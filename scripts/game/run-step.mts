/**
 * Run any one pipeline step outside the UI, through lib/game/pipeline.ts.
 *
 *   pnpm game:step --step style --images ref1.png,ref2.jpg --text "flat cel shading, thick outlines"
 *   pnpm game:step --step turnaround --text "a dwarf smith" --input style=<styleRunId>
 *   pnpm game:step --step mesh --run <runId>
 *
 * The primary input (the step's first port) is read from --run's artifacts.json;
 * other artifact ports from `--input <port>=<runId>` (that run's artifact of the
 * port's kind). --images takes local files, /generated/… paths or URLs. The new
 * artifact is saved under its kind in the run's artifacts.json and printed.
 * Exit code 2 when a blocking check failed.
 */
import { readFile } from "fs/promises";
import { extname } from "path";
import { parseArgs } from "util";
import { blockingFailures, isArtifactPort, isPropCategory, STEP_IO, type ArtifactKind, type StepInputs } from "../../lib/game/artifacts";
import { isBuild } from "../../lib/game/poses";
import { runStep } from "../../lib/game/pipeline";
import { newRunId, runDir } from "../../lib/game/runs";
import { getKieToken } from "../../lib/getKieToken";
import { loadRun, printArtifact, saveRun } from "./cli";

const { values } = parseArgs({
  options: {
    step: { type: "string" },
    run: { type: "string" },
    text: { type: "string" },
    images: { type: "string" },
    input: { type: "string", multiple: true, default: [] },
    build: { type: "string" },
    category: { type: "string" },
    name: { type: "string" },
    seed: { type: "string" },
    regenerate: { type: "boolean", default: false },
  },
});
const step = values.step as ArtifactKind | undefined;
if (!step || !(step in STEP_IO)) {
  console.error(`--step must be one of: ${Object.keys(STEP_IO).join(", ")}`);
  process.exit(1);
}

async function imageRef(ref: string): Promise<string> {
  if (/^(https?:|data:|\/generated\/)/.test(ref)) return ref;
  const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" }[extname(ref).toLowerCase()] ?? "image/png";
  return `data:${mime};base64,${(await readFile(ref)).toString("base64")}`;
}

const spec = STEP_IO[step];
const runId = values.run ?? newRunId();
await runDir(runId);
const saved = await loadRun(runId);
const inputs: StepInputs = {
  artifacts: {},
  text: values.text,
  images: values.images ? await Promise.all(values.images.split(",").filter(Boolean).map(imageRef)) : undefined,
};
const primary = spec.inputs[0];
if (isArtifactPort(primary)) inputs.artifacts[primary.id] = saved.artifacts[primary.kind];
for (const pair of values.input) {
  const [port, from] = pair.split("=");
  const p = spec.inputs.find((q) => q.id === port);
  if (!p || !isArtifactPort(p) || !from) {
    console.error(`--input ${pair}: ${step} has no artifact port "${port}"`);
    process.exit(1);
  }
  inputs.artifacts[port] = (await loadRun(from)).artifacts[p.kind];
}

console.log(`run ${runId} — ${step}`);
try {
  const art = await runStep({
    step, runId, inputs,
    build: isBuild(values.build) ? values.build : undefined,
    category: isPropCategory(values.category) ? values.category : undefined,
    name: values.name ?? saved.name, regenerate: values.regenerate,
    seed: values.seed !== undefined ? Number.parseInt(values.seed, 10) : undefined,
    kieApiKey: (await getKieToken()) ?? undefined, hfToken: process.env.HF_TOKEN,
  });
  saved.artifacts[step] = art;
  await saveRun(runId, saved);
  printArtifact(art);
  process.exit(blockingFailures(art).length ? 2 : 0);
} catch (e) {
  console.log(`ERROR — ${(e as Error).message}`);
  process.exit(1);
}
