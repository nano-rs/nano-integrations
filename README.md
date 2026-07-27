# nano integrations

Official integration catalog for [nano](https://nano.rs). Collectors that pull
events out of third-party SaaS platforms using your own credentials and land
them in nano — no agent to deploy, no log forwarder to run.

## Using this catalog

nano syncs this repository by default — open **Marketplace**, find the
integration, and install it. Then open its **Connections** tab, supply
credentials, pick the event streams you want, and nano starts pulling.

Each enabled stream becomes a log source, so collection shows up in
**Ingestion → Log Sources** alongside every other feed.

<details>
<summary>Adding it manually (older installs, or your own fork)</summary>

There is currently no UI for adding a marketplace repository, so this is an API
call:

```bash
curl -X POST https://<your-nano>/api/marketplace/repos \
  -H "X-API-Key: $NANO_API_KEY" -H 'Content-Type: application/json' \
  -d '{"name":"nano integrations",
       "url":"https://github.com/nano-rs/nano-integrations",
       "branch":"main","enrichments_path":"integrations",
       "auto_sync_enabled":true}'
```

`enrichments_path` is the content path — the field name predates collectors.

</details>

> Integrations are an **enterprise** feature and require outbound network
> access from the nano API pod. They are not supported in air-gapped
> deployments.

## What's in here

| Integration | Vendor | Auth | Streams |
|---|---|---|---|
| `netskope` | Netskope | API token | alert · page · application · audit · network · connection · incident · infrastructure · endpoint |
| `slack` | Slack | User token (`admin` scope) | access_logs |

`slack` needs only a Pro or Business+ workspace — the Enterprise-Grid-only
Audit Logs API is a different endpoint. Note that `team.accessLogs` returns
mutable aggregate records rather than an append-only event stream, so
re-delivery is guaranteed rather than incidental; see the collector's header
comment.

## Layout

```
integrations/
  <slug>/
    manifest.yaml
    code.ts
```

- `manifest.yaml` — identity, credential and config fields, allowed outbound
  domains, and the list of event streams the integration can pull.
- `code.ts` — TypeScript that runs in nano's Deno sandbox and does the pulling.

Field mapping is **not** done here. Collectors emit raw vendor events; the
[parsers repo](https://github.com/nano-rs/parsers) maps them to OCSF/UDM. Keep
VRL out of this repo.

## Writing a collector

A collector exports a single `collect` function. It receives credentials and
config at call time — never hard-code secrets.

```typescript
async function collect(ctx: CollectorContext): Promise<void> {
  for (const stream of ctx.streams) {
    let cursor = ctx.cursors[stream];
    while (!ctx.shouldStop()) {
      const { events, nextCursor, drained } = await fetchPage(ctx, stream, cursor);
      if (events.length > 0) {
        await ctx.emit(stream, events);      // resolves once nano has the batch
        await ctx.checkpoint(stream, nextCursor); // only after emit resolves
      }
      cursor = nextCursor;
      if (drained) break;
    }
  }
}
export { collect };
```

### The context object

| Member | Purpose |
|---|---|
| `ctx.credentials` | Decrypted values for the manifest's `credential_fields`. |
| `ctx.config` | Non-secret values for the manifest's `config_fields`. |
| `ctx.streams` | Stream ids the operator enabled. Collect only these. |
| `ctx.cursors[streamId]` | Opaque cursor you last checkpointed, or `undefined` on first run. |
| `ctx.backfillFrom` | ISO-8601 start time for the first run, if the operator asked for a backfill. |
| `ctx.emit(streamId, events)` | Ship a batch of raw events. Resolves once nano has durably accepted them. |
| `ctx.checkpoint(streamId, cursor)` | Persist a cursor. Call **after** the corresponding `emit` resolves. |
| `ctx.shouldStop()` | `true` when nano wants the run to wind down (run budget exhausted, or shutdown). Poll it in every loop. |
| `ctx.log(msg, fields?)` | Structured log line, surfaced in the instance's run history. |

### Delivery semantics

`emit` → `checkpoint` in that order gives **at-least-once** delivery. If the
process dies between the two, the next run re-fetches from the last committed
cursor and re-emits some events. Never checkpoint before emitting — that turns
a crash into silent data loss.

Duplicates are expected and acceptable. Do not build dedup into a collector.

### Rules that bite

1. **Poll `ctx.shouldStop()`.** A collector that ignores it gets killed
   mid-batch when the run budget expires, and loses everything since the last
   checkpoint.
2. **Respect the vendor's pacing.** If the API returns a `wait_time` or
   `Retry-After`, sleep for it. nano does not rate-limit on your behalf.
3. **One in-flight request per cursor.** Many iterator-style APIs return a
   conflict if you consume the same cursor concurrently. nano guarantees only
   one run per instance at a time; within your own code, keep streams
   sequential unless you know the API tolerates parallelism.
4. **Emit raw.** Do not reshape, rename, or flatten vendor fields — the parser
   expects the vendor's native shape. The only thing you own is *which* events
   go to *which* stream.
5. **Batch sensibly.** One `emit` per API page is right. Emitting per-event
   makes the run pipe-bound; buffering the whole stream defeats checkpointing.
6. **Fail loudly.** Throw on unexpected API responses. A collector that
   swallows errors and returns cleanly looks healthy while ingesting nothing.

## Manifest reference

See [SCHEMA.md](SCHEMA.md).

## Contributing

Open a PR with your integration directory. Include, in the PR description: the
vendor's API docs URL, which auth type it needs, and what the rate limits and
retention windows are. If the vendor drops undelivered events after a fixed
window, say so — that becomes a documented SLA for operators.

## License

Apache-2.0
