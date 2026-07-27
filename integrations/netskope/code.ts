// Netskope — REST API v2 Data Export collector
//
// Docs:
//   https://docs.netskope.com/en/using-the-rest-api-v2-dataexport-iterator-endpoints/
//   https://github.com/netskopeoss/Data-Schema   (field definitions)
//
// The iterator API keeps the read position SERVER-side, keyed by the `index`
// query parameter, and it ADVANCES WHEN A PAGE IS SERVED. That single fact
// drives the cursor design here, and makes this collector meaningfully
// different from one over a client-side watermark (see google_workspace, where
// the cursor is a timestamp we own and can rewind freely).
//
// Because the position is theirs, a page we fetch but fail to ship is gone —
// the index has already moved past it. So the cursor records not "where we are"
// but "what state the last page is in":
//
//   undefined  -> iterator not open; position it with `operation=<epoch>`
//   "open"     -> last page fetched AND emitted; walk on with `operation=next`
//   "resend"   -> a page was fetched but never confirmed; re-serve it with
//                 `operation=resend`, which does NOT advance the index
//
// Other consequences worth knowing before editing:
//
//   * Two consumers sharing an index name steal each other's events. The index
//     name is operator-configurable for exactly this reason.
//   * Concurrent requests against the same index return 409 and can lose data.
//     Streams here are strictly sequential.
//   * Events not collected within the tenant's retention window are dropped by
//     Netskope, not queued. Sustained collector downtime is silent data loss.

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

interface IteratorResponse {
  ok?: number;
  result?: unknown[];
  wait_time?: number;
  message?: string;
}

/** Netskope allows 4 requests/second per endpoint. Stay under it. */
const MIN_REQUEST_INTERVAL_MS = 300;

/** Cap on `wait_time` obedience — a pathological value shouldn't hang the run. */
const MAX_WAIT_MS = 60_000;

/** Backoff for 5xx, per Netskope's guidance. */
const SERVER_ERROR_BACKOFF_MS = 5_000;

const MAX_SERVER_ERROR_RETRIES = 3;

/**
 * Cursor states.
 *
 * Netskope's read position lives on THEIR side and advances when a page is
 * served — unlike a client-side watermark, we cannot rewind it by remembering a
 * timestamp. So a page that is fetched but not successfully shipped is lost
 * unless the next request explicitly asks for it again.
 *
 * `OPEN`   — the last page was fetched AND emitted. Safe to walk forward.
 * `RESEND` — a page was fetched but not confirmed. The next request must be
 *            `operation=resend`, which re-serves the last page WITHOUT
 *            advancing the index.
 */
const CURSOR_OPEN = "open";
const CURSOR_RESEND = "resend";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Normalize the operator-supplied hostname. nano validates it against the
 * manifest's `allowed_domain_suffixes` before we ever run, but an operator
 * pasting a full URL is common enough to be worth handling rather than failing
 * with an opaque fetch error.
 */
function tenantHost(config: Record<string, string>): string {
  const raw = (config.TENANT_HOST ?? "").trim();
  if (raw === "") {
    throw new Error("TENANT_HOST is not set");
  }
  const stripped = raw
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  if (stripped === "") {
    throw new Error(`TENANT_HOST ${JSON.stringify(raw)} is not a hostname`);
  }
  return stripped;
}

/**
 * Iterator names must be unique per consumer. Suffixing with the stream id
 * keeps the nine streams from sharing a position — sharing one would make each
 * stream consume the others' events.
 */
function indexName(config: Record<string, string>, stream: string): string {
  const base = (config.INDEX_NAME ?? "nano").trim() || "nano";
  return `${base}_${stream}`;
}

/**
 * Where to position a brand-new iterator. `backfillFrom` is the operator's
 * explicit ask; without one we start at now, because opening an iterator at
 * epoch 0 makes Netskope replay the entire retention window on first poll.
 */
function startEpochSeconds(ctx: CollectorContext): number {
  if (ctx.backfillFrom) {
    const parsed = Date.parse(ctx.backfillFrom);
    if (!Number.isNaN(parsed)) {
      return Math.floor(parsed / 1000);
    }
    ctx.log("Ignoring unparseable backfillFrom", { value: ctx.backfillFrom });
  }
  return Math.floor(Date.now() / 1000);
}

/**
 * One iterator request. Returns the parsed body, or null when the caller
 * should retry after backing off.
 *
 * The auth header is injected by the sandbox — this code never sees the token.
 */
async function fetchPage(
  ctx: CollectorContext,
  host: string,
  stream: string,
  operation: string,
  attempt: number,
): Promise<IteratorResponse | null> {
  const url =
    `https://${host}/api/v2/events/dataexport/events/${stream}` +
    `?index=${encodeURIComponent(indexName(ctx.config, stream))}` +
    `&operation=${encodeURIComponent(operation)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("Retry-After") ?? "1");
    const waitMs = Math.min(
      Math.max(Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000, 1000),
      MAX_WAIT_MS,
    );
    ctx.log("Rate limited, backing off", { stream, waitMs });
    await sleep(waitMs);
    return null;
  }

  // 409 means someone else is consuming this index concurrently. Retrying
  // immediately would compound the conflict, and Netskope's own guidance is to
  // enforce single-threaded consumption rather than retry — so surface it.
  if (response.status === 409) {
    throw new Error(
      `Netskope returned 409 for stream ${stream}: iterator ` +
        `${indexName(ctx.config, stream)} is being consumed concurrently. ` +
        `Change the iterator name if another tool shares this tenant.`,
    );
  }

  if (response.status === 403) {
    throw new Error(
      `Netskope returned 403 for stream ${stream}: the API token lacks read ` +
        `access to /api/v2/events/dataexport/events/${stream}, or has expired.`,
    );
  }

  if (response.status >= 500) {
    if (attempt >= MAX_SERVER_ERROR_RETRIES) {
      throw new Error(
        `Netskope returned ${response.status} for stream ${stream} after ` +
          `${MAX_SERVER_ERROR_RETRIES} retries`,
      );
    }
    ctx.log("Server error, backing off", { stream, status: response.status });
    await sleep(SERVER_ERROR_BACKOFF_MS);
    return null;
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Netskope returned ${response.status} for stream ${stream}: ${body.slice(0, 500)}`,
    );
  }

  const body = (await response.json()) as IteratorResponse;

  // `ok: 0` is an application-level failure carrying a 200. Treating it as
  // success would advance the iterator past events we never collected.
  if (body.ok !== undefined && body.ok !== 1) {
    throw new Error(
      `Netskope reported failure for stream ${stream}: ${body.message ?? "no message"}`,
    );
  }

  return body;
}

/**
 * Drain one stream until it runs dry, the run budget expires, or an error is
 * thrown.
 *
 * The checkpoint("resend") → emit → checkpoint("open") sequence is the delivery
 * contract. Marking the page in flight BEFORE shipping it is what makes a crash
 * recoverable: with a server-side index, "no checkpoint" is not the same as "no
 * progress" — Netskope has already moved on, so only an explicit `resend` gets
 * the page back.
 */
async function collectStream(
  ctx: CollectorContext,
  host: string,
  stream: string,
): Promise<number> {
  let collected = 0;
  let attempt = 0;

  // CURSOR_RESEND means a previous run fetched a page it never confirmed —
  // re-serve that page rather than walking past it. CURSOR_OPEN means the last
  // page was fully shipped. Anything else means the iterator is not open yet.
  const saved = ctx.cursors[stream];
  let operation =
    saved === CURSOR_RESEND
      ? CURSOR_RESEND
      : saved === CURSOR_OPEN
        ? "next"
        : String(startEpochSeconds(ctx));

  // True once Netskope holds a position for this index, which is what makes
  // `resend` a legal request.
  let iteratorOpen = saved === CURSOR_OPEN || saved === CURSOR_RESEND;

  if (operation !== "next") {
    ctx.log("Opening iterator", { stream, fromEpoch: operation });
  }

  while (!ctx.shouldStop()) {
    const body = await fetchPage(ctx, host, stream, operation, attempt);

    if (body === null) {
      // Backed off inside fetchPage. A 5xx means the request DID reach
      // Netskope and may have advanced the index, so walking on with `next`
      // would skip a page. `resend` re-serves the last one without advancing.
      // Re-positioning by epoch stays idempotent while the iterator is closed.
      attempt += 1;
      if (iteratorOpen) operation = CURSOR_RESEND;
      continue;
    }
    attempt = 0;
    iteratorOpen = true;

    const events = Array.isArray(body.result) ? body.result : [];

    if (events.length > 0) {
      // Mark the page in flight BEFORE shipping it. If the run dies between
      // here and the emit ack, the next run resends this page instead of
      // walking past it — the whole point, since Netskope will not re-serve a
      // page the index has already passed.
      await ctx.checkpoint(stream, CURSOR_RESEND);
      await ctx.emit(stream, events);
      await ctx.checkpoint(stream, CURSOR_OPEN);
      collected += events.length;
    } else if (operation !== "next") {
      // Iterator opened but the first page was empty. Still commit the cursor
      // so the next run walks forward instead of re-positioning to a later
      // timestamp and skipping everything in between.
      await ctx.checkpoint(stream, CURSOR_OPEN);
    }

    // After the first request the iterator is positioned; everything after is
    // a walk.
    operation = "next";

    // An empty page means we have caught up. Stop rather than spin — the
    // scheduler will call us again on the poll interval.
    if (events.length === 0) {
      break;
    }

    // Netskope computes `wait_time` from the volume it just served. Honor it,
    // with a floor that keeps us inside the 4 req/s limit.
    const serverWaitMs = Math.min(
      Math.max((body.wait_time ?? 0) * 1000, 0),
      MAX_WAIT_MS,
    );
    await sleep(Math.max(serverWaitMs, MIN_REQUEST_INTERVAL_MS));
  }

  return collected;
}

async function collect(ctx: CollectorContext): Promise<void> {
  const host = tenantHost(ctx.config);
  const failures: string[] = [];
  let total = 0;

  // Sequential by design: concurrent iterator use returns 409 and can lose
  // events. Netskope's 4 req/s limit is per endpoint, so parallelising across
  // streams would be legal rate-wise — but a shared 409 failure mode is not
  // worth the wall-clock saving on a 5-minute poll.
  for (const stream of ctx.streams) {
    if (ctx.shouldStop()) {
      ctx.log("Run budget exhausted, stopping early", { remaining: stream });
      break;
    }

    try {
      const count = await collectStream(ctx, host, stream);
      total += count;
      ctx.log("Stream drained", { stream, events: count });
    } catch (error) {
      // One stream's token scope or outage should not take down the other
      // eight. Collect the failures and raise at the end so the run is marked
      // failed and the operator sees every broken stream at once.
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
