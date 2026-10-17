"use client";

import { useEffect, useRef, useState } from "react";
import { IMAGE_MODELS, VIDEO_MODELS, type ImageModel, type VideoHandle, type VideoModel } from "@/lib/modelConfig";
import { getModelProvider, type ProviderId } from "@/lib/providers";
import { useWorkflowStore } from "@/lib/store";
import { getToken } from "@/lib/galleryUtils";
import { requestNotificationPermission } from "@/lib/browserNotify";
import { HANDOFF_EVENT, loadDraft, saveDraft, takeHandoff, type ComposerDraft } from "./composerDraft";
import { enqueueGenerations, randomUUID, usePendingGenerations } from "./generationStore";
import { removeTagAndRenumber, reorderTags, resolveGalleryMentions, unresolvePrompt } from "./mentions";
import type { GenerateEndpoint, KlingElement, PendingGen, RefImage, ReusePromptFn, Tab, TaggedImage } from "./types";

/**
 * All state behind the composer: prompt, model settings and attached references,
 * persisted per tab and folder (see composerDraft.ts), plus the actions that
 * upload references and turn the composer into queued generations.
 */

export type VidTarget = "startFrame" | "endFrame" | "resource" | "videoRef" | "referenceVideo" | "audioRef";
export type ListTarget = "refImage" | "resource" | "referenceVideo" | "audioRef";
export type PickerTarget = "refImage" | Exclude<VidTarget, "audioRef">;
export type MentionableAsset = RefImage & { kind: "image" | "video" | "audio"; label: string; role: string };
export type PromptTextMode = "text" | "json" | "yaml";
export type AnyModel = ImageModel | VideoModel;

/** Seedance-style models take either frames or references, never both. */
const FRAMES_XOR_REFS_MODELS: readonly string[] = ["seedance-2", "seedance-2-fast", "minimax-h3"];
const VEO_MODELS: readonly string[] = ["veo3", "veo3_fast", "veo3_lite"];
const MAX_IMAGE_COUNT = 4;

const HANDLE_LABELS: Record<string, string> = {
  resource: "a reference image",
  startFrame: "a start frame",
  endFrame: "an end frame",
  videoRef: "a reference video",
  referenceVideo: "a reference video",
  audioRef: "reference audio",
  prompt: "a prompt",
};

const urlToRef = (url: string): RefImage => ({ id: url, objectUrl: url, cdnUrl: url, uploading: false, error: false });
const isReady = (r: RefImage | null | undefined): r is RefImage => !!r && !!r.cdnUrl && !r.uploading && !r.error;

type MediaKind = "image" | "video" | "audio";
const mediaKindOf = (f: File): MediaKind | null =>
  f.type.startsWith("image/") ? "image" : f.type.startsWith("video/") ? "video" : f.type.startsWith("audio/") ? "audio" : null;
const VID_TARGET_KIND: Record<VidTarget, MediaKind> = {
  startFrame: "image", endFrame: "image", resource: "image", videoRef: "video", referenceVideo: "video", audioRef: "audio",
};

/** The video reference slots the composer offers, given what's already attached (some models make slots exclusive). */
export function visibleVidHandles(
  handles: readonly VideoHandle[],
  s: { modelId: string; isVeo: boolean; veoMode: "frames" | "references"; hasStartFrame: boolean; hasResources: boolean; hasFrame: boolean; hasRef: boolean },
): VidTarget[] {
  const xor = FRAMES_XOR_REFS_MODELS.includes(s.modelId);
  return handles.filter((h): h is VidTarget => {
    if (h === "prompt") return false;
    if (s.isVeo) {
      if (s.veoMode === "references" && (h === "startFrame" || h === "endFrame")) return false;
      if (s.veoMode === "frames" && h === "resource") return false;
      if (h === "videoRef" || h === "referenceVideo" || h === "audioRef") return false;
    }
    if (s.modelId === "happyhorse" && h === "startFrame" && s.hasResources) return false;
    if (s.modelId === "happyhorse" && h === "resource" && s.hasStartFrame) return false;
    if (xor && s.hasFrame && (h === "resource" || h === "referenceVideo" || h === "audioRef")) return false;
    if (xor && s.hasRef && (h === "startFrame" || h === "endFrame")) return false;
    return true;
  });
}

function readAzureConfig(modelId: string): { provider: string; base: string; deployment: string } {
  try {
    return {
      provider: JSON.parse(localStorage.getItem("aiui-model-providers") ?? "{}")[modelId] ?? "kie",
      base: localStorage.getItem("aiui-azure-base-url") ?? "",
      deployment: JSON.parse(localStorage.getItem("aiui-azure-endpoints") ?? "{}")[modelId] ?? "",
    };
  } catch {
    return { provider: "kie", base: "", deployment: "" };
  }
}

/** Azure is usable for a model only when selected and fully configured (base URL + deployment). */
function azureActive(model: AnyModel, requires: "quality" | "resolution"): boolean {
  if (typeof window === "undefined" || !("supportsQuality" in model)) return false;
  const opts = requires === "quality" ? model.azureQualityOptions : model.azureResolutionOptions;
  if (!opts?.length) return false;
  const { provider, base, deployment } = readAzureConfig(model.id);
  return provider === "azure" && !!base && !!deployment;
}

const defaultRatioOf = (m: AnyModel) => ("defaultRatio" in m ? m.defaultRatio : null) ?? m.ratios[0] ?? "1:1";
const modelsFor = (tab: Tab): AnyModel[] => (tab === "videos" ? VIDEO_MODELS : IMAGE_MODELS);

/** A draft normalised against the current model list (unknown models and ratios fall back to defaults). */
function resolveDraft(tab: Tab, d: Partial<ComposerDraft> | null) {
  const models = modelsFor(tab);
  const model = (d?.modelId ? models.find(m => m.id === d.modelId) : undefined) ?? models[0];
  const custom = d?.aspectRatio === "custom"
    && Number.isFinite(d.azureCustomWidth) && Number.isFinite(d.azureCustomHeight)
    && azureActive(model, "resolution");
  const prompt = d?.prompt ?? "";
  const refImageUrls = d?.refImageUrls ?? [];
  return {
    prompt,
    modelId: model.id,
    aspectRatio: custom ? "custom" : d?.aspectRatio && model.ratios.includes(d.aspectRatio) ? d.aspectRatio : defaultRatioOf(model),
    azureCustomWidth: d?.azureCustomWidth,
    azureCustomHeight: d?.azureCustomHeight,
    quality: d?.quality ?? "2k",
    count: Math.min(MAX_IMAGE_COUNT, Math.max(1, d?.count ?? 1)),
    duration: d?.duration ?? ("defaultDuration" in model ? model.defaultDuration : 5),
    mode: d?.mode ?? ("defaultMode" in model ? model.defaultMode ?? "" : ""),
    resolution: "defaultResolution" in model ? model.defaultResolution ?? "" : "",
    sound: d?.sound ?? false,
    azureResolution: d?.azureResolution ?? "1k",
    promptTextMode: d?.promptTextMode ?? "text",
    multiPromptMode: d?.multiPromptMode ?? false,
    refImages: refImageUrls.map(urlToRef),
    // Older drafts only stored URLs; rebuild the tags that the prompt still mentions.
    taggedImages: d?.taggedImages?.length
      ? d.taggedImages
      : refImageUrls.flatMap((url, i) => (prompt.includes(`@image${i + 1}`) ? [{ label: `image${i + 1}`, refId: url, url }] : [])),
    vidStartFrame: d?.vidStartFrameUrl ? urlToRef(d.vidStartFrameUrl) : null,
    vidEndFrame: d?.vidEndFrameUrl ? urlToRef(d.vidEndFrameUrl) : null,
    vidResources: (d?.vidResourceUrls ?? []).map(urlToRef),
    vidVideoRef: d?.vidVideoRefUrl ? urlToRef(d.vidVideoRefUrl) : null,
    vidRefVideos: (d?.vidRefVideoUrls ?? []).map(urlToRef),
    vidRefAudios: (d?.vidRefAudioUrls ?? []).map(urlToRef),
    vidElements: d?.vidElements ?? [],
  };
}

async function uploadAsset(file: File): Promise<string> {
  const token = await getToken();
  const res = await fetch("/api/upload-asset", {
    method: "POST",
    headers: { "Content-Type": file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: file,
  });
  const data: { cdnUrl?: string; error?: string } = await res.json().catch(() => ({}));
  if (!res.ok || !data.cdnUrl) throw new Error(data.error ?? "Upload failed");
  return data.cdnUrl;
}

export function useComposer({ tab, folderId }: { tab: Tab; folderId: string | null }) {
  const addToast = useWorkflowStore(s => s.addToast);
  const debugMode = useWorkflowStore(s => s.debugMode);
  const kieKeySet = useWorkflowStore(s => s.kieKeySet);

  const isVideo = tab === "videos";
  const models = modelsFor(tab);
  const scope = `${tab}|${folderId ?? ""}`;
  const [initial] = useState(() => resolveDraft(tab, loadDraft(tab, folderId)));

  const [loadedScope, setLoadedScope] = useState(scope);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [modelId, setModelId] = useState(initial.modelId);
  const [aspectRatio, setAspectRatio] = useState(initial.aspectRatio);
  const [azureCustomWidth, setAzureCustomWidth] = useState(initial.azureCustomWidth);
  const [azureCustomHeight, setAzureCustomHeight] = useState(initial.azureCustomHeight);
  const [quality, setQuality] = useState(initial.quality);
  const [count, setCount] = useState(initial.count);
  const [duration, setDuration] = useState(initial.duration);
  const [mode, setMode] = useState(initial.mode);
  const [resolution, setResolution] = useState(initial.resolution);
  const [sound, setSound] = useState(initial.sound);
  const [azureResolution, setAzureResolution] = useState(initial.azureResolution);
  const [seed, setSeed] = useState(0);
  const [veoMode, setVeoMode] = useState<"frames" | "references">("frames");
  const [promptTextMode, setPromptTextMode] = useState<PromptTextMode>(initial.promptTextMode);
  const [multiPromptMode, setMultiPromptMode] = useState(initial.multiPromptMode);
  const [refImages, setRefImages] = useState<RefImage[]>(initial.refImages);
  // Tags the user set explicitly; the effective list is derived below from the prompt.
  const [explicitTags, setTaggedImages] = useState<TaggedImage[]>(initial.taggedImages);
  const [vidStartFrame, setVidStartFrame] = useState<RefImage | null>(initial.vidStartFrame);
  const [vidEndFrame, setVidEndFrame] = useState<RefImage | null>(initial.vidEndFrame);
  const [vidResources, setVidResources] = useState<RefImage[]>(initial.vidResources);
  const [vidVideoRef, setVidVideoRef] = useState<RefImage | null>(initial.vidVideoRef);
  const [vidRefVideos, setVidRefVideos] = useState<RefImage[]>(initial.vidRefVideos);
  const [vidRefAudios, setVidRefAudios] = useState<RefImage[]>(initial.vidRefAudios);
  const [vidElements, setVidElements] = useState<KlingElement[]>(initial.vidElements);
  const [providerId, setProviderId] = useState<ProviderId>("kie");
  const [isAzureProvider, setIsAzureProvider] = useState(false);

  const promptRef = useRef(prompt);
  useEffect(() => { promptRef.current = prompt; }, [prompt]);

  // Switching tab or folder swaps in that scope's draft, during render, so no
  // commit (and no save) ever pairs one scope's key with another scope's state.
  if (loadedScope !== scope) {
    const d = resolveDraft(tab, loadDraft(tab, folderId));
    setLoadedScope(scope);
    setPrompt(d.prompt);
    setModelId(d.modelId);
    setAspectRatio(d.aspectRatio);
    setAzureCustomWidth(d.azureCustomWidth);
    setAzureCustomHeight(d.azureCustomHeight);
    setQuality(d.quality);
    setCount(d.count);
    setDuration(d.duration);
    setMode(d.mode);
    setResolution(d.resolution);
    setSound(d.sound);
    setAzureResolution(d.azureResolution);
    setPromptTextMode(d.promptTextMode);
    setMultiPromptMode(d.multiPromptMode);
    setRefImages(d.refImages);
    setTaggedImages(d.taggedImages);
    setVidStartFrame(d.vidStartFrame);
    setVidEndFrame(d.vidEndFrame);
    setVidResources(d.vidResources);
    setVidVideoRef(d.vidVideoRef);
    setVidRefVideos(d.vidRefVideos);
    setVidRefAudios(d.vidRefAudios);
    setVidElements(d.vidElements);
  }

  // Prompts handed over from other surfaces (chat "Use as prompt"). One that carries its generation's
  // setup loads like "Reuse"; a bare prompt replaces only the text and keeps the references.
  const reuseRef = useRef<ReusePromptFn | null>(null);
  useEffect(() => {
    const consume = () => {
      const h = takeHandoff(tab);
      if (!h) return;
      setPromptTextMode("text");
      setMultiPromptMode(false);
      if (h.setup && reuseRef.current) {
        reuseRef.current(h.prompt, h.setup.refUrls, h.setup.meta);
        return;
      }
      setTaggedImages([]);
      setPrompt(h.prompt);
    };
    window.addEventListener(HANDOFF_EVENT, consume);
    // A hand-off queued before this page mounted is picked up on the next tick.
    const t = setTimeout(consume, 0);
    return () => { clearTimeout(t); window.removeEventListener(HANDOFF_EVENT, consume); };
  }, [tab]);

  // Revoke local previews on unmount.
  const refImagesRef = useRef(refImages);
  useEffect(() => { refImagesRef.current = refImages; }, [refImages]);
  useEffect(() => () => refImagesRef.current.forEach(r => r.objectUrl.startsWith("blob:") && URL.revokeObjectURL(r.objectUrl)), []);

  // ── Derived ────────────────────────────────────────────────────────────────

  const activeModel = models.find(m => m.id === modelId) ?? models[0];
  const imgModel = isVideo ? undefined : IMAGE_MODELS.find(m => m.id === modelId);
  const vidModel = isVideo ? VIDEO_MODELS.find(m => m.id === modelId) : undefined;
  const maxImgs = imgModel?.maxImages ?? 0;
  const canAddImgs = !isVideo && !!imgModel?.supportsImages && refImages.length < maxImgs;
  const promptMaxLength = isVideo
    ? vidModel?.apiInput.promptMaxLength ?? null
    : imgModel
      ? (refImages.length === 0 && imgModel.textOnlyPromptMaxLength) || imgModel.apiInput.promptMaxLength
      : null;
  const promptOverLimit = promptMaxLength !== null && prompt.length > promptMaxLength;
  const ratios = activeModel.ratios;
  const supportsQuality = !isVideo && !!imgModel?.supportsQuality;
  const qualityOpts = isAzureProvider ? imgModel?.azureQualityOptions ?? [] : imgModel?.apiInput.qualityOptions ?? ["2k", "4k"];
  const azureResolutionOpts = isAzureProvider ? imgModel?.azureResolutionOptions ?? [] : [];
  const isVeo = VEO_MODELS.includes(modelId);
  /** Slots the reference strip offers right now. */
  const visibleVidTargets = visibleVidHandles(vidModel?.handles ?? [], {
    modelId,
    isVeo,
    veoMode,
    hasStartFrame: !!vidStartFrame,
    hasResources: vidResources.length > 0,
    hasFrame: !!(vidStartFrame || vidEndFrame),
    hasRef: vidResources.length > 0 || vidRefVideos.length > 0 || vidRefAudios.length > 0,
  });
  const vidRequiresPrompt = isVideo && !!vidModel?.apiInput.promptMaxLength;
  const needsPrompt = vidRequiresPrompt || !isVideo;
  const canGenerate = kieKeySet !== false && !promptOverLimit && (needsPrompt ? prompt.trim().length > 0 : true);
  /** Why Generate can't run yet, in the user's terms; null when it can. */
  const blockedReason = kieKeySet === false
    ? "Add your kie.ai key in Settings to generate"
    : promptOverLimit
      ? "The prompt is longer than this model allows"
      : needsPrompt && !prompt.trim()
        ? "Describe what to make first"
        : null;
  /** How many generations one click sends (mirrors `generate`). */
  const generationCount = multiPromptMode
    ? prompt.split(/\n\n+/).filter(p => p.trim()).length
    : isVideo ? 1 : count;
  const hasContent = !!prompt || refImages.length > 0 || explicitTags.length > 0 || vidElements.length > 0
    || !!vidStartFrame || !!vidEndFrame || !!vidVideoRef || vidResources.length > 0 || vidRefVideos.length > 0 || vidRefAudios.length > 0;

  // Keep provider-dependent options in sync with Settings (other tabs / the settings modal).
  useEffect(() => {
    const read = () => {
      setProviderId(getModelProvider(modelId));
      const azure = azureActive(activeModel, "quality");
      setIsAzureProvider(azure);
      if (imgModel) {
        const valid = azure ? imgModel.azureQualityOptions ?? [] : imgModel.apiInput.qualityOptions ?? [];
        if (valid.length) setQuality(q => (valid.includes(q) ? q : valid[0]));
      }
    };
    read();
    window.addEventListener("storage", read);
    window.addEventListener("aiui-providers-changed", read);
    return () => {
      window.removeEventListener("storage", read);
      window.removeEventListener("aiui-providers-changed", read);
    };
  }, [modelId, isVideo]); // eslint-disable-line react-hooks/exhaustive-deps

  /** User picked a model: apply that model's defaults. */
  const selectModel = (id: string) => {
    const m = modelsFor(tab).find(x => x.id === id);
    if (!m) return;
    setModelId(id);
    setAspectRatio(defaultRatioOf(m));
    if ("defaultDuration" in m) setDuration(m.defaultDuration ?? 5);
    if ("defaultMode" in m) setMode(m.defaultMode ?? "");
    if ("defaultResolution" in m) setResolution(m.defaultResolution ?? "");
  };

  const mentionableAssets: MentionableAsset[] = (() => {
    if (!isVideo) {
      return refImages.filter(isReady).map((r, i) => ({ ...r, kind: "image" as const, label: `image${i + 1}`, role: `Reference ${i + 1}` }));
    }
    const imgs: { ref: RefImage; role: string }[] = [];
    const resOk = vidResources.filter(isReady);
    const frames = () => {
      if (isReady(vidStartFrame)) imgs.push({ ref: vidStartFrame, role: "Start frame" });
      if (isReady(vidEndFrame)) imgs.push({ ref: vidEndFrame, role: "End frame" });
    };
    const refs = () => resOk.forEach((r, i) => imgs.push({ ref: r, role: `Reference ${i + 1}` }));
    if (isVeo) { if (veoMode === "frames") frames(); else refs(); } else { frames(); refs(); }
    const assets: MentionableAsset[] = imgs.map((it, i) => ({ ...it.ref, kind: "image", label: `image${i + 1}`, role: it.role }));
    if (!isVeo) {
      const vids: { ref: RefImage; role: string }[] = [];
      if (isReady(vidVideoRef)) vids.push({ ref: vidVideoRef, role: "Reference video" });
      vidRefVideos.filter(isReady).forEach((r, i) => vids.push({ ref: r, role: `Video ${i + 1}` }));
      assets.push(...vids.map((it, i) => ({ ...it.ref, kind: "video" as const, label: `vid${i + 1}`, role: it.role })));
      assets.push(...vidRefAudios.filter(isReady).map((r, i) => ({ ...r, kind: "audio" as const, label: `aud${i + 1}`, role: `Audio ${i + 1}` })));
    }
    return assets;
  })();

  // Effective tags follow the text: explicit tags still mentioned, plus pasted
  // `@imageN` mentions that match an attached asset.
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentioned = (label: string) => new RegExp(`@${esc(label)}(?!\\w)`).test(prompt);
  const keptTags = explicitTags.filter(t => mentioned(t.label));
  const taggedImages: TaggedImage[] = [
    ...keptTags,
    ...mentionableAssets
      .filter(a => a.cdnUrl && !keptTags.some(t => t.label === a.label) && mentioned(a.label))
      .map(a => ({ label: a.label, refId: a.id, url: a.cdnUrl!, kind: a.kind })),
  ];

  // Persist on every change.
  const ready = (rs: RefImage[]) => rs.filter(isReady).map(r => r.cdnUrl!);
  const draft: ComposerDraft = {
    prompt, modelId, aspectRatio, quality, count, duration, mode, sound, azureResolution,
    azureCustomWidth, azureCustomHeight, promptTextMode, multiPromptMode,
    refImageUrls: [...new Set(ready(refImages))],
    vidStartFrameUrl: isReady(vidStartFrame) ? vidStartFrame.cdnUrl : null,
    vidEndFrameUrl: isReady(vidEndFrame) ? vidEndFrame.cdnUrl : null,
    vidResourceUrls: ready(vidResources),
    vidVideoRefUrl: isReady(vidVideoRef) ? vidVideoRef.cdnUrl : null,
    vidRefVideoUrls: ready(vidRefVideos),
    vidRefAudioUrls: ready(vidRefAudios),
    vidElements,
    taggedImages,
  };
  const draftJson = JSON.stringify(draft);
  useEffect(() => {
    saveDraft(tab, folderId, JSON.parse(draftJson));
  }, [tab, folderId, draftJson]);

  // ── References ─────────────────────────────────────────────────────────────

  const addReference = (url: string) => {
    if (refImages.some(r => r.cdnUrl === url || r.objectUrl === url)) {
      addToast("That image is already a reference.", "info");
      return;
    }
    if (refImages.length >= maxImgs) return;
    setRefImages(prev => [...prev, { id: randomUUID(), objectUrl: url, cdnUrl: url, uploading: false, error: false }]);
  };

  const handleFilePick = async (files: FileList | File[]) => {
    if (!imgModel?.supportsImages) return;
    const toAdd = Array.from(files).slice(0, maxImgs - refImages.length).filter(f => f.type.startsWith("image/"));
    if (toAdd.length === 0) return;
    const entries: RefImage[] = toAdd.map(f => ({ id: randomUUID(), objectUrl: URL.createObjectURL(f), cdnUrl: null, uploading: true, error: false }));
    setRefImages(prev => [...prev, ...entries]);
    await Promise.all(toAdd.map(async (file, i) => {
      const id = entries[i].id;
      try {
        const cdnUrl = await uploadAsset(file);
        setRefImages(prev => prev.map(r => (r.id === id ? { ...r, cdnUrl, uploading: false } : r)));
      } catch (e) {
        setRefImages(prev => prev.map(r => (r.id === id ? { ...r, uploading: false, error: true } : r)));
        addToast(`${file.name} couldn't be uploaded. ${e instanceof Error ? e.message : ""}`.trim(), "error");
      }
    }));
  };

  const removeRefImage = (id: string) => {
    const removed = refImages.find(r => r.id === id);
    const { newTaggedImages, newPrompt } = removeTagAndRenumber(id, removed?.cdnUrl ?? null, taggedImages, prompt);
    if (removed?.objectUrl.startsWith("blob:")) URL.revokeObjectURL(removed.objectUrl);
    setRefImages(prev => prev.filter(r => r.id !== id));
    setTaggedImages(newTaggedImages);
    setPrompt(newPrompt);
  };

  /** Frames and references are mutually exclusive on some models; adding one clears the other. */
  const clearConflicts = (target: VidTarget) => {
    const xor = FRAMES_XOR_REFS_MODELS.includes(modelId);
    if (target === "startFrame" || target === "endFrame") {
      if (modelId === "happyhorse" && target === "startFrame") setVidResources([]);
      if (xor) { setVidResources([]); setVidRefVideos([]); setVidRefAudios([]); }
    } else if (target === "resource" || target === "referenceVideo" || target === "audioRef") {
      if (modelId === "happyhorse" && target === "resource") setVidStartFrame(null);
      if (xor) { setVidStartFrame(null); setVidEndFrame(null); }
    }
  };

  const setVidSlot = (target: VidTarget, update: (prev: RefImage[]) => RefImage[]) => {
    const single = (setter: React.Dispatch<React.SetStateAction<RefImage | null>>) =>
      setter(prev => update(prev ? [prev] : [])[0] ?? null);
    if (target === "startFrame") single(setVidStartFrame);
    else if (target === "endFrame") single(setVidEndFrame);
    else if (target === "videoRef") single(setVidVideoRef);
    else if (target === "resource") setVidResources(update);
    else if (target === "referenceVideo") setVidRefVideos(update);
    else setVidRefAudios(update);
  };

  const vidSlotLimit = (target: VidTarget) => {
    if (target === "startFrame" || target === "endFrame" || target === "videoRef") return 1;
    if (target === "resource") return vidModel?.maxResources ?? 3;
    if (target === "referenceVideo") return vidModel?.maxReferenceVideos ?? 3;
    return vidModel?.maxReferenceAudios ?? 3;
  };

  const vidSlotItems = (target: VidTarget): RefImage[] =>
    target === "startFrame" ? (vidStartFrame ? [vidStartFrame] : [])
    : target === "endFrame" ? (vidEndFrame ? [vidEndFrame] : [])
    : target === "videoRef" ? (vidVideoRef ? [vidVideoRef] : [])
    : target === "resource" ? vidResources
    : target === "referenceVideo" ? vidRefVideos
    : vidRefAudios;

  const handleVidFilePick = async (files: FileList | File[] | null, target: VidTarget) => {
    if (!files?.length) return;
    const single = vidSlotLimit(target) === 1;
    const current = single ? 0 : vidSlotItems(target).length;
    const toAdd = Array.from(files).slice(0, vidSlotLimit(target) - current);
    if (toAdd.length === 0) return;
    const entries: RefImage[] = toAdd.map(f => ({ id: randomUUID(), objectUrl: URL.createObjectURL(f), cdnUrl: null, uploading: true, error: false }));
    clearConflicts(target);
    setVidSlot(target, prev => (single ? entries.slice(0, 1) : [...prev, ...entries]));
    await Promise.all(toAdd.map(async (file, i) => {
      const id = entries[i].id;
      try {
        const cdnUrl = await uploadAsset(file);
        setVidSlot(target, prev => prev.map(r => (r.id === id ? { ...r, cdnUrl, uploading: false } : r)));
      } catch (e) {
        setVidSlot(target, prev => prev.map(r => (r.id === id ? { ...r, uploading: false, error: true } : r)));
        addToast(`${file.name} couldn't be uploaded. ${e instanceof Error ? e.message : ""}`.trim(), "error");
      }
    }));
  };

  /**
   * Pasted or dropped files. Each goes to the first free slot the current model
   * accepts for its kind (frames before references on video); anything that
   * doesn't fit is reported rather than dropped silently.
   */
  const addFiles = (files: FileList | File[]) => {
    const all = Array.from(files);
    const name = activeModel.name;
    const usable = all.filter(f => (isVideo ? mediaKindOf(f) !== null : mediaKindOf(f) === "image"));
    if (usable.length === 0) {
      if (all.length) addToast(isVideo ? "Only images, video and audio can be references." : "Only images can be references.", "info");
      return;
    }

    if (!isVideo) {
      if (!imgModel?.supportsImages) { addToast(`${name} doesn't take reference images.`, "info"); return; }
      const room = maxImgs - refImages.length;
      if (usable.length > room) {
        addToast(room > 0
          ? `${name} takes up to ${maxImgs} reference images. Added ${room} of ${usable.length}.`
          : `${name} takes up to ${maxImgs} reference images. Remove one to add another.`, "info");
      }
      void handleFilePick(usable);
      return;
    }

    const handles = vidModel?.handles ?? [];
    const useElements = !!vidModel?.apiInput.useKlingElements;
    // Kling elements are built in their own picker, so files never land there.
    const accepts = (t: VidTarget, kind: MediaKind) => VID_TARGET_KIND[t] === kind && !(t === "resource" && useElements);
    const counts = new Map((Object.keys(VID_TARGET_KIND) as VidTarget[]).map(t => [t, vidSlotItems(t).length]));
    const n = (t: VidTarget) => counts.get(t) ?? 0;
    const plan = new Map<VidTarget, File[]>();
    const skipped: File[] = [];
    for (const file of usable) {
      const kind = mediaKindOf(file)!;
      // Re-evaluate per file: filling a frame can hide reference slots and vice versa.
      const open = visibleVidHandles(handles, {
        modelId, isVeo, veoMode,
        hasStartFrame: n("startFrame") > 0,
        hasResources: n("resource") > 0,
        hasFrame: n("startFrame") + n("endFrame") > 0,
        hasRef: n("resource") + n("referenceVideo") + n("audioRef") > 0,
      });
      const target = open.find(t => accepts(t, kind) && n(t) < vidSlotLimit(t));
      if (!target) { skipped.push(file); continue; }
      counts.set(target, n(target) + 1);
      plan.set(target, [...(plan.get(target) ?? []), file]);
    }

    if (skipped.length) {
      const unsupported = skipped.filter(f => !handles.some(h => h !== "prompt" && accepts(h, mediaKindOf(f)!)));
      const kinds = [...new Set(skipped.map(mediaKindOf))];
      const noun = kinds.length === 1 ? `reference ${kinds[0] === "audio" ? "audio" : `${kinds[0]}s`}` : "these references";
      addToast(unsupported.length === skipped.length
        ? `${name} doesn't take ${noun}.`
        : plan.size
          ? `Added ${usable.length - skipped.length} of ${usable.length}. ${name}'s reference slots are full.`
          : `${name}'s reference slots are full. Remove one to add another.`, "info");
    }
    for (const [target, group] of plan) void handleVidFilePick(group, target);
  };

  /** Attaches an existing URL (media picker, gallery drag) to a video slot. */
  const addVidRefUrl = (target: VidTarget, url: string) => {
    const single = vidSlotLimit(target) === 1;
    if (!single && vidSlotItems(target).some(r => r.cdnUrl === url || r.objectUrl === url)) return;
    clearConflicts(target);
    const entry: RefImage = { id: randomUUID(), objectUrl: url, cdnUrl: url, uploading: false, error: false };
    setVidSlot(target, prev => (single ? [entry] : [...prev, entry]));
  };

  const removeVidRef = (id: string, target: VidTarget) => {
    const removed = vidSlotItems(target).find(r => r.id === id);
    setVidSlot(target, prev => prev.filter(r => r.id !== id));
    const { newTaggedImages, newPrompt } = removeTagAndRenumber(id, removed?.cdnUrl ?? null, taggedImages, prompt);
    setTaggedImages(newTaggedImages);
    setPrompt(newPrompt);
  };

  /** Media picker toggled an item off. */
  const removeByUrl = (target: PickerTarget, url: string) => {
    const list = target === "refImage" ? refImages : vidSlotItems(target);
    const match = list.find(r => r.cdnUrl === url || r.objectUrl === url);
    if (!match) return;
    if (target === "refImage") removeRefImage(match.id);
    else removeVidRef(match.id, target);
  };

  const reorder = (list: ListTarget, dragId: string, targetId: string) => {
    if (dragId === targetId) return;
    const arr = list === "refImage" ? refImages : vidSlotItems(list);
    const from = arr.findIndex(r => r.id === dragId);
    const to = arr.findIndex(r => r.id === targetId);
    if (from === -1 || to === -1) return;
    const next = [...arr];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    if (list === "refImage") setRefImages(next);
    else setVidSlot(list, () => next);
    setTaggedImages(tags => reorderTags(next, "image", tags));
  };

  const clearAll = () => {
    refImages.forEach(r => r.objectUrl.startsWith("blob:") && URL.revokeObjectURL(r.objectUrl));
    setPrompt("");
    setRefImages([]);
    setTaggedImages([]);
    setVidElements([]);
    setVidStartFrame(null);
    setVidEndFrame(null);
    setVidVideoRef(null);
    setVidResources([]);
    setVidRefVideos([]);
    setVidRefAudios([]);
  };

  /** Loads a stored generation's prompt, references and settings back into the composer. */
  const reuse: ReusePromptFn = (text, refUrls, meta) => {
    const { text: restored, tagged } = unresolvePrompt(text, refUrls);
    const refs = (refUrls ?? []).map(url => ({ id: randomUUID(), objectUrl: url, cdnUrl: url, uploading: false, error: false }));
    if (isVideo) {
      // Slot by the source model's handles, not the currently selected model.
      const vm = VIDEO_MODELS.find(m => m.id === meta?.model) ?? VIDEO_MODELS.find(m => m.id === modelId);
      const handles = vm?.handles ?? [];
      const remaining = [...refs];
      setVidStartFrame(handles.includes("startFrame") ? remaining.shift() ?? null : null);
      setVidEndFrame(handles.includes("endFrame") ? remaining.shift() ?? null : null);
      setVidVideoRef(handles.includes("videoRef") ? remaining.shift() ?? null : null);
      setVidRefVideos([]);
      setVidRefAudios([]);
      const useElements = !!vm?.apiInput.useKlingElements;
      setVidResources(handles.includes("resource") && !useElements ? remaining : []);
      setVidElements(handles.includes("resource") && useElements
        ? remaining.map(r => ({ id: r.id, name: "image", description: "", imageUrls: [r.cdnUrl!, r.cdnUrl!] }))
        : []);
    } else {
      setRefImages(prev => { prev.forEach(r => r.objectUrl.startsWith("blob:") && URL.revokeObjectURL(r.objectUrl)); return refs; });
    }
    setTaggedImages(tagged);
    setPrompt(restored);
    const target = meta?.model ? modelsFor(tab).find(m => m.id === meta.model) : undefined;
    if (target) setModelId(target.id);
    if (meta?.aspectRatio && (target ?? activeModel).ratios.includes(meta.aspectRatio)) setAspectRatio(meta.aspectRatio);
    if (meta?.quality) setQuality(meta.quality);
    if (meta?.azureResolution) setAzureResolution(meta.azureResolution);
  };
  useEffect(() => { reuseRef.current = reuse; });

  // ── Generate ───────────────────────────────────────────────────────────────

  const buildRequest = (text: string): { endpoint: GenerateEndpoint; request: Record<string, unknown> } => {
    if (!isVideo) {
      const { resolvedPrompt, extraUrls } = resolveGalleryMentions(text, taggedImages);
      const tagged = new Set(extraUrls);
      const refUrls = imgModel?.supportsImages ? refImages.filter(r => r.cdnUrl && !r.error && !tagged.has(r.cdnUrl)).map(r => r.cdnUrl!) : [];
      const imageUrls = imgModel?.supportsImages ? [...new Set([...extraUrls, ...refUrls])] : [];
      const { provider, base, deployment } = readAzureConfig(modelId);
      const isAzure = !!(base && deployment && provider === "azure");
      return {
        endpoint: "/api/generate",
        request: {
          prompt: resolvedPrompt, model: modelId, aspectRatio, quality, imageUrls,
          ...(isAzure ? {
            azureBaseUrl: base, azureDeployment: deployment, azureQuality: quality, azureResolution,
            ...(aspectRatio === "custom" ? { azureCustomWidth, azureCustomHeight } : {}),
          } : {}),
          ...(provider === "codex" ? { codexProvider: true } : {}),
        },
      };
    }

    const vm = vidModel;
    const handles = vm?.handles ?? [];
    const { resolvedPrompt, extraAssets } = resolveGalleryMentions(text, taggedImages, vm?.resourceTagFormat ?? "default");
    const startFrameUrl = handles.includes("startFrame") && vidStartFrame?.cdnUrl ? vidStartFrame.cdnUrl : undefined;
    const endFrameUrl = handles.includes("endFrame") && vidEndFrame?.cdnUrl ? vidEndFrame.cdnUrl : undefined;
    const videoRefUrl = handles.includes("videoRef") && vidVideoRef?.cdnUrl ? vidVideoRef.cdnUrl : undefined;
    const useElements = !!vm?.apiInput.useKlingElements;
    const ofKind = (k: "image" | "video" | "audio") => extraAssets.filter(a => a.kind === k).map(a => a.url);
    const taggedImageUrls = ofKind("image");
    const taggedVideoUrls = ofKind("video");
    const taggedAudioUrls = ofKind("audio");
    const untagged = (rs: RefImage[], tagged: string[]) => rs.filter(r => r.cdnUrl && !r.error && !tagged.includes(r.cdnUrl)).map(r => r.cdnUrl!);

    const resourceUrls = handles.includes("resource") && !useElements ? untagged(vidResources, taggedImageUrls) : [];
    const referenceImageUrls = !useElements && (taggedImageUrls.length || resourceUrls.length) ? [...taggedImageUrls, ...resourceUrls] : undefined;
    const baseElements = useElements && handles.includes("resource")
      ? vidElements.map(el => ({ name: el.name, description: el.description, imageUrls: el.imageUrls }))
      : [];
    const mentionElements = useElements
      ? taggedImageUrls.map((url, i) => ({ name: `element_${i + 1}`, description: `Mentioned image ${i + 1}`, imageUrls: [url] }))
      : [];
    const klingElements = [...mentionElements, ...baseElements];
    const referenceVideoUrls = handles.includes("referenceVideo") ? [...taggedVideoUrls, ...untagged(vidRefVideos, taggedVideoUrls)] : [];
    const referenceAudioUrls = handles.includes("audioRef") ? [...taggedAudioUrls, ...untagged(vidRefAudios, taggedAudioUrls)] : [];

    if (vm?.apiInput.useGoogleVeo) {
      const veoImageUrls = veoMode === "frames"
        ? [startFrameUrl, endFrameUrl].filter((u): u is string => !!u)
        : (referenceImageUrls ?? []).slice(0, 3);
      return {
        endpoint: "/api/generate-video",
        request: {
          model: modelId, prompt: resolvedPrompt, aspect_ratio: aspectRatio,
          generationType: veoMode === "references" ? "REFERENCE_2_VIDEO" : veoImageUrls.length ? "FIRST_AND_LAST_FRAMES_2_VIDEO" : "TEXT_2_VIDEO",
          imageUrls: veoImageUrls, enableTranslation: true, enableFallback: false, watermark: "",
        },
      };
    }
    return {
      endpoint: "/api/generate-video",
      request: {
        videoModel: modelId,
        prompt: resolvedPrompt,
        aspectRatio,
        duration,
        ...(vm?.sound ? { sound } : {}),
        ...(vm?.modes?.length ? { mode: mode || vm.defaultMode || "pro" } : {}),
        ...(vm?.resolutions?.length ? { resolution: resolution || vm.defaultResolution } : {}),
        ...(startFrameUrl ? { startFrameUrl } : {}),
        ...(endFrameUrl ? { endFrameUrl } : {}),
        ...(videoRefUrl ? { videoRefUrl } : {}),
        ...(klingElements.length ? { klingElements } : {}),
        ...(referenceImageUrls?.length ? { referenceImageUrls } : {}),
        ...(referenceVideoUrls.length ? { referenceVideoUrls } : {}),
        ...(referenceAudioUrls.length ? { referenceAudioUrls } : {}),
        ...(vm?.supportsSeeds && seed ? { seed } : {}),
      },
    };
  };

  /** After a successful submit, clear the prompt — unless the user has already started a new one. */
  const lastSubmit = useRef<{ ids: string[]; prompt: string } | null>(null);
  useEffect(() => usePendingGenerations.subscribe(({ pending }) => {
    const sub = lastSubmit.current;
    if (!sub) return;
    const mine = pending.filter(p => sub.ids.includes(p.id));
    if (mine.some(p => p.taskId)) {
      lastSubmit.current = null;
      if (promptRef.current === sub.prompt) { setPrompt(""); setTaggedImages([]); }
    } else if (mine.length === 0 || mine.every(p => p.error)) {
      lastSubmit.current = null; // cancelled or failed: keep the prompt
    }
  }), []);

  const generate = () => {
    if (kieKeySet === false || !canGenerate) return;
    requestNotificationPermission();
    const uploading = isVideo
      ? [vidStartFrame, vidEndFrame, vidVideoRef, ...vidResources, ...vidRefVideos, ...vidRefAudios].some(r => r?.uploading)
      : refImages.some(r => r.uploading);
    if (uploading) { addToast("References are still uploading. Generate again in a moment.", "info"); return; }

    if (vidModel?.requiredHandles?.length) {
      const has = (h: string) =>
        h === "resource" ? vidResources.some(r => r.cdnUrl && !r.error)
        : h === "startFrame" ? isReady(vidStartFrame)
        : h === "endFrame" ? isReady(vidEndFrame)
        : h === "videoRef" ? isReady(vidVideoRef)
        : h === "referenceVideo" ? vidRefVideos.some(r => r.cdnUrl && !r.error)
        : h === "audioRef" ? vidRefAudios.some(r => r.cdnUrl && !r.error)
        : h === "prompt" ? !!prompt.trim()
        : true;
      const missing = vidModel.requiredHandles.filter(h => !has(h));
      if (missing.length) {
        addToast(`${vidModel.name} needs ${missing.map(h => HANDLE_LABELS[h] ?? h).join(", ")}. Add it, then generate.`, "error");
        return;
      }
    }

    const prompts = multiPromptMode
      ? prompt.split(/\n\n+/).map(p => p.trim()).filter(Boolean)
      : Array.from({ length: isVideo ? 1 : count }, () => prompt);
    if (prompts.length === 0) return;
    const referenceImageUrls = isVideo
      ? [vidStartFrame, vidEndFrame, ...vidResources].filter((r): r is RefImage => !!r?.cdnUrl && !r.error).map(r => r.cdnUrl!)
      : [...new Set(refImages.filter(r => r.cdnUrl && !r.error).map(r => r.cdnUrl!))];
    const createdAt = new Date().toISOString();
    const entries: PendingGen[] = prompts.map(text => ({
      id: randomUUID(),
      clientRequestId: randomUUID(),
      ...buildRequest(text),
      aspectRatio,
      prompt: text,
      modelName: activeModel.name,
      referenceImageUrls,
      createdAt,
      tab,
      prePending: true,
      folderId,
    }));

    if (debugMode) {
      console.log("[Gallery debug] generate requests:", entries.map(e => ({ endpoint: e.endpoint, request: e.request })));
      enqueueGenerations(entries, { simulate: true });
      return;
    }
    lastSubmit.current = { ids: entries.map(e => e.id), prompt };
    enqueueGenerations(entries);
  };

  return {
    tab, isVideo, models, activeModel, imgModel, vidModel, isVeo,
    prompt, setPrompt, modelId, selectModel, aspectRatio, setAspectRatio,
    azureCustomWidth, azureCustomHeight, setAzureCustom: (w: number, h: number) => { setAzureCustomWidth(w); setAzureCustomHeight(h); setAspectRatio("custom"); },
    quality, setQuality, count, setCount, duration, setDuration, mode, setMode, resolution, setResolution,
    sound, setSound, azureResolution, setAzureResolution, seed, setSeed, veoMode, setVeoMode,
    promptTextMode, setPromptTextMode, multiPromptMode, setMultiPromptMode,
    refImages, taggedImages, setTaggedImages,
    vidStartFrame, vidEndFrame, vidResources, vidVideoRef, vidRefVideos, vidRefAudios, vidElements, setVidElements,
    providerId, isAzureProvider,
    maxImgs, canAddImgs, promptMaxLength, promptOverLimit, ratios, supportsQuality, qualityOpts, azureResolutionOpts,
    canGenerate, blockedReason, generationCount, hasContent, mentionableAssets, maxImageCount: MAX_IMAGE_COUNT,
    addReference, handleFilePick, addFiles, removeRefImage, handleVidFilePick, addVidRefUrl, removeVidRef, removeByUrl,
    vidSlotLimit, visibleVidTargets, reorder, clearAll, reuse, generate,
  };
}

export type ComposerState = ReturnType<typeof useComposer>;
