/**
 * Steps 2–5 of the character pipeline. Each takes the upstream artifact (already
 * accepted by `accepts`), writes its files into the same run folder and returns
 * the next artifact with its checks. Step 1 (turnaround) is in ./turnaround.ts.
 */
import { execFile } from "child_process";
import { existsSync } from "fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
import { promisify } from "util";
import { Client } from "@gradio/client";
import { validateBytes } from "gltf-validator";
import {
  BPY_BUDGET,
  CHARACTER_BUDGET,
  type AnimClip,
  type Check,
  type GltfAsset,
  type Mesh,
  type SheetViewName,
  type Skeleton,
  type TurnaroundSheet,
  type UnrealAsset,
} from "./artifacts";
import { DATA_DIR } from "../guest/paths";
import { makeZip } from "../makeZip";
import { pathForRunUrl, runPath, runUrl } from "./runs";
import { godotBin, godotCheck, runBlender, runUnrealScript, unrealEditorCmd } from "./tools";

const now = () => new Date().toISOString();

// ── Step 2: TurnaroundSheet → Mesh ──────────────────────────────────────────

/** Hunyuan3D-2mv (multi-view DiT, shape only) on Hugging Face ZeroGPU. */
export const MESH_SPACE = "tencent/Hunyuan3D-2mv";

export async function hunyuanMultiview(views: Record<SheetViewName, string>, out: string, hfToken?: string): Promise<void> {
  const client = await Client.connect(MESH_SPACE, hfToken ? { token: hfToken as `hf_${string}` } : {});
  const blob = async (p: string) => new Blob([await readFile(p)], { type: "image/png" });
  const res = await client.predict("/shape_generation", {
    caption: null,
    image: null,
    // Hunyuan's "left" view shows the character's left side, facing screen-left —
    // exactly the sheet's side view.
    mv_image_front: await blob(views.front),
    mv_image_back: await blob(views.back),
    mv_image_left: await blob(views.side),
    mv_image_right: null,
    steps: 30,
    guidance_scale: 5,
    seed: 1234,
    octree_resolution: 256,
    // Our views already carry an exact alpha from the sheet flood fill. With
    // rembg on, the Space flattens RGBA onto black first, and a dark costume on
    // black came back as a slab with the character embossed on it.
    check_box_rembg: false,
    num_chunks: 8000,
    randomize_seed: false,
  });
  const first = (res.data as Array<{ url?: string; value?: { url?: string } }>)[0];
  const url = first?.value?.url ?? first?.url;
  if (!url) throw new Error(`${MESH_SPACE} returned no mesh`);
  const file = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!file.ok) throw new Error(`mesh download failed: HTTP ${file.status}`);
  await writeFile(out, Buffer.from(await file.arrayBuffer()));
}

interface MeshReport {
  checks: Check[];
  final: { triangles: number; vertices: number; height_m: number; texture_size: number };
  silhouette_iou: Record<SheetViewName, number>;
}

export async function runMesh(sheet: TurnaroundSheet, opts: { heightM?: number; hfToken?: string; regenerate?: boolean } = {}): Promise<Mesh> {
  const t0 = Date.now();
  const id = sheet.runId;
  const views = Object.fromEntries(sheet.views.map((v) => [v.name, runPath(id, v.file)])) as Record<SheetViewName, string>;
  const raw = runPath(id, "mesh_raw.glb");
  // regenerate deletes the cached raw mesh up front, so a resumed job (always
  // regenerate: false) keeps a mesh the interrupted attempt already received.
  if (opts.regenerate) await rm(raw, { force: true });
  let gpu: string | undefined;
  if (!existsSync(raw)) {
    await hunyuanMultiview(views, raw, opts.hfToken);
    gpu = `${MESH_SPACE} (HF ZeroGPU)`;
  }
  const report = await runBlender<MeshReport>("mesh_prepare", {
    raw, views, height_m: opts.heightM ?? 1.8, target_tris: 16_000, texture_size: 1024,
    out_glb: runPath(id, "mesh.glb"), budget: BPY_BUDGET,
  });
  await runBlender("preview", { glb: runPath(id, "mesh.glb"), out_png: runPath(id, "mesh_preview.png") });
  return {
    kind: "mesh", runId: id, parent: { kind: "turnaround", url: sheet.sheetUrl },
    glbUrl: runUrl(id, "mesh.glb"), rawUrl: runUrl(id, "mesh_raw.glb"), previewUrl: runUrl(id, "mesh_preview.png"),
    generator: MESH_SPACE, hands: sheet.hands,
    triangles: report.final.triangles, vertices: report.final.vertices, heightM: report.final.height_m,
    textureSize: report.final.texture_size, silhouette: report.silhouette_iou,
    checks: report.checks, createdAt: now(), cost: { seconds: (Date.now() - t0) / 1000, gpuProvider: gpu },
  };
}

// ── Step 3: Mesh → Skeleton ─────────────────────────────────────────────────

interface RigReport {
  checks: Check[];
  bones?: string[];
  skin_method?: "bone_heat" | "voxel_proxy";
  arm_angle_deg?: { Left: number; Right: number };
}

export async function runSkeleton(mesh: Mesh): Promise<Skeleton> {
  const t0 = Date.now();
  const id = mesh.runId;
  const report = await runBlender<RigReport>("rig", {
    mesh_glb: pathForRunUrl(mesh.glbUrl), out_blend: runPath(id, "rigged.blend"), out_glb: runPath(id, "rigged.glb"),
    budget: BPY_BUDGET, hands: mesh.hands ?? "open",
  });
  return {
    kind: "skeleton", runId: id, parent: { kind: "mesh", url: mesh.glbUrl },
    glbUrl: runUrl(id, "rigged.glb"), blendUrl: runUrl(id, "rigged.blend"), previewUrl: mesh.previewUrl,
    profile: "godot-humanoid", bones: report.bones ?? [], skinMethod: report.skin_method ?? "bone_heat",
    armAngleDeg: { left: report.arm_angle_deg?.Left ?? NaN, right: report.arm_angle_deg?.Right ?? NaN },
    checks: report.checks, createdAt: now(), cost: { seconds: (Date.now() - t0) / 1000 },
  };
}

// ── Step 4: Skeleton → AnimClip (the animation set) ─────────────────────────

// CMU Graphics Lab Motion Capture Database (mocap.cs.cmu.edu), BVH conversions
// by Bruce Hahne (cgspeed), all 120 fps.
/** Subject 02 trial 01, "walk". */
export const WALK_SOURCE = "scripts/game/mocap/cmu_02_01_walk.bvh";
/** Subject 140 trial 06, "Idle": standing, weight shifting between the feet. */
export const IDLE_SOURCE = "scripts/game/mocap/cmu_140_06_idle.bvh";
/** Subject 02 trial 03, "run/jog" (the walk's actor). */
export const RUN_SOURCE = "scripts/game/mocap/cmu_02_03_run.bvh";
/** Subject 16 trial 01, "jump": standing vertical jump, lands in place. */
export const JUMP_SOURCE = "scripts/game/mocap/cmu_16_01_jump.bvh";
const BVH_FPS = 120;

/**
 * The set, in export order, fixed before the first run. Loops are cut where the
 * pose repeats best within `periodS` seconds; the jump is a fixed window of its
 * trial (standing → crouch → flight → landing → standing). `moves`: face along
 * the hips' travel (else along the hips' facing); `contact`: plant the feet the
 * source has on its floor and check they stay down.
 */
const ANIM_SET = [
  { name: "idle-loop", source: IDLE_SOURCE, loop: true, moves: false, contact: true, periodS: [3, 8] },
  { name: "walk-loop", source: WALK_SOURCE, loop: true, moves: true, contact: false, periodS: [0.8, 1.5] },
  { name: "run-loop", source: RUN_SOURCE, loop: true, moves: true, contact: false, periodS: [0.5, 1.0] },
  { name: "jump", source: JUMP_SOURCE, loop: false, moves: false, contact: true, windowS: [0.2, 2.2] },
] as const;
const ANIM_FPS = 30;

interface AnimReport { checks: Check[]; clips: { name: string; frames: number; fps: number }[] }

export async function runAnimClip(skel: Skeleton): Promise<AnimClip> {
  const t0 = Date.now();
  const id = skel.runId;
  const report = await runBlender<AnimReport>("retarget", {
    rigged_blend: pathForRunUrl(skel.blendUrl), fps: ANIM_FPS,
    clips: ANIM_SET.map((c) => ({
      name: c.name, bvh: join(process.cwd(), c.source), bvh_fps: BVH_FPS, loop: c.loop, moves: c.moves, contact: c.contact,
      ...("periodS" in c ? { period_s: c.periodS } : { window_s: c.windowS }),
    })),
    out_blend: runPath(id, "anim.blend"), out_glb: runPath(id, "anim.glb"), budget: BPY_BUDGET,
  });
  await runBlender("preview", { glb: runPath(id, "anim.glb"), out_png: runPath(id, "anim_preview.png"), action: "walk-loop", frame: 8 });
  const frames = new Map(report.clips.map((c) => [c.name, c]));
  return {
    kind: "animclip", runId: id, parent: { kind: "skeleton", url: skel.glbUrl },
    glbUrl: runUrl(id, "anim.glb"), blendUrl: runUrl(id, "anim.blend"), previewUrl: runUrl(id, "anim_preview.png"),
    clips: ANIM_SET.map((c) => ({ name: c.name, source: c.source, frames: frames.get(c.name)!.frames, fps: ANIM_FPS, loop: c.loop })),
    checks: report.checks, createdAt: now(), cost: { seconds: (Date.now() - t0) / 1000 },
  };
}

// ── Step 5: AnimClip → GltfAsset (the external checks) ──────────────────────

const run = promisify(execFile);

export async function runGltf(clip: AnimClip, opts: { name?: string } = {}): Promise<GltfAsset> {
  const t0 = Date.now();
  const id = clip.runId;
  const name = (opts.name ?? "character").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character";
  const file = `${name}.glb`;
  const out = runPath(id, file);
  await copyFile(pathForRunUrl(clip.glbUrl), out);
  const checks: Check[] = [];

  // Khronos glTF-Validator.
  const v = await validateBytes(new Uint8Array(await readFile(out)), { uri: file, maxIssues: 0 });
  const issues = v.issues;
  checks.push({
    id: "gltf.validator.errors", pass: issues.numErrors === 0, value: issues.numErrors, limit: 0,
    detail: issues.messages.filter((m: { severity: number }) => m.severity === 0).map((m: { code: string }) => m.code).join(", ") || undefined,
  });
  checks.push({
    id: "gltf.validator.warnings", pass: issues.numWarnings === 0, value: issues.numWarnings, limit: 0, advisory: true,
    detail: issues.messages.filter((m: { severity: number }) => m.severity === 1).map((m: { code: string }) => m.code).join(", ") || undefined,
  });

  // Godot: headless import, then play + CPU-skin every frame of every clip.
  const godotVersion = (await run(godotBin(), ["--version"])).stdout.trim();
  const g = await godotCheck(out, name);
  const c = g.character;
  checks.push({ id: "godot.import.clean", pass: g.importLog.length === 0, value: g.importLog.length, limit: 0, detail: g.importLog.slice(0, 5).join(" | ") || undefined });
  checks.push({ id: "godot.loaded", pass: !!c, detail: c ? undefined : "check_character.gd produced no result" });
  const godotClips = c?.clips ?? [];
  if (c) {
    // Godot strips the "-loop" suffix and imports those clips looping.
    const want = clip.clips.map((x) => ({ ...x, godotName: x.name.replace(/-loop$/, "") }));
    const played = new Map(godotClips.map((x) => [x.animation, x]));
    checks.push({
      id: "godot.clips", pass: godotClips.length === want.length && want.every((w) => played.has(w.godotName)),
      value: godotClips.length, limit: want.length, detail: godotClips.map((x) => x.animation).join(", ") || undefined,
    });
    for (const w of want) {
      const r = played.get(w.godotName);
      if (!r) continue;
      const pre = `godot.${w.godotName}`;
      checks.push({ id: `${pre}.loop`, pass: r.loop === w.loop, value: r.loop ? "loop" : "once", limit: w.loop ? "loop" : "once",
        detail: "Animation.loop_mode after import (LOOP_LINEAR for -loop clips)" });
      if (w.loop) {
        checks.push({ id: `${pre}.loop_seam`, pass: r.loop_seam_deg <= CHARACTER_BUDGET.maxLoopSeamDeg,
          value: +r.loop_seam_deg.toFixed(3), limit: CHARACTER_BUDGET.maxLoopSeamDeg,
          detail: `first vs last key over the imported tracks, degrees (hips ${(1000 * r.loop_seam_m).toFixed(1)} mm)` });
      }
      checks.push({ id: `${pre}.no_tearing`, pass: r.max_stretch <= CHARACTER_BUDGET.maxEdgeStretch,
        value: +r.max_stretch.toFixed(3), limit: CHARACTER_BUDGET.maxEdgeStretch,
        detail: `${r.frames} frames skinned from Godot's imported Skin/Skeleton3D; ${r.edges_over_2x} edges over 2x` });
      checks.push({ id: `${pre}.no_cracks`, pass: r.max_seam_gap <= CHARACTER_BUDGET.maxSeamGapFrac,
        value: +r.max_seam_gap.toFixed(5), limit: CHARACTER_BUDGET.maxSeamGapFrac,
        detail: `${c.seam_pairs} vertex pairs sharing a rest position (UV/normal seams); max gap over the clip / height` });
    }
    checks.push({ id: "godot.influences", pass: (c.max_influences ?? 99) <= CHARACTER_BUDGET.maxInfluences, value: c.max_influences, limit: CHARACTER_BUDGET.maxInfluences });
  }

  // Blender: independent budget measurement of the file.
  const b = await runBlender<{ checks: Check[] }>("check_budgets", { glb: out, budget: BPY_BUDGET });
  checks.push(...b.checks);

  return {
    kind: "gltf", runId: id, parent: { kind: "animclip", url: clip.glbUrl },
    glbUrl: runUrl(id, file), previewUrl: clip.previewUrl,
    validator: { version: v.validatorVersion, errors: issues.numErrors, warnings: issues.numWarnings, infos: issues.numInfos, hints: issues.numHints },
    godot: {
      version: godotVersion, importIssues: g.importLog,
      clips: godotClips.map((r) => ({ name: r.animation, loop: r.loop, frames: r.frames, maxStretch: r.max_stretch, maxSeamGap: r.max_seam_gap, loopSeamDeg: r.loop_seam_deg })),
    },
    checks, createdAt: now(), cost: { seconds: (Date.now() - t0) / 1000 },
  };
}

// ── Step 5 (Unreal): AnimClip → UnrealAsset ──────────────────────────────────

export const MANNY_SPEC = "scripts/game/unreal/manny.json";
/** SKM_Manny_Simple's reference pose, dumped from Unreal 5.8 by scripts/game/unreal/dump_manny.py. */
export const MANNY_REF = "scripts/game/unreal/manny_ref.json";

/** SK_Mannequin and the Manny clips played on each character in the engine check (Third Person template content). */
export const MANNY_SKELETON = "/Game/Characters/Mannequins/Meshes/SK_Mannequin";
const MANNY_CLIPS = [
  "/Game/Characters/Mannequins/Anims/Unarmed/MM_Idle",
  "/Game/Characters/Mannequins/Anims/Unarmed/Walk/MF_Unarmed_Walk_Fwd",
  "/Game/Characters/Mannequins/Anims/Unarmed/Jog/MF_Unarmed_Jog_Fwd",
  "/Game/Characters/Mannequins/Anims/Unarmed/Jump/MM_Jump",
];

interface UnrealExportReport {
  bones: string[];
  clips: { name: string; frames: number; fbx_frames: number; fbx: string }[];
  rest: Record<string, number[][]>;
  checks: Check[];
}

export async function runUnreal(clip: AnimClip, opts: { name?: string } = {}): Promise<UnrealAsset> {
  const t0 = Date.now();
  const id = clip.runId;
  const name = (opts.name ?? "character").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "character";
  const file = `${name}.fbx`;
  const meshFbx = runPath(id, file);
  const report = await runBlender<UnrealExportReport>("unreal_export", {
    anim_blend: pathForRunUrl(clip.blendUrl), manny: join(process.cwd(), MANNY_SPEC), manny_ref: join(process.cwd(), MANNY_REF),
    clips: clip.clips.map((c) => c.name), out_fbx: meshFbx, budget: BPY_BUDGET,
  });
  const checks = [...report.checks];
  const texture = `${name}_albedo.png`;

  // Unreal itself, when installed: import the mesh and clips the way a user
  // would, import the mesh onto Manny's own skeleton, and measure every clip
  // (ours and Manny's) as the engine poses it.
  let unreal: UnrealAsset["unreal"];
  const editor = unrealEditorCmd();
  if (editor) {
    const cache = join(DATA_DIR, "unreal");
    const dest = `/Game/Import/${name.replace(/-/g, "_")}`;
    const own = await runUnrealScript("import_check", {
      fbx: meshFbx, anim_fbx: Object.fromEntries(report.clips.map((c) => [c.name, c.fbx])), dest, fps: ANIM_FPS,
    }, cache);
    const manny = await runUnrealScript("import_check", {
      fbx: meshFbx, dest: `${dest}_manny`, skeleton: MANNY_SKELETON, anims: MANNY_CLIPS, fps: ANIM_FPS,
    }, cache);
    const dir = await mkdtemp(join(tmpdir(), "bnr-uev-"));
    try {
      const files = { own: join(dir, "own.json"), manny: join(dir, "manny.json"), rest: join(dir, "rest.json") };
      await writeFile(files.own, JSON.stringify(own.report));
      await writeFile(files.manny, JSON.stringify(manny.report));
      await writeFile(files.rest, JSON.stringify(report.rest));
      const v = await runBlender<{ checks: Check[]; manny: Record<string, { stretch: number; lowest_m: number }> }>("unreal_verify", {
        mesh_fbx: meshFbx, ...files, manny_skeleton: MANNY_SKELETON, budget: BPY_BUDGET,
      });
      checks.push(...v.checks);
      unreal = { version: own.engine, importIssues: [...new Set([...own.log, ...manny.log])], manny: v.manny };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  } else {
    checks.push({ id: "unreal.engine", pass: true, advisory: true, detail: "Unreal Engine not installed: the files were not imported into Unreal (set UNREAL_EDITOR_CMD)" });
  }

  const zipName = `${name}_unreal.zip`;
  const entries = [file, texture, ...report.clips.map((c) => basename(c.fbx))]
    .filter((f) => existsSync(runPath(id, f)));
  const zip = makeZip(await Promise.all(entries.map(async (f) => ({ name: f, data: new Uint8Array(await readFile(runPath(id, f))) }))));
  await writeFile(runPath(id, zipName), Buffer.from(await zip.arrayBuffer()));

  return {
    kind: "unreal", runId: id, parent: { kind: "animclip", url: clip.glbUrl },
    fbxUrl: runUrl(id, file), zipUrl: runUrl(id, zipName), previewUrl: clip.previewUrl,
    bones: report.bones,
    clips: report.clips.map((c) => ({ name: c.name, frames: c.fbx_frames, fbxUrl: runUrl(id, basename(c.fbx)) })),
    fps: ANIM_FPS, unreal, checks, createdAt: now(), cost: { seconds: (Date.now() - t0) / 1000 },
  };
}
