// Public Okta mock (NAN-3490 item 4). The unit tests need only Deno; the
// connector run needs NANO_CONNECTOR_BIN (skipped without it, unless
// NANO_SHADOW_REQUIRED=1).
//
//   deno test --allow-read --allow-write --allow-net=127.0.0.1 --allow-run --allow-env \
//     testing/okta-mock-public/worker.test.ts

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { eventUuid, makeEvent } from "../okta-mock/mock.ts";
import {
  type ConnectorRun,
  runConnector,
  serveMock,
  shadowIgnored,
} from "../shadow/lib.ts";
import {
  catalogConfig,
  checkHost,
  MOCK_CONNECTOR,
  mockSpec,
  sha256Hex,
} from "./catalog.ts";
import { config, handler, type MockEnv, Stream } from "./worker.ts";

const TOKEN = "test-token-0123456789";
const EPOCH = Date.parse("2026-10-01T00:00:00Z");
const BASE = "https://okta-mock.example.net";

function get(
  h: (r: Request) => Response,
  path: string,
  token: string | null = TOKEN,
): Response {
  return h(
    new Request(`${BASE}${path}`, {
      headers: token === null ? {} : { authorization: `SSWS ${token}` },
    }),
  );
}

function nextLink(r: Response): string | undefined {
  const m = (r.headers.get("link") ?? "").match(/<([^>]+)>; rel="next"/);
  return m?.[1];
}

/** Walk Link rel=next from `path`; returns the uuids served and the request count. */
async function walk(
  h: (r: Request) => Response,
  path: string,
): Promise<{ uuids: string[]; pages: number }> {
  const uuids: string[] = [];
  let url: string | undefined = `${BASE}${path}`;
  let pages = 0;
  while (url) {
    const r = h(
      new Request(url, { headers: { authorization: `SSWS ${TOKEN}` } }),
    );
    assertEquals(r.status, 200);
    const body = await r.json() as { uuid: string }[];
    uuids.push(...body.map((e) => e.uuid));
    pages++;
    url = nextLink(r);
    assert(pages < 1000, "runaway paging");
  }
  return { uuids, pages };
}

const env = (over: Partial<MockEnv> = {}): MockEnv => ({
  MOCK_TOKEN: TOKEN,
  EPOCH: String(EPOCH),
  ...over,
});
const iso = (ms: number) => new Date(ms).toISOString();

Deno.test("refuses to serve without a real token", async () => {
  for (const t of [undefined, "", "short"]) {
    const h = handler({ MOCK_TOKEN: t });
    assertEquals(get(h, "/__mock/health", null).status, 503);
    const r = get(h, "/api/v1/logs", t ?? "");
    assertEquals(r.status, 503);
    await r.body?.cancel();
  }
  assertThrows(() =>
    config({
      MOCK_TOKEN: TOKEN,
      FAULT_429_EVERY_SECS: "10",
      FAULT_429_SECS: "9",
    })
  );
  assertEquals(
    handler(env({ EVENTS_PER_MIN: "0" }))(new Request(`${BASE}/__mock/health`))
      .status,
    503,
  );
});

Deno.test("wrong or missing SSWS token answers Okta's 401", async () => {
  const h = handler(env(), () => EPOCH + 60_000);
  for (const t of [null, "wrong-token-0123456789", TOKEN + "x"]) {
    const r = get(h, "/api/v1/logs", t);
    assertEquals(r.status, 401);
    assertEquals((await r.json()).errorCode, "E0000011");
  }
  assertEquals(get(h, "/__mock/health", null).status, 200);
});

Deno.test("bounded window: Link paging until exhausted, exactly the expected events", async () => {
  const now = EPOCH + 3600_000;
  const h = handler(env({ PAGE_MAX: "50" }), () => now);
  const since = iso(EPOCH + 600_000), until = iso(EPOCH + 1200_000);
  const { uuids, pages } = await walk(
    h,
    `/api/v1/logs?since=${since}&until=${until}&limit=1000&sortOrder=ASCENDING`,
  );
  assertEquals(uuids.length, 600);
  assertEquals(pages, 12);
  assertEquals(
    uuids,
    Array.from({ length: 600 }, (_, i) => eventUuid(600 + i)),
  );
  const exp = await get(h, `/__mock/expected?since=${since}&until=${until}`)
    .json();
  assertEquals([exp.count, exp.first_uuid, exp.last_uuid, exp.final], [
    600,
    uuids[0],
    uuids.at(-1),
    true,
  ]);
});

Deno.test("events are MockOkta's, deterministic across isolates", async () => {
  const now = EPOCH + 120_000;
  const a = await get(
    handler(env(), () => now),
    `/api/v1/logs?since=${iso(EPOCH)}&until=${iso(EPOCH + 5_000)}`,
  ).json();
  const b = await get(
    handler(env(), () => now + 999),
    `/api/v1/logs?since=${iso(EPOCH)}&until=${iso(EPOCH + 5_000)}`,
  ).json();
  assertEquals(a, b);
  assertEquals(a, [0, 1, 2, 3, 4].map((s) => makeEvent(s, EPOCH + s * 1000)));
});

Deno.test("polling (no until) always links next and picks up later events", async () => {
  let now = EPOCH + 10_500;
  const h = handler(env(), () => now);
  const r1 = get(h, `/api/v1/logs?since=${iso(EPOCH)}&limit=1000`);
  assertEquals((await r1.json()).length, 11);
  const next = nextLink(r1)!;
  assert(next.includes("after=11"));
  const r2 = h(
    new Request(next, { headers: { authorization: `SSWS ${TOKEN}` } }),
  );
  assertEquals(await r2.json(), []);
  assert(nextLink(r2), "an empty polling page still links next");
  now += 3_000;
  const r3 = h(
    new Request(next, { headers: { authorization: `SSWS ${TOKEN}` } }),
  );
  assertEquals(
    (await r3.json() as { uuid: string }[]).map((e) => e.uuid),
    [11, 12, 13].map(eventUuid),
  );
});

Deno.test("nothing after the clock exists, even in a bounded window", async () => {
  const h = handler(env(), () => EPOCH + 4_000);
  const body = await get(
    h,
    `/api/v1/logs?since=${iso(EPOCH)}&until=${iso(EPOCH + 3600_000)}`,
  ).json();
  assertEquals(body.length, 5);
  const exp = await get(
    h,
    `/__mock/expected?since=${iso(EPOCH)}&until=${iso(EPOCH + 3600_000)}`,
  ).json();
  assertEquals([exp.count, exp.final], [5, false]);
});

Deno.test("late events stay hidden until visible; expected is final only after", async () => {
  let now = EPOCH + 30_500;
  const h = handler(env({ LATE_EVERY: "10", LATE_MS: "60000" }), () => now);
  const q = `/api/v1/logs?since=${iso(EPOCH)}&until=${iso(EPOCH + 30_000)}`;
  const early = (await walk(h, q)).uuids;
  assertEquals(early.length, 27, "seq 9, 19, 29 are late");
  assert(!early.includes(eventUuid(9)));
  assertEquals(
    (await get(
      h,
      `/__mock/expected?since=${iso(EPOCH)}&until=${iso(EPOCH + 30_000)}`,
    ).json()).final,
    false,
  );
  now = EPOCH + 90_000;
  const late = (await walk(h, q)).uuids;
  assertEquals(late, Array.from({ length: 30 }, (_, i) => eventUuid(i)));
  const exp = await get(
    h,
    `/__mock/expected?since=${iso(EPOCH)}&until=${iso(EPOCH + 30_000)}`,
  ).json();
  assertEquals([exp.count, exp.final], [30, true]);
});

Deno.test("429 bursts on a fixed schedule with a reset at the burst's end", async () => {
  const slot = Math.ceil(EPOCH / 1000 / 30) * 30; // a 30 s boundary in seconds
  for (
    const [off, status] of [[0, 429], [1, 429], [2, 200], [29, 200]] as const
  ) {
    const h = handler(
      env({ FAULT_429_EVERY_SECS: "30", FAULT_429_SECS: "2" }),
      () => (slot + off) * 1000 + 250,
    );
    const r = get(
      h,
      `/api/v1/logs?since=${iso(EPOCH)}&until=${iso(EPOCH + 1000)}`,
    );
    assertEquals(r.status, status, `offset ${off}`);
    if (status === 429) {
      assertEquals((await r.json()).errorCode, "E0000047");
      assertEquals(r.headers.get("x-rate-limit-reset"), String(slot + 2));
      assertEquals(r.headers.get("x-rate-limit-remaining"), "0");
    } else await r.body?.cancel();
  }
});

Deno.test("a rate that does not divide a minute still yields a gapless stream", () => {
  const s = new Stream(config(env({ EVENTS_PER_MIN: "7" })));
  for (let seq = 0; seq < 500; seq++) {
    const p = s.publishedMs(seq);
    assertEquals(s.firstAtOrAfter(p), seq);
    assertEquals(s.firstAtOrAfter(p + 1), seq + 1);
    assertEquals(s.publishedBy(p), seq + 1);
  }
  assertEquals(s.range(EPOCH, EPOCH + 60_000), [0, 7]);
});

Deno.test("bad queries answer Okta-shaped 400s; other paths 404", async () => {
  const h = handler(env(), () => EPOCH + 60_000);
  for (
    const q of [
      "since=nope",
      "after=-1",
      "sortOrder=DESCENDING",
      `since=${iso(EPOCH - 400 * 86400_000)}&until=${iso(EPOCH)}`,
    ]
  ) {
    const r = get(h, `/api/v1/logs?${q}`);
    // The last one is a huge window before the epoch: empty, not an error.
    if (q.startsWith("since=2")) {
      assertEquals([r.status, await r.json()], [200, []]);
      continue;
    }
    assertEquals(r.status, 400, q);
    await r.body?.cancel();
  }
  const r = get(h, "/api/v1/users");
  assertEquals(r.status, 404);
  await r.body?.cancel();
  assertEquals(get(h, "/__mock/expected?since=x").status, 400);
});

// --------------------------------------------------------------- catalog copy

const shipped = await Deno.readTextFile(
  new URL("../../integrations/okta_system_log/connector.yaml", import.meta.url),
);

Deno.test("catalog copy differs from the shipped spec only in name and allowlist", async () => {
  const spec = mockSpec(shipped, "Okta-Mock.Example.net");
  const a = shipped.split("\n"), b = spec.split("\n");
  const removed = a.filter((l) => !b.includes(l));
  const added = b.filter((l) => !a.includes(l));
  assertEquals(removed, [
    "name: okta_system_log",
    '  - host: "{{config.OKTA_DOMAIN}}"',
    '    host_suffixes: [".okta.com", ".oktapreview.com", ".okta-emea.com", ".okta-gov.com", ".okta.mil"]',
  ]);
  assertEquals(added.filter((l) => !l.startsWith("#")), [
    `name: ${MOCK_CONNECTOR}`,
    '  - host: "okta-mock.example.net"',
  ]);
  const cfg = await catalogConfig("okta-mock.example.net", shipped);
  assertEquals(cfg.runtime, "connector");
  assertEquals(cfg.connector_spec_sha256, await sha256Hex(cfg.connector_spec));
});

Deno.test("catalog copy refuses hosts that are not one public mock name", () => {
  for (
    const h of [
      "acme.okta.com",
      "x.oktapreview.com",
      "okta.mil",
      "10.0.0.1",
      "localhost",
      "a..b",
      "-a.example.net",
      "",
      "a/b.example.net",
    ]
  ) {
    assertThrows(() => checkHost(h), Error, undefined, h);
  }
  assertEquals(checkHost(" okta-mock.Example.NET "), "okta-mock.example.net");
  assertThrows(
    () =>
      mockSpec(
        shipped.replace("name: okta_system_log\n", "name: okta_v2\n"),
        "m.example.net",
      ),
    Error,
    "spec changed",
  );
});

// ---------------------------------------------------------- connector run

const ignore = shadowIgnored();
const MOCK_HOST = "okta-mock.example.net";

Deno.test({
  name:
    "okta_system_log_mock: the connector ships the mock's stream exactly once",
  ignore,
}, async () => {
  const start = Date.now();
  const mockEnv = env({
    EPOCH: String(start - 3600_000),
    PAGE_MAX: "200",
    // A 1 s burst every 5 s, and the run starts inside one: it must back
    // off and still be complete.
    FAULT_429_EVERY_SECS: "5",
    FAULT_429_SECS: "1",
    MOCK_ORIGIN: `https://${MOCK_HOST}`,
  });
  const inner = handler(mockEnv);
  let throttled = 0;
  const h = (req: Request) => {
    const r = inner(req);
    if (r.status === 429) throttled++;
    return r;
  };
  const dir = await Deno.makeTempDir({ prefix: "okta-mock-public-" });
  const spec = `${dir}/connector.yaml`;
  await Deno.writeTextFile(spec, mockSpec(shipped, MOCK_HOST));
  const backfill = new Date(start - 30 * 60_000).toISOString();
  const opts = {
    config: { OKTA_DOMAIN: MOCK_HOST },
    creds: { API_TOKEN: TOKEN },
    backfillFrom: backfill,
  };
  const uuidsOf = (r: ConnectorRun) =>
    r.batches.flatMap((
      [st, evs],
    ) => (assertEquals(st, "okta"), evs.map((e) => e.uuid as string)));

  await new Promise((r) => setTimeout(r, 5000 - (Date.now() % 5000) + 50));
  const b = serveMock(h);
  let first: ConnectorRun, second: ConnectorRun;
  try {
    first = await runConnector(spec, b, opts);
    second = await runConnector(spec, b, {
      ...opts,
      checkpoints: first.checkpoints,
    });
  } finally {
    await b.close();
  }
  const one = uuidsOf(first), two = uuidsOf(second);
  console.log(
    `okta_system_log_mock: first run ${one.length}, restart ${two.length}, ${throttled} x 429`,
  );
  assert(throttled > 0, "the run met a 429 burst");
  assertEquals(new Set(one).size, one.length, "no duplicates in a run");
  assert(
    two.every((u) => !one.includes(u)),
    "a restart from the checkpoint re-ships nothing",
  );
  assert(
    first.batches.every(([, evs]) =>
      evs.every((e) => e._nano_ingest_id === e.uuid)
    ),
    "vendor uuid is the ingest id",
  );

  // Gapless from the backfill start up to wherever the run's window closed,
  // and it closed no earlier than the spec's lag (30 s) plus slack.
  const s = new Stream(config(mockEnv));
  const from = s.firstAtOrAfter(Date.parse(backfill));
  assertEquals(
    one,
    Array.from({ length: one.length }, (_, i) => eventUuid(from + i)),
  );
  const mustHave = s.firstAtOrAfter(start - 60_000) - from;
  assert(
    one.length >= mustHave,
    `shipped ${one.length}, expected at least ${mustHave}`,
  );
});
