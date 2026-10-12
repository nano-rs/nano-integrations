// NAN-3490 shadow runs: every collector's code.ts vs the connector.yaml next
// to it, against the same mock. See testing/README.md for how to run it.
//
//   NANO_CONNECTOR_BIN=… NANO_PARSERS_DIR=… \
//     deno test --cached-only --allow-read --allow-write --allow-net=127.0.0.1 \
//       --allow-run --allow-env testing/shadow/shadow.test.ts
//
// Per collector: (1) events are identical per stream (the connector's
// `_nano_ingest_id` stamp aside, which it must put on every event); (2) a
// restart from the connector's committed checkpoint ships nothing twice;
// (3) with NANO_PARSERS_DIR, the stream's OCSF parser gives every event a
// stable, unique metadata.uid, which is what the lake dedupes on.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1";
import { MockOkta } from "../okta-mock/mock.ts";
import { MockNetskope } from "../netskope-mock/mock.ts";
import { MockGoogleDirectory } from "../directory-mocks/google.ts";
import { MockGraph } from "../directory-mocks/graph.ts";
import { MockOktaDirectory } from "../directory-mocks/okta.ts";
import { gwsEvent, gwsMock, serviceAccountKey, slackLogin, slackMock } from "./mocks.ts";
import {
  assertIngestIds,
  connectorBin,
  assertSame,
  bySourceType,
  checkUids,
  type ConnectorRun,
  denoEmits,
  diffEvents,
  type Handler,
  type Json,
  runConnector,
  runDeno,
  serveMock,
  shadowIgnored,
} from "./lib.ts";

const root = new URL("../../integrations/", import.meta.url);
const ignore = shadowIgnored();
const dir = (slug: string) => new URL(`${slug}/`, root);
const spec = (slug: string) => new URL("connector.yaml", dir(slug)).pathname;
const script = (slug: string) => new URL("code.ts", dir(slug)).href;

type Stream = { id: string; source_type: string; parser?: string };
type Component = {
  id: string;
  label?: string;
  kind: string;
  streams?: string[];
  connector_spec?: string;
  hosted_connector_spec?: string;
  config_fields?: string[];
  default?: boolean;
  setup?: { scopes?: string[]; permissions?: string[]; steps?: string[] };
};
type Manifest = {
  slug: string;
  runtime?: string;
  connector_spec?: string;
  hosted_connector_spec?: string;
  credential_fields?: { name: string }[];
  config_fields?: { name: string; required?: boolean }[];
  streams?: Stream[];
  categories?: string[];
  components?: Component[];
};
type SpecStream = { id: string; source_type?: string; fanout?: unknown; identity?: { role?: string; mode?: string } };
type Spec = { kind?: string; auth?: Record<string, string>; streams: SpecStream[] };

/** NAN-3503: identity streams feed nano's identity snapshot, never ingest. */
const IDENTITY_LANE = "nano_identity";

/**
 * Config keys a spec reads that the manifest must mark `required: true`.
 * A `{{config.X}}` template anywhere but a query value (host, url, auth,
 * headers, body, state) renders empty when the field is unset, so the run
 * fails: required. A query value that renders empty is dropped by the engine,
 * which is a working default (Slack's optional TEAM_ID). A program read
 * `.config.X` is optional only when it is coalesced (`(.config.X) ?? ...`);
 * a coalesce to a value the run cannot use (an empty host) is not caught
 * here, which is why every host/url template is checked above.
 * STREAMS is filled by nano.
 */
function configNeedsRequired(spec: unknown, text: string): Set<string> {
  const need = new Set<string>();
  const walk = (v: unknown, inQuery: boolean, key: string) => {
    if (typeof v === "string") {
      if (key === "program") return;
      for (const m of v.matchAll(/\{\{\s*config\.([A-Z0-9_]+)/g)) if (!inQuery) need.add(m[1]);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, inQuery, key));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, inQuery || k === "query", k);
    }
  };
  walk(spec, false, "");
  for (const m of text.matchAll(/\.config\.([A-Z0-9_]+)(\)?\s*\?\?)?/g)) if (!m[2]) need.add(m[1]);
  need.delete("STREAMS");
  return need;
}

/**
 * Config keys a HOSTED spec needs that stay `required: false` in the manifest
 * because the self-hosted spec never reads them. The manifest format has no
 * per-spec requirement, so the server enforces these when the hosted spec is
 * the one selected. Every entry must name that check, and must still be used.
 */
const HOSTED_ONLY_CONFIG: Record<string, Record<string, string>> = {
  okta_users: {
    CLIENT_ID: "hosted-only (okta_broker_jwt client_id); enforced by the NAN-3503 lane G handler check that requires every non-coalesced config read of the selected hosted spec",
  },
};

/**
 * Problems for config keys `specText` needs that the manifest leaves optional
 * or undeclared. `allow` (hosted specs only) exempts keys the server enforces
 * for that spec; an entry the spec no longer needs is itself a problem.
 */
function requiredConfigProblems(where: string, m: Manifest, specText: string, allow: Record<string, string> = {}): string[] {
  const required = new Set((m.config_fields ?? []).filter((f) => f.required === true).map((f) => f.name));
  const need = configNeedsRequired(parse(specText), specText);
  return [
    ...[...need].filter((k) => !required.has(k) && !(k in allow))
      .map((k) => `${where}: spec needs config ${k}, which the manifest does not mark required: true`),
    ...Object.keys(allow).filter((k) => !need.has(k) || required.has(k))
      .map((k) => `${where}: hosted-only allowlist entry ${k} is stale (the spec no longer needs it or the manifest already requires it)`),
  ];
}

/** Every `{{config.X}}` / `.config.X` a spec text reads. */
const configReads = (text: string) => [...text.matchAll(/(?:\{\{\s*config\.|\.config\.)([A-Z0-9_]+)/g)].map((m) => m[1]);

/**
 * A hosted twin (NAN-3490) may differ from its spec ONLY in the auth block,
 * so a run of the self-hosted spec covers what the hosted one collects.
 * Returns problems; `where` prefixes them.
 */
async function checkHostedTwin(slug: string, where: string, specFile: string, spec: Record<string, unknown>, hostedFile: string, creds: Set<string>, configs: Set<string>): Promise<string[]> {
  const problems: string[] = [];
  let hostedText = "";
  try {
    hostedText = await Deno.readTextFile(new URL(hostedFile, dir(slug)));
  } catch {
    return [`${where}: hosted spec ${hostedFile} is missing`];
  }
  const { auth: _a, ...rest } = spec;
  const { auth: hostedAuth, ...hostedRest } = parse(hostedText) as Record<string, unknown>;
  try {
    assertEquals(hostedRest, rest);
  } catch {
    problems.push(`${where}: ${hostedFile} differs from ${specFile} outside auth`);
  }
  for (const [k, v] of Object.entries((hostedAuth ?? {}) as Record<string, string>)) {
    if ((k === "credential" || k.endsWith("_credential")) && !creds.has(v)) problems.push(`${where}: hosted auth uses credential ${v}, which the manifest does not declare`);
  }
  for (const k of configReads(hostedText)) {
    if (!configs.has(k)) problems.push(`${where}: hosted spec reads config ${k}, which the manifest does not declare`);
  }
  problems.push(...requiredConfigProblems(`${where}/${hostedFile}`, await manifest(slug), hostedText, HOSTED_ONLY_CONFIG[slug]));
  return problems;
}

/** Structural checks every `kind: identity` spec must pass. */
function checkIdentitySpec(where: string, s: Spec): string[] {
  const problems: string[] = [];
  if (s.kind !== "identity") problems.push(`${where}: kind must be identity`);
  if (!s.streams.some((x) => x.identity?.role === "users")) problems.push(`${where}: no users stream`);
  for (const st of s.streams) {
    const role = st.identity?.role;
    if (role !== "users" && role !== "memberships") problems.push(`${where}/${st.id}: identity.role must be users or memberships`);
    if (role === "users" && !["full", "delta", undefined].includes(st.identity?.mode)) problems.push(`${where}/${st.id}: identity.mode must be full or delta`);
    if (role === "memberships" && st.identity?.mode !== undefined) problems.push(`${where}/${st.id}: memberships streams are always full`);
    if (st.source_type !== undefined) problems.push(`${where}/${st.id}: identity streams have no source_type`);
  }
  return problems;
}
const manifest = async (slug: string) => parse(await Deno.readTextFile(new URL("manifest.yaml", dir(slug)))) as Manifest;

/** OCSF parser per source_type, from the manifest or the parser snapshot. */
const snapshot = JSON.parse(await Deno.readTextFile(new URL("../ocsf-parsers/ocsf-parsers.json", import.meta.url))) as {
  parsers: { name: string; match_values: string[] }[];
};
function parserFor(s: Stream): string {
  return s.parser ?? snapshot.parsers.find((p) => p.match_values.includes(s.source_type))!.name;
}

/** Run each side against a fresh mock, diff per stream, check ids and uids. */
async function shadow(opts: {
  slug: string;
  mock: () => Handler;
  deno: Record<string, unknown>;
  connector: Parameters<typeof runConnector>[2];
}): Promise<{ run: ConnectorRun; handler: Handler }> {
  const m = await manifest(opts.slug);
  const a = serveMock(opts.mock());
  let d: Record<string, Json>;
  try {
    d = await runDeno(a, { script: script(opts.slug), kind: "collector", ...opts.deno });
  } finally {
    await a.close();
  }
  const handler = opts.mock();
  const b = serveMock(handler);
  let run: ConnectorRun;
  try {
    run = await runConnector(spec(opts.slug), b, opts.connector);
  } finally {
    await b.close();
  }
  const deno = denoEmits(d);
  const conn = bySourceType(run);
  for (const s of m.streams ?? []) {
    if (!(opts.deno.streams as string[]).includes(s.id)) continue;
    const evs = conn.get(s.source_type) ?? [];
    assertSame(diffEvents(`${opts.slug}/${s.id}`, deno.get(s.id) ?? [], evs));
    assert(evs.length > 0, `${opts.slug}/${s.id}: no events`);
    assertIngestIds(`${opts.slug}/${s.id}`, evs);
    await checkUids(`${opts.slug}/${s.id}`, parserFor(s), [[s.source_type, evs]]);
  }
  return { run, handler };
}

/** A second connector run from the first run's checkpoints, same mock state. */
async function restart(slug: string, handler: Handler, first: ConnectorRun, connector: Parameters<typeof runConnector>[2]) {
  const b = serveMock(handler);
  try {
    const r = await runConnector(spec(slug), b, { ...connector, checkpoints: first.checkpoints });
    console.log(`shadow ${slug}: restart ships ${r.events}`);
    return r;
  } finally {
    await b.close();
  }
}

Deno.test({ name: "okta_system_log: Deno vs connector", ignore }, async () => {
  const backfill = new Date(Date.now() - 2 * 3600_000).toISOString();
  // One pinned clock for both mocks, so both serve the same `published` times.
  const t = Date.now() - 60_000;
  const mock = () => new MockOkta({ token: "mock-token", events: 2500, users: 450, pageMax: 200, now: () => t, origin: "https://acme.okta.com" }).handle;
  const connector = { config: { OKTA_DOMAIN: "acme.okta.com" }, creds: { API_TOKEN: "mock-token" }, backfillFrom: backfill };
  const { run, handler } = await shadow({
    slug: "okta_system_log",
    mock,
    deno: { credentials: { API_TOKEN: "mock-token" }, config: { OKTA_DOMAIN: "acme.okta.com" }, streams: ["system_log"], backfill_from: backfill },
    connector,
  });
  assertEquals(run.events, 2500);
  assertEquals((await restart("okta_system_log", handler, run, connector)).events, 0);
});

Deno.test({ name: "google_workspace: Deno vs connector", ignore }, async () => {
  const { pem, publicKey } = await serviceAccountKey();
  const now = Date.now();
  const base = now - 10 * 60_000;
  const apps: Record<string, Record<string, unknown>[]> = {};
  for (const [app, n] of [["login", 260], ["admin", 140], ["token", 75]] as const) {
    // Pairs share an instant (the inclusive-boundary case), 40 s apart.
    apps[app] = Array.from({ length: n }, (_, i) => gwsEvent(app, i, new Date(base - 40_000 * Math.floor(i / 2))));
  }
  const expect = { iss: "svc@mock-project.iam.gserviceaccount.com", sub: "admin@example.com", scope: "https://www.googleapis.com/auth/admin.reports.audit.readonly" };
  const backfill = new Date(now - 4 * 3600_000).toISOString();
  const connector = {
    config: { ADMIN_EMAIL: "admin@example.com", STREAMS: "login,admin,token" },
    creds: { CLIENT_EMAIL: expect.iss },
    credFiles: { PRIVATE_KEY: pem },
    backfillFrom: backfill,
  };
  const { run, handler } = await shadow({
    slug: "google_workspace",
    mock: () => gwsMock(apps, publicKey, expect),
    deno: {
      auth: { type: "service_account_jwt", token_url: "https://oauth2.googleapis.com/token", private_key: pem, client_email: expect.iss, subject: expect.sub, scope: expect.scope },
      credentials: { PRIVATE_KEY: pem, CLIENT_EMAIL: expect.iss },
      config: { ADMIN_EMAIL: "admin@example.com" },
      streams: ["login", "admin", "token"],
      backfill_from: backfill,
    },
    connector,
  });
  assertEquals(run.events, 475);
  assertEquals((await restart("google_workspace", handler, run, connector)).events, 0);
});

Deno.test({ name: "slack: Deno vs connector", ignore }, async () => {
  const t0 = Math.floor(Date.now() / 1000) - 600;
  const logins = Array.from({ length: 450 }, (_, i) => slackLogin(i, t0 - 60 * i));
  const connector = { creds: { USER_TOKEN: "xoxp-mock-token" } };
  const { run, handler } = await shadow({
    slug: "slack",
    mock: () => slackMock(logins, "xoxp-mock-token"),
    deno: { auth: { type: "bearer", token: "xoxp-mock-token" }, credentials: { USER_TOKEN: "xoxp-mock-token" }, config: {}, streams: ["access_logs"] },
    connector,
  });
  assertEquals(run.events, 450);
  assertEquals((await restart("slack", handler, run, connector)).events, 0);
});

const netskopeT0 = Math.floor(Date.now() / 1000) - 3600;
const netskopeBackfill = new Date((netskopeT0 - 60) * 1000).toISOString();
const netskopeDeno = (streams: string[]) => ({
  auth: { type: "api_key_header", header_name: "Netskope-API-Token", api_key: "ns-token-123456" },
  credentials: { API_TOKEN: "ns-token-123456" },
  config: { TENANT_HOST: "acme.goskope.com", INDEX_NAME: "nano" },
  streams,
  backfill_from: netskopeBackfill,
});
const netskopeConnector = (streams: string[]) => ({
  config: { TENANT_HOST: "acme.goskope.com", INDEX_NAME: "nano", STREAMS: streams.join(",") },
  creds: { API_TOKEN: "ns-token-123456" },
  backfillFrom: netskopeBackfill,
});

Deno.test({ name: "netskope: Deno vs connector", ignore }, async () => {
  const streams = ["alert", "application"];
  const { run, handler } = await shadow({
    slug: "netskope",
    mock: () => new MockNetskope({ token: "ns-token-123456", t0: netskopeT0, counts: { alert: 230, application: 140 } }).handle,
    deno: netskopeDeno(streams),
    connector: netskopeConnector(streams),
  });
  assertEquals(run.events, 370);
  assertEquals((await restart("netskope", handler, run, netskopeConnector(streams))).events, 0);
});

Deno.test({ name: "netskope: a page lost after it was served is resent by both", ignore }, async () => {
  // The 502 arrives after Netskope advanced the index; both runtimes must
  // retry with operation=resend, or the page is gone for good.
  const mocks: MockNetskope[] = [];
  const { run } = await shadow({
    slug: "netskope",
    mock: () => {
      const m = new MockNetskope({ token: "ns-token-123456", t0: netskopeT0, counts: { alert: 330 } });
      m.failAfterServe = 1;
      mocks.push(m);
      return m.handle;
    },
    deno: netskopeDeno(["alert"]),
    connector: netskopeConnector(["alert"]),
  });
  assertEquals(run.events, 330);
  for (const m of mocks.slice(0, 2)) {
    assertEquals(m.log.filter((l) => l.endsWith(" resend")).length, 1);
    assertEquals(m.unopenedResends, 0);
  }
});

// NAN-3503 identity specs: users rows and membership events against the
// directory mocks. They need an engine with `kind: identity` (lane A); a
// binary that predates it skips them with a warning, even in CI, so this repo
// can land the specs before the engine.
const identityIgnored = ignore || await (async () => {
  const out = await new Deno.Command(connectorBin, { args: ["schema"], stdout: "piped", stderr: "null" }).output();
  const ok = new TextDecoder().decode(out.stdout).includes('"identity"');
  if (!ok) console.warn("shadow: nano-connector has no kind: identity yet; skipping the identity spec runs");
  return !ok;
})();

/** Split an identity run into user rows and (member, group) pairs. Accepts the
 *  engine's per-event memberships or rows already aggregated into `groups`. */
function identityRows(run: ConnectorRun): { users: Record<string, Json>[]; pairs: Set<string>; privileged: Set<string> } {
  const users: Record<string, Json>[] = [];
  const pairs = new Set<string>();
  const privileged = new Set<string>();
  for (const [, evs] of run.batches) {
    for (const e of evs) {
      if (typeof e.member === "string") {
        pairs.add(`${e.member}|${e.group}`);
        if (e.privileged === true) privileged.add(e.member);
      } else if (Array.isArray(e.groups)) {
        for (const g of e.groups) pairs.add(`${e.external_id}|${g}`);
        if (e.is_admin === true) privileged.add(e.external_id as string);
      } else users.push(e);
    }
  }
  return { users, pairs, privileged };
}

/** Engine features the identity specs need beyond `kind: identity` (the
 *  `next_url` stepper, templated oauth2 params) may land after it. A spec the
 *  binary refuses for a MISSING feature is skipped with a warning; any other
 *  validation error fails. */
async function engineLacks(specFile: string): Promise<string | null> {
  const out = await new Deno.Command(connectorBin, { args: ["validate", specFile], stdout: "piped", stderr: "null" }).output();
  const v = JSON.parse(new TextDecoder().decode(out.stdout) || "{}") as { ok?: boolean; error?: string };
  if (v.ok) return null;
  if (/is not registered|unknown field/.test(v.error ?? "")) return v.error!;
  throw new Error(`${specFile}: ${v.error}`);
}

async function identityRun(specFile: string, handler: Handler, opts: Parameters<typeof runConnector>[2]) {
  const b = serveMock(handler);
  try {
    return await runConnector(specFile, b, opts);
  } finally {
    await b.close();
  }
}

Deno.test({ name: "okta_users: identity full run (every status, groups, admin roles)", ignore: identityIgnored }, async (t) => {
  const lacks = await engineLacks(spec("okta_users"));
  if (lacks) return void console.warn(`okta_users: skipped, engine lacks: ${lacks}`);
  const mock = new MockOktaDirectory({ users: 450, groups: 3, membersPerGroup: 5, origin: "https://acme.okta.com" });
  const run = await identityRun(spec("okta_users"), mock.handle, { config: { OKTA_DOMAIN: "acme.okta.com", PRIVILEGED_GROUPS: "okta admins" }, creds: { API_TOKEN: "mock-token" } });
  const { users, pairs, privileged } = identityRows(run);
  assertEquals(users.length, 450); // STAGED and DEPROVISIONED included
  assert(users.some((u) => u.account_status === "staged" && u.account_enabled === false));
  assert(users.some((u) => u.account_status === "deprovisioned" && u.account_enabled === false));
  assertEquals(pairs.size, 15 + 3); // group pairs + USER_ADMIN, READ_ONLY_ADMIN, HELP_DESK_ADMIN
  assertEquals(privileged.size, 5); // the role holders (users 1, 2) are in Okta Admins too
  await t.step("an org of only STAGED users (the integrator test org's shape)", async () => {
    const staged = new MockOktaDirectory({ users: 24, groups: 4, membersPerGroup: 4, origin: "https://acme.okta.com", allStaged: true, admins: { 5: ["USER_ADMIN"] } });
    const r = identityRows(await identityRun(spec("okta_users"), staged.handle, { config: { OKTA_DOMAIN: "acme.okta.com" }, creds: { API_TOKEN: "mock-token" } }));
    assertEquals(r.users.length, 24);
    assert(r.users.every((u) => u.account_status === "staged"));
    assert(r.pairs.has(`${staged.user(5).id}|role:USER_ADMIN`));
    assertEquals([...r.privileged], [staged.user(5).id as string]);
  });
});

Deno.test({ name: "google_workspace: directory identity full run", ignore: identityIgnored }, async () => {
  const { pem } = await serviceAccountKey();
  const mock = new MockGoogleDirectory({ users: 120, groups: 3, membersPerGroup: 5, pageMax: 50 });
  const run = await identityRun(new URL("directory.connector.yaml", dir("google_workspace")).pathname, mock.handle, {
    config: { ADMIN_EMAIL: "admin@example.com", PRIVILEGED_GROUPS: "admins@example.com" },
    creds: { CLIENT_EMAIL: "svc@mock-project.iam.gserviceaccount.com" },
    credFiles: { PRIVATE_KEY: pem },
  });
  const { users, pairs, privileged } = identityRows(run);
  assertEquals(users.length, 120);
  assertEquals(pairs.size, 20); // admins@ flattens group 1 (derived membership)
  assertEquals(privileged.size, 10);
  assertEquals(mock.grants[0]?.scope, "https://www.googleapis.com/auth/admin.directory.user.readonly https://www.googleapis.com/auth/admin.directory.group.readonly");
});

Deno.test({ name: "entra_directory: identity full run then delta", ignore: identityIgnored }, async () => {
  const lacks = await engineLacks(spec("entra_directory"));
  if (lacks) return void console.warn(`entra_directory: skipped, engine lacks: ${lacks}`);
  const mock = new MockGraph({ users: 24, groups: 4, membersPerGroup: 4, pageMax: 10 });
  const opts = {
    config: { DIRECTORY_ID: "e6800ccd-0000-4000-8000-000000000000", CLIENT_ID: mock.clientId, PRIVILEGED_GROUPS: "privileged ops" },
    creds: { CLIENT_SECRET: mock.clientSecret },
  };
  const full = await identityRun(spec("entra_directory"), mock.handle, opts);
  const f = identityRows(full);
  assertEquals(f.users.length, 24);
  assert(f.users.some((u) => u.employee_type === "guest"));
  assertEquals(f.pairs.size, 4 * 4 + 4 + 2); // groups (0 nests 1) + two role holders
  mock.updateUser(3, { department: "Security" });
  mock.removeUser(5);
  const delta = await identityRun(spec("entra_directory"), mock.handle, { ...opts, checkpoints: full.checkpoints });
  const d = identityRows(delta);
  assertEquals(d.users.map((u) => u.external_id).sort(), [mock.users[3].id, mock.users[5].id].sort());
  assert(d.users.some((u) => u.deleted === true));
});

// Runs without the connector binary: the manifest <-> spec contract.
Deno.test("every connector.yaml is declared by its manifest and only uses declared fields", async () => {
  const problems: string[] = [];
  let n = 0;
  for await (const e of Deno.readDir(root)) {
    if (!e.isDirectory) continue;
    let text: string;
    try {
      text = await Deno.readTextFile(new URL("connector.yaml", dir(e.name)));
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      throw err;
    }
    n++;
    const m = await manifest(e.name);
    const where = e.name;
    if (m.connector_spec !== "connector.yaml") problems.push(`${where}: manifest connector_spec is not connector.yaml`);
    if (m.runtime !== "deno" && m.runtime !== "connector") problems.push(`${where}: manifest runtime must be deno or connector`);
    let hasScript = true;
    try {
      await Deno.stat(new URL("code.ts", dir(e.name)));
    } catch {
      hasScript = false;
    }
    if (!hasScript && m.runtime !== "connector") problems.push(`${where}: no code.ts, so runtime must be connector`);
    // Every config/credential the spec reads must be a manifest field. STREAMS
    // is filled by nano from the operator's enabled streams (fan-out specs).
    const configs = new Set([...(m.config_fields ?? []).map((f) => f.name), "STREAMS"]);
    const creds = new Set((m.credential_fields ?? []).map((f) => f.name));
    for (const k of configReads(text)) {
      if (!configs.has(k)) problems.push(`${where}: spec reads config ${k}, which the manifest does not declare`);
    }
    problems.push(...requiredConfigProblems(`${where}/connector.yaml`, m, text));
    const s = parse(text) as Spec;
    for (const [k, v] of Object.entries(s.auth ?? {})) {
      if ((k === "credential" || k.endsWith("_credential")) && !creds.has(v)) problems.push(`${where}: auth uses credential ${v}, which the manifest does not declare`);
    }
    if (s.kind === "identity") {
      // NAN-3503: manifest streams mirror the identity spec's stream ids.
      problems.push(...checkIdentitySpec(`${where}/connector.yaml`, s));
      for (const ms of m.streams ?? []) {
        if (ms.source_type !== IDENTITY_LANE) problems.push(`${where}/${ms.id}: identity streams use source_type ${IDENTITY_LANE}`);
        if (!s.streams.some((ss) => ss.id === ms.id)) problems.push(`${where}/${ms.id}: no identity spec stream has this id`);
      }
    } else {
      // Every manifest stream maps to a spec stream's source_type.
      for (const ms of m.streams ?? []) {
        const ok = s.streams.some((ss) => ss.source_type === ms.source_type || (ss.fanout !== undefined && ss.source_type?.replace("{{item}}", ms.id) === ms.source_type));
        if (!ok) problems.push(`${where}/${ms.id}: no spec stream emits source_type ${ms.source_type}`);
      }
    }
    // A hosted-only spec (NAN-3490) may differ from connector.yaml ONLY in its
    // auth block, so the shadow run of connector.yaml covers what it collects.
    if (m.hosted_connector_spec !== undefined) {
      if (m.hosted_connector_spec !== "connector.hosted.yaml") problems.push(`${where}: hosted_connector_spec is not connector.hosted.yaml`);
      problems.push(...await checkHostedTwin(e.name, where, "connector.yaml", s as unknown as Record<string, unknown>, m.hosted_connector_spec, creds, configs));
    }
  }
  assert(n >= 5, `only ${n} connector specs found`);
  assertEquals(problems, []);
});

// NAN-3503: marketplace components. Runs without the connector binary.
Deno.test("every manifest component is well-formed and its identity specs are declared", async () => {
  const problems: string[] = [];
  let identity = 0;
  for await (const e of Deno.readDir(root)) {
    if (!e.isDirectory) continue;
    let m: Manifest;
    try {
      m = await manifest(e.name);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) continue;
      throw err;
    }
    const where = e.name;
    for (const c of m.categories ?? []) {
      if (c !== "logs" && c !== "identity") problems.push(`${where}: unknown category ${c}`);
    }
    if (m.components === undefined) continue;
    const configs = new Set([...(m.config_fields ?? []).map((f) => f.name), "STREAMS"]);
    const creds = new Set((m.credential_fields ?? []).map((f) => f.name));
    const streamIds = new Set((m.streams ?? []).map((s) => s.id));
    const claimed = new Map<string, string>();
    const ids = new Set<string>();
    for (const c of m.components) {
      const cw = `${where}/components/${c.id}`;
      if (!/^[a-z0-9_]+$/.test(c.id ?? "")) problems.push(`${cw}: id must be [a-z0-9_]+`);
      if (ids.has(c.id)) problems.push(`${cw}: duplicate id`);
      ids.add(c.id);
      if (!c.label) problems.push(`${cw}: label is required`);
      for (const k of ["scopes", "permissions", "steps"] as const) {
        const v = c.setup?.[k];
        if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === "string"))) problems.push(`${cw}: setup.${k} must be a list of strings`);
      }
      for (const f of c.config_fields ?? []) if (!configs.has(f)) problems.push(`${cw}: config field ${f} is not declared`);
      if (c.kind === "logs") {
        if (!c.streams?.length) problems.push(`${cw}: a logs component lists its streams`);
        for (const sid of c.streams ?? []) {
          if (!streamIds.has(sid)) problems.push(`${cw}: unknown stream ${sid}`);
          if (claimed.has(sid)) problems.push(`${cw}: stream ${sid} is already in component ${claimed.get(sid)}`);
          claimed.set(sid, c.id);
        }
      } else if (c.kind === "identity") {
        identity++;
        if (!(m.categories ?? []).includes("identity")) problems.push(`${where}: has an identity component but categories lacks identity`);
        if (!c.connector_spec || c.connector_spec.includes("/")) {
          problems.push(`${cw}: connector_spec must name a file next to the manifest`);
          continue;
        }
        let text: string;
        try {
          text = await Deno.readTextFile(new URL(c.connector_spec, dir(e.name)));
        } catch {
          problems.push(`${cw}: ${c.connector_spec} is missing`);
          continue;
        }
        const s = parse(text) as Spec;
        problems.push(...checkIdentitySpec(`${cw}/${c.connector_spec}`, s));
        problems.push(...requiredConfigProblems(`${cw}/${c.connector_spec}`, m, text));
        const allowed = c.config_fields ? new Set(c.config_fields) : configs;
        for (const k of configReads(text)) {
          if (!configs.has(k)) problems.push(`${cw}: spec reads config ${k}, which the manifest does not declare`);
          else if (!allowed.has(k)) problems.push(`${cw}: spec reads config ${k}, which the component's config_fields omit`);
        }
        for (const [k, v] of Object.entries(s.auth ?? {})) {
          if ((k === "credential" || k.endsWith("_credential")) && !creds.has(v)) problems.push(`${cw}: auth uses credential ${v}, which the manifest does not declare`);
        }
        if (c.hosted_connector_spec !== undefined) {
          problems.push(...await checkHostedTwin(e.name, cw, c.connector_spec, s as unknown as Record<string, unknown>, c.hosted_connector_spec, creds, configs));
        }
        // An entry that IS a directory: its own spec is the component's.
        if (m.connector_spec === c.connector_spec && m.hosted_connector_spec !== c.hosted_connector_spec) {
          problems.push(`${cw}: hosted_connector_spec must match the manifest's for its own spec`);
        }
      } else problems.push(`${cw}: kind must be logs or identity`);
    }
  }
  assert(identity >= 3, `only ${identity} identity components found`);
  assertEquals(problems, []);
});

// Guards the guard: an auth/url template on an optional field is caught; a
// query value or a coalesced program read is not.
Deno.test("the required-config check catches an optional field a spec cannot run without", () => {
  const text = [
    "auth: { type: okta_broker_jwt, okta_domain: \"{{config.DOMAIN}}\", client_id: \"{{config.CLIENT_ID}}\" }",
    "streams:",
    "  - id: s",
    "    request: { url: \"https://{{config.DOMAIN}}/x\", query: { team: \"{{config.TEAM}}\" } }",
    "    program: |",
    "      a = string(.config.OPTIONAL) ?? \"\"",
    "      b = .config.NEEDED",
  ].join("\n");
  assertEquals([...configNeedsRequired(parse(text), text)].sort(), ["CLIENT_ID", "DOMAIN", "NEEDED"]);
  const m = { slug: "x", config_fields: [{ name: "DOMAIN", required: true }, { name: "CLIENT_ID", required: false }, { name: "TEAM" }] } as Manifest;
  assertEquals(requiredConfigProblems("x", m, text), [
    "x: spec needs config CLIENT_ID, which the manifest does not mark required: true",
    "x: spec needs config NEEDED, which the manifest does not mark required: true",
  ]);
  // A hosted spec may leave a key optional only through a named allowlist entry,
  // and an entry the spec no longer needs is flagged.
  assertEquals(requiredConfigProblems("x", m, text, { CLIENT_ID: "handler check", GONE: "handler check" }), [
    "x: spec needs config NEEDED, which the manifest does not mark required: true",
    "x: hosted-only allowlist entry GONE is stale (the spec no longer needs it or the manifest already requires it)",
  ]);
});

// Every hosted-only allowlist entry belongs to an integration that ships a
// hosted spec (otherwise the stale check above never sees it) and names its check.
Deno.test("hosted-only config allowlist entries point at a hosted spec and give a reason", async () => {
  for (const [slug, keys] of Object.entries(HOSTED_ONLY_CONFIG)) {
    const m = await manifest(slug);
    const hosted = m.hosted_connector_spec ?? (m.components ?? []).find((c) => c.hosted_connector_spec)?.hosted_connector_spec;
    assert(hosted, `${slug}: allowlisted hosted-only config but ships no hosted spec`);
    for (const [k, why] of Object.entries(keys)) assert(why.trim().length > 0, `${slug}.${k}: allowlist entry needs a reason`);
  }
});
