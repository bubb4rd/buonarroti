"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronLeft, ChevronRight, Copy, Download, MessageCircleQuestion, RefreshCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { thumbSrc } from "@/lib/galleryUtils";
import { naturalRatioCache, parseRatio, persistNaturalRatios } from "./media";
import { renderStoredPrompt, syntaxHighlightJson, syntaxHighlightYaml } from "./mentions";
import type { GalleryItem, ReusePromptFn } from "./types";

export interface LightboxProps {
  item: GalleryItem;
  /** Already-loaded grid thumbnail, shown instantly while the full file loads. */
  thumbUrl?: string;
  onClose: () => void;
  /** Puts the prompt, references and settings back into the composer. */
  onReuse?: ReusePromptFn;
  /** Opens the assistant on this item (the lightbox closes so the assistant is visible). */
  onAskAssistant?: (item: GalleryItem, shownUrl: string) => void;
  /** Routed through the parent so its download toast tracks progress. */
  onDownload: (url: string, isVideo: boolean) => void;
  onPrev?: () => void;
  onNext?: () => void;
}

const CLOSE_MS = 180;

type PromptFormat = { kind: "plain" } | { kind: "json"; text: string } | { kind: "yaml" };

/** Structured prompts get monospace + syntax colour; everything else reads as prose. */
function detectPromptFormat(text: string): PromptFormat {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return { kind: "json", text: JSON.stringify(JSON.parse(t), null, 2) }; } catch {}
  }
  if (t.includes("\n")) {
    const keyLines = t.split("\n").filter(l => /^\s*(-\s+)?[\w\-./]+\s*:(\s|$)/.test(l)).length;
    if (/^---\s*$/m.test(t) || keyLines >= 2) return { kind: "yaml" };
  }
  return { kind: "plain" };
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

const ratioOf = (url: string, aspect?: string): number | null => {
  const cached = naturalRatioCache.get(url);
  return parseRatio(cached) ?? parseRatio(aspect);
};

const ON_MEDIA_ROUND =
  "on-media flex size-9 items-center justify-center rounded-full transition-[opacity,background-color] duration-150 ease-[var(--ease-out)] hover:bg-black/60 disabled:pointer-events-none disabled:opacity-30";

/** Icon-only panel action: the label and its shortcut live in the tooltip. */
function IconAction({ label, kbd, ...props }: { label: string; kbd: string } & React.ComponentProps<typeof Button>) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={label} {...props} />} />
      <TooltipContent side="bottom">
        {label} <Kbd>{kbd}</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

export function Lightbox({ item, thumbUrl, onClose, onReuse, onAskAssistant, onDownload, onPrev, onNext }: LightboxProps) {
  const [visible, setVisible] = useState(false);
  const [imgIdx, setImgIdx] = useState(0);
  const [thumbLoaded, setThumbLoaded] = useState(false);
  const [fullLoaded, setFullLoaded] = useState(false);
  const [dimensions, setDimensions] = useState<string | null>(null);
  const [ratio, setRatio] = useState<number | null>(() => ratioOf(item.imageUrls?.[0] ?? item.url, item.aspect_ratio));
  const [zoomed, setZoomed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  const closing = useRef(false);
  const promptRef = useRef<HTMLDivElement>(null);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [promptOverflows, setPromptOverflows] = useState(false);

  const isVideo = item.mediaType === "video";
  const allUrls = item.imageUrls?.length ? item.imageUrls : [item.url];
  const mediaUrl = allUrls[imgIdx] ?? item.url;
  const placeholderSrc = isVideo ? "" : imgIdx === 0 && thumbUrl ? thumbUrl : thumbSrc(mediaUrl, 300);
  const hasPrevImage = !isVideo && imgIdx > 0;
  const hasNextImage = !isVideo && imgIdx < allUrls.length - 1;

  // New item: back to the first image.
  const [shownItem, setShownItem] = useState(item.id);
  if (shownItem !== item.id) {
    setShownItem(item.id);
    setImgIdx(0);
    setCopied(false);
    setPromptExpanded(false);
  }
  // New media (item or page): reset load state, seed the frame ratio from what we know.
  const mediaKey = `${mediaUrl}|${item.aspect_ratio ?? ""}`;
  const [shownMedia, setShownMedia] = useState(mediaKey);
  if (shownMedia !== mediaKey) {
    setShownMedia(mediaKey);
    setThumbLoaded(false);
    setFullLoaded(false);
    setDimensions(null);
    setRatio(ratioOf(mediaUrl, item.aspect_ratio));
  }

  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  // The prompt is clamped; offer "Show more" only when the clamp actually hides text.
  useLayoutEffect(() => {
    const el = promptRef.current;
    if (!el || promptExpanded) return;
    const ro = new ResizeObserver(() => setPromptOverflows(el.scrollHeight > el.clientHeight + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [item.prompt, promptExpanded]);

  const handleClose = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setVisible(false);
    setTimeout(onClose, CLOSE_MS);
  }, [onClose]);

  const goPrev = useCallback(() => {
    if (hasPrevImage) setImgIdx(i => i - 1);
    else onPrev?.();
  }, [hasPrevImage, onPrev]);
  const goNext = useCallback(() => {
    if (hasNextImage) setImgIdx(i => i + 1);
    else onNext?.();
  }, [hasNextImage, onNext]);

  const copyPrompt = useCallback(() => {
    if (!item.prompt) return;
    navigator.clipboard.writeText(item.prompt).catch(() => {});
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1500);
  }, [item.prompt]);

  const reuse = useCallback(() => {
    if (!item.prompt || !onReuse) return;
    onReuse(item.prompt, item.referenceImageUrls, {
      model: item.model,
      aspectRatio: item.aspect_ratio,
      quality: item.quality,
      azureResolution: item.azure_resolution,
    });
    // The composer sits underneath; close so the reused prompt is visible.
    handleClose();
  }, [item, onReuse, handleClose]);

  const canAsk = !!onAskAssistant && !(isVideo && item.source === "upload");
  const ask = useCallback(() => {
    if (!canAsk) return;
    onAskAssistant?.(item, mediaUrl);
    handleClose();
  }, [canAsk, onAskAssistant, item, mediaUrl, handleClose]);

  // A game character's deliverable is its .glb; the image is only its preview.
  const download = useCallback(
    () => onDownload(item.modelUrl ?? mediaUrl, isVideo),
    [onDownload, item.modelUrl, mediaUrl, isVideo],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (zoomed) setZoomed(false);
        else handleClose();
        return;
      }
      if (e.key === "ArrowLeft") { goPrev(); return; }
      if (e.key === "ArrowRight") { goNext(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      if (key === "c" && item.prompt) { e.preventDefault(); copyPrompt(); }
      else if (key === "r" && item.prompt && onReuse) { e.preventDefault(); reuse(); }
      else if (key === "a" && canAsk) { e.preventDefault(); ask(); }
      else if (key === "d") { e.preventDefault(); download(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [zoomed, handleClose, goPrev, goNext, copyPrompt, reuse, ask, canAsk, download, item.prompt, onReuse]);

  const learnRatio = (w: number, h: number) => {
    if (!w || !h) return;
    setRatio(w / h);
    if (!naturalRatioCache.has(mediaUrl)) {
      naturalRatioCache.set(mediaUrl, `${w} / ${h}`);
      persistNaturalRatios();
    }
  };

  const format = useMemo(() => (item.prompt ? detectPromptFormat(item.prompt) : null), [item.prompt]);

  const metaRows = [
    item.model && { label: "Model", value: item.model },
    item.aspect_ratio && { label: "Aspect ratio", value: item.aspect_ratio },
    item.quality && { label: "Quality", value: item.quality.charAt(0).toUpperCase() + item.quality.slice(1) },
    item.azure_resolution && { label: "Resolution", value: item.azure_resolution },
    dimensions && { label: "Dimensions", value: dimensions },
    { label: "Source", value: item.source === "generation" ? "Generated" : "Uploaded" },
    { label: "Created", value: formatDate(item.created_at) },
  ].filter(Boolean) as { label: string; value: string }[];

  // Fit the frame to the stage with container units once the ratio is known;
  // until then the media fills the stage and object-contain does the fitting.
  const frameStyle: React.CSSProperties | undefined = ratio
    ? { aspectRatio: ratio, width: `min(100cqw, calc(100cqh * ${ratio}))` }
    : undefined;

  const showPrev = hasPrevImage || !!onPrev;
  const showNext = hasNextImage || !!onNext;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={isVideo ? "Video" : "Image"}
      onClick={zoomed ? () => setZoomed(false) : handleClose}
      className={cn(
        "fixed inset-0 z-[9500] flex flex-col overflow-y-auto bg-[var(--scrim)] backdrop-blur-md transition-opacity duration-200 ease-[var(--ease-out)] md:flex-row md:overflow-hidden",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      {/* ── Stage ── */}
      <div
        className={cn(
          "relative flex h-[72vh] shrink-0 items-center justify-center transition-[padding] duration-200 ease-[var(--ease-out)] dark:bg-mat md:h-auto md:min-h-0 md:flex-1",
          zoomed ? "p-0" : "p-4 md:p-8",
        )}
      >
        <div className="flex size-full items-center justify-center [container-type:size]">
          <div
            onClick={e => { e.stopPropagation(); if (!isVideo) setZoomed(z => !z); }}
            style={frameStyle}
            className={cn(
              "relative max-h-full max-w-full overflow-hidden transition-[transform,border-radius] duration-200 ease-[var(--ease-out)]",
              !frameStyle && "size-full",
              visible ? "scale-100" : "scale-[0.97]",
              zoomed ? "rounded-none" : "rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)]",
              isVideo ? "cursor-default" : zoomed ? "cursor-zoom-out" : "cursor-zoom-in",
              !fullLoaded && !thumbLoaded && "ink-shimmer",
            )}
          >
            {isVideo ? (
              <video
                key={mediaUrl}
                src={mediaUrl}
                autoPlay
                loop
                playsInline
                controls
                onClick={e => e.stopPropagation()}
                onLoadedMetadata={e => learnRatio(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
                onLoadedData={e => {
                  setFullLoaded(true);
                  const v = e.currentTarget;
                  if (v.videoWidth && v.videoHeight) setDimensions(`${v.videoWidth} × ${v.videoHeight}`);
                }}
                className="block size-full object-contain"
              />
            ) : (
              <>
                {/* Thumbnail placeholder — already in the browser cache, shows instantly */}
                {placeholderSrc && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={`thumb-${mediaUrl}`}
                    src={placeholderSrc}
                    alt=""
                    aria-hidden
                    onLoad={e => { setThumbLoaded(true); if (!ratio) learnRatio(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight); }}
                    className={cn(
                      "absolute inset-0 block size-full object-contain transition-opacity duration-300 ease-[var(--ease-out)]",
                      fullLoaded ? "opacity-0" : "opacity-100",
                    )}
                  />
                )}
                {/* Full resolution — painted progressively over the placeholder */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={`full-${mediaUrl}`}
                  src={mediaUrl}
                  alt={item.prompt ?? ""}
                  onLoad={e => {
                    setFullLoaded(true);
                    const img = e.currentTarget;
                    learnRatio(img.naturalWidth, img.naturalHeight);
                    if (img.naturalWidth && img.naturalHeight) setDimensions(`${img.naturalWidth} × ${img.naturalHeight}`);
                  }}
                  className="absolute inset-0 block size-full object-contain"
                />
              </>
            )}
          </div>
        </div>

        {/* Counter */}
        {!isVideo && allUrls.length > 1 && (
          <div className="on-media pointer-events-none absolute top-4 left-4 flex h-7 items-center rounded-full px-2.5 text-[12px] font-medium tabular-nums">
            {imgIdx + 1} / {allUrls.length}
          </div>
        )}

        {/* Close */}
        <button
          type="button"
          aria-label="Close"
          onClick={e => { e.stopPropagation(); handleClose(); }}
          className={cn(ON_MEDIA_ROUND, "absolute top-4 right-4 z-10")}
        >
          <X className="size-4" strokeWidth={2} />
        </button>

        {/* Prev / next — pages within a multi-image item, then across items */}
        {showPrev && (
          <button
            type="button"
            aria-label={hasPrevImage ? "Previous image" : "Previous item"}
            onClick={e => { e.stopPropagation(); goPrev(); }}
            className={cn(ON_MEDIA_ROUND, "absolute top-1/2 left-4 z-10 size-10 -translate-y-1/2")}
          >
            <ChevronLeft className="size-5" strokeWidth={2} />
          </button>
        )}
        {showNext && (
          <button
            type="button"
            aria-label={hasNextImage ? "Next image" : "Next item"}
            onClick={e => { e.stopPropagation(); goNext(); }}
            className={cn(ON_MEDIA_ROUND, "absolute top-1/2 right-4 z-10 size-10 -translate-y-1/2")}
          >
            <ChevronRight className="size-5" strokeWidth={2} />
          </button>
        )}

        {/* Image index dots */}
        {!isVideo && allUrls.length > 1 && (
          <div className="on-media absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full px-2.5 py-2">
            {allUrls.map((_, idx) => (
              <button
                key={idx}
                type="button"
                aria-label={`Image ${idx + 1}`}
                aria-current={idx === imgIdx}
                onClick={e => { e.stopPropagation(); setImgIdx(idx); }}
                className={cn(
                  "h-1.5 rounded-full transition-[width,background-color] duration-150 ease-[var(--ease-out)]",
                  idx === imgIdx ? "w-4 bg-white" : "w-1.5 bg-white/45 hover:bg-white/70",
                )}
              />
            ))}
          </div>
        )}
      </div>

      {/* ── Metadata panel ── */}
      <aside
        onClick={e => e.stopPropagation()}
        className={cn(
          "mx-3 mb-3 flex shrink-0 flex-col rounded-[var(--radius-xl)] bg-surface-raised shadow-[var(--shadow-lg)] transition-[opacity,transform] duration-200 ease-[var(--ease-out)]",
          "md:my-3 md:ml-0 md:w-[340px] md:overflow-y-auto",
          zoomed ? "hidden" : visible ? "translate-x-0 opacity-100" : "opacity-0 md:translate-x-3",
        )}
      >
        {/* Actions first: they're why the panel is open. One labelled primary; the rest are icons with tooltips. */}
        <div className="sticky top-0 z-10 flex items-center gap-1 rounded-t-[var(--radius-xl)] border-b border-rule bg-surface-raised px-3 py-3">
          {onReuse && (
            <IconAction label="Reuse prompt & settings" kbd="R" onClick={reuse} disabled={!item.prompt}>
              <RefreshCcw />
            </IconAction>
          )}
          {canAsk && (
            <IconAction label="Ask assistant" kbd="A" onClick={ask}>
              <MessageCircleQuestion />
            </IconAction>
          )}
          <Button variant="ink" size="sm" className="ml-auto" onClick={download}>
            <Download />
            {item.modelUrl ? "Download .glb" : "Download"}
            <Kbd>D</Kbd>
          </Button>
        </div>

        {item.prompt && format && (
          <section className="px-5 py-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="type-label">Prompt</p>
              <IconAction label={copied ? "Copied" : "Copy prompt"} kbd="C" onClick={copyPrompt} className="-my-1.5 -mr-1.5 text-ink-3">
                {copied ? <Check /> : <Copy />}
              </IconAction>
            </div>
            <div
              ref={promptRef}
              className={cn(
                "break-words whitespace-pre-wrap",
                !promptExpanded && "line-clamp-8",
                format.kind === "plain" ? "text-[13.5px] leading-[1.55] text-ink" : "font-mono text-[12px] leading-[1.6]",
              )}
            >
              {format.kind === "json"
                ? syntaxHighlightJson(format.text)
                : format.kind === "yaml"
                  ? syntaxHighlightYaml(item.prompt)
                  : renderStoredPrompt(item.prompt, item.referenceImageUrls)}
            </div>
            {(promptOverflows || promptExpanded) && (
              <button
                type="button"
                onClick={() => setPromptExpanded(e => !e)}
                className="mt-1.5 text-[12.5px] font-medium text-ink-3 transition-colors duration-150 ease-[var(--ease-out)] hover:text-ink"
              >
                {promptExpanded ? "Show less" : "Show more"}
              </button>
            )}
          </section>
        )}

        {item.referenceImageUrls && item.referenceImageUrls.length > 0 && (
          <section className={cn("px-5 py-4", item.prompt && "border-t border-rule")}>
            <p className="type-label mb-2">References</p>
            <div className="flex flex-wrap gap-2">
              {item.referenceImageUrls.map((url, i) => (
                <div key={i} className="relative h-[60px] w-[68px] shrink-0 overflow-hidden rounded-[var(--radius-sm)] bg-mat">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={thumbSrc(url, 68)} alt={`Reference ${i + 1}`} className="block size-full object-cover" />
                  <span className="on-media absolute right-1 bottom-1 rounded-[var(--radius-xs)] px-1 text-[10px] leading-4 font-medium tabular-nums">
                    {i + 1}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Two-up label-over-value grid: half the height of one row per fact */}
        <dl className={cn("grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-4 text-[13px]", (item.prompt || item.referenceImageUrls?.length) && "border-t border-rule")}>
          {metaRows.map(row => (
            <div key={row.label} className="min-w-0">
              <dt className="type-label">{row.label}</dt>
              <dd title={row.value} className="mt-0.5 truncate font-medium text-ink tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      </aside>
    </div>,
    document.body,
  );
}
