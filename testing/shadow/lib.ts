// Shadow-run harness (NAN-3490): run a Deno script and the nano-connector spec
// that replaces it against the SAME vendor mock, and diff what they emit.
//
// Both runtimes reach the mock the same way: every outbound request goes to a
// loopback HTTP server with the vendor host in `x-mock-host`. The Deno side
// patches `fetch` (driver.ts); the connector side runs
// `nano-connector shadow --mock-url`, which applies the spec's host policy
// first and then forwards. Each side gets a fresh mock built from the same
// seed, so a stateful vendor (an iterator, a cursor) starts identical.
//
// The same file lives in nano-integrations and nano-enrichments
// (testing/shadow/lib.ts); keep them in step.
//
// Environment:
//   NANO_CONNECTOR_BIN  path to the nano-connector binary (cargo build -p
//                       nano-connector in nanosiem). Without it the shadow
//                       tests are skipped, unless NANO_SHADOW_REQUIRED=1.
//   NANO_PARSERS_DIR    a parsers checkout on ocsf-1.9. Enables the uid check:
//                       each collector event is parsed twice with its stream's
//                       OCSF parser and must get the same, unique metadata.uid.
//                       Skipped without it, unless NANO_SHADOW_REQUIRED=1.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Handler = (req: Request) => Response | Promise<Response>;

export const connectorBin = Deno.env.get("NANO_CONNECTOR_BIN") ?? "";
export const parsersDir = Deno.env.get("NANO_PARSERS_DIR") ?? "";
export const required = Deno.env.get("NANO_SHADOW_REQUIRED") === "1";

/** Deno.test `ignore` value for the shadow tests, with the reason logged once. */
export function shadowIgnored(): boolean {
  if (connectorBin !== "") return false;
  if (required) throw new Error("NANO_SHADOW_REQUIRED=1 but NANO_CONNECTOR_BIN is not set");
  console.warn("shadow: NANO_CONNECTOR_BIN not set; skipping the Deno-vs-connector diffs");
  return true;
}

export interface MockServer {
  url: string;
  close(): Promise<void>;
}

/** Serve `handler` on an ephemeral loopback port. */
export function serveMock(handler: Handler): MockServer {
  const ac = new AbortController();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} }, (req) => handler(req));
  return {
    url: `http://127.0.0.1:${server.addr.port}`,
    close: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

/** The vendor host a request was meant for. */
export function mockHost(req: Request): string {
  return req.headers.get("x-mock-host") ?? new URL(req.url).host;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const here = new URL(".", import.meta.url);

async function tempFile(name: string, text: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "nano-shadow-" });
  const p = `${dir}/${name}`;
  await Deno.writeTextFile(p, text);
  return p;
}

/** Run a script under driver.ts (the production auth wrapper + entry call). */
export async function runDeno(mock: MockServer, input: Record<string, unknown>): Promise<Record<string, Json>> {
  const inp = await tempFile("input.json", JSON.stringify({ ...input, mock_url: mock.url }));
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "--quiet", "--no-prompt", "--cached-only", "--allow-net=127.0.0.1", "--allow-read", new URL("driver.ts", here).pathname, inp],
    env: { DENO_NO_UPDATE_CHECK: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(out.stdout);
  if (!out.success) throw new Error(`deno driver failed: ${stdout}\n${new TextDecoder().decode(out.stderr)}`);
  const line = stdout.split("\n").reverse().find((l) => l.startsWith("{"));
  if (!line) throw new Error(`no driver output: ${stdout}`);
  const v = JSON.parse(line);
  if (v.error) throw new Error(`deno script error: ${v.error}`);
  return v;
}

export interface ConnectorRun {
  ok: boolean;
  error?: string;
  events: number;
  result?: Json;
  checkpoints: Record<string, Json>;
  missing_ingest_id?: number;
  batches: [string, Record<string, Json>[]][];
}

/** `nano-connector shadow <spec> --mock-url ...`. */
export async function runConnector(
  spec: string,
  mock: MockServer,
  opts: {
    config?: Record<string, string>;
    creds?: Record<string, string>;
    credFiles?: Record<string, string>;
    artifact?: [string, string];
    backfillFrom?: string;
    checkpoints?: Record<string, Json>;
  } = {},
): Promise<ConnectorRun> {
  const args = ["shadow", spec, "--mock-url", mock.url, "--all-batches", "--show", "0"];
  for (const [k, v] of Object.entries(opts.config ?? {})) args.push("--config", `${k}=${v}`);
  for (const [k, v] of Object.entries(opts.creds ?? {})) args.push("--cred", `${k}=${v}`);
  for (const [k, v] of Object.entries(opts.credFiles ?? {})) args.push("--cred-file", `${k}=${await tempFile(k, v)}`);
  if (opts.artifact) args.push("--artifact", opts.artifact[0], "--type", opts.artifact[1]);
  if (opts.backfillFrom) args.push("--backfill-from", opts.backfillFrom);
  if (opts.checkpoints) args.push("--checkpoints", await tempFile("checkpoints.json", JSON.stringify(opts.checkpoints)));
  const out = await new Deno.Command(connectorBin, { args, stdout: "piped", stderr: "piped" }).output();
  const text = new TextDecoder().decode(out.stdout);
  let v: ConnectorRun;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`nano-connector: ${text}\n${new TextDecoder().decode(out.stderr)}`);
  }
  if (!v.ok) throw new Error(`nano-connector run failed: ${v.error}`);
  v.batches ??= [];
  return v;
}

/** Events per source_type from a connector run. */
export function bySourceType(r: ConnectorRun): Map<string, Record<string, Json>[]> {
  const m = new Map<string, Record<string, Json>[]>();
  for (const [st, evs] of r.batches) m.set(st, [...(m.get(st) ?? []), ...evs]);
  return m;
}

/** Deno collector emits per stream id. */
export function denoEmits(v: Record<string, Json>): Map<string, Record<string, Json>[]> {
  const m = new Map<string, Record<string, Json>[]>();
  for (const [stream, evs] of (v.emits ?? []) as [string, Record<string, Json>[]][]) {
    m.set(stream, [...(m.get(stream) ?? []), ...evs]);
  }
  return m;
}

export const INGEST_ID = "_nano_ingest_id";

/** null == absent, key order ignored, chosen keys dropped (recursively). */
function canon(v: Json, ignore: Set<string>): string {
  if (Array.isArray(v)) return `[${v.map((x) => canon(x, ignore)).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v).filter((k) => !ignore.has(k) && v[k] !== null && v[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k], ignore)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export interface Diff {
  label: string;
  deno: number;
  connector: number;
  identical: boolean;
  onlyDeno: string[];
  onlyConnector: string[];
}

/** Compare as multisets. `_nano_ingest_id` is always ignored. */
export function diffEvents(label: string, deno: Json[], connector: Json[], ignore: string[] = []): Diff {
  const ig = new Set([INGEST_ID, ...ignore]);
  const a = deno.map((e) => canon(e, ig)).sort();
  const b = connector.map((e) => canon(e, ig)).sort();
  const count = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const ca = count(a), cb = count(b);
  const onlyDeno = [...ca].filter(([k, n]) => (cb.get(k) ?? 0) < n).map(([k]) => k);
  const onlyConnector = [...cb].filter(([k, n]) => (ca.get(k) ?? 0) < n).map(([k]) => k);
  return { label, deno: a.length, connector: b.length, identical: onlyDeno.length === 0 && onlyConnector.length === 0, onlyDeno, onlyConnector };
}

export function assertSame(d: Diff): void {
  console.log(`shadow ${d.label}: deno ${d.deno} / connector ${d.connector} ${d.identical ? "identical" : "DIFFER"}`);
  if (!d.identical) {
    throw new Error(
      `${d.label}: events differ\n deno-only: ${d.onlyDeno.slice(0, 2).join("\n  ")}\n connector-only: ${d.onlyConnector.slice(0, 2).join("\n  ")}`,
    );
  }
}

/** Every collector event carries a non-empty `_nano_ingest_id`. */
export function assertIngestIds(label: string, events: Record<string, Json>[]): void {
  // `h:` is the engine's content-hash fallback: the spec's ingest_id fields
  // were missing, so the id is not the vendor's.
  const missing = events.filter((e) => typeof e[INGEST_ID] !== "string" || e[INGEST_ID] === "" || (e[INGEST_ID] as string).startsWith("h:")).length;
  if (missing > 0) throw new Error(`${label}: ${missing} of ${events.length} events lack a vendor ${INGEST_ID}`);
}

/** Find `parsers-ocsf/<dir>/parser.yaml` whose `name:` is `parser`. */
async function parserPath(parser: string): Promise<string> {
  const root = `${parsersDir}/parsers-ocsf`;
  for await (const d of Deno.readDir(root)) {
    const p = `${root}/${d.name}/parser.yaml`;
    try {
      const text = await Deno.readTextFile(p);
      if (new RegExp(`^name:\\s*["']?${parser}["']?\\s*$`, "m").test(text)) return p;
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }
  throw new Error(`no parser named ${parser} under ${root}`);
}

/**
 * The lake dedupes on the parser's metadata.uid and keeps the FIRST row for a
 * uid. Run `parser` over the connector's events twice: every uid must be
 * present, identical across the two parses, and unique per distinct event.
 * Returns false when skipped (no NANO_PARSERS_DIR).
 */
export async function checkUids(label: string, parser: string, batches: [string, Json[]][]): Promise<boolean> {
  if (parsersDir === "") {
    if (required) throw new Error("NANO_SHADOW_REQUIRED=1 but NANO_PARSERS_DIR is not set");
    console.warn(`shadow ${label}: NANO_PARSERS_DIR not set; uid check skipped`);
    return false;
  }
  const file = await tempFile("batches.json", JSON.stringify(batches));
  const out = await new Deno.Command(connectorBin, { args: ["check-uids", await parserPath(parser), file], stdout: "piped", stderr: "piped" }).output();
  const text = new TextDecoder().decode(out.stdout);
  let v: { ok: boolean; events: number; distinct_uids: number; failures: unknown[] };
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(`check-uids: ${text}\n${new TextDecoder().decode(out.stderr)}`);
  }
  console.log(`shadow ${label}: ${parser} metadata.uid stable for ${v.events} events (${v.distinct_uids} distinct)`);
  if (!v.ok) throw new Error(`${label}: ${parser} uid check failed: ${JSON.stringify(v.failures.slice(0, 3))}`);
  return true;
}

/** A manifest's `streams` (stream id -> source_type and parser). */
export async function manifestStreams(dir: URL): Promise<{ id: string; source_type: string; parser?: string }[]> {
  const { parse } = await import("jsr:@std/yaml@1");
  const m = parse(await Deno.readTextFile(new URL("manifest.yaml", dir))) as { streams?: { id: string; source_type: string; parser?: string }[] };
  return m.streams ?? [];
}
