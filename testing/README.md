# Testing harnesses

Not part of the catalog. Repo sync walks the `integrations/` content path only,
so nothing here is ever installed by a nano deployment browsing this repo.

## `throughput-collector`

Measures the **nano-side** ceiling of the collector path — Deno sandbox →
framed stdout protocol → host ingest → Vector — with the vendor removed from
the picture. It makes no network calls: it fabricates events in-process and
emits them as fast as the host will ack.

This is the number that decides whether a collector is a viable transport for a
high-volume source, and it is the one part of the design that cannot be
reasoned about from the vendor's published limits.

### Running it

Requires a nano deployment with the collector scheduler running, and `deno` on
the API pod's PATH.

1. Copy `throughput-collector/` into `integrations/` **on a branch you do not
   publish**, or point a marketplace repository at a fork with it in place.
2. Sync the catalog and install it.
3. Connect an instance. There are no credentials; the config fields tune the
   load:

   | Field | Meaning |
   |---|---|
   | `EVENTS_PER_BATCH` | Events per `emit` call. `10000` matches Netskope's page size. |
   | `BATCH_COUNT` | How many batches to emit before finishing. |
   | `EVENT_BYTES` | Approximate size of each synthetic event's payload. |

4. Run it and read the reported rate from the instance's run history — the
   collector logs a summary line, and `events_fetched` / `last_run_duration_ms`
   give the same figure independently.

### Reading the result

Divide `events_fetched` by `last_run_duration_ms / 1000`. Compare against:

- **The vendor's ceiling.** Netskope: 10k records × 4 req/s = 40k events/s
  theoretical, far below what a poll interval ever produces in practice. If the
  harness clears this comfortably, the sandbox is not the constraint for
  Netskope.
- **Your ingest budget.** The events land in ClickHouse through the ordinary
  Vector pipeline, so the measured rate includes parsing and insert. A rate
  well below your deployment's known ingest capacity points at the protocol,
  not at storage.

Vary `EVENTS_PER_BATCH` to find where batching stops helping. Per-event emits
make the run pipe-bound; batches that approach `max_events_per_emit` are
rejected outright.

### What it does not measure

Vendor latency, rate-limit backoff, or cursor round-trips — all of which
dominate a real collector's wall-clock. A real integration is almost always
waiting on the vendor, not on nano. This harness deliberately removes that wait
so the remaining ceiling is visible.
