"use client";

import { Image as ImageIcon, Upload, Video, ZoomIn, ZoomOut } from "lucide-react";
import { Segmented } from "@/components/ui/segmented";
import { useFolderStore } from "@/lib/folderStore";
import type { SourceFilter, Tab } from "./types";

export const ZOOM_MIN = 4;
export const ZOOM_MAX = 8;

/**
 * Studio header: serif title (or the open folder's path), the item count, and
 * the switches for medium, source and grid density.
 */
export function GalleryHeader({
  tab,
  source,
  zoom,
  onTab,
  onSource,
  onZoom,
}: {
  tab: Tab;
  source: SourceFilter;
  zoom: number;
  onTab: (t: Tab) => void;
  onSource: (s: SourceFilter) => void;
  onZoom: (z: number) => void;
}) {
  const selectedFolderId = useFolderStore(s => s.selectedFolderId);
  const folders = useFolderStore(s => s.folders);
  const count = useFolderStore(s => (tab === "videos" ? s.galleryVideoCount : s.galleryImageCount));

  const path: string[] = [];
  for (let f = folders.find(x => x.id === selectedFolderId); f; f = f.parentId ? folders.find(x => x.id === f!.parentId) : undefined) {
    path.unshift(f.name);
  }
  const title = path.length ? path[path.length - 1] : "Studio";
  const noun = tab === "videos" ? (count === 1 ? "video" : "videos") : count === 1 ? "image" : "images";

  return (
    <header className="titlebar-drag relative z-[1] flex shrink-0 flex-wrap items-end justify-between gap-x-6 gap-y-3 px-8 pt-7 pb-4">
      <div className="min-w-0">
        {path.length > 1 && (
          <div className="mb-1 truncate text-[12.5px] text-ink-3">{path.slice(0, -1).join(" / ")}</div>
        )}
        <h1 className="type-title truncate text-ink">{title}</h1>
        {!path.length && count > 0 && source === "generated" && (
          <p className="mt-1 text-[12.5px] text-ink-3">
            <span className="tabular-nums">{count.toLocaleString()}</span> {noun}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Tab>
          aria-label="Medium"
          value={tab}
          onChange={onTab}
          options={[
            { value: "images", label: "Images", icon: <ImageIcon /> },
            { value: "videos", label: "Video", icon: <Video /> },
          ]}
        />
        <Segmented<SourceFilter>
          aria-label="Source"
          value={source}
          onChange={onSource}
          options={[
            { value: "generated", label: "Generated" },
            { value: "uploaded", label: "Uploaded", icon: <Upload /> },
          ]}
        />
        <label className="ml-1 flex h-8 items-center gap-2 text-ink-3" title="Grid size">
          <ZoomOut className="size-3.5" strokeWidth={1.75} />
          <input
            type="range"
            aria-label="Grid size"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={1}
            value={ZOOM_MIN + ZOOM_MAX - zoom}
            onChange={e => onZoom(ZOOM_MIN + ZOOM_MAX - Number(e.target.value))}
            className="h-1 w-[84px] cursor-pointer accent-[var(--ink-2)]"
          />
          <ZoomIn className="size-3.5" strokeWidth={1.75} />
        </label>
      </div>
    </header>
  );
}
