import { NextRequest, NextResponse } from "next/server";
import { createOnce, parseClientRequestId, type CreateOutcome } from "@/lib/jobStore";
import { ensureJobsRecovered, pollKieJob } from "@/lib/kieJobPoller";
import { KIE_BASE, KieCreateError, createKieTask } from "@/lib/kieApi";
import { rewriteLocalMediaForKie } from "@/lib/kieUpload";
import { ensureStorage } from "@/lib/storage";
import { VIDEO_MODELS } from "@/lib/modelConfig";
import { getKieToken } from "@/lib/getKieToken";
import { GUEST_USER_ID } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";

interface Resource {
  url: string;
  label: string;
}

interface KlingElementInput {
  name: string;
  description: string;
  imageUrls: string[];
}

type CreateErrorCode = "credits" | "auth" | "invalid" | "upstream" | "rate_limited";

function errorOutcome(error: string, code: CreateErrorCode, status: number): CreateOutcome {
  return { status, body: { error, code } };
}

function respond(outcome: CreateOutcome): NextResponse {
  return NextResponse.json(outcome.body, { status: outcome.status });
}

/**
 * Store a reference locally (mirrors remote URLs, decodes data URLs). If that
 * fails the original URL is kept: `rewriteLocalMediaForKie` re-hosts local and
 * data URLs, and kie.ai fetches public ones itself — nothing is dropped.
 */
function keepLocal(url: string): Promise<string> {
  return ensureStorage(url, "references").catch((e: unknown) => {
    console.warn("[generate-video] couldn't store reference locally, sending it as-is:", (e as Error).message);
    return url;
  });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

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
  const body = parsed as Record<string, unknown>;

  try {
  const {
    videoModel      = typeof body.model === "string" && body.model ? body.model : "kling-3.0",
    prompt,
    startFrameUrl:  rawStartFrame,
    endFrameUrl:    rawEndFrame,
    videoRefUrl:    rawVideoRef,
    resources       = [] as Resource[],
    klingElements   = [] as KlingElementInput[],
    sound           = false,
    duration        = 5,
    aspectRatio     = typeof body.aspect_ratio === "string" && body.aspect_ratio ? body.aspect_ratio : "16:9",
    mode            = "pro",
    resolution:     rawResolution,
    seed,
    veoMode,
    generationType: rawGenerationType,
    debugOnly       = false,
  } = body as {
    videoModel?: string; prompt?: string; startFrameUrl?: string; endFrameUrl?: string; videoRefUrl?: string;
    resources?: Resource[]; klingElements?: KlingElementInput[]; sound?: boolean; duration?: number | string;
    aspectRatio?: string; mode?: string; resolution?: string; seed?: number | string | null; veoMode?: string;
    generationType?: string; debugOnly?: boolean;
  };
  const rawRefImages    = stringList(body.referenceImageUrls ?? body.imageUrls);
  const rawRefVideoUrls = stringList(body.referenceVideoUrls);
  const rawRefAudioUrls = stringList(body.referenceAudioUrls);
  const clientRequestId = parseClientRequestId(body.clientRequestId);
  const warnings: string[] = [];

  const userId = GUEST_USER_ID;

  const apiKey = await getKieToken();
  if (!apiKey) return respond(errorOutcome("No kie.ai API key is saved. Add one in Settings.", "auth", 401));

  const cfg = VIDEO_MODELS.find((m) => m.id === videoModel);
  if (!cfg) return respond(errorOutcome(`Unknown video model: ${videoModel}`, "invalid", 400));

  const resolution = rawResolution || cfg.defaultResolution || "480p";
  const { apiInput } = cfg;
  const isSeedance25EditModel = cfg.id === "seedance-2-5-edit";
  const effectiveAspectRatio = isSeedance25EditModel ? "adaptive" : aspectRatio;

  // Clamp duration to model limits (motion-control has no duration field)
  const clampedDuration = isSeedance25EditModel
    ? -1
    : apiInput.durationMax > 0
    ? Math.max(apiInput.durationMin, Math.min(apiInput.durationMax, Number(duration)))
    : 0;

  let input: Record<string, unknown>;
  let effectiveApiId = cfg.apiId;

  if (apiInput.useMotionControl) {
    // ── Kling 2.6 motion control ──────────────────────────────────────────────
    // { prompt, input_urls, video_urls, mode, character_orientation }
    const [inputImageUrl, inputVideoUrl] = await Promise.all([
      rawStartFrame ? keepLocal(rawStartFrame) : undefined,
      rawVideoRef   ? keepLocal(rawVideoRef)   : undefined,
    ]);

    input = {
      prompt:                prompt ?? "",
      input_urls:            inputImageUrl ? [inputImageUrl] : [],
      video_urls:            inputVideoUrl ? [inputVideoUrl] : [],
      mode:                  resolution,   // "720p" or "1080p"
      character_orientation: mode,         // "image" or "video"
    };
    if (apiInput.extra) Object.assign(input, apiInput.extra);

  } else if (apiInput.useMinimaxH3) {
    // ── MiniMax H3 (text / image / reference to video) ───────────────────────
    const [startFrameUrl, endFrameUrl, r2RefImages, r2RefVideos, r2RefAudios] = await Promise.all([
      rawStartFrame ? keepLocal(rawStartFrame) : undefined,
      rawEndFrame   ? keepLocal(rawEndFrame)   : undefined,
      Promise.all(rawRefImages.map(keepLocal)),
      Promise.all(rawRefVideoUrls.map(keepLocal)),
      Promise.all(rawRefAudioUrls.map(keepLocal)),
    ]);

    if (startFrameUrl || endFrameUrl) {
      // image-to-video — frames take priority over references
      effectiveApiId = cfg.imageApiId!;
      input = {
        prompt:                 prompt ?? "",
        [apiInput.durationKey!]: clampedDuration,
      };
      if (startFrameUrl)          input[apiInput.firstFrameKey!] = startFrameUrl;
      if (endFrameUrl)            input[apiInput.lastFrameKey!]  = endFrameUrl;
      if (apiInput.resolutionKey) input[apiInput.resolutionKey]  = resolution;
      if (r2RefImages.length > 0) warnings.push("Reference images aren't used when a start or end frame is set.");
    } else if (r2RefImages.length > 0) {
      // reference-to-video
      effectiveApiId = "minimax-h3/reference-to-video";
      input = {
        prompt:                     prompt ?? "",
        [apiInput.referenceImagesKey!]: r2RefImages.slice(0, 9),
        [apiInput.aspectRatioKey!]: aspectRatio,
        [apiInput.durationKey!]:    clampedDuration,
      };
      // reference_audio cannot be used alone — it always rides along with images here
      if (r2RefVideos.length > 0 && apiInput.referenceVideosKey) input[apiInput.referenceVideosKey] = r2RefVideos.slice(0, 3);
      if (r2RefAudios.length > 0 && apiInput.referenceAudiosKey) input[apiInput.referenceAudiosKey] = r2RefAudios.slice(0, 3);
      if (apiInput.resolutionKey) input[apiInput.resolutionKey] = resolution;
    } else {
      // text-to-video
      effectiveApiId = cfg.apiId;
      input = {
        prompt:                     prompt ?? "",
        [apiInput.aspectRatioKey!]: aspectRatio,
        [apiInput.durationKey!]:    clampedDuration,
      };
      if (apiInput.resolutionKey) input[apiInput.resolutionKey] = resolution;
    }

  } else if (apiInput.firstFrameKey) {
    // ── Seedance-style models (separate frame keys + multi-ref arrays) ─────────
    const [startFrameUrl, endFrameUrl, r2RefImages, r2RefVideos, r2RefAudios] = await Promise.all([
      rawStartFrame ? keepLocal(rawStartFrame) : undefined,
      rawEndFrame   ? keepLocal(rawEndFrame)   : undefined,
      Promise.all(rawRefImages.map(keepLocal)),
      Promise.all(rawRefVideoUrls.map(keepLocal)),
      Promise.all(rawRefAudioUrls.map(keepLocal)),
    ]);

    input = {
      [apiInput.aspectRatioKey!]: effectiveAspectRatio,
      [apiInput.durationKey!]:    clampedDuration,
    };

    if (prompt?.trim())                                        input.prompt                       = prompt;
    if (apiInput.firstFrameKey  && startFrameUrl)              input[apiInput.firstFrameKey]       = startFrameUrl;
    if (apiInput.lastFrameKey   && endFrameUrl)                input[apiInput.lastFrameKey]        = endFrameUrl;
    if (apiInput.resolutionKey)                                input[apiInput.resolutionKey]       = resolution;
    if (apiInput.soundKey)                                     input[apiInput.soundKey]            = Boolean(sound);
    // Seedance (and similar): first/last frames and reference images are mutually exclusive
    if (apiInput.referenceImagesKey && r2RefImages.length > 0) {
      if (!startFrameUrl && !endFrameUrl) input[apiInput.referenceImagesKey] = r2RefImages;
      else warnings.push("Reference images aren't used when a start or end frame is set.");
    }
    if (apiInput.referenceVideosKey && r2RefVideos.length > 0) input[apiInput.referenceVideosKey]  = r2RefVideos;
    if (apiInput.referenceAudiosKey && r2RefAudios.length > 0) input[apiInput.referenceAudiosKey]  = r2RefAudios;
    if (apiInput.extra)                                        Object.assign(input, apiInput.extra);

  } else if (apiInput.useHappyHorse) {
    // ── HappyHorse (Alibaba) — routes to text/image/reference endpoint ────────
    const [refImageUrls, startFrameUrl] = await Promise.all([
      Promise.all(rawRefImages.map(keepLocal)),
      rawStartFrame ? keepLocal(rawStartFrame) : undefined,
    ]);

    const maybeSeed = seed !== undefined && seed !== null && Number(seed) > 0 ? Number(seed) : undefined;

    if (refImageUrls.length > 0) {
      effectiveApiId = "happyhorse/reference-to-video";
      input = {
        prompt: prompt ?? "",
        reference_image: refImageUrls.slice(0, 9),
        [apiInput.aspectRatioKey!]: aspectRatio,
        [apiInput.durationKey!]:    clampedDuration,
      };
      if (apiInput.resolutionKey) input[apiInput.resolutionKey] = resolution;
      if (maybeSeed !== undefined && apiInput.seedKey) input[apiInput.seedKey] = maybeSeed;
      if (startFrameUrl) warnings.push("The start frame isn't used when reference images are set.");
    } else if (startFrameUrl) {
      effectiveApiId = "happyhorse/image-to-video";
      input = {
        image_urls:             [startFrameUrl],
        [apiInput.durationKey!]: clampedDuration,
      };
      if (prompt?.trim()) input.prompt = prompt;
      // resolution is determined by the input image — do not send it
      if (maybeSeed !== undefined && apiInput.seedKey) input[apiInput.seedKey] = maybeSeed;
    } else {
      effectiveApiId = "happyhorse/text-to-video";
      input = {
        prompt: prompt ?? "",
        [apiInput.aspectRatioKey!]: aspectRatio,
        [apiInput.durationKey!]:    clampedDuration,
      };
      if (apiInput.resolutionKey) input[apiInput.resolutionKey] = resolution;
      if (maybeSeed !== undefined && apiInput.seedKey) input[apiInput.seedKey] = maybeSeed;
    }

  } else if (apiInput.useKlingTurbo) {
    // ── Kling 3.0 Turbo (text-to-video / image-to-video) ─────────────────────
    const startFrameUrl = rawStartFrame ? await keepLocal(rawStartFrame) : undefined;

    const durationValue = String(clampedDuration);

    if (startFrameUrl) {
      effectiveApiId = cfg.imageApiId!;
      input = {
        prompt:              prompt ?? "",
        image_urls:          [startFrameUrl],
        [apiInput.durationKey!]: durationValue,
        [apiInput.resolutionKey!]: resolution,
      };
    } else {
      effectiveApiId = cfg.apiId;
      input = {
        prompt:                     prompt ?? "",
        [apiInput.aspectRatioKey!]: aspectRatio,
        [apiInput.durationKey!]:    durationValue,
        [apiInput.resolutionKey!]:  resolution,
      };
    }

  } else if (apiInput.useGoogleVeo) {
    // ── Google Veo 3.1 ───────────────────────────────────────────────────────
    // Veo reads only `imageUrls` + `generationType`. The mode is derived from
    // the images actually attached — a client-sent generationType is only a
    // hint, so a retry can't strip images by sending TEXT_2_VIDEO.
    const [startFrameUrl, endFrameUrl, refImages] = await Promise.all([
      rawStartFrame ? keepLocal(rawStartFrame) : undefined,
      rawEndFrame   ? keepLocal(rawEndFrame)   : undefined,
      Promise.all(rawRefImages.map(keepLocal)),
    ]);

    // Veo 3.1 Lite has text-to-video and frames-to-video only; Fast and Quality
    // also accept reference images.
    const isLite = cfg.id === "veo3_lite";
    const wantsReferences = veoMode === "references" || rawGenerationType === "REFERENCE_2_VIDEO";
    const frames = [startFrameUrl, endFrameUrl].filter((u): u is string => !!u);

    let generationType: string;
    let imageUrls: string[];
    if (wantsReferences && !isLite && refImages.length > 0) {
      generationType = "REFERENCE_2_VIDEO";
      imageUrls = refImages.slice(0, 3);
      if (refImages.length > 3) warnings.push(`Veo takes up to 3 reference images; ${refImages.length - 3} were left out.`);
    } else if (frames.length > 0) {
      generationType = "FIRST_AND_LAST_FRAMES_2_VIDEO";
      imageUrls = frames;
      if (refImages.length > 0) warnings.push("Reference images aren't used when a start or end frame is set.");
    } else if (refImages.length > 0) {
      // Plain attached images (e.g. the Generate screen): first and last frames.
      generationType = "FIRST_AND_LAST_FRAMES_2_VIDEO";
      imageUrls = refImages.slice(0, 2);
      if (wantsReferences && isLite) warnings.push("Veo 3.1 Lite doesn't take reference images, so they were used as first and last frames.");
      if (refImages.length > 2) warnings.push(`Veo uses up to 2 images as first and last frames; ${refImages.length - 2} were left out.`);
    } else {
      generationType = "TEXT_2_VIDEO";
      imageUrls = [];
    }

    effectiveApiId = cfg.apiId; // veo3, veo3_fast, or veo3_lite

    input = {
      prompt: prompt ?? "",
      generationType,
      [apiInput.aspectRatioKey!]: aspectRatio,
      [apiInput.resolutionKey!]: resolution,
      imageUrls,
      watermark: "",
      enableFallback: false,
      enableTranslation: true,
    };
    if (apiInput.extra) Object.assign(input, apiInput.extra);

  } else if (apiInput.useGeminiOmniVideo) {
    // ── Gemini Omni Video (quota-based: image=1 slot, video=2 slots, max 7) ────
    const [r2RefImages, r2RefVideos] = await Promise.all([
      Promise.all(rawRefImages.map(keepLocal)),
      Promise.all(rawRefVideoUrls.slice(0, 1).map(keepLocal)),
    ]);

    const videoSlots = r2RefVideos.length > 0 ? 2 : 0;
    const clampedImages = r2RefImages.slice(0, 7 - videoSlots);
    if (r2RefImages.length > clampedImages.length) {
      warnings.push(`This model takes up to ${7 - videoSlots} reference images here; ${r2RefImages.length - clampedImages.length} were left out.`);
    }

    const maybeSeed = seed !== undefined && seed !== null && Number(seed) > 0 ? Number(seed) : undefined;

    input = { prompt: prompt ?? "" };
    if (clampedImages.length > 0) input.image_urls = clampedImages;
    if (r2RefVideos.length > 0)   input.video_list = r2RefVideos.map((url) => ({ url, start: 0, ends: 10 }));
    // duration is ignored by the model when video input is provided
    if (r2RefVideos.length === 0) input[apiInput.durationKey!] = String(clampedDuration);
    if (apiInput.aspectRatioKey)  input[apiInput.aspectRatioKey] = aspectRatio;
    if (apiInput.resolutionKey)   input[apiInput.resolutionKey]  = resolution;
    if (maybeSeed !== undefined && apiInput.seedKey) input[apiInput.seedKey] = maybeSeed;

  } else if (apiInput.referenceImagesKey) {
    // ── Reference-image-based models (Grok Imagine, Grok Imagine 1.5) ─────────
    const refImageUrls = await Promise.all(rawRefImages.map(keepLocal));

    const hasImages = refImageUrls.length > 0;
    effectiveApiId = hasImages && cfg.imageApiId ? cfg.imageApiId : cfg.apiId;

    const durationValue = apiInput.durationAsString ? String(clampedDuration) : clampedDuration;

    input = {
      prompt:                     prompt ?? "",
      [apiInput.aspectRatioKey!]: aspectRatio,
      [apiInput.durationKey!]:    durationValue,
    };

    if (apiInput.modeKey)       input[apiInput.modeKey]       = mode;
    if (apiInput.resolutionKey) input[apiInput.resolutionKey] = resolution;
    if (apiInput.extra)         Object.assign(input, apiInput.extra);
    if (hasImages) input[apiInput.referenceImagesKey] = refImageUrls;

  } else {
    // ── Start/end-frame + elements models (Kling) ─────────────────────────────
    const hasNewElements = klingElements.length > 0;

    const [startFrameUrl, endFrameUrl, r2Resources, uploadedElements] = await Promise.all([
      rawStartFrame ? keepLocal(rawStartFrame) : undefined,
      rawEndFrame   ? keepLocal(rawEndFrame)   : undefined,
      hasNewElements
        ? Promise.resolve([] as Resource[])
        : Promise.all(resources.slice(0, 3).map(async (r) => ({ ...r, url: await keepLocal(r.url) }))),
      hasNewElements
        ? Promise.all(
            klingElements.slice(0, 3).map(async (el) => ({
              name:        el.name,
              description: el.description,
              imageUrls:   await Promise.all(el.imageUrls.map(keepLocal)),
            }))
          )
        : Promise.resolve([] as { name: string; description: string; imageUrls: string[] }[]),
    ]);
    if ((hasNewElements ? klingElements.length : resources.length) > 3) {
      warnings.push("This model takes up to 3 elements; the rest were left out.");
    }

    input = {
      prompt:                     prompt ?? "",
      [apiInput.aspectRatioKey!]: aspectRatio,
      [apiInput.durationKey!]:    apiInput.durationAsString ? String(clampedDuration) : clampedDuration,
    };

    if (apiInput.modeKey)       input[apiInput.modeKey]       = mode;
    if (apiInput.soundKey)      input[apiInput.soundKey]      = Boolean(sound);
    if (apiInput.resolutionKey) input[apiInput.resolutionKey] = resolution;
    if (apiInput.extra)         Object.assign(input, apiInput.extra);

    if (apiInput.useImageUrls) {
      const image_urls: string[] = [];
      if (startFrameUrl) image_urls.push(startFrameUrl);
      if (endFrameUrl)   image_urls.push(endFrameUrl);
      if (image_urls.length > 0) input.image_urls = image_urls;
    }

    if (apiInput.useKlingElements) {
      let kling_elements: { name: string; description: string; element_input_urls: string[] }[] = [];
      if (hasNewElements) {
        kling_elements = uploadedElements.map((el) => ({
          name:               el.name,
          description:        el.description,
          element_input_urls: el.imageUrls.length >= 2 ? el.imageUrls : [el.imageUrls[0], el.imageUrls[0]],
        }));
      } else {
        kling_elements = r2Resources.map((r) => {
          const safeName = r.label.toLowerCase().replace(/\s+#/g, "_").replace(/[^a-z0-9_]/g, "") || "element";
          return { name: safeName, description: r.label, element_input_urls: [r.url, r.url] };
        });
      }
      if (kling_elements.length > 0) input.kling_elements = kling_elements;
    }
  }

  // Reference URLs recorded with the generation — captured before the kie.ai
  // rewrite below, so they point at our local copies, not 3-day temp files.
  const referenceUrls: string[] = apiInput.useMotionControl
    ? [
        ...((input.input_urls as string[] | undefined) ?? []),
        ...((input.video_urls as string[] | undefined) ?? []),
      ]
    : apiInput.useGeminiOmniVideo
    ? [
        ...((input.image_urls as string[] | undefined) ?? []),
        ...((input.video_list as Array<{ url: string }> | undefined)?.map((v) => v.url) ?? []),
      ]
    : apiInput.useGoogleVeo
    ? [...((input.imageUrls as string[] | undefined) ?? [])]
    : apiInput.useMinimaxH3
    ? [
        ...(input.first_frame_url ? [input.first_frame_url as string] : []),
        ...(input.last_frame_url  ? [input.last_frame_url as string]  : []),
        ...((input.reference_image_urls as string[] | undefined) ?? []),
        ...((input.reference_video_urls as string[] | undefined) ?? []),
        ...((input.reference_audio_urls as string[] | undefined) ?? []),
      ]
    : apiInput.referenceImagesKey
    ? [...((input[apiInput.referenceImagesKey] as string[] | undefined) ?? [])]
    : [
        ...((input.image_urls as string[] | undefined) ?? []),
        ...((input.kling_elements as Array<{ element_input_urls: string[] }> | undefined)
          ?.map((el) => el.element_input_urls[0]) ?? []),
      ];

  // Google Veo models use a dedicated endpoint and a flattened body.
  const endpoint = apiInput.useGoogleVeo
    ? `${KIE_BASE}/api/v1/veo/generate`
    : `${KIE_BASE}/api/v1/jobs/createTask`;

  // Debug mode — log payload to server console and return without submitting
  if (debugOnly) {
    const debugPayload = apiInput.useGoogleVeo ? { model: effectiveApiId, ...input } : { model: effectiveApiId, input };
    console.log(`[DEBUG] generate-video payload → ${endpoint}`, JSON.stringify(debugPayload, null, 2));
    return NextResponse.json({ debugPayload, debugEndpoint: endpoint });
  }

  await ensureJobsRecovered();

  return respond(await createOnce(clientRequestId, async () => {
    // kie.ai can't fetch our local reference media, so re-host any /generated or
    // data: URLs in the payload first.
    try {
      await rewriteLocalMediaForKie(input, apiKey);
    } catch (e) {
      return errorOutcome(
        `Couldn't upload your reference media to kie.ai (${(e as Error).message}). Try again.`,
        "upstream",
        502,
      );
    }

    // The app polls kie.ai (lib/kieJobPoller), so no callback URL.
    const kieBody = apiInput.useGoogleVeo
      ? { model: effectiveApiId, ...input }
      : { model: effectiveApiId, input };

    console.log(`[generate-video] sending to ${endpoint}:`, JSON.stringify(kieBody));
    let taskId: string;
    try {
      taskId = await createKieTask(endpoint, apiKey, kieBody);
    } catch (e) {
      if (e instanceof KieCreateError) {
        console.error("[generate-video] kie.ai refused the task:", e.code, e.message);
        return errorOutcome(e.message, e.code, e.httpStatus);
      }
      throw e;
    }

    const provider = apiInput.useGoogleVeo ? "kie-veo" : "kie";
    guestDb.insertGeneration({
      task_id: taskId, user_id: userId, generation_type: "video",
      status: "pending", provider, client_request_id: clientRequestId,
      model: videoModel, prompt, aspect_ratio: effectiveAspectRatio,
      duration: clampedDuration, kling_mode: mode,
      sound: cfg.sound ? Boolean(sound) : false,
      reference_image_urls: referenceUrls,
    });
    pollKieJob(taskId, apiKey, "video", provider);

    return { status: 200, body: { taskId, ...(warnings.length > 0 ? { warnings } : {}) } };
  }));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[generate-video] couldn't start generation:", msg, e instanceof Error ? e.cause ?? "" : "");
    return respond(errorOutcome(`Couldn't start the generation: ${msg}`, "upstream", 500));
  }
}
