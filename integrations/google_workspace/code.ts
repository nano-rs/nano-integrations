// Google Workspace — audit activities via the Admin SDK Reports API
//
// Docs: https://developers.google.com/workspace/admin/reports/v1/reference/activities/list
//
// Auth is service-account JWT with domain-wide delegation, handled entirely by
// nano: the assertion is built, signed and exchanged for a bearer before this
// code runs, so there is no key handling here.
//
// Two properties of this API drive the implementation:
//
//   * Ordering is NOT guaranteed. The reference documents no ordering, and in
//     practice results come back newest-first. So this never stops early on
//     reaching the watermark the way an ascending feed would — it drains every
//     page in the window and takes the maximum event time it saw.
//
//   * Events arrive late. Workspace audit events surface minutes to hours after
//     they happen, varying by application. The watermark is therefore the newest
//     EVENT time observed, never "now" — advancing to wall-clock would skip
//     every event still in flight, permanently and silently.

interface CollectorContext {
  cursors: Record<string, string | undefined>;
  credentials: Record<string, string>;
  config: Record<string, string>;
  streams: string[];
  backfillFrom?: string;
  emit(streamId: string, events: unknown[]): Promise<void>;
  checkpoint(streamId: string, cursor: string): Promise<void>;
  shouldStop(): boolean;
  log(msg: string, fields?: Record<string, unknown>): void;
}

interface Activity {
  id?: {
    time?: string;
    uniqueQualifier?: string;
    applicationName?: string;
    customerId?: string;
  };
  actor?: Record<string, unknown>;
  ipAddress?: string;
  events?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface ActivitiesResponse {
  items?: Activity[];
  nextPageToken?: string;
  error?: { code?: number; message?: string; status?: string };
}

const BASE = "https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications";

/** Google's documented default and maximum for this endpoint. */
const PAGE_SIZE = 1000;

/** Courtesy spacing between page fetches. Reports API quota is generous. */
const PAGE_INTERVAL_MS = 250;

const MAX_WAIT_MS = 60_000;
const SERVER_ERROR_BACKOFF_MS = 5_000;
const MAX_SERVER_ERROR_RETRIES = 3;

/** Refuse to walk forever if a stream somehow never stops offering pages. */
const MAX_PAGES_PER_STREAM = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Where a stream resumes: an instant, plus the records already shipped AT that
 * instant.
 *
 * `startTime` is inclusive, so resuming at the last event's exact time
 * re-delivers that event. Nudging forward a millisecond would avoid it but drop
 * any other event sharing the timestamp, so the boundary stays inclusive and
 * the duplicate is filtered by identity instead.
 *
 * `seen` only ever holds identities at exactly `t` — anything strictly older is
 * already excluded by `startTime`, so it does not grow with the stream.
 */
interface Cursor {
  t: string;
  seen: string[];
}

/**
 * Cap on `seen`, so a burst sharing one millisecond cannot grow the cursor
 * without bound. Past this the oldest identities are dropped and those records
 * may be re-delivered once — at-least-once, which the pipeline already assumes.
 */
const MAX_SEEN = 500;

/**
 * Identity of an activity within a stream.
 *
 * Google documents (time, uniqueQualifier, applicationName, customerId) as the
 * composite key. Stream and instant are already fixed by the caller, so
 * `uniqueQualifier` is what distinguishes two records here. Without one there
 * is nothing stable to match on, so it is left undeduplicated rather than
 * guessed at — dropping a record is worse than shipping it twice.
 */
function activityKey(activity: Activity): string | null {
  const q = activity.id?.uniqueQualifier;
  return q === undefined || q === null || q === "" ? null : String(q);
}

/**
 * Parse a stored cursor.
 *
 * Accepts the plain RFC 3339 string this collector used to write, so a stream
 * mid-flight on the old format resumes without re-emitting or skipping: it just
 * carries an empty `seen` and fills it after the first run.
 */
function parseCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { t?: unknown; seen?: unknown };
      if (typeof parsed.t === "string" && !Number.isNaN(Date.parse(parsed.t))) {
        const seen = Array.isArray(parsed.seen)
          ? parsed.seen.filter((s): s is string => typeof s === "string")
          : [];
        return { t: parsed.t, seen };
      }
    } catch {
      // Fall through — a corrupt cursor is handled below rather than throwing
      // the whole run away.
    }
    return null;
  }

  return Number.isNaN(Date.parse(raw)) ? null : { t: raw, seen: [] };
}

function resumeFrom(ctx: CollectorContext, stream: string): Cursor {
  const stored = ctx.cursors[stream];
  const parsed = parseCursor(stored);
  if (parsed) return parsed;
  if (stored) {
    ctx.log("Ignoring unparseable cursor", { stream, value: stored });
  }

  if (ctx.backfillFrom) {
    const from = Date.parse(ctx.backfillFrom);
    if (!Number.isNaN(from)) return { t: new Date(from).toISOString(), seen: [] };
    ctx.log("Ignoring unparseable backfillFrom", { value: ctx.backfillFrom });
  }

  // Default to 24h back rather than the retention limit: enough to prove the
  // integration works on first run without pulling six months of Drive
  // activity into a tenant that only wanted to try it.
  return { t: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), seen: [] };
}

/**
 * `id.time` is RFC 3339 in every response observed, but the reference has
 * described it as epoch seconds — so accept both rather than silently produce
 * an invalid watermark that resets the stream to 1970 on the next run.
 */
function activityTime(activity: Activity): number | null {
  const raw = activity.id?.time;
  if (!raw) return null;

  const asDate = Date.parse(raw);
  if (!Number.isNaN(asDate)) return asDate;

  const asEpoch = Number.parseInt(raw, 10);
  if (Number.isFinite(asEpoch) && asEpoch > 0) return asEpoch * 1000;

  return null;
}

/** Translate Google's error shapes into something an operator can act on. */
function googleErrorMessage(status: number, body: ActivitiesResponse, stream: string): string {
  const detail = body.error?.message ?? "";

  if (status === 403) {
    return (
      `Google returned 403 for the ${stream} stream. The usual cause is domain-wide ` +
      `delegation not being authorized: in the Admin console, Security → Access and ` +
      `data control → API controls → Domain-wide delegation must list the service ` +
      `account's client ID with the admin.reports.audit.readonly scope. Also check ` +
      `that the impersonated admin is a super-admin. ${detail}`
    );
  }
  if (status === 401) {
    return `Google rejected the assertion for ${stream} (401). Check the service account key and email. ${detail}`;
  }
  if (status === 400 && detail.toLowerCase().includes("invalid")) {
    return `Google rejected the ${stream} request as invalid — often an unknown applicationName. ${detail}`;
  }
  return `Google returned ${status} for ${stream}: ${detail || "no detail"}`;
}

async function fetchPage(
  ctx: CollectorContext,
  stream: string,
  startTime: string,
  pageToken: string | undefined,
  attempt: number,
): Promise<ActivitiesResponse | null> {
  const params = new URLSearchParams({
    startTime,
    maxResults: String(PAGE_SIZE),
  });
  if (pageToken) params.set("pageToken", pageToken);

  // The Authorization header is injected by the sandbox after it exchanges the
  // signed assertion; this code never sees the key or the bearer.
  const response = await fetch(`${BASE}/${stream}?${params.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("Retry-After") ?? "30");
    const waitMs = Math.min(
      Math.max(Number.isFinite(retryAfter) ? retryAfter * 1000 : 30_000, 1_000),
      MAX_WAIT_MS,
    );
    ctx.log("Rate limited, backing off", { stream, waitMs });
    await sleep(waitMs);
    return null;
  }

  if (response.status >= 500) {
    if (attempt >= MAX_SERVER_ERROR_RETRIES) {
      throw new Error(`Google returned ${response.status} for ${stream} after ${MAX_SERVER_ERROR_RETRIES} retries`);
    }
    await sleep(SERVER_ERROR_BACKOFF_MS);
    return null;
  }

  if (!response.ok) {
    let body: ActivitiesResponse = {};
    try {
      body = (await response.json()) as ActivitiesResponse;
    } catch {
      // Non-JSON error body; the status alone still tells the operator enough.
    }
    throw new Error(googleErrorMessage(response.status, body, stream));
  }

  return (await response.json()) as ActivitiesResponse;
}

/**
 * Drain one application's activities from `startTime` forward.
 *
 * Every page in the window is walked before the cursor moves. Stopping early on
 * seeing an old event would be wrong here — ordering is not guaranteed, so an
 * older event can appear on a page ahead of a newer one.
 */
async function collectStream(ctx: CollectorContext, stream: string): Promise<number> {
  const cursor = resumeFrom(ctx, stream);
  const startTime = cursor.t;
  const startMs = Date.parse(startTime);
  const alreadyShipped = new Set(cursor.seen);
  ctx.log("Collecting activities", { stream, startTime, seen: cursor.seen.length });

  let pageToken: string | undefined;
  let attempt = 0;
  let pages = 0;
  let collected = 0;
  let skipped = 0;
  let newest = startMs;
  // Identities at exactly `newest`. Rebuilt whenever a later instant wins, so
  // it only ever describes the boundary.
  let atNewest: string[] = [...cursor.seen];

  while (!ctx.shouldStop()) {
    if (pages >= MAX_PAGES_PER_STREAM) {
      ctx.log("Page ceiling reached; the rest follows next run", { stream, pages });
      break;
    }

    const body = await fetchPage(ctx, stream, startTime, pageToken, attempt);
    if (body === null) {
      // Backed off inside fetchPage; the request never landed, so retry the
      // same page token.
      attempt += 1;
      continue;
    }
    attempt = 0;
    pages += 1;

    const items = body.items ?? [];

    // `startTime` is inclusive, so the records that sat on the boundary last
    // run come back every run. Drop the ones already shipped — by identity, not
    // by time, so a NEW record sharing that instant still gets through.
    const fresh = items.filter((item) => {
      const t = activityTime(item);
      if (t === null || t !== startMs) return true;
      const key = activityKey(item);
      if (key === null || !alreadyShipped.has(key)) return true;
      skipped += 1;
      return false;
    });

    if (fresh.length > 0) {
      await ctx.emit(stream, fresh);
      collected += fresh.length;
    }

    // Track the boundary across everything SEEN, not just what was emitted:
    // a filtered duplicate still sits on the watermark and must stay in `seen`,
    // or the next run ships it again.
    for (const item of items) {
      const t = activityTime(item);
      if (t === null) continue;
      if (t > newest) {
        newest = t;
        atNewest = [];
      }
      if (t === newest) {
        const key = activityKey(item);
        if (key !== null && !atNewest.includes(key)) atNewest.push(key);
      }
    }

    pageToken = body.nextPageToken;
    if (!pageToken) break;

    await sleep(PAGE_INTERVAL_MS);
  }

  if (skipped > 0) {
    ctx.log("Filtered records already shipped at the watermark", { stream, skipped });
  }

  if (atNewest.length > MAX_SEEN) {
    // Every identity here shares one instant, so there is no meaningful order
    // among them and no subset is a better bet than another — the dropped ones
    // simply re-deliver once each. Bounding the cursor matters more than which
    // ones survive.
    ctx.log("Boundary identity set capped; some records may re-deliver once", {
      stream,
      at: new Date(newest).toISOString(),
      dropped: atNewest.length - MAX_SEEN,
    });
    atNewest = atNewest.slice(-MAX_SEEN);
  }

  // Commit once, after every page has been acked. Committing per page would
  // advance the window past events on pages not yet shipped.
  //
  // The watermark is the newest EVENT time, never wall-clock: Workspace audit
  // events surface minutes to hours late, so moving to "now" would skip
  // everything still in flight, silently and permanently.
  //
  // Committed even when the instant did NOT move, because `seen` may have
  // grown — that is how a stream with no new events stops re-shipping its
  // newest record on every poll.
  const advanced = newest > startMs;
  const learned = atNewest.length !== cursor.seen.length;
  if (advanced || learned) {
    const next: Cursor = { t: new Date(newest).toISOString(), seen: atNewest };
    await ctx.checkpoint(stream, JSON.stringify(next));
  }

  return collected;
}

async function collect(ctx: CollectorContext): Promise<void> {
  const failures: string[] = [];
  let total = 0;

  for (const stream of ctx.streams) {
    if (ctx.shouldStop()) {
      ctx.log("Run budget exhausted, stopping early", { remaining: stream });
      break;
    }

    try {
      const count = await collectStream(ctx, stream);
      total += count;
      ctx.log("Stream drained", { stream, events: count });
    } catch (error) {
      // One application's missing scope should not take down the others —
      // delegation is commonly authorized for some scopes and not others.
      const message = error instanceof Error ? error.message : String(error);
      ctx.log("Stream failed", { stream, error: message });
      failures.push(`${stream}: ${message}`);
    }
  }

  ctx.log("Run complete", { events: total, failed: failures.length });

  if (failures.length > 0) {
    throw new Error(`${failures.length} stream(s) failed — ${failures.join("; ")}`);
  }
}

export { collect };
