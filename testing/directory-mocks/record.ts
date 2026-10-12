// Recordings of the directory mocks in nano-connector's preview format
// (NAN-3503), so lane A's Rust tests and `nano-connector preview` can replay
// the identity specs with no network:
//
//   nano-connector preview integrations/okta_users/connector.yaml \
//     testing/directory-mocks/recordings/okta_full.json --config OKTA_DOMAIN=acme.okta.com --cred API_TOKEN=mock-token
//
// Each recording walks the request sequence the spec makes, in order (the
// replay transport consumes entries in order and matches host, path and the
// listed query keys). `*.state.json` holds the program state a delta run
// starts from (the stream's saved checkpoint state). Deterministic: the
// recordings test regenerates them and diffs against the committed files.
//
//   deno run --allow-read --allow-write testing/directory-mocks/record.ts

import { type Recorded, record } from "./common.ts";
import { MockGoogleDirectory } from "./google.ts";
import { GRAPH, MockGraph } from "./graph.ts";
import { MockOktaDirectory, OKTA_BASE_UPDATED } from "./okta.ts";

export type Recordings = Record<string, Recorded[] | Record<string, unknown>>;

const GRAPH_SELECT =
  "id,userPrincipalName,mail,displayName,givenName,surname,department,jobTitle,companyName,officeLocation,city,country,accountEnabled,employeeId,employeeType,userType,createdDateTime,mobilePhone,businessPhones";
const OKTA = "https://acme.okta.com";

async function google(): Promise<Recorded[]> {
  const m = new MockGoogleDirectory({ users: 25, groups: 3, membersPerGroup: 5, pageMax: 10 });
  const auth = { headers: { Authorization: `Bearer ${m.accessToken}` } };
  const out: Recorded[] = [];
  const claims = btoa(JSON.stringify({ iss: "svc@mock.iam.gserviceaccount.com", sub: "admin@example.com", scope: "mock" }));
  out.push(await record(m.handle, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=h.${claims}.s`,
  }, []));
  let tok: string | undefined;
  do {
    const u = new URL("https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=500&projection=full");
    if (tok) u.searchParams.set("pageToken", tok);
    const r = await record(m.handle, u.toString(), auth, ["customer", "projection", "pageToken"]);
    out.push(r);
    tok = (r.body as { nextPageToken?: string }).nextPageToken;
  } while (tok);
  const g = await record(m.handle, "https://admin.googleapis.com/admin/directory/v1/groups?customer=my_customer&maxResults=200", auth, ["customer"]);
  out.push(g);
  for (const grp of (g.body as { groups: { id: string }[] }).groups) {
    out.push(await record(m.handle, `https://admin.googleapis.com/admin/directory/v1/groups/${grp.id}/members?maxResults=200&includeDerivedMembership=true`, auth, ["includeDerivedMembership"]));
  }
  return out;
}

async function graphMemberships(m: MockGraph, auth: RequestInit): Promise<Recorded[]> {
  const out: Recorded[] = [];
  const g = await record(m.handle, `${GRAPH}/v1.0/groups?$select=id,displayName,securityEnabled&$top=999`, auth, []);
  out.push(g);
  for (const grp of (g.body as { value: { id: string }[] }).value) {
    out.push(await record(m.handle, `${GRAPH}/v1.0/groups/${grp.id}/transitiveMembers/microsoft.graph.user?$select=id&$top=999`, auth, []));
  }
  const r = await record(m.handle, `${GRAPH}/v1.0/directoryRoles?$select=id,displayName`, auth, []);
  out.push(r);
  for (const role of (r.body as { value: { id: string }[] }).value) {
    out.push(await record(m.handle, `${GRAPH}/v1.0/directoryRoles/${role.id}/members?$select=id`, auth, []));
  }
  return out;
}

async function graph(): Promise<Recordings> {
  const m = new MockGraph({ users: 24, groups: 4, membersPerGroup: 4, pageMax: 10, deltaPageSize: 3 });
  const auth = { headers: { Authorization: `Bearer ${m.accessToken}` } };
  const full: Recorded[] = [];
  // Self-hosted token exchange (oauth2_client_credentials).
  full.push(await record(m.handle, "https://login.microsoftonline.com/e6800ccd-0000-4000-8000-000000000000/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: m.clientId, client_secret: m.clientSecret, scope: "https://graph.microsoft.com/.default" }).toString(),
  }, []));
  const base = await record(m.handle, `${GRAPH}/v1.0/users/delta?$deltatoken=latest&$select=${GRAPH_SELECT},manager`, auth, ["$deltatoken"]);
  full.push(base);
  const deltaLink = (base.body as Record<string, string>)["@odata.deltaLink"];
  let next: string | undefined = `${GRAPH}/v1.0/users?$select=${GRAPH_SELECT}&$expand=manager&$top=100`;
  let first = true;
  while (next) {
    const r = await record(m.handle, next, auth, first ? ["$expand", "$top"] : ["$expand", "$skiptoken"]);
    first = false;
    full.push(r);
    next = (r.body as Record<string, string>)["@odata.nextLink"];
  }
  full.push(...await graphMemberships(m, auth));

  // Changes after the baseline: an edit, a manager move, a disable, a delete.
  m.updateUser(3, { department: "Security", jobTitle: "Analyst" });
  m.setManager(4, 2);
  m.updateUser(6, { accountEnabled: false });
  m.removeUser(5);
  const delta: Recorded[] = [];
  let link: string | undefined = deltaLink;
  let newDelta = "";
  while (link) {
    const r = await record(m.handle, link, auth, ["$deltatoken", "$skiptoken"]);
    delta.push(r);
    const b = r.body as Record<string, string>;
    link = b["@odata.nextLink"];
    if (b["@odata.deltaLink"]) newDelta = b["@odata.deltaLink"];
  }
  delta.push(...await graphMemberships(m, auth));

  m.expireTokens();
  const gone = [await record(m.handle, newDelta, auth, ["$deltatoken"])];
  const m2 = new MockGraph({ users: 4 });
  m2.expiry = "syncStateNotFound";
  const l2 = (await (await m2.handle(new Request(`${GRAPH}/v1.0/users/delta?$deltatoken=latest&$select=id,manager`, auth))).json())["@odata.deltaLink"];
  m2.expireTokens();
  const syncState = [await record(m2.handle, l2, auth, ["$deltatoken"])];

  return {
    graph_full: full,
    graph_delta: delta,
    "graph_delta.state": { users: { delta_link: deltaLink } },
    graph_delta_410: gone,
    "graph_delta_410.state": { users: { delta_link: newDelta } },
    graph_delta_sync_state_not_found: syncState,
    "graph_delta_sync_state_not_found.state": { users: { delta_link: l2 } },
  };
}

async function okta(): Promise<Recordings> {
  const m = new MockOktaDirectory({ users: 45, groups: 3, membersPerGroup: 5, pageMax: 20, origin: OKTA, now: () => Date.parse("2026-10-12T00:00:00Z") });
  const auth = { headers: { Authorization: `SSWS ${m.token}` } };
  const walk = async (start: string, keys: string[]): Promise<Recorded[]> => {
    const out: Recorded[] = [];
    let next: string | undefined = start;
    while (next) {
      const r = await record(m.handle, next, auth, keys);
      out.push(r);
      next = r.headers?.link?.match(/<([^>]+)>; rel="next"/)?.[1];
    }
    return out;
  };
  const memberships = async (): Promise<Recorded[]> => {
    const out = await walk(`${OKTA}/api/v1/groups?limit=200`, ["after"]);
    for (const r of [...out]) {
      for (const g of r.body as { id: string }[]) out.push(...await walk(`${OKTA}/api/v1/groups/${g.id}/users?limit=200`, ["after"]));
    }
    return out;
  };
  const full = [...await walk(`${OKTA}/api/v1/users?limit=200`, ["after", "search"]), ...await memberships()];

  // Delta: the program asks lastUpdated gt (cursor - 300 s).
  m.update(7, "2026-10-11T10:00:00.000Z", { status: "DEPROVISIONED" });
  m.update(9, "2026-10-11T11:00:00.000Z", { profile: { department: "Security" } });
  m.update(12, "2026-10-11T12:00:00.000Z", { status: "SUSPENDED" });
  const since = new Date(Date.parse(OKTA_BASE_UPDATED) - 300_000).toISOString();
  const deltaUsers = await walk(`${OKTA}/api/v1/users?limit=200&search=${encodeURIComponent(`lastUpdated gt "${since}"`)}`, ["after", "search"]);
  // A cursor past the baseline returns only the changed users.
  const since2 = new Date(Date.parse("2026-10-11T10:30:00.000Z") - 300_000).toISOString();
  const delta2 = await walk(`${OKTA}/api/v1/users?limit=200&search=${encodeURIComponent(`lastUpdated gt "${since2}"`)}`, ["after", "search"]);

  m.faults.throttle(1, 1);
  const throttled = [await record(m.handle, `${OKTA}/api/v1/users?limit=200`, auth, ["after"]), ...await walk(`${OKTA}/api/v1/users?limit=200`, ["after"])];
  return {
    okta_full: full,
    okta_delta_since_baseline: [...deltaUsers, ...await memberships()],
    "okta_delta_since_baseline.state": { users: { last_updated: OKTA_BASE_UPDATED, seen_max: "" } },
    okta_delta: [...delta2, ...await memberships()],
    "okta_delta.state": { users: { last_updated: "2026-10-11T10:30:00.000Z", seen_max: "" } },
    okta_429: [...throttled, ...await memberships()],
  };
}

export async function buildRecordings(): Promise<Recordings> {
  return { google_directory: await google(), ...await graph(), ...await okta() };
}

export const recordingsDir = new URL("./recordings/", import.meta.url);

if (import.meta.main) {
  await Deno.mkdir(recordingsDir, { recursive: true });
  for (const [name, v] of Object.entries(await buildRecordings())) {
    await Deno.writeTextFile(new URL(`${name}.json`, recordingsDir), JSON.stringify(v, null, 1) + "\n");
  }
}
