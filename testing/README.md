# Testing harnesses

Not part of the catalog. Repo sync walks the `integrations/` content path only,
so nothing here is ever installed by a nano deployment browsing this repo.

## `shadow`

The NAN-3490 shadow run: proof that each `connector.yaml` replaces its
`code.ts`. For every integration it starts the same vendor mock twice, runs the
unmodified `code.ts` under a port of nano's Deno auth wrapper
(`shadow/driver.ts`) against one and `nano-connector shadow` against the
other, and checks that:

- both ship the same events per stream (a multiset diff; `_nano_ingest_id` is
  the engine's stamp and is ignored);
- a second connector run from the first run's checkpoints ships nothing;
- every connector event carries `_nano_ingest_id`;
- the stream's OCSF parser gives every event a `metadata.uid` that is the same
  on a second parse and not shared with another event (`nano-connector
  check-uids`), since the lake dedupes on it and drops a later row with the
  same uid.

A contract test needs no binary and always runs: every manifest names its
`connector.yaml`, declares a `runtime`, and declares every credential, config
field and stream `source_type` the spec uses.

```sh
# contract only
deno test --allow-read --allow-env testing/shadow/shadow.test.ts
# full shadow run
NANO_CONNECTOR_BIN=/path/to/nano-connector NANO_PARSERS_DIR=/path/to/parsers \
  deno test --allow-read --allow-write --allow-net=127.0.0.1 --allow-run --allow-env \
  testing/shadow/shadow.test.ts
```

Without `NANO_CONNECTOR_BIN` the shadow tests are skipped, unless
`NANO_SHADOW_REQUIRED=1` (CI), which turns a missing binary into a failure.
`.github/workflows/shadow.yml` builds `nano-connector` from nanosiem and
checks out the parsers repo's `ocsf-1.9` branch.

## `netskope-mock`

A mock of Netskope's iterator API (`/api/v2/events/dataexport/...`) with its
server-side position: `operation=next` advances it, `resend` re-serves the last
page, and the first call opens the iterator at an epoch. It can drop the
response after serving a page (`failAfterServe`) to prove a lost page is
resent, not skipped. Runs standalone: `deno run --allow-net --allow-env
testing/netskope-mock/mock.ts`.

## `okta-mock-public`

The target for a live connector-runner run (NAN-3490). The hosted runner can
only reach public TLS names (its NetworkPolicy and the broker refuse private
addresses), so `okta-mock` cannot be its target. `worker.ts` is a stateless
Cloudflare Worker port: event `seq` is published at `EPOCH + seq * 60 s /
EVENTS_PER_MIN` with `okta-mock`'s `makeEvent` body, so every isolate serves
the same stream and a validator can compute what a feed must have shipped.
It keeps Okta's paging (`since` / `until` / `after`, `Link rel="next"`), the
SSWS token check, late events (`LATE_EVERY` / `LATE_MS`) and a fixed 429
schedule (`FAULT_429_EVERY_SECS` / `FAULT_429_SECS`).
`GET /__mock/expected?since=&until=` returns the count and the first and last
uuid of `[since, until)`, with `final: true` once all of them are visible.

The shipped `okta_system_log` spec allows only Okta's domains, so the feed runs
a copy: `catalog.ts --host <mock host>` prints the `marketplace_catalog.config`
for `okta_system_log_mock`, which is the shipped spec renamed and with its
allowlist pinned to that one host. Nothing else differs (a test checks it).

```sh
# unit tests + a real nano-connector run against the mock (NANO_CONNECTOR_BIN)
deno test --allow-read --allow-write --allow-net=127.0.0.1 --allow-run --allow-env \
  testing/okta-mock-public/worker.test.ts
# deploy (a live change: only as a step of the validation plan)
cd testing/okta-mock-public && wrangler secret put MOCK_TOKEN && wrangler deploy
deno run --allow-read testing/okta-mock-public/catalog.ts --host nano-okta-mock.<account>.workers.dev
```

## `throughput-collector` (retired at the connector cutover)

Nothing uses this harness except this README. It measures the Deno framed
stdout protocol, which goes away with the Deno runtime, so it is retired at
the cutover rather than ported. To load-test the connector engine, run
`nano-connector shadow` against a high-volume mock (for example
`netskope-mock` with a large backlog) and read `events` and the wall-clock
time.

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

## `ocsf-parsers`

A check, not a harness (NAN-3483). `ocsf-parsers.json` snapshots the OCSF parser
set (name and `match_values`) from the parsers repo's `ocsf-1.9` branch, and
`manifests.test.ts` fails when a collector stream names a parser outside that
set, names one that does not claim its `source_type`, or declares none and no
OCSF parser claims its `source_type`.

```sh
deno test --allow-read testing/ocsf-parsers/manifests.test.ts
# refresh the snapshot from a parsers checkout on origin/ocsf-1.9
deno run --allow-read --allow-write --allow-run=git testing/ocsf-parsers/refresh.ts ../parsers
```

## `directory-mocks`

Vendor mocks for the NAN-3503 identity specs (`kind: identity`): Google
Directory (`google.ts`: users with projection=full, groups, members with
includeDerivedMembership), Microsoft Graph (`graph.ts`: users with
`$expand=manager` and its 100-row page cap, users/delta with
`$deltatoken=latest`, `@removed`, `manager@delta`, 410 / syncStateNotFound
expiry, groups, transitiveMembers, directoryRoles) and Okta (`okta.ts`: users
generated lazily so 500k costs nothing, a plain list that omits STAGED and
DEPROVISIONED like Okta, `search` on status or `lastUpdated gt`, Link paging,
admin role assignees and per-user roles,
429 with Retry-After, 401 on a bad token, group members). Each has a
`faults.throttle(n)` switch and runs standalone (`deno run --allow-net
testing/directory-mocks/okta.ts`).

`record.ts` writes `recordings/*.json` in nano-connector's preview format
(`Recorded`: host, path, query, status, headers, body), the request sequence
each spec makes, plus `*.state.json` program states for delta runs. The Rust
tests and `nano-connector preview <spec> <recording>` replay them. Regenerate
after a mock change with `deno run --allow-read --allow-write
testing/directory-mocks/record.ts`; `mocks.test.ts` fails on stale recordings.
The identity shadow runs in `shadow/shadow.test.ts` use the same mocks and skip
until the engine knows `kind: identity`.
