// Okta — System Log events via GET /api/v1/logs
//
// Docs: https://developer.okta.com/docs/reference/api/system-log/
//       https://developer.okta.com/docs/reference/rl-best-practices/
//
// The file has two halves:
//
//   1. A runtime-agnostic core (`pullSystemLog` and its helpers). It takes every
//      side effect as an injected dependency: fetch, sleep, clock, emit,
//      checkpoint, stop signal and log. Nothing in it knows about the Deno
//      sandbox, the ctx object or nano's framing, so it ports unchanged to
//      whatever replaces the sandbox (NAN-3484) and is unit-tested directly.
//   2. `collect(ctx)`: a thin adapter from nano's collector context onto the
//      core. Collector code ships as this ONE file, so the core lives here
//      rather than in a sibling module the catalog sync would not pick up.
//
// Properties of this API that drive the implementation:
//
//   * Polling requests (`since` with no `until`) are ASCENDING and ALWAYS
//     return `Link: <…after=…>; rel="next"`, even on an empty page. That `after`
//     value IS the resume point: it is opaque, it encodes exactly which events
//     were already served, and following it can neither skip nor repeat. So the
//     cursor stores Okta's own `after`, never a timestamp we derived.
//   * Okta events arrive slightly out of order and late. Advancing a
//     `since` watermark to the newest `published` value would drop late
//     arrivals; following `after` does not.
//   * Rate limits are per org and per endpoint, and are shared with every other
//     client of the org. Every response carries X-Rate-Limit-Remaining /
//     X-Rate-Limit-Reset (epoch seconds). A 429 must wait until Reset, and a
//     well-behaved poller slows down before it gets there.
//
// Delivery is at-least-once: a page is emitted, then its `after` is
// checkpointed. A crash between the two re-serves that page on the next run.
//
// Auth: an Okta API token (SSWS). The manifest declares `auth_type: none`
// because the sandbox can only inject a header verbatim and Okta needs the
// `SSWS ` scheme prefix, so this file builds the header from the decrypted
// credential. The token is never logged.

// =============================================================================
// 1. Runtime-agnostic core
// =============================================================================

export interface PullDeps {
  fetch(url: string, init: { headers: Record<string, string> }): Promise<Response>;
  sleep(ms: number): Promise<void>;
  now(): number;
  shouldStop(): boolean;
  /** Durably hand a page of raw events to the platform. */
  emit(events: OktaLogEvent[]): Promise<void>;
  /** Persist the resume point. Only ever called after the matching emit. */
  checkpoint(cursor: string): Promise<void>;
  log(msg: string, fields?: Record<string, unknown>): void;
}

export interface PullOptions {
  /** `https://<org>.okta.com`, no trailing slash. */
  baseUrl: string;
  token: string;
  /** ISO-8601 instant the very first run starts from. */
  startFrom: string;
  /** Okta maximum for /api/v1/logs is 1000. */
  pageSize?: number;
  /** Safety valve against an API that never stops offering pages. */
  maxPages?: number;
  /** Longest single rate-limit wait honoured before giving up the run. */
  maxWaitMs?: number;
  /** Consecutive 429s tolerated before the run fails. */
  maxRateLimited?: number;
  /** Consecutive 5xx / network errors tolerated before the run fails. */
  maxServerErrors?: number;
  serverBackoffMs?: number;
  /** Pause until reset when X-Rate-Limit-Remaining drops to this or below. */
  remainingFloor?: number;
}

export interface OktaLogEvent {
  uuid?: string;
  published?: string;
  eventType?: string;
  [key: string]: unknown;
}

/**
 * Resume point. `after` is Okta's opaque pagination token from the last
 * rel="next" link and is authoritative whenever present. `since` is the
 * original window start, re-sent with `after` because Okta's next links carry
 * it too. `seen` is used only on the fallback path (a response with no next
 * link): the uuids already shipped AT `since`, so an inclusive restart from
 * that instant does not re-ship them.
 */
export interface Cursor {
  v: 1;
  since: string;
  after?: string;
  seen?: string[];
}

export interface PullResult {
  events: number;
  pages: number;
  /** True when Okta had nothing more to give (an empty or final page). */
  drained: boolean;
  cursor: string;
}

export class OktaApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "OktaApiError";
  }
}

const LOGS_PATH = "/api/v1/logs";

export function encodeCursor(c: Cursor): string {
  return JSON.stringify(c);
}

/**
 * Read a stored cursor. Anything unreadable falls back to `startFrom` so a
 * corrupt cursor cannot wedge the stream. `startFrom` is the initial cursor
 * (NAN-3697), so that restart can skip events; `pullSystemLog` logs it.
 */
export function parseCursor(raw: string | undefined, startFrom: string): Cursor {
  if (raw) {
    try {
      const c = JSON.parse(raw);
      if (c && c.v === 1 && typeof c.since === "string" && !Number.isNaN(Date.parse(c.since))) {
        const out: Cursor = { v: 1, since: c.since };
        if (typeof c.after === "string" && c.after !== "") out.after = c.after;
        if (Array.isArray(c.seen)) out.seen = c.seen.filter((s: unknown) => typeof s === "string");
        return out;
      }
    } catch {
      // fall through
    }
  }
  return { v: 1, since: startFrom };
}

/** Normalise an operator-entered org domain into an https origin. */
export function baseUrlFromDomain(domain: string): string {
  const trimmed = domain.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  if (!/^[a-z0-9.-]+(:\d+)?$/.test(trimmed) || !trimmed.includes(".")) {
    throw new Error(`OKTA_DOMAIN "${domain}" is not a hostname (expected e.g. acme.okta.com)`);
  }
  return `https://${trimmed}`;
}

export function pageUrl(baseUrl: string, cursor: Cursor, pageSize: number): string {
  const u = new URL(LOGS_PATH, baseUrl);
  u.searchParams.set("since", cursor.since);
  u.searchParams.set("sortOrder", "ASCENDING");
  u.searchParams.set("limit", String(pageSize));
  if (cursor.after) u.searchParams.set("after", cursor.after);
  return u.toString();
}

/**
 * The `after` token from a `rel="next"` link, or undefined. A next link that
 * points anywhere other than this org's /api/v1/logs is refused: following it
 * would hand the SSWS token to whatever host a response named.
 */
export function nextAfter(link: string | null, baseUrl: string): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/i);
    if (!m) continue;
    let u: URL;
    try {
      u = new URL(m[1]);
    } catch {
      return undefined;
    }
    if (u.origin !== new URL(baseUrl).origin || u.pathname !== LOGS_PATH) {
      throw new OktaApiError(0, undefined, `refusing rel="next" link to ${u.origin}${u.pathname}`);
    }
    const after = u.searchParams.get("after");
    return after && after !== "" ? after : undefined;
  }
  return undefined;
}

/**
 * How long to wait before the next request, from Okta's rate-limit headers.
 * Reset is epoch SECONDS; one extra second absorbs clock skew between us and
 * Okta, which would otherwise burn a request on an immediate second 429.
 */
export function rateLimitWaitMs(headers: Headers, nowMs: number): number {
  const reset = Number(headers.get("x-rate-limit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, reset * 1000 - nowMs) + 1000;
  }
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return 60_000;
}

/** Sleep in short slices so a stop request is honoured promptly. */
async function waitInterruptibly(deps: PullDeps, ms: number): Promise<boolean> {
  const deadline = deps.now() + ms;
  while (deps.now() < deadline) {
    if (deps.shouldStop()) return false;
    await deps.sleep(Math.min(1000, deadline - deps.now()));
  }
  return !deps.shouldStop();
}

async function errorFrom(res: Response): Promise<OktaApiError> {
  let code: string | undefined;
  let summary = "";
  try {
    const body = await res.json();
    code = typeof body?.errorCode === "string" ? body.errorCode : undefined;
    summary = typeof body?.errorSummary === "string" ? body.errorSummary : "";
  } catch {
    // non-JSON error body
  }
  const tail = [code, summary].filter(Boolean).join(" ");
  if (res.status === 401) {
    return new OktaApiError(401, code,
      `Okta rejected the API token (HTTP 401${tail ? `: ${tail}` : ""}). ` +
        "The token is invalid, revoked or expired (tokens expire after 30 days unused); create a new one.");
  }
  if (res.status === 403) {
    return new OktaApiError(403, code,
      `Okta refused System Log access (HTTP 403${tail ? `: ${tail}` : ""}). ` +
        "The token's admin needs a role that can read the System Log (Read-only Administrator or higher).");
  }
  return new OktaApiError(res.status, code, `Okta System Log request failed (HTTP ${res.status}${tail ? `: ${tail}` : ""})`);
}

/**
 * GET one page, absorbing 429s and transient 5xx/network failures. Returns
 * null when a stop was requested mid-wait (the caller ends the run cleanly,
 * cursor untouched). Throws on anything that will not fix itself by waiting.
 */
async function getPage(url: string, opts: Required<PullOptions>, deps: PullDeps): Promise<Response | null> {
  let rateLimited = 0;
  let serverErrors = 0;
  for (;;) {
    let res: Response;
    try {
      res = await deps.fetch(url, {
        headers: { Authorization: `SSWS ${opts.token}`, Accept: "application/json" },
      });
    } catch (e) {
      if (++serverErrors > opts.maxServerErrors) {
        throw new OktaApiError(0, undefined, `Okta unreachable after ${serverErrors} attempts: ${(e as Error).message}`);
      }
      if (!(await waitInterruptibly(deps, opts.serverBackoffMs * serverErrors))) return null;
      continue;
    }
    if (res.ok) return res;
    if (res.status === 429) {
      await res.body?.cancel();
      rateLimited++;
      const wait = rateLimitWaitMs(res.headers, deps.now());
      if (rateLimited > opts.maxRateLimited || wait > opts.maxWaitMs) {
        throw new OktaApiError(429, "E0000047",
          `Okta rate limit still exceeded after ${rateLimited} attempt(s) (next reset in ${Math.round(wait / 1000)}s); ` +
            "the org's System Log quota is being consumed by another client or the poll schedule is too tight.");
      }
      deps.log("okta rate limited; waiting for reset", { wait_ms: wait, attempt: rateLimited });
      if (!(await waitInterruptibly(deps, wait))) return null;
      continue;
    }
    if (res.status >= 500) {
      await res.body?.cancel();
      if (++serverErrors > opts.maxServerErrors) throw await errorFrom(res);
      if (!(await waitInterruptibly(deps, opts.serverBackoffMs * serverErrors))) return null;
      continue;
    }
    throw await errorFrom(res);
  }
}

/** Drain the System Log from `cursorRaw` until caught up, stopped or out of budget. */
export async function pullSystemLog(
  options: PullOptions,
  cursorRaw: string | undefined,
  deps: PullDeps,
): Promise<PullResult> {
  const opts: Required<PullOptions> = {
    pageSize: 1000,
    maxPages: 500,
    maxWaitMs: 120_000,
    maxRateLimited: 5,
    maxServerErrors: 3,
    serverBackoffMs: 5_000,
    remainingFloor: 2,
    ...options,
  };
  let cursor = parseCursor(cursorRaw, opts.startFrom);
  if (cursorRaw && cursor.since === opts.startFrom && !cursor.after) {
    // Restarting from startFrom (the initial cursor) can skip events, so make it loud.
    deps.log("okta cursor unreadable; restarting from the configured start", { start: opts.startFrom });
  }
  let events = 0;
  let pages = 0;
  let drained = false;

  while (!deps.shouldStop() && pages < opts.maxPages) {
    const res = await getPage(pageUrl(opts.baseUrl, cursor, opts.pageSize), opts, deps);
    if (!res) break;
    pages++;

    const body = await res.json();
    if (!Array.isArray(body)) {
      throw new OktaApiError(res.status, undefined, "Okta System Log response was not a JSON array");
    }
    let page = body as OktaLogEvent[];
    const after = nextAfter(res.headers.get("link"), opts.baseUrl);

    // Fallback path only: an inclusive since-restart re-serves the boundary.
    if (!cursor.after && cursor.seen?.length) {
      const seen = new Set(cursor.seen);
      page = page.filter((e) => !(e.published === cursor.since && e.uuid && seen.has(e.uuid)));
    }

    let next: Cursor;
    if (after) {
      next = { v: 1, since: cursor.since, after };
    } else if (body.length > 0) {
      // No next link (Okta only does this on bounded queries; defensive).
      // Resume inclusively at the newest instant, remembering who sat on it.
      const last = String(body[body.length - 1].published ?? cursor.since);
      const prior = last === cursor.since ? cursor.seen ?? [] : [];
      const atLast = body.filter((e) => e.published === last && e.uuid).map((e) => String(e.uuid));
      next = { v: 1, since: last, seen: [...new Set([...prior, ...atLast])] };
    } else {
      next = cursor;
    }

    if (page.length > 0) {
      await deps.emit(page);
      events += page.length;
    }
    const encoded = encodeCursor(next);
    if (encoded !== encodeCursor(cursor)) {
      await deps.checkpoint(encoded);
      cursor = next;
    }

    // A polling query always offers a next link, so an empty page is the
    // "caught up" signal; a missing link means a bounded query finished.
    if (body.length === 0 || !after) {
      drained = true;
      break;
    }

    const remaining = Number(res.headers.get("x-rate-limit-remaining"));
    if (Number.isFinite(remaining) && remaining <= opts.remainingFloor) {
      const wait = Math.min(rateLimitWaitMs(res.headers, deps.now()), opts.maxWaitMs);
      deps.log("okta rate-limit headroom low; pausing until reset", { remaining, wait_ms: wait });
      if (!(await waitInterruptibly(deps, wait))) break;
    }
  }

  return { events, pages, drained, cursor: encodeCursor(cursor) };
}

// =============================================================================
// 2. nano collector adapter
// =============================================================================

interface CollectorContext {
  cursors: Record<string, string | undefined>;
  credentials: Record<string, string>;
  config: Record<string, string>;
  streams: string[];
  /** First-run start, ISO-8601: activation time − 5 min, computed by the host (NAN-3697). */
  initialCursor?: string;
  /** Deprecated alias of `initialCursor`, carrying the same value. */
  backfillFrom?: string;
  emit(streamId: string, events: unknown[]): Promise<void>;
  checkpoint(streamId: string, cursor: string): Promise<void>;
  shouldStop(): boolean;
  log(msg: string, fields?: Record<string, unknown>): void;
}

const STREAM = "system_log";

/**
 * NAN-3697: every collector starts point-forward. A stream with no cursor
 * starts at the host's `initialCursor` (activation − 5 min); there is no
 * backfill option. The same rule lives in the nano-connector engine
 * (`.initial_cursor`), and this helper is duplicated verbatim in each
 * single-file collector.
 */
export const INITIAL_OVERLAP_MS = 300_000;

/**
 * Epoch ms a stream with no cursor starts at.
 *
 * `initialCursor` wins. `backfillFrom` is read only as the deprecated alias an
 * older host sends — and clamped, because on such a host it may still be an
 * operator backfill. With neither, now − INITIAL_OVERLAP_MS. Never earlier
 * than that, never all-history.
 */
export function initialCursorMs(
  ctx: { initialCursor?: string; backfillFrom?: string; log(msg: string, fields?: Record<string, unknown>): void },
  now: number = Date.now(),
): number {
  const floor = now - INITIAL_OVERLAP_MS;
  if (ctx.initialCursor) {
    const parsed = Date.parse(ctx.initialCursor);
    if (!Number.isNaN(parsed)) return parsed;
    ctx.log("Ignoring unparseable initialCursor", { value: ctx.initialCursor });
  }
  if (ctx.backfillFrom) {
    const parsed = Date.parse(ctx.backfillFrom);
    if (!Number.isNaN(parsed)) return Math.max(parsed, floor);
    ctx.log("Ignoring unparseable backfillFrom", { value: ctx.backfillFrom });
  }
  return floor;
}

async function collect(ctx: CollectorContext): Promise<void> {
  if (!ctx.streams.includes(STREAM)) return;
  const token = (ctx.credentials.API_TOKEN ?? "").trim();
  if (!token) throw new Error("API_TOKEN is not set");
  const baseUrl = baseUrlFromDomain(ctx.config.OKTA_DOMAIN ?? "");
  // Point-forward (NAN-3697): no cursor starts at the host's initial cursor.
  // An existing cursor is resumed by pullSystemLog and never reset.
  const startFrom = new Date(initialCursorMs(ctx)).toISOString();

  const result = await pullSystemLog(
    { baseUrl, token, startFrom },
    ctx.cursors[STREAM],
    {
      fetch: (url, init) => fetch(url, init),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => Date.now(),
      shouldStop: () => ctx.shouldStop(),
      emit: (events) => ctx.emit(STREAM, events),
      checkpoint: (cursor) => ctx.checkpoint(STREAM, cursor),
      log: (msg, fields) => ctx.log(msg, fields),
    },
  );
  ctx.log("okta system log pull finished", {
    events: result.events,
    pages: result.pages,
    drained: result.drained,
  });
}

export { collect };
