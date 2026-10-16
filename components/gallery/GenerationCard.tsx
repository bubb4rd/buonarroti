"use client";

import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  ImageOff,
  ImagePlus,
  LoaderCircle,
  Play,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";

import { thumbSrc } from "@/lib/galleryUtils";
import { cn } from "@/lib/utils";
import {
  GALLERY_DRAG_MIME,
  galleryDrag,
  loadedImageUrls,
  naturalRatioCache,
  persistLoadedImages,
  releaseImageSlot,
  requestImageSlot,
} from "./media";
import { renderStoredPrompt } from "./mentions";
import type { GalleryItem, ReusePromptFn } from "./types";

export interface GenerationCardProps {
  item: GalleryItem;
  /** Rendered width in CSS px; picks the thumbnail size. */
  displayWidth?: number;
  /** Opens the lightbox; receives the thumbnail URL already in cache for a blur-up. */
  onOpen?: (thumbUrl: string) => void;
  onAddReference?: (url: string) => void;
  onReuse?: ReusePromptFn;
  onDownload?: (url: string, isVideo: boolean) => void | Promise<void>;
  onDelete?: (id: string, source: "generation" | "upload") => void;
  videoMuted?: boolean;
  onToggleMute?: () => void;
  /** Fired once when an upload's natural ratio is first written to `naturalRatioCache`. */
  onNaturalRatioDiscovered?: () => void;
  selected?: boolean;
  anySelected?: boolean;
  onSelect?: () => void;
  scrollContainer?: React.RefObject<HTMLDivElement | null>;
  isTagged?: boolean;
  isNew?: boolean;
  onMarkSeen?: () => void;
}

const ICON = { strokeWidth: 1.75 } as const;

/** Round 28px control drawn over the artwork. */
const mediaIconBtn =
  "on-media flex size-7 shrink-0 items-center justify-center rounded-full text-white/85 outline-none transition-[background-color,color,opacity] duration-150 ease-[var(--ease-out)] hover:bg-black/60 hover:text-white focus-visible:ring-2 focus-visible:ring-white/70 disabled:pointer-events-none [&_svg]:size-3.5";

/** Fades in on hover (or keyboard focus inside the card). */
const reveal =
  "opacity-0 transition-opacity duration-150 ease-[var(--ease-out)] group-hover/card:opacity-100 group-focus-within/card:opacity-100";
/** Revealed and interactive only on hover (or keyboard focus inside the card). */
const onHover = `${reveal} pointer-events-none group-hover/card:pointer-events-auto group-focus-within/card:pointer-events-auto`;

export function GenerationCard({
  item,
  displayWidth,
  onOpen,
  onAddReference,
  onReuse,
  onDownload,
  onDelete,
  videoMuted,
  onToggleMute,
  onNaturalRatioDiscovered,
  selected,
  anySelected,
  onSelect,
  scrollContainer,
  isTagged,
  isNew,
  onMarkSeen,
}: GenerationCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cancelSlotRef = useRef<(() => void) | null>(null);
  const slotReleasedRef = useRef(false);
  const [thumbFailedUrls, setThumbFailedUrls] = useState<ReadonlySet<string>>(() => new Set());
  const [lockedWidths, setLockedWidths] = useState<Readonly<Record<string, number>>>({});
  const preloaded = loadedImageUrls.has(item.url);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(preloaded);
  const [shouldLoad, setShouldLoad] = useState(preloaded);
  const [reused, setReused] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [cardImgIdx, setCardImgIdx] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const isVideo = item.mediaType === "video";
  const allUrls = item.imageUrls ?? [item.url];
  const displayUrl = allUrls[cardImgIdx] ?? item.url;
  const isThumbFailed = thumbFailedUrls.has(displayUrl);
  // Lock the thumbnail width per URL; it only ratchets up, so a resize never swaps in a smaller image.
  const requested = displayWidth ?? 400;
  const stableWidth = Math.max(requested, lockedWidths[displayUrl] ?? 0);
  if (stableWidth > (lockedWidths[displayUrl] ?? 0)) setLockedWidths({ ...lockedWidths, [displayUrl]: stableWidth });
  const imgSrc = isThumbFailed ? displayUrl : thumbSrc(displayUrl, stableWidth);
  const hasStoredRatio = !!item.aspect_ratio && item.aspect_ratio !== "auto";

  // Lazy load: request a concurrency slot when the card nears the viewport.
  useEffect(() => {
    if (preloaded) return;
    const el = cardRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        if (isVideo) setShouldLoad(true);
        else if (!cancelSlotRef.current) cancelSlotRef.current = requestImageSlot(() => setShouldLoad(true));
      },
      { root: scrollContainer?.current ?? null, rootMargin: "200px", threshold: 0 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelSlotRef.current?.();
      cancelSlotRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only play videos that are actually visible.
  useEffect(() => {
    if (!isVideo) return;
    const el = cardRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          videoRef.current?.play().then(() => setPlaying(true)).catch(() => {});
        } else {
          videoRef.current?.pause();
          setPlaying(false);
        }
      },
      { root: scrollContainer?.current ?? null, rootMargin: "0px", threshold: 0.1 },
    );
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideo]);

  const releaseSlot = () => {
    if (slotReleasedRef.current) return;
    slotReleasedRef.current = true;
    releaseImageSlot();
  };

  const markFailed = () => {
    setFailed(true);
    loadedImageUrls.delete(item.url);
    persistLoadedImages();
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (downloading) return;
    setDownloading(true);
    try { await onDownload?.(item.url, isVideo); } finally { setDownloading(false); }
  };

  const handleReuse = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!item.prompt) return;
    onReuse?.(item.prompt, item.referenceImageUrls, {
      model: item.model,
      aspectRatio: item.aspect_ratio,
      quality: item.quality,
      azureResolution: item.azure_resolution,
    });
    setReused(true);
    setTimeout(() => setReused(false), 1500);
  };

  const pageTo = (idx: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    if (idx === cardImgIdx) return;
    setImgLoaded(false);
    setCardImgIdx(idx);
  };

  if (failed) {
    return (
      <div className="flex size-full items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-mat text-ink-4">
        <ImageOff className="size-5" {...ICON} aria-label="This file could not be loaded" />
      </div>
    );
  }

  const meta = [item.model, item.aspect_ratio].filter(Boolean).join(" · ") || (item.source === "upload" ? "Uploaded" : "");

  return (
    <div
      ref={cardRef}
      className="group/card relative size-full animate-in cursor-pointer overflow-hidden rounded-[var(--radius-sm)] bg-mat duration-200 ease-[var(--ease-out)] fade-in slide-in-from-bottom-2"
      draggable
      onDragStart={e => {
        e.stopPropagation();
        galleryDrag.item = { url: item.url, mediaType: item.mediaType };
        e.dataTransfer.setData(GALLERY_DRAG_MIME, "1");
        e.dataTransfer.setData("text/plain", item.url);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onDragEnd={() => { galleryDrag.item = null; }}
      onMouseEnter={() => { setIsHovered(true); onMarkSeen?.(); }}
      onMouseLeave={() => setIsHovered(false)}
      onClick={anySelected ? onSelect : () => onOpen?.(imgSrc)}
    >
      {isVideo ? (
        <>
          {!imgLoaded && <div className="ink-shimmer absolute inset-0" />}
          <video
            ref={videoRef}
            src={shouldLoad ? item.url : undefined}
            muted={videoMuted || !isHovered}
            autoPlay
            loop
            playsInline
            preload="metadata"
            draggable={false}
            onLoadedData={() => {
              setImgLoaded(true);
              loadedImageUrls.add(item.url);
            }}
            onError={markFailed}
            className={cn(
              "relative block size-full object-cover transition-opacity duration-200 ease-[var(--ease-out)]",
              imgLoaded ? "opacity-100" : "opacity-0",
            )}
          />
          {!playing && (
            <div className={cn("on-media pointer-events-none absolute top-1/2 left-1/2 flex size-9 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full", reveal)}>
              <Play className="size-3.5 translate-x-px fill-current" {...ICON} />
            </div>
          )}
        </>
      ) : (
        <>
          {(!shouldLoad || !imgLoaded) && <div className="ink-shimmer absolute inset-0" />}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={displayUrl}
            src={shouldLoad ? imgSrc : undefined}
            alt={item.prompt ?? ""}
            draggable={false}
            decoding="async"
            onLoad={e => {
              releaseSlot();
              const img = e.currentTarget;
              if (!hasStoredRatio && item.source === "upload" && img.naturalWidth && img.naturalHeight && !naturalRatioCache.has(item.url)) {
                naturalRatioCache.set(item.url, `${img.naturalWidth} / ${img.naturalHeight}`);
                onNaturalRatioDiscovered?.();
              }
              setImgLoaded(true);
              loadedImageUrls.add(item.url);
            }}
            onError={() => {
              if (!isThumbFailed) {
                // The resized thumbnail failed; fall back to the original once.
                setThumbFailedUrls(prev => new Set(prev).add(displayUrl));
              } else {
                releaseSlot();
                markFailed();
              }
            }}
            className={cn(
              "relative block size-full object-cover transition-opacity duration-200 ease-[var(--ease-out)]",
              imgLoaded ? "opacity-100" : "opacity-0",
            )}
          />
          {allUrls.length > 1 && (
            <>
              <button
                type="button"
                aria-label="Previous image"
                onClick={pageTo(Math.max(0, cardImgIdx - 1))}
                disabled={cardImgIdx === 0}
                className={cn(mediaIconBtn, "absolute top-1/2 left-1.5 z-[3] size-[26px] -translate-y-1/2 disabled:opacity-25")}
              >
                <ChevronLeft {...ICON} />
              </button>
              <button
                type="button"
                aria-label="Next image"
                onClick={pageTo(Math.min(allUrls.length - 1, cardImgIdx + 1))}
                disabled={cardImgIdx === allUrls.length - 1}
                className={cn(mediaIconBtn, "absolute top-1/2 right-1.5 z-[3] size-[26px] -translate-y-1/2 disabled:opacity-25")}
              >
                <ChevronRight {...ICON} />
              </button>
              <div className="absolute bottom-2 left-1/2 z-[3] flex -translate-x-1/2 gap-1">
                {allUrls.map((_, idx) => (
                  <button
                    key={idx}
                    type="button"
                    aria-label={`Image ${idx + 1} of ${allUrls.length}`}
                    aria-current={idx === cardImgIdx}
                    onClick={pageTo(idx)}
                    className={cn(
                      "h-1.5 rounded-full transition-[width,background-color] duration-150 ease-[var(--ease-out)]",
                      idx === cardImgIdx ? "w-3 bg-white" : "w-1.5 bg-white/40 hover:bg-white/70",
                    )}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}

      {/* Tagged as a reference in the composer. Drawn above the media so the ring is visible. */}
      {isTagged && <div className="pointer-events-none absolute inset-0 z-[4] rounded-[inherit] ring-2 ring-lapis ring-inset" />}

      {/* Unseen since it landed. Cleared on hover. */}
      {isNew && (
        <span
          aria-label="New"
          className="pointer-events-none absolute top-2.5 left-2.5 z-[5] size-1.5 rounded-full bg-lapis shadow-[0_0_0_1.5px_rgb(255_255_255/0.85)] group-hover/card:opacity-0"
        />
      )}

      {!anySelected && (
        <>
          {/* Scrim + prompt excerpt */}
          <div className={cn("pointer-events-none absolute inset-0 flex flex-col justify-end bg-linear-to-t from-black/60 to-black/0 to-55% p-2.5", reveal)}>
            {item.prompt && (
              <div className="mb-1 line-clamp-3 text-[11.5px] leading-[1.45] text-white/85 [&_.bg-wash-strong]:bg-white/15 [&_.text-ink]:text-white">
                {renderStoredPrompt(item.prompt, item.referenceImageUrls)}
              </div>
            )}
            {meta && <p className="truncate text-[10.5px] text-white/50 tabular-nums">{meta}</p>}
          </div>

          {/* Top-right actions */}
          <div className={cn("absolute top-2 right-2 z-[5] flex flex-col gap-1.5", onHover)}>
            {isVideo && (
              <button
                type="button"
                className={mediaIconBtn}
                onClick={e => { e.stopPropagation(); onToggleMute?.(); }}
                title={videoMuted ? "Unmute" : "Mute"}
                aria-label={videoMuted ? "Unmute" : "Mute"}
              >
                {videoMuted ? <VolumeX {...ICON} /> : <Volume2 {...ICON} />}
              </button>
            )}
            {item.prompt && onReuse && (
              <button
                type="button"
                className={mediaIconBtn}
                title={reused ? "Prompt reused" : "Reuse prompt"}
                aria-label={reused ? "Prompt reused" : "Reuse prompt"}
                onClick={handleReuse}
              >
                {reused ? <Check {...ICON} /> : <Copy {...ICON} />}
              </button>
            )}
            {onDownload && (
              <button
                type="button"
                className={cn(mediaIconBtn, downloading && "opacity-65")}
                title={downloading ? "Downloading…" : "Download"}
                aria-label={downloading ? "Downloading…" : "Download"}
                onClick={handleDownload}
                disabled={downloading}
              >
                {downloading ? <LoaderCircle className="animate-spin" {...ICON} /> : <Download {...ICON} />}
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                className={cn(mediaIconBtn, "hover:bg-sanguine/80 hover:text-white")}
                title="Delete"
                aria-label="Delete"
                onClick={e => { e.stopPropagation(); onDelete(item.id, item.source); }}
              >
                <Trash2 {...ICON} />
              </button>
            )}
          </div>

          {/* Use as reference (images only) */}
          {!isVideo && onAddReference && (
            <div className={cn("absolute right-2.5 bottom-2.5 z-[5]", onHover)}>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); onAddReference(item.url); }}
                className="on-media flex h-7 items-center gap-1.5 rounded-full pr-3 pl-2.5 text-[12px] font-medium whitespace-nowrap text-white outline-none transition-colors duration-150 ease-[var(--ease-out)] hover:bg-black/60 focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <ImagePlus className="size-3.5" {...ICON} />
                Use as reference
              </button>
            </div>
          )}
        </>
      )}

      {/* Selection checkbox (top-left) */}
      <button
        type="button"
        role="checkbox"
        aria-checked={!!selected}
        aria-label={selected ? "Deselect" : "Select"}
        onClick={e => { e.stopPropagation(); onSelect?.(); }}
        className={cn(
          "absolute top-2 left-2 z-[6] flex size-5 items-center justify-center rounded-[var(--radius-xs)] border-[1.5px] outline-none transition-[opacity,background-color,border-color] duration-150 ease-[var(--ease-out)] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-white/70",
          selected
            ? "border-lapis bg-lapis text-white opacity-100"
            : "border-white bg-black/20 opacity-0 group-hover/card:opacity-100 hover:bg-black/35",
        )}
      >
        {selected && <Check className="size-3" strokeWidth={3} />}
      </button>
    </div>
  );
}
