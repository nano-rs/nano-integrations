// Public Okta System Log mock for live connector-runner validation (NAN-3490).
// SYNTHETIC DATA ONLY.
//
// The hosted runner reaches only public TLS names (its NetworkPolicy and the
// broker refuse private addresses), so the in-process MockOkta in
// ../okta-mock cannot be its target. This is a stateless port that runs as a
// Cloudflare Worker: every answer is a pure function of the request, the
// config below and the clock, so any isolate serves the same stream and a
// validator can compute exactly what a feed should have shipped.
//
// The stream: event `seq` (0, 1, 2, ...) is published at
//   EPOCH_MS + seq * interval,  interval = 60000 / EVENTS_PER_MIN  (ms)
// with the same body as MockOkta's `makeEvent(seq, published)`, so its uuid
// is `eventUuid(seq)`. Optional quirks the puller has to survive:
//
//   LATE_EVERY=N, LATE_MS=M   every Nth event becomes visible M ms after its
//                             `published` (Okta's eventual consistency). With
//                             M > the spec's lag_secs and M < lag + lookback,
//                             only the lookback re-read catches it.
//   FAULT_429_EVERY_SECS=E,   for the first D seconds of every E-second slot,
//   FAULT_429_SECS=D          /api/v1/logs answers 429 with an
//                             X-Rate-Limit-Reset at the end of the burst
//                             (D <= E - 2: the reset plus a puller's slack
//                             must land outside the next burst).
//
// Endpoints (all but /__mock/health need `Authorization: SSWS <MOCK_TOKEN>`):
//   GET /api/v1/logs        since / until / after / limit, ASCENDING only.
//                           Link rel="next" always on polling requests (no
//                           `until`), and on bounded ones until exhausted.
//   GET /__mock/expected    since, until -> how many events, and the first and
//                           last uuid, the stream holds in [since, until).
//                           `final` is true once every one of them is visible.
//   GET /__mock/health      liveness, no auth.
//
// MOCK_TOKEN is a Worker secret and must be at least 16 characters; without
// one every request answers 503, so a deploy cannot fall back to a known
// token.

import { eventUuid, makeEvent } from "../okta-mock/mock.ts";

export interface MockEnv {
  MOCK_TOKEN?: string;
  /** ISO time or epoch ms of event 0. Default 2026-10-01T00:00:00Z. */
  EPOCH?: string;
  EVENTS_PER_MIN?: string;
  PAGE_MAX?: string;
  LATE_EVERY?: string;
  LATE_MS?: string;
  FAULT_429_EVERY_SECS?: string;
  FAULT_429_SECS?: string;
  /** Origin for Link headers when the request URL is not the public one
   *  (the loopback shadow harness). Default: the request's own origin. */
  MOCK_ORIGIN?: string;
}

export interface MockConfig {
  token: string;
  epochMs: number;
  intervalMs: number;
  pageMax: number;
  lateEvery: number;
  lateMs: number;
  faultEverySecs: number;
  faultSecs: number;
  origin?: string;
}

const DEFAULT_EPOCH = "2026-10-01T00:00:00Z";
/** A bounded scan never walks more sequence numbers than this per request. */
const MAX_SCAN = 200_000;

function int(
  v: string | undefined,
  d: number,
  min: number,
  max: number,
): number {
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`mock config: ${v} is not an integer in [${min}, ${max}]`);
  }
  return n;
}

export function config(env: MockEnv): MockConfig {
  const epochRaw = env.EPOCH ?? DEFAULT_EPOCH;
  const epochMs = /^\d+$/.test(epochRaw)
    ? Number(epochRaw)
    : Date.parse(epochRaw);
  if (!Number.isFinite(epochMs)) {
    throw new Error(`mock config: EPOCH ${epochRaw} is not a time`);
  }
  const perMin = int(env.EVENTS_PER_MIN, 60, 1, 60_000);
  const faultEverySecs = int(env.FAULT_429_EVERY_SECS, 0, 0, 86_400);
  const faultSecs = int(env.FAULT_429_SECS, 0, 0, 3_600);
  // A puller waits until X-Rate-Limit-Reset plus slack (nano-connector adds
  // 1 s); a slot shorter than that lands every retry in the next burst.
  if (
    faultEverySecs > 0 && (faultSecs === 0 || faultSecs + 2 > faultEverySecs)
  ) {
    throw new Error(
      "mock config: FAULT_429_SECS must be in [1, FAULT_429_EVERY_SECS - 2]",
    );
  }
  return {
    token: env.MOCK_TOKEN ?? "",
    epochMs,
    intervalMs: 60_000 / perMin,
    pageMax: int(env.PAGE_MAX, 200, 1, 1000),
    lateEvery: int(env.LATE_EVERY, 0, 0, 1_000_000),
    lateMs: int(env.LATE_MS, 0, 0, 86_400_000),
    faultEverySecs,
    faultSecs,
    origin: env.MOCK_ORIGIN || undefined,
  };
}

/** The stream as a pure function of the config. */
export class Stream {
  constructor(readonly cfg: MockConfig) {}

  publishedMs(seq: number): number {
    return Math.round(this.cfg.epochMs + seq * this.cfg.intervalMs);
  }

  visibleMs(seq: number): number {
    const late = this.cfg.lateEvery > 0 &&
      seq % this.cfg.lateEvery === this.cfg.lateEvery - 1;
    return this.publishedMs(seq) + (late ? this.cfg.lateMs : 0);
  }

  /** First seq published at or after `ms`. */
  firstAtOrAfter(ms: number): number {
    if (ms <= this.cfg.epochMs) return 0;
    let s = Math.ceil((ms - this.cfg.epochMs) / this.cfg.intervalMs);
    // Rounding in publishedMs can put the boundary one step either way.
    while (s > 0 && this.publishedMs(s - 1) >= ms) s--;
    while (this.publishedMs(s) < ms) s++;
    return s;
  }

  /** One past the last seq published at or before `now`. */
  publishedBy(now: number): number {
    return now < this.cfg.epochMs ? 0 : this.firstAtOrAfter(now + 1);
  }

  /** Every event the stream holds in [sinceMs, untilMs), visible yet or not. */
  range(sinceMs: number, untilMs: number): [number, number] {
    const a = this.firstAtOrAfter(sinceMs);
    return [a, Math.max(a, this.firstAtOrAfter(untilMs))];
  }
}

function json(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function oktaError(
  status: number,
  code: string,
  summary: string,
  headers: Record<string, string> = {},
): Response {
  return json(
    {
      errorCode: code,
      errorSummary: summary,
      errorLink: code,
      errorId: `oaemock${status}`,
      errorCauses: [],
    },
    status,
    headers,
  );
}

function sameToken(given: string, want: string): boolean {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(want);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

function parseTime(v: string | null): number | undefined {
  if (v === null) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

/** Build the request handler. `now` is injectable for tests. */
export function handler(
  env: MockEnv,
  now: () => number = Date.now,
): (req: Request) => Response {
  let cfg: MockConfig | undefined;
  let cfgError = "";
  try {
    cfg = config(env);
    if (cfg.token.length < 16) {
      cfgError = "MOCK_TOKEN is not set (16+ characters)";
    }
  } catch (e) {
    cfgError = (e as Error).message;
  }

  return (req: Request): Response => {
    const url = new URL(req.url);
    if (url.pathname === "/__mock/health") {
      return json({ ok: cfgError === "" }, cfgError === "" ? 200 : 503);
    }
    if (!cfg || cfgError !== "") {
      return json({ error: "mock not configured" }, 503);
    }
    if (req.method !== "GET") {
      return oktaError(
        405,
        "E0000022",
        "The endpoint does not support the provided HTTP method",
      );
    }

    const auth = req.headers.get("authorization") ?? "";
    if (!auth.startsWith("SSWS ") || !sameToken(auth.slice(5), cfg.token)) {
      return oktaError(401, "E0000011", "Invalid token provided", {
        "WWW-Authenticate": 'SSWS realm="mock"',
      });
    }

    const t = now();
    const stream = new Stream(cfg);
    const nowSec = Math.floor(t / 1000);
    const rate = (remaining: number, reset = nowSec + 1) => ({
      "X-Rate-Limit-Limit": "120",
      "X-Rate-Limit-Remaining": String(remaining),
      "X-Rate-Limit-Reset": String(reset),
    });

    if (url.pathname === "/__mock/expected") {
      const since = parseTime(url.searchParams.get("since"));
      const until = parseTime(url.searchParams.get("until"));
      if (
        since === undefined || until === undefined || Number.isNaN(since) ||
        Number.isNaN(until) || until < since
      ) {
        return json({
          error: "since and until (ISO times, since <= until) are required",
        }, 400);
      }
      const [a, b] = stream.range(since, until);
      const end = Math.min(b, stream.publishedBy(t));
      const count = Math.max(0, end - a);
      return json({
        since: new Date(since).toISOString(),
        until: new Date(until).toISOString(),
        count,
        first_seq: count ? a : null,
        first_uuid: count ? eventUuid(a) : null,
        last_uuid: count ? eventUuid(end - 1) : null,
        // Final once the whole range is published and its last event is
        // visible even if it is a late one.
        final: end === b &&
          (b === a ||
            stream.publishedMs(b - 1) + (cfg.lateEvery > 0 ? cfg.lateMs : 0) <=
              t),
      }, 200);
    }

    if (url.pathname !== "/api/v1/logs") {
      return oktaError(404, "E0000007", "Not found: Resource not found");
    }

    if (cfg.faultEverySecs > 0) {
      const phase = nowSec % cfg.faultEverySecs;
      if (phase < cfg.faultSecs) {
        return oktaError(
          429,
          "E0000047",
          "API call exceeded rate limit due to too many requests.",
          rate(0, nowSec - phase + cfg.faultSecs),
        );
      }
    }

    const q = url.searchParams;
    if (q.get("sortOrder") !== null && q.get("sortOrder") !== "ASCENDING") {
      return oktaError(400, "E0000001", "mock serves ASCENDING only");
    }
    const since = parseTime(q.get("since")) ?? t - 7 * 24 * 3600 * 1000;
    const until = parseTime(q.get("until"));
    if (Number.isNaN(since) || Number.isNaN(until)) {
      return oktaError(400, "E0000001", "Api validation failed: since/until");
    }
    const limitRaw = Number(q.get("limit") ?? "100");
    const limit = Math.min(
      Math.max(Number.isInteger(limitRaw) ? limitRaw : 100, 1),
      cfg.pageMax,
    );

    const bounded = until !== undefined;
    const [first, rangeEnd] = stream.range(since, bounded ? until : t + 1);
    // Nothing published after the clock exists yet, bounded or not.
    const end = Math.min(rangeEnd, stream.publishedBy(t));
    let start = first;
    const after = q.get("after");
    if (after !== null) {
      start = Number(after);
      if (!Number.isInteger(start) || start < 0) {
        return oktaError(400, "E0000001", "Api validation failed: after");
      }
    }
    if (end - start > MAX_SCAN) {
      return oktaError(
        400,
        "E0000001",
        "mock: window too large, narrow since/until",
      );
    }

    const page: Record<string, unknown>[] = [];
    let i = start;
    for (; i < end && page.length < limit; i++) {
      if (stream.visibleMs(i) <= t) {
        page.push(makeEvent(i, stream.publishedMs(i)));
      }
    }

    const self = new URL(url.pathname + url.search, cfg.origin ?? url.origin);
    const links = [`<${self}>; rel="self"`];
    if (!bounded || i < end) {
      const next = new URL(self);
      next.searchParams.set("after", String(i));
      links.push(`<${next.toString()}>; rel="next"`);
    }
    return json(page, 200, { ...rate(100), Link: links.join(", ") });
  };
}

export default {
  fetch(req: Request, env: MockEnv): Response {
    return handler(env)(req);
  },
};
