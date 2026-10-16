/**
 * Run the character pipeline end to end (or resume it) outside the UI, through
 * the same lib/game/pipeline.ts the canvas nodes call.
 *
 *   pnpm game:character --name dwarf --build stocky --concept "a stocky dwarf blacksmith…"
 *   pnpm game:character --run <runId> --from skeleton      # resume after a fix
 *   pnpm game:character --run <runId> --regenerate mesh    # discard the cached mesh
 *
 * Artifacts are saved to <media>/game/<runId>/artifacts.json after every step.
 * Stops at the first step whose artifact has a failing blocking check.
 */
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import { parseArgs } from "util";
import { blockingFailures, type Artifact, type ArtifactKind } from "../../lib/game/artifacts";
import { BUILDS, isBuild } from "../../lib/game/poses";
import { runStep } from "../../lib/game/pipeline";
import { newRunId, runDir, runPath } from "../../lib/game/runs";
import { getKieToken } from "../../lib/getKieToken";

const ORDER: ArtifactKind[] = ["turnaround", "mesh", "skeleton", "animclip", "gltf"];

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    concept: { type: "string" },
    /** Mannequin build for the turnaround (scripts/game/poses/builds.json). */
    build: { type: "string" },
    run: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    /** Comma-separated steps whose cached generation (sheet.png, mesh_raw.glb) is discarded. */
    regenerate: { type: "string", default: "" },
  },
});
if (values.build !== undefined && !isBuild(values.build)) {
  console.error(`unknown --build ${values.build} (one of: ${BUILDS.map((b) => b.id).join(", ")})`);
  process.exit(1);
}
const runId = values.run ?? newRunId();
await runDir(runId);
const store = runPath(runId, "artifacts.json");
const saved: { name?: string; concept?: string; artifacts: Partial<Record<ArtifactKind, Artifact>> } =
  existsSync(store) ? JSON.parse(await readFile(store, "utf8")) : { artifacts: {} };
saved.name = values.name ?? saved.name ?? "character";
saved.concept = values.concept ?? saved.concept;

const from = ORDER.indexOf((values.from as ArtifactKind) ?? "turnaround");
const to = ORDER.indexOf((values.to as ArtifactKind) ?? "gltf");
console.log(`run ${runId} (${saved.name})`);
let exit = 0;
for (const step of ORDER.slice(from, to + 1)) {
  const prev = ORDER[ORDER.indexOf(step) - 1];
  process.stdout.write(`▸ ${step} … `);
  try {
    const art = await runStep({
      step, runId, input: prev ? saved.artifacts[prev] : undefined,
      concept: saved.concept, build: isBuild(values.build) ? values.build : undefined,
      name: saved.name, regenerate: values.regenerate.split(",").includes(step),
      kieApiKey: (await getKieToken()) ?? undefined, hfToken: process.env.HF_TOKEN,
    });
    saved.artifacts[step] = art;
    await writeFile(store, JSON.stringify(saved, null, 1));
    const failed = blockingFailures(art);
    const cost = art.cost.kieCredits !== undefined ? `, ${art.cost.kieCredits} kie credits` : "";
    console.log(`${art.cost.seconds.toFixed(1)}s${cost} — ${failed.length ? "REJECTED" : "ok"}`);
    for (const c of art.checks) {
      if (!c.pass || process.env.VERBOSE) {
        console.log(`    ${c.pass ? "pass" : c.advisory ? "warn" : "FAIL"} ${c.id} = ${JSON.stringify(c.value)} (limit ${JSON.stringify(c.limit)})${c.detail ? ` — ${c.detail}` : ""}`);
      }
    }
    if (failed.length) { exit = 2; break; }
  } catch (e) {
    console.log(`ERROR — ${(e as Error).message}`);
    exit = 1;
    break;
  }
}
process.exit(exit);
