// The failure-attribution contract, checked across EVERY collector.
//
// nano recovers the failing stream's name by matching the structured log
// `"Stream failed"` with a `stream` field — it is the only point where the host
// still sees an individual stream, because collectors catch per stream and then
// rethrow one aggregate at the end of the run. The Rust side keys on that exact
// string (`stream_failure_from_log`).
//
// That makes it a contract expressed in prose, which is the fragile kind: a
// collector that words its log differently, or that grows a stream without a
// catch, silently stops recording per-stream errors. Nothing fails, the UI just
// shows an empty error field forever — which is exactly how NAN-2279 hid, and
// how slack was still missing after NAN-2279 fixed the host side (NAN-2280).
//
// So this asserts the contract for every integration in the repo, and any new
// one is included automatically rather than by someone remembering.
//
//   deno test --allow-read integrations/contract.test.ts

import { assert } from "jsr:@std/assert@1";

/** Every integration directory, discovered rather than listed. */
async function integrationDirs(): Promise<string[]> {
  const dirs: string[] = [];
  for await (const entry of Deno.readDir("integrations")) {
    if (entry.isDirectory) dirs.push(entry.name);
  }
  return dirs.sort();
}

Deno.test("every collector reports stream failures in the shape the host parses", async () => {
  const dirs = await integrationDirs();
  assert(dirs.length > 0, "no integrations found — did the layout change?");

  const offenders: string[] = [];
  for (const dir of dirs) {
    const path = `integrations/${dir}/code.ts`;
    let source: string;
    try {
      source = await Deno.readTextFile(path);
    } catch {
      continue; // not a code-backed collector
    }

    // The host matches the message exactly and then reads `stream` from the
    // fields object, so both halves have to be present.
    const logsFailure = source.includes('ctx.log("Stream failed"');
    const namesStream = /ctx\.log\("Stream failed",\s*\{[^}]*stream/.test(source);

    if (!logsFailure || !namesStream) {
      offenders.push(
        `${dir}: ${logsFailure ? "logs it but does not name the stream" : "never logs \"Stream failed\""}`,
      );
    }
  }

  assert(
    offenders.length === 0,
    `these collectors cannot have a failure attributed to their stream:\n  ${offenders.join("\n  ")}\n\n` +
      `Catch per stream and call ctx.log("Stream failed", { stream, error }) before rethrowing. ` +
      `Without it the per-stream last_error stays NULL and a broken stream looks identical to an idle one.`,
  );
});
