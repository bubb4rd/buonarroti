/**
 * One entry point for running a pipeline step — used by the API route (canvas
 * nodes) and by scripts/game/run-character.mts, so both run identical code.
 * The inputs are re-checked here: a step never runs on a rejected input.
 */
import {
  checkStepInputs, STEP_IO,
  type AnimClip, type Artifact, type ArtifactKind, type Mesh, type Prop, type PropCategory, type PropSheet, type Skeleton, type StepInputs, type StyleGuide, type TurnaroundSheet,
} from "./artifacts";
import { DEFAULT_BUILD, type Build } from "./poses";
import { runStyle } from "./style";
import { runTurnaround } from "./turnaround";
import { runAnimClip, runGltf, runMesh, runSkeleton, runUnreal } from "./steps";
import { runSurface } from "./surface";
import { runEquip, runIcon, runProp, runPropSheet } from "./prop";
import { DEFAULT_MAP_SEED, runSkybox, runWorldMap } from "./maps";

export interface StepRequest {
  step: ArtifactKind;
  runId: string;
  inputs: StepInputs;
  /** Turnaround: the mannequin build the character is drawn over. */
  build?: Build;
  /** Final file name (gltf / unreal step). */
  name?: string;
  heightM?: number;
  /** Prop sheet: what the item is for (held in the fist / lying on the ground). */
  category?: PropCategory;
  /** World map: seed of the land/water mask when no sketch is wired. */
  seed?: number;
  regenerate?: boolean;
  kieApiKey?: string;
  hfToken?: string;
}

export async function runStep(req: StepRequest): Promise<Artifact> {
  const spec = STEP_IO[req.step];
  const ok = checkStepInputs(req.step, req.inputs);
  if (!ok.ok) throw new Error(ok.reason);
  // checkStepInputs has matched every artifact to its port's kind, so the casts below hold.
  const a = req.inputs.artifacts;
  const primary = a[spec.inputs[0].id];
  if (primary && primary.runId !== req.runId) throw new Error("input artifact belongs to a different run");
  if (spec.kie && !req.kieApiKey) throw new Error("no kie.ai API key — add it in Settings");
  const style = a.style as StyleGuide | undefined;
  switch (req.step) {
    case "style": return runStyle({ runId: req.runId, images: req.inputs.images ?? [], notes: req.inputs.text });
    case "turnaround": return runTurnaround({ runId: req.runId, concept: req.inputs.text!, build: req.build ?? DEFAULT_BUILD, style, apiKey: req.kieApiKey!, regenerate: req.regenerate });
    case "mesh": return runMesh(a.turnaround as TurnaroundSheet, { heightM: req.heightM, hfToken: req.hfToken, regenerate: req.regenerate });
    case "skeleton": return runSkeleton(a.mesh as Mesh);
    case "animclip": return runAnimClip(a.skeleton as Skeleton);
    case "gltf": return runGltf(a.animclip as AnimClip, { name: req.name });
    case "unreal": return runUnreal(a.animclip as AnimClip, { name: req.name });
    case "surface": return runSurface({ runId: req.runId, material: req.inputs.text!, style, name: req.name, apiKey: req.kieApiKey!, regenerate: req.regenerate });
    case "propsheet": return runPropSheet({ runId: req.runId, item: req.inputs.text!, category: req.category ?? "handheld", style, apiKey: req.kieApiKey!, regenerate: req.regenerate });
    case "prop": return runProp(a.propsheet as PropSheet, { hfToken: req.hfToken, regenerate: req.regenerate });
    case "icon": return runIcon(a.prop as Prop);
    case "equip": return runEquip(a.prop as Prop, a.skeleton as Skeleton);
    case "worldmap": return runWorldMap({ runId: req.runId, world: req.inputs.text!, sketch: req.inputs.images?.[0], seed: req.seed ?? DEFAULT_MAP_SEED, style, apiKey: req.kieApiKey!, regenerate: req.regenerate });
    case "skybox": return runSkybox({ runId: req.runId, sky: req.inputs.text!, style, apiKey: req.kieApiKey!, regenerate: req.regenerate });
  }
}
