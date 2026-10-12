// Mock Microsoft Graph v1.0 directory endpoints (NAN-3503). SYNTHETIC DATA ONLY.
//
//   POST /{tenant}/oauth2/v2.0/token   client_credentials (self-hosted auth)
//   GET  /v1.0/users                   $select, $expand=manager, $top, $skiptoken;
//        @odata.nextLink. Page size 1..999, but 1..100 with $expand (Graph
//        refuses a larger page on expanded directory queries).
//   GET  /v1.0/users/delta             no token: initial round; $deltatoken=latest:
//        empty page + deltaLink ("sync from now"); $deltatoken=<t>: changes since
//        t, updated users in full (selected props + manager@delta), removed
//        users as {id, @removed}. $expand / $top are refused (400), as Graph
//        does for users/delta. An expired token answers 410 Gone (default) or
//        400 syncStateNotFound (`expiry = "syncStateNotFound"`).
//   GET  /v1.0/groups                  $select, $top, nextLink
//   GET  /v1.0/groups/{id}/members[/microsoft.graph.user]
//   GET  /v1.0/groups/{id}/transitiveMembers[/microsoft.graph.user]
//   GET  /v1.0/directoryRoles          activated roles
//   GET  /v1.0/directoryRoles/{id}/members   users AND service principals
//
// Mutations for delta tests: updateUser(i, patch), setManager(i, j),
// removeUser(i), expireTokens(). faults.throttle(n) arms 429 + Retry-After.
//
// Standalone: deno run --allow-net --allow-env testing/directory-mocks/graph.ts

import { type Served, Faults, guid, json } from "./common.ts";

export const GRAPH = "https://graph.microsoft.com";
const USER_TYPE = "#microsoft.graph.user";

export interface GraphOptions {
  users?: number;
  groups?: number;
  membersPerGroup?: number;
  accessToken?: string;
  clientId?: string;
  clientSecret?: string;
  /** Rows per users/delta page (Graph varies it; small pages exercise nextLink). */
  deltaPageSize?: number;
  domain?: string;
  /** Serve at most this many rows per list page whatever $top asks (Graph may). */
  pageMax?: number;
}

type User = Record<string, unknown> & { id: string };

export function graphUser(i: number, n: number, domain = "example.onmicrosoft.com"): User {
  const guest = i % 11 === 10;
  return {
    id: guid(1, i),
    userPrincipalName: guest ? `guest${i}_partner.example#EXT#@${domain}` : `entra${i}@${domain}`,
    mail: guest ? `guest${i}@partner.example` : `entra${i}@${domain}`,
    displayName: `Entra User${i}`,
    givenName: "Entra",
    surname: `User${i}`,
    department: i % 2 ? "Engineering" : "Finance",
    jobTitle: "Synthetic",
    companyName: "Example Corp",
    officeLocation: "HQ 2",
    city: "Ottawa",
    country: "CA",
    accountEnabled: i % 13 !== 7,
    employeeId: guest ? null : `E${20000 + i}`,
    employeeType: guest ? null : (i % 7 === 0 ? "Contractor" : "Employee"),
    userType: guest ? "Guest" : "Member",
    createdDateTime: "2025-01-01T00:00:00Z",
    mobilePhone: i % 3 === 0 ? null : `+1 555 02${String(i % 100).padStart(2, "0")}`,
    businessPhones: ["+1 555 0100"],
    _manager: i === 0 ? null : Math.min(Math.floor((i - 1) / 5), n - 1),
  };
}

function enc(v: unknown): string {
  return btoa(JSON.stringify(v)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function dec(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")));
  } catch {
    return null;
  }
}

export class MockGraph {
  readonly users: User[];
  readonly removed = new Set<number>();
  readonly groups: { id: string; displayName: string; securityEnabled: boolean; members: { kind: "user" | "group"; idx: number }[] }[];
  readonly roles: { id: string; displayName: string; members: { type: string; id: string }[] }[];
  readonly faults = new Faults();
  readonly served: Served[] = [];
  readonly accessToken: string;
  readonly clientId: string;
  readonly clientSecret: string;
  deltaPageSize: number;
  pageMax: number;
  /** Change log: seq -> user index. A token holds the seq it was minted at. */
  private changes: { seq: number; idx: number }[] = [];
  private seq = 0;
  private minValidSeq = 0;
  expiry: "gone" | "syncStateNotFound" = "gone";

  constructor(opts: GraphOptions = {}) {
    const n = opts.users ?? 24;
    this.users = Array.from({ length: n }, (_, i) => graphUser(i, n, opts.domain));
    this.accessToken = opts.accessToken ?? "graph-mock-access";
    this.clientId = opts.clientId ?? guid(9, 1);
    this.clientSecret = opts.clientSecret ?? "graph-mock-secret";
    this.deltaPageSize = opts.deltaPageSize ?? 3;
    this.pageMax = opts.pageMax ?? Infinity;
    const per = opts.membersPerGroup ?? 4;
    this.groups = Array.from({ length: opts.groups ?? 4 }, (_, g) => ({
      id: guid(2, g),
      displayName: g === 0 ? "Privileged Ops" : `Group ${g}`,
      securityEnabled: true,
      members: Array.from({ length: per }, (_, k) => ({ kind: "user" as const, idx: (g * per + k) % n })),
    }));
    // Group 0 nests group 1 (transitiveMembers flattens it).
    if (this.groups.length > 1) this.groups[0].members.push({ kind: "group", idx: 1 });
    this.roles = [
      { id: guid(3, 0), displayName: "Global Administrator", members: [{ type: USER_TYPE, id: guid(1, 0) }] },
      {
        id: guid(3, 1),
        displayName: "User Administrator",
        members: [{ type: USER_TYPE, id: guid(1, 2) }, { type: "#microsoft.graph.servicePrincipal", id: guid(4, 0) }],
      },
    ];
  }

  private bump(idx: number): void {
    this.changes.push({ seq: ++this.seq, idx });
  }
  updateUser(i: number, patch: Record<string, unknown>): void {
    Object.assign(this.users[i], patch);
    this.bump(i);
  }
  setManager(i: number, j: number | null): void {
    this.users[i]._manager = j;
    this.bump(i);
  }
  removeUser(i: number): void {
    this.removed.add(i);
    this.bump(i);
  }
  /** Every delta token minted so far stops working (seven-day expiry, resync). */
  expireTokens(): void {
    this.minValidSeq = this.seq + 1;
  }

  private select(u: User, sel: string[] | null, expandManager: boolean, deltaManager: boolean): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(u)) {
      if (k.startsWith("_")) continue;
      if (sel && k !== "id" && !sel.includes(k)) continue;
      out[k] = v;
    }
    const m = u._manager as number | null;
    if (expandManager && m !== null) {
      const mu = this.users[m];
      out.manager = { "@odata.type": USER_TYPE, id: mu.id, userPrincipalName: mu.userPrincipalName, displayName: mu.displayName, mail: mu.mail };
    }
    if (deltaManager) out["manager@delta"] = m === null ? [] : [{ "@odata.type": USER_TYPE, id: this.users[m].id }];
    return out;
  }

  private live(): number[] {
    return this.users.map((_, i) => i).filter((i) => !this.removed.has(i));
  }

  private transitive(g: number, seen = new Set<number>()): number[] {
    const out: number[] = [];
    for (const m of this.groups[g].members) {
      if (m.kind === "group") {
        if (!seen.has(m.idx)) {
          seen.add(m.idx);
          for (const x of this.transitive(m.idx, seen)) if (!out.includes(x)) out.push(x);
        }
      } else if (!out.includes(m.idx)) out.push(m.idx);
    }
    return out;
  }

  private err(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
    return json({ error: { code, message, innerError: { "request-id": "mock" } } }, status, headers);
  }

  handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const q = url.searchParams;
    let count = 0;
    const rec = (status: number) =>
      this.served.push({ method: req.method, host: url.hostname, path: url.pathname, query: Object.fromEntries(q.entries()), status, count });
    const reply = (r: Response) => {
      rec(r.status);
      return r;
    };

    const tok = url.pathname.match(/^\/([^/]+)\/oauth2\/v2\.0\/token$/);
    if (tok && req.method === "POST") {
      const f = new URLSearchParams(await req.text());
      if (f.get("grant_type") !== "client_credentials" || f.get("client_id") !== this.clientId || f.get("client_secret") !== this.clientSecret) {
        return reply(json({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." }, 401));
      }
      return reply(json({ token_type: "Bearer", expires_in: 3599, access_token: this.accessToken }));
    }
    if (req.headers.get("authorization") !== `Bearer ${this.accessToken}`) {
      return reply(this.err(401, "InvalidAuthenticationToken", "Access token is empty or invalid."));
    }
    if (this.faults.take429()) {
      return reply(this.err(429, "TooManyRequests", "Too many requests", { "Retry-After": String(this.faults.retryAfterSecs) }));
    }

    const sel = q.get("$select")?.split(",").map((s) => s.trim()) ?? null;
    const path = url.pathname.replace(/\(\)$/, "");

    if (path === "/v1.0/users/delta") {
      if (q.has("$expand") || q.has("$top") || q.has("$orderby")) {
        return reply(this.err(400, "Request_UnsupportedQuery", "Unsupported query for users/delta."));
      }
      const link = (kind: "next" | "delta", state: Record<string, unknown>) =>
        `${GRAPH}/v1.0/users/delta()?${kind === "next" ? "$skiptoken" : "$deltatoken"}=${enc(state)}`;
      let st: Record<string, unknown>;
      if (q.get("$deltatoken") === "latest") {
        return reply(json({ "@odata.context": `${GRAPH}/v1.0/$metadata#users`, value: [], "@odata.deltaLink": link("delta", { seq: this.seq, sel }) }));
      } else if (q.has("$deltatoken") || q.has("$skiptoken")) {
        const d = dec(q.get("$deltatoken") ?? q.get("$skiptoken") ?? "");
        if (!d || typeof d.seq !== "number") return reply(this.err(400, "Request_BadRequest", "Invalid delta token."));
        if (d.seq < this.minValidSeq) {
          return this.expiry === "gone"
            ? reply(new Response(null, { status: 410, headers: { Location: `${GRAPH}/v1.0/users/delta?$deltatoken=` } }))
            : reply(this.err(400, "syncStateNotFound", "The sync state cannot be found."));
        }
        st = d;
      } else {
        st = { seq: -1, sel, initial: true };
      }
      const s = (st.sel as string[] | null) ?? sel;
      const trackManager = !!s && s.includes("manager");
      const props = s ? s.filter((x) => x !== "manager") : null;
      // The round's rows: initial = every live user; else the latest change per user since seq.
      let idxs: number[];
      const upto = typeof st.upto === "number" ? st.upto : this.seq;
      if (st.initial) idxs = this.live();
      else {
        const since = st.seq as number;
        idxs = [...new Set(this.changes.filter((c) => c.seq > since && c.seq <= upto).map((c) => c.idx))];
      }
      const offset = typeof st.offset === "number" ? st.offset : 0;
      const page = idxs.slice(offset, offset + this.deltaPageSize);
      const value = page.map((i) =>
        this.removed.has(i)
          ? { "@odata.type": USER_TYPE, id: this.users[i].id, "@removed": { reason: "deleted" } }
          : this.select(this.users[i], props, false, trackManager)
      );
      count = value.length;
      const more = offset + this.deltaPageSize < idxs.length;
      const body: Record<string, unknown> = { "@odata.context": `${GRAPH}/v1.0/$metadata#users`, value };
      if (more) body["@odata.nextLink"] = link("next", { ...st, sel: s, upto, offset: offset + this.deltaPageSize });
      else body["@odata.deltaLink"] = link("delta", { seq: upto, sel: s });
      return reply(json(body));
    }

    if (path === "/v1.0/users") {
      const expand = q.get("$expand");
      const max = expand ? 100 : 999;
      const top = parseInt(q.get("$top") ?? "100", 10);
      if (!(top >= 1 && top <= max)) {
        return reply(this.err(400, "Request_UnsupportedQuery", `Invalid page size specified: '${top}'. Must be between 1 and ${max} inclusive.`));
      }
      const all = this.live();
      const size = Math.min(top, this.pageMax);
      const start = q.get("$skiptoken") ? (dec(q.get("$skiptoken")!)?.start as number ?? 0) : 0;
      const page = all.slice(start, start + size);
      const value = page.map((i) => this.select(this.users[i], sel, expand === "manager" || !!expand?.startsWith("manager("), false));
      count = value.length;
      const body: Record<string, unknown> = { "@odata.context": `${GRAPH}/v1.0/$metadata#users`, value };
      if (start + size < all.length) {
        const n = new URL(`${GRAPH}/v1.0/users`);
        for (const [k, v] of q.entries()) if (k !== "$skiptoken") n.searchParams.set(k, v);
        n.searchParams.set("$skiptoken", enc({ start: start + size }));
        body["@odata.nextLink"] = n.toString();
      }
      return reply(json(body));
    }

    if (path === "/v1.0/groups") {
      const top = Math.min(parseInt(q.get("$top") ?? "100", 10) || 100, 999);
      const start = q.get("$skiptoken") ? (dec(q.get("$skiptoken")!)?.start as number ?? 0) : 0;
      const page = this.groups.slice(start, start + top);
      count = page.length;
      const body: Record<string, unknown> = { value: page.map((g) => ({ id: g.id, displayName: g.displayName, securityEnabled: g.securityEnabled })) };
      if (start + top < this.groups.length) {
        const n = new URL(`${GRAPH}/v1.0/groups`);
        for (const [k, v] of q.entries()) if (k !== "$skiptoken") n.searchParams.set(k, v);
        n.searchParams.set("$skiptoken", enc({ start: start + top }));
        body["@odata.nextLink"] = n.toString();
      }
      return reply(json(body));
    }

    const gm = path.match(/^\/v1\.0\/groups\/([^/]+)\/(members|transitiveMembers)(\/microsoft\.graph\.user)?$/);
    if (gm) {
      const g = this.groups.findIndex((x) => x.id === gm[1]);
      if (g < 0) return reply(this.err(404, "Request_ResourceNotFound", `Resource '${gm[1]}' does not exist.`));
      const usersOnly = !!gm[3];
      let objs: Record<string, unknown>[];
      if (gm[2] === "transitiveMembers") {
        objs = this.transitive(g).filter((i) => !this.removed.has(i)).map((i) => ({ "@odata.type": USER_TYPE, id: this.users[i].id }));
        if (!usersOnly) {
          for (const m of this.groups[g].members) if (m.kind === "group") objs.push({ "@odata.type": "#microsoft.graph.group", id: this.groups[m.idx].id });
        }
      } else {
        objs = this.groups[g].members
          .filter((m) => !(m.kind === "user" && this.removed.has(m.idx)))
          .filter((m) => !usersOnly || m.kind === "user")
          .map((m) => m.kind === "user" ? { "@odata.type": USER_TYPE, id: this.users[m.idx].id } : { "@odata.type": "#microsoft.graph.group", id: this.groups[m.idx].id });
      }
      const top = Math.min(parseInt(q.get("$top") ?? "100", 10) || 100, 999);
      const start = q.get("$skiptoken") ? (dec(q.get("$skiptoken")!)?.start as number ?? 0) : 0;
      const page = objs.slice(start, start + top);
      count = page.length;
      const body: Record<string, unknown> = { value: page };
      if (start + top < objs.length) {
        const n = new URL(GRAPH + url.pathname);
        for (const [k, v] of q.entries()) if (k !== "$skiptoken") n.searchParams.set(k, v);
        n.searchParams.set("$skiptoken", enc({ start: start + top }));
        body["@odata.nextLink"] = n.toString();
      }
      return reply(json(body));
    }

    if (path === "/v1.0/directoryRoles") {
      count = this.roles.length;
      return reply(json({ value: this.roles.map((r) => ({ id: r.id, displayName: r.displayName })) }));
    }
    const rm = path.match(/^\/v1\.0\/directoryRoles\/([^/]+)\/members$/);
    if (rm) {
      const r = this.roles.find((x) => x.id === rm[1]);
      if (!r) return reply(this.err(404, "Request_ResourceNotFound", `Resource '${rm[1]}' does not exist.`));
      count = r.members.length;
      return reply(json({ value: r.members.map((m) => ({ "@odata.type": m.type, id: m.id })) }));
    }
    return reply(this.err(404, "Request_ResourceNotFound", "Not found"));
  };
}

if (import.meta.main) {
  const mock = new MockGraph({ users: parseInt(Deno.env.get("MOCK_USERS") ?? "24", 10) });
  const port = parseInt(Deno.env.get("PORT") ?? "8092", 10);
  Deno.serve({ port, hostname: "127.0.0.1" }, mock.handle);
}
