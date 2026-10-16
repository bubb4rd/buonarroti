import { NextRequest, NextResponse } from "next/server";
import https from "node:https";
import { spawn } from "node:child_process";
import { writeFile, unlink, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOnce,
  parseClientRequestId,
  runLocalJob,
  type CreateOutcome,
  type TerminalJobResult,
} from "@/lib/jobStore";
import { ensureJobsRecovered, pollKieJob } from "@/lib/kieJobPoller";
import { KIE_BASE, KieCreateError, createKieTask } from "@/lib/kieApi";
import { ensureKieReachable } from "@/lib/kieUpload";
import { ensureStorage, readMediaBuffer, uploadBuffer } from "@/lib/storage";
import { IMAGE_MODELS, validateAzureCustomSize } from "@/lib/modelConfig";
import { getKieToken } from "@/lib/getKieToken";
import { getAzureKeyForUser } from "@/lib/getAzureKey";
import { GUEST_USER_ID } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";

const CREATE = `${KIE_BASE}/api/v1/jobs/createTask`;
const MAX_REFERENCE_IMAGES = 14;
/** Largest Azure response we accept (a 4K PNG as base64 is ~30 MB). */
const MAX_AZURE_RESPONSE_BYTES = 100 * 1024 * 1024;

type CreateErrorCode = "credits" | "auth" | "invalid" | "upstream" | "rate_limited";

function errorOutcome(error: string, code: CreateErrorCode, status: number): CreateOutcome {
  return { status, body: { error, code } };
}

function respond(outcome: CreateOutcome): NextResponse {
  return NextResponse.json(outcome.body, { status: outcome.status });
}

/**
 * A minimal HTTPS POST that uses Node.js core — NOT Next.js's patched `fetch`.
 * Next.js ties its patched fetch to the request's AbortSignal, which cancels
 * any pending calls when the HTTP response commits. This helper is immune to
 * that because it goes through the raw TLS stack. The socket may sit idle for
 * up to `timeoutMs` (Azure sends nothing until the image is done) and the
 * response body is capped at MAX_AZURE_RESPONSE_BYTES.
 */
function httpsPost(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs = 1_000_000, // Azure image gen (gpt-image-2) can be slow; 1000s gives ample headroom
): Promise<{ ok: boolean; status: number; text: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ ok: boolean; status: number; text: string }>();
  const u       = new URL(url);
  const bodyBuf = Buffer.from(body, "utf8");

  const req = https.request(
    {
      hostname: u.hostname,
      port:     u.port ? Number(u.port) : 443,
      path:     u.pathname + u.search,
      method:   "POST",
      headers:  { ...headers, "Content-Length": bodyBuf.byteLength },
    },
    (res) => {
      const chunks: Buffer[] = [];
      let size = 0;

      // Response stream errors (e.g. ECONNRESET mid-body) must be caught here
      res.on("error", reject);
      res.on("data",  (c: Buffer) => {
        size += c.byteLength;
        if (size > MAX_AZURE_RESPONSE_BYTES) {
          req.destroy(new Error("Azure sent a response larger than 100 MB"));
          return;
        }
        chunks.push(c);
      });
      res.on("end",   () => {
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString("utf8") });
      });
    },
  );

  // Disable Nagle and keep-alive so the socket stays alive for long responses
  req.on("socket", (socket) => {
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Azure didn't answer within ${timeoutMs / 1000}s`));
    });
  });

  req.on("error", reject);
  req.write(bodyBuf);
  req.end();
  return promise;
}

// Send a multipart/form-data request via curl (bypasses Node.js TLS quirks with Azure)
async function curlMultipartPost(
  url:        string,
  authKey:    string,
  images:     Array<{ buf: Buffer; mime: string; ext: string }>,
  textFields: Record<string, string>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const tmpFiles: string[] = [];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bodyPath = join(tmpdir(), `azure-resp-${stamp}.json`);
  // The key goes through a private header file, never argv — argv shows up in
  // `ps` and in our own logs.
  const headerPath = join(tmpdir(), `azure-hdr-${stamp}.txt`);

  try {
    await writeFile(headerPath, `Authorization: Bearer ${authKey}\n`, { mode: 0o600 });
    tmpFiles.push(headerPath);
    for (const img of images) {
      const p = join(tmpdir(), `azure-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${img.ext}`);
      await writeFile(p, img.buf);
      tmpFiles.push(p);
    }
    const imagePaths = tmpFiles.slice(1);

    const args = [
      "-s", "-m", "600",
      "-X", "POST", url,
      "-H", `@${headerPath}`,
      "-o", bodyPath,
      "-w", "%{http_code}",
    ];
    for (let i = 0; i < images.length; i++) {
      args.push("-F", `image[]=@${imagePaths[i]};type=${images[i].mime}`);
    }
    for (const [k, v] of Object.entries(textFields)) {
      args.push("-F", `${k}=${v}`);
    }

    console.log("[azure/edits/curl] args:", args);

    const runCurl = () => {
      const { promise, resolve, reject } = Promise.withResolvers<{ statusStr: string; stderr: string; exitCode: number }>();
      let out = "";
      let err = "";
      const proc = spawn("curl", args);
      proc.stdout.on("data", (d: Buffer) => out += d.toString());
      proc.stderr.on("data", (d: Buffer) => err += d.toString());
      proc.on("close",  (code) => resolve({ statusStr: out.trim(), stderr: err, exitCode: code ?? -1 }));
      proc.on("error",  (e) => reject(new Error(`curl spawn failed: ${e.message}`)));
      return promise;
    };

    let statusStr = "", stderr = "", exitCode = -1;
    for (let attempt = 1; attempt <= 3; attempt++) {
      ({ statusStr, stderr, exitCode } = await runCurl());
      console.log(`[azure/edits/curl] attempt ${attempt} exit code:`, exitCode);
      if (stderr) console.log("[azure/edits/curl] stderr:", stderr);
      if (exitCode !== 35) break; // 35 = SSL handshake failure — retry
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }

    if (exitCode !== 0) {
      const reason = exitCode === 28 ? "timed out after 600s" : `curl exited with code ${exitCode}`;
      throw new Error(`Azure request failed: ${reason}`);
    }

    const status = parseInt(statusStr, 10) || 0;
    const body   = await readFile(bodyPath, "utf-8").catch(() => "");
    console.log("[azure/edits/curl] status:", status, "body:", body.slice(0, 300));
    return { ok: status >= 200 && status < 300, status, body };
  } finally {
    for (const f of [...tmpFiles, bodyPath]) unlink(f).catch(() => {});
  }
}

/**
 * Store every reference image locally (data URLs decoded, remote URLs
 * mirrored). Images that can't be loaded are left out and reported in
 * `warnings` — never dropped silently.
 */
async function resolveReferenceImages(imageUrls: string[]): Promise<{ urls: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  if (imageUrls.length > MAX_REFERENCE_IMAGES) {
    warnings.push(`Only the first ${MAX_REFERENCE_IMAGES} reference images were used; ${imageUrls.length - MAX_REFERENCE_IMAGES} were left out.`);
  }
  const settled = await Promise.allSettled(
    imageUrls.slice(0, MAX_REFERENCE_IMAGES).map((u) => ensureStorage(u, "references")),
  );
  const urls: string[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      urls.push(r.value);
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      console.warn(`[generate] reference image ${i + 1} failed to load:`, reason);
      warnings.push(`Reference image ${i + 1} couldn't be loaded (${reason}), so it wasn't used.`);
    }
  });
  return { urls, warnings };
}

// codex-imagegen (https://github.com/jdmnk/codex-imagegen-cli) only accepts these four sizes.
const CODEX_SIZE_MAP: Record<string, string> = {
  auto:   "auto",
  "1:1":  "1024x1024",
  "16:9": "1536x1024",
  "9:16": "1024x1536",
  "4:3":  "1536x1024",
  "3:4":  "1024x1536",
};

/**
 * codex-imagegen's stderr wraps the underlying failure as `codex-imagegen exited
 * with code N: <tmp path> Error: <detail>`, where <detail> is either a JSON blob
 * (e.g. `HTTP 429: {"error":{"message":"..."}}`) or plain prose terminated by a
 * semicolon (e.g. `Responses stream ended without an image result; last status
 * was failed.`). Pull out just the useful part instead of showing the whole dump.
 */
function cleanCodexError(raw: string): string {
  const match = raw.match(/Error:\s*([\s\S]*)$/);
  const tail = (match ? match[1] : raw).trim();

  const braceIdx = tail.indexOf("{");
  if (braceIdx !== -1) {
    try {
      const parsed = JSON.parse(tail.slice(braceIdx));
      const message = parsed?.error?.message;
      if (typeof message === "string" && message) return message;
    } catch { /* not valid JSON — fall through */ }
  }

  const semiIdx = tail.indexOf(";");
  return (semiIdx !== -1 ? tail.slice(0, semiIdx).trim() : tail) || raw;
}

/**
 * Runs the `codex-imagegen` CLI, which drives OpenAI Codex's image tool using the
 * server's local `codex login` session (~/.codex/auth.json) — a single shared
 * identity for the whole deployment, not a per-user API key. Writes reference
 * images to temp files (the CLI takes file paths, not URLs) and reads the
 * generated PNG back from its --out path.
 */
async function runCodexImagegen(opts: {
  prompt: string;
  images: Array<{ buf: Buffer; ext: string }>;
  size: string;
}): Promise<Buffer> {
  const tmpFiles: string[] = [];
  const outPath = join(tmpdir(), `codex-out-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

  try {
    const imagePaths: string[] = [];
    for (const img of opts.images) {
      const p = join(tmpdir(), `codex-in-${Date.now()}-${Math.random().toString(36).slice(2)}.${img.ext}`);
      await writeFile(p, img.buf);
      tmpFiles.push(p);
      imagePaths.push(p);
    }

    const args = imagePaths.length > 0
      ? ["edit", ...imagePaths.flatMap((p) => ["--image", p]), "--prompt", opts.prompt, "--size", opts.size, "--out", outPath, "--force"]
      : ["generate", "--prompt", opts.prompt, "--size", opts.size, "--out", outPath, "--force"];

    const run = Promise.withResolvers<{ exitCode: number; stderr: string }>();
    let err = "";
    const proc = spawn("codex-imagegen", args);
    proc.stderr.on("data", (d: Buffer) => err += d.toString());
    proc.on("close", (code) => run.resolve({ exitCode: code ?? -1, stderr: err }));
    proc.on("error", (e) => run.reject(new Error(`codex-imagegen couldn't start: ${e.message}. Is it installed and on PATH?`)));
    const { exitCode, stderr } = await run.promise;

    if (exitCode !== 0) {
      // The useful part — codex-imagegen's final `Error: ...` line — is at the
      // *tail* of stderr, after any retry `Warning:` lines. Those warnings
      // (now including a raw failed-item dump per retry, see cli.py's
      // item_failed_no_detail handling) can push well past a head-truncated
      // slice, which cuts the real error off before cleanCodexError() ever
      // sees it. Log the untruncated stream for debugging and only cap what
      // gets wrapped into the thrown Error as a sane upper bound.
      console.error("[codex-imagegen] full stderr:", stderr || "(empty)");
      throw new Error(`codex-imagegen exited with code ${exitCode}: ${stderr.slice(-4000) || "no stderr output"}`);
    }

    return await readFile(outPath);
  } finally {
    for (const f of [...tmpFiles, outPath]) unlink(f).catch(() => {});
  }
}

/** Load reference images for a local provider (Azure/Codex) that takes raw bytes. */
async function loadImageBytes(urls: string[]): Promise<Array<{ buf: Buffer; ext: string; mime: string }>> {
  return Promise.all(
    urls.map(async (url) => {
      const buf  = await readMediaBuffer(url);
      const raw  = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "png";
      const ext  = raw === "jpg" ? "jpeg" : raw;
      const mime = ext === "jpeg" ? "image/jpeg" : "image/png";
      return { buf, ext, mime };
    }),
  );
}

const AZURE_REJECTED_CODES = new Set(["content_policy_violation", "moderation_blocked", "content_filter", "contentFilter"]);

interface GenerateBody {
  model?:              string;
  prompt?:             string;
  imageUrls?:          string[];
  aspectRatio?:        string;
  quality?:            string;
  azureQuality?:       string;     // "auto" | "low" | "medium" | "high"
  azureResolution?:    string;     // "1k" | "2k" | "4k"
  azureBaseUrl?:       string;     // global base URL from settings
  azureDeployment?:    string;     // per-model deployment name from settings
  azureCustomWidth?:   number;     // manual size — used when aspectRatio === "custom"
  azureCustomHeight?:  number;
  codexProvider?:      boolean;    // route through the server's local codex-imagegen CLI
  debugOnly?:          boolean;
  clientRequestId?:    string;     // idempotency key — a retry returns the same task
}

export const maxDuration = 1000;

export async function POST(req: NextRequest) {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return respond(errorOutcome("The request body isn't valid JSON.", "invalid", 400));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return respond(errorOutcome("The request body must be a JSON object.", "invalid", 400));
  }
  const body = parsed as GenerateBody;
  if (body.imageUrls !== undefined && (!Array.isArray(body.imageUrls) || body.imageUrls.some((u) => typeof u !== "string"))) {
    return respond(errorOutcome("imageUrls must be a list of URLs.", "invalid", 400));
  }

  const {
    model       = "nano-banana-2",
    prompt,
    imageUrls   = [],
    aspectRatio = "1:1",
    quality     = "1k",
    azureQuality,
    azureResolution,
    azureBaseUrl,
    azureDeployment,
    azureCustomWidth,
    azureCustomHeight,
    codexProvider,
    debugOnly,
  } = body;
  const clientRequestId = parseClientRequestId(body.clientRequestId);

  if (debugOnly) {
    const payload = { model, prompt, imageUrls, aspectRatio, quality, azureQuality, azureResolution, azureCustomWidth, azureCustomHeight };
    console.log("[DEBUG] generate payload:", JSON.stringify(payload, null, 2));
    return NextResponse.json({ ok: true });
  }

  if (typeof prompt !== "string" || !prompt.trim()) {
    return respond(errorOutcome("Write a prompt first.", "invalid", 400));
  }

  const cfg = IMAGE_MODELS.find((m) => m.id === model);
  if (!cfg) return respond(errorOutcome(`Unknown model: ${model}`, "invalid", 400));

  await ensureJobsRecovered();

  const currentUserId = GUEST_USER_ID;

  // ── Azure Foundry branch ──────────────────────────────────────────────────────
  if (azureBaseUrl && azureDeployment) {
    const azureKey = (await getAzureKeyForUser()) ?? process.env.AZURE_API_KEY ?? null;
    if (!azureKey) return respond(errorOutcome("No Azure API key is saved. Add one in Settings.", "auth", 401));

    return respond(await createOnce(clientRequestId, async () => {
      const { urls: refImages, warnings } = await resolveReferenceImages(imageUrls);
      const sentImages = refImages.slice(0, cfg.maxImages);
      if (refImages.length > sentImages.length) {
        warnings.push(`This model takes up to ${cfg.maxImages} reference images; the rest were left out.`);
      }

      const resSizeMaps     = cfg.azureResolutionSizeMaps ?? {};
      const sizeMap         = (azureResolution && resSizeMaps[azureResolution]) ? resSizeMaps[azureResolution] : (cfg.azureSizeMap ?? {});
      const customSizeError = aspectRatio === "custom" && azureCustomWidth && azureCustomHeight
        ? validateAzureCustomSize(azureCustomWidth, azureCustomHeight)
        : null;
      const size            = aspectRatio === "custom" && azureCustomWidth && azureCustomHeight && !customSizeError
        ? `${azureCustomWidth}x${azureCustomHeight}`
        : (sizeMap[aspectRatio] ?? "1024x1024");
      const azureQualityLevel = azureQuality || "medium";
      const base            = azureBaseUrl.replace(/\/$/, "");
      const azureApiVersion = cfg.azureApiVersion ?? "2025-04-01-preview";
      const truncatedPrompt = prompt.slice(0, cfg.apiInput.promptMaxLength ?? 32000);

      const azureTaskId = `azure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      guestDb.insertGeneration({
        task_id: azureTaskId, user_id: currentUserId, generation_type: "image",
        status: "pending", provider: "azure", client_request_id: clientRequestId,
        prompt: prompt.slice(0, 2000), model, aspect_ratio: aspectRatio, quality: azureQualityLevel,
        azure_resolution: azureResolution,
        reference_image_urls: sentImages.length > 0 ? sentImages : undefined,
      });

      runLocalJob(azureTaskId, async (): Promise<TerminalJobResult> => {
        let res: { ok: boolean; status: number; text: string };

        if (sentImages.length > 0) {
          // ── Image-to-image: multipart /images/edits via curl ─────────────
          const azureUrl = `${base}/openai/deployments/${azureDeployment}/images/edits?api-version=${azureApiVersion}`;
          const images = await loadImageBytes(sentImages);

          const textFields: Record<string, string> = {
            prompt:        truncatedPrompt,
            quality:       azureQualityLevel,
            output_format: "png",
            n:             "1",
          };
          if (size && size !== "auto") textFields.size = size;

          const curl = await curlMultipartPost(azureUrl, azureKey, images, textFields);
          res = { ok: curl.ok, status: curl.status, text: curl.body };
        } else {
          // ── Text-to-image: JSON /images/generations ────────────────────────
          const azureUrl = `${base}/openai/deployments/${azureDeployment}/images/generations?api-version=${azureApiVersion}`;

          const requestBody: Record<string, unknown> = {
            prompt:             truncatedPrompt,
            n:                  1,
            output_format:      "png",
            output_compression: 100,
            quality:            azureQualityLevel,
          };
          if (size && size !== "auto") requestBody.size = size;

          console.log("[azure/generations] request →", { url: azureUrl, method: "POST", body: requestBody });

          res = await httpsPost(
            azureUrl,
            { "Content-Type": "application/json", Authorization: `Bearer ${azureKey}` },
            JSON.stringify(requestBody),
          );
        }

        console.log("[azure] response status:", res.status, "body:", res.text.slice(0, 300));
        if (!res.ok) {
          let displayError = `Azure returned an error (HTTP ${res.status}). Try again.`;
          let rejected = false;
          try {
            const errJson = JSON.parse(res.text);
            const code    = errJson?.error?.code ?? errJson?.error?.type;
            const message = errJson?.error?.message;
            rejected = typeof code === "string" && AZURE_REJECTED_CODES.has(code);
            if (code === "EngineOverloaded") displayError = "The model is overloaded right now. Try again in a minute.";
            else if (typeof message === "string" && message) displayError = message;
            else if (typeof code === "string") displayError = code;
          } catch { /* not JSON — keep the HTTP status message */ }
          return { status: "error", error: displayError, code: rejected ? "rejected" : "failed" };
        }

        const azureJson = JSON.parse(res.text);
        const b64 = azureJson?.data?.[0]?.b64_json as string | undefined;
        if (!b64) return { status: "error", error: "Azure finished but sent back no image. Retry it.", code: "failed" };

        const imageUrl = await uploadBuffer(Buffer.from(b64, "base64"), "image/png", "generated");
        return { status: "done", imageUrl };
      });

      return { status: 200, body: { taskId: azureTaskId, ...(warnings.length > 0 ? { warnings } : {}) } };
    }));
  }

  // ── Codex CLI branch ───────────────────────────────────────────────────────────
  // codex-imagegen has no per-user token — it's a single shared `codex login`
  // session on this host — so there's no key lookup here, unlike the other branches.
  if (codexProvider) {
    return respond(await createOnce(clientRequestId, async () => {
      const { urls: refImages, warnings } = await resolveReferenceImages(imageUrls);
      const sentImages = refImages.slice(0, 5);
      if (refImages.length > sentImages.length) {
        warnings.push("Codex takes up to 5 reference images; the rest were left out.");
      }

      const codexTaskId = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const size = CODEX_SIZE_MAP[aspectRatio] ?? "auto";

      // "<<<image N>>>" tags are an in-text convention other providers resolve to a
      // URL; codex-imagegen takes images as separate file args, so just flatten the
      // tag to plain prose instead.
      // Codex's --size only offers 4 fixed canvases (no true 4:3/3:4), so spelling out
      // the intended ratio in the prompt steers composition even when the canvas itself
      // is an approximation.
      const codexPrompt = (prompt
        .slice(0, cfg.apiInput.promptMaxLength ?? 8000)
        .replace(/<<<image (\d+)>>>/gi, (_m, n) => `image ${n}`)
        + (aspectRatio && aspectRatio !== "auto" ? ` Aspect ratio: ${aspectRatio}.` : "")).trim();

      guestDb.insertGeneration({
        task_id: codexTaskId, user_id: currentUserId, generation_type: "image",
        status: "pending", provider: "codex", client_request_id: clientRequestId,
        prompt: prompt.slice(0, 2000), model, aspect_ratio: aspectRatio, quality,
        reference_image_urls: sentImages.length > 0 ? sentImages : undefined,
      });

      runLocalJob(codexTaskId, async (): Promise<TerminalJobResult> => {
        try {
          const images = await loadImageBytes(sentImages);
          const outBuf   = await runCodexImagegen({ prompt: codexPrompt, images, size });
          const imageUrl = await uploadBuffer(outBuf, "image/png", "generated");
          return { status: "done", imageUrl };
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error("[codex] background error:", msg);
          return { status: "error", error: cleanCodexError(msg), code: "failed" };
        }
      });

      return { status: 200, body: { taskId: codexTaskId, ...(warnings.length > 0 ? { warnings } : {}) } };
    }));
  }

  // ── Kie.ai branch ─────────────────────────────────────────────────────────────
  const kieToken = await getKieToken();
  if (!kieToken) return respond(errorOutcome("No kie.ai API key is saved. Add one in Settings.", "auth", 401));

  return respond(await createOnce(clientRequestId, async () => {
    try {
      const { apiInput } = cfg;
      const { urls: refImages, warnings } = await resolveReferenceImages(imageUrls);

      // kie.ai can't fetch our local reference images, so push them to kie's
      // temporary file store first. Each failure becomes a warning.
      const reachable = await Promise.allSettled(refImages.map((u) => ensureKieReachable(u, kieToken)));
      const sentLocal: string[] = [];
      const kieImageUrls: string[] = [];
      reachable.forEach((r, i) => {
        if (r.status === "fulfilled") {
          sentLocal.push(refImages[i]);
          kieImageUrls.push(r.value);
        } else {
          const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
          console.warn(`[generate] couldn't upload reference image ${i + 1} to kie.ai:`, reason);
          warnings.push(`Reference image ${i + 1} couldn't be uploaded to kie.ai (${reason}), so it wasn't used.`);
        }
      });
      if (apiInput.imageInputKey && kieImageUrls.length > cfg.maxImages) {
        warnings.push(`This model takes up to ${cfg.maxImages} reference images; the rest were left out.`);
      }

      // ── Dual-mode models (e.g. GPT Image 2) ────────────────────────────────────
      const hasImages = kieImageUrls.length > 0;
      const resolvedApiId = !hasImages && cfg.textOnlyApiId ? cfg.textOnlyApiId : cfg.apiId;

      const input: Record<string, unknown> = {
        prompt:                    prompt.slice(0, apiInput.promptMaxLength),
        [apiInput.aspectRatioKey]: aspectRatio,
      };

      if (apiInput.outputFormat)               input.output_format           = apiInput.outputFormat;
      if (apiInput.imageInputKey && hasImages) input[apiInput.imageInputKey] = kieImageUrls.slice(0, cfg.maxImages);
      if (apiInput.qualityKey) {
        input[apiInput.qualityKey] = apiInput.qualityMap
          ? (apiInput.qualityMap[quality] ?? quality)
          : quality === "4k" ? "4K" : quality === "2k" ? "2K" : quality === "1k" ? "1K" : quality;
      }
      if (apiInput.extra) Object.assign(input, apiInput.extra);

      // The app polls kie.ai (lib/kieJobPoller), so no callback URL.
      const taskId = await createKieTask(CREATE, kieToken, { model: resolvedApiId, input });

      guestDb.insertGeneration({
        task_id: taskId, user_id: currentUserId, generation_type: "image",
        status: "pending", provider: "kie", client_request_id: clientRequestId,
        prompt, model, aspect_ratio: aspectRatio, quality,
        reference_image_urls: apiInput.imageInputKey ? sentLocal.slice(0, cfg.maxImages) : [],
      });
      pollKieJob(taskId, kieToken, "image", "kie");

      return { status: 200, body: { taskId, ...(warnings.length > 0 ? { warnings } : {}) } };
    } catch (e: unknown) {
      if (e instanceof KieCreateError) return errorOutcome(e.message, e.code, e.httpStatus);
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[generate] couldn't start generation:", msg);
      return errorOutcome(`Couldn't start the generation: ${msg}`, "upstream", 500);
    }
  }));
}
