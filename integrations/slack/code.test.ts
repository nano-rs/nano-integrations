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
import { collect } from "./code.ts";

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

function makeCtx(cursors: Record<string, string | undefined>) {
  const emitted: SlackLogin[] = [];
  return {
    emitted,
    ctx: {
      cursors,
      credentials: { TOKEN: "xoxp-test" },
      config: {},
      streams: ["access_logs"],
      emit: (_s: string, events: unknown[]) => {
        emitted.push(...(events as SlackLogin[]));
        return Promise.resolve();
      },
      checkpoint: (s: string, cursor: string) => {
        cursors[s] = cursor;
        return Promise.resolve();
      },
      shouldStop: () => false,
      log: () => {},
    },
  };
}

const NOW = Math.floor(Date.now() / 1000);

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

/**
 * NAN-2280: slack was the one collector that never attributed a failure to its
 * stream — it threw straight out of `collect`, so the host had no structured
 * log to recover the name from and the per-stream `last_error` stayed NULL.
 *
 * Asserts the runtime behaviour, not just that the string is present in the
 * file: the log must carry the stream name AND the failure must still propagate.
 * Swallowing it would turn a broken stream into a silently successful run,
 * which is worse than the bug being fixed.
 */
Deno.test("a slack failure names its stream and still fails the run", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (): Promise<Response> =>
    Promise.resolve(
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

  const logged: Array<{ msg: string; fields?: Record<string, unknown> }> = [];
  const ctx = {
    cursors: {},
    credentials: { TOKEN: "xoxp-test" },
    config: {},
    streams: ["access_logs"],
    emit: () => Promise.resolve(),
    checkpoint: () => Promise.resolve(),
    shouldStop: () => false,
    log: (msg: string, fields?: Record<string, unknown>) => logged.push({ msg, fields }),
  };

  try {
    let threw = false;
    try {
      await collect(ctx as never);
    } catch {
      threw = true;
    }
    assertEquals(threw, true, "the failure must still propagate");

    const failure = logged.find((l) => l.msg === "Stream failed");
    assertEquals(failure !== undefined, true, "must log the host-parsed message");
    assertEquals(failure?.fields?.stream, "access_logs", "must name the stream");
    assertEquals(
      typeof failure?.fields?.error === "string" && (failure.fields.error as string).length > 0,
      true,
      "must carry a non-empty error",
    );
  } finally {
    globalThis.fetch = original;
  }
});
