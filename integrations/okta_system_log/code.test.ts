// NAN-3483: Okta System Log collector.
//
// Drives the runtime-agnostic core (`pullSystemLog`) and the nano adapter
// (`collect`) against testing/okta-mock, which models Okta's polling
// semantics (an always-present rel="next" on polling queries), its 429 and
// rate-limit headers, and its 401 body. Time is virtual: `sleep` advances the
// clock the mock also reads, so back-off is asserted exactly and runs fast.
//
//   deno test integrations/okta_system_log/code.test.ts

import { assert, assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import {
  collect,
  type Cursor,
  nextAfter,
  OktaApiError,
  type OktaLogEvent,
  parseCursor,
  type PullDeps,
  pullSystemLog,
  rateLimitWaitMs,
} from "./code.ts";
import { MockOkta } from "../../testing/okta-mock/mock.ts";

const BASE = "https://acme.okta.com";
const TOKEN = "mock-token";

class Clock {
  t = Date.parse("2026-10-10T12:00:00.000Z");
  sleeps: number[] = [];
  now = () => this.t;
  sleep = (ms: number) => {
    this.sleeps.push(ms);
    this.t += ms;
    return Promise.resolve();
  };
}

interface Harness {
  deps: PullDeps;
  emitted: OktaLogEvent[];
  checkpoints: string[];
  order: string[];
  logs: string[];
  stopAfterEmits?: number;
}

function harness(mock: MockOkta, clock: Clock, opts: { stopAfterEmits?: number; failCheckpointAt?: number } = {}): Harness {
  const h: Harness = { emitted: [], checkpoints: [], order: [], logs: [], deps: undefined as unknown as PullDeps };
  let emits = 0;
  h.deps = {
    fetch: (url, init) => {
      const u = new URL(url);
      assertEquals(u.origin, BASE, "collector must only call the configured org");
      return Promise.resolve(mock.handle(new Request(url, { headers: init.headers })));
    },
    sleep: clock.sleep,
    now: clock.now,
    shouldStop: () => opts.stopAfterEmits !== undefined && emits >= opts.stopAfterEmits,
    emit: (events) => {
      emits++;
      h.emitted.push(...events);
      h.order.push(`emit:${events.length}`);
      return Promise.resolve();
    },
    checkpoint: (cursor) => {
      if (opts.failCheckpointAt !== undefined && h.checkpoints.length === opts.failCheckpointAt) {
        return Promise.reject(new Error("simulated crash between emit and checkpoint"));
      }
      h.checkpoints.push(cursor);
      h.order.push("checkpoint");
      return Promise.resolve();
    },
    log: (msg) => {
      h.logs.push(msg);
    },
  };
  return h;
}

function uuids(events: OktaLogEvent[]): string[] {
  return events.map((e) => String(e.uuid));
}

function lastCursor(h: Harness): string | undefined {
  return h.checkpoints[h.checkpoints.length - 1];
}

/** The window the mock's initial history sits in. */
function historyStart(clock: Clock, n: number): string {
  return new Date(clock.t - n - 1000).toISOString();
}

Deno.test("pages through a backlog with Link rel=next and emits every event once", async () => {
  const clock = new Clock();
  const mock = new MockOkta({ events: 2500, now: clock.now, origin: BASE });
  const h = harness(mock, clock);

  const r = await pullSystemLog({ baseUrl: BASE, token: TOKEN, startFrom: historyStart(clock, 2500) }, undefined, h.deps);

  assertEquals(r.events, 2500);
  assertEquals(new Set(uuids(h.emitted)).size, 2500, "no duplicates");
  assert(r.drained, "an empty polling page means caught up");
  // 1000 + 1000 + 500 + one empty page that confirms the drain.
  assertEquals(mock.served.filter((s) => s.path === "/api/v1/logs").map((s) => s.count), [1000, 1000, 500, 0]);
  // Every emit is followed by its checkpoint, never preceded.
  assertEquals(h.order, ["emit:1000", "checkpoint", "emit:1000", "checkpoint", "emit:500", "checkpoint"]);
  // Requests carry the SSWS scheme and ascending order.
  const first = mock.served[0].query;
  assertEquals(first.sortOrder, "ASCENDING");
  assertEquals(first.limit, "1000");
});

Deno.test("cursor survives a restart: no duplicates, no gaps (count by uuid)", async () => {
  const clock = new Clock();
  const mock = new MockOkta({ events: 2500, now: clock.now, origin: BASE });
  const start = historyStart(clock, 2500);

  // Run 1 is stopped by the platform after two pages (run budget / pod restart).
  const run1 = harness(mock, clock, { stopAfterEmits: 2 });
  const r1 = await pullSystemLog({ baseUrl: BASE, token: TOKEN, startFrom: start }, undefined, run1.deps);
  assertEquals(r1.events, 2000);
  assert(!r1.drained);

  // Events keep arriving while nothing is polling, including several sharing
  // one timestamp (the case that breaks timestamp-watermark pollers).
  clock.t += 60_000;
  mock.append(700);
  mock.appendSameInstant(5);

  // Run 2 is a fresh process: only the persisted cursor carries over.
  const run2 = harness(mock, clock);
  const r2 = await pullSystemLog({ baseUrl: BASE, token: TOKEN, startFrom: "1970-01-01T00:00:00.000Z" }, lastCursor(run1), run2.deps);
  assert(r2.drained);

  const all = [...uuids(run1.emitted), ...uuids(run2.emitted)];
  assertEquals(all.length, mock.eventCount, "every published event delivered exactly once");
  assertEquals(new Set(all).size, mock.eventCount, "no duplicates across the restart");
  // Gap check: the delivered set is exactly the published set.
  const published = new Set(Array.from({ length: mock.eventCount }, (_, i) => i));
  for (const u of all) published.delete(parseInt(u.slice(-12), 16));
  assertEquals(published.size, 0, "no gaps");

  // A third run with nothing new emits nothing and does not move the cursor.
  const run3 = harness(mock, clock);
  const r3 = await pullSystemLog({ baseUrl: BASE, token: TOKEN, startFrom: start }, lastCursor(run2), run3.deps);
  assertEquals(r3.events, 0);
  assertEquals(run3.checkpoints, []);
});

Deno.test("a crash between emit and checkpoint re-delivers that page only (at-least-once)", async () => {
  const clock = new Clock();
  const mock = new MockOkta({ events: 2500, now: clock.now, origin: BASE });
  const start = historyStart(clock, 2500);

  const run1 = harness(mock, clock, { failCheckpointAt: 1 }); // second checkpoint fails
  await assertRejects(() => pullSystemLog({ baseUrl: BASE, token: TOKEN, startFrom: start }, undefined, run1.deps));
  assertEquals(run1.emitted.length, 2000);

  const run2 = harness(mock, clock);
  await pullSystemLog({ baseUrl: BASE, token: TOKEN, startFrom: start }, lastCursor(run1), run2.deps);
  const all = [...uuids(run1.emitted), ...uuids(run2.emitted)];
  assertEquals(new Set(all).size, 2500, "no gaps");
  assertEquals(all.length, 3500, "exactly the un-checkpointed page is repeated");
});

Deno.test("429 waits until X-Rate-Limit-Reset, then resumes without loss", async () => {
  const clock = new Clock();
  const mock = new MockOkta({ events: 1500, now: clock.now, origin: BASE, resetSecs: 7 });
  mock.setMode("429", 2);
  const h = harness(mock, clock);

  const r = await pullSystemLog({ baseUrl: BASE, token: TOKEN, startFrom: historyStart(clock, 1500) }, undefined, h.deps);

  assertEquals(r.events, 1500);
  assertEquals(mock.served.filter((s) => s.status === 429).length, 2);
  // Each wait lasts until the advertised reset (+1s skew margin), not a fixed guess.
  const waited = h.deps.now() - Date.parse("2026-10-10T12:00:00.000Z");
  assert(waited >= 2 * 7_000, `waited ${waited}ms, expected >= 14000ms`);
  const retryGap = mock.served[1].at - mock.served[0].at;
  assert(retryGap >= 7_000, `retried after ${retryGap}ms, before the reset`);
  assertEquals(h.logs.filter((l) => l.includes("rate limited")).length, 2);
});

Deno.test("persistent 429 fails the run with a visible error and keeps the cursor", async () => {
  const clock = new Clock();
  const mock = new MockOkta({ events: 10, now: clock.now, origin: BASE, resetSecs: 1 });
  mock.setMode("429", 100);
  const h = harness(mock, clock);
  const err = await assertRejects(
    () => pullSystemLog({ baseUrl: BASE, token: TOKEN, startFrom: historyStart(clock, 10), maxRateLimited: 3 }, undefined, h.deps),
    OktaApiError,
  );
  assertEquals(err.status, 429);
  assertStringIncludes(err.message, "rate limit");
  assertEquals(h.checkpoints, []);
});

Deno.test("low X-Rate-Limit-Remaining pauses before the quota runs out", async () => {
  const clock = new Clock();
  const mock = new MockOkta({ events: 2500, now: clock.now, origin: BASE, resetSecs: 30 });
  const h = harness(mock, clock);
  await pullSystemLog(
    { baseUrl: BASE, token: TOKEN, startFrom: historyStart(clock, 2500), remainingFloor: 100 },
    undefined,
    h.deps,
  );
  assert(h.logs.some((l) => l.includes("headroom low")));
  assert(h.deps.now() - Date.parse("2026-10-10T12:00:00.000Z") >= 30_000);
});

Deno.test("401 surfaces Okta's error code, never the token, and checkpoints nothing", async () => {
  const clock = new Clock();
  const mock = new MockOkta({ events: 10, now: clock.now, origin: BASE });
  mock.setMode("401");
  const h = harness(mock, clock);
  const err = await assertRejects(
    () => pullSystemLog({ baseUrl: BASE, token: TOKEN, startFrom: historyStart(clock, 10) }, undefined, h.deps),
    OktaApiError,
  );
  assertEquals(err.status, 401);
  assertEquals(err.errorCode, "E0000011");
  assertStringIncludes(err.message, "Invalid token provided");
  assert(!err.message.includes(TOKEN));
  assertEquals(h.emitted, []);
  assertEquals(h.checkpoints, []);
  assertEquals(mock.served.length, 1, "auth failures are not retried");
});

Deno.test("a wrong token is a 401 too (the mock checks SSWS like Okta)", async () => {
  const clock = new Clock();
  const mock = new MockOkta({ events: 10, now: clock.now, origin: BASE });
  const h = harness(mock, clock);
  const err = await assertRejects(
    () => pullSystemLog({ baseUrl: BASE, token: "wrong", startFrom: historyStart(clock, 10) }, undefined, h.deps),
    OktaApiError,
  );
  assertEquals(err.status, 401);
});

Deno.test("5xx is retried with back-off, then fails loudly", async () => {
  const clock = new Clock();
  let calls = 0;
  const h = harness(new MockOkta({ now: clock.now, origin: BASE }), clock);
  h.deps.fetch = () => {
    calls++;
    return Promise.resolve(new Response("upstream", { status: 503 }));
  };
  const err = await assertRejects(
    () => pullSystemLog({ baseUrl: BASE, token: TOKEN, startFrom: new Date(clock.t).toISOString(), maxServerErrors: 2 }, undefined, h.deps),
    OktaApiError,
  );
  assertEquals(err.status, 503);
  assertEquals(calls, 3);
});

Deno.test("a rel=next link to another host is refused (token never leaves the org)", () => {
  assertEquals(nextAfter(`<${BASE}/api/v1/logs?since=x&after=abc>; rel="next"`, BASE), "abc");
  assertEquals(nextAfter(`<${BASE}/api/v1/logs?after=abc>; rel="self"`, BASE), undefined);
  let threw = false;
  try {
    nextAfter(`<https://evil.example/api/v1/logs?after=abc>; rel="next"`, BASE);
  } catch (e) {
    threw = e instanceof OktaApiError;
  }
  assert(threw);
});

Deno.test("fallback without a next link resumes inclusively and drops boundary repeats", async () => {
  const clock = new Clock();
  const t = "2026-10-10T11:00:00.000Z";
  const ev = (n: number, published: string) => ({ uuid: `u${n}`, published, eventType: "user.session.start" });
  const pages: OktaLogEvent[][] = [[ev(1, "2026-10-10T10:59:59.000Z"), ev(2, t), ev(3, t)], [ev(2, t), ev(3, t), ev(4, t)]];
  let call = 0;
  const h = harness(new MockOkta({ now: clock.now, origin: BASE }), clock);
  h.deps.fetch = () => Promise.resolve(new Response(JSON.stringify(pages[call++] ?? []), { status: 200 }));

  await pullSystemLog({ baseUrl: BASE, token: TOKEN, startFrom: "2026-10-10T10:00:00.000Z" }, undefined, h.deps);
  const c1 = JSON.parse(lastCursor(h)!) as Cursor;
  assertEquals(c1.since, t);
  assertEquals(c1.seen, ["u2", "u3"]);

  await pullSystemLog({ baseUrl: BASE, token: TOKEN, startFrom: "x" }, lastCursor(h), h.deps);
  assertEquals(uuids(h.emitted), ["u1", "u2", "u3", "u4"]);
});

Deno.test("an unreadable cursor restarts from the configured start, not from nowhere", () => {
  assertEquals(parseCursor("garbage", "2026-01-01T00:00:00Z"), { v: 1, since: "2026-01-01T00:00:00Z" });
  assertEquals(parseCursor('{"v":1,"since":"2026-02-02T00:00:00Z","after":"9"}', "x"), {
    v: 1,
    since: "2026-02-02T00:00:00Z",
    after: "9",
  });
});

Deno.test("rateLimitWaitMs reads epoch-second resets and Retry-After", () => {
  const now = 1_000_000_000_000;
  assertEquals(rateLimitWaitMs(new Headers({ "x-rate-limit-reset": String(now / 1000 + 5) }), now), 6_000);
  assertEquals(rateLimitWaitMs(new Headers({ "retry-after": "3" }), now), 3_000);
  assertEquals(rateLimitWaitMs(new Headers(), now), 60_000);
});

Deno.test("collect(): nano adapter wires stream, SSWS header, cursor and backfill", async () => {
  const clock = new Clock();
  clock.t = Date.now();
  const mock = new MockOkta({ events: 1200, now: () => Date.now(), origin: BASE });
  const original = globalThis.fetch;
  const seenAuth: string[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(String(input), init);
    seenAuth.push(req.headers.get("authorization") ?? "");
    return Promise.resolve(mock.handle(req));
  }) as typeof fetch;
  try {
    const emitted: Array<[string, number]> = [];
    const cursors: Record<string, string | undefined> = {};
    await collect({
      cursors,
      credentials: { API_TOKEN: ` ${TOKEN} ` },
      config: { OKTA_DOMAIN: "https://ACME.okta.com/" },
      streams: ["system_log"],
      backfillFrom: new Date(Date.now() - 3_600_000).toISOString(),
      emit: (s, events) => {
        emitted.push([s, events.length]);
        return Promise.resolve();
      },
      checkpoint: (s, c) => {
        cursors[s] = c;
        return Promise.resolve();
      },
      shouldStop: () => false,
      log: () => {},
    });
    assertEquals(emitted, [["system_log", 1000], ["system_log", 200]]);
    assert(seenAuth.every((a) => a === `SSWS ${TOKEN}`));
    assert(JSON.parse(cursors.system_log!).after);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("collect(): a 401 throws so the run is recorded as failed", async () => {
  const mock = new MockOkta({ events: 5, origin: BASE });
  mock.setMode("401");
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(mock.handle(new Request(String(input), init)))) as typeof fetch;
  try {
    await assertRejects(
      () =>
        collect({
          cursors: {},
          credentials: { API_TOKEN: TOKEN },
          config: { OKTA_DOMAIN: "acme.okta.com" },
          streams: ["system_log"],
          emit: () => Promise.resolve(),
          checkpoint: () => Promise.resolve(),
          shouldStop: () => false,
          log: () => {},
        }),
      OktaApiError,
      "E0000011",
    );
  } finally {
    globalThis.fetch = original;
  }
});

const netGranted = (await Deno.permissions.query({ name: "net", host: "127.0.0.1" })).state === "granted";

Deno.test({
  name: "over real HTTP: the mock server, real fetch, 429 then drain (run with --allow-net)",
  ignore: !netGranted,
  async fn() {
    const mock = new MockOkta({ events: 2100, resetSecs: 1 });
    const server = mock.serve(0);
    const port = (server.addr as Deno.NetAddr).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      mock.setMode("429", 1);
      const emitted: OktaLogEvent[] = [];
      let cursor: string | undefined;
      const r = await pullSystemLog(
        { baseUrl: base, token: TOKEN, startFrom: new Date(Date.now() - 3_600_000).toISOString() },
        undefined,
        {
          fetch: (url, init) => fetch(url, init),
          sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
          now: () => Date.now(),
          shouldStop: () => false,
          emit: (events) => {
            emitted.push(...events);
            return Promise.resolve();
          },
          checkpoint: (c) => {
            cursor = c;
            return Promise.resolve();
          },
          log: () => {},
        },
      );
      assertEquals(r.events, 2100);
      assertEquals(new Set(uuids(emitted)).size, 2100);
      assert(cursor && JSON.parse(cursor).after === "2100");
    } finally {
      await server.shutdown();
    }
  },
});
