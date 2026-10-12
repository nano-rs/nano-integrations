// NAN-3697 — every collector starts point-forward.
//
// A brand-new Netskope iterator is opened with `operation=<epoch seconds>`.
// That epoch must be the host's initial cursor (activation − 5 min): never
// epoch 0, which replays the whole retention window, and never an operator
// backfill. An iterator that is already open (cursor "open" / "resend") is
// resumed as-is. The clock is pinned by stubbing Date.now.
//
//   deno test integrations/netskope/code.test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { collect, INITIAL_OVERLAP_MS } from "./code.ts";

const FAKE_NOW_MS = Date.parse("2026-10-12T15:00:00.000Z");
const FAKE_NOW_S = FAKE_NOW_MS / 1000;
const isoAt = (s: number) => new Date(s * 1000).toISOString();

async function run(
  start: { initialCursors?: Record<string, string>; initialCursor?: string; backfillFrom?: string },
  cursors: Record<string, string | undefined> = {},
  streams: string[] = ["alert"],
): Promise<{ operations: string[]; checkpoints: string[] }> {
  const operations: string[] = [];
  const checkpoints: string[] = [];
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  globalThis.fetch = ((input: string | URL | Request) => {
    operations.push(new URL(String(input)).searchParams.get("operation") ?? "");
    // An empty page: caught up, so the stream stops after one request.
    return Promise.resolve(
      new Response(JSON.stringify({ ok: 1, result: [], wait_time: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  Date.now = () => FAKE_NOW_MS;
  try {
    await collect({
      ...start,
      cursors,
      credentials: { API_TOKEN: "ns-token" },
      config: { TENANT_HOST: "acme.goskope.com" },
      streams,
      emit: () => Promise.resolve(),
      checkpoint: (s: string, c: string) => {
        checkpoints.push(c);
        cursors[s] = c;
        return Promise.resolve();
      },
      shouldStop: () => false,
      log: () => {},
    });
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
  }
  return { operations, checkpoints };
}

Deno.test("NAN-3697 netskope: a new iterator opens exactly at initialCursor (now - 300 s)", async () => {
  assertEquals(INITIAL_OVERLAP_MS, 300_000);
  const start = isoAt(FAKE_NOW_S - 300);
  const r = await run({ initialCursor: start, backfillFrom: start });
  assertEquals(r.operations, [String(FAKE_NOW_S - 300)]);
  // The empty first page still commits the open iterator, so the next run
  // walks on instead of re-opening later.
  assertEquals(r.checkpoints, ["open"]);
});

Deno.test("NAN-3697 netskope: no initialCursor (old host) still opens at now - 300 s", async () => {
  const r = await run({});
  assertEquals(r.operations, [String(FAKE_NOW_S - 300)]);
});

Deno.test("NAN-3697 netskope: initialCursor wins over a far-past backfillFrom; a lone far-past alias is clamped", async () => {
  const farPast = isoAt(FAKE_NOW_S - 60 * 86400);
  const a = await run({ initialCursor: isoAt(FAKE_NOW_S - 300), backfillFrom: farPast });
  const b = await run({ backfillFrom: farPast });
  assertEquals(a.operations, [String(FAKE_NOW_S - 300)]);
  assertEquals(b.operations, [String(FAKE_NOW_S - 300)]);
});

Deno.test("NAN-3697 netskope: an open iterator is resumed, never re-opened at a later initialCursor", async () => {
  const open = await run({ initialCursor: isoAt(FAKE_NOW_S - 300) }, { alert: "open" });
  assertEquals(open.operations, ["next"]);
  const resend = await run({ initialCursor: isoAt(FAKE_NOW_S - 300) }, { alert: "resend" });
  assertEquals(resend.operations, ["resend"]);
});

Deno.test("NAN-3697 netskope: per-stream initialCursors wins over initialCursor, per iterator", async () => {
  // `alert` was enabled an hour ago; `page` was enabled two minutes ago. The
  // host's initialCursor is the earliest of the two; `page` must not open there.
  const r = await run(
    {
      initialCursors: { alert: isoAt(FAKE_NOW_S - 3600), page: isoAt(FAKE_NOW_S - 120) },
      initialCursor: isoAt(FAKE_NOW_S - 3600),
      backfillFrom: isoAt(FAKE_NOW_S - 3600),
    },
    {},
    ["alert", "page"],
  );
  assertEquals(r.operations, [String(FAKE_NOW_S - 3600), String(FAKE_NOW_S - 120)]);
  // A stream missing from initialCursors falls back to initialCursor.
  const fallback = await run(
    { initialCursors: { page: isoAt(FAKE_NOW_S - 120) }, initialCursor: isoAt(FAKE_NOW_S - 3600) },
    {},
    ["alert", "page"],
  );
  assertEquals(fallback.operations, [String(FAKE_NOW_S - 3600), String(FAKE_NOW_S - 120)]);
});
