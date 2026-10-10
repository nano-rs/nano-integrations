// Regenerate ocsf-parsers.json from a checkout of nano-rs/parsers at the
// branch nano deployments sync for OCSF (ocsf-1.9):
//
//   git -C ../parsers fetch origin ocsf-1.9 && git -C ../parsers checkout origin/ocsf-1.9
//   deno run --allow-read --allow-write --allow-run=git \
//     testing/ocsf-parsers/refresh.ts ../parsers
//
// The snapshot is what manifests.test.ts checks every collector stream
// against (NAN-3483): a manifest that names a parser outside the OCSF set
// provisions its stream unparsed on OCSF tenants.
import { parse } from "jsr:@std/yaml@1";

const root = Deno.args[0];
if (!root) {
  console.error("usage: refresh.ts <parsers-checkout>");
  Deno.exit(2);
}

const commit = new TextDecoder().decode(
  (await new Deno.Command("git", { args: ["-C", root, "rev-parse", "--short", "HEAD"] }).output())
    .stdout,
).trim();

const parsers: { name: string; match_values: string[] }[] = [];
for await (const entry of Deno.readDir(`${root}/parsers-ocsf`)) {
  if (!entry.isDirectory) continue;
  let text: string;
  try {
    text = await Deno.readTextFile(`${root}/parsers-ocsf/${entry.name}/parser.yaml`);
  } catch {
    continue;
  }
  const doc = parse(text) as { name?: string; match_values?: string[] };
  if (!doc?.name) continue;
  parsers.push({ name: doc.name, match_values: [...(doc.match_values ?? [])].sort() });
}
parsers.sort((a, b) => a.name.localeCompare(b.name));

const out = {
  source: { repo: "nano-rs/parsers", branch: "ocsf-1.9", path: "parsers-ocsf", commit },
  parsers,
};
const target = new URL("./ocsf-parsers.json", import.meta.url);
await Deno.writeTextFile(target, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${parsers.length} OCSF parsers @ ${commit}`);
