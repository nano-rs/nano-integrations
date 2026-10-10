// NAN-3483: every collector stream must resolve to a parser in the OCSF set.
//
// Collector provisioning looks a declared `parser:` up BY NAME (NAN-2248, no
// fallback to source_type), and OCSF tenants only carry the parsers under
// parsers-ocsf/ on the parsers repo's ocsf-1.9 branch. A manifest that names a
// pre-OCSF parser (google_workspace, slack_access, netskope) therefore
// provisions its streams unparsed on every OCSF tenant. This test fails when a
// collector names a parser that is not in the checked-in OCSF snapshot
// (ocsf-parsers.json; refresh it with refresh.ts).
//
//   deno test --allow-read testing/ocsf-parsers/manifests.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse } from "jsr:@std/yaml@1";

type Stream = { id: string; source_type: string; parser?: string };
type Manifest = { slug: string; category?: string; streams?: Stream[] };
type Snapshot = { parsers: { name: string; match_values: string[] }[] };

const here = new URL(".", import.meta.url);
const integrations = new URL("../../integrations/", here);

const snapshot: Snapshot = JSON.parse(
  await Deno.readTextFile(new URL("ocsf-parsers.json", here)),
);
const byName = new Map(snapshot.parsers.map((p) => [p.name, p]));
const claimed = new Set(snapshot.parsers.flatMap((p) => p.match_values));

async function collectors(): Promise<Manifest[]> {
  const out: Manifest[] = [];
  for await (const entry of Deno.readDir(integrations)) {
    if (!entry.isDirectory) continue;
    let text: string;
    try {
      text = await Deno.readTextFile(new URL(`${entry.name}/manifest.yaml`, integrations));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) continue;
      throw e;
    }
    const m = parse(text) as Manifest;
    if (m.category === "collector") out.push(m);
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

Deno.test("snapshot is non-trivial", () => {
  assert(snapshot.parsers.length > 10, "ocsf-parsers.json looks empty; re-run refresh.ts");
});

Deno.test("every collector stream resolves to an OCSF parser", async () => {
  const problems: string[] = [];
  const manifests = await collectors();
  assert(manifests.length > 0, "no collector manifests found");
  for (const m of manifests) {
    for (const s of m.streams ?? []) {
      const where = `${m.slug}/${s.id}`;
      if (s.parser !== undefined) {
        const p = byName.get(s.parser);
        if (!p) {
          problems.push(`${where}: parser '${s.parser}' is not an OCSF parser`);
        } else if (!p.match_values.includes(s.source_type)) {
          problems.push(
            `${where}: parser '${s.parser}' does not claim source_type '${s.source_type}'`,
          );
        }
      } else if (!claimed.has(s.source_type)) {
        problems.push(`${where}: no parser declared and no OCSF parser claims '${s.source_type}'`);
      }
    }
  }
  assertEquals(problems, []);
});

Deno.test("the check rejects a pre-OCSF parser name", () => {
  // Guards the guard: the names this PR moved off must stay outside the set.
  for (const legacy of ["google_workspace", "slack_access", "netskope"]) {
    assert(!byName.has(legacy), `${legacy} unexpectedly in the OCSF snapshot`);
  }
});
