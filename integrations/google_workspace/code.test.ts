// NAN-2272 — the boundary event was re-delivered on EVERY poll, forever.
//
// `startTime` is inclusive, so the newest event comes back next run; the old
// guard `newest > startTime` was then false, the cursor never advanced, and the
// same record shipped every 15 minutes. Quiet streams amplified hardest —
// gws_admin reached 547 rows for 6 real events (91x) in five days.
//
// These drive the real `collect` against a stubbed Reports API, so they cover
// the cursor round-trip rather than a helper in isolation: the bug lived in the
// hand-off between runs, which a unit test of either half would have missed.
//
//   deno test integrations/google_workspace/code.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { collect } from "./code.ts";

interface Activity {
  id: { time: string; uniqueQualifier?: string; applicationName?: string };
  actor?: Record<string, unknown>;
}

function activity(time: string, qualifier: string): Activity {
  return { id: { time, uniqueQualifier: qualifier, applicationName: "admin" } };
}

/** Event times are relative to now, so they land inside the default 24h window. */
const T0 = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const T1 = new Date(Date.now() - 30 * 60 * 1000).toISOString();

/**
 * A Reports API that honours `startTime` the way Google does: **inclusive**.
 *
 * Modelling that is the entire point — the bug is that an inclusive boundary
 * re-serves the watermark record on every call. A stub that ignored startTime
 * would re-serve everything and prove nothing about the fix.
 */
function stubApi(pages: Record<string, Activity[]>) {
  const startTimes: string[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    const stream = url.pathname.split("/").pop() ?? "";
    const startTime = url.searchParams.get("startTime") ?? "";
    startTimes.push(startTime);

    const from = Date.parse(startTime);
    const items = (pages[stream] ?? []).filter(
      (a) => Date.parse(a.id.time) >= from, // inclusive, as documented
    );

    return Promise.resolve(
      new Response(JSON.stringify({ items }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  return { startTimes, restore: () => { globalThis.fetch = original; } };
}

function makeCtx(cursors: Record<string, string | undefined>) {
  const emitted: Activity[] = [];
  const checkpoints: string[] = [];
  return {
    emitted,
    checkpoints,
    ctx: {
      cursors,
      credentials: {},
      config: {},
      streams: ["admin"],
      emit: (_s: string, events: unknown[]) => {
        emitted.push(...(events as Activity[]));
        return Promise.resolve();
      },
      checkpoint: (_s: string, cursor: string) => {
        checkpoints.push(cursor);
        cursors["admin"] = cursor;
        return Promise.resolve();
      },
      shouldStop: () => false,
      log: () => {},
    },
  };
}

Deno.test("a quiet stream ships its newest event once, not once per poll", async () => {
  const evt = activity(T0, "q-1");
  const api = stubApi({ admin: [evt] });
  try {
    const cursors: Record<string, string | undefined> = {};

    // Three consecutive polls against an API whose contents never change —
    // exactly the gws_admin situation.
    let total = 0;
    for (let poll = 0; poll < 3; poll++) {
      const h = makeCtx(cursors);
      await collect(h.ctx as never);
      total += h.emitted.length;
    }

    assertEquals(total, 1, "the same event must not be re-emitted on later polls");
  } finally {
    api.restore();
  }
});

Deno.test("a new event sharing the boundary instant is still delivered", async () => {
  const instant = T0;
  const first = activity(instant, "q-1");
  const api = stubApi({ admin: [first] });
  try {
    const cursors: Record<string, string | undefined> = {};

    const run1 = makeCtx(cursors);
    await collect(run1.ctx as never);
    assertEquals(run1.emitted.length, 1);

    // A second record lands at the SAME millisecond. Nudging the watermark
    // forward would have lost this one; identity filtering keeps it.
    api.restore();
    const api2 = stubApi({ admin: [first, activity(instant, "q-2")] });
    try {
      const run2 = makeCtx(cursors);
      await collect(run2.ctx as never);
      assertEquals(run2.emitted.length, 1, "only the unseen record");
      assertEquals(run2.emitted[0].id.uniqueQualifier, "q-2");
    } finally {
      api2.restore();
    }
  } catch (e) {
    api.restore();
    throw e;
  }
});

Deno.test("the watermark still advances when a newer event arrives", async () => {
  const older = activity(T0, "q-1");
  const newer = activity(T1, "q-2");
  const api = stubApi({ admin: [older] });
  try {
    const cursors: Record<string, string | undefined> = {};
    const run1 = makeCtx(cursors);
    await collect(run1.ctx as never);

    api.restore();
    const api2 = stubApi({ admin: [older, newer] });
    try {
      const run2 = makeCtx(cursors);
      await collect(run2.ctx as never);
      assertEquals(run2.emitted.length, 1);
      assertEquals(run2.emitted[0].id.uniqueQualifier, "q-2");

      // The boundary moved, so the old identity must be forgotten rather than
      // accumulated — otherwise `seen` grows with the stream.
      const cursor = JSON.parse(cursors["admin"] as string);
      assertEquals(cursor.t, T1);
      assertEquals(cursor.seen, ["q-2"]);
    } finally {
      api2.restore();
    }
  } catch (e) {
    api.restore();
    throw e;
  }
});

Deno.test("a legacy plain-timestamp cursor resumes without re-emitting", async () => {
  const instant = T0;
  const evt = activity(instant, "q-1");
  const api = stubApi({ admin: [evt] });
  try {
    // What the previous version wrote: a bare RFC 3339 string.
    const cursors: Record<string, string | undefined> = { admin: instant };

    // First run after the upgrade still re-emits once — the old cursor carries
    // no identities, so there is nothing to match on. That is at-least-once,
    // and it is the last time.
    const run1 = makeCtx(cursors);
    await collect(run1.ctx as never);
    assertEquals(run1.emitted.length, 1);

    const run2 = makeCtx(cursors);
    await collect(run2.ctx as never);
    assertEquals(run2.emitted.length, 0, "the repeat must stop after one run");
  } finally {
    api.restore();
  }
});

Deno.test("a corrupt cursor does not throw the run away", async () => {
  const api = stubApi({ admin: [activity(T0, "q-1")] });
  try {
    const cursors: Record<string, string | undefined> = { admin: "{not json" };
    const run = makeCtx(cursors);
    await collect(run.ctx as never);
    // Falls back to the 24h default window and carries on.
    assertEquals(run.emitted.length, 1);
  } finally {
    api.restore();
  }
});

/**
 * A newest-first Reports API with real page tokens and inclusive time bounds.
 * Events are generated on demand so the ceiling test does not retain a second
 * 500,001-item copy of its backlog.
 */
function paginatedStubApi(total: number, oldestMs: number) {
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;

  globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    const startMs = Date.parse(url.searchParams.get("startTime") ?? "");
    const end = url.searchParams.get("endTime");
    const endMs = end === null ? Number.POSITIVE_INFINITY : Date.parse(end);
    const pageSize = Number(url.searchParams.get("maxResults") ?? "1000");
    const offset = Number(url.searchParams.get("pageToken") ?? "0");

    // One event per millisecond makes the time-bound continuation observable:
    // the next run must retain the inclusive lower bound while narrowing the
    // upper bound below the already walked newest pages.
    const first = Math.max(0, Math.ceil(startMs - oldestMs));
    const last = Math.min(total - 1, Math.floor(endMs - oldestMs));
    const available = Math.max(0, last - first + 1);
    const count = Math.min(pageSize, Math.max(0, available - offset));
    const items: Activity[] = [];
    for (let i = 0; i < count; i++) {
      const index = last - offset - i;
      items.push(activity(new Date(oldestMs + index).toISOString(), `q-${index}`));
    }

    const body: { items: Activity[]; nextPageToken?: string } = { items };
    if (offset + count < available) body.nextPageToken = String(offset + count);
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  // Production pacing is important, but waiting 499 * 250ms would only make
  // this deterministic pagination test slow.
  globalThis.setTimeout = ((handler: () => void) => {
    handler();
    return 0;
  }) as typeof setTimeout;

  return {
    restore: () => {
      globalThis.fetch = originalFetch;
      globalThis.setTimeout = originalSetTimeout;
    },
  };
}

function paginatedCtx(
  cursors: Record<string, string | undefined>,
  delivered: Set<string>,
  shouldStop: () => boolean = () => false,
) {
  const logs: string[] = [];
  let emitted = 0;
  return {
    logs,
    get emitted() {
      return emitted;
    },
    ctx: {
      cursors,
      credentials: {},
      config: {},
      streams: ["admin"],
      emit: (_s: string, events: unknown[]) => {
        for (const event of events as Activity[]) {
          emitted += 1;
          delivered.add(event.id.uniqueQualifier ?? "");
        }
        return Promise.resolve();
      },
      checkpoint: (_s: string, cursor: string) => {
        cursors["admin"] = cursor;
        return Promise.resolve();
      },
      shouldStop,
      log: (message: string) => logs.push(message),
    },
  };
}

Deno.test("a backlog beyond the page ceiling drains across consecutive runs", async () => {
  const total = 500_001;
  const oldestMs = Date.now() - 3 * 60 * 60 * 1000;
  const api = paginatedStubApi(total, oldestMs);
  try {
    const initial = new Date(oldestMs - 1).toISOString();
    const cursors: Record<string, string | undefined> = {
      admin: JSON.stringify({ t: initial, seen: [] }),
    };
    const delivered = new Set<string>();

    const run1 = paginatedCtx(cursors, delivered);
    await collect(run1.ctx as never);
    assertEquals(delivered.size, 500_000);
    assertEquals(JSON.parse(cursors.admin as string).t, initial, "the lower boundary stays pinned");
    assertEquals(
      run1.logs.includes("Walk truncated; older events will resume from an overlapping boundary next run"),
      true,
    );
    assertEquals(run1.logs.includes("Stream paused"), true);

    const run2 = paginatedCtx(cursors, delivered);
    await collect(run2.ctx as never);
    assertEquals(delivered.size, total, "the oldest page must not be stranded behind the ceiling");
    assertEquals(JSON.parse(cursors.admin as string).continuation, undefined, "the final cursor is v3-compatible");
  } finally {
    api.restore();
  }
});

Deno.test("a shouldStop truncation drains its backlog across consecutive runs", async () => {
  const total = 2_001;
  const oldestMs = Date.now() - 2 * 60 * 60 * 1000;
  const api = paginatedStubApi(total, oldestMs);
  try {
    const initial = new Date(oldestMs - 1).toISOString();
    const cursors: Record<string, string | undefined> = {
      admin: JSON.stringify({ t: initial, seen: [] }),
    };
    const delivered = new Set<string>();
    let stopChecks = 0;

    // collect checks once before entering the stream and once before each page.
    // The third check stops after page one has been emitted and acknowledged.
    const run1 = paginatedCtx(cursors, delivered, () => stopChecks++ >= 2);
    await collect(run1.ctx as never);
    assertEquals(delivered.size, 1_000);
    assertEquals(JSON.parse(cursors.admin as string).t, initial, "the lower boundary stays pinned");
    assertEquals(
      run1.logs.includes("Walk truncated; older events will resume from an overlapping boundary next run"),
      true,
    );
    assertEquals(run1.logs.includes("Stream paused"), true);

    const run2 = paginatedCtx(cursors, delivered);
    await collect(run2.ctx as never);
    assertEquals(delivered.size, total, "stopping mid-walk must not strand older pages");
    assertEquals(JSON.parse(cursors.admin as string).continuation, undefined, "the final cursor is v3-compatible");
  } finally {
    api.restore();
  }
});
