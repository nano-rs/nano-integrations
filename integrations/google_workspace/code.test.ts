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
