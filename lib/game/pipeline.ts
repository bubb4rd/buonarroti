/**
 * One entry point for running a pipeline step — used by the API route (canvas
 * nodes) and by scripts/game/run-character.ts, so both run identical code.
 * The upstream artifact is re-checked here: a step never runs on a rejected input.
 */
import { accepts, STEP_IO, type Artifact, type ArtifactKind } from "./artifacts";
import { runTurnaround } from "./turnaround";
import { runAnimClip, runGltf, runMesh, runSkeleton } from "./steps";

export interface StepRequest {
  step: ArtifactKind;
  runId: string;
  /** Upstream artifact (absent for the turnaround step). */
  input?: Artifact;
  /** Turnaround: the concept prompt. */
  concept?: string;
  /** Final file name (gltf step). */
  name?: string;
  heightM?: number;
  regenerate?: boolean;
  kieApiKey?: string;
  hfToken?: string;
}

export async function runStep(req: StepRequest): Promise<Artifact> {
  const need = STEP_IO[req.step].input;
  if (need === "prompt") {
    if (!req.concept?.trim()) throw new Error("the turnaround step needs a concept prompt");
    if (!req.kieApiKey) throw new Error("no kie.ai API key — add it in Settings");
    return runTurnaround({ runId: req.runId, concept: req.concept, apiKey: req.kieApiKey, regenerate: req.regenerate });
  }
  const ok = accepts(req.input, need);
  if (!ok.ok) throw new Error(ok.reason);
  const input = req.input!;
  if (input.runId !== req.runId) throw new Error("input artifact belongs to a different run");
  switch (req.step) {
    case "mesh": return runMesh(input as Extract<Artifact, { kind: "turnaround" }>, { heightM: req.heightM, hfToken: req.hfToken, regenerate: req.regenerate });
    case "skeleton": return runSkeleton(input as Extract<Artifact, { kind: "mesh" }>);
    case "animclip": return runAnimClip(input as Extract<Artifact, { kind: "skeleton" }>);
    case "gltf": return runGltf(input as Extract<Artifact, { kind: "animclip" }>, { name: req.name });
  }
  throw new Error(`unknown step ${req.step}`);
}
