// Mock Okta Users + Groups APIs for directory sync (NAN-3503). SYNTHETIC DATA ONLY.
//
//   GET /api/v1/users           limit (<=200), after; Link rel="next". Without
//        `search`/`filter` the list omits STAGED and DEPROVISIONED users, as
//        Okta does. search=lastUpdated gt "<ISO>" (or ge) and
//        search=status eq "A" or status eq "B" ... return matching users of
//        every status.
//   GET /api/v1/iam/assignees/users  users holding an admin role: {value:
//        [{id, orn}], _links: {next: {href}}}; limit (default 100), after
//   GET /api/v1/users/{id}/roles     [{id, type, label, status, assignmentType}]
//   GET /api/v1/groups          limit (<=200), after; Link rel="next"
//   GET /api/v1/groups/{id}/users   limit (<=200), after; Link rel="next"
//
// Users are generated LAZILY from their index, so `users: 500_000` costs no
// memory until a page is asked for; changes are kept as per-index overrides.
// `faults.throttle(n, secs)` arms n 429s with Retry-After and
// X-Rate-Limit-Reset; a wrong SSWS token answers Okta's E0000011 401.
//
// Standalone: deno run --allow-net --allow-env testing/directory-mocks/okta.ts

import { type Served, Faults, hex, json } from "./common.ts";

export const OKTA_BASE_UPDATED = "2026-10-01T00:00:00.000Z";

export interface OktaDirectoryOptions {
  users?: number;
  groups?: number;
  membersPerGroup?: number;
  token?: string;
  origin?: string;
  /** Clock for X-Rate-Limit-Reset (tests pin it). */
  now?: () => number;
  /** Serve at most this many rows per page whatever `limit` asks. */
  pageMax?: number;
  /** Admin role types per user index (default: 1 USER_ADMIN, 2 READ_ONLY_ADMIN + HELP_DESK_ADMIN). */
  admins?: Record<number, string[]>;
  /** Every user STAGED (created with activate=false), like the integrator test org. */
  allStaged?: boolean;
}

export function oktaUser(i: number): Record<string, unknown> {
  const status = i % 23 === 0 ? "DEPROVISIONED" : i % 19 === 4 ? "SUSPENDED" : i % 31 === 6 ? "LOCKED_OUT" : i % 37 === 8 ? "STAGED" : "ACTIVE";
  return {
    id: `00udir${hex(i, 14)}`,
    status,
    created: "2025-01-01T00:00:00.000Z",
    activated: "2025-01-01T00:00:00.000Z",
    statusChanged: OKTA_BASE_UPDATED,
    lastLogin: i % 5 === 4 ? null : "2026-10-09T12:00:00.000Z",
    lastUpdated: OKTA_BASE_UPDATED,
    passwordChanged: "2025-06-01T00:00:00.000Z",
    type: { id: "otymock" },
    profile: {
      login: `okta${i}@example.com`,
      email: `okta${i}@example.com`,
      firstName: "Okta",
      lastName: `User${i}`,
      displayName: i % 4 === 0 ? null : `Okta User${i}`,
      department: i % 2 ? "Engineering" : "Finance",
      title: "Synthetic",
      manager: i === 0 ? null : "Okta User0",
      managerId: i === 0 ? null : "okta0@example.com",
      employeeNumber: `E${30000 + i}`,
      userType: i % 7 === 0 ? "Contractor" : "Employee",
      organization: "Example Corp",
      city: "Ottawa",
      countryCode: "CA",
      mobilePhone: i % 3 === 0 ? null : "+1 555 0300",
      primaryPhone: "+1 555 0100",
    },
    _links: { self: { href: `https://acme.okta.com/api/v1/users/00udir${hex(i, 14)}` } },
  };
}

export class MockOktaDirectory {
  readonly n: number;
  readonly token: string;
  readonly faults = new Faults();
  readonly served: Served[] = [];
  private overrides = new Map<number, Record<string, unknown>>();
  private origin?: string;
  private now: () => number;
  pageMax: number;
  readonly admins: Record<number, string[]>;
  readonly allStaged: boolean;
  readonly groups: { id: string; name: string; members: number[] }[];

  constructor(opts: OktaDirectoryOptions = {}) {
    this.n = opts.users ?? 450;
    this.token = opts.token ?? "mock-token";
    this.origin = opts.origin;
    this.now = opts.now ?? Date.now;
    this.pageMax = opts.pageMax ?? 200;
    this.admins = opts.admins ?? { 1: ["USER_ADMIN"], 2: ["READ_ONLY_ADMIN", "HELP_DESK_ADMIN"] };
    this.allStaged = opts.allStaged ?? false;
    const per = opts.membersPerGroup ?? 5;
    this.groups = Array.from({ length: opts.groups ?? 3 }, (_, g) => ({
      id: `00gdir${hex(g, 14)}`,
      name: g === 0 ? "Okta Admins" : `Group ${g}`,
      members: Array.from({ length: per }, (_, k) => (g * per + k) % this.n),
    }));
  }

  user(i: number): Record<string, unknown> {
    const o = this.overrides.get(i);
    if (o) return o;
    const u = oktaUser(i);
    if (this.allStaged) {
      u.status = "STAGED";
      u.activated = null;
      u.lastLogin = null;
    }
    return u;
  }

  /** Change user i at `when` (ISO): status and/or profile fields. */
  update(i: number, when: string, change: { status?: string; profile?: Record<string, unknown> }): void {
    const u = structuredClone(this.user(i));
    if (change.status) {
      u.status = change.status;
      u.statusChanged = when;
    }
    if (change.profile) u.profile = { ...(u.profile as Record<string, unknown>), ...change.profile };
    u.lastUpdated = when;
    this.overrides.set(i, u);
  }

  private link(origin: string, path: string, q: URLSearchParams, after: number | null): string {
    const self = new URL(path, origin);
    for (const [k, v] of q.entries()) self.searchParams.set(k, v);
    const links = [`<${self}>; rel="self"`];
    if (after !== null) {
      const next = new URL(path, origin);
      for (const [k, v] of q.entries()) if (k !== "after") next.searchParams.set(k, v);
      next.searchParams.set("after", String(after));
      links.push(`<${next}>; rel="next"`);
    }
    return links.join(", ");
  }

  private rate(remaining: number): Record<string, string> {
    return {
      "X-Rate-Limit-Limit": "600",
      "X-Rate-Limit-Remaining": String(remaining),
      "X-Rate-Limit-Reset": String(Math.ceil(this.now() / 1000) + this.faults.retryAfterSecs),
    };
  }

  handle = (req: Request): Response => {
    const url = new URL(req.url);
    const q = url.searchParams;
    let count = 0;
    const reply = (r: Response) => {
      this.served.push({ method: req.method, host: url.hostname, path: url.pathname, query: Object.fromEntries(q.entries()), status: r.status, count });
      return r;
    };
    if (req.headers.get("authorization") !== `SSWS ${this.token}`) {
      return reply(json({ errorCode: "E0000011", errorSummary: "Invalid token provided", errorLink: "E0000011", errorId: "oaemock401", errorCauses: [] }, 401));
    }
    if (this.faults.take429()) {
      return reply(json(
        { errorCode: "E0000047", errorSummary: "API call exceeded rate limit due to too many requests.", errorLink: "E0000047", errorId: "oaemock429", errorCauses: [] },
        429,
        { ...this.rate(0), "Retry-After": String(this.faults.retryAfterSecs) },
      ));
    }
    const origin = this.origin ?? url.origin;
    const limit = Math.min(Math.max(parseInt(q.get("limit") ?? "200", 10) || 200, 1), 200, this.pageMax);
    const after = q.has("after") ? parseInt(q.get("after")!, 10) : 0;

    if (url.pathname === "/api/v1/users") {
      const search = q.get("search") ?? q.get("filter");
      let pred: (u: Record<string, unknown>) => boolean = (u) => u.status !== "DEPROVISIONED" && u.status !== "STAGED";
      // Indexes to scan: everything, or only overrides when the cut is past
      // the generated baseline (keeps a 500k delta query cheap).
      let scan: Iterable<number> | null = null;
      const statuses = search?.split(/ or /).map((c) => c.match(/^status eq "([A-Z_]+)"$/)?.[1]);
      if (search && statuses && statuses.every((x) => x !== undefined)) {
        const want = new Set(statuses);
        pred = (u) => want.has(u.status as string);
      } else if (search) {
        const m = search.match(/^lastUpdated (gt|ge) "([^"]+)"$/);
        if (!m || Number.isNaN(Date.parse(m[2]))) {
          return reply(json({ errorCode: "E0000031", errorSummary: "Invalid search criteria.", errorCauses: [] }, 400));
        }
        const cut = Date.parse(m[2]);
        const gt = m[1] === "gt";
        pred = (u) => (gt ? Date.parse(u.lastUpdated as string) > cut : Date.parse(u.lastUpdated as string) >= cut);
        if (Date.parse(OKTA_BASE_UPDATED) < cut || (gt && Date.parse(OKTA_BASE_UPDATED) === cut)) {
          scan = [...this.overrides.keys()].sort((a, b) => a - b);
        }
      }
      const page: Record<string, unknown>[] = [];
      let next: number | null = null;
      const it = scan ?? { [Symbol.iterator]: function* (this: MockOktaDirectory) { for (let i = 0; i < this.n; i++) yield i; }.bind(this) };
      for (const i of it) {
        if (i < after) continue;
        const u = this.user(i);
        if (!pred(u)) continue;
        if (page.length === limit) {
          next = i;
          break;
        }
        page.push(u);
      }
      count = page.length;
      return reply(json(page, 200, { ...this.rate(500), Link: this.link(origin, url.pathname, q, next) }));
    }
    const ur = url.pathname.match(/^\/api\/v1\/users\/([^/]+)\/roles$/);
    if (ur) {
      const i = parseInt(ur[1].replace(/^00udir/, ""), 16);
      if (!(i >= 0 && i < this.n) || ur[1] !== this.user(i).id) {
        return reply(json({ errorCode: "E0000007", errorSummary: `Not found: Resource not found: ${ur[1]} (User)` }, 404));
      }
      const roles = (this.admins[i] ?? []).map((t, k) => ({
        id: `ra1dir${hex(i, 8)}${hex(k, 2)}`,
        label: t.split("_").map((w) => w[0] + w.slice(1).toLowerCase()).join(" "),
        type: t,
        status: "ACTIVE",
        created: "2025-01-01T00:00:00.000Z",
        lastUpdated: OKTA_BASE_UPDATED,
        assignmentType: "USER",
      }));
      count = roles.length;
      return reply(json(roles, 200, this.rate(500)));
    }
    if (url.pathname === "/api/v1/iam/assignees/users") {
      const lim = Math.min(parseInt(q.get("limit") ?? "100", 10) || 100, 100, this.pageMax);
      const ids = Object.keys(this.admins).map(Number).filter((i) => (this.admins[i] ?? []).length > 0).sort((a, b) => a - b);
      const start = q.has("after") ? ids.findIndex((i) => i >= after) : 0;
      const page = start < 0 ? [] : ids.slice(start, start + lim);
      count = page.length;
      const body: Record<string, unknown> = {
        value: page.map((i) => ({ id: this.user(i).id, orn: `orn:okta:directory:mock:users:${this.user(i).id}`, _links: { self: { href: `${origin}/api/v1/users/${this.user(i).id}` } } })),
        _links: {},
      };
      if (start >= 0 && start + lim < ids.length) {
        (body._links as Record<string, unknown>).next = { href: `${origin}/api/v1/iam/assignees/users?limit=${lim}&after=${ids[start + lim]}` };
      }
      return reply(json(body, 200, this.rate(500)));
    }
    if (url.pathname === "/api/v1/groups") {
      const page = this.groups.slice(after, after + limit);
      count = page.length;
      const next = after + limit < this.groups.length ? after + limit : null;
      return reply(json(
        page.map((g) => ({ id: g.id, type: "OKTA_GROUP", profile: { name: g.name, description: null }, lastUpdated: OKTA_BASE_UPDATED })),
        200,
        { ...this.rate(500), Link: this.link(origin, url.pathname, q, next) },
      ));
    }
    const gm = url.pathname.match(/^\/api\/v1\/groups\/([^/]+)\/users$/);
    if (gm) {
      const g = this.groups.find((x) => x.id === gm[1]);
      if (!g) return reply(json({ errorCode: "E0000007", errorSummary: `Not found: Resource not found: ${gm[1]} (UserGroup)` }, 404));
      const page = g.members.slice(after, after + limit).map((i) => this.user(i));
      count = page.length;
      const next = after + limit < g.members.length ? after + limit : null;
      return reply(json(page, 200, { ...this.rate(500), Link: this.link(origin, url.pathname, q, next) }));
    }
    return reply(json({ errorCode: "E0000007", errorSummary: "Not found: Resource not found" }, 404));
  };
}

if (import.meta.main) {
  const mock = new MockOktaDirectory({ users: parseInt(Deno.env.get("MOCK_USERS") ?? "450", 10), origin: Deno.env.get("MOCK_ORIGIN") });
  const port = parseInt(Deno.env.get("PORT") ?? "8093", 10);
  Deno.serve({ port, hostname: "127.0.0.1" }, mock.handle);
}
