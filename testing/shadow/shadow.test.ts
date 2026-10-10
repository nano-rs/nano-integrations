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
import { gwsEvent, gwsMock, serviceAccountKey, slackLogin, slackMock } from "./mocks.ts";
import {
  assertIngestIds,
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
type Manifest = {
  slug: string;
  runtime?: string;
  connector_spec?: string;
  credential_fields?: { name: string }[];
  config_fields?: { name: string }[];
  streams?: Stream[];
};
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

Deno.test({ name: "okta_users: connector only (no Deno original)", ignore }, async () => {
  const b = serveMock(new MockOkta({ token: "mock-token", events: 0, users: 450, origin: "https://acme.okta.com" }).handle);
  try {
    const run = await runConnector(spec("okta_users"), b, { config: { OKTA_DOMAIN: "acme.okta.com" }, creds: { API_TOKEN: "mock-token" } });
    const users = bySourceType(run).get("nano_enrich") ?? [];
    assertEquals(users.length, 450);
    assertIngestIds("okta_users", users);
    assert(users.every((u) => u.kind === "identity" && u.source === "okta"), "identity-lane records");
  } finally {
    await b.close();
  }
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
    for (const [, k] of text.matchAll(/(?:\{\{\s*config\.|\.config\.)([A-Z0-9_]+)/g)) {
      if (!configs.has(k)) problems.push(`${where}: spec reads config ${k}, which the manifest does not declare`);
    }
    const s = parse(text) as { auth?: Record<string, string>; streams: { source_type?: string; fanout?: unknown }[] };
    for (const [k, v] of Object.entries(s.auth ?? {})) {
      if ((k === "credential" || k.endsWith("_credential")) && !creds.has(v)) problems.push(`${where}: auth uses credential ${v}, which the manifest does not declare`);
    }
    // Every manifest stream maps to a spec stream's source_type.
    for (const ms of m.streams ?? []) {
      const ok = s.streams.some((ss) => ss.source_type === ms.source_type || (ss.fanout !== undefined && ss.source_type?.replace("{{item}}", ms.id) === ms.source_type));
      if (!ok) problems.push(`${where}/${ms.id}: no spec stream emits source_type ${ms.source_type}`);
    }
  }
  assert(n >= 5, `only ${n} connector specs found`);
  assertEquals(problems, []);
});
