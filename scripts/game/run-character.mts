/**
 * Run the character pipeline end to end (or resume it) outside the UI, through
 * the same lib/game/pipeline.ts the canvas nodes call.
 *
 *   pnpm game:character --name dwarf --build stocky --concept "a stocky dwarf blacksmith…"
 *   pnpm game:character --name dwarf --concept "…" --style <styleRunId>   # drawn in a style guide's look
 *   pnpm game:character --run <runId> --from skeleton      # resume after a fix
 *   pnpm game:character --run <runId> --regenerate mesh    # discard the cached mesh
 *   pnpm game:character --run <runId> --from unreal --export unreal   # Unreal FBX from an existing animation set
 *
 * Artifacts are saved to <media>/game/<runId>/artifacts.json after every step.
 * Stops at the first step whose artifact has a failing blocking check.
 */
import { blockingFailures, STEP_IO, type ArtifactKind } from "../../lib/game/artifacts";
import { BUILDS, isBuild } from "../../lib/game/poses";
import { runStep } from "../../lib/game/pipeline";
import { newRunId, runDir } from "../../lib/game/runs";
import { getKieToken } from "../../lib/getKieToken";
import { loadRun, printArtifact, saveRun } from "./cli";
import { parseArgs } from "util";

const CHAIN: ArtifactKind[] = ["turnaround", "mesh", "skeleton", "animclip"];
const EXPORTS: ArtifactKind[] = ["gltf", "unreal"];

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    concept: { type: "string" },
    /** Mannequin build for the turnaround (scripts/game/poses/builds.json). */
    build: { type: "string" },
    /** Run id of a StyleGuide (pnpm game:step --step style …) the turnaround is drawn in. */
    style: { type: "string" },
    run: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    /** Comma-separated export steps after the animation set: gltf (Godot), unreal (FBX). */
    export: { type: "string", default: "gltf" },
    /** Comma-separated steps whose cached generation (sheet.png, mesh_raw.glb) is discarded. */
    regenerate: { type: "string", default: "" },
  },
});
if (values.build !== undefined && !isBuild(values.build)) {
  console.error(`unknown --build ${values.build} (one of: ${BUILDS.map((b) => b.id).join(", ")})`);
  process.exit(1);
}
const exportSteps = values.export.split(",").filter(Boolean) as ArtifactKind[];
if (exportSteps.some((s) => !EXPORTS.includes(s))) {
  console.error(`unknown --export ${values.export} (any of: ${EXPORTS.join(", ")})`);
  process.exit(1);
}
const ORDER = [...CHAIN, ...exportSteps];
const runId = values.run ?? newRunId();
await runDir(runId);
const saved = await loadRun(runId);
saved.name = values.name ?? saved.name ?? "character";
saved.concept = values.concept ?? saved.concept;
const style = values.style ? (await loadRun(values.style)).artifacts.style : undefined;
if (values.style && !style) {
  console.error(`run ${values.style} has no style artifact`);
  process.exit(1);
}

const from = ORDER.indexOf((values.from as ArtifactKind) ?? "turnaround");
const to = ORDER.indexOf((values.to as ArtifactKind) ?? ORDER[ORDER.length - 1]);
console.log(`run ${runId} (${saved.name})`);
let exit = 0;
for (const step of ORDER.slice(from, to + 1)) {
  const primary = STEP_IO[step].inputs[0];
  process.stdout.write(`▸ ${step} … `);
  try {
    const art = await runStep({
      step, runId,
      inputs: {
        artifacts: {
          ...(primary.kind === "prompt" || primary.kind === "image" ? {} : { [primary.id]: saved.artifacts[primary.kind] }),
          ...(step === "turnaround" && style ? { style } : {}),
        },
        text: saved.concept,
      },
      build: isBuild(values.build) ? values.build : undefined,
      name: saved.name, regenerate: values.regenerate.split(",").includes(step),
      kieApiKey: (await getKieToken()) ?? undefined, hfToken: process.env.HF_TOKEN,
    });
    saved.artifacts[step] = art;
    await saveRun(runId, saved);
    printArtifact(art);
    if (blockingFailures(art).length) { exit = 2; break; }
  } catch (e) {
    console.log(`ERROR — ${(e as Error).message}`);
    exit = 1;
    break;
  }
}
process.exit(exit);
