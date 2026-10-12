// NAN-2272 — a companion check, not a fix.
//
// The Google Workspace collector re-delivered its boundary record on every poll
// forever, because the Reports API `startTime` is inclusive and the watermark
// guard could never advance past it. This asks whether Slack shares that shape.
//
// It does not: `team.accessLogs` has no "since" parameter, so this collector
// filters client-side and breaks on `date_last <= watermark` — strictly
// EXCLUDING the boundary record. The header comment in code.ts claims "each run
// re-emits the boundary record at minimum", which is not what the code does;
// these tests pin the real behaviour so a future edit to that comment (or to the
// comparison) has to confront it.
//
// Re-emitting a record whose `date_last` MOVED is intended and separately
// covered below — Slack's records are mutable and later copies supersede.
//
//   deno test integrations/slack/code.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { collect, INITIAL_OVERLAP_MS, initialCursorMs } from "./code.ts";

interface SlackLogin {
  user_id: string;
  ip: string;
  user_agent: string;
  date_first: number;
  date_last: number;
  count: number;
}

function login(userId: string, dateLast: number, count = 1): SlackLogin {
  return {
    user_id: userId,
    ip: "203.0.113.10",
    user_agent: "Mozilla/5.0",
    date_first: dateLast - 60,
    date_last: dateLast,
    count,
  };
}

function stubApi(getLogins: () => SlackLogin[]) {
  const original = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: true, logins: getLogins() }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  return { restore: () => { globalThis.fetch = original; } };
}

const NOW = Math.floor(Date.now() / 1000);

/** The host's initial cursor for the NAN-2272 cases: activation two hours ago. */
const ACTIVATED_2H_AGO = new Date((NOW - 7200) * 1000).toISOString();

function makeCtx(
  cursors: Record<string, string | undefined>,
  start: { initialCursors?: Record<string, string>; initialCursor?: string; backfillFrom?: string } = {
    initialCursor: ACTIVATED_2H_AGO,
  },
) {
  const emitted: SlackLogin[] = [];
  const checkpoints: string[] = [];
  return {
    emitted,
    checkpoints,
    ctx: {
      ...start,
      cursors,
      credentials: { TOKEN: "xoxp-test" },
      config: {},
      streams: ["access_logs"],
      emit: (_s: string, events: unknown[]) => {
        emitted.push(...(events as SlackLogin[]));
        return Promise.resolve();
      },
      checkpoint: (s: string, cursor: string) => {
        checkpoints.push(cursor);
        cursors[s] = cursor;
        return Promise.resolve();
      },
      shouldStop: () => false,
      log: () => {},
    },
  };
}

Deno.test("slack does NOT re-emit an unchanged boundary record", async () => {
  const record = login("U1", NOW - 3600);
  const api = stubApi(() => [record]);
  try {
    const cursors: Record<string, string | undefined> = {};

    let total = 0;
    for (let poll = 0; poll < 3; poll++) {
      const h = makeCtx(cursors);
      await collect(h.ctx as never);
      total += h.emitted.length;
    }

    assertEquals(total, 1, "an unchanged record must ship once across repeated polls");
  } finally {
    api.restore();
  }
});

Deno.test("slack DOES re-emit a record whose date_last moved", async () => {
  let record = login("U1", NOW - 3600, 1);
  const api = stubApi(() => [record]);
  try {
    const cursors: Record<string, string | undefined> = {};

    const run1 = makeCtx(cursors);
    await collect(run1.ctx as never);
    assertEquals(run1.emitted.length, 1);

    // The session is still being added to: same identity, newer date_last.
    // Slack's records are mutable, so this SHOULD ship again — the later copy
    // supersedes on the (user, ip, user_agent) key.
    record = login("U1", NOW - 60, 2);
    const run2 = makeCtx(cursors);
    await collect(run2.ctx as never);
    assertEquals(run2.emitted.length, 1, "a mutated record must re-ship");
    assertEquals(run2.emitted[0].count, 2);
  } finally {
    api.restore();
  }
});

// ---------------------------------------------------------------------------
// NAN-3697: point-forward start. Slack has no "since" parameter, so the start
// is the watermark the walk filters on and the cursor the first run commits.
// The clock is pinned by stubbing Date.now.
// ---------------------------------------------------------------------------

const FAKE_NOW_MS = Date.parse("2026-10-12T15:00:00.000Z");
const FAKE_NOW_S = FAKE_NOW_MS / 1000;
const iso = (s: number) => new Date(s * 1000).toISOString();

async function atFakeNow(fn: () => Promise<void>): Promise<void> {
  const real = Date.now;
  Date.now = () => FAKE_NOW_MS;
  try {
    await fn();
  } finally {
    Date.now = real;
  }
}

/** Old history, one record exactly on the start, and two inside the window. */
function historyAroundStart(): SlackLogin[] {
  return [
    login("U-new", FAKE_NOW_S - 10),
    login("U-mid", FAKE_NOW_S - 299),
    login("U-edge", FAKE_NOW_S - 300),
    login("U-old", FAKE_NOW_S - 301),
    login("U-ancient", FAKE_NOW_S - 90 * 86400),
  ];
}

Deno.test("NAN-3697 initialCursorMs: initialCursor, clamped alias, else now - 300 s", () => {
  const log = () => {};
  assertEquals(INITIAL_OVERLAP_MS, 300_000);
  assertEquals(initialCursorMs({ initialCursor: iso(FAKE_NOW_S - 300), log }, "access_logs", FAKE_NOW_MS), FAKE_NOW_MS - 300_000);
  assertEquals(initialCursorMs({ log }, "access_logs", FAKE_NOW_MS), FAKE_NOW_MS - 300_000);
  assertEquals(initialCursorMs({ initialCursor: "garbage", log }, "access_logs", FAKE_NOW_MS), FAKE_NOW_MS - 300_000);
  // An old host's operator backfill is clamped: never earlier than now - 300 s.
  assertEquals(initialCursorMs({ backfillFrom: iso(FAKE_NOW_S - 30 * 86400), log }, "access_logs", FAKE_NOW_MS), FAKE_NOW_MS - 300_000);
  // initialCursor wins over a far-past alias.
  assertEquals(
    initialCursorMs({ initialCursor: iso(FAKE_NOW_S - 300), backfillFrom: iso(FAKE_NOW_S - 30 * 86400), log }, "access_logs", FAKE_NOW_MS),
    FAKE_NOW_MS - 300_000,
  );
});

Deno.test("NAN-3697 initialCursorMs: initialCursors[stream] wins; other streams' entries and garbage fall back", () => {
  const log = () => {};
  const both = { initialCursors: { access_logs: iso(FAKE_NOW_S - 60) }, initialCursor: iso(FAKE_NOW_S - 3600), log };
  assertEquals(initialCursorMs(both, "access_logs", FAKE_NOW_MS), FAKE_NOW_MS - 60_000);
  // Another stream's entry is not this stream's start.
  assertEquals(initialCursorMs(both, "other", FAKE_NOW_MS), FAKE_NOW_MS - 3_600_000);
  // An unparseable per-stream entry falls back to initialCursor, then the clamped alias.
  assertEquals(
    initialCursorMs({ initialCursors: { access_logs: "garbage" }, initialCursor: iso(FAKE_NOW_S - 3600), log }, "access_logs", FAKE_NOW_MS),
    FAKE_NOW_MS - 3_600_000,
  );
  assertEquals(
    initialCursorMs({ initialCursors: {}, backfillFrom: iso(FAKE_NOW_S - 30 * 86400), log }, "access_logs", FAKE_NOW_MS),
    FAKE_NOW_MS - 300_000,
  );
});

Deno.test("NAN-3697 slack: per-stream initialCursors wins over initialCursor", async () => {
  const api = stubApi(historyAroundStart);
  try {
    await atFakeNow(async () => {
      const h = makeCtx({}, {
        initialCursors: { access_logs: iso(FAKE_NOW_S - 100) },
        initialCursor: iso(FAKE_NOW_S - 300),
        backfillFrom: iso(FAKE_NOW_S - 300),
      });
      await collect(h.ctx as never);
      // U-mid (now - 299) is after initialCursor but before this stream's own start.
      assertEquals(h.emitted.map((l) => l.user_id), ["U-new"]);
      assertEquals(h.checkpoints, [String(FAKE_NOW_S - 10)]);
    });
  } finally {
    api.restore();
  }
});

Deno.test("NAN-3697 slack: no cursor starts exactly at initialCursor (now - 300 s)", async () => {
  const api = stubApi(historyAroundStart);
  try {
    await atFakeNow(async () => {
      const h = makeCtx({}, { initialCursor: iso(FAKE_NOW_S - 300), backfillFrom: iso(FAKE_NOW_S - 300) });
      await collect(h.ctx as never);
      assertEquals(h.emitted.map((l) => l.user_id), ["U-new", "U-mid"]);
      assertEquals(h.checkpoints, [String(FAKE_NOW_S - 10)]);
    });
  } finally {
    api.restore();
  }
});

Deno.test("NAN-3697 slack: an empty first run pins its start as the cursor", async () => {
  const api = stubApi(() => [login("U-old", FAKE_NOW_S - 3600)]);
  try {
    await atFakeNow(async () => {
      const h = makeCtx({}, { initialCursor: iso(FAKE_NOW_S - 300) });
      await collect(h.ctx as never);
      assertEquals(h.emitted.length, 0);
      assertEquals(h.checkpoints, [String(FAKE_NOW_S - 300)]);
    });
  } finally {
    api.restore();
  }
});

Deno.test("NAN-3697 slack: no initialCursor (old host) still starts at now - 300 s", async () => {
  const api = stubApi(historyAroundStart);
  try {
    await atFakeNow(async () => {
      const h = makeCtx({}, {});
      await collect(h.ctx as never);
      assertEquals(h.emitted.map((l) => l.user_id), ["U-new", "U-mid"]);
    });
  } finally {
    api.restore();
  }
});

Deno.test("NAN-3697 slack: initialCursor wins over a far-past backfillFrom", async () => {
  const api = stubApi(historyAroundStart);
  try {
    await atFakeNow(async () => {
      const h = makeCtx({}, { initialCursor: iso(FAKE_NOW_S - 300), backfillFrom: iso(FAKE_NOW_S - 365 * 86400) });
      await collect(h.ctx as never);
      assertEquals(h.emitted.map((l) => l.user_id), ["U-new", "U-mid"]);
    });
  } finally {
    api.restore();
  }
});

Deno.test("NAN-3697 slack: an old host's far-past backfillFrom alone is clamped to now - 300 s", async () => {
  const api = stubApi(historyAroundStart);
  try {
    await atFakeNow(async () => {
      const h = makeCtx({}, { backfillFrom: iso(FAKE_NOW_S - 365 * 86400) });
      await collect(h.ctx as never);
      assertEquals(h.emitted.map((l) => l.user_id), ["U-new", "U-mid"]);
    });
  } finally {
    api.restore();
  }
});

Deno.test("NAN-3697 slack: an existing cursor is resumed, never reset to a later initialCursor", async () => {
  const api = stubApi(historyAroundStart);
  try {
    await atFakeNow(async () => {
      const cursor = String(FAKE_NOW_S - 120 * 86400);
      const h = makeCtx({ access_logs: cursor }, { initialCursor: iso(FAKE_NOW_S - 300) });
      await collect(h.ctx as never);
      // Everything after the stored cursor ships, including what predates the
      // initial cursor.
      assertEquals(h.emitted.map((l) => l.user_id), ["U-new", "U-mid", "U-edge", "U-old", "U-ancient"]);
      assertEquals(h.checkpoints, [String(FAKE_NOW_S - 10)]);
    });
  } finally {
    api.restore();
  }
});
