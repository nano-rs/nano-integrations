// Mock Netskope REST API v2 Data Export iterator (NAN-3490). SYNTHETIC DATA.
//
// Models what makes the iterator easy to get wrong: the read position lives
// HERE, per `index` query parameter, and it ADVANCES WHEN A PAGE IS SERVED.
//
//   GET /api/v2/events/dataexport/events/<type>?index=<name>&operation=<op>
//     operation=<epoch secs>  open (or re-open) the index at the first event
//                             whose `timestamp` >= epoch, and serve a page
//     operation=next          serve the page after the last one served
//     operation=resend        re-serve the last page without advancing;
//                             answers ok:0 on an index that never opened
//   Responses: {"ok":1,"result":[...],"wait_time":0}; an empty `result` means
//   the consumer has caught up. `Netskope-Api-Token` must match `token`.
//
// Fault modes, switchable at runtime through POST /__mock/mode:
//   {"fail_after_serve":N}   the next N non-empty `next` pages advance the
//                            index and then answer 502 (a served page lost in
//                            transit: only `resend` gets it back)
//   {"append":{"alert":N}}   publish N more events of a type now
// GET /__mock/stats returns the request log and the unopened-resend count.
//
// Standalone:  deno run --allow-net --allow-env testing/netskope-mock/mock.ts
//   env: PORT (8090), MOCK_TOKEN (mock-token), MOCK_COUNTS ("alert=230,application=140"),
//        MOCK_PAGE (100)

export interface NetskopeMockOptions {
  token?: string;
  /** Events per type, e.g. {alert: 230, application: 140}. */
  counts?: Record<string, number>;
  /** Epoch seconds of the first event of each type; one event per second. */
  t0?: number;
  page?: number;
}

export function netskopeEvent(type: string, i: number, ts: number): Record<string, unknown> {
  return {
    _id: (type.length * 2 ** 40 + i).toString(16).padStart(24, "0"),
    record_type: type,
    timestamp: ts,
    user: `user${i % 13}@corp.example`,
    srcip: `203.0.113.${(i % 250) + 1}`,
    app: "Box",
    activity: i % 3 === 0 ? "Upload" : "Download",
    action: "allow",
  };
}

const PREFIX = "/api/v2/events/dataexport/events/";

export class MockNetskope {
  readonly token: string;
  readonly page: number;
  private events = new Map<string, Record<string, unknown>[]>();
  /** index -> [position after the last served page, start of that page] */
  private iters = new Map<string, [number, number]>();
  private t0: number;
  failAfterServe = 0;
  unopenedResends = 0;
  log: string[] = [];

  constructor(opts: NetskopeMockOptions = {}) {
    this.token = opts.token ?? "mock-token";
    this.page = opts.page ?? 100;
    this.t0 = opts.t0 ?? Math.floor(Date.now() / 1000) - 3600;
    for (const [type, n] of Object.entries(opts.counts ?? { alert: 230, application: 140 })) this.append(type, n);
  }

  append(type: string, n: number): void {
    const list = this.events.get(type) ?? [];
    for (let k = 0; k < n; k++) list.push(netskopeEvent(type, list.length, this.t0 + list.length));
    this.events.set(type, list);
  }

  handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/__mock/mode" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (typeof body.fail_after_serve === "number") this.failAfterServe = body.fail_after_serve;
      for (const [type, n] of Object.entries(body.append ?? {})) this.append(type, Number(n));
      return json({ ok: 1 });
    }
    if (url.pathname === "/__mock/stats") return json({ log: this.log, unopened_resends: this.unopenedResends });
    if (req.headers.get("netskope-api-token") !== this.token) return json({ ok: 0, message: "Unauthorized" }, 401);
    if (!url.pathname.startsWith(PREFIX)) return json({ ok: 0, message: "not found" }, 404);
    const all = this.events.get(url.pathname.slice(PREFIX.length));
    if (!all) return json({ ok: 0, message: "unknown event type" }, 400);
    const index = url.searchParams.get("index") ?? "";
    const op = url.searchParams.get("operation") ?? "";
    this.log.push(`${index} ${op}`);
    let start: number;
    const it = this.iters.get(index);
    if (op === "next") {
      if (!it) return json({ ok: 0, message: "iterator not initialized" });
      start = it[0];
    } else if (op === "resend") {
      if (!it) {
        this.unopenedResends++;
        return json({ ok: 0, message: "resend on an iterator that was never opened" });
      }
      start = it[1];
    } else if (/^\d+$/.test(op)) {
      const epoch = Number(op);
      start = all.findIndex((e) => (e.timestamp as number) >= epoch);
      if (start < 0) start = all.length;
    } else {
      return json({ ok: 0, message: "bad operation" }, 400);
    }
    const page = all.slice(start, start + this.page);
    this.iters.set(index, [start + page.length, start]);
    if (op === "next" && page.length > 0 && this.failAfterServe > 0) {
      this.failAfterServe--;
      return json({ message: "bad gateway" }, 502);
    }
    return json({ ok: 1, result: page, wait_time: 0 });
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

if (import.meta.main) {
  const counts = Object.fromEntries(
    (Deno.env.get("MOCK_COUNTS") ?? "alert=230,application=140").split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k.trim(), Number(v)];
    }),
  );
  const mock = new MockNetskope({ token: Deno.env.get("MOCK_TOKEN"), counts, page: Number(Deno.env.get("MOCK_PAGE") ?? "100") });
  const port = Number(Deno.env.get("PORT") ?? "8090");
  Deno.serve({ port, hostname: "127.0.0.1" }, mock.handle);
}
