/**
 * Map and environment pictures for 3D games — pictures, not levels:
 *
 *   World (text) [+ layout sketch] → WorldMap   illustrated map for the map screen
 *   Sky (text)                     → Skybox     2:1 equirectangular sky panorama
 *
 * Same rule as the character sheet: the model draws over a layout template
 * (a land/water mask for the map, a projection guide for the sky), budgets are
 * fixed in ./artifacts.ts, and an outside program reads the result: Tesseract
 * OCR on the map (no baked text), Godot rendering the sky as a
 * PanoramaSkyMaterial (the wrap seam as a player would see it).
 *
 * The map carries no text on purpose: image models garble words, and baked
 * labels can't be translated or moved; place names are added in-engine.
 */
import { execFile } from "child_process";
import { existsSync } from "fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import sharp from "sharp";
import { SKYBOX_BUDGET, WORLDMAP_BUDGET, type Check, type Skybox, type StyleGuide, type WorldMap } from "./artifacts";
import { generateKieImage } from "./kieImage";
import { runDir, runUrl } from "./runs";
import { kmeans, paletteFitCheck, readReference, stylePrompt, styleRefFiles, toLab, type Lab } from "./style";
import { godotBin, tesseractBin } from "./tools";

const run = promisify(execFile);

/** nano-banana-2: the layout comes from the template, so the pro model's extra fidelity isn't needed. */
export const MAPS_MODEL = "nano-banana-2";
export const DEFAULT_MAP_SEED = 1;

// ── World map ───────────────────────────────────────────────────────────────

/** Mask and guide: the map screen's 16:9 at 1080p. */
const MASK_W = 1920, MASK_H = 1080;
/** Analysis grid: noise field, sketch reading, segmentation. */
const GRID_W = 480, GRID_H = 270;
/** 1K (8 credits; 2K is 12): a map screen background, and the coastlines come from the guide anyway. */
const MAP_RESOLUTION = "1K" as const;
const GUIDE = { water: [79, 134, 198], land: [216, 192, 142], coast: [43, 33, 24] } as const;

export function worldMapPrompt(world: string, style?: StyleGuide): string {
  return [
    `Illustrated map of ${world.trim().replace(/\.$/, "")}, for a 3D game's world map screen, seen straight down.`,
    "Attached image 1 is the coastline guide: tan is land, blue is water, the dark line is the coastline.",
    "Follow the guide's coastlines exactly: the same continents and islands, with the same shapes, positions and sizes; keep every island and add no land where the guide shows water.",
    style
      ? "Take only the land and water layout from the guide, not its colours; terrain, colours and rendering come from the description and the style."
      : "Take only the land and water layout from the guide, not its colours; terrain, colours and style come from the description.",
    stylePrompt(style, 2),
    "Water must read clearly as water and land as land. Fill the whole frame edge to edge: no border, no frame, no torn paper edge, no vignette.",
    "Absolutely no text of any kind: no place names, labels, letters, numbers, compass rose lettering, legend, scale bar, title or cartouche. Names are added later in the game.",
  ].filter(Boolean).join(" ");
}

/** Deterministic integer hash → [0, 1). */
function hash01(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed + 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash01(xi, yi, seed), b = hash01(xi + 1, yi, seed), c = hash01(xi, yi + 1, seed), d = hash01(xi + 1, yi + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/**
 * Binary MASK_W×MASK_H mask (255 = land) from a seed: fBm value noise, pulled
 * down toward the frame so the map is bordered by sea, upsampled smoothly and
 * cut at the quantile that gives WORLDMAP_BUDGET.seedLandShare land.
 */
async function seededMask(seed: number): Promise<Uint8Array> {
  const field = new Float32Array(GRID_W * GRID_H);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      let v = 0, amp = 1, freq = 4 / GRID_W;
      for (let o = 0; o < 5; o++) {
        v += amp * valueNoise(x * freq, y * freq, seed * 7 + o);
        amp *= 0.5; freq *= 2;
      }
      const edge = Math.min(x, GRID_W - 1 - x, y, GRID_H - 1 - y) / GRID_H;
      v -= 0.8 * Math.max(0, 1 - edge / 0.15) ** 2;
      field[y * GRID_W + x] = v;
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of field) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const bytes = Buffer.from(field.map((v) => Math.round(((v - lo) / (hi - lo)) * 255)));
  const smooth = await sharp(bytes, { raw: { width: GRID_W, height: GRID_H, channels: 1 } })
    .resize(MASK_W, MASK_H, { kernel: "cubic" }).extractChannel(0).raw().toBuffer();
  const hist = new Array<number>(256).fill(0);
  for (const v of smooth) hist[v]++;
  let t = 255, above = 0;
  while (t > 0 && above + hist[t] <= WORLDMAP_BUDGET.seedLandShare * smooth.length) above += hist[t--];
  return Uint8Array.from(smooth, (v) => (v > t ? 255 : 0));
}

/**
 * A sketch → binary mask. Its colours split in two (k-means in CIELAB); water
 * is the bluer cluster when the two differ clearly in blue–yellow, otherwise
 * the lighter one (paper). When the darker cluster covers too little to be
 * filled land it is read as outlines: water is what can be reached from the
 * frame without crossing a line, land is everything enclosed. The result is
 * fitted inside the 16:9 frame with sea around it and smoothed.
 */
async function sketchMask(ref: string): Promise<Uint8Array> {
  const { data, info } = await sharp(await readReference(ref)).rotate().flatten({ background: "#ffffff" })
    .resize(GRID_W, GRID_H, { fit: "inside" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, n = w * h;
  const px: Lab[] = [];
  for (let i = 0; i < n; i++) px.push(toLab(data[3 * i], data[3 * i + 1], data[3 * i + 2]));
  const centres = kmeans(px, 2).map((c) => c.centre);
  if (centres.length < 2) throw new Error("The layout sketch is a single flat colour: draw land and water.");
  const water = Math.abs(centres[0][2] - centres[1][2]) > 15
    ? (centres[0][2] < centres[1][2] ? 0 : 1)
    : (centres[0][0] > centres[1][0] ? 0 : 1);
  let land = Uint8Array.from(px, (p) => ((labDist2(p, centres[0]) <= labDist2(p, centres[1]) ? 0 : 1) !== water ? 1 : 0));
  const share = land.reduce((s, v) => s + v, 0) / n;
  if (share < 0.15 && centres[1 - water][0] < centres[water][0]) {
    // Outline sketch: grow the ink by a pixel to close hairline gaps, flood the paper from the frame.
    const wall = Uint8Array.from(land);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!land[y * w + x]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < w && Y < h) wall[Y * w + X] = 1;
      }
    }
    const sea = new Uint8Array(n);
    const stack: number[] = [];
    for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
    while (stack.length) {
      const i = stack.pop()!;
      if (sea[i] || wall[i]) continue;
      sea[i] = 1;
      const x = i % w;
      if (x > 0) stack.push(i - 1);
      if (x < w - 1) stack.push(i + 1);
      if (i >= w) stack.push(i - w);
      if (i < n - w) stack.push(i + w);
    }
    land = Uint8Array.from(sea, (s) => 1 - s);
  }
  const grid = Buffer.from(land.map((v) => v * 255));
  const scale = Math.min(MASK_W / w, MASK_H / h);
  const fw = Math.round(w * scale), fh = Math.round(h * scale);
  const fitted = await sharp(grid, { raw: { width: w, height: h, channels: 1 } }).resize(fw, fh, { kernel: "cubic" }).blur(2)
    .extend({ left: Math.floor((MASK_W - fw) / 2), right: Math.ceil((MASK_W - fw) / 2), top: Math.floor((MASK_H - fh) / 2), bottom: Math.ceil((MASK_H - fh) / 2), background: "#000000" })
    .extractChannel(0).raw().toBuffer();
  return Uint8Array.from(fitted, (v) => (v >= 128 ? 255 : 0));
}

function labDist2(p: Lab, c: Lab): number {
  return (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
}

/** The guide sent to the model: flat land and water with a dark coastline. */
async function writeGuide(mask: Uint8Array, out: string): Promise<void> {
  const soft = await sharp(Buffer.from(mask), { raw: { width: MASK_W, height: MASK_H, channels: 1 } }).blur(2.5).extractChannel(0).raw().toBuffer();
  const rgb = Buffer.alloc(MASK_W * MASK_H * 3);
  for (let i = 0; i < mask.length; i++) {
    const c = soft[i] > 40 && soft[i] < 215 ? GUIDE.coast : mask[i] ? GUIDE.land : GUIDE.water;
    rgb[3 * i] = c[0]; rgb[3 * i + 1] = c[1]; rgb[3 * i + 2] = c[2];
  }
  await sharp(rgb, { raw: { width: MASK_W, height: MASK_H, channels: 3 } }).png().toFile(out);
}

/**
 * Land IoU of the picture against the mask on the analysis grid. The picture
 * (median-filtered to drop brush texture) is split into colour clusters, and
 * each cluster becomes land or water by where most of its pixels fall on the
 * mask; a picture that ignored the coastlines mixes both in every cluster and
 * scores low. Writes a picture of the agreement.
 */
async function coastAgreement(mapPng: string, maskPng: string, outPng: string): Promise<{ land: number; water: number }> {
  const small = await sharp(mapPng).removeAlpha().resize(GRID_W, GRID_H, { fit: "fill" }).png().toBuffer();
  const img = await sharp(small).median(3).toColourspace("srgb").raw().toBuffer();
  const mask = await sharp(maskPng).resize(GRID_W, GRID_H, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  const n = GRID_W * GRID_H;
  const px: Lab[] = [];
  for (let i = 0; i < n; i++) px.push(toLab(img[3 * i], img[3 * i + 1], img[3 * i + 2]));
  const centres = kmeans(px, WORLDMAP_BUDGET.segmentClusters).map((c) => c.centre);
  const cluster = Int32Array.from(px, (p) => {
    let best = 0;
    for (let c = 1; c < centres.length; c++) if (labDist2(p, centres[c]) < labDist2(p, centres[best])) best = c;
    return best;
  });
  const votes = centres.map(() => [0, 0]);
  for (let i = 0; i < n; i++) votes[cluster[i]][mask[i] >= 128 ? 1 : 0]++;
  const isLand = votes.map(([w, l]) => l > w);
  let li = 0, lu = 0, wi = 0, wu = 0;
  const vis = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    const m = mask[i] >= 128, p = isLand[cluster[i]];
    if (m && p) li++;
    if (m || p) lu++;
    if (!m && !p) wi++;
    if (!m || !p) wu++;
    const c = m !== p ? [220, 40, 40] : m ? [90, 170, 90] : [70, 110, 190];
    vis[3 * i] = c[0]; vis[3 * i + 1] = c[1]; vis[3 * i + 2] = c[2];
  }
  await sharp(vis, { raw: { width: GRID_W, height: GRID_H, channels: 3 } }).png().toFile(outPng);
  return { land: lu ? li / lu : 0, water: wu ? wi / wu : 0 };
}

/** Width the picture is scaled to for OCR: map labels then land near Tesseract's preferred 20–40 px x-height. */
const OCR_WIDTH = 2752;

/**
 * Tesseract (sparse-text page mode) on the picture binarised at each of
 * WORLDMAP_BUDGET.ocrThresholds, bright-on-dark and dark-on-bright. Returns the
 * words read under at least `ocrMinAgreement` binarisations (same box), one
 * per box, and how many candidate words were read in all.
 */
async function ocrText(png: string): Promise<{ version: string; words: WorldMap["ocr"]["words"]; scanned: number }> {
  const B = WORLDMAP_BUDGET;
  const bin = tesseractBin();
  const v = await run(bin, ["--version"]);
  const version = `${v.stdout}${v.stderr}`.split("\n")[0].trim();
  const { data, info } = await sharp(png).flatten({ background: "#000000" }).greyscale().resize({ width: OCR_WIDTH }).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  const scale = OCR_WIDTH / (await sharp(png).metadata()).width!;
  const dir = await mkdtemp(join(tmpdir(), "bnr-ocr-"));
  type Hit = { cut: number; x: number; y: number; w: number; h: number; conf: number; text: string };
  const hits: Hit[] = [];
  let scanned = 0;
  try {
    const cuts = B.ocrThresholds.flatMap((t) => [{ t, bright: true }, { t, bright: false }]);
    for (const [cut, { t, bright }] of cuts.entries()) {
      const file = join(dir, `cut-${cut}.png`);
      await sharp(Buffer.from(data.map((p) => ((bright ? p > t : p < t) ? 0 : 255))), { raw: { width: info.width, height: info.height, channels: 1 } }).png().toFile(file);
      const { stdout } = await run(bin, [file, "stdout", "--psm", "11", "tsv"], { maxBuffer: 32 * 1024 * 1024, timeout: 5 * 60_000 });
      for (const line of stdout.split("\n").slice(1)) {
        const f = line.split("\t");
        if (f[0] !== "5" || f.length < 12) continue;
        const text = f.slice(11).join("\t").trim();
        if (!text) continue;
        scanned++;
        const [x, y, w, h, conf] = f.slice(6, 11).map(Number);
        if (conf >= B.ocrMinConf && (text.match(/[A-Za-z]/g) ?? []).length >= B.ocrMinLetters && h >= B.ocrMinHeight * info.height) {
          hits.push({ cut, x, y, w, h, conf, text });
        }
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const overlap = (a: Hit, b: Hit) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) > 0.5 * Math.min(a.w * a.h, b.w * b.h);
  const words: WorldMap["ocr"]["words"] = [];
  const taken: Hit[] = [];
  for (const a of [...hits].sort((p, q) => q.conf - p.conf)) {
    const cutsAgreeing = new Set(hits.filter((b) => overlap(a, b)).map((b) => b.cut));
    if (cutsAgreeing.size < B.ocrMinAgreement || taken.some((b) => overlap(a, b))) continue;
    taken.push(a);
    words.push({ text: a.text, conf: Math.round(a.conf), heightPx: Math.round(a.h / scale) });
  }
  return { version, words, scanned };
}

/**
 * Generate (or, when the run already has a map and `regenerate` is false,
 * re-analyse for free) the world map. The mask is made at submission from the
 * sketch if one is wired, else from `seed`; mask, guide, prompt and seed are
 * kept beside the picture (map.json) so re-analysis checks against what was sent.
 */
export async function runWorldMap(opts: { runId: string; world: string; sketch?: string; seed: number; style?: StyleGuide; apiKey: string; regenerate?: boolean }): Promise<WorldMap> {
  const t0 = Date.now();
  const id = opts.runId;
  const dir = await runDir(id);
  const map = join(dir, "map.png"), maskPng = join(dir, "map-mask.png"), guide = join(dir, "map-guide.png"), info = join(dir, "map.json");
  if (opts.regenerate) {
    await rm(map, { force: true });
    await rm(`${map}.task`, { force: true });
  }
  let kieCredits: number | undefined = 0;
  if (!existsSync(map)) {
    if (!existsSync(`${map}.task`)) {
      const mask = opts.sketch ? await sketchMask(opts.sketch) : await seededMask(opts.seed);
      const land = mask.reduce((s, v) => s + (v ? 1 : 0), 0) / mask.length;
      if (land < WORLDMAP_BUDGET.minLandShare || land > WORLDMAP_BUDGET.maxLandShare) {
        throw new Error(`The layout sketch reads as ${(land * 100).toFixed(0)}% land (allowed ${WORLDMAP_BUDGET.minLandShare * 100}–${WORLDMAP_BUDGET.maxLandShare * 100}%): draw land as filled shapes or closed outlines on plain paper.`);
      }
      await sharp(Buffer.from(mask), { raw: { width: MASK_W, height: MASK_H, channels: 1 } }).png().toFile(maskPng);
      await writeGuide(mask, guide);
      await writeFile(info, JSON.stringify({
        prompt: worldMapPrompt(opts.world, opts.style), style: opts.style?.runId,
        maskSource: opts.sketch ? "sketch" : "seed", seed: opts.sketch ? undefined : opts.seed, landShare: +land.toFixed(4),
      }));
    }
    const sent = JSON.parse(await readFile(info, "utf8")) as { prompt: string };
    kieCredits = await generateKieImage({
      model: MAPS_MODEL, prompt: sent.prompt, images: [guide, ...styleRefFiles(opts.style)],
      aspectRatio: "16:9", resolution: MAP_RESOLUTION, outFile: map, apiKey: opts.apiKey,
    });
  }
  const used = JSON.parse(await readFile(info, "utf8")) as { prompt: string; style?: string; maskSource: "seed" | "sketch"; seed?: number; landShare: number };
  const meta = await sharp(map).metadata();
  const width = meta.width!, height = meta.height!;
  const checks: Check[] = [];

  const aspectErr = Math.abs(width / height - WORLDMAP_BUDGET.aspect) / WORLDMAP_BUDGET.aspect;
  checks.push({ id: "worldmap.aspect", pass: aspectErr <= WORLDMAP_BUDGET.maxAspectError, value: +aspectErr.toFixed(4), limit: WORLDMAP_BUDGET.maxAspectError, detail: `${width}×${height} vs 16:9, relative error` });

  const iou = await coastAgreement(map, maskPng, join(dir, "map-segmentation.png"));
  checks.push({
    id: "worldmap.coast_iou", pass: iou.land >= WORLDMAP_BUDGET.minCoastIoU, value: +iou.land.toFixed(3), limit: WORLDMAP_BUDGET.minCoastIoU,
    detail: `land IoU of the picture's colour segmentation (${WORLDMAP_BUDGET.segmentClusters} CIELAB clusters, each labelled by majority on the mask) vs the ${used.maskSource} mask; water IoU ${iou.water.toFixed(3)}`,
  });

  let ocr: WorldMap["ocr"] = { version: "", words: [] };
  try {
    const r = await ocrText(map);
    ocr = { version: r.version, words: r.words };
    checks.push({
      id: "worldmap.no_text", pass: r.words.length <= WORLDMAP_BUDGET.maxTextWords, value: r.words.length, limit: WORLDMAP_BUDGET.maxTextWords,
      detail: `${r.version} at ${WORLDMAP_BUDGET.ocrThresholds.length * 2} binarisations: words with confidence ≥ ${WORLDMAP_BUDGET.ocrMinConf}, ≥ ${WORLDMAP_BUDGET.ocrMinLetters} letters, ≥ ${WORLDMAP_BUDGET.ocrMinHeight * 100}% of the height, read under ≥ ${WORLDMAP_BUDGET.ocrMinAgreement} of them (${r.scanned} raw detections)${r.words.length ? `: ${r.words.slice(0, 6).map((w) => `"${w.text}"`).join(", ")}` : ""}`,
    });
  } catch (e) {
    checks.push({ id: "worldmap.no_text", pass: false, detail: `OCR could not run: ${(e as Error).message} (macOS: brew install tesseract)` });
  }

  // The palette check needs the style the map was drawn with, not whichever is wired now.
  const fit = used.style && used.style === opts.style?.runId ? await paletteFitCheck(map, opts.style) : undefined;
  if (fit) checks.push(fit);

  return {
    kind: "worldmap", runId: id, prompt: used.prompt, model: MAPS_MODEL, styleRun: used.style,
    maskSource: used.maskSource, seed: used.seed,
    maskUrl: runUrl(id, "map-mask.png"), guideUrl: runUrl(id, "map-guide.png"), mapUrl: runUrl(id, "map.png"),
    segmentationUrl: runUrl(id, "map-segmentation.png"), previewUrl: runUrl(id, "map.png"),
    width, height, ocr, checks,
    createdAt: new Date().toISOString(), cost: { seconds: (Date.now() - t0) / 1000, kieCredits },
  };
}

// ── Skybox ──────────────────────────────────────────────────────────────────

/**
 * nano-banana has no 2:1 aspect: the guide is the full 360°×180° sphere
 * squeezed to 21:9 (the nearest, 14% wider), and the picture is resampled back
 * to 2:1, undoing the squeeze.
 */
const SKY_GUIDE_W = 2520, SKY_GUIDE_H = 1080;
const SKY_RESOLUTION = "2K" as const;

export function skyboxPrompt(sky: string, style?: StyleGuide): string {
  return [
    `Seamless 360-degree equirectangular sky panorama (a 3D game skybox) of ${sky.trim().replace(/\.$/, "")}.`,
    "Attached image 1 is the projection guide: the whole sphere around the viewer unwrapped, 360 degrees across and 180 degrees from top to bottom.",
    "The bold line across the middle, at exactly half the picture's height, is the horizon at eye level: the far edge of the ground or sea (the foot of distant mountains) must lie exactly on it, perfectly level across the full width; everything below it is ground seen from above, distant terrain may rise only a little above it.",
    "The top band is the zenith (straight up) and the bottom band the nadir (straight down): each must be one even colour with no clouds, sun, stars or detail inside it, blending smoothly into the picture.",
    "The left and right edges are the same direction: everything touching the right edge continues seamlessly onto the left edge, at the same heights and in the same colours.",
    "Equirectangular projection: clouds near the top appear stretched wide.",
    style
      ? "Take only the projection, horizon and bands from the guide: never draw its grid lines, band outlines or colours; mood and colours come from the description and the style."
      : "Take only the projection, horizon and bands from the guide: never draw its grid lines, band outlines or colours; mood and colours come from the description.",
    stylePrompt(style, 2),
    "No text, no frame, no border, no people, no watermark.",
  ].filter(Boolean).join(" ");
}

/** Projection guide: sky and ground halves, bold horizon, 30° graticule, flat pole caps (above 75°). */
async function writeSkyGuide(out: string): Promise<void> {
  const W = SKY_GUIDE_W, H = SKY_GUIDE_H, cap = H / 12;
  const lon = Array.from({ length: 11 }, (_, i) => ((i + 1) * W) / 12)
    .map((x) => `<line x1="${x}" y1="${cap}" x2="${x}" y2="${H - cap}" stroke="#7d8996" stroke-width="2"/>`);
  const lat = [1, 2, 4, 5].map((k) => (k * H) / 6)
    .map((y) => `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#7d8996" stroke-width="2"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#aac4dc"/><stop offset="1" stop-color="#e8eef3"/></linearGradient>
      <linearGradient id="ground" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b5af9f"/><stop offset="1" stop-color="#8b8576"/></linearGradient>
    </defs>
    <rect width="${W}" height="${H / 2}" fill="url(#sky)"/>
    <rect y="${H / 2}" width="${W}" height="${H / 2}" fill="url(#ground)"/>
    ${lon.join("")}${lat.join("")}
    <rect width="${W}" height="${cap}" fill="#9fb9d2"/>
    <rect y="${H - cap}" width="${W}" height="${cap}" fill="#7f796b"/>
    <line x1="0" y1="${cap}" x2="${W}" y2="${cap}" stroke="#4a5866" stroke-width="3" stroke-dasharray="18 12"/>
    <line x1="0" y1="${H - cap}" x2="${W}" y2="${H - cap}" stroke="#4a5866" stroke-width="3" stroke-dasharray="18 12"/>
    <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#1f2a36" stroke-width="7"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(out);
}

function p95(v: Float32Array): number {
  const s = Float32Array.from(v).sort();
  return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))];
}

function luma(rgb: Buffer | Float32Array, n: number): Float32Array {
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.2126 * rgb[3 * i] + 0.7152 * rgb[3 * i + 1] + 0.0722 * rgb[3 * i + 2];
  return L;
}

/**
 * p95 luminance step across the wrap (last column → first) / p95 step between
 * every other pair of neighbouring columns, pole bands excluded (they're
 * checked separately). Steps under one 8-bit level count as one: quantisation.
 */
function wrapSeamRatio(L: Float32Array, w: number, h: number): number {
  const y0 = Math.round(SKYBOX_BUDGET.poleBand * h), y1 = h - y0;
  const seam = new Float32Array(y1 - y0), inner = new Float32Array((y1 - y0) * (w - 1));
  let j = 0;
  for (let y = y0; y < y1; y++) {
    seam[y - y0] = Math.abs(L[y * w] - L[y * w + w - 1]);
    for (let x = 0; x < w - 1; x++) inner[j++] = Math.abs(L[y * w + x + 1] - L[y * w + x]);
  }
  return Math.max(1, p95(seam)) / Math.max(1, p95(inner));
}

/**
 * Make the left and right edges meet: per row and channel, half the colour
 * difference across the wrap is added to one side and taken from the other,
 * fading out over a band (3% of the width) from each edge. The difference is
 * smoothed over 9 rows first, so only colour and brightness offsets are
 * removed; mismatched shapes (a cloud or ridge cut off at one edge) survive
 * and fail the seam check instead of being smeared into streaks.
 */
function repairSeam(rgb: Float32Array, w: number, h: number): void {
  const band = Math.round(0.03 * w), half = 4;
  const diff = new Float32Array(h * 3);
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      const right = (rgb[(y * w + w - 1) * 3 + c] + rgb[(y * w + w - 2) * 3 + c]) / 2;
      const left = (rgb[(y * w) * 3 + c] + rgb[(y * w + 1) * 3 + c]) / 2;
      diff[y * 3 + c] = (right - left) / 2;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let s = 0, k = 0;
      for (let yy = Math.max(0, y - half); yy <= Math.min(h - 1, y + half); yy++) { s += diff[yy * 3 + c]; k++; }
      const d = s / k;
      for (let x = 0; x < band; x++) {
        const f = 1 - x / band;
        rgb[(y * w + x) * 3 + c] += d * f;
        rgb[(y * w + w - 1 - x) * 3 + c] -= d * f;
      }
    }
  }
}

/** Mean luminance standard deviation along the rows of a pole band. */
function poleStd(L: Float32Array, w: number, rows: [number, number]): number {
  let total = 0;
  for (let y = rows[0]; y < rows[1]; y++) {
    let s = 0, ss = 0;
    for (let x = 0; x < w; x++) { const v = L[y * w + x]; s += v; ss += v * v; }
    total += Math.sqrt(Math.max(0, ss / w - (s / w) ** 2));
  }
  return total / (rows[1] - rows[0]);
}

/** Row of the strongest change in the row-mean colour (CIELAB, 4 rows apart), between 20% and 80% of the height. */
async function horizonRow(png: string): Promise<number> {
  const W = 512, H = 256;
  const { data } = await sharp(png).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const rows: Lab[] = [];
  for (let y = 0; y < H; y++) {
    let r = 0, g = 0, b = 0;
    for (let x = 0; x < W; x++) { const o = (y * W + x) * 3; r += data[o]; g += data[o + 1]; b += data[o + 2]; }
    rows.push(toLab(r / W, g / W, b / W));
  }
  let best = H / 2, bestD = -1;
  for (let y = Math.round(0.2 * H); y < Math.round(0.8 * H); y++) {
    const d = labDist2(rows[y - 2], rows[y + 2]);
    if (d > bestD) { bestD = d; best = y; }
  }
  return best / H;
}

/** Rows of the guide's horizontal lines in the panorama, as a share of the height. */
const GUIDE_ROWS: [number, string][] = [
  [1 / 12, "zenith cap edge"], [1 / 6, "60° latitude"], [1 / 3, "30° latitude"], [1 / 2, "horizon"],
  [2 / 3, "-30° latitude"], [5 / 6, "-60° latitude"], [11 / 12, "nadir cap edge"],
];

/**
 * Guide lines copied into the picture. Per row: median over the columns of
 * |L(y) − mean(L(y−4), L(y+4))|, which is high only for a thin line or hard
 * edge running the full width (a skyline or cloud edge isn't the same at every
 * column). The strongest guide row (±4 rows) against the median row; steps
 * under one 8-bit level count as one.
 */
function guideResidue(L: Float32Array, w: number, h: number): { ratio: number; where: string } {
  const strength = new Float32Array(h);
  const col = new Float32Array(w);
  for (let y = 4; y < h - 4; y++) {
    for (let x = 0; x < w; x++) col[x] = Math.abs(L[y * w + x] - (L[(y - 4) * w + x] + L[(y + 4) * w + x]) / 2);
    strength[y] = col.sort()[w >> 1];
  }
  const typical = Float32Array.from(strength.subarray(4, h - 4)).sort()[(h - 8) >> 1];
  let ratio = 0, where = "";
  for (const [f, name] of GUIDE_ROWS) {
    const r = Math.round(f * h);
    for (let y = Math.max(4, r - 4); y <= Math.min(h - 5, r + 4); y++) {
      const v = Math.max(1, strength[y]) / Math.max(1, typical);
      if (v > ratio) { ratio = v; where = name; }
    }
  }
  return { ratio, where };
}

/**
 * Peak circular autocorrelation of the luminance along the rows (each row's
 * mean removed, pole bands left out) at lags from 1/8 to 1/2 turn, on a
 * 512×256 copy: near 1 when the same scenery is drawn twice around the circle.
 */
async function repetition(png: string): Promise<number> {
  const W = 512, H = 256;
  const g = await sharp(png).greyscale().resize(W, H, { fit: "fill" }).extractChannel(0).raw().toBuffer();
  const y0 = Math.ceil(SKYBOX_BUDGET.poleBand * H), y1 = H - y0;
  const v = new Float32Array((y1 - y0) * W);
  let energy = 0;
  for (let y = y0; y < y1; y++) {
    let mean = 0;
    for (let x = 0; x < W; x++) mean += g[y * W + x] / W;
    for (let x = 0; x < W; x++) { const d = g[y * W + x] - mean; v[(y - y0) * W + x] = d; energy += d * d; }
  }
  if (energy === 0) return 0;
  let peak = -1;
  for (let lag = W / 8; lag <= W / 2; lag++) {
    let s = 0;
    for (let r = 0; r < y1 - y0; r++) for (let x = 0; x < W; x++) s += v[r * W + x] * v[r * W + ((x + lag) % W)];
    peak = Math.max(peak, s / energy);
  }
  return peak;
}

interface GodotSkyResult { ok: boolean; problems: string[]; version: string; width?: number; height?: number; seam_view?: string; seam_x?: number; views: Record<string, string> }

/**
 * Godot: import the panorama into a throwaway copy of scripts/game/godot
 * (headless), then check_sky.gd renders it as a PanoramaSkyMaterial (GPU
 * renderer, so not headless) into `outDir`.
 */
async function godotSky(png: string, outDir: string): Promise<{ importLog: string[]; result: GodotSkyResult | null }> {
  const src = join(process.cwd(), "scripts", "game", "godot");
  const proj = await mkdtemp(join(tmpdir(), "bnr-godot-sky-"));
  try {
    for (const f of ["project.godot", "preview.gd", "preview.tscn", "check_sky.gd"]) await copyFile(join(src, f), join(proj, f));
    await mkdir(join(proj, "sky"));
    await copyFile(png, join(proj, "sky", "sky.png"));
    const bin = godotBin();
    const settle = (e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" });
    const imp = await run(bin, ["--headless", "--import", "--path", proj], { maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 }).catch(settle);
    const importLog = `${imp.stdout}\n${imp.stderr}`.split("\n").filter((l) => /warn|error/i.test(l)).map((l) => l.trim());
    const out = await run(bin, ["--path", proj, "--resolution", "64x64", "-s", "res://check_sky.gd", "--", outDir], { maxBuffer: 16 * 1024 * 1024, timeout: 2 * 60_000 }).catch(settle);
    const line = `${out.stdout}`.split("\n").find((l) => l.startsWith("{"));
    return { importLog, result: line ? (JSON.parse(line) as GodotSkyResult) : null };
  } finally {
    await rm(proj, { recursive: true, force: true });
  }
}

/** In a Godot view: mean luminance step across column `x` → x+1 / median of the same over every other column. */
async function renderSeamRatio(png: string, x: number): Promise<number> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const L = luma(data, w * h);
  const steps = new Float32Array(w - 1);
  for (let c = 0; c < w - 1; c++) {
    let s = 0;
    for (let y = 0; y < h; y++) s += Math.abs(L[y * w + c + 1] - L[y * w + c]);
    steps[c] = s / h;
  }
  const others = Float32Array.from(steps.filter((_, c) => Math.abs(c - x) > 2)).sort();
  return Math.max(1, steps[x]) / Math.max(1, others[others.length >> 1]);
}

/**
 * Generate (or re-analyse the cached picture for free) the sky. The 2:1
 * deliverable is always rebuilt from sky-raw.png: resample, repair the wrap
 * if it shows, check, render in Godot.
 */
export async function runSkybox(opts: { runId: string; sky: string; style?: StyleGuide; apiKey: string; regenerate?: boolean }): Promise<Skybox> {
  const t0 = Date.now();
  const id = opts.runId;
  const dir = await runDir(id);
  const raw = join(dir, "sky-raw.png"), guide = join(dir, "sky-guide.png"), info = join(dir, "sky.json"), out = join(dir, "sky.png");
  if (opts.regenerate) {
    await rm(raw, { force: true });
    await rm(`${raw}.task`, { force: true });
  }
  let kieCredits: number | undefined = 0;
  if (!existsSync(raw)) {
    if (!existsSync(`${raw}.task`)) {
      await writeSkyGuide(guide);
      await writeFile(info, JSON.stringify({ prompt: skyboxPrompt(opts.sky, opts.style), style: opts.style?.runId }));
    }
    const sent = JSON.parse(await readFile(info, "utf8")) as { prompt: string };
    kieCredits = await generateKieImage({
      model: MAPS_MODEL, prompt: sent.prompt, images: [guide, ...styleRefFiles(opts.style)],
      aspectRatio: "21:9", resolution: SKY_RESOLUTION, outFile: raw, apiKey: opts.apiKey,
    });
  }
  const used = JSON.parse(await readFile(info, "utf8")) as { prompt: string; style?: string };

  const W = SKYBOX_BUDGET.width, H = SKYBOX_BUDGET.height, n = W * H;
  const bytes = await sharp(raw).removeAlpha().toColourspace("srgb").resize(W, H, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer();
  const rgb = Float32Array.from(bytes);
  const rawSeam = wrapSeamRatio(luma(rgb, n), W, H);
  const seamRepaired = rawSeam > SKYBOX_BUDGET.maxSeamRatio;
  if (seamRepaired) repairSeam(rgb, W, H);
  await sharp(Buffer.from(rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))))), { raw: { width: W, height: H, channels: 3 } }).png().toFile(out);
  const L = luma(rgb, n);
  const seam = wrapSeamRatio(L, W, H);
  const band = Math.max(1, Math.round(SKYBOX_BUDGET.poleBand * H));
  const top = poleStd(L, W, [0, band]), bottom = poleStd(L, W, [H - band, H]);
  const horizon = await horizonRow(out);
  const residue = guideResidue(L, W, H);
  const rep = await repetition(out);
  const [rawMeta, outMeta] = await Promise.all([sharp(raw).metadata(), sharp(out).metadata()]);
  const ow = outMeta.width!, oh = outMeta.height!;

  const checks: Check[] = [
    { id: "skybox.size", pass: ow === 2 * oh && (ow & (ow - 1)) === 0 && (oh & (oh - 1)) === 0, value: `${ow}×${oh}`, limit: "2:1, powers of two", detail: `resampled from the ${rawMeta.width}×${rawMeta.height} picture` },
    { id: "skybox.seam", pass: seam <= SKYBOX_BUDGET.maxSeamRatio, value: +seam.toFixed(3), limit: SKYBOX_BUDGET.maxSeamRatio, detail: `p95 step across the wrap / p95 step between neighbouring columns; ${rawSeam.toFixed(2)} as drawn${seamRepaired ? ", edges blended" : ""}` },
    { id: "skybox.pole_top", pass: top <= SKYBOX_BUDGET.maxPoleStd, value: +top.toFixed(2), limit: SKYBOX_BUDGET.maxPoleStd, detail: `mean luminance std along the top ${band} rows (they collapse onto the zenith)` },
    // Advisory: what's under the camera is usually covered by terrain.
    { id: "skybox.pole_bottom", pass: bottom <= SKYBOX_BUDGET.maxPoleStd, value: +bottom.toFixed(2), limit: SKYBOX_BUDGET.maxPoleStd, advisory: true, detail: `same for the bottom ${band} rows (nadir), usually hidden by terrain` },
    { id: "skybox.horizon", pass: Math.abs(horizon - 0.5) <= SKYBOX_BUDGET.maxHorizonOffset, value: +(horizon - 0.5).toFixed(3), limit: SKYBOX_BUDGET.maxHorizonOffset, advisory: true, detail: "strongest row-mean colour change, offset from the vertical centre (share of the height; + is below)" },
    { id: "skybox.guide_residue", pass: residue.ratio <= SKYBOX_BUDGET.maxGuideResidue, value: +residue.ratio.toFixed(2), limit: SKYBOX_BUDGET.maxGuideResidue, advisory: true, detail: `full-width line strength at the guide's rows / at a typical row; strongest at the ${residue.where}` },
    { id: "skybox.repetition", pass: rep <= SKYBOX_BUDGET.maxRepetition, value: +rep.toFixed(3), limit: SKYBOX_BUDGET.maxRepetition, advisory: true, detail: "peak autocorrelation along the rows at lags of 1/8 turn or more (scenery drawn twice)" },
  ];

  const views: Record<string, string> = {};
  const godot = await godotSky(out, dir);
  const g = godot.result;
  if (!g) {
    checks.push({ id: "skybox.godot_render", pass: false, detail: `Godot printed no result${godot.importLog.length ? `: ${godot.importLog.slice(0, 3).join("; ")}` : ""}` });
  } else {
    for (const [name, file] of Object.entries(g.views)) views[name] = runUrl(id, file);
    checks.push({
      id: "skybox.godot_render", pass: g.ok && g.width === W && g.height === H && Object.keys(g.views).length === 5,
      value: Object.keys(g.views).length, limit: 5,
      detail: `${g.version}: PanoramaSkyMaterial, ${g.width}×${g.height} texture, views ${Object.keys(g.views).join(", ")}${g.problems.length ? `; ${g.problems.join("; ")}` : ""}${godot.importLog.length ? `; import: ${godot.importLog.slice(0, 3).join("; ")}` : ""}`,
    });
    if (g.seam_view && g.seam_x !== undefined && g.views[g.seam_view]) {
      const r = await renderSeamRatio(join(dir, g.views[g.seam_view]), g.seam_x);
      checks.push({ id: "skybox.render_seam", pass: r <= SKYBOX_BUDGET.maxRenderSeamRatio, value: +r.toFixed(3), limit: SKYBOX_BUDGET.maxRenderSeamRatio, detail: `Godot ${g.seam_view} view (straddles the wrap at column ${g.seam_x}): mean step across it / median over the other columns` });
    }
  }

  // The palette check needs the style the sky was drawn with, not whichever is wired now.
  const fit = used.style && used.style === opts.style?.runId ? await paletteFitCheck(out, opts.style) : undefined;
  if (fit) checks.push(fit);

  return {
    kind: "skybox", runId: id, prompt: used.prompt, model: MAPS_MODEL, styleRun: used.style,
    guideUrl: runUrl(id, "sky-guide.png"), rawUrl: runUrl(id, "sky-raw.png"), panoramaUrl: runUrl(id, "sky.png"), previewUrl: runUrl(id, "sky.png"),
    width: W, height: H, seamRepaired,
    godot: { version: g?.version ?? "", importIssues: godot.importLog, seamView: g?.seam_view, views },
    checks, createdAt: new Date().toISOString(), cost: { seconds: (Date.now() - t0) / 1000, kieCredits },
  };
}
