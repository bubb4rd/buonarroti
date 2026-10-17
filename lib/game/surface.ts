/**
 * Seamless surface material: material text (+ style) → Surface, through kie.ai.
 *
 * The image model is shown a layout template (a flat grey ground patch seen
 * straight down, with scale marks on its edges) and asked to fill it with the
 * material: the picture fixes camera, scale and flat lighting. Words that name
 * a texture ("seamless tileable texture", "albedo") made nano-banana-2 draw a
 * 2 x 2 repeat of a smaller block, so the prompt asks for a picture of ground.
 * Tiling is made here, without a mask-capable model:
 *
 *  1. Baked lighting: a luminance plane fit, divided out (the engine lights).
 *  2. Wrap: the picture shows a repeat plus OVERLAP of extra ground. Seen with a
 *     half-period offset, the wrap seam is the tile's centre cross; it is
 *     repaired by joining the overlap strip with the opposite edge in two
 *     bands: detail switches sides along a minimum-error cut (image quilting,
 *     Efros & Freeman 2001), tone cross-fades over the whole strip; x first,
 *     then y with a cut that closes on itself. Unlike a feathered blend with
 *     the offset copy it neither ghosts nor halves contrast along the seam,
 *     and unlike a half-offset patch it duplicates no content inside the tile.
 *  3. Power-of-two: resampled on a 3 x 3 tiling so the filter wraps.
 *  4. Normal map from high-passed luminance as height (OpenGL / Godot +Y);
 *     roughness from the same height (raised, brighter parts smoother).
 *
 * Godot then imports the PNGs with the presets shipped beside them, renders the
 * material on an 8 x 8 m plane from three heights, and the seam detector runs
 * on those renders.
 */
import { execFile } from "child_process";
import { existsSync } from "fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import sharp from "sharp";
import { SURFACE_BUDGET, type Check, type StyleGuide, type Surface } from "./artifacts";
import { generateKieImage } from "./kieImage";
import { runDir, runPath, runUrl } from "./runs";
import { paletteFitCheck, stylePrompt, styleRefFiles } from "./style";
import { godotBin } from "./tools";

const run = promisify(execFile);

export const SURFACE_MODEL = "nano-banana-2";
export const SURFACE_RESOLUTION: "1K" | "2K" = "1K";

/** Share of the picture's side cut away by the wrap repair; the rest is one repeat. */
const OVERLAP = 1 / 6;
/** Ground the template shows: one repeat plus the overlap (2.4 m for a 2 m tile). */
const PICTURE_M = SURFACE_BUDGET.tileM / (1 - OVERLAP);
const GRID_M = 0.2;
/** Half-width of the cross-fade along a cut, px: hides sub-pixel misregistration only. */
const FEATHER = 2;
/** Normal map relief: metres of height per unit of high-passed luminance. */
const RELIEF_M = 0.05;
/** Godot check: straight-down camera heights (a player's eye, a building, an overview). */
const CAMERA_HEIGHTS_M = [1.5, 3.5, 7];
const CAMERA_FOV_DEG = 50;
const RENDER_PX = 1024;

const SCRIPTS = join(process.cwd(), "scripts", "game");

// ── Prompt and template ─────────────────────────────────────────────────────

export function surfacePrompt(material: string, style?: StyleGuide): string {
  return [
    `Top-down picture of ${material.trim().replace(/\.$/, "")}, used as the colour of the ground or walls in a 3D game.`,
    `Attached image 1 is the layout guide: a ${PICTURE_M.toFixed(1)} m by ${PICTURE_M.toFixed(1)} m square patch seen straight down by an orthographic camera, with scale marks along its edges every ${GRID_M * 100} cm (longer every metre).`,
    "Fill the whole square edge to edge with the material at the guide's scale, seen exactly straight down like the guide: no perspective, no horizon, no border, no frame.",
    "Light it like the flat grey guide: even, shadowless, no light direction, no cast shadows, no vignette, no bright or dark corners, no specular highlights. The game engine adds the lighting.",
    "One continuous, natural patch: every stone, board, blade or grain is different, nothing is repeated, copied or mirrored. Spread the detail evenly, with no single feature that stands out, no objects, no plants or debris standing up, no people, no text. Do not draw the scale marks.",
    stylePrompt(style, 2),
  ].filter(Boolean).join(" ");
}

/**
 * The layout template: mid grey (flat light, no colour cue), square, scale
 * marks on the edges only. A full 20 cm grid (the first version) came back as
 * cobblestones set in its cells: the grid fixed the layout, not just the scale.
 */
async function renderTemplate(side: number, out: string): Promise<void> {
  const marks = Math.round(PICTURE_M / GRID_M);
  const ticks = Array.from({ length: marks + 1 }, (_, i) => {
    const p = ((i * side) / marks).toFixed(1);
    const len = (side / (i % Math.round(1 / GRID_M) === 0 ? 40 : 80)).toFixed(1);
    const far = (side - +len).toFixed(1);
    return `<line x1="${p}" y1="0" x2="${p}" y2="${len}"/><line x1="${p}" y1="${far}" x2="${p}" y2="${side}"/>`
      + `<line x1="0" y1="${p}" x2="${len}" y2="${p}"/><line x1="${far}" y1="${p}" x2="${side}" y2="${p}"/>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}">`
    + `<rect width="${side}" height="${side}" fill="#808080"/>`
    + `<g stroke="#a0a0a0" stroke-width="${side / 400}">${ticks}</g></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(out);
}

// ── Pixels ──────────────────────────────────────────────────────────────────

/** Interleaved RGB, sRGB values in 0..1. */
interface Img { w: number; h: number; d: Float32Array }

async function loadSquare(file: string): Promise<Img> {
  const meta = await sharp(file).metadata();
  const side = Math.min(meta.width!, meta.height!);
  const { data, info } = await sharp(file)
    .extract({ left: (meta.width! - side) >> 1, top: (meta.height! - side) >> 1, width: side, height: side })
    .removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const d = new Float32Array(info.width * info.height * 3);
  for (let i = 0; i < d.length; i++) d[i] = data[i] / 255;
  return { w: info.width, h: info.height, d };
}

function toBytes(img: Img): Buffer {
  const b = Buffer.alloc(img.d.length);
  for (let i = 0; i < b.length; i++) b[i] = Math.max(0, Math.min(255, Math.round(img.d[i] * 255)));
  return b;
}

function luma(img: Img): Float32Array {
  const L = new Float32Array(img.w * img.h);
  for (let i = 0; i < L.length; i++) L[i] = 0.2126 * img.d[3 * i] + 0.7152 * img.d[3 * i + 1] + 0.0722 * img.d[3 * i + 2];
  return L;
}

function transpose(img: Img): Img {
  const d = new Float32Array(img.d.length);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const s = 3 * (y * img.w + x), t = 3 * (x * img.h + y);
      d[t] = img.d[s]; d[t + 1] = img.d[s + 1]; d[t + 2] = img.d[s + 2];
    }
  }
  return { w: img.h, h: img.w, d };
}

/**
 * Least-squares plane L = a + b·u + c·v over the full pixel grid (u, v in
 * -0.5..0.5, centred, so the three terms decouple). Slope: change across one
 * picture width along the gradient, as a fraction of the mean.
 */
function planeFit(L: Float32Array, w: number, h: number): { a: number; b: number; c: number; slope: number } {
  let s = 0, su = 0, sv = 0, uu = 0, vv = 0;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h - 0.5;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w - 0.5, l = L[y * w + x];
      s += l; su += u * l; sv += v * l; uu += u * u; vv += v * v;
    }
  }
  const a = s / (w * h), b = su / uu, c = sv / vv;
  return { a, b, c, slope: Math.hypot(b, c) / a };
}

/** Divide the fitted plane out of every channel, keeping the mean. */
function removePlane(img: Img, p: { a: number; b: number; c: number }): void {
  for (let y = 0; y < img.h; y++) {
    const v = (y + 0.5) / img.h - 0.5;
    for (let x = 0; x < img.w; x++) {
      const k = p.a / Math.max(1e-3, p.a + p.b * ((x + 0.5) / img.w - 0.5) + p.c * v);
      const i = 3 * (y * img.w + x);
      img.d[i] *= k; img.d[i + 1] *= k; img.d[i + 2] *= k;
    }
  }
}

// ── Wrap repair ─────────────────────────────────────────────────────────────

/**
 * Cheapest path down `rows` through cost[row * cols + k], one column per row,
 * moving at most one column per row, within lo..hi. `start` pins row 0 and
 * also requires the last row to end within one column of it (a closed cut).
 */
function minPath(cost: Float32Array, rows: number, cols: number, lo: number, hi: number, start?: number): { path: Int32Array; total: number } {
  const acc = new Float64Array(rows * cols).fill(Infinity);
  const from = new Int8Array(rows * cols);
  for (let k = lo; k <= hi; k++) if (start === undefined || k === start) acc[k] = cost[k];
  for (let r = 1; r < rows; r++) {
    for (let k = lo; k <= hi; k++) {
      let best = acc[(r - 1) * cols + k], step = 0;
      if (k > lo && acc[(r - 1) * cols + k - 1] < best) { best = acc[(r - 1) * cols + k - 1]; step = -1; }
      if (k < hi && acc[(r - 1) * cols + k + 1] < best) { best = acc[(r - 1) * cols + k + 1]; step = 1; }
      acc[r * cols + k] = best + cost[r * cols + k];
      from[r * cols + k] = step;
    }
  }
  let end = -1, total = Infinity;
  for (let k = lo; k <= hi; k++) {
    if (start !== undefined && Math.abs(k - start) > 1) continue;
    if (acc[(rows - 1) * cols + k] < total) { total = acc[(rows - 1) * cols + k]; end = k; }
  }
  const path = new Int32Array(rows);
  path[rows - 1] = end;
  for (let r = rows - 1; r > 0; r--) path[r - 1] = path[r] + from[r * cols + path[r]];
  return { path, total };
}

/**
 * Make `img` wrap along x: the last `ov` columns (which continue the picture
 * past the repeat) and the first `ov` columns (which lead into it) are joined,
 * and that strip becomes the new first columns. Output width w - ov; its last
 * column is followed, in the source, by the strip's first. `closed`: the image
 * already wraps along y, so the cut must too.
 *
 * Two bands: detail switches sides at the minimum-error cut (a short
 * cross-fade, no ghosting), tone (a blur at 1/16 of the strip) cross-fades over
 * the whole strip. With the cut alone, a cut across wooden planks left a tone
 * jump on every plank it crossed (cut seam 2.3 along the grain).
 * Returns the cut column per row (pixels left of it come from the far edge).
 */
async function wrapX(img: Img, ov: number, closed: boolean): Promise<{ img: Img; cut: Int32Array }> {
  const { w, h, d } = img;
  const { data: lowBytes } = await sharp(toBytes(img), { raw: { width: w, height: h, channels: 3 } })
    .blur(ov / 16).raw().toBuffer({ resolveWithObject: true });
  const err = new Float32Array(h * ov);
  for (let y = 0; y < h; y++) {
    for (let k = 0; k < ov; k++) {
      const a = 3 * (y * w + w - ov + k), b = 3 * (y * w + k);
      err[y * ov + k] = (d[a] - d[b]) ** 2 + (d[a + 1] - d[b + 1]) ** 2 + (d[a + 2] - d[b + 2]) ** 2;
    }
  }
  const lo = FEATHER + 1, hi = ov - FEATHER - 1;
  let best: { path: Int32Array; total: number } = { path: new Int32Array(0), total: Infinity };
  if (closed) {
    for (let s = lo; s <= hi; s += 2) {
      const p = minPath(err, h, ov, lo, hi, s);
      if (p.total < best.total) best = p;
    }
  } else {
    best = minPath(err, h, ov, lo, hi);
  }
  const W = w - ov;
  const out = new Float32Array(W * h * 3);
  for (let y = 0; y < h; y++) {
    const k = best.path[y];
    for (let x = 0; x < W; x++) {
      const o = 3 * (y * W + x);
      if (x >= ov) {
        const s = 3 * (y * w + x);
        out[o] = d[s]; out[o + 1] = d[s + 1]; out[o + 2] = d[s + 2];
        continue;
      }
      const t = Math.max(0, Math.min(1, (x - k + 0.5) / (2 * FEATHER + 1) + 0.5));
      const T = x / (ov - 1);
      const a = 3 * (y * w + w - ov + x), b = 3 * (y * w + x);
      // Detail cut at t, tone faded at T: (1-t)·A + t·B + (t - T)·(lowA - lowB).
      for (let c = 0; c < 3; c++) out[o + c] = (1 - t) * d[a + c] + t * d[b + c] + ((t - T) * (lowBytes[a + c] - lowBytes[b + c])) / 255;
    }
  }
  return { img: { w: W, h, d: out }, cut: best.path };
}

/** Resample a tile to side×side with the filter wrapping around: resize a 3×3 tiling, keep the centre. */
async function resizeWrapped(img: Img, side: number): Promise<Img> {
  const src = toBytes(img);
  const W = img.w * 3, H = img.h * 3;
  const big = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const row = src.subarray(3 * (y % img.h) * img.w, 3 * ((y % img.h) + 1) * img.w);
    for (let t = 0; t < 3; t++) row.copy(big, 3 * (y * W + t * img.w));
  }
  const { data } = await sharp(big, { raw: { width: W, height: H, channels: 3 } })
    .resize(side * 3, side * 3, { fit: "fill", kernel: "lanczos3" })
    .extract({ left: side, top: side, width: side, height: side })
    .raw().toBuffer({ resolveWithObject: true });
  const d = new Float32Array(side * side * 3);
  for (let i = 0; i < d.length; i++) d[i] = data[i] / 255;
  return { w: side, h: side, d };
}

// ── Measurements ────────────────────────────────────────────────────────────

function p95(v: Float32Array): number {
  const s = Float32Array.from(v).sort();
  return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))];
}

/** p95 luminance step across the wrap edges / p95 step between all other neighbours. */
function wrapSeamRatio(L: Float32Array, n: number): number {
  const seam = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    seam[i] = Math.abs(L[i * n + n - 1] - L[i * n]);
    seam[n + i] = Math.abs(L[(n - 1) * n + i] - L[i]);
  }
  const inner = new Float32Array(2 * n * (n - 1));
  let j = 0;
  for (let y = 0; y < n; y++) for (let x = 0; x < n - 1; x++) inner[j++] = Math.abs(L[y * n + x + 1] - L[y * n + x]);
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n; x++) inner[j++] = Math.abs(L[(y + 1) * n + x] - L[y * n + x]);
  return p95(seam) / p95(inner);
}

/**
 * The repair cuts: p95 step between the pixels just outside the cross-fade on
 * either side of a cut, against p95 of every pair at the same spacing and in
 * the same direction (wrapping); the worse of the two cuts. Per direction,
 * because materials are anisotropic: across plank joints every step is large,
 * along the grain small, and a tone jump where a cut crosses a plank is only
 * visible against the latter. cutX[y] for rows y in rowsX (columns cut),
 * cutY[x] for every column (rows cut).
 */
function cutSeamRatio(L: Float32Array, n: number, cutX: Int32Array, rowsX: [number, number], cutY: Int32Array): number {
  const span = 2 * FEATHER + 1;
  const seamX = new Float32Array(rowsX[1] - rowsX[0]), seamY = new Float32Array(n);
  for (let y = rowsX[0]; y < rowsX[1]; y++) seamX[y - rowsX[0]] = Math.abs(L[y * n + cutX[y] + FEATHER] - L[y * n + cutX[y] - FEATHER - 1]);
  for (let x = 0; x < n; x++) seamY[x] = Math.abs(L[(cutY[x] + FEATHER) * n + x] - L[(cutY[x] - FEATHER - 1) * n + x]);
  const innerX = new Float32Array(n * n), innerY = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      innerX[y * n + x] = Math.abs(L[y * n + ((x + span) % n)] - L[y * n + x]);
      innerY[y * n + x] = Math.abs(L[((y + span) % n) * n + x] - L[y * n + x]);
    }
  }
  return Math.max(p95(seamX) / p95(innerX), p95(seamY) / p95(innerY));
}

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

function fft2(re: Float64Array, im: Float64Array, n: number, inverse: boolean): void {
  const r = new Float64Array(n), i = new Float64Array(n);
  for (let y = 0; y < n; y++) {
    r.set(re.subarray(y * n, y * n + n)); i.set(im.subarray(y * n, y * n + n));
    fft(r, i, inverse);
    re.set(r, y * n); im.set(i, y * n);
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) { r[y] = re[y * n + x]; i[y] = im[y * n + x]; }
    fft(r, i, inverse);
    for (let y = 0; y < n; y++) { re[y * n + x] = r[y]; im[y * n + x] = i[y]; }
  }
}

/**
 * Peak normalised autocorrelation of the tile's luminance at lags of at least
 * 1/8 tile. Circular autocorrelation is that of the endless tiling, so a motif
 * repeated inside the tile (or any strong periodic structure) peaks here.
 * Measured at 256 px (exact box average, which keeps the tile periodic).
 */
function repetition(L: Float32Array, n: number): number {
  const m = 256, f = n / m;
  const re = new Float64Array(m * m), im = new Float64Array(m * m);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) re[Math.floor(y / f) * m + Math.floor(x / f)] += L[y * n + x];
  let mean = 0;
  for (const v of re) mean += v;
  mean /= re.length;
  for (let i = 0; i < re.length; i++) re[i] -= mean;
  fft2(re, im, m, false);
  for (let i = 0; i < re.length; i++) { re[i] = re[i] ** 2 + im[i] ** 2; im[i] = 0; }
  fft2(re, im, m, true);
  let peak = -Infinity;
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      const dy = Math.min(y, m - y), dx = Math.min(x, m - x);
      if (Math.hypot(dx, dy) >= m / 8) peak = Math.max(peak, re[y * m + x]);
    }
  }
  return peak / re[0];
}

// ── PBR maps ────────────────────────────────────────────────────────────────

/** Gaussian-ish blur (three box passes per axis), wrapping at the edges. */
function blurWrapped(src: Float32Array, n: number, sigma: number): Float32Array {
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  const pass = (stride: number, step: number) => {
    for (let line = 0; line < n; line++) {
      const base = line * stride;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += a[base + (((k % n) + n) % n) * step];
      for (let i = 0; i < n; i++) {
        b[base + i * step] = sum / (2 * r + 1);
        sum += a[base + ((i + r + 1) % n) * step] - a[base + (((i - r) % n + n) % n) * step];
      }
    }
    [a, b] = [b, a];
  };
  for (let k = 0; k < 3; k++) { pass(n, 1); pass(1, n); }
  return a;
}

/**
 * Height = luminance minus its blur at 1/32 tile (shading of single stones,
 * blades, boards, not the tile's large-scale tone). Normal: OpenGL convention
 * (+Y green up), which Godot expects; Unreal wants the green channel flipped.
 */
function pbrMaps(albedo: Img): { normal: Buffer; roughness: Buffer } {
  const n = albedo.w;
  const L = luma(albedo);
  const low = blurWrapped(L, n, n / 32);
  const hp = new Float32Array(n * n);
  for (let i = 0; i < hp.length; i++) hp[i] = L[i] - low[i];
  const h = blurWrapped(hp, n, 1);
  const k = (RELIEF_M * n) / SURFACE_BUDGET.tileM / 2; // central difference over 2 px, in metres per metre
  const normal = Buffer.alloc(n * n * 3), roughness = Buffer.alloc(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (h[y * n + ((x + 1) % n)] - h[y * n + ((x - 1 + n) % n)]) * k;
      const dy = (h[((y + 1) % n) * n + x] - h[((y - 1 + n) % n) * n + x]) * k;
      // Image rows grow downward; +Y of the normal map points up the image.
      const nx = -dx, ny = dy, nz = 1, len = Math.hypot(nx, ny, nz);
      const o = 3 * (y * n + x);
      normal[o] = Math.round((nx / len * 0.5 + 0.5) * 255);
      normal[o + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      normal[o + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
      roughness[y * n + x] = Math.round(Math.max(0.45, Math.min(1, 0.8 - h[y * n + x])) * 255);
    }
  }
  return { normal, roughness };
}

// ── Godot ───────────────────────────────────────────────────────────────────

/** Import presets shipped with each PNG: VRAM-compressed with mipmaps, the normal map as one. */
function importPreset(normalMap: boolean): string {
  return [
    "[remap]", "", 'importer="texture"', 'type="CompressedTexture2D"', "", "[params]", "",
    "compress/mode=2", `compress/normal_map=${normalMap ? 1 : 2}`, "mipmaps/generate=true", "",
  ].join("\n");
}

/**
 * World-triplanar mapping with uv1_scale = 1 / tile: one repeat per tileM on
 * any ground or wall mesh regardless of its UVs, i.e. a fixed texel density.
 * Texture paths are relative, so the folder can go anywhere in a project.
 */
function materialTres(name: string, files: { albedo: string; normal: string; roughness: string }): string {
  const s = (1 / SURFACE_BUDGET.tileM).toString();
  return [
    '[gd_resource type="StandardMaterial3D" load_steps=4 format=3]', "",
    `[ext_resource type="Texture2D" path="${files.albedo}" id="1_albedo"]`,
    `[ext_resource type="Texture2D" path="${files.normal}" id="2_normal"]`,
    `[ext_resource type="Texture2D" path="${files.roughness}" id="3_roughness"]`, "",
    "[resource]",
    `resource_name = "${name}"`,
    'albedo_texture = ExtResource("1_albedo")',
    'roughness_texture = ExtResource("3_roughness")',
    "normal_enabled = true",
    'normal_texture = ExtResource("2_normal")',
    "uv1_triplanar = true",
    "uv1_world_triplanar = true",
    `uv1_scale = Vector3(${s}, ${s}, ${s})`,
    "texture_filter = 5", "",
  ].join("\n");
}

interface GodotSurfaceResult {
  loaded: boolean;
  problems: string[];
  textures: Record<string, { w: number; h: number; mipmaps: boolean; compressed: boolean; normal_map?: boolean }>;
  renders: { file: string; height: number; fov: number }[];
}

/**
 * Seam detector on a straight-down render: tile edges lie on world lines
 * x, z = k·tileM, which project to known columns/rows. A line's score is the
 * largest mean luminance step across it (±1 px for rounding) over the median
 * mean step across all lines. The result is the strongest edge line over the
 * strongest line at arbitrary offsets between the edges: above 1, the tile
 * edge stands out from anything the material itself draws.
 */
async function renderSeamRatio(png: string, heightM: number): Promise<number> {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width;
  const L = new Float32Array(n * n);
  for (let i = 0; i < L.length; i++) L[i] = 0.2126 * data[3 * i] + 0.7152 * data[3 * i + 1] + 0.0722 * data[3 * i + 2];
  const halfM = heightM * Math.tan((CAMERA_FOV_DEG * Math.PI) / 360);
  const tile = SURFACE_BUDGET.tileM;
  /** Pixel index c of the step between c and c+1 nearest world lines k·tile + off. */
  const linesAt = (off: number) => {
    const out: number[] = [];
    for (let k = Math.ceil((-halfM - off) / tile); k * tile + off <= halfM; k++) {
      const c = Math.round(n / 2 + ((k * tile + off) * n) / 2 / halfM) - 1;
      if (c > 8 && c < n - 9) out.push(c);
    }
    return out;
  };
  const edges = linesAt(0);
  const others = Array.from({ length: 16 }, (_, i) => linesAt(tile * (0.1 + (0.8 * i) / 15))).flat();
  // col[c]: step between columns c and c+1; row[r]: between rows r and r+1.
  const col = new Float64Array(n - 1), row = new Float64Array(n - 1);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n - 1; x++) {
      col[x] += Math.abs(L[y * n + x + 1] - L[y * n + x]) / n;
      row[x] += Math.abs(L[(x + 1) * n + y] - L[x * n + y]) / n;
    }
  }
  let edge = 0, other = 0;
  for (const prof of [col, row]) {
    const sorted = Array.from(prof.subarray(8, n - 9)).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    for (const c of edges) edge = Math.max(edge, Math.max(prof[c - 1], prof[c], prof[c + 1]) / median);
    for (const c of others) other = Math.max(other, Math.max(prof[c - 1], prof[c], prof[c + 1]) / median);
  }
  return edge / other;
}

/**
 * Copy the deliverable into a throwaway Godot project, import it headless
 * (import warnings/errors are kept), then render with a window: the headless
 * display driver has no renderer.
 */
async function godotRender(files: string[], tresName: string, outDir: string): Promise<{ importLog: string[]; result: GodotSurfaceResult | null; version: string }> {
  const proj = await mkdtemp(join(tmpdir(), "bnr-godot-surface-"));
  try {
    for (const f of ["project.godot", "preview.gd", "preview.tscn", "render_surface.gd"]) {
      await copyFile(join(SCRIPTS, "godot", f), join(proj, f));
    }
    await mkdir(join(proj, "surface"));
    for (const f of files) await copyFile(f, join(proj, "surface", f.split("/").pop()!));
    const bin = godotBin();
    const version = (await run(bin, ["--version"])).stdout.trim();
    const opts = { maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 };
    const imp = await run(bin, ["--headless", "--import", "--path", proj], opts)
      .catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
    const importLog = `${imp.stdout}\n${imp.stderr}`.split("\n").filter((l) => /warn|error/i.test(l)).map((l) => l.trim());
    await mkdir(outDir, { recursive: true });
    const r = await run(bin, [
      "--path", proj, "--resolution", "64x64", "-s", "res://render_surface.gd", "--",
      `res://surface/${tresName}`, outDir, String(RENDER_PX), String(CAMERA_FOV_DEG), CAMERA_HEIGHTS_M.join(","),
    ], opts).catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
    const line = `${r.stdout}`.split("\n").find((l) => l.startsWith("{"));
    return { importLog, result: line ? (JSON.parse(line) as GodotSurfaceResult) : null, version };
  } finally {
    await rm(proj, { recursive: true, force: true });
  }
}

// ── Step ────────────────────────────────────────────────────────────────────

interface SurfaceRequestInfo { material: string; prompt: string; style?: string; model: string; resolution: "1K" | "2K" }

/**
 * Generate (or, when the run already has a picture and `regenerate` is false,
 * re-process for free) the surface. The cached picture is reused whatever the
 * request now says (the artifact reports the material and prompt it was drawn
 * from, in surface.json), so re-analysis never spends credits.
 */
export async function runSurface(opts: { runId: string; material: string; style?: StyleGuide; name?: string; apiKey: string; regenerate?: boolean }): Promise<Surface> {
  const t0 = Date.now();
  const id = opts.runId;
  const dir = await runDir(id);
  const raw = join(dir, "surface_raw.png");
  const template = join(dir, "surface_template.png");
  const infoFile = join(dir, "surface.json");
  if (opts.regenerate) {
    await rm(raw, { force: true });
    await rm(`${raw}.task`, { force: true });
  }
  let kieCredits: number | undefined = 0;
  if (!existsSync(raw)) {
    if (!existsSync(`${raw}.task`)) {
      await renderTemplate(SURFACE_RESOLUTION === "1K" ? 1024 : 2048, template);
      const info: SurfaceRequestInfo = {
        material: opts.material.trim(), prompt: surfacePrompt(opts.material, opts.style), style: opts.style?.runId,
        model: SURFACE_MODEL, resolution: SURFACE_RESOLUTION,
      };
      await writeFile(infoFile, JSON.stringify(info));
    }
    const sent = JSON.parse(await readFile(infoFile, "utf8")) as SurfaceRequestInfo;
    kieCredits = await generateKieImage({
      model: sent.model, prompt: sent.prompt, images: [template, ...styleRefFiles(opts.style)],
      aspectRatio: "1:1", resolution: sent.resolution, outFile: raw, apiKey: opts.apiKey,
    });
  }
  const used = JSON.parse(await readFile(infoFile, "utf8")) as SurfaceRequestInfo;
  const name = (opts.name ?? used.material).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "surface";
  const checks: Check[] = [];

  // 1. Baked lighting.
  const pic = await loadSquare(raw);
  const rawPlane = planeFit(luma(pic), pic.w, pic.h);
  removePlane(pic, rawPlane);
  const rawWrap = wrapSeamRatio(luma(pic), pic.w);
  const rawRep = repetition(luma(pic), pic.w);

  // 2. Wrap: x, then y on the transposed picture (x already wraps, so that cut closes).
  const ov = Math.round(pic.w * OVERLAP);
  const passX = await wrapX(pic, ov, false);
  const passY = await wrapX(transpose(passX.img), ov, true);
  const tile = transpose(passY.img);
  const cutRatio = cutSeamRatio(luma(tile), tile.w, passX.cut, [ov, pic.h - ov], passY.cut);

  // 3. Power of two.
  const size = SURFACE_BUDGET.sizes.reduce((best, s) => (Math.abs(s - tile.w) < Math.abs(best - tile.w) ? s : best));
  const albedo = await resizeWrapped(tile, size);
  const L = luma(albedo);
  const plane = planeFit(L, size, size);
  const wrap = wrapSeamRatio(L, size);
  const rep = repetition(L, size);

  // 4. Files.
  const files = { albedo: `${name}_albedo.png`, normal: `${name}_normal.png`, roughness: `${name}_roughness.png` };
  const maps = pbrMaps(albedo);
  await sharp(toBytes(albedo), { raw: { width: size, height: size, channels: 3 } }).png().toFile(runPath(id, files.albedo));
  await sharp(maps.normal, { raw: { width: size, height: size, channels: 3 } }).png().toFile(runPath(id, files.normal));
  await sharp(maps.roughness, { raw: { width: size, height: size, channels: 1 } }).png().toFile(runPath(id, files.roughness));
  await writeFile(runPath(id, `${files.albedo}.import`), importPreset(false));
  await writeFile(runPath(id, `${files.normal}.import`), importPreset(true));
  await writeFile(runPath(id, `${files.roughness}.import`), importPreset(false));
  const tres = `${name}.tres`;
  await writeFile(runPath(id, tres), materialTres(name, files));
  const deliver = [...Object.values(files).flatMap((f) => [f, `${f}.import`]), tres].map((f) => runPath(id, f));
  const zip = `${name}.zip`;
  await rm(runPath(id, zip), { force: true });
  await run("zip", ["-j", "-X", "-q", runPath(id, zip), ...deliver]);

  checks.push({ id: "surface.power_of_two", pass: (SURFACE_BUDGET.sizes as readonly number[]).includes(size) && albedo.w === albedo.h, value: size, limit: SURFACE_BUDGET.sizes.join("|"), detail: `${tile.w} px repeat resampled with wrap-around` });
  checks.push({ id: "surface.wrap_seam", pass: wrap <= SURFACE_BUDGET.maxSeamRatio, value: +wrap.toFixed(3), limit: SURFACE_BUDGET.maxSeamRatio, detail: `p95 step across the wrap edges / p95 step between neighbours; the picture as drawn: ${rawWrap.toFixed(2)}` });
  checks.push({ id: "surface.cut_seam", pass: cutRatio <= SURFACE_BUDGET.maxSeamRatio, value: +cutRatio.toFixed(3), limit: SURFACE_BUDGET.maxSeamRatio, detail: `the two repair cuts: p95 step across the ${2 * FEATHER + 1} px cross-fade / p95 step at that spacing` });
  checks.push({ id: "surface.lighting_slope", pass: rawPlane.slope <= SURFACE_BUDGET.maxLightingSlope, value: +rawPlane.slope.toFixed(4), limit: SURFACE_BUDGET.maxLightingSlope, detail: `luminance plane fit of the picture as drawn, change across it / mean, divided out; the tile's own fit (content, a wrapping tile has no linear light): ${plane.slope.toFixed(3)}` });
  // Advisory: uncalibrated, see SURFACE_BUDGET.maxRepetition. A block the model drew twice stays
  // twice inside the tile, but the crop breaks its period, so the tile alone under-reads it.
  const repeat = Math.max(rep, rawRep);
  checks.push({ id: "surface.repetition", pass: repeat <= SURFACE_BUDGET.maxRepetition, value: +repeat.toFixed(3), limit: SURFACE_BUDGET.maxRepetition, advisory: true, detail: `peak autocorrelation at lags of 1/8 side or more, the larger of the endless tiling (${rep.toFixed(2)}) and the picture as drawn (${rawRep.toFixed(2)}; near 1: the model copied a block)` });
  // The palette check needs the style the picture was drawn with, not whichever is wired now.
  const fit = used.style && used.style === opts.style?.runId ? await paletteFitCheck(runPath(id, files.albedo), opts.style) : undefined;
  if (fit) checks.push(fit);

  // 5. Godot.
  const g = await godotRender(deliver, tres, join(dir, "surface_renders"));
  checks.push({ id: "godot.import.clean", pass: g.importLog.length === 0, value: g.importLog.length, limit: 0, detail: g.importLog.slice(0, 5).join(" | ") || undefined });
  const res = g.result;
  checks.push({ id: "godot.material.loaded", pass: !!res?.loaded, detail: res ? res.problems.join("; ") || "StandardMaterial3D with albedo, normal and roughness textures" : "render_surface.gd produced no result" });
  const texProblems = res
    ? (["albedo", "normal", "roughness"] as const).flatMap((slot) => {
      const t = res.textures[slot];
      if (!t) return [`${slot}: missing`];
      return [
        t.w !== size || t.h !== size ? `${slot}: ${t.w}x${t.h}` : "",
        !t.mipmaps ? `${slot}: no mipmaps` : "",
        !t.compressed ? `${slot}: not VRAM-compressed` : "",
        slot === "normal" && !t.normal_map ? "normal: not imported as a normal map" : "",
      ].filter(Boolean);
    })
    : ["not loaded"];
  checks.push({ id: "godot.textures.imported", pass: texProblems.length === 0, value: texProblems.length, limit: 0, detail: texProblems.join("; ") || "power-of-two, mipmapped, VRAM-compressed; normal map as RG" });
  const renders: Surface["renders"] = [];
  for (const [i, r] of (res?.renders ?? []).entries()) {
    const file = `surface_render_${i}.png`;
    await copyFile(r.file, runPath(id, file));
    renders.push({ url: runUrl(id, file), heightM: r.height, seamRatio: +(await renderSeamRatio(r.file, r.height)).toFixed(3) });
  }
  await rm(join(dir, "surface_renders"), { recursive: true, force: true });
  const worst = renders.reduce((m, r) => Math.max(m, r.seamRatio), 0);
  checks.push({
    id: "godot.render.seam", pass: renders.length === CAMERA_HEIGHTS_M.length && worst <= SURFACE_BUDGET.maxRenderSeamRatio,
    value: renders.length ? worst : undefined, limit: SURFACE_BUDGET.maxRenderSeamRatio,
    detail: renders.length
      ? `strongest tile-edge line / strongest line between edges, per camera height: ${renders.map((r) => `${r.heightM} m ${r.seamRatio}`).join(", ")}`
      : "no renders",
  });

  return {
    kind: "surface", runId: id,
    material: used.material, prompt: used.prompt, model: used.model, resolution: used.resolution, styleRun: used.style,
    templateUrl: runUrl(id, "surface_template.png"), rawUrl: runUrl(id, "surface_raw.png"),
    albedoUrl: runUrl(id, files.albedo), normalUrl: runUrl(id, files.normal), roughnessUrl: runUrl(id, files.roughness),
    tresUrl: runUrl(id, tres), zipUrl: runUrl(id, zip),
    size, tileM: SURFACE_BUDGET.tileM, renders,
    previewUrl: renders.at(-1)?.url ?? runUrl(id, files.albedo),
    godot: { version: g.version, importIssues: g.importLog },
    checks, createdAt: new Date().toISOString(), cost: { seconds: (Date.now() - t0) / 1000, kieCredits },
  };
}
