/**
 * Turnaround-sheet analysis: split a generated front/side/back sheet into three
 * views and measure whether it is usable as image-to-3D input.
 *
 * Everything here is pixel geometry on the sheet itself (no model calls), so a
 * rejection is reproducible and cheap: background is flood-filled from the
 * border, views are column runs of foreground, and the A-pose / orthographic
 * checks read the silhouettes.
 */
import sharp from "sharp";
import { writeFile } from "fs/promises";
import { join } from "path";
import { SHEET_BUDGET, type Check, type SheetView, type SheetViewName } from "./artifacts";

interface Mask {
  w: number;
  h: number;
  /** 1 = foreground (character), 0 = background. */
  fg: Uint8Array;
  /** Connected-component id per pixel (filled by `components`). */
  label: Int32Array;
}

interface Component { id: number; area: number; x0: number; x1: number; y0: number; y1: number }

const VIEW_ORDER: SheetViewName[] = ["front", "side", "back"];

/** 8-connected foreground components; boxes are [x0, x1) × [y0, y1). */
function components(mask: Mask): Component[] {
  const { w, h, fg, label } = mask;
  label.fill(-1);
  const out: Component[] = [];
  const stack = new Int32Array(w * h);
  for (let start = 0; start < fg.length; start++) {
    if (!fg[start] || label[start] >= 0) continue;
    const c: Component = { id: out.length, area: 0, x0: w, x1: 0, y0: h, y1: 0 };
    let sp = 0;
    stack[sp++] = start;
    label[start] = c.id;
    while (sp > 0) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x >= c.x1) c.x1 = x + 1;
      if (y < c.y0) c.y0 = y;
      if (y >= c.y1) c.y1 = y + 1;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (fg[j] && label[j] < 0) { label[j] = c.id; stack[sp++] = j; }
        }
      }
    }
    out.push(c);
  }
  return out;
}

/**
 * Background = pixels connected to the border whose colour is near the border
 * median. Long horizontal strokes (a drawn ground line spanning several views)
 * are made passable so they neither join the figures nor close the gap between
 * the legs.
 */
function segment(rgb: Buffer, w: number, h: number): { mask: Mask; bg: [number, number, number]; bgNoise: number; strokeRows: number } {
  const border: number[][] = [[], [], []];
  const push = (i: number) => { for (let c = 0; c < 3; c++) border[c].push(rgb[i * 3 + c]); };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  const median = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  const bg: [number, number, number] = [median(border[0]), median(border[1]), median(border[2])];
  let noise = 0;
  for (let i = 0; i < border[0].length; i++) {
    noise += Math.abs(border[0][i] - bg[0]) + Math.abs(border[1][i] - bg[1]) + Math.abs(border[2][i] - bg[2]);
  }
  const bgNoise = noise / border[0].length / 3;

  const passable = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = Math.abs(rgb[i * 3] - bg[0]) + Math.abs(rgb[i * 3 + 1] - bg[1]) + Math.abs(rgb[i * 3 + 2] - bg[2]);
    if (d < SHEET_BUDGET.bgTolerance) passable[i] = 1;
  }
  // A stroke pixel is solid with background STROKE_GAP rows above and below
  // (a line at most ~2*STROKE_GAP px thick). A row is a drawn line when such
  // pixels cover a quarter of the sheet width; only those thin pixels are cleared,
  // so figures crossing the line keep their silhouette.
  const STROKE_GAP = 5;
  const strokes = new Set<number>();
  const minStroke = Math.round(w * 0.25);
  const thin: number[] = [];
  for (let y = STROKE_GAP; y < h - STROKE_GAP; y++) {
    thin.length = 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!passable[i] && passable[i - STROKE_GAP * w] && passable[i + STROKE_GAP * w]) thin.push(i);
    }
    if (thin.length >= minStroke) {
      for (const i of thin) passable[i] = 1;
      strokes.add(y);
    }
  }

  const isBg = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const seed = (i: number) => { if (!isBg[i] && passable[i]) { isBg[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
  }
  const fg = new Uint8Array(w * h);
  for (let i = 0; i < fg.length; i++) fg[i] = isBg[i] ? 0 : 1;
  return { mask: { w, h, fg, label: new Int32Array(w * h) }, bg, bgNoise, strokeRows: strokes.size };
}

interface Box { x0: number; x1: number; y0: number; y1: number }

function bbox(mask: Mask, x0: number, x1: number): Box | null {
  let y0 = mask.h, y1 = -1, bx0 = x1, bx1 = x0;
  for (let y = 0; y < mask.h; y++) {
    for (let x = x0; x < x1; x++) {
      if (mask.fg[y * mask.w + x]) {
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
      }
    }
  }
  return y1 < 0 ? null : { x0: bx0, x1: bx1 + 1, y0, y1: y1 + 1 };
}

/** Foreground runs along row `y` inside the box, ignoring specks narrower than `minRun`. */
function rowRuns(mask: Mask, box: Box, y: number, minRun: number): number {
  let count = 0, len = 0;
  for (let x = box.x0; x <= box.x1; x++) {
    const on = x < box.x1 && mask.fg[y * mask.w + x] === 1;
    if (on) len++;
    else { if (len >= minRun) count++; len = 0; }
  }
  return count;
}

/**
 * Longest contiguous run of rows inside the [from, to] band (0 = feet, 1 = head
 * top) whose foreground run count satisfies `ok`, as a fraction of figure height.
 */
function longestSpan(mask: Mask, box: Box, from: number, to: number, ok: (n: number) => boolean): number {
  const height = box.y1 - box.y0;
  const minRun = Math.max(2, Math.round(height * 0.004));
  let best = 0, cur = 0;
  for (let y = Math.round(box.y1 - 1 - from * (height - 1)); y >= Math.round(box.y1 - 1 - to * (height - 1)); y--) {
    if (ok(rowRuns(mask, box, y, minRun))) best = Math.max(best, ++cur);
    else cur = 0;
  }
  return best / height;
}

/** Mean luminance asymmetry between the left half and the mirrored right half of the silhouette. */
function lightingAsymmetry(rgb: Buffer, mask: Mask, box: Box): number {
  const cx = (box.x0 + box.x1) / 2;
  let diff = 0, n = 0;
  for (let y = box.y0; y < box.y1; y += 2) {
    for (let x = box.x0; x < cx; x += 2) {
      const mx = Math.round(2 * cx - x - 1);
      const i = y * mask.w + x, j = y * mask.w + mx;
      if (!mask.fg[i] || !mask.fg[j]) continue;
      const li = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
      const lj = 0.299 * rgb[j * 3] + 0.587 * rgb[j * 3 + 1] + 0.114 * rgb[j * 3 + 2];
      diff += li - lj;
      n++;
    }
  }
  return n ? Math.abs(diff / n) / 255 : 0;
}

/**
 * Silhouette IoU of two boxes' masks after normalising both to the same height;
 * `mirror` flips b. `band` limits the comparison to rows [from, to) as fractions
 * of the height measured from the top (head = [0, 0.2]).
 */
function silhouetteIoU(mask: Mask, a: Box, b: Box, mirror: boolean, band: [number, number] = [0, 1]): number {
  const H = 256;
  const sample = (box: Box, u: number, v: number, flip: boolean) => {
    const bh = box.y1 - box.y0;
    const scale = bh / H;
    const cx = (box.x0 + box.x1) / 2;
    const x = Math.round(cx + (flip ? -u : u) * scale);
    const y = Math.round(box.y0 + v * scale);
    if (x < box.x0 || x >= box.x1 || y < box.y0 || y >= box.y1) return 0;
    return mask.fg[y * mask.w + x];
  };
  let inter = 0, union = 0;
  for (let v = Math.floor(band[0] * H); v < Math.ceil(band[1] * H); v++) {
    for (let u = -H; u < H; u++) {
      const p = sample(a, u, v, false), q = sample(b, u, v, mirror);
      if (p && q) inter++;
      if (p || q) union++;
    }
  }
  return union ? inter / union : 0;
}

export interface SheetAnalysis {
  width: number;
  height: number;
  views: SheetView[];
  checks: Check[];
}

/**
 * Split `sheetPath` into `front.png`, `side.png`, `back.png` (RGBA, background
 * transparent, square, character centred) inside `outDir` and run the sheet checks.
 * Views are returned in sheet order; a sheet that does not contain exactly three
 * separated figures yields no views and a failing `views.count` check.
 */
export async function analyzeSheet(sheetPath: string, outDir: string): Promise<SheetAnalysis> {
  const { data, info } = await sharp(sheetPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  const { mask, bg, bgNoise, strokeRows } = segment(data, w, h);
  const checks: Check[] = [];

  checks.push({
    id: "sheet.background.flat",
    pass: bgNoise <= SHEET_BUDGET.bgMaxNoise,
    value: +bgNoise.toFixed(2),
    limit: SHEET_BUDGET.bgMaxNoise,
    detail: `border median rgb(${bg.join(",")})`,
  });
  checks.push({ id: "sheet.background.no_strokes", pass: strokeRows === 0, value: strokeRows, limit: 0, advisory: true, detail: "rows of a drawn ground line / border (removed before splitting)" });

  // Figures = connected foreground components at least half as tall as the
  // tallest one. Smaller components are kept only if they sit inside a figure's
  // column and height range (a detached strand of hair); anything else — the
  // "FRONT / SIDE / BACK" captions models add despite the prompt, signatures,
  // remnants of a ground line — is dropped from the mask before measuring.
  const comps = components(mask);
  const tallest = Math.max(0, ...comps.map((c) => c.y1 - c.y0));
  const figs = comps.filter((c) => c.y1 - c.y0 >= 0.5 * tallest && c.area > 0).sort((a, b) => a.x0 - b.x0);
  const keep = new Set(figs.map((c) => c.id));
  let dropped = 0;
  for (const c of comps) {
    if (keep.has(c.id)) continue;
    const host = figs.find((f) => c.x0 >= f.x0 && c.x1 <= f.x1 && c.y0 >= f.y0 && c.y1 <= f.y1);
    if (host) keep.add(c.id);
    else dropped++;
  }
  for (let i = 0; i < mask.fg.length; i++) mask.fg[i] = mask.fg[i] && keep.has(mask.label[i]) ? 1 : 0;
  checks.push({ id: "sheet.views.extras_removed", pass: dropped === 0, value: dropped, limit: 0, advisory: true, detail: "captions / marks outside the figures, removed before splitting" });
  checks.push({ id: "sheet.views.count", pass: figs.length === 3, value: figs.length, limit: 3 });
  if (figs.length !== 3) return { width: w, height: h, views: [], checks };

  const boxes = figs.map((f) => bbox(mask, f.x0, f.x1)!);
  const heights = boxes.map((b) => b.y1 - b.y0);
  const medH = [...heights].sort((p, q) => p - q)[1];

  const heightSpread = (Math.max(...heights) - Math.min(...heights)) / medH;
  checks.push({ id: "sheet.ortho.height", pass: heightSpread <= SHEET_BUDGET.maxHeightSpread, value: +heightSpread.toFixed(3), limit: SHEET_BUDGET.maxHeightSpread, detail: "view heights must match (orthographic, same scale)" });
  const feet = boxes.map((b) => b.y1);
  const feetSpread = (Math.max(...feet) - Math.min(...feet)) / medH;
  checks.push({ id: "sheet.ortho.groundline", pass: feetSpread <= SHEET_BUDGET.maxGroundSpread, value: +feetSpread.toFixed(3), limit: SHEET_BUDGET.maxGroundSpread, detail: "feet on one ground line" });
  const fill = medH / h;
  checks.push({ id: "sheet.views.scale", pass: fill >= SHEET_BUDGET.minFigureFill, value: +fill.toFixed(3), limit: SHEET_BUDGET.minFigureFill, detail: "figure height / sheet height" });

  const [front, side, back] = boxes;
  const frontW = (front.x1 - front.x0) / (front.y1 - front.y0);
  const sideW = (side.x1 - side.x0) / (side.y1 - side.y0);
  checks.push({ id: "sheet.side.profile", pass: sideW <= frontW * SHEET_BUDGET.maxSideToFrontWidth, value: +(sideW / frontW).toFixed(3), limit: SHEET_BUDGET.maxSideToFrontWidth, detail: "middle view must be a profile, narrower than the front (A-pose arms spread)" });

  // A-pose: arms read as separate runs beside the torso over the upper body band,
  // legs read as two runs over the shin band. Measured on front and back.
  for (const [name, box] of [["front", front], ["back", back]] as const) {
    const arms = longestSpan(mask, box, SHEET_BUDGET.armBand[0], SHEET_BUDGET.armBand[1], (n) => n >= 3);
    checks.push({ id: `sheet.apose.arms_${name}`, pass: arms >= SHEET_BUDGET.minArmGap, value: +arms.toFixed(3), limit: SHEET_BUDGET.minArmGap, detail: "tallest span where both arms are separated from the torso (fraction of height)" });
    const legs = longestSpan(mask, box, SHEET_BUDGET.legBand[0], SHEET_BUDGET.legBand[1], (n) => n >= 2);
    checks.push({ id: `sheet.apose.legs_${name}`, pass: legs >= SHEET_BUDGET.minLegGap, value: +legs.toFixed(3), limit: SHEET_BUDGET.minLegGap, detail: "tallest span where the legs are separated (fraction of height)" });
  }

  const iou = silhouetteIoU(mask, front, back, true);
  checks.push({ id: "sheet.back.matches_front", pass: iou >= SHEET_BUDGET.minFrontBackIoU, value: +iou.toFixed(3), limit: SHEET_BUDGET.minFrontBackIoU, detail: "mirrored back silhouette vs front (back-side drift)" });
  // Whole-body IoU hides costume drift at the head (hood up in front, down at the
  // back): compare the head band on its own.
  const headIou = silhouetteIoU(mask, front, back, true, [0, SHEET_BUDGET.headBand]);
  checks.push({ id: "sheet.back.head_matches_front", pass: headIou >= SHEET_BUDGET.minHeadIoU, value: +headIou.toFixed(3), limit: SHEET_BUDGET.minHeadIoU, detail: "mirrored back vs front, top of the figure only (hood / hair / hat drift)" });

  const asym = lightingAsymmetry(data, mask, front);
  checks.push({ id: "sheet.lighting.flat", pass: asym <= SHEET_BUDGET.maxLightAsymmetry, value: +asym.toFixed(3), limit: SHEET_BUDGET.maxLightAsymmetry, detail: "left/right luminance asymmetry of the front view (directional light)" });

  const views: SheetView[] = [];
  for (let k = 0; k < 3; k++) {
    const box = boxes[k];
    const bw = box.x1 - box.x0, bh = box.y1 - box.y0;
    const pad = Math.round(bh * 0.06);
    const size = Math.max(bw, bh) + 2 * pad;
    const rgba = Buffer.alloc(bw * bh * 4);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const si = (box.y0 + y) * w + box.x0 + x;
        const di = (y * bw + x) * 4;
        rgba[di] = data[si * 3]; rgba[di + 1] = data[si * 3 + 1]; rgba[di + 2] = data[si * 3 + 2];
        rgba[di + 3] = mask.fg[si] ? 255 : 0;
      }
    }
    const file = `${VIEW_ORDER[k]}.png`;
    const png = await sharp(rgba, { raw: { width: bw, height: bh, channels: 4 } })
      .extend({
        top: Math.floor((size - bh) / 2), bottom: Math.ceil((size - bh) / 2),
        left: Math.floor((size - bw) / 2), right: Math.ceil((size - bw) / 2),
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    await writeFile(join(outDir, file), png);
    views.push({ name: VIEW_ORDER[k], file, box: { x: box.x0, y: box.y0, w: bw, h: bh } });
  }
  return { width: w, height: h, views, checks };
}
