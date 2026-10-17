/**
 * Make image inputs reachable by kie.ai from a machine with no public URL.
 *
 * Hosted mode hands kie.ai a public R2 URL and (with a tunnel) can even expose
 * local files. The desktop app has neither, so local / data-URL images are
 * pushed to kie.ai's temporary file store (`POST /api/file-base64-upload`,
 * retained 3 days — long enough for a generation) and the returned `downloadUrl`
 * is used instead.
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MEDIA_DIR } from "./guest/paths";

// kie.ai's temp file store lives on this host, not api.kie.ai (their docs are
// stale). Files land on tempfile.redpandaai.co and are purged after 3 days.
const UPLOAD_URL = "https://kieai.redpandaai.co/api/file-base64-upload";

function isRemotelyReachable(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const { hostname } = new URL(url);
    return hostname !== "localhost" && hostname !== "127.0.0.1" && hostname !== "0.0.0.0";
  } catch {
    return false;
  }
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
};

/** A local reference that kie.ai can't fetch and we must re-host. */
function isLocalMedia(url: string): boolean {
  return url.startsWith("data:") || url.startsWith("/generated/");
}

/** Read a `/generated/...` path or a `data:` URL into a base64 data URL. */
async function toDataUrl(input: string): Promise<string> {
  if (input.startsWith("data:")) return input;

  const rel = input.replace(/^\/generated\//, "").replace(/^\/+/, "");
  const buf = await readFile(join(MEDIA_DIR, rel));
  const ext = rel.split(".").pop()?.toLowerCase() ?? "";
  const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// The same reference used in several input fields (or several runs) uploads
// once. Failed uploads are dropped so the next attempt retries; successes
// expire well before kie.ai purges its temp files (3 days).
const CACHE_TTL_MS = 12 * 60 * 60_000;
const CACHE_MAX_ENTRIES = 200;
const uploadCache = new Map<string, { url: Promise<string>; at: number }>();

async function doUpload(input: string, apiKey: string): Promise<string> {
  const base64Data = await toDataUrl(input);
  const res = await fetch(UPLOAD_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ base64Data, uploadPath: "buonarroti" }),
    signal: AbortSignal.timeout(120_000),
  });
  const json = await res.json().catch(() => null);
  const url = json?.data?.downloadUrl;
  if (!res.ok || !url) {
    throw new Error(`kie.ai file upload failed (${res.status}): ${json?.msg ?? "no downloadUrl"}`);
  }
  return url as string;
}

function uploadOne(input: string, apiKey: string): Promise<string> {
  // data: URLs can be megabytes — key them by digest instead of holding the string twice.
  const key = input.startsWith("data:") ? `sha256:${createHash("sha256").update(input).digest("hex")}` : input;
  const hit = uploadCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.url;
  uploadCache.delete(key);

  const url = doUpload(input, apiKey);
  uploadCache.set(key, { url, at: Date.now() });
  url.catch(() => {
    if (uploadCache.get(key)?.url === url) uploadCache.delete(key);
  });
  // Map iterates in insertion order, so the first key is the oldest.
  while (uploadCache.size > CACHE_MAX_ENTRIES) {
    const oldest = uploadCache.keys().next().value;
    if (oldest === undefined) break;
    uploadCache.delete(oldest);
  }
  return url;
}

/**
 * Return a URL kie.ai can fetch for this image: already-public URLs pass
 * through, local / data-URL images are pushed to kie.ai's temp store. Throws if
 * the upload fails — the caller must surface it, never drop it silently.
 */
export function ensureKieReachable(url: string, apiKey: string): Promise<string> {
  return isRemotelyReachable(url) ? Promise.resolve(url) : uploadOne(url, apiKey);
}

/**
 * Deep-walk a kie.ai `input` payload and replace every local `/generated/...` or
 * `data:` media reference (in strings, arrays, and nested objects) with a kie.ai
 * temporary URL. Mutates in place. Use for the video route, whose payload shape
 * varies a lot between model families.
 */
export async function rewriteLocalMediaForKie(node: unknown, apiKey: string): Promise<void> {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      if (typeof node[i] === "string" && isLocalMedia(node[i])) {
        node[i] = await uploadOne(node[i], apiKey);
      } else {
        await rewriteLocalMediaForKie(node[i], apiKey);
      }
    }
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === "string" && isLocalMedia(value)) {
        (node as Record<string, unknown>)[key] = await uploadOne(value, apiKey);
      } else {
        await rewriteLocalMediaForKie(value, apiKey);
      }
    }
  }
}
