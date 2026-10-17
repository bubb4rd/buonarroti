/**
 * Style guide: the look shared by every asset of one game.
 *
 * A style is given as pictures, not adjectives: the references are sent to the
 * image model after each step's layout template (the template fixes pose and
 * framing, the references fix rendering and colour), and generated pictures are
 * measured against the palette taken from them.
 *
 * Palette fit is CIEDE2000 distance in CIELAB, the colour-difference formula
 * print and paint matching use; it is advisory until calibrated against
 * people's "belongs to the same game" verdicts.
 */
import { readFile } from "fs/promises";
import { resolve, sep } from "path";
import sharp from "sharp";
import { MEDIA_DIR } from "../guest/paths";
import type { Check, StyleGuide } from "./artifacts";
import { pathForRunUrl, runDir, runPath, runUrl } from "./runs";

export const STYLE_BUDGET = {
  minRefs: 1,
  /** nano-banana-pro takes up to 14 image inputs; one is the layout template and some steps add more. */
  maxRefs: 6,
  /** Palette colours extracted from the references. */
  paletteSize: 8,
  /** A pixel "fits" when its CIEDE2000 distance to the nearest palette colour is at most this. */
  fitDeltaE: 15,
  /** Share of a generated picture's foreground pixels that must fit (advisory, uncalibrated). */
  minPaletteFit: 0.7,
  /** References narrower than this on their short side carry too little style to read. */
  minRefSide: 256,
} as const;

// ── Colour ──────────────────────────────────────────────────────────────────

export type Lab = [number, number, number];

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** sRGB (0–255) to CIELAB, D65 white. */
export function toLab(r: number, g: number, b: number): Lab {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const x = f((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const y = f(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const z = f((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function labToHex([L, a, b]: Lab): string {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
  return "#" + lin.map((v) => {
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, s)) * 255).toString(16).padStart(2, "0");
  }).join("");
}

function hexToLab(hex: string): Lab {
  const n = parseInt(hex.slice(1), 16);
  return toLab((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/** CIEDE2000 colour difference (Sharma, Wu & Dalal 2005). */
export function deltaE2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1, ap2 = (1 + G) * a2;
  const Cp1 = Math.hypot(ap1, b1), Cp2 = Math.hypot(ap2, b2);
  const hue = (b: number, a: number) => (b === 0 && a === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const hp1 = hue(b1, ap1), hp2 = hue(b2, ap2);
  const dL = L2 - L1, dC = Cp2 - Cp1;
  let dh = 0;
  if (Cp1 * Cp2 !== 0) dh = Math.abs(hp2 - hp1) <= 180 ? hp2 - hp1 : hp2 - hp1 > 180 ? hp2 - hp1 - 360 : hp2 - hp1 + 360;
  const dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);
  const Lm = (L1 + L2) / 2, Cpm = (Cp1 + Cp2) / 2;
  let hm = hp1 + hp2;
  if (Cp1 * Cp2 !== 0) hm = Math.abs(hp1 - hp2) <= 180 ? hm / 2 : hm < 360 ? (hm + 360) / 2 : (hm - 360) / 2;
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * Cpm, Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/** Lab samples of an image's opaque pixels, downscaled so the long side is at most `side`. */
async function labPixels(file: string, side = 160): Promise<Lab[]> {
  const { data, info } = await sharp(file).resize(side, side, { fit: "inside" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out: Lab[] = [];
  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * 4;
    if (data[o + 3] < 128) continue;
    out.push(toLab(data[o], data[o + 1], data[o + 2]));
  }
  return out;
}

/** k-means in Lab, deterministic k-means++-style seeding (farthest point from the chosen seeds). */
export function kmeans(px: Lab[], k: number): { centre: Lab; share: number }[] {
  if (px.length === 0) return [];
  const dist2 = (p: Lab, c: Lab) => (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
  const centres: Lab[] = [px[Math.floor(px.length / 2)]];
  const nearest = px.map((p) => dist2(p, centres[0]));
  while (centres.length < Math.min(k, px.length)) {
    let far = 0;
    for (let i = 1; i < px.length; i++) if (nearest[i] > nearest[far]) far = i;
    centres.push(px[far]);
    for (let i = 0; i < px.length; i++) nearest[i] = Math.min(nearest[i], dist2(px[i], px[far]));
  }
  const assign = new Int32Array(px.length);
  for (let iter = 0; iter < 20; iter++) {
    let moved = false;
    for (let i = 0; i < px.length; i++) {
      let best = 0;
      for (let c = 1; c < centres.length; c++) if (dist2(px[i], centres[c]) < dist2(px[i], centres[best])) best = c;
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    const sum = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < px.length; i++) {
      const s = sum[assign[i]];
      s[0] += px[i][0]; s[1] += px[i][1]; s[2] += px[i][2]; s[3]++;
    }
    sum.forEach((s, c) => { if (s[3]) centres[c] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
    if (!moved && iter > 0) break;
  }
  const counts = centres.map(() => 0);
  for (let i = 0; i < px.length; i++) counts[assign[i]]++;
  return centres.map((centre, c) => ({ centre, share: counts[c] / px.length })).filter((c) => c.share > 0).sort((a, b) => b.share - a.share);
}

// ── Step: references (+ notes) → StyleGuide ──────────────────────────────────

/** Bytes of an image reference: a `/generated/…` file, a data URL, or an http(s) URL. */
export async function readReference(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  if (url.startsWith("/generated/")) {
    const root = resolve(MEDIA_DIR);
    const file = resolve(root, url.slice("/generated/".length));
    if (!file.startsWith(root + sep)) throw new Error(`reference outside the media folder: ${url}`);
    return readFile(file);
  }
  if (/^https?:\/\//.test(url)) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`reference download failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  throw new Error(`unsupported reference: ${url.slice(0, 60)}`);
}

export async function runStyle(opts: { runId: string; images: string[]; notes?: string }): Promise<StyleGuide> {
  const t0 = Date.now();
  await runDir(opts.runId);
  const refs: string[] = [];
  let smallest = Infinity;
  for (const [i, url] of opts.images.slice(0, STYLE_BUDGET.maxRefs).entries()) {
    const file = `style-ref-${i + 1}.png`;
    // Long side capped at 1536: enough for the model to read rendering, small enough to upload fast.
    const info = await sharp(await readReference(url)).rotate()
      .resize(1536, 1536, { fit: "inside", withoutEnlargement: true })
      .png().toFile(runPath(opts.runId, file));
    smallest = Math.min(smallest, info.width, info.height);
    refs.push(runUrl(opts.runId, file));
  }
  const px = (await Promise.all(refs.map((r) => labPixels(pathForRunUrl(r))))).flat();
  const palette = kmeans(px, STYLE_BUDGET.paletteSize).map((c) => ({ hex: labToHex(c.centre), share: +c.share.toFixed(4) }));

  const swatch = runPath(opts.runId, "style-palette.png");
  await writePaletteSwatch(refs.map(pathForRunUrl), palette, swatch);

  const checks: Check[] = [
    { id: "style.refs", pass: refs.length >= STYLE_BUDGET.minRefs, value: refs.length, limit: STYLE_BUDGET.minRefs, detail: "reference pictures" },
    { id: "style.refs_dropped", pass: opts.images.length <= STYLE_BUDGET.maxRefs, value: opts.images.length, limit: STYLE_BUDGET.maxRefs, advisory: true, detail: "references beyond the limit are ignored" },
    { id: "style.ref_resolution", pass: refs.length > 0 && smallest >= STYLE_BUDGET.minRefSide, value: Number.isFinite(smallest) ? smallest : 0, limit: STYLE_BUDGET.minRefSide, advisory: true, detail: "short side of the smallest reference, px" },
  ];
  return {
    kind: "style", runId: opts.runId, refs, notes: opts.notes?.trim() || undefined, palette,
    previewUrl: runUrl(opts.runId, "style-palette.png"),
    checks, createdAt: new Date().toISOString(), cost: { seconds: (Date.now() - t0) / 1000 },
  };
}

/** Preview: the references in a row over a strip of palette swatches sized by share. */
async function writePaletteSwatch(files: string[], palette: StyleGuide["palette"], out: string): Promise<void> {
  const W = 1024, refH = 768, stripH = 256;
  const cell = Math.floor(W / Math.max(1, files.length));
  const layers: sharp.OverlayOptions[] = [];
  for (const [i, f] of files.entries()) {
    layers.push({ input: await sharp(f).resize(cell, refH, { fit: "cover" }).toBuffer(), left: i * cell, top: 0 });
  }
  let x = 0;
  for (const [i, c] of palette.entries()) {
    const w = i === palette.length - 1 ? W - x : Math.max(1, Math.round(c.share * W));
    if (w <= 0) continue;
    layers.push({ input: { create: { width: w, height: stripH, channels: 3, background: c.hex } }, left: x, top: refH });
    x += w;
  }
  await sharp({ create: { width: W, height: refH + stripH, channels: 3, background: "#ffffff" } }).composite(layers).png().toFile(out);
}

// ── Used by every step that asks an image model for a picture ───────────────

/** Local files of the style's references, to append to a request's image_input. */
export function styleRefFiles(style: StyleGuide | undefined): string[] {
  return style ? style.refs.map(pathForRunUrl) : [];
}

/**
 * Prompt sentence pointing the model at the references. `first` is the 1-based
 * position of the first reference in image_input (after the layout template).
 */
export function stylePrompt(style: StyleGuide | undefined, first: number): string {
  if (!style) return "";
  const n = style.refs.length;
  const which = n === 1 ? `Attached image ${first} is the style reference` : `Attached images ${first} to ${first + n - 1} are style references`;
  return [
    `${which}: match its rendering, line work, shading model, level of detail and colour palette.`,
    "Take only the style from it, never its subjects, objects, composition or layout.",
    style.notes ? `Style notes: ${style.notes}.` : "",
  ].filter(Boolean).join(" ");
}

/**
 * Share of an image's opaque pixels whose nearest palette colour is within
 * STYLE_BUDGET.fitDeltaE. Transparent pixels and near-pure white (the plain
 * background templates ask for) are skipped, so a mostly white sheet doesn't pass.
 */
export async function paletteFitCheck(file: string, style: StyleGuide | undefined, id = "style.palette_fit"): Promise<Check | undefined> {
  if (!style || style.palette.length === 0) return undefined;
  const pal = style.palette.map((c) => hexToLab(c.hex));
  const px = (await labPixels(file, 192)).filter(([L, a, b]) => !(L > 97 && Math.abs(a) < 2 && Math.abs(b) < 2));
  let fit = 0;
  for (const p of px) {
    let best = Infinity;
    for (const c of pal) best = Math.min(best, deltaE2000(p, c));
    if (best <= STYLE_BUDGET.fitDeltaE) fit++;
  }
  const share = px.length ? fit / px.length : 0;
  return {
    id, pass: share >= STYLE_BUDGET.minPaletteFit, value: +share.toFixed(3), limit: STYLE_BUDGET.minPaletteFit, advisory: true,
    detail: `share of pixels within ΔE2000 ${STYLE_BUDGET.fitDeltaE} of the style palette`,
  };
}
