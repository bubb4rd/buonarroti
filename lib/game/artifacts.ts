/**
 * Typed artifacts for the game-asset pipelines, e.g. the character chain:
 *
 *   concept (+ StyleGuide) → TurnaroundSheet → Mesh → Skeleton (rigged mesh) → AnimClip → GltfAsset (Godot)
 *                                                                                       ↘ UnrealAsset (FBX)
 *
 * Each artifact is produced by one canvas node, carries the checks that were
 * run on it, and is only accepted downstream when every blocking check passed.
 * STEP_IO declares each step's input ports: the canvas, the API route and the
 * CLIs all derive their wiring and validation from it. Budgets are fixed here,
 * ahead of any run, so a pass/fail never depends on what a given model
 * happened to output.
 *
 * Files live under `/generated/game/<runId>/`; artifacts store those URLs.
 */

export type ArtifactKind = "style" | "turnaround" | "mesh" | "skeleton" | "animclip" | "gltf" | "unreal" | "surface" | "worldmap" | "skybox" | "propsheet" | "prop" | "icon" | "equip";

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
  /** Run of the StyleGuide a generated picture was drawn with, if one was wired. */
  styleRun?: string;
}

export type SheetViewName = "front" | "side" | "back";

export type Hands = "open" | "fist";

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
  /** Hand shape drawn; the rig places the wrist by it. Absent: open (sheets made before fist templates). */
  hands?: Hands;
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
  /** Hand shape, carried from the sheet for the rig. Absent: open. */
  hands?: Hands;
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

/** One baked clip of an animation set. */
export interface ClipInfo {
  /** Action / glTF animation name; the "-loop" suffix makes Godot import it looping (as "walk"). */
  name: string;
  /** Mocap file it was retargeted from (repo-relative). */
  source: string;
  frames: number;
  fps: number;
  /** Loops are in place and close exactly; one-shots (jump) play once. */
  loop: boolean;
}

export interface AnimClip extends ArtifactBase {
  kind: "animclip";
  /** Rigged mesh + the animation set (idle, walk, run, jump) baked on the rig. */
  glbUrl: string;
  blendUrl: string;
  clips: ClipInfo[];
}

/** One clip as Godot imported and played it (check_character.gd). */
export interface GodotClip {
  /** Godot's name (the "-loop" suffix stripped). */
  name: string;
  loop: boolean;
  frames: number;
  maxStretch: number;
  maxSeamGap: number;
  /** First vs last key over the imported tracks, degrees. */
  loopSeamDeg: number;
}

export interface GltfAsset extends ArtifactBase {
  kind: "gltf";
  glbUrl: string;
  /** Khronos glTF-Validator issue counts. */
  validator: { version: string; errors: number; warnings: number; infos: number; hints: number };
  /** godot --headless --import, then check_character.gd on the imported scene. */
  godot: { version: string; importIssues: string[]; clips: GodotClip[] };
}

export interface UnrealAsset extends ArtifactBase {
  kind: "unreal";
  /** Skinned mesh on the UE5 mannequin's bone names and parent chain, no animation (its bind pose is the rest pose). */
  fbxUrl: string;
  /** Bones in the file (a subset of SK_Mannequin's skeleton: no fingers, twist or IK helpers). */
  bones: string[];
  /** One FBX per clip, imported onto the mesh's skeleton; frames as read back from each file. */
  clips: { name: string; frames: number; fbxUrl: string }[];
  fps: number;
  /** Mesh, clips and albedo texture in one download. */
  zipUrl: string;
  /** Headless UnrealEditor-Cmd import, when Unreal is installed: engine, Interchange's messages,
   *  and how Manny's own clips measure on this character. */
  unreal?: { version: string; importIssues: string[]; manny: Record<string, { stretch: number; lowest_m: number }> };
}

/**
 * A look shared by every asset of one game: reference pictures (sent to the
 * image model next to each step's layout template) and the palette measured
 * from them, which generated images are checked against.
 */
export interface StyleGuide extends ArtifactBase {
  kind: "style";
  /** Reference pictures, copied into the run folder. */
  refs: string[];
  /** What the style is, in words (optional Text input). */
  notes?: string;
  /** Dominant colours of the references (k-means in CIELAB), largest share first; shares sum to 1. */
  palette: { hex: string; share: number }[];
}

/**
 * A seamless tiling PBR material for 3D ground and walls: albedo (baked
 * lighting removed), normal and roughness derived from it, and a Godot
 * StandardMaterial3D that maps them at a fixed texel density.
 */
export interface Surface extends ArtifactBase {
  kind: "surface";
  material: string;
  prompt: string;
  model: string;
  resolution: string;
  /** Layout template sent as image_input[0], and the picture the model returned. */
  templateUrl: string;
  rawUrl: string;
  albedoUrl: string;
  normalUrl: string;
  roughnessUrl: string;
  /** Godot material referencing the three PNGs by relative path. */
  tresUrl: string;
  /** The deliverable: PNGs, their Godot .import presets and the .tres, folder-less. */
  zipUrl: string;
  /** Texture side, px (power of two), and the world size one repeat covers, m. */
  size: number;
  tileM: number;
  /** Godot renders of the material on an 8 x 8 m plane, one per camera height. */
  renders: { url: string; heightM: number; seamRatio: number }[];
  godot: { version: string; importIssues: string[] };
}

/**
 * World / region map illustration for a game's map screen (lib/game/maps.ts),
 * drawn over a land/water mask. Carries no text: place names are added in-engine.
 */
export interface WorldMap extends ArtifactBase {
  kind: "worldmap";
  prompt: string;
  model: string;
  /** Where the coastlines came from: seeded noise, or the wired sketch normalised to land/water. */
  maskSource: "seed" | "sketch";
  seed?: number;
  /** Land/water mask (white land), the guide drawn from it (image_input[0]), the picture. */
  maskUrl: string;
  guideUrl: string;
  mapUrl: string;
  /** Picture segmented by colour, compared with the mask: green/blue agree, red disagrees. */
  segmentationUrl: string;
  width: number;
  height: number;
  /** Tesseract on the picture; `words` are the detections that count as text. */
  ocr: { version: string; words: { text: string; conf: number; heightPx: number }[] };
}

/** Equirectangular sky panorama (2:1) for Godot's PanoramaSkyMaterial / Unreal's sky sphere. */
export interface Skybox extends ArtifactBase {
  kind: "skybox";
  prompt: string;
  model: string;
  /** Projection guide sent as image_input[0], the picture as returned, the 2:1 deliverable. */
  guideUrl: string;
  rawUrl: string;
  panoramaUrl: string;
  width: number;
  height: number;
  /** The left/right edges were blended to wrap (lib/game/maps.ts repairSeam). */
  seamRepaired: boolean;
  /** Godot render of the panorama as a PanoramaSkyMaterial: view name → image URL. */
  godot: { version: string; importIssues: string[]; seamView?: string; views: Record<string, string> };
}

/** What an item is for: held in a character's closed fist, or resting on the ground. */
export const PROP_CATEGORIES = [
  { id: "handheld", label: "Handheld (weapon, tool)" },
  { id: "pickup", label: "Pickup (resting on the ground)" },
] as const;

export type PropCategory = (typeof PROP_CATEGORIES)[number]["id"];

export function isPropCategory(v: unknown): v is PropCategory {
  return PROP_CATEGORIES.some((c) => c.id === v);
}

/**
 * Front / side / back of one item (lib/game/prop.ts), drawn over a layout
 * template with a metre ruler (handheld: and a fist-sized grip box), split
 * into views for image-to-3D like a TurnaroundSheet.
 */
export interface PropSheet extends ArtifactBase {
  kind: "propsheet";
  item: string;
  category: PropCategory;
  prompt: string;
  model: string;
  templateUrl: string;
  sheetUrl: string;
  width: number;
  height: number;
  views: SheetView[];
  /** Height of the item in the views (handheld: its length along the handle), m, at the template's ruler scale. */
  sizeM: number;
  /** Handheld: centre of the grip box as a fraction of the item's height from its lower end (front view). */
  gripFrac?: number;
}

/**
 * Game-ready static item: metres, +Y up, one material, plus a convex hull node
 * named `*-convcolonly` that Godot turns into a StaticBody3D collision shape.
 * Handheld: origin at the grip centre, handle along +Y (business end up), the
 * drawn front facing +Z, its width along X. Pickup: origin at the centre of the
 * base, lowest point at y = 0.
 */
export interface Prop extends ArtifactBase {
  kind: "prop";
  category: PropCategory;
  item: string;
  glbUrl: string;
  /** Raw generator output, kept so a re-run of the fixes needs no new generation. */
  rawUrl: string;
  generator: string;
  triangles: number;
  sizeM: number;
  textureSize: number;
  /** Albedo pixels per metre of surface. */
  texelDensity: number;
  silhouette: Record<SheetViewName, number>;
  validator: { version: string; errors: number; warnings: number };
  /** godot --headless --import, then check_prop.gd on the imported scene. */
  godot: { version: string; importIssues: string[]; collisionShapes: number; hullPoints: number };
}

/** Inventory icon rendered from a Prop's mesh by a fixed orthographic 3/4 camera (no image model). */
export interface Icon extends ArtifactBase {
  kind: "icon";
  /** 512 x 512 and 64 x 64 RGBA, transparent background. */
  pngUrl: string;
  smallUrl: string;
  /** Longest side of the silhouette's bounding box / frame side (512 px render). */
  fill: number;
  /** Edge contrast of the 64 px icon on a dark and on a light inventory slot, CIELAB ΔL*. */
  contrast: { dark: number; light: number };
}

/** A handheld Prop parented to a rigged character's RightHand bone, with the walk. */
export interface EquippedProp extends ArtifactBase {
  kind: "equip";
  glbUrl: string;
  /** Run of the character the prop is equipped on. */
  characterRun: string;
  bone: "RightHand";
  animation: string;
  frames: number;
  /** Smallest distance between the item and the body (grip region excluded) over the clip, m. */
  minClearanceM: number;
  validator: { version: string; errors: number; warnings: number };
  godot: { version: string; importIssues: string[] };
}

export type Artifact = StyleGuide | TurnaroundSheet | Mesh | Skeleton | AnimClip | GltfAsset | UnrealAsset | Surface | WorldMap | Skybox | PropSheet | Prop | Icon | EquippedProp;

/**
 * What a step's input port accepts: another step's artifact, text from a
 * Text/Assistant node ("prompt"), or pictures from image nodes ("image").
 */
export type PortKind = ArtifactKind | "prompt" | "image";

export interface Port {
  /** Target handle id on the node; the request carries the port's value under it. */
  id: string;
  kind: PortKind;
  /** Shown on the handle and in "Connect a …" messages. */
  label: string;
  /** May stay unconnected. */
  optional?: boolean;
  /** Takes several wires (image references); every other port takes one. */
  many?: boolean;
}

export interface StepSpec {
  /** inputs[0] is the primary input: its artifact's run is the run the step writes into (no
   *  artifact there: a new run). Other artifact inputs (a style, the character an item is
   *  equipped on) may come from any run. */
  inputs: Port[];
  output: ArtifactKind;
  /** Spends kie.ai credits: refused before a job is created when no key is set. */
  kie?: boolean;
}

/** Optional on every step that asks an image model for a picture. */
export const STYLE_PORT: Port = { id: "style", kind: "style", label: "Style guide", optional: true };

/** Which artifacts each node consumes and emits — the canvas connection contract. */
export const STEP_IO: Record<ArtifactKind, StepSpec> = {
  style: {
    inputs: [{ id: "image", kind: "image", label: "Style references", many: true }, { id: "prompt", kind: "prompt", label: "Style notes (text)", optional: true }],
    output: "style",
  },
  turnaround: { inputs: [{ id: "prompt", kind: "prompt", label: "Character concept (text)" }, STYLE_PORT], output: "turnaround", kie: true },
  mesh: { inputs: [{ id: "turnaround", kind: "turnaround", label: "Turnaround sheet" }], output: "mesh" },
  skeleton: { inputs: [{ id: "mesh", kind: "mesh", label: "Mesh" }], output: "skeleton" },
  animclip: { inputs: [{ id: "skeleton", kind: "skeleton", label: "Rigged mesh" }], output: "animclip" },
  gltf: { inputs: [{ id: "animclip", kind: "animclip", label: "Animation set" }], output: "gltf" },
  unreal: { inputs: [{ id: "animclip", kind: "animclip", label: "Animation set" }], output: "unreal" },
  surface: { inputs: [{ id: "prompt", kind: "prompt", label: "Material (text)" }, STYLE_PORT], output: "surface", kie: true },
  worldmap: {
    inputs: [{ id: "prompt", kind: "prompt", label: "World (text)" }, { id: "image", kind: "image", label: "Layout sketch", optional: true }, STYLE_PORT],
    output: "worldmap",
    kie: true,
  },
  skybox: { inputs: [{ id: "prompt", kind: "prompt", label: "Sky (text)" }, STYLE_PORT], output: "skybox", kie: true },
  propsheet: { inputs: [{ id: "prompt", kind: "prompt", label: "Item (text)" }, STYLE_PORT], output: "propsheet", kie: true },
  prop: { inputs: [{ id: "propsheet", kind: "propsheet", label: "Prop sheet" }], output: "prop" },
  icon: { inputs: [{ id: "prop", kind: "prop", label: "Prop" }], output: "icon" },
  equip: {
    inputs: [{ id: "prop", kind: "prop", label: "Handheld item" }, { id: "skeleton", kind: "skeleton", label: "Character (rigged)" }],
    output: "equip",
  },
};

export function isArtifactPort(p: Port): p is Port & { kind: ArtifactKind } {
  return p.kind !== "prompt" && p.kind !== "image";
}

/** A step's input values: artifacts by port id, the Text input, the image references. */
export interface StepInputs {
  artifacts: Partial<Record<string, Artifact>>;
  text?: string;
  images?: string[];
}

export function blockingFailures(a: { checks: Check[] }): Check[] {
  return a.checks.filter((c) => !c.pass && !c.advisory);
}

/**
 * Whether a stored artifact has the shape the current code reads. Canvas nodes
 * keep artifacts across app updates; one made before its kind changed shape
 * (the single walk clip before the animation set) is treated as not made yet.
 */
export function hasCurrentShape(a: Artifact): boolean {
  switch (a.kind) {
    case "animclip": return Array.isArray(a.clips);
    case "gltf": return Array.isArray(a.godot?.clips);
    case "unreal": return Array.isArray(a.clips);
    default: return true;
  }
}

/** An artifact is consumable downstream only if it exists, has the current shape, and none of its blocking checks failed. */
export function accepts(input: Artifact | undefined, kind: ArtifactKind): { ok: true } | { ok: false; reason: string } {
  if (!input) return { ok: false, reason: `no ${kind} artifact yet — run the upstream node first` };
  if (input.kind !== kind) return { ok: false, reason: `expected a ${kind} artifact, got ${input.kind}` };
  if (!hasCurrentShape(input)) return { ok: false, reason: `the ${kind} was made by an older version — run it again` };
  const failed = blockingFailures(input);
  if (failed.length) return { ok: false, reason: `upstream ${kind} failed: ${failed.map((c) => c.id).join(", ")}` };
  return { ok: true };
}

/**
 * Whether `inputs` satisfy every port of `step`: required ports are filled and
 * every artifact present is of its port's kind with no failed blocking check.
 * The reason names the first port that falls short.
 */
export function checkStepInputs(step: ArtifactKind, inputs: StepInputs): { ok: true } | { ok: false; reason: string } {
  for (const p of STEP_IO[step].inputs) {
    if (p.kind === "prompt") {
      if (!p.optional && !inputs.text?.trim()) return { ok: false, reason: `Connect a text node: ${p.label}` };
    } else if (p.kind === "image") {
      if (!p.optional && !inputs.images?.length) return { ok: false, reason: `Connect at least one image: ${p.label}` };
    } else {
      const a = inputs.artifacts[p.id];
      if (!a && p.optional) continue;
      const ok = accepts(a, p.kind);
      if (!ok.ok) return ok;
    }
  }
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
  /** Jump: at the apex both feet clear the floor by at least this, meters (it must leave the ground). */
  minJumpClearanceM: 0.05,
  /** Jump: feet centre at the last vs the first frame, horizontal, meters (in-place one-shot). */
  maxJumpDriftM: 0.05,
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

/** Prop sheet (lib/game/prop.ts): the three views of one item. Fractions of the item's height unless noted. */
export const PROP_SHEET_BUDGET = {
  bgMaxNoise: SHEET_BUDGET.bgMaxNoise,
  /** Detached parts kept with a view (a cork, a chain link): minimum area as a fraction of the main part's. */
  minPartArea: 0.005,
  /** All three views show the same upright item at one scale: heights and lower ends agree. */
  maxHeightSpread: 0.04,
  maxBottomSpread: 0.03,
  minFrontBackIoU: 0.8,
  maxLightAsymmetry: SHEET_BUDGET.maxLightAsymmetry,
  /** Handheld: the item crosses the grip box in every view, at least over this fraction of the box height. */
  minGripCover: 0.6,
  /** The lighting check reads left vs mirrored right, so it only blocks on items whose front
   *  silhouette mirrors onto itself at least this well (a sword, a potion; not an axe). */
  minSymmetryForLighting: 0.9,
} as const;

/** Game-ready prop budgets, measured on the final .glb by scripts/game/bpy/prop_prepare.py and Godot. */
export const PROP_BUDGET = {
  /** Height in the views (handheld: handle length end to end), metres. */
  sizeM: { handheld: [0.3, 1.3], pickup: [0.05, 1.0] } as Record<PropCategory, [number, number]>,
  triangles: { handheld: [300, 4000], pickup: [200, 4000] } as Record<PropCategory, [number, number]>,
  textureSize: [512, 1024] as [number, number],
  maxMaterials: 1,
  /** Albedo px per metre of surface. The reference is the forest ranger d6eb0ddc
   *  (1024² albedo, 43.3% of it covered by UV islands, 2.66 m² of surface:
   *  413 px/m), so an item in the hand is as sharp as the hand holding it. */
  texelDensity: { ref: 413, tolerance: 0.25 },
  /** Handheld items are scaled so the handle in the grip box is this thick (mean of its front and
   *  side widths). The image model draws every handheld item about as long as the template's
   *  ruler, whatever it is; the handle is the one size all of them share. The ranger's closed
   *  fist measures 0.115 x 0.123 x 0.107 m (vertices weighted >= 0.5 to RightHand): a 4 cm
   *  handle disappears inside it. */
  gripDiameterM: 0.04,
  /** Mesh silhouette vs sheet view after alignment. Lower than the character's: a blade's
   *  edge-on side view is a few pixels wide, where one pixel of drift costs a lot of IoU. */
  minSilhouetteIoU: { front: 0.8, side: 0.65, back: 0.8 },
  /** Convex hull for the collision shape: vertex cap, and how far a mesh vertex may stick out of it (m). */
  maxHullPoints: 64,
  hullToleranceM: 0.002,
} as const;

/** Inventory icon (lib/game/prop.ts): fixed camera, measured framing and legibility. */
export const ICON_BUDGET = {
  size: 512,
  smallSize: 64,
  /** Longest side of the silhouette's bounding box / frame side. */
  fill: [0.55, 0.85] as [number, number],
  /** Silhouette bbox centre off the frame centre, fraction of the frame. */
  maxCentreOffset: 0.05,
  /** Inventory slot backgrounds (sRGB) the 64 px icon is read against. */
  slots: { dark: [32, 32, 36], light: [214, 210, 200] } as Record<"dark" | "light", [number, number, number]>,
  /** Mean |ΔL*| between the icon's outer ring of pixels and the slot. Advisory: not yet
   *  calibrated against people reading icons at 64 px. */
  minEdgeContrast: 20,
} as const;

/** Equipping a handheld prop (lib/game/prop.ts, scripts/game/godot/check_equip.gd). */
export const EQUIP_BUDGET = {
  /** Item to body every frame of the walk, metres; below it the item clips. The grip region (body
   *  within 6 cm of the item in the rest pose, check_equip.gd) is the hand holding it and excluded. */
  minClearanceM: 0.01,
  /** Item's transform vs the hand bone's over the walk: drift of the grip point, metres. */
  maxFollowErrorM: 0.001,
  /** Vertices weighted to RightHand at least this much are the fist: the grip centre (equip.py) and the drift check. */
  handWeight: 0.5,
} as const;

/**
 * Seamless surface material (lib/game/surface.ts). Steps are luminance
 * differences between pixel pairs; a seam is a line whose p95 step stands out
 * from the p95 of every other pair at the same spacing (1.0 = indistinguishable).
 */
export const SURFACE_BUDGET = {
  /** Texture sides engines mip down to 1x1 without padding. */
  sizes: [1024, 2048],
  /** World size one texture repeat covers; with `sizes` this fixes the texel density (512 or 1024 px/m). */
  tileM: 2,
  /** Wrap edges and the repair cuts: p95 step across them / p95 step anywhere. */
  maxSeamRatio: 1.5,
  /** Godot renders: the strongest tile-edge line (mean step across it / median line) over the
   *  strongest of the lines at 16 arbitrary offsets between edges in the same render. Content
   *  lines (plank joints, building edges) set the bar, as they mask a seam to the eye too. A
   *  test picture scored 1.9-3.9 with its raw wrap, 0.6-1.02 once repaired. */
  maxRenderSeamRatio: 1.15,
  /** Baked lighting in the picture as drawn: luminance plane fit, change across it / mean. The
   *  plane is divided out, but a picture lit this strongly also shades every stone or board from
   *  one side, which no plane removes. (On the final tile the fit only sees content: a tile that
   *  wraps cannot hold a linear light; a cobblestone run read 0.040 drawn, 0.052 tiled.) */
  maxLightingSlope: 0.05,
  /** Peak circular autocorrelation of the luminance at lags of at least 1/8 side, the larger
   *  of the tile (= its endless tiling) and the picture as drawn (a block the model drew
   *  twice). Advisory until calibrated: grain and plank rows correlate along their
   *  direction without being a visible repeat. */
  maxRepetition: 0.5,
} as const;

/**
 * World map picture (lib/game/maps.ts). Coastline agreement is the land IoU
 * between the mask and the picture segmented by colour (k-means in CIELAB,
 * each colour cluster labelled land or water by where most of its pixels fall
 * on the mask: the best any colour-only reading of the picture can agree).
 */
export const WORLDMAP_BUDGET = {
  /** The map screen's frame. */
  aspect: 16 / 9,
  maxAspectError: 0.02,
  /** Land share of a seeded mask. */
  seedLandShare: 0.38,
  /** A sketch that reads as less or more land than this is refused before anything is spent. */
  minLandShare: 0.04,
  maxLandShare: 0.92,
  /** Colour clusters of the picture for the segmentation. */
  segmentClusters: 8,
  minCoastIoU: 0.75,
  /** Tesseract words that count as text: confidence, letters, height as a share of the picture's. */
  ocrMinConf: 60,
  ocrMinLetters: 3,
  ocrMinHeight: 0.01,
  /** Tesseract reads dark text on flat paper; text on a map has any colour over busy ground. The
   *  picture is binarised at these luminance cuts, both polarities, and a word counts only if the
   *  same box is read under at least `ocrMinAgreement` of them: flat-coloured letters survive
   *  several cuts, brush texture read as letters doesn't. On the first maps: three overlaid labels
   *  all found, nothing on three clean maps; Tesseract on the plain picture found none of the labels. */
  ocrThresholds: [64, 96, 128, 160, 192, 224],
  ocrMinAgreement: 2,
  maxTextWords: 0,
} as const;

/**
 * Equirectangular sky (lib/game/maps.ts). Seam ratios use SURFACE_BUDGET's
 * definitions: p95 luminance step across the wrap / p95 step between all other
 * neighbouring columns on the panorama; in Godot's render, mean step across
 * the seam's screen column / median over all other columns (1.0 = invisible).
 */
export const SKYBOX_BUDGET = {
  /** Deliverable: 2:1, powers of two (engines mip and compress it without padding). */
  width: 2048,
  height: 1024,
  maxSeamRatio: 1.5,
  maxRenderSeamRatio: 1.3,
  /** Rows nearest each pole (share of the height) and their mean luminance std, 0–255:
   *  every row there collapses onto one point, so any variation along it pinches. */
  poleBand: 0.03,
  maxPoleStd: 12,
  /** Horizon (strongest change of the row-mean colour) off the vertical centre, share of the height.
   *  Advisory: the detector is uncalibrated against skylines and cloud banks. */
  maxHorizonOffset: 0.06,
  /** Guide lines copied into the picture (horizon, pole-cap edges, graticule): strength of a thin
   *  full-width line at those rows / the same at every row. Advisory, uncalibrated. */
  maxGuideResidue: 3,
  /** The same scenery drawn twice around the circle: peak circular autocorrelation of the
   *  luminance along the rows at lags of 1/8 turn or more (SURFACE_BUDGET.maxRepetition's
   *  measure, in one dimension). Advisory, uncalibrated. */
  maxRepetition: 0.5,
} as const;
