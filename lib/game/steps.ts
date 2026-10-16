/**
 * Steps 2–5 of the character pipeline. Each takes the upstream artifact (already
 * accepted by `accepts`), writes its files into the same run folder and returns
 * the next artifact with its checks. Step 1 (turnaround) is in ./turnaround.ts.
 */
import { execFile } from "child_process";
import { existsSync } from "fs";
import { copyFile, readFile, writeFile } from "fs/promises";
import { join } from "path";
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
} from "./artifacts";
import { pathForRunUrl, runPath, runUrl } from "./runs";
import { godotBin, godotCheck, runBlender } from "./tools";

const now = () => new Date().toISOString();

// ── Step 2: TurnaroundSheet → Mesh ──────────────────────────────────────────

/** Hunyuan3D-2mv (multi-view DiT, shape only) on Hugging Face ZeroGPU. */
export const MESH_SPACE = "tencent/Hunyuan3D-2mv";

async function hunyuanMultiview(views: Record<SheetViewName, string>, out: string, hfToken?: string): Promise<void> {
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
  let gpu: string | undefined;
  if (opts.regenerate || !existsSync(raw)) {
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
    generator: MESH_SPACE,
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
    budget: BPY_BUDGET,
  });
  return {
    kind: "skeleton", runId: id, parent: { kind: "mesh", url: mesh.glbUrl },
    glbUrl: runUrl(id, "rigged.glb"), blendUrl: runUrl(id, "rigged.blend"), previewUrl: mesh.previewUrl,
    profile: "godot-humanoid", bones: report.bones ?? [], skinMethod: report.skin_method ?? "bone_heat",
    armAngleDeg: { left: report.arm_angle_deg?.Left ?? NaN, right: report.arm_angle_deg?.Right ?? NaN },
    checks: report.checks, createdAt: now(), cost: { seconds: (Date.now() - t0) / 1000 },
  };
}

// ── Step 4: Skeleton → AnimClip ─────────────────────────────────────────────

/** CMU Graphics Lab Motion Capture Database, subject 02 trial 01 (walk), BVH conversion. */
export const WALK_SOURCE = "scripts/game/mocap/cmu_02_01_walk.bvh";

interface AnimReport { checks: Check[]; frames: number; fps: number; clip: string }

export async function runAnimClip(skel: Skeleton): Promise<AnimClip> {
  const t0 = Date.now();
  const id = skel.runId;
  const name = "walk-loop";
  const report = await runBlender<AnimReport>("retarget", {
    rigged_blend: pathForRunUrl(skel.blendUrl), bvh: join(process.cwd(), WALK_SOURCE), bvh_fps: 120,
    clip_name: name, fps: 30, out_blend: runPath(id, "anim.blend"), out_glb: runPath(id, "anim.glb"),
    budget: BPY_BUDGET,
  });
  await runBlender("preview", { glb: runPath(id, "anim.glb"), out_png: runPath(id, "anim_preview.png"), frame: 8 });
  return {
    kind: "animclip", runId: id, parent: { kind: "skeleton", url: skel.glbUrl },
    glbUrl: runUrl(id, "anim.glb"), blendUrl: runUrl(id, "anim.blend"), previewUrl: runUrl(id, "anim_preview.png"),
    name, source: WALK_SOURCE, frames: report.frames, fps: report.fps,
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

  // Godot: headless import, then play + CPU-skin every frame.
  const godotVersion = (await run(godotBin(), ["--version"])).stdout.trim();
  const g = await godotCheck(out, name);
  const w = g.walk;
  checks.push({ id: "godot.import.clean", pass: g.importLog.length === 0, value: g.importLog.length, limit: 0, detail: g.importLog.slice(0, 5).join(" | ") || undefined });
  checks.push({ id: "godot.walk.loaded", pass: !!w, detail: w ? undefined : "check_walk.gd produced no result" });
  if (w) {
    checks.push({ id: "godot.walk.loops", pass: !!w.loop, value: w.animation, detail: "clip imported with loop_mode = LOOP_LINEAR" });
    checks.push({ id: "godot.walk.no_tearing", pass: (w.max_stretch ?? Infinity) <= CHARACTER_BUDGET.maxEdgeStretch,
      value: w.max_stretch !== undefined ? +w.max_stretch.toFixed(3) : undefined, limit: CHARACTER_BUDGET.maxEdgeStretch,
      detail: `${w.frames} frames skinned from Godot's imported Skin/Skeleton3D; ${w.edges_over_2x} edges over 2x` });
    checks.push({ id: "godot.walk.no_cracks", pass: (w.max_seam_gap ?? Infinity) <= CHARACTER_BUDGET.maxSeamGapFrac,
      value: w.max_seam_gap !== undefined ? +w.max_seam_gap.toFixed(5) : undefined, limit: CHARACTER_BUDGET.maxSeamGapFrac,
      detail: `${w.seam_pairs} vertex pairs sharing a rest position (UV/normal seams); max gap over the clip / height` });
    checks.push({ id: "godot.walk.influences", pass: (w.max_influences ?? 99) <= CHARACTER_BUDGET.maxInfluences, value: w.max_influences, limit: CHARACTER_BUDGET.maxInfluences });
  }

  // Blender: independent budget measurement of the file.
  const b = await runBlender<{ checks: Check[] }>("check_budgets", { glb: out, budget: BPY_BUDGET });
  checks.push(...b.checks);

  return {
    kind: "gltf", runId: id, parent: { kind: "animclip", url: clip.glbUrl },
    glbUrl: runUrl(id, file), previewUrl: clip.previewUrl,
    validator: { version: v.validatorVersion, errors: issues.numErrors, warnings: issues.numWarnings, infos: issues.numInfos, hints: issues.numHints },
    godot: { version: godotVersion, importIssues: g.importLog, animation: w?.animation, loop: w?.loop, frames: w?.frames, maxStretch: w?.max_stretch },
    checks, createdAt: now(), cost: { seconds: (Date.now() - t0) / 1000 },
  };
}
