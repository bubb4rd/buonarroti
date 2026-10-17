"use client";
import React, { useEffect } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { GalleryItem } from "@/lib/galleryUtils";
import { Kbd } from "@/components/ui/kbd";

/**
 * Full-screen preview nested inside the picker dialog: scrim + artwork + `.on-media`
 * controls. ←/→ step through the grid, ↵ toggles selection, Esc closes (base-ui).
 */
export function MediaPreview({
  item,
  items,
  selected,
  canSelect,
  onNavigate,
  onToggle,
  onClose,
}: {
  item: GalleryItem | null;
  items: GalleryItem[];
  selected: boolean;
  canSelect: boolean;
  onNavigate: (item: GalleryItem) => void;
  onToggle: () => void;
  onClose: () => void;
}) {
  const idx = item ? items.findIndex((i) => i.id === item.id) : -1;
  const prev = idx > 0 ? items[idx - 1] : null;
  const next = idx !== -1 && idx < items.length - 1 ? items[idx + 1] : null;

  useEffect(() => {
    if (!item) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const target = e.key === "ArrowLeft" ? prev : next;
        if (target) onNavigate(target);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (selected || canSelect) onToggle();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [item, prev, next, selected, canSelect, onNavigate, onToggle, onClose]);

  const roundBtn = "on-media absolute flex items-center justify-center rounded-full transition-opacity hover:opacity-90";

  return (
    <DialogPrimitive.Root open={!!item} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          data-prompt-overlay=""
          className="fixed inset-0 z-[100001] bg-[var(--scrim)] backdrop-blur-md transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
        />
        <DialogPrimitive.Popup
          data-prompt-overlay=""
          aria-label="Preview"
          className="fixed inset-0 z-[100002] flex items-center justify-center outline-none transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          {item &&
            (item.mediaType === "video" ? (
              <video
                key={item.id}
                src={item.url}
                controls
                autoPlay
                className="max-h-[86vh] max-w-[88vw] rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)]"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={item.id}
                src={item.url}
                alt=""
                className="max-h-[86vh] max-w-[88vw] rounded-[var(--radius-lg)] object-contain shadow-[var(--shadow-lg)]"
              />
            ))}

          <DialogPrimitive.Close aria-label="Close preview" className={`${roundBtn} top-5 right-5 size-8`}>
            <X className="size-4" />
          </DialogPrimitive.Close>
          {prev && (
            <button type="button" aria-label="Previous" onClick={() => onNavigate(prev)} className={`${roundBtn} top-1/2 left-5 size-10 -translate-y-1/2`}>
              <ChevronLeft className="size-5" />
            </button>
          )}
          {next && (
            <button type="button" aria-label="Next" onClick={() => onNavigate(next)} className={`${roundBtn} top-1/2 right-5 size-10 -translate-y-1/2`}>
              <ChevronRight className="size-5" />
            </button>
          )}
          {(selected || canSelect) && (
            <button
              type="button"
              onClick={() => {
                onToggle();
                onClose();
              }}
              className="on-media absolute bottom-6 left-1/2 flex h-9 -translate-x-1/2 items-center gap-2 rounded-full px-4 text-[13px] font-medium"
            >
              {selected ? "Remove from selection" : (<><Check className="size-4" />Select</>)}
              <Kbd className="bg-white/15 text-white/80 shadow-none">↵</Kbd>
            </button>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
