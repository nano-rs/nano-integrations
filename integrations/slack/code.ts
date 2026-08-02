// Slack — workspace sign-in records via team.accessLogs
//
// Docs: https://docs.slack.dev/reference/methods/team.accessLogs/
//
// This endpoint is NOT an append-only event log, and that shapes everything
// below. It returns one aggregated record per (user, IP, user-agent) with
// `date_first`, `date_last` and `count` — so a record an earlier run already
// saw comes back later with a higher `count` and a newer `date_last`.
//
// Consequences worth knowing before editing:
//
//   * There is no "since" parameter. Incremental collection means walking
//     newest-first and stopping once records fall below the last watermark.
//   * Re-delivery is guaranteed, not incidental: a session still being added to
//     is re-emitted every run until it goes quiet, because its `date_last`
//     keeps moving past the watermark. A record that has NOT changed is not
//     re-emitted — the walk breaks on `date_last <= watermark`, excluding the
//     boundary. Keep that comparison inclusive-of-the-watermark: the Google
//     Workspace collector had the mirror-image bug (an inclusive API boundary
//     with a strict guard) and re-shipped one record every poll for five days
//     (NAN-2272). code.test.ts pins both halves of this.
//   * The records are mutable, so the newest ones are the least stable. That is
//     fine for a SIEM — later copies supersede earlier ones on the same
//     (user, ip, user_agent) key, which the parser preserves so a query can
//     pick the latest.
//
// Requires a *user* token (xoxp-) with the `admin` scope; access logs are not
// readable with a bot token. Available on Pro and Business+ — the Audit Logs
// API, which is a real event stream, is Enterprise Grid only.

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

interface SlackLogin {
  user_id?: string;
  username?: string;
  date_first?: number;
  date_last?: number;
  count?: number;
  ip?: string;
  user_agent?: string;
  isp?: string;
  country?: string;
  region?: string;
}

interface AccessLogsResponse {
  ok?: boolean;
  error?: string;
  logins?: SlackLogin[];
  response_metadata?: { next_cursor?: string };
}

const STREAM = "access_logs";

/** Tier 2 allows roughly 20 requests/minute. Stay comfortably under it. */
const MIN_REQUEST_INTERVAL_MS = 3_000;

/** Cap on any backoff so a pathological Retry-After cannot hang the run. */
const MAX_WAIT_MS = 60_000;

/** Cursor mode is triggered by sending `limit`; page mode caps out at 100 pages. */
const PAGE_LIMIT = 200;

/** Stop after this many pages even if Slack keeps offering a cursor. */
const MAX_PAGES = 100;

const SERVER_ERROR_BACKOFF_MS = 5_000;
const MAX_SERVER_ERROR_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Watermark: the highest `date_last` shipped so far, as epoch seconds.
 *
 * Deliberately not "the newest record's timestamp at run start" — a session
 * active during the run would be missed on the next one.
 */
function readWatermark(ctx: CollectorContext): number {
  const raw = ctx.cursors[STREAM];
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (ctx.backfillFrom) {
    const parsed = Date.parse(ctx.backfillFrom);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
    ctx.log("Ignoring unparseable backfillFrom", { value: ctx.backfillFrom });
  }
  // No cursor and no explicit backfill: take everything Slack still holds. The
  // volume is bounded (one record per user/IP/device, not per sign-in), so this
  // is a few pages rather than an unbounded history.
  return 0;
}

async function fetchPage(
  ctx: CollectorContext,
  cursor: string | undefined,
  attempt: number,
): Promise<AccessLogsResponse | null> {
  const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
  if (cursor) params.set("cursor", cursor);
  const teamId = (ctx.config.TEAM_ID ?? "").trim();
  if (teamId) params.set("team_id", teamId);

  // The Authorization header is injected by the sandbox; this code never sees
  // the token.
  const response = await fetch(
    `https://slack.com/api/team.accessLogs?${params.toString()}`,
    { method: "GET", headers: { Accept: "application/json" } },
  );

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("Retry-After") ?? "30");
    const waitMs = Math.min(
      Math.max(Number.isFinite(retryAfter) ? retryAfter * 1000 : 30_000, 1_000),
      MAX_WAIT_MS,
    );
    ctx.log("Rate limited, backing off", { waitMs });
    await sleep(waitMs);
    return null;
  }

  if (response.status >= 500) {
    if (attempt >= MAX_SERVER_ERROR_RETRIES) {
      throw new Error(
        `Slack returned ${response.status} after ${MAX_SERVER_ERROR_RETRIES} retries`,
      );
    }
    await sleep(SERVER_ERROR_BACKOFF_MS);
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack returned ${response.status}: ${body.slice(0, 300)}`);
  }

  const body = (await response.json()) as AccessLogsResponse;

  // Slack signals application errors with HTTP 200 and ok:false. Treating that
  // as success would advance the watermark past records never collected.
  if (body.ok === false) {
    throw new Error(slackErrorMessage(body.error));
  }

  return body;
}

/** Turn Slack's error codes into something an operator can act on. */
function slackErrorMessage(code: string | undefined): string {
  switch (code) {
    case "paid_only":
      return "Slack returned paid_only: access logs need a Pro or Business+ workspace.";
    case "missing_scope":
      return "Slack returned missing_scope: the token needs the `admin` user scope. " +
        "A bot token (xoxb-) cannot read access logs — use a user token (xoxp-).";
    case "not_allowed_token_type":
      return "Slack rejected the token type: access logs require a user token (xoxp-), not a bot token.";
    case "invalid_auth":
    case "token_revoked":
      return `Slack rejected the token (${code}). Reinstall the app and update the credential.`;
    case "invalid_team_id":
      return "Slack returned invalid_team_id: check the Team ID, or leave it blank for a normal workspace token.";
    case "over_pagination_limit":
      return "Slack returned over_pagination_limit — this is a collector bug, not a configuration problem.";
    default:
      return `Slack returned an error: ${code ?? "unknown"}`;
  }
}

/**
 * Report a stream failure the way the host can attribute it, then rethrow.
 *
 * nano recovers the failing stream's NAME from this exact structured log — it
 * is the only place an individual stream is still named, because collectors
 * rethrow one aggregate at the end of a run. Without it the per-stream
 * `last_error` stays NULL and a broken stream is indistinguishable from a quiet
 * one in the UI (NAN-2280).
 *
 * The message string and the `stream` / `error` fields are a contract with the
 * host, not free text. `code.test.ts` pins them.
 */
async function collect(ctx: CollectorContext): Promise<void> {
  if (!ctx.streams.includes(STREAM)) {
    ctx.log("Sign-in records stream not enabled, nothing to do");
    return;
  }

  try {
    await collectAccessLogs(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log("Stream failed", { stream: STREAM, error: message });
    // Rethrown so the run is still marked failed — this only adds attribution,
    // it does not swallow the failure.
    throw error;
  }
}

async function collectAccessLogs(ctx: CollectorContext): Promise<void> {
  const watermark = readWatermark(ctx);
  ctx.log("Collecting sign-in records", { sinceEpoch: watermark });

  let cursor: string | undefined;
  let attempt = 0;
  let pages = 0;
  let collected = 0;
  // Track the newest record seen across the whole run, and only commit it at
  // the end. Committing per page would advance past records on later pages —
  // Slack returns newest first, so a mid-run failure would skip the remainder.
  let newest = watermark;

  while (!ctx.shouldStop()) {
    if (pages >= MAX_PAGES) {
      ctx.log("Hit the page ceiling; remaining history will be picked up next run", {
        pages,
      });
      break;
    }

    const body = await fetchPage(ctx, cursor, attempt);
    if (body === null) {
      // Backed off inside fetchPage. Retry the same cursor: the request never
      // landed, so nothing has advanced.
      attempt += 1;
      continue;
    }
    attempt = 0;
    pages += 1;

    const logins = body.logins ?? [];
    if (logins.length === 0) break;

    // Newest first, so once a record is at or below the watermark everything
    // after it is too.
    const fresh: SlackLogin[] = [];
    let reachedWatermark = false;
    for (const login of logins) {
      const last = login.date_last ?? login.date_first ?? 0;
      if (last > newest) newest = last;
      if (last <= watermark) {
        reachedWatermark = true;
        break;
      }
      fresh.push(login);
    }

    if (fresh.length > 0) {
      await ctx.emit(STREAM, fresh);
      collected += fresh.length;
    }

    if (reachedWatermark) break;

    cursor = body.response_metadata?.next_cursor || undefined;
    if (!cursor) break;

    await sleep(MIN_REQUEST_INTERVAL_MS);
  }

  // Only commit once every page that was going to be emitted has been acked.
  if (newest > watermark) {
    await ctx.checkpoint(STREAM, String(newest));
  }

  ctx.log("Run complete", { records: collected, pages, watermark: newest });
}

export { collect };
