// Mock Google Admin SDK Directory API (NAN-3503). SYNTHETIC DATA ONLY.
//
//   POST /token                                   JWT-bearer exchange (any
//        assertion; its `scope` / `sub` claims are recorded for assertions)
//   GET  /admin/directory/v1/users                customer=my_customer,
//        maxResults (<=500), pageToken; projection=full adds organizations,
//        relations, phones, externalIds, addresses, locations
//   GET  /admin/directory/v1/groups               customer, maxResults (<=200), pageToken
//   GET  /admin/directory/v1/groups/{id}/members  maxResults (<=200), pageToken;
//        includeDerivedMembership=true adds members of nested groups
//
// Every API call needs `Authorization: Bearer <token>` from /token; a wrong
// token answers Google's 401. `faults.throttle(n)` arms n 429s (Retry-After).
//
// Standalone: deno run --allow-net --allow-env testing/directory-mocks/google.ts

import { type Served, Faults, hex, json, jwtClaims } from "./common.ts";

export interface GoogleOptions {
  users?: number;
  groups?: number;
  /** Members per group (users i*stride .. ), plus one nested group in group 0. */
  membersPerGroup?: number;
  accessToken?: string;
  domain?: string;
  /** Serve at most this many rows per page whatever maxResults asks (Google may). */
  pageMax?: number;
}

export function googleUser(i: number, domain = "example.com"): Record<string, unknown> {
  const id = `1${String(i).padStart(17, "0")}`;
  const email = `gws${i}@${domain}`;
  return {
    kind: "admin#directory#user",
    id,
    primaryEmail: email,
    name: { givenName: "Gws", familyName: `User${i}`, fullName: `Gws User${i}` },
    isAdmin: i === 0,
    isDelegatedAdmin: i === 1,
    lastLoginTime: i % 5 === 4 ? "1970-01-01T00:00:00.000Z" : "2026-10-09T12:00:00.000Z",
    creationTime: "2025-01-01T00:00:00.000Z",
    suspended: i % 17 === 3,
    archived: i % 29 === 5,
    isEnrolledIn2Sv: i % 3 !== 0,
    orgUnitPath: "/",
    organizations: [
      { name: "Example Corp", title: "Synthetic", department: i % 2 ? "Engineering" : "Finance", costCenter: "CC-1", description: i % 7 === 0 ? "contractor" : "employee", primary: true },
    ],
    relations: i === 0 ? [] : [{ type: "manager", value: `gws0@${domain}` }],
    phones: [{ type: "work", value: `+1 555 01${hex(i % 256, 2)}`, primary: true }],
    externalIds: [{ type: "organization", value: `E${10000 + i}` }],
    addresses: [{ type: "work", locality: "Ottawa", countryCode: "CA", primary: true }],
    locations: [{ type: "desk", area: "desk", buildingId: "HQ" }],
  };
}

function slim(u: Record<string, unknown>): Record<string, unknown> {
  const { organizations: _o, relations: _r, phones: _p, externalIds: _e, addresses: _a, locations: _l, ...rest } = u;
  return rest;
}

export class MockGoogleDirectory {
  readonly users: Record<string, unknown>[];
  readonly groups: { id: string; email: string; name: string; members: { id: string; email: string; type: string }[] }[];
  readonly accessToken: string;
  readonly faults = new Faults();
  readonly served: Served[] = [];
  readonly grants: Record<string, unknown>[] = [];
  pageMax: number;

  constructor(opts: GoogleOptions = {}) {
    const domain = opts.domain ?? "example.com";
    this.accessToken = opts.accessToken ?? "gws-mock-access";
    this.pageMax = opts.pageMax ?? Infinity;
    this.users = Array.from({ length: opts.users ?? 25 }, (_, i) => googleUser(i, domain));
    const per = opts.membersPerGroup ?? 5;
    const ng = opts.groups ?? 3;
    this.groups = Array.from({ length: ng }, (_, g) => ({
      id: `0${hex(g, 15)}`,
      email: g === 0 ? `admins@${domain}` : `group${g}@${domain}`,
      name: g === 0 ? "Admins" : `Group ${g}`,
      members: this.users.slice(g * per, g * per + per).map((u) => ({ id: u.id as string, email: u.primaryEmail as string, type: "USER" })),
    }));
    // Group 0 nests group 1: direct listing shows a GROUP member, derived
    // listing adds group 1's users.
    if (ng > 1) this.groups[0].members.push({ id: this.groups[1].id, email: this.groups[1].email, type: "GROUP" });
  }

  private page<T>(items: T[], q: URLSearchParams, max: number, def: number): { page: T[]; next?: string } {
    const size = Math.min(Math.max(parseInt(q.get("maxResults") ?? String(def), 10) || def, 1), max, this.pageMax);
    const start = q.get("pageToken") ? parseInt(atob(q.get("pageToken")!), 10) : 0;
    const page = items.slice(start, start + size);
    return { page, next: start + size < items.length ? btoa(String(start + size)) : undefined };
  }

  private derived(g: number, seen = new Set<string>()): { id: string; email: string; type: string }[] {
    const out: { id: string; email: string; type: string }[] = [];
    for (const m of this.groups[g].members) {
      if (m.type === "GROUP") {
        const sub = this.groups.findIndex((x) => x.id === m.id);
        if (sub >= 0 && !seen.has(m.id)) {
          seen.add(m.id);
          out.push(...this.derived(sub, seen));
        }
      } else if (!out.some((x) => x.id === m.id)) out.push(m);
    }
    return out;
  }

  handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const q = url.searchParams;
    const rec = (status: number, count = 0) =>
      this.served.push({ method: req.method, host: url.hostname, path: url.pathname, query: Object.fromEntries(q.entries()), status, count });

    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || !form.get("assertion")) {
        rec(400);
        return json({ error: "invalid_grant", error_description: "Invalid JWT" }, 400);
      }
      this.grants.push(jwtClaims(form.get("assertion")!));
      rec(200);
      return json({ access_token: this.accessToken, token_type: "Bearer", expires_in: 3600 });
    }
    if (req.headers.get("authorization") !== `Bearer ${this.accessToken}`) {
      rec(401);
      return json({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, 401);
    }
    if (this.faults.take429()) {
      rec(429);
      return json({ error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } }, 429, { "Retry-After": String(this.faults.retryAfterSecs) });
    }

    if (url.pathname === "/admin/directory/v1/users") {
      if (q.get("customer") !== "my_customer") {
        rec(400);
        return json({ error: { code: 400, message: "Bad Request: customer" } }, 400);
      }
      const { page, next } = this.page(this.users, q, 500, 100);
      const users = q.get("projection") === "full" ? page : page.map(slim);
      rec(200, users.length);
      return json({ kind: "admin#directory#users", users, ...(next ? { nextPageToken: next } : {}) });
    }
    if (url.pathname === "/admin/directory/v1/groups") {
      const { page, next } = this.page(this.groups, q, 200, 200);
      rec(200, page.length);
      return json({
        kind: "admin#directory#groups",
        groups: page.map((g) => ({ kind: "admin#directory#group", id: g.id, email: g.email, name: g.name, directMembersCount: String(g.members.length) })),
        ...(next ? { nextPageToken: next } : {}),
      });
    }
    const m = url.pathname.match(/^\/admin\/directory\/v1\/groups\/([^/]+)\/members$/);
    if (m) {
      const g = this.groups.findIndex((x) => x.id === decodeURIComponent(m[1]));
      if (g < 0) {
        rec(404);
        return json({ error: { code: 404, message: "Resource Not Found: groupKey" } }, 404);
      }
      const all = q.get("includeDerivedMembership") === "true" ? this.derived(g) : this.groups[g].members;
      const { page, next } = this.page(all, q, 200, 200);
      rec(200, page.length);
      return json({
        kind: "admin#directory#members",
        members: page.map((x) => ({ kind: "admin#directory#member", id: x.id, email: x.email, role: "MEMBER", type: x.type, status: "ACTIVE" })),
        ...(next ? { nextPageToken: next } : {}),
      });
    }
    rec(404);
    return json({ error: { code: 404, message: "Not Found" } }, 404);
  };
}

if (import.meta.main) {
  const mock = new MockGoogleDirectory({ users: parseInt(Deno.env.get("MOCK_USERS") ?? "25", 10) });
  const port = parseInt(Deno.env.get("PORT") ?? "8091", 10);
  Deno.serve({ port, hostname: "127.0.0.1" }, mock.handle);
}
