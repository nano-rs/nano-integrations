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
import { collect, INITIAL_OVERLAP_MS } from "./code.ts";

interface Activity {
  id: { time: string; uniqueQualifier?: string; applicationName?: string };
  actor?: Record<string, unknown>;
}

function activity(time: string, qualifier: string): Activity {
  return { id: { time, uniqueQualifier: qualifier, applicationName: "admin" } };
}

/**
 * Event times are relative to now. The NAN-2272 cases model a stream the host
 * activated two hours ago, so they land after its initial cursor.
 */
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

const ACTIVATED_2H_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000 - INITIAL_OVERLAP_MS).toISOString();

function makeCtx(
  cursors: Record<string, string | undefined>,
  start: { initialCursors?: Record<string, string>; initialCursor?: string; backfillFrom?: string } = {
    initialCursor: ACTIVATED_2H_AGO,
  },
) {
  const emitted: Activity[] = [];
  const checkpoints: string[] = [];
  const logs: string[] = [];
  return {
    emitted,
    checkpoints,
    logs,
    ctx: {
      ...start,
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
      log: (msg: string) => {
        logs.push(msg);
      },
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
    // Restarts at the initial cursor, loudly, and carries on (NAN-3697).
    assertEquals(run.emitted.length, 1);
    assertEquals(run.logs.filter((l) => l.startsWith("CURSOR UNREADABLE")).length, 1);
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
  }) as unknown as typeof setTimeout;

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

// ---------------------------------------------------------------------------
// NAN-3697: point-forward start, with the clock pinned by stubbing Date.now.
// The stub records every request's startTime, which is the start under test.
// ---------------------------------------------------------------------------

const FAKE_NOW_MS = Date.parse("2026-10-12T15:00:00.000Z");
const isoAt = (ms: number) => new Date(ms).toISOString();

async function atFakeNow(fn: () => Promise<void>): Promise<void> {
  const real = Date.now;
  Date.now = () => FAKE_NOW_MS;
  try {
    await fn();
  } finally {
    Date.now = real;
  }
}

Deno.test("NAN-3697 gws: no cursor starts exactly at initialCursor (now - 300 s)", async () => {
  const api = stubApi({ admin: [activity(isoAt(FAKE_NOW_MS - 3 * 86400_000), "old"), activity(isoAt(FAKE_NOW_MS - 60_000), "new")] });
  try {
    await atFakeNow(async () => {
      const start = isoAt(FAKE_NOW_MS - 300_000);
      const h = makeCtx({}, { initialCursor: start, backfillFrom: start });
      await collect(h.ctx as never);
      assertEquals(api.startTimes[0], start);
      assertEquals(h.emitted.map((a) => a.id.uniqueQualifier), ["new"]);
    });
  } finally {
    api.restore();
  }
});

Deno.test("NAN-3697 gws: an empty first run pins its start as the cursor", async () => {
  const api = stubApi({ admin: [] });
  try {
    await atFakeNow(async () => {
      const start = isoAt(FAKE_NOW_MS - 300_000);
      const h = makeCtx({}, { initialCursor: start });
      await collect(h.ctx as never);
      assertEquals(h.checkpoints.map((c) => JSON.parse(c).t), [start]);
    });
  } finally {
    api.restore();
  }
});

Deno.test("NAN-3697 gws: no initialCursor (old host) still starts at now - 300 s, not 24 h back", async () => {
  const api = stubApi({ admin: [] });
  try {
    await atFakeNow(async () => {
      const h = makeCtx({}, {});
      await collect(h.ctx as never);
      assertEquals(api.startTimes[0], isoAt(FAKE_NOW_MS - 300_000));
    });
  } finally {
    api.restore();
  }
});

Deno.test("NAN-3697 gws: initialCursor wins over a far-past backfillFrom; a lone far-past alias is clamped", async () => {
  const api = stubApi({ admin: [] });
  try {
    await atFakeNow(async () => {
      const farPast = isoAt(FAKE_NOW_MS - 180 * 86400_000);
      await collect(makeCtx({}, { initialCursor: isoAt(FAKE_NOW_MS - 300_000), backfillFrom: farPast }).ctx as never);
      await collect(makeCtx({}, { backfillFrom: farPast }).ctx as never);
      assertEquals(api.startTimes, [isoAt(FAKE_NOW_MS - 300_000), isoAt(FAKE_NOW_MS - 300_000)]);
    });
  } finally {
    api.restore();
  }
});

Deno.test("NAN-3697 gws: an existing cursor is resumed, never reset to a later initialCursor", async () => {
  const older = isoAt(FAKE_NOW_MS - 10 * 86400_000);
  const api = stubApi({ admin: [activity(isoAt(FAKE_NOW_MS - 5 * 86400_000), "backlog")] });
  try {
    await atFakeNow(async () => {
      const cursors: Record<string, string | undefined> = { admin: JSON.stringify({ t: older, seen: [] }) };
      const h = makeCtx(cursors, { initialCursor: isoAt(FAKE_NOW_MS - 300_000) });
      await collect(h.ctx as never);
      assertEquals(api.startTimes[0], older);
      assertEquals(h.emitted.map((a) => a.id.uniqueQualifier), ["backlog"]);
      assertEquals(JSON.parse(cursors.admin as string).t, isoAt(FAKE_NOW_MS - 5 * 86400_000));
    });
  } finally {
    api.restore();
  }
});

Deno.test("NAN-3697 gws: per-stream initialCursors wins over initialCursor", async () => {
  // The admin stream was enabled two minutes ago; initialCursor is the earliest
  // start across streams (an hour ago). The admin stream must not reach back to it.
  const api = stubApi({
    admin: [activity(isoAt(FAKE_NOW_MS - 30 * 60_000), "before-own-start"), activity(isoAt(FAKE_NOW_MS - 60_000), "new")],
  });
  try {
    await atFakeNow(async () => {
      const own = isoAt(FAKE_NOW_MS - 120_000);
      const earliest = isoAt(FAKE_NOW_MS - 3_600_000);
      const h = makeCtx({}, { initialCursors: { admin: own, login: earliest }, initialCursor: earliest, backfillFrom: earliest });
      await collect(h.ctx as never);
      assertEquals(api.startTimes[0], own);
      assertEquals(h.emitted.map((a) => a.id.uniqueQualifier), ["new"]);
    });
  } finally {
    api.restore();
  }
});
