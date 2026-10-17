/**
 * Items and weapons as 3D props:
 *
 *   item text → PropSheet → Prop (mesh, collision hull) → Icon
 *                               ↘ EquippedProp (handheld, on a rigged character's right fist)
 *
 * The sheet is drawn over a layout template (scripts/game/bpy/prop_template.py)
 * with a metre ruler and (handheld) a fist-sized box where the hand closes,
 * which becomes the prop's pivot. Pickups keep the ruler's scale; handheld
 * items are scaled by their handle (see PROP_BUDGET.gripDiameterM for why).
 */
import { execFile } from "child_process";
import { existsSync } from "fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { validateBytes } from "gltf-validator";
import sharp from "sharp";
import {
  EQUIP_BUDGET,
  ICON_BUDGET,
  PROP_BUDGET,
  PROP_SHEET_BUDGET,
  type Check,
  type EquippedProp,
  type Icon,
  type Prop,
  type PropCategory,
  type PropSheet,
  type SheetView,
  type SheetViewName,
  type Skeleton,
  type StyleGuide,
} from "./artifacts";
import { generateKieImage } from "./kieImage";
import { pathForRunUrl, runDir, runPath, runUrl } from "./runs";
import { components, lightingAsymmetry, segment, silhouetteIoU, writeView, type Box, type Guide } from "./sheet";
import { hunyuanMultiview, MESH_SPACE, runAnimClip } from "./steps";
import { paletteFitCheck, stylePrompt, styleRefFiles } from "./style";
import { godotBin, runBlender } from "./tools";

const now = () => new Date().toISOString();

// ── Step 1: item text → PropSheet ───────────────────────────────────────────

/** 8 credits a 1K picture (nano-banana-pro: 18 at 2K). 1K is enough: a 1 m item spans ~600 px,
 *  ~1.5x the texel density the prop is baked at (PROP_BUDGET.texelDensity). */
export const PROP_SHEET_MODEL = "nano-banana-2";

/**
 * Template layout, in sheet fractions (u across, v down) and metres. The frame
 * is `frame_m` tall, the baseline (0 m on the ruler) at `baseline_v`; the three
 * views are centred on `slots_u` and split at ±`slot_half_u`. Handheld: the grip
 * box (`band_m` = fist width x height) is centred `grip_m` above the baseline,
 * which leaves room below it for a pommel or a handle end. Pickup: a smaller
 * frame (a potion is 20 cm, a chest 60 cm) with a ground line under the views.
 */
export const PROP_LAYOUT = {
  handheld: { frame_m: 1.6, baseline_v: 0.92, slots_u: [0.27, 0.55, 0.83], slot_half_u: 0.13, ruler_u: 0.05, ruler_m: 1.0, grip_m: 0.3, band_m: [0.11, 0.09] },
  pickup: { frame_m: 1.2, baseline_v: 0.9, slots_u: [0.27, 0.55, 0.83], slot_half_u: 0.13, ruler_u: 0.05, ruler_m: 1.0, ground_u: [0.13, 0.97] },
} as const;

/** The grip box as prop_template.py renders it (sRGB), so a copy of it in the picture reads as background. */
const BAND_RGB: [number, number, number] = [255, 196, 108];

const TEMPLATE_SIZE = { width: 1536, height: 1024 };

const VIEW_ORDER: SheetViewName[] = ["front", "side", "back"];

export function propSheetPrompt(item: string, category: PropCategory, style?: StyleGuide): string {
  const what = item.trim().replace(/\.$/, "");
  const handheld = category === "handheld";
  return [
    handheld
      ? `Prop turnaround sheet of ${what}, a one-handed item for a 3D game, at real-world size for a human character.`
      : `Prop turnaround sheet of ${what}, an item lying in a 3D game world for the player to pick up, at real-world size next to a human character.`,
    handheld
      ? "Attached image 1 is the layout guide. Draw the same item three times, standing upright with the handle vertical and the business end (blade, head, flame) pointing up: front view (its widest side facing the viewer) on the left, the same item turned 90 degrees to show its left side in the middle, back view on the right, one view centred on each orange box."
      : "Attached image 1 is the layout guide. Draw the same item three times, resting upright on its base on the grey ground line: front view on the left, the same item turned 90 degrees to show its left side in the middle, back view on the right, evenly spaced.",
    handheld
      ? "The orange boxes mark where a character's closed fist holds the item: the middle of the grip passes vertically through each orange box, at the same height in every view."
      : "",
    "The ruler on the left is 1 metre tall with a tick every 10 cm, standing on the same baseline: draw the item at its real size against that ruler, the same size and height in all three views, leaving empty space above it if it is short. Orthographic, no perspective.",
    handheld
      ? "Real lengths for scale: a one-handed sword about 0.9 m (up to the ninth tick), a hand axe, hammer or mace about 0.6 m, a torch about 0.5 m, a dagger about 0.35 m."
      : "Real heights for scale: a potion bottle about 0.2 m (up to the second tick), a coin pouch about 0.15 m, a lantern about 0.3 m, a small chest about 0.4 m.",
    style
      ? "Take only layout, scale and camera from the guide; the item's design and colours come from the description."
      : "Take only layout, scale and camera from the guide; the item's design, colours and style come from the description.",
    stylePrompt(style, 2),
    handheld ? "Only the item: no hand, no character, no stand, no sheath, nothing attached." : "Only the item: no character, no stand, no pedestal, nothing around it.",
    "Flat, even, unlit albedo shading: no shadows, no ambient occlusion, no rim light, no specular highlights, no gradients from a light direction.",
    "Plain pure white background (#FFFFFF) everywhere, no ground shadow, no floor, no text, no labels, no arrows, no borders, no color swatches. Do not draw the ruler, the guide boxes or the ground line.",
  ].filter(Boolean).join(" ");
}

export async function renderPropTemplate(category: PropCategory, outPng: string): Promise<void> {
  await runBlender("prop_template", { out_png: outPng, category, layout: PROP_LAYOUT[category], ...TEMPLATE_SIZE });
}

export interface PropSheetAnalysis {
  width: number;
  height: number;
  views: SheetView[];
  checks: Check[];
  sizeM: number;
  gripFrac?: number;
}

/**
 * Split a prop sheet into `front.png`, `side.png`, `back.png` in `outDir` and
 * check it. The views are found by the template's columns rather than by
 * counting figures: anything outside them (a copied ruler, captions) is
 * dropped, and a view is its largest part plus detached parts of some size.
 * Sizes are read with the template's scale (metres per pixel of the frame).
 */
export async function analyzePropSheet(sheetPath: string, outDir: string, category: PropCategory): Promise<PropSheetAnalysis> {
  const { data, info } = await sharp(sheetPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const L = PROP_LAYOUT[category];
  const mPerPx = L.frame_m / H;
  const rowOf = (m: number) => (L.baseline_v - m / L.frame_m) * H;
  const B = PROP_SHEET_BUDGET;

  // Grip boxes in pixels (handheld), with a margin for a model that drew them slightly off.
  const boxes = category === "handheld"
    ? L.slots_u.map((u) => {
        const halfW = PROP_LAYOUT.handheld.band_m[0] / 2 / mPerPx, halfH = PROP_LAYOUT.handheld.band_m[1] / 2 / mPerPx;
        const cy = rowOf(PROP_LAYOUT.handheld.grip_m);
        return { x0: Math.round(u * W - halfW), x1: Math.round(u * W + halfW), y0: Math.round(cy - halfH), y1: Math.round(cy + halfH) };
      })
    : [];
  const margin = Math.round(0.01 * W);
  const guides: Guide[] = boxes.map((b) => ({ rgb: BAND_RGB, x0: b.x0 - margin, x1: b.x1 + margin, y0: b.y0 - margin, y1: b.y1 + margin }));
  const { mask, bg, bgNoise, strokeRows } = segment(data, W, H, guides);
  const checks: Check[] = [];
  checks.push({ id: "propsheet.background.flat", pass: bgNoise <= B.bgMaxNoise, value: +bgNoise.toFixed(2), limit: B.bgMaxNoise, detail: `border median rgb(${bg.join(",")})` });
  checks.push({ id: "propsheet.background.no_strokes", pass: strokeRows === 0, value: strokeRows, limit: 0, advisory: true, detail: "rows of a copied ground line (removed before splitting)" });

  // One view per template column: the largest component whose centre is in it,
  // plus detached parts of some size touching its box grown by 5% of its
  // height (a cork above a flask; captions under the views are further off).
  // A view's box is its parts' extent, wherever the model drew it.
  const comps = components(mask);
  const keep = new Set<number>();
  const views: Box[] = [];
  let parts = 0;
  for (const u of L.slots_u) {
    const x0 = (u - L.slot_half_u) * W, x1 = (u + L.slot_half_u) * W;
    const mine = comps.filter((c) => (c.x0 + c.x1) / 2 >= x0 && (c.x0 + c.x1) / 2 < x1).sort((p, q) => q.area - p.area);
    if (!mine.length || mine[0].area < 0.0005 * W * H) continue;
    const m = mine[0], grow = 0.05 * (m.y1 - m.y0);
    const kept = mine.filter((c) => c.area >= B.minPartArea * m.area
      && c.x0 < m.x1 + grow && c.x1 > m.x0 - grow && c.y0 < m.y1 + grow && c.y1 > m.y0 - grow);
    for (const c of kept) keep.add(c.id);
    parts = Math.max(parts, kept.length);
    views.push({ x0: Math.min(...kept.map((c) => c.x0)), x1: Math.max(...kept.map((c) => c.x1)), y0: Math.min(...kept.map((c) => c.y0)), y1: Math.max(...kept.map((c) => c.y1)) });
  }
  const dropped = comps.filter((c) => !keep.has(c.id) && c.area >= 0.0005 * W * H).length;
  for (let i = 0; i < mask.fg.length; i++) mask.fg[i] = mask.fg[i] && keep.has(mask.label[i]) ? 1 : 0;
  checks.push({ id: "propsheet.views.extras_removed", pass: dropped === 0, value: dropped, limit: 0, advisory: true, detail: "marks outside the three views (a copied ruler, captions), removed" });
  checks.push({ id: "propsheet.views.count", pass: views.length === 3, value: views.length, limit: 3, detail: "one item in each of the template's three columns" });
  if (views.length !== 3) return { width: W, height: H, views: [], checks, sizeM: 0 };
  checks.push({ id: "propsheet.views.parts", pass: parts === 1, value: parts, limit: 1, advisory: true, detail: "separate pieces in a view (most in one view)" });

  const apart = views.every((v, k) => v.x0 > 1 && v.x1 < W - 1 && v.y0 > 1 && v.y1 < H - 1 && (k === 0 || v.x0 > views[k - 1].x1));
  checks.push({ id: "propsheet.views.separate", pass: apart, detail: "views side by side without overlapping, none cut off by the picture's edge" });
  const heights = views.map((v) => v.y1 - v.y0);
  const medH = [...heights].sort((p, q) => p - q)[1];
  const spread = (Math.max(...heights) - Math.min(...heights)) / medH;
  checks.push({ id: "propsheet.ortho.height", pass: spread <= B.maxHeightSpread, value: +spread.toFixed(3), limit: B.maxHeightSpread, detail: "view heights must match (orthographic, one scale)" });
  const bottoms = views.map((v) => v.y1);
  const bSpread = (Math.max(...bottoms) - Math.min(...bottoms)) / medH;
  checks.push({ id: "propsheet.ortho.bottom", pass: bSpread <= B.maxBottomSpread, value: +bSpread.toFixed(3), limit: B.maxBottomSpread, detail: "lower ends on one line" });
  const sizeM = +(medH * mPerPx).toFixed(4);
  const [lo, hi] = PROP_BUDGET.sizeM[category];
  // Handheld items came back drawn as long as the ruler or longer whatever they
  // were (hammer 1.03 m, mace 1.04 m, torch 1.33 m): the prop step sizes them by
  // their grip instead, so here the ruler reading is only reported.
  checks.push({
    id: "propsheet.size_m", pass: sizeM >= lo && sizeM <= hi, value: sizeM, limit: `${lo}–${hi}`, advisory: category === "handheld",
    detail: `${category === "handheld" ? "length" : "height"} at the ruler's scale`,
  });

  let gripFrac: number | undefined;
  if (category === "handheld") {
    // The handle must cross the grip box's rows in every view (the mesh step measures it there).
    const b = boxes[0];
    for (let k = 0; k < 3; k++) {
      const v = views[k];
      let covered = 0;
      for (let y = b.y0; y < b.y1; y++) {
        for (let x = v.x0; x < v.x1; x++) if (mask.fg[y * W + x]) { covered++; break; }
      }
      const cover = covered / (b.y1 - b.y0);
      checks.push({ id: `propsheet.grip.${VIEW_ORDER[k]}`, pass: cover >= B.minGripCover, value: +cover.toFixed(3), limit: B.minGripCover, detail: "share of the grip box's rows the item crosses" });
    }
    const f = views[0];
    gripFrac = +((f.y1 - rowOf(PROP_LAYOUT.handheld.grip_m)) / (f.y1 - f.y0)).toFixed(4);
  }

  const iou = silhouetteIoU(mask, views[0], views[2], true);
  checks.push({ id: "propsheet.back.matches_front", pass: iou >= B.minFrontBackIoU, value: +iou.toFixed(3), limit: B.minFrontBackIoU, detail: "mirrored back silhouette vs front (back-side drift)" });
  // The left/right luminance test assumes a mirror-symmetric subject; on an axe
  // it compares the steel head with the wooden haft. It blocks only when the
  // front silhouette is itself nearly symmetric.
  const symmetric = silhouetteIoU(mask, views[0], views[0], true);
  const asym = lightingAsymmetry(data, mask, views[0]);
  checks.push({
    id: "propsheet.lighting.flat", pass: asym <= B.maxLightAsymmetry, value: +asym.toFixed(3), limit: B.maxLightAsymmetry,
    advisory: symmetric < B.minSymmetryForLighting,
    detail: `left/right luminance asymmetry of the front view (directional light); front self-mirror IoU ${symmetric.toFixed(3)}`,
  });

  const out: SheetView[] = [];
  for (let k = 0; k < 3; k++) out.push(await writeView(data, mask, views[k], VIEW_ORDER[k], outDir));
  return { width: W, height: H, views: out, checks, sizeM, gripFrac };
}

interface SheetInfo { item: string; category: PropCategory; prompt: string; style?: string; model: string }

/**
 * Generate (or re-analyse for free, when the run has a sheet and `regenerate`
 * is false) the prop sheet. The template, and the item, category, prompt and
 * style actually sent, are kept beside it (template.png, propsheet.json): a
 * cached sheet is analysed as the category it was drawn for.
 */
export async function runPropSheet(opts: { runId: string; item: string; category: PropCategory; style?: StyleGuide; apiKey: string; regenerate?: boolean }): Promise<PropSheet> {
  const t0 = Date.now();
  const dir = await runDir(opts.runId);
  const sheet = join(dir, "sheet.png");
  const template = join(dir, "template.png");
  const infoFile = join(dir, "propsheet.json");
  if (opts.regenerate) {
    await rm(sheet, { force: true });
    await rm(`${sheet}.task`, { force: true });
  }
  let kieCredits: number | undefined = 0;
  if (!existsSync(sheet)) {
    if (!existsSync(`${sheet}.task`)) {
      await renderPropTemplate(opts.category, template);
      const sent: SheetInfo = { item: opts.item, category: opts.category, prompt: propSheetPrompt(opts.item, opts.category, opts.style), style: opts.style?.runId, model: PROP_SHEET_MODEL };
      await writeFile(infoFile, JSON.stringify(sent));
    }
    const sent = JSON.parse(await readFile(infoFile, "utf8")) as SheetInfo;
    kieCredits = await generateKieImage({
      model: sent.model, prompt: sent.prompt, images: [template, ...styleRefFiles(opts.style)],
      aspectRatio: "3:2", resolution: "1K", outFile: sheet, apiKey: opts.apiKey,
    });
  }
  const used = JSON.parse(await readFile(infoFile, "utf8")) as SheetInfo;
  const analysis = await analyzePropSheet(sheet, dir, used.category);
  const fit = used.style && used.style === opts.style?.runId ? await paletteFitCheck(sheet, opts.style) : undefined;
  return {
    kind: "propsheet", runId: opts.runId, item: used.item, category: used.category, prompt: used.prompt, model: used.model,
    styleRun: used.style, templateUrl: runUrl(opts.runId, "template.png"), sheetUrl: runUrl(opts.runId, "sheet.png"),
    previewUrl: runUrl(opts.runId, "sheet.png"), width: analysis.width, height: analysis.height, views: analysis.views,
    sizeM: analysis.sizeM, gripFrac: analysis.gripFrac,
    checks: fit ? [...analysis.checks, fit] : analysis.checks,
    createdAt: now(), cost: { seconds: (Date.now() - t0) / 1000, kieCredits },
  };
}

// ── Godot and glTF-Validator, shared by the prop and equip steps ───────────

const exec = promisify(execFile);
const GODOT_DIR = join(process.cwd(), "scripts", "game", "godot");

/**
 * Import `glbs` (file name → path) into res://<folder>/ of a throwaway copy of
 * scripts/game/godot, run `script` on them (`userArgs` after "--") and return
 * the import log's warnings/errors and the JSON lines the script printed.
 */
async function godotRun<T>(script: string, folder: string, glbs: Record<string, string>, userArgs: string[] = []): Promise<{ version: string; importLog: string[]; results: T[] }> {
  const proj = await mkdtemp(join(tmpdir(), "bnr-godot-prop-"));
  try {
    for (const f of ["project.godot", "preview.gd", "preview.tscn", script]) await copyFile(join(GODOT_DIR, f), join(proj, f));
    await mkdir(join(proj, folder));
    for (const [name, path] of Object.entries(glbs)) await copyFile(path, join(proj, folder, name));
    const bin = godotBin();
    const opts = { maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 };
    const settle = (e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" });
    const version = (await exec(bin, ["--version"])).stdout.trim();
    const imp = await exec(bin, ["--headless", "--import", "--path", proj], opts).catch(settle);
    const importLog = `${imp.stdout}\n${imp.stderr}`.split("\n").filter((l) => /warn|error/i.test(l)).map((l) => l.trim());
    const out = await exec(bin, ["--headless", "--path", proj, "-s", `res://${script}`, "--", ...userArgs], opts).catch(settle);
    const results = `${out.stdout}`.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as T);
    return { version, importLog, results };
  } finally {
    await rm(proj, { recursive: true, force: true });
  }
}

async function validateGlb(file: string): Promise<{ checks: Check[]; validator: { version: string; errors: number; warnings: number } }> {
  const v = await validateBytes(new Uint8Array(await readFile(file)), { uri: file.split("/").pop()!, maxIssues: 0 });
  const codes = (severity: number) => v.issues.messages.filter((m: { severity: number }) => m.severity === severity).map((m: { code: string }) => m.code).join(", ") || undefined;
  return {
    validator: { version: v.validatorVersion, errors: v.issues.numErrors, warnings: v.issues.numWarnings },
    checks: [
      { id: "gltf.validator.errors", pass: v.issues.numErrors === 0, value: v.issues.numErrors, limit: 0, detail: codes(0) },
      { id: "gltf.validator.warnings", pass: v.issues.numWarnings === 0, value: v.issues.numWarnings, limit: 0, advisory: true, detail: codes(1) },
    ],
  };
}

// ── Step 2: PropSheet → Prop ────────────────────────────────────────────────

/** Node name of the visual mesh in every prop .glb (its hull is `PropCollision-convcolonly`). */
export const PROP_NODE = "Prop";

interface PropReport {
  checks: Check[];
  final: { triangles: number; size_m: number; texture_size: number; texel_density: number };
  silhouette_iou: Record<SheetViewName, number>;
  hull: { points: number; scale: number };
}

interface GodotPropResult {
  file: string; ok: boolean; problems: string[]; meshes: number; triangles: number; materials: number;
  aabb: [[number, number, number], [number, number, number]]; bodies: number; shapes: number; hull_points: number; max_outside: number | null;
}

/**
 * Mesh the sheet with the character pipeline's Hunyuan3D-2mv call (unchanged:
 * 8 of 8 items came back as one watertight surface with every view's IoU >=
 * 0.81), then prop_prepare.py scales, pivots, bakes and adds the collision
 * hull, and Godot imports the result to prove the hull became a collision shape.
 */
export async function runProp(sheet: PropSheet, opts: { hfToken?: string; regenerate?: boolean } = {}): Promise<Prop> {
  const t0 = Date.now();
  const id = sheet.runId;
  const cat = sheet.category;
  const views = Object.fromEntries(sheet.views.map((v) => [v.name, runPath(id, v.file)])) as Record<SheetViewName, string>;
  const raw = runPath(id, "mesh_raw.glb");
  if (opts.regenerate) await rm(raw, { force: true });
  let gpu: string | undefined;
  if (!existsSync(raw)) {
    await hunyuanMultiview(views, raw, opts.hfToken);
    gpu = `${MESH_SPACE} (HF ZeroGPU)`;
  }
  const glb = runPath(id, "prop.glb");
  const report = await runBlender<PropReport>("prop_prepare", {
    raw, views, category: cat, size_m: sheet.sizeM,
    grip_frac: sheet.gripFrac ?? 0, grip_half_frac: PROP_LAYOUT.handheld.band_m[1] / 2 / sheet.sizeM,
    grip_diameter_m: PROP_BUDGET.gripDiameterM, target_tris: 3000, texel_density: PROP_BUDGET.texelDensity.ref,
    texture_sizes: [512, 1024], name: PROP_NODE, out_glb: glb, out_albedo: runPath(id, "prop_albedo.png"),
    budget: { ...PROP_BUDGET, sizeM: PROP_BUDGET.sizeM[cat], triangles: PROP_BUDGET.triangles[cat] },
  });
  await runBlender("preview", { glb, out_png: runPath(id, "prop_preview.png") });
  const checks = [...report.checks];
  const val = await validateGlb(glb);
  checks.push(...val.checks);

  const g = await godotRun<GodotPropResult>("check_prop.gd", "props", { "prop.glb": glb });
  const r = g.results[0];
  checks.push({ id: "godot.import.clean", pass: g.importLog.length === 0, value: g.importLog.length, limit: 0, detail: g.importLog.slice(0, 5).join(" | ") || undefined });
  checks.push({ id: "godot.prop.loaded", pass: !!r, detail: r ? undefined : "check_prop.gd produced no result" });
  if (r) {
    checks.push({ id: "godot.collision.created", pass: r.bodies >= 1 && r.shapes >= 1 && r.problems.length === 0, value: r.shapes,
      detail: r.problems.join("; ") || `StaticBody3D + CollisionShape3D (ConvexPolygonShape3D, ${r.hull_points} points) from the -convcolonly node` });
    checks.push({ id: "godot.collision.contains_mesh", pass: r.max_outside !== null && r.max_outside <= PROP_BUDGET.hullToleranceM,
      value: r.max_outside !== null ? +r.max_outside.toFixed(5) : undefined, limit: PROP_BUDGET.hullToleranceM,
      detail: "furthest visual vertex outside the imported hull, m" });
    checks.push({ id: "godot.materials", pass: r.materials <= PROP_BUDGET.maxMaterials, value: r.materials, limit: PROP_BUDGET.maxMaterials });
    // The pivot as the engine sees it: handheld origin inside the handle, pickup resting on y = 0.
    const [lo, hi] = r.aabb;
    const inside = [0, 1, 2].every((i) => lo[i] < 0 && hi[i] > 0);
    const pivot = cat === "handheld"
      ? { pass: inside, value: `y ${lo[1].toFixed(3)}..${hi[1].toFixed(3)}`, detail: "origin at the grip, inside the item's bounds on every axis" }
      : { pass: Math.abs(lo[1]) <= 0.001, value: +lo[1].toFixed(4), detail: "lowest point at y = 0" };
    checks.push({ id: "godot.pivot", ...pivot });
  }
  return {
    kind: "prop", runId: id, parent: { kind: "propsheet", url: sheet.sheetUrl }, category: cat, item: sheet.item,
    glbUrl: runUrl(id, "prop.glb"), rawUrl: runUrl(id, "mesh_raw.glb"), previewUrl: runUrl(id, "prop_preview.png"),
    generator: MESH_SPACE, triangles: report.final.triangles, sizeM: report.final.size_m, textureSize: report.final.texture_size,
    texelDensity: report.final.texel_density, silhouette: report.silhouette_iou,
    validator: val.validator,
    godot: { version: g.version, importIssues: g.importLog, collisionShapes: r?.shapes ?? 0, hullPoints: r?.hull_points ?? 0 },
    styleRun: sheet.styleRun, checks, createdAt: now(), cost: { seconds: (Date.now() - t0) / 1000, gpuProvider: gpu },
  };
}

// ── Step 3: Prop → Icon ─────────────────────────────────────────────────────

/** Longest side of the item / frame side the icon camera frames to (ICON_BUDGET.fill is checked on the picture). */
const ICON_FILL = 0.7;

/** CIELAB L* of an sRGB colour, channels 0–255. */
function lightness(r: number, g: number, b: number): number {
  const lin = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

/**
 * Render the icon (scripts/game/bpy/icon.py), downscale it to the inventory
 * size and measure it: framing on the 512 px render, legibility on the 64 px
 * one composited over a dark and a light slot (mean |ΔL*| along the outer ring
 * of the silhouette, where the item meets the slot).
 */
export async function runIcon(prop: Prop): Promise<Icon> {
  const t0 = Date.now();
  const id = prop.runId;
  const { size, smallSize } = ICON_BUDGET;
  const png = runPath(id, "icon.png");
  const small = runPath(id, "icon_64.png");
  const render = await runBlender<{ camera: { azimuth_deg: number; elevation_deg: number; roll_deg: number; ortho_scale: number } }>("icon", {
    glb: pathForRunUrl(prop.glbUrl), category: prop.category, size, fill: ICON_FILL, out_png: png,
  });
  await sharp(png).resize(smallSize, smallSize, { kernel: "lanczos3" }).png().toFile(small);
  const checks: Check[] = [];

  const big = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0: number = size, x1 = -1, y0: number = size, y1 = -1;
  for (let y = 0; y < big.info.height; y++) {
    for (let x = 0; x < big.info.width; x++) {
      if (big.data[(y * big.info.width + x) * 4 + 3] < 128) continue;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  const fill = x1 < 0 ? 0 : Math.max(x1 - x0 + 1, y1 - y0 + 1) / size;
  const offset = x1 < 0 ? 1 : Math.max(Math.abs((x0 + x1 + 1) / 2 - size / 2), Math.abs((y0 + y1 + 1) / 2 - size / 2)) / size;
  const [fLo, fHi] = ICON_BUDGET.fill;
  checks.push({ id: "icon.fill", pass: fill >= fLo && fill <= fHi, value: +fill.toFixed(3), limit: `${fLo}–${fHi}`, detail: "longest side of the silhouette's box / frame" });
  checks.push({ id: "icon.centred", pass: offset <= ICON_BUDGET.maxCentreOffset, value: +offset.toFixed(3), limit: ICON_BUDGET.maxCentreOffset, detail: "silhouette box centre off the frame centre / frame" });
  const c = render.camera;
  checks.push({ id: "icon.camera", pass: true, value: `az ${c.azimuth_deg}°, el ${c.elevation_deg}°, roll ${c.roll_deg}°`, detail: `fixed orthographic 3/4 camera for every ${prop.category} icon; ortho scale ${c.ortho_scale} m` });

  const px = await sharp(small).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = px.info.width, H = px.info.height, d = px.data;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && d[(y * W + x) * 4 + 3] >= 128;
  const ring: number[] = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (solid(x, y) && !(solid(x - 1, y) && solid(x + 1, y) && solid(x, y - 1) && solid(x, y + 1))) ring.push(y * W + x);
    }
  }
  const contrast = {} as Icon["contrast"];
  for (const slot of ["dark", "light"] as const) {
    const [sr, sg, sb] = ICON_BUDGET.slots[slot];
    const lSlot = lightness(sr, sg, sb);
    let sum = 0;
    for (const i of ring) {
      const a = d[i * 4 + 3] / 255;
      sum += Math.abs(lightness(d[i * 4] * a + sr * (1 - a), d[i * 4 + 1] * a + sg * (1 - a), d[i * 4 + 2] * a + sb * (1 - a)) - lSlot);
    }
    contrast[slot] = +(ring.length ? sum / ring.length : 0).toFixed(1);
    checks.push({
      id: `icon.contrast.${slot}`, pass: contrast[slot] >= ICON_BUDGET.minEdgeContrast, value: contrast[slot], limit: ICON_BUDGET.minEdgeContrast, advisory: true,
      detail: `${smallSize} px icon on rgb(${ICON_BUDGET.slots[slot].join(",")}): mean |ΔL*| along the silhouette's outer ring (${ring.length} px)`,
    });
  }
  return {
    kind: "icon", runId: id, parent: { kind: "prop", url: prop.glbUrl },
    pngUrl: runUrl(id, "icon.png"), smallUrl: runUrl(id, "icon_64.png"), previewUrl: runUrl(id, "icon.png"),
    fill: +fill.toFixed(3), contrast, styleRun: prop.styleRun,
    checks, createdAt: now(), cost: { seconds: (Date.now() - t0) / 1000 },
  };
}

// ── Step 4: Prop + Skeleton → EquippedProp ──────────────────────────────────

interface EquipReport { checks: Check[]; walk: string | null; clips: string[]; grip_centre: number[]; grip_axis: number[] }

interface GodotEquipResult {
  file: string; ok: boolean; problems: string[]; bone?: string; animation?: string; frames?: number; follow_err?: number;
  fist_drift?: number; min_clearance?: number; clearance_frame?: number; clearance_bone?: string; intersections?: number; grip_bones?: string[];
}

/**
 * Parent a handheld prop (from its own run) to the RightHand bone of a rigged
 * character (from the character's run) and play the walk in Godot with it.
 * The clips come from the character's walk step (its run's anim.blend) when
 * that is newer than the rig; otherwise the walk step is run for it first.
 * Unreal (not built): the same grip frame as a `hand_r` socket on SK_Mannequin,
 * i.e. this prop offset re-expressed in hand_r's bone axes (X along the bone),
 * and the hull as a `UCX_` mesh instead of `-convcolonly`.
 */
export async function runEquip(prop: Prop, skel: Skeleton): Promise<EquippedProp> {
  if (prop.category !== "handheld") throw new Error(`Equip takes a handheld prop: "${prop.item}" is a ${prop.category} item`);
  const t0 = Date.now();
  const id = prop.runId;
  const rigged = pathForRunUrl(skel.blendUrl);
  let anim = runPath(skel.runId, "anim.blend");
  if (!existsSync(anim) || (await stat(anim)).mtimeMs < (await stat(rigged)).mtimeMs) anim = pathForRunUrl((await runAnimClip(skel)).blendUrl);
  const out = runPath(id, "equipped.glb");
  const rep = await runBlender<EquipReport>("equip", {
    anim_blend: anim, prop_glb: pathForRunUrl(prop.glbUrl), hand_weight: EQUIP_BUDGET.handWeight, out_glb: out,
  });
  await runBlender("preview", { glb: out, out_png: runPath(id, "equip_preview.png"), frame: 8 });
  const checks = [...rep.checks];
  const val = await validateGlb(out);
  checks.push(...val.checks);

  const g = await godotRun<GodotEquipResult>("check_equip.gd", "equip", { "equipped.glb": out }, [String(EQUIP_BUDGET.handWeight)]);
  const r = g.results[0];
  checks.push({ id: "godot.import.clean", pass: g.importLog.length === 0, value: g.importLog.length, limit: 0, detail: g.importLog.slice(0, 5).join(" | ") || undefined });
  checks.push({ id: "godot.equip.loaded", pass: !!r && r.problems.length === 0, detail: r ? r.problems.join("; ") || undefined : "check_equip.gd produced no result" });
  if (r && r.problems.length === 0) {
    checks.push({ id: "godot.equip.bone", pass: r.bone === "RightHand", value: r.bone, limit: "RightHand", detail: "the Prop's BoneAttachment3D" });
    const grip = r.grip_bones ?? [];
    checks.push({ id: "godot.equip.grip_region", pass: grip.length > 0 && grip.every((b) => b === "RightHand" || b === "RightLowerArm"), value: grip.join(", "), limit: "RightHand, RightLowerArm",
      detail: "dominant bones of the body within 6 cm of the item in the rest pose, left out of the clearance as the hand holding it" });
    checks.push({ id: "godot.equip.follows_hand", pass: r.follow_err! <= EQUIP_BUDGET.maxFollowErrorM, value: +r.follow_err!.toFixed(6), limit: EQUIP_BUDGET.maxFollowErrorM,
      detail: `${r.frames} frames of "${r.animation}": Prop origin as Godot placed it vs RightHand pose x rest offset, m` });
    checks.push({ id: "godot.equip.fist_drift", pass: r.fist_drift! <= 0.01, value: +r.fist_drift!.toFixed(4), limit: 0.01, advisory: true,
      detail: "range of the distance from the grip to the skinned fist's centroid over the walk, m" });
    checks.push({ id: "godot.equip.clearance", pass: r.min_clearance! >= EQUIP_BUDGET.minClearanceM, value: +r.min_clearance!.toFixed(4), limit: EQUIP_BUDGET.minClearanceM,
      detail: `closest approach to the body (grip region excluded) at frame ${r.clearance_frame} near ${r.clearance_bone || "—"}; ${r.intersections} prop edges through body triangles` });
  }
  return {
    kind: "equip", runId: id, parent: { kind: "prop", url: prop.glbUrl },
    glbUrl: runUrl(id, "equipped.glb"), previewUrl: runUrl(id, "equip_preview.png"),
    characterRun: skel.runId, bone: "RightHand", animation: r?.animation ?? rep.walk ?? "", frames: r?.frames ?? 0,
    minClearanceM: r?.min_clearance ?? 0, validator: val.validator, godot: { version: g.version, importIssues: g.importLog },
    styleRun: prop.styleRun, checks, createdAt: now(), cost: { seconds: (Date.now() - t0) / 1000 },
  };
}
