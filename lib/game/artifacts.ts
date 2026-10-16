/**
 * Typed artifacts for the character pipeline:
 *
 *   concept → TurnaroundSheet → Mesh → Skeleton (rigged mesh) → AnimClip → GltfAsset (Godot)
 *                                                                        ↘ UnrealAsset (FBX)
 *
 * Each artifact is produced by one canvas node, carries the checks that were
 * run on it, and is only accepted downstream when every blocking check passed.
 * Budgets are fixed here, ahead of any run, so a pass/fail never depends on
 * what a given model happened to output.
 *
 * Files live under `/generated/game/<runId>/`; artifacts store those URLs.
 */

export type ArtifactKind = "turnaround" | "mesh" | "skeleton" | "animclip" | "gltf" | "unreal";

/** One measured check. `pass:false` on a blocking check rejects the artifact. */
export interface Check {
  id: string;
  pass: boolean;
  value?: number | string | boolean;
  limit?: number | string;
  detail?: string;
  /** Advisory checks are reported but never reject. Default: blocking. */
  advisory?: boolean;
}

export interface ArtifactBase {
  kind: ArtifactKind;
  /** Pipeline run folder: every file of one character lives in `/generated/game/<runId>/`. */
  runId: string;
  /** Upstream artifact this one was derived from (kind + url of its primary file). */
  parent?: { kind: ArtifactKind; url: string };
  checks: Check[];
  /** Preview image for the canvas card and the gallery row. */
  previewUrl?: string;
  createdAt: string;
  /** Wall time of the step and the provider cost actually spent (credits are provider-specific). */
  cost: { seconds: number; kieCredits?: number; gpuProvider?: string };
}

export type SheetViewName = "front" | "side" | "back";

export interface SheetView {
  name: SheetViewName;
  /** File name inside the run folder (RGBA, transparent background, square). */
  file: string;
  /** Bounding box on the sheet, pixels. */
  box: { x: number; y: number; w: number; h: number };
}

export interface TurnaroundSheet extends ArtifactBase {
  kind: "turnaround";
  concept: string;
  prompt: string;
  model: string;
  /** Mannequin build the sheet was drawn over (lib/game/poses.ts); absent on sheets made before pose templates. */
  build?: string;
  /** The pose / layout reference sent with the request. */
  poseUrl?: string;
  sheetUrl: string;
  width: number;
  height: number;
  views: SheetView[];
}

export interface Mesh extends ArtifactBase {
  kind: "mesh";
  /** Normalised static mesh: meters, +Y up, facing +Z, feet at y=0, one material. */
  glbUrl: string;
  generator: string;
  triangles: number;
  vertices: number;
  heightM: number;
  textureSize: number;
  /** Silhouette IoU against each sheet view after alignment. */
  silhouette: Record<SheetViewName, number>;
  /** Raw generator output, kept so downstream fixes re-run without a new generation. */
  rawUrl: string;
}

export interface Skeleton extends ArtifactBase {
  kind: "skeleton";
  /** Rigged mesh in rest pose (A-pose), skin weights bound, no animation. */
  glbUrl: string;
  /** Same rig as a .blend: the retarget step reads it to avoid a glTF re-import round trip. */
  blendUrl: string;
  profile: "godot-humanoid";
  bones: string[];
  skinMethod: "bone_heat" | "voxel_proxy";
  /** Arm angle below horizontal in the rest pose, degrees, per side. */
  armAngleDeg: { left: number; right: number };
}

export interface AnimClip extends ArtifactBase {
  kind: "animclip";
  /** Rigged mesh + one baked, looping, in-place clip. */
  glbUrl: string;
  blendUrl: string;
  /** Clip name in the file; the "-loop" suffix makes Godot import it looping (as "walk"). */
  name: string;
  source: string;
  frames: number;
  fps: number;
}

export interface GltfAsset extends ArtifactBase {
  kind: "gltf";
  glbUrl: string;
  /** Khronos glTF-Validator issue counts. */
  validator: { version: string; errors: number; warnings: number; infos: number; hints: number };
  /** godot --headless --import, then check_walk.gd on the imported scene. */
  godot: { version: string; importIssues: string[]; animation?: string; loop?: boolean; frames?: number; maxStretch?: number };
}

export interface UnrealAsset extends ArtifactBase {
  kind: "unreal";
  /** Skinned mesh + the walk on the UE5 mannequin's bone names and parent chain. */
  fbxUrl: string;
  /** Bones in the file (a subset of SK_Mannequin's skeleton: no fingers, twist or IK helpers). */
  bones: string[];
  frames: number;
  fps: number;
  /** Headless UnrealEditor-Cmd import of the FBX, when Unreal is installed. */
  unreal?: { version: string; importIssues: string[] };
}

export type Artifact = TurnaroundSheet | Mesh | Skeleton | AnimClip | GltfAsset | UnrealAsset;

/** Which artifact each node consumes and emits — the canvas connection contract. */
export const STEP_IO: Record<ArtifactKind, { input: ArtifactKind | "prompt"; output: ArtifactKind }> = {
  turnaround: { input: "prompt", output: "turnaround" },
  mesh: { input: "turnaround", output: "mesh" },
  skeleton: { input: "mesh", output: "skeleton" },
  animclip: { input: "skeleton", output: "animclip" },
  gltf: { input: "animclip", output: "gltf" },
  unreal: { input: "animclip", output: "unreal" },
};

export function blockingFailures(a: { checks: Check[] }): Check[] {
  return a.checks.filter((c) => !c.pass && !c.advisory);
}

/** An artifact is consumable downstream only if it exists and none of its blocking checks failed. */
export function accepts(input: Artifact | undefined, kind: ArtifactKind): { ok: true } | { ok: false; reason: string } {
  if (!input) return { ok: false, reason: `no ${kind} artifact yet — run the upstream node first` };
  if (input.kind !== kind) return { ok: false, reason: `expected a ${kind} artifact, got ${input.kind}` };
  const failed = blockingFailures(input);
  if (failed.length) return { ok: false, reason: `upstream ${kind} failed: ${failed.map((c) => c.id).join(", ")}` };
  return { ok: true };
}

// ── Budgets (fixed before any run) ──────────────────────────────────────────

/** Turnaround sheet: geometry of the three silhouettes. Fractions of figure height unless noted. */
export const SHEET_BUDGET = {
  /** Sum of |Δr|+|Δg|+|Δb| under which a pixel counts as background. */
  bgTolerance: 60,
  /** Mean per-channel deviation of border pixels from their median. */
  bgMaxNoise: 6,
  maxHeightSpread: 0.04,
  maxGroundSpread: 0.03,
  minFigureFill: 0.55,
  maxSideToFrontWidth: 0.8,
  /** Height bands (0 = feet, 1 = head top) searched for the arm / leg gaps, and the minimum gap span. */
  armBand: [0.3, 0.8] as [number, number],
  minArmGap: 0.12,
  legBand: [0.02, 0.45] as [number, number],
  minLegGap: 0.1,
  minFrontBackIoU: 0.8,
  /** Head band (top fraction of the figure) compared on its own, and its minimum IoU. */
  headBand: 0.2,
  minHeadIoU: 0.85,
  maxLightAsymmetry: 0.06,
} as const;

/** Game-ready character budgets, checked by scripts/game/bpy/check_budgets.py on the final .glb. */
export const CHARACTER_BUDGET = {
  maxTriangles: 20_000,
  minTriangles: 2_000,
  maxTextureSize: 2048,
  requirePowerOfTwoTextures: true,
  maxMaterials: 1,
  heightM: [1.0, 2.2] as [number, number],
  maxBones: 64,
  maxInfluences: 4,
  /** Every vertex must be weighted; weights sum to 1 within this. */
  weightSumTolerance: 1e-3,
  /** Rest pose: upper-arm angle below horizontal, degrees. */
  aPoseArmDeg: [30, 60] as [number, number],
  /** Left/right arm angle difference, degrees. */
  aPoseSymmetryDeg: 6,
  /** Feet must touch the ground plane in the rest pose, meters. */
  maxFootGroundOffsetM: 0.02,
  /** Loop: first vs last frame pose difference, degrees, per bone. */
  maxLoopSeamDeg: 3,
  /** Animated frames: max edge length ratio vs rest (tearing / candy-wrapper detector). */
  maxEdgeStretch: 2.5,
  /** Animated frames: max distance between vertices sharing a rest position (glTF
   *  seam copies), as a fraction of height. Above this the mesh visibly cracks. */
  maxSeamGapFrac: 0.001,
  /** Mesh silhouette vs sheet view IoU (view drift / missing or invented parts). */
  minSilhouetteIoU: { front: 0.85, side: 0.8, back: 0.85 },
  /** Baked texture rendered in each sheet view vs the drawing: max fraction of wrong pixels.
   *  Advisory until calibrated against people's "looks right" verdicts. */
  maxTextureWrong: 0.05,
} as const;

/** Required bone names (Godot SkeletonProfileHumanoid, no fingers). */
export const REQUIRED_BONES = [
  "Root", "Hips", "Spine", "Chest", "UpperChest", "Neck", "Head",
  "LeftShoulder", "LeftUpperArm", "LeftLowerArm", "LeftHand",
  "RightShoulder", "RightUpperArm", "RightLowerArm", "RightHand",
  "LeftUpperLeg", "LeftLowerLeg", "LeftFoot", "LeftToes",
  "RightUpperLeg", "RightLowerLeg", "RightFoot", "RightToes",
] as const;

/** Budget object handed to the bpy scripts. */
export const BPY_BUDGET = { ...CHARACTER_BUDGET, requiredBones: [...REQUIRED_BONES] };
