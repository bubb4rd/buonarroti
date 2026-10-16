"use client";

import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, Music, Plus, X, ZoomIn } from "lucide-react";
import { thumbSrc } from "@/lib/galleryUtils";
import { cn } from "@/lib/utils";
import { GALLERY_DRAG_MIME, galleryDrag } from "./media";
import { getDisplayOrder } from "./mentions";
import type { ComposerState, ListTarget, PickerTarget, VidTarget } from "./useComposer";
import type { KlingElement, RefImage } from "./types";

/**
 * The row of attached references above the prompt: images for image models,
 * frames / references / videos / audio / Kling elements for video models.
 * Filled slots can be previewed, removed, reordered (pointer drag) and
 * replaced by dropping a gallery item; empty slots open the media picker.
 */

type MediaKind = "image" | "video" | "audio";
type Slot =
  | { kind: "filled"; target: VidTarget | "refImage"; mediaKind: MediaKind; label: string; ref: RefImage; reorderable: boolean }
  | { kind: "add"; target: VidTarget | "refImage"; mediaKind: MediaKind; label: string; left: number }
  | { kind: "element"; element: KlingElement }
  | { kind: "element-add"; left: number };

const TILE = "relative size-16 shrink-0 overflow-hidden rounded-[var(--radius-sm)]";
const MAX_ELEMENTS = 3;

export function ReferenceStrip({
  c,
  onOpenPicker,
  onPickAudio,
  onOpenElements,
  onPreview,
}: {
  c: ComposerState;
  onOpenPicker: (target: PickerTarget, kind: "image" | "video") => void;
  onPickAudio: (target: VidTarget) => void;
  onOpenElements: () => void;
  onPreview: (p: { url: string; mediaKind: "image" | "video" }) => void;
}) {
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; list: ListTarget } | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const justDropped = useRef(false);

  // Cancel a reorder when the pointer is released outside any tile.
  useEffect(() => {
    if (!dragging) return;
    const cancel = () => { setDragging(null); setOverId(null); };
    document.addEventListener("pointerup", cancel);
    document.addEventListener("pointercancel", cancel);
    return () => {
      document.removeEventListener("pointerup", cancel);
      document.removeEventListener("pointercancel", cancel);
    };
  }, [dragging]);

  const slots = buildSlots(c, dragging, overId);
  if (slots.length === 0) return null;

  const acceptGalleryDrop = (key: string, kind: MediaKind) => (e: React.DragEvent) => {
    if (kind === "audio" || !e.dataTransfer.types.includes(GALLERY_DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setDragOver(key);
  };

  const drop = (target: VidTarget | "refImage", kind: MediaKind) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(null);
    const item = galleryDrag.item;
    galleryDrag.item = null;
    if (!item || item.mediaType !== kind) return;
    if (target === "refImage") c.addReference(item.url);
    else c.addVidRefUrl(target, item.url);
  };

  const finishReorder = (targetId: string) => {
    if (!dragging) return;
    c.reorder(dragging.list, dragging.id, overId ?? targetId);
    if (overId && overId !== dragging.id) {
      justDropped.current = true;
      setTimeout(() => { justDropped.current = false; }, 300);
    }
    setDragging(null);
    setOverId(null);
  };

  return (
    <div className="flex flex-wrap items-start gap-2 px-4 pt-3.5">
      {slots.map((slot, idx) => {
        if (slot.kind === "element") {
          const el = slot.element;
          return (
            <div key={el.id} className={cn(TILE, "group bg-mat")}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumbSrc(el.imageUrls[0], 56)} alt="" className="size-full object-cover" />
              <button
                type="button"
                aria-label={`Preview ${el.name}`}
                onClick={() => onPreview({ url: el.imageUrls[0], mediaKind: "image" })}
                className="absolute inset-0 flex items-center justify-center bg-black/35 text-white opacity-0 transition-opacity group-hover:opacity-100"
              >
                <ZoomIn className="size-3.5" />
              </button>
              <TileLabel>{el.name}</TileLabel>
              <RemoveButton label={`Remove ${el.name}`} onClick={() => c.setVidElements(prev => prev.filter(e => e.id !== el.id))} />
            </div>
          );
        }
        if (slot.kind === "element-add") {
          return (
            <button key={`element-add-${idx}`} type="button" onClick={onOpenElements} className={cn(TILE, ADD_TILE)}>
              <Plus className="size-3.5" />
              <span className="text-[11px] leading-none text-ink-2">Element</span>
              <span className="text-[10.5px] leading-none text-ink-4 tabular-nums">{slot.left} left</span>
            </button>
          );
        }
        if (slot.kind === "add") {
          const key = `add-${slot.target}-${idx}`;
          const over = dragOver === key;
          return (
            <button
              key={key}
              type="button"
              // Only audio slots target "audioRef"; every other add slot is a picker target.
              onClick={() => (slot.mediaKind === "audio" ? onPickAudio(slot.target as VidTarget) : onOpenPicker(slot.target as PickerTarget, slot.mediaKind as "image" | "video"))}
              onDragOver={acceptGalleryDrop(key, slot.mediaKind)}
              onDragLeave={() => setDragOver(null)}
              onDrop={slot.mediaKind === "audio" ? undefined : drop(slot.target, slot.mediaKind)}
              className={cn(TILE, ADD_TILE, over && "border-solid border-lapis bg-lapis-soft text-lapis")}
            >
              <Plus className="size-3.5" />
              <span className="max-w-full truncate px-1 text-[11px] leading-none text-ink-2">{slot.label}</span>
              {slot.left > 1 && <span className="text-[10.5px] leading-none text-ink-4 tabular-nums">{slot.left} left</span>}
            </button>
          );
        }

        const r = slot.ref;
        const key = `filled-${r.id}`;
        const list = slot.target as ListTarget;
        const tagged = c.taggedImages.some(t => t.refId === r.id);
        const previewable = slot.mediaKind !== "audio" && !r.uploading && !r.error;
        return (
          <div
            key={r.id}
            onMouseDown={e => e.preventDefault()}
            onPointerDown={() => { if (slot.reorderable && !r.uploading && !r.error) setDragging({ id: r.id, list }); }}
            onPointerEnter={() => { if (dragging && dragging.list === list && dragging.id !== r.id) setOverId(r.id); }}
            onPointerUp={e => {
              if (!dragging || dragging.list !== list) return;
              e.stopPropagation();
              finishReorder(r.id);
            }}
            onClick={() => {
              if (justDropped.current) { justDropped.current = false; return; }
              if (previewable && !dragging) onPreview({ url: r.objectUrl, mediaKind: slot.mediaKind as "image" | "video" });
            }}
            onDragOver={acceptGalleryDrop(key, slot.mediaKind)}
            onDragLeave={() => setDragOver(null)}
            onDrop={slot.mediaKind === "audio" ? undefined : drop(slot.target, slot.mediaKind)}
            style={{ touchAction: slot.reorderable ? "none" : undefined }}
            className={cn(
              TILE,
              "group bg-mat animate-in fade-in-0 zoom-in-95 duration-200",
              previewable && (slot.reorderable ? "cursor-grab" : "cursor-zoom-in"),
              dragging?.id === r.id && "cursor-grabbing opacity-35",
              r.error && "ring-1 ring-sanguine ring-inset",
              tagged && !r.error && "ring-2 ring-lapis ring-inset",
              dragOver === key && "ring-2 ring-lapis",
            )}
          >
            {slot.mediaKind === "image" ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbSrc(r.objectUrl, 56)} alt="" draggable={false} className="size-full object-cover" />
            ) : slot.mediaKind === "video" ? (
              <video src={r.objectUrl} autoPlay muted loop playsInline className="size-full object-cover" />
            ) : (
              <div className="flex size-full items-center justify-center text-ink-3"><Music className="size-4" strokeWidth={1.75} /></div>
            )}
            {previewable && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/30 text-white opacity-0 transition-opacity group-hover:opacity-100">
                <ZoomIn className="size-3.5" />
              </div>
            )}
            <TileLabel>{slot.label}</TileLabel>
            {r.uploading && <div className="ink-shimmer absolute inset-0" aria-label="Uploading" />}
            {r.error && (
              <div className="absolute inset-0 flex items-center justify-center bg-surface/80 text-sanguine" title="Upload failed">
                <AlertCircle className="size-4" strokeWidth={1.75} />
              </div>
            )}
            <RemoveButton
              label={`Remove ${slot.label.toLowerCase()}`}
              onClick={() => (slot.target === "refImage" ? c.removeRefImage(r.id) : c.removeVidRef(r.id, slot.target))}
            />
          </div>
        );
      })}
    </div>
  );
}

const ADD_TILE =
  "flex flex-col items-center justify-center gap-1 border border-dashed border-rule-strong text-ink-3 transition-colors duration-150 hover:border-ink-3 hover:bg-wash hover:text-ink-2";

function TileLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1 pt-3 pb-0.5 text-center">
      <span className="block truncate text-[9.5px] font-medium text-white/90">{children}</span>
    </div>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onClick(); }}
      className="on-media absolute top-1 right-1 z-[2] flex size-4 items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
    >
      <X className="size-2.5" strokeWidth={2.5} />
    </button>
  );
}

function buildSlots(c: ComposerState, dragging: { id: string } | null, overId: string | null): Slot[] {
  const order = (rs: RefImage[]) => getDisplayOrder(rs, dragging?.id ?? null, overId);
  const slots: Slot[] = [];

  if (!c.isVideo) {
    if (!c.imgModel?.supportsImages) return slots;
    const multi = c.refImages.length > 1;
    order(c.refImages).forEach(ref => slots.push({ kind: "filled", target: "refImage", mediaKind: "image", label: "Image", ref, reorderable: multi }));
    if (c.canAddImgs) slots.push({ kind: "add", target: "refImage", mediaKind: "image", label: "Image", left: c.maxImgs - c.refImages.length });
    return slots;
  }

  const vm = c.vidModel;
  const id = vm?.id;
  const framesXorRefs = id === "seedance-2" || id === "seedance-2-fast" || id === "minimax-h3";
  const hasFrame = !!(c.vidStartFrame || c.vidEndFrame);
  const hasRef = c.vidResources.length > 0 || c.vidRefVideos.length > 0 || c.vidRefAudios.length > 0;

  const single = (target: VidTarget, ref: RefImage | null, mediaKind: MediaKind, label: string) =>
    slots.push(ref ? { kind: "filled", target, mediaKind, label, ref, reorderable: false } : { kind: "add", target, mediaKind, label, left: 1 });
  const multiple = (target: VidTarget, list: RefImage[], mediaKind: MediaKind, label: string) => {
    order(list).forEach(ref => slots.push({ kind: "filled", target, mediaKind, label, ref, reorderable: list.length > 1 }));
    const max = c.vidSlotLimit(target);
    if (list.length < max) slots.push({ kind: "add", target, mediaKind, label, left: max - list.length });
  };

  for (const h of c.vidRefHandles) {
    if (c.isVeo) {
      if (c.veoMode === "references" && (h === "startFrame" || h === "endFrame")) continue;
      if (c.veoMode === "frames" && h === "resource") continue;
      if (h === "videoRef" || h === "referenceVideo" || h === "audioRef") continue;
    }
    if (id === "happyhorse" && h === "startFrame" && c.vidResources.length > 0) continue;
    if (id === "happyhorse" && h === "resource" && c.vidStartFrame) continue;
    if (framesXorRefs && hasFrame && (h === "resource" || h === "referenceVideo" || h === "audioRef")) continue;
    if (framesXorRefs && hasRef && (h === "startFrame" || h === "endFrame")) continue;

    if (h === "startFrame") single(h, c.vidStartFrame, "image", "Start frame");
    else if (h === "endFrame") single(h, c.vidEndFrame, "image", "End frame");
    else if (h === "videoRef") single(h, c.vidVideoRef, "video", "Video");
    else if (h === "resource") {
      if (vm?.apiInput.useKlingElements) {
        c.vidElements.forEach(element => slots.push({ kind: "element", element }));
        if (c.vidElements.length < MAX_ELEMENTS) slots.push({ kind: "element-add", left: MAX_ELEMENTS - c.vidElements.length });
      } else {
        multiple(h, c.vidResources, "image", id === "happyhorse" ? "Character" : "Image");
      }
    } else if (h === "referenceVideo") multiple(h, c.vidRefVideos, "video", "Video");
    else if (h === "audioRef") multiple(h, c.vidRefAudios, "audio", "Audio");
  }
  return slots;
}
