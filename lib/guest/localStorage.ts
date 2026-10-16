import { writeFile, mkdir, readFile, rename, unlink } from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import { join, normalize } from "path";
import { randomUUID, createHash } from "crypto";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import https from "node:https";
import http  from "node:http";
import type { IncomingMessage } from "node:http";
import { lookupAssetHash, storeAssetHash } from "./db";
import { stripMetadata, stripVideoMetadataFile } from "../mediaMetadata";
import { MEDIA_DIR as GENERATED_DIR } from "./paths";

/** A stalled socket (no bytes either way) is abandoned after this long. */
const IDLE_TIMEOUT_MS = 30_000;
/** Hard ceiling for a whole download, body included. */
const TOTAL_TIMEOUT_MS = 15 * 60_000;
/** Images and audio are held in memory; videos stream to disk. */
const MAX_BUFFERED_BYTES = 100 * 1024 * 1024;
const MAX_VIDEO_BYTES = 4 * 1024 * 1024 * 1024;

function hashBuffer(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function ext(contentType: string): string {
  if (contentType.includes("mp4"))  return "mp4";
  if (contentType.includes("webm")) return "webm";
  if (contentType.includes("quicktime")) return "mov";
  if (contentType.includes("png"))  return "png";
  if (contentType.includes("gif"))  return "gif";
  if (contentType.includes("webp")) return "webp";
  if (contentType.startsWith("audio")) {
    if (contentType.includes("mpeg")) return "mp3";
    if (contentType.includes("wav"))  return "wav";
    if (contentType.includes("ogg"))  return "ogg";
    return "m4a";
  }
  return "jpg";
}

const TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg",
};

/** CDNs often send `application/octet-stream`; fall back to the URL's extension. */
function contentTypeFor(header: string | undefined, url: string): string {
  const type = header?.split(";")[0].trim().toLowerCase();
  if (type && type !== "application/octet-stream" && type !== "binary/octet-stream") return type;
  const urlExt = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  return TYPE_BY_EXT[urlExt] ?? type ?? "image/jpeg";
}

export async function uploadBuffer(buffer: Buffer, contentType: string, folder: string): Promise<string> {
  buffer = await stripMetadata(buffer, contentType);
  const hash   = hashBuffer(buffer);
  const cached = lookupAssetHash(hash);
  if (cached) return cached;

  await mkdir(join(GENERATED_DIR, folder), { recursive: true });
  const filename = `${randomUUID()}.${ext(contentType)}`;
  await writeFile(join(GENERATED_DIR, folder, filename), buffer);
  const url = `/generated/${folder}/${filename}`;

  storeAssetHash(hash, url, contentType, buffer.byteLength);
  return url;
}

/**
 * GET a remote URL, following redirects, and hand back the 2xx response. Idle
 * sockets and slow transfers are cut off (IDLE_TIMEOUT_MS / TOTAL_TIMEOUT_MS),
 * so a hung CDN can never stall a caller forever.
 */
function openDownload(url: string, redirectsLeft = 5, deadline = Date.now() + TOTAL_TIMEOUT_MS): Promise<IncomingMessage> {
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  if (redirectsLeft < 0) {
    reject(new Error("Too many redirects"));
    return promise;
  }
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    reject(new Error(`Unsupported URL scheme: ${u.protocol}`));
    return promise;
  }
  const mod = u.protocol === "https:" ? https : http;
  const req = mod.get(url, (res) => {
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      clearTimeout(overall);
      openDownload(new URL(res.headers.location, url).toString(), redirectsLeft - 1, deadline).then(resolve, reject);
      return;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      clearTimeout(overall);
      reject(new Error(`HTTP ${status} fetching ${u.origin}${u.pathname}`));
      return;
    }
    res.once("close", () => clearTimeout(overall));
    resolve(res);
  });
  const overall = setTimeout(
    () => req.destroy(new Error(`Download took longer than ${TOTAL_TIMEOUT_MS / 60_000} minutes`)),
    Math.max(0, deadline - Date.now()),
  );
  req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error(`Download stalled for ${IDLE_TIMEOUT_MS / 1000}s`)));
  req.on("error", (e) => {
    clearTimeout(overall);
    reject(e);
  });
  return promise;
}

function tooLarge(limit: number): Error {
  return new Error(`File is larger than ${Math.round(limit / (1024 * 1024))} MB`);
}

async function readBody(res: IncomingMessage, maxBytes: number): Promise<Buffer> {
  if (Number(res.headers["content-length"] ?? 0) > maxBytes) {
    res.destroy();
    throw tooLarge(maxBytes);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res as AsyncIterable<Buffer>) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      res.destroy();
      throw tooLarge(maxBytes);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Download a remote URL into memory, capped at MAX_BUFFERED_BYTES. */
export async function fetchToBuffer(url: string): Promise<{ buf: Buffer; contentType: string }> {
  const res = await openDownload(url);
  const contentType = contentTypeFor(res.headers["content-type"], url);
  return { buf: await readBody(res, MAX_BUFFERED_BYTES), contentType };
}

/** Read a `/generated/...` path straight off disk, or download any http(s) URL. */
export async function readMediaBuffer(url: string): Promise<Buffer> {
  if (url.startsWith("/generated/")) {
    const rel = normalize(decodeURIComponent(url.slice("/generated/".length).split(/[?#]/)[0]));
    if (rel.startsWith("..") || rel.includes("\0")) throw new Error(`Refusing to read outside media dir: ${url}`);
    return readFile(join(GENERATED_DIR, rel));
  }
  return (await fetchToBuffer(url)).buf;
}

async function hashFile(path: string): Promise<{ hash: string; bytes: number }> {
  const h = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    h.update(chunk);
    bytes += chunk.byteLength;
  }
  return { hash: h.digest("hex"), bytes };
}

/** Stream a video response to disk (never fully in memory), strip metadata, dedupe by hash. */
async function storeVideoStream(res: IncomingMessage, contentType: string, folder: string): Promise<string> {
  if (Number(res.headers["content-length"] ?? 0) > MAX_VIDEO_BYTES) {
    res.destroy();
    throw tooLarge(MAX_VIDEO_BYTES);
  }
  const dir = join(GENERATED_DIR, folder);
  await mkdir(dir, { recursive: true });
  const extension = ext(contentType);
  const id = randomUUID();
  const incoming = join(dir, `.incoming-${id}.${extension}`);
  const stripped = join(dir, `.stripped-${id}.${extension}`);

  let size = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.byteLength;
      done(size > MAX_VIDEO_BYTES ? tooLarge(MAX_VIDEO_BYTES) : null, chunk);
    },
  });

  let source = incoming;
  try {
    await pipeline(res, cap, createWriteStream(incoming));
    try {
      await stripVideoMetadataFile(incoming, stripped);
      source = stripped;
    } catch (e) {
      // Keeping the video matters more than its metadata (e.g. ffmpeg missing).
      console.warn("[storage] couldn't strip video metadata, keeping the original:", (e as Error).message);
    }

    const { hash, bytes } = await hashFile(source);
    const cached = lookupAssetHash(hash);
    if (cached) return cached;

    const filename = `${id}.${extension}`;
    await rename(source, join(dir, filename));
    const url = `/generated/${folder}/${filename}`;
    storeAssetHash(hash, url, contentType, bytes);
    return url;
  } finally {
    await Promise.all([unlink(incoming).catch(() => {}), unlink(stripped).catch(() => {})]);
  }
}

/** Download a remote URL into local storage and return its `/generated/...` path. */
export async function mirrorToStorage(url: string, folder: string): Promise<string> {
  const res = await openDownload(url);
  const contentType = contentTypeFor(res.headers["content-type"], url);
  if (contentType.startsWith("video/")) return storeVideoStream(res, contentType, folder);
  return uploadBuffer(await readBody(res, MAX_BUFFERED_BYTES), contentType, folder);
}

export async function uploadDataUrl(dataUrl: string, folder: string): Promise<string> {
  const m = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);
  if (!m) throw new Error("Not a valid data URL");
  return uploadBuffer(Buffer.from(m[2], "base64"), m[1], folder);
}

/** Resolve any URL to a locally-stored `/generated/...` path. Remote URLs are
 *  mirrored to disk; `data:` URLs are decoded; already-local paths pass through.
 *  kie.ai reference images are made reachable separately by `lib/kieUpload.ts`
 *  (base64 upload to kie's temp store), so no public tunnel URL is needed. */
export async function ensureStorage(url: string, folder: string): Promise<string> {
  if (url.startsWith("data:"))         return uploadDataUrl(url, folder);
  if (url.startsWith("/generated/"))   return url;
  return mirrorToStorage(url, folder);
}
