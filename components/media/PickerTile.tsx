"use client";
import React, { useRef, useState } from "react";
import { Check, Maximize2, Play } from "lucide-react";
import { GalleryItem, thumbSrc } from "@/lib/galleryUtils";
import { cn } from "@/lib/utils";

function PickerImage({ src }: { src: string }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  return (
    <div className="absolute inset-0">
      {status === "loading" && <div className="ink-shimmer absolute inset-0" />}
      {status !== "error" && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt=""
          src={thumbSrc(src)}
          loading="lazy"
          decoding="async"
          onLoad={() => setStatus("loaded")}
          onError={() => setStatus("error")}
          className={cn(
            "absolute inset-0 size-full object-cover transition-opacity duration-200",
            status === "loaded" ? "opacity-100" : "opacity-0"
          )}
        />
      )}
    </div>
  );
}

/** One artwork in the picker grid: mat ground, crop marks + lapis check when selected. */
export function PickerTile({
  item,
  selected,
  disabled,
  onToggle,
  onPreview,
}: {
  item: GalleryItem;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
  onPreview: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const isVideo = item.mediaType === "video";

  return (
    <div
      className={cn(
        "group/tile relative aspect-square",
        selected && "crop-marks [--crop-color:var(--lapis)] [--crop-gap:3px] [--crop:9px]"
      )}
      onMouseEnter={() => {
        if (!disabled) videoRef.current?.play().catch(() => {});
      }}
      onMouseLeave={() => {
        const v = videoRef.current;
        if (v) {
          v.pause();
          v.currentTime = 0;
        }
      }}
    >
      <button
        type="button"
        aria-pressed={selected}
        aria-disabled={disabled || undefined}
        aria-label={isVideo ? "Video" : "Image"}
        onClick={() => {
          if (!disabled || selected) onToggle();
        }}
        className={cn(
          "relative block size-full overflow-hidden rounded-[var(--radius-sm)] bg-mat outline-none transition-[opacity,box-shadow,transform] duration-150 ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]",
          selected ? "shadow-[0_0_0_2px_var(--lapis)]" : "hover:shadow-[var(--shadow-md)]",
          disabled ? "cursor-not-allowed opacity-35" : "cursor-pointer"
        )}
      >
        {isVideo ? (
          <video
            ref={videoRef}
            src={item.url}
            muted
            playsInline
            preload="metadata"
            className="block size-full object-cover"
            onLoadedMetadata={(e) => {
              e.currentTarget.currentTime = 0.001;
            }}
          />
        ) : (
          <PickerImage src={item.url} />
        )}
        {isVideo && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover/tile:opacity-0">
            <span className="on-media flex size-6 items-center justify-center rounded-full">
              <Play className="size-2.5 fill-current" strokeWidth={0} />
            </span>
          </span>
        )}
      </button>

      {selected && (
        <span className="pointer-events-none absolute bottom-1 left-1 flex size-[18px] items-center justify-center rounded-full bg-lapis text-lapis-ink shadow-[var(--shadow-sm)]">
          <Check className="size-3" strokeWidth={3} />
        </span>
      )}

      {!disabled && (
        <button
          type="button"
          aria-label="Preview"
          onClick={onPreview}
          className="on-media absolute top-1 right-1 flex size-5 items-center justify-center rounded-[var(--radius-xs)] opacity-0 transition-opacity duration-150 group-hover/tile:opacity-100 focus-visible:opacity-100"
        >
          <Maximize2 className="size-2.5" />
        </button>
      )}
    </div>
  );
}
