// Mock Okta System Log + Users API (NAN-3483). SYNTHETIC DATA ONLY.
//
// Models the parts of Okta that a puller can get wrong:
//
//   GET /api/v1/logs   since / until / after / limit / sortOrder=ASCENDING.
//                      Polling requests (no `until`) ALWAYS carry a
//                      `Link: <…after=…>; rel="next"`, even on an empty page,
//                      exactly as Okta documents. Bounded requests (`until`)
//                      omit it on the last page.
//   GET /api/v1/users  limit / after, Link rel="next" paging (directory sync).
//
// Fault modes, switchable at runtime through POST /__mock/mode:
//   {"mode":"ok"}                     normal
//   {"mode":"429","count":N}          next N requests answer 429 with
//                                     X-Rate-Limit-Reset = now + reset_secs
//   {"mode":"401"}                    every request answers Okta's E0000011
//   {"append":N}                      publish N more log events now
// GET /__mock/stats returns the request log so a test can assert on paging,
// on the back-off timing and on what was served.
//
// Every request must carry `Authorization: SSWS <token>` matching MOCK_TOKEN
// (default "mock-token"); a wrong token answers 401 just like Okta.
//
// Standalone:  deno run --allow-net --allow-env testing/okta-mock/mock.ts
//   env: PORT (8089), MOCK_TOKEN, MOCK_EVENTS (initial log count, 2500),
//        MOCK_USERS (450), MOCK_PAGE_MAX (1000), MOCK_RESET_SECS (2)

export interface MockOptions {
  token?: string;
  events?: number;
  users?: number;
  pageMax?: number;
  resetSecs?: number;
  /** Clock for `published` timestamps and rate-limit resets (tests pin it). */
  now?: () => number;
  /** Origin used when building Link headers (defaults to the request's). */
  origin?: string;
}

interface Served {
  path: string;
  query: Record<string, string>;
  status: number;
  count: number;
  at: number;
}

const EVENT_TYPES: Array<[string, string, string]> = [
  ["user.session.start", "User login to Okta", "SUCCESS"],
  ["user.session.start", "User login to Okta", "FAILURE"],
  ["user.authentication.sso", "User single sign on to app", "SUCCESS"],
  ["user.authentication.auth_via_mfa", "Authentication of user via MFA", "SUCCESS"],
  ["user.lifecycle.create", "Create Okta user", "SUCCESS"],
  ["user.account.reset_password", "Fire a password reset event", "SUCCESS"],
  ["group.user_membership.add", "Add user to group membership", "SUCCESS"],
  ["policy.evaluate_sign_on", "Evaluation of sign-on policy", "ALLOW"],
  ["user.session.end", "User logout from Okta", "SUCCESS"],
];

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, "0");
}

/** Deterministic uuid per sequence number, so a test can count by uid. */
export function eventUuid(seq: number): string {
  return `0c7a0000-${hex((seq >> 16) & 0xffff, 4)}-4000-8000-${hex(seq, 12)}`;
}

export function makeEvent(seq: number, publishedMs: number): Record<string, unknown> {
  const [eventType, displayMessage, result] = EVENT_TYPES[seq % EVENT_TYPES.length];
  const user = `user${seq % 37}@example.com`;
  const isAdminAction = eventType.startsWith("user.lifecycle") || eventType.startsWith("user.account") ||
    eventType.startsWith("group.");
  const actor = isAdminAction
    ? { id: "00umockadmin0001", type: "User", alternateId: "admin@example.com", displayName: "Mock Admin", detailEntry: null }
    : { id: `00umock${hex(seq % 37, 9)}`, type: "User", alternateId: user, displayName: `Mock User ${seq % 37}`, detailEntry: null };
  const target: unknown[] = [];
  if (isAdminAction) {
    target.push({ id: `00umock${hex(seq % 37, 9)}`, type: "User", alternateId: user, displayName: `Mock User ${seq % 37}`, detailEntry: null });
  }
  if (eventType.startsWith("group.")) {
    target.push({ id: "00gmockgroup0001", type: "UserGroup", alternateId: "unknown", displayName: "Mock Admins", detailEntry: null });
  }
  if (eventType === "user.authentication.sso") {
    target.push({ id: "0oamockapp00001", type: "AppInstance", alternateId: "Mock App", displayName: "Mock App", detailEntry: null });
  }
  const ip = `203.0.113.${seq % 250 + 1}`;
  return {
    uuid: eventUuid(seq),
    published: new Date(publishedMs).toISOString(),
    eventType,
    version: "0",
    severity: result === "FAILURE" ? "WARN" : "INFO",
    legacyEventType: null,
    displayMessage,
    actor,
    client: {
      userAgent: { rawUserAgent: "Mozilla/5.0 (mock) Firefox/131.0", os: "Linux", browser: "FIREFOX" },
      zone: "null",
      device: "Computer",
      id: null,
      ipAddress: ip,
      geographicalContext: { city: "Ottawa", state: "Ontario", country: "Canada", postalCode: "K1A", geolocation: { lat: 45.4, lon: -75.7 } },
    },
    device: null,
    authenticationContext: {
      authenticationProvider: null,
      credentialProvider: null,
      credentialType: eventType.includes("mfa") ? "OTP" : null,
      issuer: null,
      interface: null,
      authenticationStep: 0,
      rootSessionId: `102mockroot${seq}`,
      externalSessionId: `102mocksess${seq % 50}`,
    },
    outcome: { result, reason: result === "FAILURE" ? "INVALID_CREDENTIALS" : null },
    securityContext: { asNumber: 64500, asOrg: "mock transit", isp: "mock isp", domain: "example.net", isProxy: false },
    debugContext: { debugData: { requestId: `mockreq${seq}`, requestUri: "/api/v1/authn", url: "/api/v1/authn?" } },
    transaction: { type: "WEB", id: `mocktx${seq}`, detail: {} },
    request: { ipChain: [{ ip, geographicalContext: null, version: "V4", source: null }] },
    target,
  };
}

export function makeUser(i: number): Record<string, unknown> {
  return {
    id: `00umockdir${hex(i, 6)}`,
    status: i % 23 === 0 ? "DEPROVISIONED" : "ACTIVE",
    created: "2026-01-01T00:00:00.000Z",
    lastUpdated: "2026-10-01T00:00:00.000Z",
    lastLogin: "2026-10-09T12:00:00.000Z",
    profile: {
      login: `dir${i}@example.com`,
      email: `dir${i}@example.com`,
      firstName: "Dir",
      lastName: `User${i}`,
      displayName: `Dir User ${i}`,
      department: i % 2 ? "Engineering" : "Finance",
      title: "Synthetic",
    },
  };
}

export class MockOkta {
  readonly token: string;
  readonly pageMax: number;
  resetSecs: number;
  private now: () => number;
  private origin?: string;
  private events: Array<{ seq: number; publishedMs: number; ev: Record<string, unknown> }> = [];
  private users: Record<string, unknown>[] = [];
  private mode: "ok" | "429" | "401" = "ok";
  private remaining429 = 0;
  readonly served: Served[] = [];

  constructor(opts: MockOptions = {}) {
    this.token = opts.token ?? "mock-token";
    this.pageMax = opts.pageMax ?? 1000;
    this.resetSecs = opts.resetSecs ?? 2;
    this.now = opts.now ?? Date.now;
    this.origin = opts.origin;
    this.append(opts.events ?? 0);
    for (let i = 0; i < (opts.users ?? 0); i++) this.users.push(makeUser(i));
  }

  /** Publish `n` more events. Timestamps are strictly increasing, 1 ms apart,
   *  starting no earlier than the mock clock, so `since=<now>` sees them. */
  append(n: number): void {
    // The initial batch is history (just before "now"); later batches are
    // published at the current clock, after everything already present.
    let t = this.events.length
      ? Math.max(this.events[this.events.length - 1].publishedMs + 1, this.now())
      : this.now() - n;
    for (let i = 0; i < n; i++, t++) {
      const seq = this.events.length;
      this.events.push({ seq, publishedMs: t, ev: makeEvent(seq, t) });
    }
  }

  /** Several events on ONE timestamp: the boundary case for since-based resumes. */
  appendSameInstant(n: number): void {
    const t = (this.events.length ? this.events[this.events.length - 1].publishedMs : this.now()) + 1;
    for (let i = 0; i < n; i++) {
      const seq = this.events.length;
      this.events.push({ seq, publishedMs: t, ev: makeEvent(seq, t) });
    }
  }

  get eventCount(): number {
    return this.events.length;
  }

  setMode(mode: "ok" | "429" | "401", count = 1): void {
    this.mode = mode;
    this.remaining429 = mode === "429" ? count : 0;
  }

  private json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  }

  private rateHeaders(remaining: number): Record<string, string> {
    return {
      "X-Rate-Limit-Limit": "120",
      "X-Rate-Limit-Remaining": String(Math.max(0, remaining)),
      "X-Rate-Limit-Reset": String(Math.ceil(this.now() / 1000) + this.resetSecs),
    };
  }

  handle = (req: Request): Response => {
    const url = new URL(req.url);
    const query = Object.fromEntries(url.searchParams.entries());
    const record = (status: number, count = 0) =>
      this.served.push({ path: url.pathname, query, status, count, at: this.now() });

    if (url.pathname === "/__mock/stats") {
      return this.json({ served: this.served, events: this.events.length, mode: this.mode }, 200);
    }
    if (url.pathname === "/__mock/mode" && req.method === "POST") {
      // Body is parsed by serve() below; in-process callers use setMode/append.
      return this.json({ error: "use serve() for the control endpoint" }, 400);
    }

    const auth = req.headers.get("authorization") ?? "";
    if (this.mode === "401" || auth !== `SSWS ${this.token}`) {
      record(401);
      return this.json({
        errorCode: "E0000011",
        errorSummary: "Invalid token provided",
        errorLink: "E0000011",
        errorId: "oaemock401",
        errorCauses: [],
      }, 401, { "WWW-Authenticate": 'SSWS realm="mock"' });
    }
    if (this.mode === "429" && this.remaining429 > 0) {
      this.remaining429--;
      if (this.remaining429 === 0) this.mode = "ok";
      record(429);
      return this.json({
        errorCode: "E0000047",
        errorSummary: "API call exceeded rate limit due to too many requests.",
        errorLink: "E0000047",
        errorId: "oaemock429",
        errorCauses: [],
      }, 429, this.rateHeaders(0));
    }

    const origin = this.origin ?? url.origin;
    const limit = Math.min(Math.max(parseInt(query.limit ?? "100", 10) || 100, 1), this.pageMax);

    if (url.pathname === "/api/v1/logs") {
      if (query.sortOrder && query.sortOrder !== "ASCENDING") {
        record(400);
        return this.json({ errorCode: "E0000001", errorSummary: "mock serves ASCENDING only" }, 400);
      }
      const sinceMs = query.since ? Date.parse(query.since) : this.now() - 7 * 24 * 3600 * 1000;
      const untilMs = query.until ? Date.parse(query.until) : Infinity;
      if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) {
        record(400);
        return this.json({ errorCode: "E0000001", errorSummary: "Api validation failed: since" }, 400);
      }
      // `after` is opaque to the client; here it is the next sequence number.
      let start: number;
      if (query.after !== undefined) {
        start = parseInt(query.after, 10);
        if (!Number.isFinite(start) || start < 0) {
          record(400);
          return this.json({ errorCode: "E0000001", errorSummary: "Api validation failed: after" }, 400);
        }
      } else {
        start = this.events.findIndex((e) => e.publishedMs >= sinceMs);
        if (start < 0) start = this.events.length;
      }
      const page = [];
      let i = start;
      for (; i < this.events.length && page.length < limit; i++) {
        const e = this.events[i];
        if (e.publishedMs >= untilMs) break;
        page.push(e.ev);
      }
      const bounded = query.until !== undefined;
      const exhausted = i >= this.events.length || (bounded && this.events[i]?.publishedMs >= untilMs);
      const headers: Record<string, string> = this.rateHeaders(100);
      const self = new URL(url.pathname + url.search, origin).toString();
      const links = [`<${self}>; rel="self"`];
      if (!(bounded && exhausted)) {
        const next = new URL("/api/v1/logs", origin);
        for (const [k, v] of Object.entries(query)) if (k !== "after") next.searchParams.set(k, v);
        next.searchParams.set("after", String(i));
        links.push(`<${next.toString()}>; rel="next"`);
      }
      headers["Link"] = links.join(", ");
      record(200, page.length);
      return this.json(page, 200, headers);
    }

    if (url.pathname === "/api/v1/users") {
      const start = query.after ? parseInt(query.after, 10) : 0;
      const page = this.users.slice(start, start + limit);
      const headers: Record<string, string> = this.rateHeaders(100);
      const links = [`<${new URL(url.pathname + url.search, origin)}>; rel="self"`];
      if (start + limit < this.users.length) {
        const next = new URL("/api/v1/users", origin);
        for (const [k, v] of Object.entries(query)) if (k !== "after") next.searchParams.set(k, v);
        next.searchParams.set("after", String(start + limit));
        links.push(`<${next}>; rel="next"`);
      }
      headers["Link"] = links.join(", ");
      record(200, page.length);
      return this.json(page, 200, headers);
    }

    record(404);
    return this.json({ errorCode: "E0000007", errorSummary: "Not found: Resource not found" }, 404);
  };

  /** Bind to a port; adds the JSON control endpoint. */
  serve(port: number, hostname = "127.0.0.1"): Deno.HttpServer {
    return Deno.serve({ port, hostname, onListen: () => {} }, async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/__mock/mode" && req.method === "POST") {
        const body = await req.json().catch(() => ({}));
        if (typeof body.append === "number") this.append(body.append);
        if (typeof body.appendSameInstant === "number") this.appendSameInstant(body.appendSameInstant);
        if (body.mode === "ok" || body.mode === "429" || body.mode === "401") this.setMode(body.mode, body.count ?? 1);
        if (typeof body.reset_secs === "number") this.resetSecs = body.reset_secs;
        return this.json({ mode: this.mode, events: this.events.length }, 200);
      }
      return this.handle(req);
    });
  }
}

if (import.meta.main) {
  const env = (k: string, d: string) => Deno.env.get(k) ?? d;
  const mock = new MockOkta({
    token: env("MOCK_TOKEN", "mock-token"),
    events: parseInt(env("MOCK_EVENTS", "2500"), 10),
    users: parseInt(env("MOCK_USERS", "450"), 10),
    pageMax: parseInt(env("MOCK_PAGE_MAX", "1000"), 10),
    resetSecs: parseInt(env("MOCK_RESET_SECS", "2"), 10),
    origin: Deno.env.get("MOCK_ORIGIN"),
  });
  const port = parseInt(env("PORT", "8089"), 10);
  mock.serve(port, env("HOST", "127.0.0.1"));
  console.log(`mock okta listening on ${env("HOST", "127.0.0.1")}:${port} (${mock.eventCount} log events)`);
}
