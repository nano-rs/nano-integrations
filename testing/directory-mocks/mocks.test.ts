// Unit tests for the directory mocks (NAN-3503) and their recordings.
//
//   deno test --allow-read testing/directory-mocks/mocks.test.ts
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { MockGoogleDirectory } from "./google.ts";
import { GRAPH, MockGraph } from "./graph.ts";
import { MockOktaDirectory, OKTA_BASE_UPDATED } from "./okta.ts";
import { buildRecordings, OKTA_EVERY_STATUS, recordingsDir } from "./record.ts";

type J = Record<string, unknown>;
const get = async (h: (r: Request) => Response | Promise<Response>, url: string, auth: string) => {
  const res = await h(new Request(url, { headers: { Authorization: auth } }));
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) as J & J[] };
};
const nextLink = (link: string | null) => link?.match(/<([^>]+)>; rel="next"/)?.[1];

// ---------------------------------------------------------------- Google

Deno.test("google: users page by nextPageToken and honor projection", async () => {
  const m = new MockGoogleDirectory({ users: 25, pageMax: 10 });
  const auth = `Bearer ${m.accessToken}`;
  const base = "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=500&projection=full";
  const seen: string[] = [];
  let tok: string | undefined;
  do {
    const r = await get(m.handle, base + (tok ? `&pageToken=${tok}` : ""), auth);
    assertEquals(r.status, 200);
    for (const u of r.body.users as J[]) seen.push(u.primaryEmail as string);
    tok = r.body.nextPageToken as string | undefined;
  } while (tok);
  assertEquals(seen.length, 25);
  assertEquals(new Set(seen).size, 25);
  const basic = await get(m.handle, "https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer", auth);
  assert(!("organizations" in (basic.body.users as J[])[0]), "projection=basic omits organizations");
  assertEquals((await get(m.handle, "https://admin.googleapis.com/admin/directory/v1/users", auth)).status, 400);
});

Deno.test("google: derived membership flattens nested groups; auth and 429", async () => {
  const m = new MockGoogleDirectory({ users: 20, groups: 3, membersPerGroup: 5 });
  const auth = `Bearer ${m.accessToken}`;
  const g0 = m.groups[0].id;
  const direct = await get(m.handle, `https://admin.googleapis.com/admin/directory/v1/groups/${g0}/members`, auth);
  assertEquals((direct.body.members as J[]).filter((x) => x.type === "GROUP").length, 1);
  const derived = await get(m.handle, `https://admin.googleapis.com/admin/directory/v1/groups/${g0}/members?includeDerivedMembership=true`, auth);
  const d = derived.body.members as J[];
  assertEquals(d.length, 10);
  assert(d.every((x) => x.type === "USER"));
  assertEquals((await get(m.handle, `https://admin.googleapis.com/admin/directory/v1/groups`, "Bearer nope")).status, 401);
  m.faults.throttle(1, 2);
  const t = await get(m.handle, `https://admin.googleapis.com/admin/directory/v1/groups`, auth);
  assertEquals(t.status, 429);
  assertEquals(t.headers.get("retry-after"), "2");
  assertEquals((await get(m.handle, `https://admin.googleapis.com/admin/directory/v1/groups`, auth)).status, 200);
});

Deno.test("google: token exchange records the requested scopes", async () => {
  const m = new MockGoogleDirectory();
  const claims = btoa(JSON.stringify({ scope: "a b", sub: "admin@example.com" }));
  const res = await m.handle(new Request("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=h.${claims}.s`,
  }));
  assertEquals((await res.json()).access_token, m.accessToken);
  assertEquals(m.grants[0].scope, "a b");
});

// ---------------------------------------------------------------- Graph

Deno.test("graph: users list caps $top at 100 with $expand and follows nextLink", async () => {
  const m = new MockGraph({ users: 24, pageMax: 10 });
  const auth = `Bearer ${m.accessToken}`;
  const bad = await get(m.handle, `${GRAPH}/v1.0/users?$expand=manager&$top=999`, auth);
  assertEquals(bad.status, 400);
  assertMatch((bad.body.error as J).message as string, /between 1 and 100/);
  assertEquals((await get(m.handle, `${GRAPH}/v1.0/users?$top=999`, auth)).status, 200);
  let url: string | undefined = `${GRAPH}/v1.0/users?$select=id,displayName&$expand=manager&$top=100`;
  const rows: J[] = [];
  while (url) {
    const r = await get(m.handle, url, auth);
    rows.push(...(r.body.value as J[]));
    url = r.body["@odata.nextLink"] as string | undefined;
  }
  assertEquals(rows.length, 24);
  assert(!("department" in rows[1]), "$select is honored");
  assertEquals((rows[6].manager as J).id, m.users[1].id);
});

Deno.test("graph: users/delta latest, changes, @removed, manager@delta, expiry", async () => {
  const m = new MockGraph({ users: 12, deltaPageSize: 2 });
  const auth = `Bearer ${m.accessToken}`;
  assertEquals((await get(m.handle, `${GRAPH}/v1.0/users/delta?$expand=manager`, auth)).status, 400);
  assertEquals((await get(m.handle, `${GRAPH}/v1.0/users/delta?$top=10`, auth)).status, 400);
  const latest = await get(m.handle, `${GRAPH}/v1.0/users/delta?$deltatoken=latest&$select=id,department,manager`, auth);
  assertEquals((latest.body.value as J[]).length, 0);
  const link = latest.body["@odata.deltaLink"] as string;
  m.updateUser(3, { department: "Security" });
  m.setManager(4, 2);
  m.removeUser(5);
  const rows: J[] = [];
  let url: string | undefined = link;
  let pages = 0;
  let next = "";
  while (url) {
    const r = await get(m.handle, url, auth);
    pages++;
    rows.push(...(r.body.value as J[]));
    url = r.body["@odata.nextLink"] as string | undefined;
    next = (r.body["@odata.deltaLink"] as string) ?? next;
  }
  assertEquals(pages, 2);
  assertEquals(rows.length, 3);
  assertEquals(rows[0].department, "Security");
  assert(!("jobTitle" in rows[0]), "the token keeps the original $select");
  assertEquals((rows[1]["manager@delta"] as J[])[0].id, m.users[2].id);
  assertEquals((rows[2]["@removed"] as J).reason, "deleted");
  // Nothing new since: an empty round.
  const again = await get(m.handle, next, auth);
  assertEquals((again.body.value as J[]).length, 0);
  m.expireTokens();
  assertEquals((await get(m.handle, next, auth)).status, 410);
  m.expiry = "syncStateNotFound";
  const ss = await get(m.handle, next, auth);
  assertEquals(ss.status, 400);
  assertEquals((ss.body.error as J).code, "syncStateNotFound");
});

Deno.test("graph: transitive members flatten nesting; roles mix principals; auth", async () => {
  const m = new MockGraph({ users: 16, groups: 4, membersPerGroup: 4 });
  const auth = `Bearer ${m.accessToken}`;
  const g0 = m.groups[0].id;
  const direct = await get(m.handle, `${GRAPH}/v1.0/groups/${g0}/members`, auth);
  assertEquals((direct.body.value as J[]).length, 5);
  const users = await get(m.handle, `${GRAPH}/v1.0/groups/${g0}/transitiveMembers/microsoft.graph.user?$select=id`, auth);
  assertEquals((users.body.value as J[]).length, 8);
  const roleMembers = await get(m.handle, `${GRAPH}/v1.0/directoryRoles/${m.roles[1].id}/members`, auth);
  assertEquals((roleMembers.body.value as J[]).map((x) => x["@odata.type"]), ["#microsoft.graph.user", "#microsoft.graph.servicePrincipal"]);
  assertEquals((await get(m.handle, `${GRAPH}/v1.0/groups`, "Bearer nope")).status, 401);
  const tok = await m.handle(new Request("https://login.microsoftonline.com/t/oauth2/v2.0/token", {
    method: "POST",
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: m.clientId, client_secret: "wrong" }),
  }));
  assertEquals(tok.status, 401);
});

// ---------------------------------------------------------------- Okta

Deno.test("okta: list omits DEPROVISIONED, pages by Link, search includes it", async () => {
  const m = new MockOktaDirectory({ users: 50, pageMax: 20, origin: "https://acme.okta.com" });
  const auth = `SSWS ${m.token}`;
  let url: string | undefined = "https://acme.okta.com/api/v1/users?limit=200";
  const ids: string[] = [];
  while (url) {
    const r = await get(m.handle, url, auth);
    for (const u of r.body as J[]) ids.push(u.id as string);
    url = nextLink(r.headers.get("link"));
  }
  assertEquals(ids.length, 50 - 3 - 2); // users 0, 23, 46 are DEPROVISIONED, 8 and 45 STAGED (plain list omits both)
  const every = await get(m.handle, `https://acme.okta.com/api/v1/users?limit=200&search=${encodeURIComponent(OKTA_EVERY_STATUS)}`, auth);
  assertEquals((every.body as J[]).length, 20, "first page of every status");
  m.update(7, "2026-10-11T10:00:00.000Z", { status: "DEPROVISIONED" });
  const s = await get(m.handle, `https://acme.okta.com/api/v1/users?search=${encodeURIComponent('lastUpdated gt "2026-10-05T00:00:00.000Z"')}`, auth);
  assertEquals((s.body as J[]).map((u) => u.status), ["DEPROVISIONED"]);
  const all = await get(m.handle, `https://acme.okta.com/api/v1/users?limit=200&search=${encodeURIComponent(`lastUpdated ge "${OKTA_BASE_UPDATED}"`)}`, auth);
  assertEquals((all.body as J[]).length, 20, "baseline cut matches everyone, deprovisioned too (first page)");
  assertEquals((await get(m.handle, "https://acme.okta.com/api/v1/users?search=bogus", auth)).status, 400);
});

Deno.test("okta: 429 with Retry-After and reset, 401 on a bad token, group members", async () => {
  const m = new MockOktaDirectory({ users: 30, groups: 2, membersPerGroup: 5, now: () => 1_000_000 });
  const auth = `SSWS ${m.token}`;
  m.faults.throttle(1, 3);
  const t = await get(m.handle, "https://acme.okta.com/api/v1/users", auth);
  assertEquals(t.status, 429);
  assertEquals(t.headers.get("retry-after"), "3");
  assertEquals(t.headers.get("x-rate-limit-reset"), String(1000 + 3));
  assertEquals((await get(m.handle, "https://acme.okta.com/api/v1/users", "SSWS nope")).status, 401);
  const gm = await get(m.handle, `https://acme.okta.com/api/v1/groups/${m.groups[1].id}/users`, auth);
  assertEquals((gm.body as J[]).length, 5);
});

Deno.test("okta: an all-STAGED org is invisible to the plain list, whole to the status search", async () => {
  const m = new MockOktaDirectory({ users: 24, allStaged: true, admins: { 5: ["USER_ADMIN"] } });
  const auth = `SSWS ${m.token}`;
  assertEquals(((await get(m.handle, "https://acme.okta.com/api/v1/users", auth)).body as J[]).length, 0);
  const all = await get(m.handle, `https://acme.okta.com/api/v1/users?search=${encodeURIComponent(OKTA_EVERY_STATUS)}`, auth);
  assertEquals((all.body as J[]).length, 24);
  const assignees = await get(m.handle, "https://acme.okta.com/api/v1/iam/assignees/users", auth);
  assertEquals((assignees.body.value as J[]).map((v) => v.id), [m.user(5).id]);
  const roles = await get(m.handle, `https://acme.okta.com/api/v1/users/${m.user(5).id}/roles`, auth);
  assertEquals((roles.body as J[]).map((r) => r.type), ["USER_ADMIN"]);
  assertEquals(((await get(m.handle, `https://acme.okta.com/api/v1/users/${m.user(6).id}/roles`, auth)).body as J[]).length, 0);
});

Deno.test("okta: assignees page by _links.next.href", async () => {
  const m = new MockOktaDirectory({ users: 300, admins: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [i * 2, ["READ_ONLY_ADMIN"]])), origin: "https://acme.okta.com" });
  const auth = `SSWS ${m.token}`;
  let url: string | undefined = "https://acme.okta.com/api/v1/iam/assignees/users";
  const ids = new Set<unknown>();
  while (url) {
    const r = await get(m.handle, url, auth);
    for (const v of r.body.value as J[]) ids.add(v.id);
    url = ((r.body._links as J).next as J | undefined)?.href as string | undefined;
  }
  assertEquals(ids.size, 150);
});

Deno.test("okta: 500k users are generated lazily and the last page is cheap", async () => {
  const m = new MockOktaDirectory({ users: 500_000 });
  const auth = `SSWS ${m.token}`;
  const t0 = performance.now();
  const r = await get(m.handle, "https://acme.okta.com/api/v1/users?limit=200&after=499900", auth);
  const page = r.body as J[];
  assert(page.length > 0 && page.length <= 100);
  assertEquals(nextLink(r.headers.get("link")), undefined);
  // A delta cut past the baseline scans only the changed users.
  m.update(123_456, "2026-10-11T10:00:00.000Z", { profile: { department: "Security" } });
  const d = await get(m.handle, `https://acme.okta.com/api/v1/users?search=${encodeURIComponent('lastUpdated gt "2026-10-02T00:00:00.000Z"')}`, auth);
  assertEquals((d.body as J[]).map((u) => (u.profile as J).department), ["Security"]);
  assert(performance.now() - t0 < 5_000, "lazy generation keeps 500k cheap");
});

// ---------------------------------------------------------------- recordings

Deno.test("recordings are up to date (deno run record.ts regenerates them)", async () => {
  const built = await buildRecordings();
  for (const [name, v] of Object.entries(built)) {
    const committed = JSON.parse(await Deno.readTextFile(new URL(`${name}.json`, recordingsDir)));
    assertEquals(committed, JSON.parse(JSON.stringify(v)), `${name}.json is stale`);
  }
  const files = [...Deno.readDirSync(recordingsDir)].map((e) => e.name.replace(/\.json$/, "")).sort();
  assertEquals(files, Object.keys(built).sort());
});

Deno.test("recordings use the preview Recorded shape", async () => {
  for await (const e of Deno.readDir(recordingsDir)) {
    if (e.name.endsWith(".state.json")) continue;
    const entries = JSON.parse(await Deno.readTextFile(new URL(e.name, recordingsDir))) as J[];
    assert(Array.isArray(entries) && entries.length > 0, e.name);
    for (const r of entries) {
      assert(typeof r.host === "string" && typeof r.path === "string" && "body" in r, `${e.name}: entry shape`);
      assert(!JSON.stringify(r).includes("Bearer "), `${e.name}: no credentials in recordings`);
    }
  }
});
