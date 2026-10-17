/**
 * Module-level media state shared by the grid, the cards and the composer.
 * Lives outside React so it survives remounts (route changes, tab switches).
 */

/** URLs whose full image has loaded once — suppresses the shimmer on revisit. */
export const loadedImageUrls = new Set<string>();
/** url → "w / h", discovered from the media itself when the DB has no ratio. */
export const naturalRatioCache = new Map<string, string>();

const RATIOS_KEY = "buonarroti-gallery-ratios";
const LOADED_KEY = "buonarroti-gallery-loaded";

if (typeof window !== "undefined") {
  try {
    const ratios = JSON.parse(sessionStorage.getItem(RATIOS_KEY) ?? "{}") as Record<string, string>;
    for (const [url, r] of Object.entries(ratios)) naturalRatioCache.set(url, r);
  } catch {}
  try {
    const loaded = JSON.parse(sessionStorage.getItem(LOADED_KEY) ?? "[]") as string[];
    for (const url of loaded) loadedImageUrls.add(url);
  } catch {}
}

export function persistNaturalRatios() {
  try { sessionStorage.setItem(RATIOS_KEY, JSON.stringify(Object.fromEntries(naturalRatioCache))); } catch {}
}

export function persistLoadedImages() {
  try { sessionStorage.setItem(LOADED_KEY, JSON.stringify([...loadedImageUrls])); } catch {}
}

/** Parses "16:9" / "16 / 9" into a width/height ratio, or null. */
export function parseRatio(ar: string | undefined | null): number | null {
  if (!ar || ar === "auto" || ar === "Auto" || ar === "adaptive" || ar === "custom") return null;
  const [w, h] = ar.includes("/") ? ar.split("/") : ar.split(":");
  const wn = parseFloat(w), hn = parseFloat(h);
  return wn && hn ? wn / hn : null;
}

// ── Concurrency limiter: at most 4 gallery images load simultaneously ───────
const imgQueue: Array<() => void> = [];
let imgActive = 0;
const IMG_CONCURRENCY = 4;

/** Runs `fn` when a load slot is free. Returns a cancel function for queued work. */
export function requestImageSlot(fn: () => void): () => void {
  if (imgActive < IMG_CONCURRENCY) { imgActive++; fn(); return () => {}; }
  imgQueue.push(fn);
  return () => { const i = imgQueue.indexOf(fn); if (i !== -1) imgQueue.splice(i, 1); };
}

export function releaseImageSlot() {
  imgActive = Math.max(0, imgActive - 1);
  const next = imgQueue.shift();
  if (next) { imgActive++; next(); }
}

/**
 * The gallery item being dragged from the grid onto a composer slot. Kept out of
 * dataTransfer to avoid browser quirks; the MIME type
 * "application/x-gallery-item" is still set so drop targets can recognise it.
 */
export const galleryDrag: { item: { url: string; mediaType: "image" | "video" } | null } = { item: null };
export const GALLERY_DRAG_MIME = "application/x-gallery-item";
