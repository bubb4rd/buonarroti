"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ArrowRight, Link2, Plus, X } from "lucide-react";
import { GalleryItem, getToken } from "@/lib/galleryUtils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Segmented } from "@/components/ui/segmented";
import { PickerTile } from "@/components/media/PickerTile";
import { MediaPreview } from "@/components/media/MediaPreview";
import { useMediaLibrary, type PickerTabId as TabId } from "@/components/media/useMediaLibrary";

const PICKER_POS_STORAGE_KEY = "mediaPickerModal:pos";

function loadSavedPickerPos(): { left: number; top: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PICKER_POS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.left === "number" && typeof parsed?.top === "number") return parsed;
  } catch {
    // ignore malformed storage
  }
  return null;
}

function savePickerPos(left: number, top: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PICKER_POS_STORAGE_KEY, JSON.stringify({ left, top }));
  } catch {
    // ignore storage failures (e.g. private browsing quota)
  }
}

/** Picker height when anchored above a composer (grows with its width). */
const anchoredHeight = (width: number) => Math.min(460, Math.max(340, 0.55 * width));

export function MediaPickerModal({
  open,
  mediaKind,
  onClose,
  onPickUrl,
  onDeselect,
  onUpload,
  onDropFiles,
  anchorRef,
  x,
  y,
  selectedUrls,
  maxCount,
}: {
  open: boolean;
  mediaKind: "image" | "video" | "any";
  onClose: () => void;
  onPickUrl: (url: string, mediaType: "image" | "video") => void;
  onDeselect?: (url: string) => void;
  onUpload?: () => void;
  /** Files dropped onto the picker. When absent, the picker doesn't accept drops. */
  onDropFiles?: (files: File[]) => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  x?: number;
  y?: number;
  selectedUrls?: string[];
  maxCount?: number;
}) {
  const defaultTab: TabId = mediaKind === "image" ? "image-gen" : mediaKind === "video" ? "video-gen" : "uploads";
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab);
  const [pos, setPos] = useState({ left: 0, top: 0, bottom: 0, width: 0, isAnchored: false, isCustom: false });
  const [urlInput, setUrlInput] = useState("");
  const [urlLoading, setUrlLoading] = useState(false);
  const [urlError, setUrlError] = useState("");
  const [previewItem, setPreviewItem] = useState<GalleryItem | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const dragDepthRef = useRef(0);
  const dragOffsetRef = useRef({ x: 0, y: 0 });

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (!pos.isCustom) return;
    if ((e.target as HTMLElement).closest("button, input")) return;
    dragOffsetRef.current = { x: e.clientX - pos.left, y: e.clientY - pos.top };
    setIsDragging(true);
    e.preventDefault();
  }, [pos.isCustom, pos.left, pos.top]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      setPos((p) => ({
        ...p,
        left: Math.max(4, Math.min(e.clientX - dragOffsetRef.current.x, window.innerWidth - p.width - 4)),
        top: Math.max(4, Math.min(e.clientY - dragOffsetRef.current.y, window.innerHeight - p.width - 4)),
      }));
    };
    const handleUp = () => {
      setIsDragging(false);
      setPos((p) => {
        savePickerPos(p.left, p.top);
        return p;
      });
    };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isDragging]);

  const submitUrl = async () => {
    const trimmed = urlInput.trim();
    if (!trimmed || urlLoading) return;
    setUrlError("");
    setUrlLoading(true);
    try {
      const token = await getToken();
      const res = await fetch("/api/fetch-url", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ url: trimmed }),
      });
      const data = await res.json() as { cdnUrl?: string; mediaType?: "image" | "video"; error?: string };
      if (!res.ok || !data.cdnUrl) throw new Error(data.error ?? "That link couldn't be attached. Check it points to an image or video, then try again.");
      setUrlInput("");
      onPickUrl(data.cdnUrl, data.mediaType ?? "image");
      onClose();
    } catch (e: unknown) {
      setUrlError(e instanceof Error ? e.message : "That link couldn't be attached. Check it points to an image or video, then try again.");
    } finally {
      setUrlLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;

    let targetLeft = 0;
    let targetTop = 0;
    let targetBottom = 0;
    let targetWidth = 0;
    let anchored = false;
    let custom = false;

    if (anchorRef?.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      targetLeft = rect.left;
      targetWidth = rect.width;
      // Sit just above the anchor, never overflowing the top of the viewport
      targetBottom = window.innerHeight - rect.top + 6;
      targetBottom = Math.min(targetBottom, window.innerHeight - anchoredHeight(targetWidth) - 8);
      targetBottom = Math.max(targetBottom, 8);
      anchored = true;
    } else if (x !== undefined && y !== undefined) {
      // Position at cursor — square popup (or the remembered spot, if the user moved it before)
      const modalSize = 520;
      const saved = loadSavedPickerPos();
      const rawLeft = saved ? saved.left : x;
      const rawTop = saved ? saved.top : y;
      targetLeft = Math.max(12, Math.min(rawLeft, window.innerWidth - modalSize - 12));
      targetTop = Math.max(12, Math.min(rawTop, window.innerHeight - modalSize - 12));
      targetWidth = modalSize;
      custom = true;
    }

    setPos({
      left: targetLeft,
      top: targetTop,
      bottom: targetBottom,
      width: targetWidth,
      isAnchored: anchored,
      isCustom: custom,
    });
  }, [open, anchorRef, x, y]);

  const { displayItems, fetching, loadingMore, scrollContainerRef } = useMediaLibrary({ open, mediaKind, activeTab });

  /* Each open starts fresh: default tab, no stale link, preview or drop state. */
  const session = open ? mediaKind : null;
  const [startedSession, setStartedSession] = useState<typeof session>(null);
  if (session !== startedSession) {
    setStartedSession(session);
    if (session) {
      setActiveTab(defaultTab);
      setUrlInput("");
      setUrlError("");
      setPreviewItem(null);
      setDropActive(false);
    }
  }

  const tabs: { value: TabId; label: string }[] =
    mediaKind === "any"
      ? [
          { value: "uploads", label: "Uploads" },
          { value: "image-gen", label: "Images" },
          { value: "video-gen", label: "Videos" },
        ]
      : mediaKind === "image"
        ? [
            { value: "image-gen", label: "Generated" },
            { value: "uploads", label: "Uploads" },
          ]
        : [
            { value: "video-gen", label: "Generated" },
            { value: "uploads", label: "Uploads" },
          ];

  const selectedCount = selectedUrls?.length ?? 0;
  const atLimit = maxCount !== undefined && selectedCount >= maxCount;
  const isMulti = maxCount !== undefined;
  const previewSelected = previewItem ? (selectedUrls?.includes(previewItem.url) ?? false) : false;

  const toggleItem = useCallback(
    (item: GalleryItem) => {
      const isSelected = selectedUrls?.includes(item.url) ?? false;
      if (isSelected) onDeselect?.(item.url);
      else if (!(maxCount !== undefined && (selectedUrls?.length ?? 0) >= maxCount)) onPickUrl(item.url, item.mediaType);
    },
    [selectedUrls, maxCount, onDeselect, onPickUrl]
  );

  const closePreview = useCallback(() => setPreviewItem(null), []);
  const togglePreviewItem = useCallback(() => {
    if (previewItem) toggleItem(previewItem);
  }, [previewItem, toggleItem]);

  /* ⌘↵ confirms a multi-selection (selections already apply live) */
  useEffect(() => {
    if (!open || !isMulti || previewItem) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, isMulti, previewItem, onClose]);

  const acceptsDrop = !!onDropFiles;
  const dropHandlers = acceptsDrop
    ? {
        onDragEnter: (e: React.DragEvent) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragDepthRef.current = dropActive ? dragDepthRef.current + 1 : 1;
          setDropActive(true);
        },
        onDragOver: (e: React.DragEvent) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: () => {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDropActive(false);
        },
        onDrop: (e: React.DragEvent) => {
          e.preventDefault();
          dragDepthRef.current = 0;
          setDropActive(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length) onDropFiles!(files);
        },
      }
    : {};

  const positioned = pos.isAnchored || pos.isCustom;
  const popupStyle: React.CSSProperties = positioned
    ? {
        left: pos.left,
        top: pos.isCustom ? pos.top : "auto",
        bottom: pos.isAnchored ? pos.bottom : "auto",
        translate: "none",
        width: pos.width,
        height: pos.isCustom ? pos.width : anchoredHeight(pos.width),
      }
    : {};

  const emptyCopy =
    activeTab === "uploads"
      ? "Nothing uploaded yet. Drop a file here or choose Upload."
      : "Nothing here yet. Your generations will appear here.";

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          data-prompt-overlay=""
          className="fixed inset-0 z-[100000] bg-[var(--scrim)] transition-opacity duration-200 ease-[var(--ease-out)] data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        />
        <DialogPrimitive.Popup
          data-prompt-overlay=""
          aria-label="Choose media"
          style={popupStyle}
          className={cn(
            "fixed top-1/2 left-1/2 z-[100000] flex h-[min(560px,86vh)] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[var(--radius-xl)] bg-surface-raised text-ink shadow-[var(--shadow-lg)] outline-none",
            "transition-[opacity,transform] duration-200 ease-[var(--ease-out)] data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"
          )}
          {...dropHandlers}
        >
          {/* Header — draggable when the picker was opened at the cursor */}
          <div
            onMouseDown={handleDragStart}
            className={cn(
              "flex shrink-0 items-center gap-3 px-5 pt-4 pb-3",
              pos.isCustom && (isDragging ? "cursor-grabbing" : "cursor-grab")
            )}
          >
            <DialogPrimitive.Title className="type-title text-[19px] text-ink">
              {mediaKind === "video" ? "Choose a video" : mediaKind === "image" ? "Choose images" : "Choose media"}
            </DialogPrimitive.Title>
            <Segmented
              size="sm"
              aria-label="Source"
              value={activeTab}
              onChange={setActiveTab}
              options={tabs}
              className="ml-auto"
            />
            <DialogPrimitive.Close
              aria-label="Close"
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-ink-3 transition-colors hover:bg-wash hover:text-ink"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>

          {/* Paste a link */}
          <div className="shrink-0 px-5 pb-3">
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Link2 className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-4" />
                <Input
                  type="url"
                  placeholder="Paste an image or video link"
                  value={urlInput}
                  aria-invalid={urlError ? true : undefined}
                  onChange={(e) => { setUrlInput(e.target.value); setUrlError(""); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitUrl(); } }}
                  className="pl-8"
                />
              </div>
              <Button onClick={submitUrl} disabled={!urlInput.trim() || urlLoading}>
                {urlLoading ? "Attaching…" : (<>Attach <ArrowRight /></>)}
              </Button>
            </div>
            {urlError && <p className="mt-1.5 text-[12px] text-sanguine">{urlError}</p>}
          </div>

          {/* Grid */}
          <div
            ref={scrollContainerRef}
            className={cn(
              "relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto border-t border-rule bg-paper-sunk px-5 pt-4 pb-5 transition-colors",
              dropActive && "bg-lapis-soft"
            )}
          >
            {fetching && displayItems.length === 0 ? (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2.5">
                {Array.from({ length: 12 }, (_, i) => (
                  <div key={i} className="ink-shimmer aspect-square rounded-[var(--radius-sm)]" />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2.5">
                {(onUpload || acceptsDrop) && (
                  <button
                    type="button"
                    onClick={onUpload}
                    disabled={!onUpload}
                    className={cn(
                      "flex aspect-square flex-col items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border-[1.5px] border-dashed text-[11.5px] font-medium transition-colors outline-none focus-visible:shadow-[var(--focus-ring)] disabled:cursor-default",
                      dropActive
                        ? "border-lapis bg-lapis-soft text-lapis"
                        : "border-rule-strong text-ink-3 hover:border-ink-4 hover:bg-wash hover:text-ink"
                    )}
                  >
                    <Plus className="size-4" />
                    {dropActive ? "Drop to upload" : "Upload"}
                  </button>
                )}

                {displayItems.map((item) => {
                  const isSelected = selectedUrls?.includes(item.url) ?? false;
                  return (
                    <PickerTile
                      key={item.id}
                      item={item}
                      selected={isSelected}
                      disabled={!isSelected && atLimit}
                      onToggle={() => toggleItem(item)}
                      onPreview={() => setPreviewItem(item)}
                    />
                  );
                })}

                {displayItems.length === 0 && !fetching && (
                  <p className="col-span-full py-12 text-center text-[13px] text-ink-3">{emptyCopy}</p>
                )}
              </div>
            )}
            {loadingMore && (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(84px,1fr))] gap-2.5 pt-2.5">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="ink-shimmer aspect-square rounded-[var(--radius-sm)]" />
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex shrink-0 items-center gap-3 border-t border-rule px-5 py-3">
            {isMulti ? (
              <>
                <span className={cn("text-[12.5px] tabular-nums", atLimit ? "text-ink" : "text-ink-3")}>
                  {selectedCount} of {maxCount} selected
                </span>
                <Button variant="primary" className="ml-auto" onClick={onClose}>
                  {selectedCount > 0 ? `Use ${selectedCount}` : "Done"}
                  <Kbd>⌘↵</Kbd>
                </Button>
              </>
            ) : (
              <span className="text-[12px] text-ink-3">Click to choose. Hover for a closer look.</span>
            )}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>

      <MediaPreview
        item={previewItem}
        items={displayItems}
        selected={previewSelected}
        canSelect={!atLimit}
        onNavigate={setPreviewItem}
        onToggle={togglePreviewItem}
        onClose={closePreview}
      />
    </DialogPrimitive.Root>
  );
}
