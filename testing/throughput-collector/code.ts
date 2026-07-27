// Throughput harness — measures the nano-side collector ceiling.
//
// Makes no network calls. Fabricates events in-process and emits them as fast
// as the host will ack, so what is measured is: Deno serialization → framed
// stdout → host read → ingest POST → ack. That is the one part of the collector
// design that cannot be predicted from a vendor's published rate limits.
//
// See ../README.md for how to run it and how to read the result.

interface CollectorContext {
  cursors: Record<string, string | undefined>;
  credentials: Record<string, string>;
  config: Record<string, string>;
  streams: string[];
  backfillFrom?: string;
  emit(streamId: string, events: unknown[]): Promise<void>;
  checkpoint(streamId: string, cursor: string): Promise<void>;
  shouldStop(): boolean;
  log(msg: string, fields?: Record<string, unknown>): void;
}

function intConfig(config: Record<string, string>, key: string, fallback: number): number {
  const raw = (config[key] ?? "").trim();
  if (raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Build one synthetic event of roughly `bytes` payload size.
 *
 * Shaped like a real vendor record — a handful of small typed fields plus one
 * large string — because JSON serialization cost depends on field count, not
 * only on total size. A single giant string would flatter the result.
 */
function makeEvent(seq: number, bytes: number): Record<string, unknown> {
  const filler = "x".repeat(Math.max(0, bytes - 200));
  return {
    _id: `synthetic-${seq}`,
    record_type: "application",
    timestamp: Math.floor(Date.now() / 1000),
    user: `user${seq % 1000}@loadtest.invalid`,
    srcip: `10.${(seq >> 16) & 0xff}.${(seq >> 8) & 0xff}.${seq & 0xff}`,
    dstip: "192.0.2.1",
    srcport: 1024 + (seq % 60000),
    dstport: 443,
    protocol: "https",
    app: "LoadTest",
    activity: "Upload",
    action: "allow",
    numbytes: bytes,
    padding: filler,
  };
}

async function collect(ctx: CollectorContext): Promise<void> {
  const perBatch = intConfig(ctx.config, "EVENTS_PER_BATCH", 10_000);
  const batchCount = intConfig(ctx.config, "BATCH_COUNT", 20);
  const eventBytes = intConfig(ctx.config, "EVENT_BYTES", 500);
  const stream = ctx.streams[0];

  if (!stream) {
    throw new Error("no stream enabled — enable `synthetic` on the instance");
  }

  ctx.log("Starting throughput run", { perBatch, batchCount, eventBytes });

  const started = Date.now();
  let emitted = 0;
  let seq = 0;

  for (let batch = 0; batch < batchCount; batch++) {
    if (ctx.shouldStop()) {
      ctx.log("Run budget exhausted", { batchesCompleted: batch });
      break;
    }

    const events = new Array(perBatch);
    for (let i = 0; i < perBatch; i++) {
      events[i] = makeEvent(seq++, eventBytes);
    }

    await ctx.emit(stream, events);
    emitted += perBatch;

    // Checkpoint every batch, as a real collector does — the round trip is part
    // of what is being measured, and omitting it would overstate the ceiling.
    await ctx.checkpoint(stream, String(seq));
  }

  const elapsedMs = Date.now() - started;
  const rate = elapsedMs > 0 ? Math.round((emitted / elapsedMs) * 1000) : 0;

  ctx.log("Throughput run complete", {
    events: emitted,
    elapsed_ms: elapsedMs,
    events_per_sec: rate,
    bytes_per_event: eventBytes,
  });
}

export { collect };
