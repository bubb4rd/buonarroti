"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { GenerationCard } from "./GenerationCard";
import { naturalRatioCache, parseRatio, persistNaturalRatios } from "./media";
import { PendingTile } from "./PendingTile";
import type { GalleryItem, PendingGen, ReusePromptFn } from "./types";

export const GRID_GAP = 8;

type Cell =
  | { kind: "pending"; pg: PendingGen; ratio: number; width: number }
  | { kind: "gallery"; item: GalleryItem; ratio: number; width: number };
type Row = { cells: Cell[]; height: number; empty: number };

function itemRatio(item: GalleryItem): number {
  return parseRatio(item.aspect_ratio) ?? parseRatio(naturalRatioCache.get(item.url)) ?? (item.mediaType === "video" ? 16 / 9 : 4 / 3);
}

/**
 * Orders in-flight generations first, then failed ones mixed with finished
 * items by date, and packs them `columns` to a row. Full rows fill the width at
 * a shared height; the last partial row keeps the column width.
 */
export function layoutRows(items: GalleryItem[], pending: PendingGen[], columns: number, width: number): Row[] {
  if (width <= 0) return [];
  const running = pending.filter(pg => !pg.error && !pg.retried);
  const mixed = [
    ...pending.filter(pg => pg.error || pg.retried).map(pg => ({ t: pg.createdAt ? Date.parse(pg.createdAt) : Date.now(), cell: pendingCell(pg) })),
    ...items.map(item => ({ t: Date.parse(item.created_at), cell: { kind: "gallery" as const, item, ratio: itemRatio(item), width: 0 } })),
  ].sort((a, b) => b.t - a.t);
  const cells: Cell[] = [...running.map(pendingCell), ...mixed.map(m => m.cell)];

  const rows: Row[] = [];
  const colWidth = (width - (columns - 1) * GRID_GAP) / columns;
  for (let i = 0; i < cells.length; i += columns) {
    const group = cells.slice(i, i + columns);
    if (group.length === columns) {
      const ratioSum = group.reduce((s, c) => s + c.ratio, 0);
      const avail = width - (group.length - 1) * GRID_GAP;
      rows.push({ cells: group.map(c => ({ ...c, width: (avail * c.ratio) / ratioSum })), height: avail / ratioSum, empty: 0 });
    } else {
      const avgRatio = group.reduce((s, c) => s + c.ratio, 0) / group.length;
      rows.push({ cells: group.map(c => ({ ...c, width: colWidth })), height: colWidth / avgRatio, empty: columns - group.length });
    }
  }
  return rows;
}

function pendingCell(pg: PendingGen): Cell {
  return { kind: "pending", pg, ratio: parseRatio(pg.aspectRatio) ?? 16 / 9, width: 0 };
}

export function GenerationGrid({
  items,
  pending,
  columns,
  scrollRef,
  selectedIds,
  focusedId,
  referencedUrls,
  newItemIds,
  canAddReference,
  onOpen,
  onToggleSelect,
  onAddReference,
  onReuse,
  onAskAssistant,
  onDownload,
  onDelete,
  onMarkSeen,
  onOrderChange,
}: {
  items: GalleryItem[];
  pending: PendingGen[];
  columns: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  selectedIds: Set<string>;
  focusedId: string | null;
  /** URLs currently attached in the composer; those cards get a lapis ring. */
  referencedUrls: Set<string>;
  newItemIds: Set<string>;
  canAddReference: boolean;
  onOpen: (item: GalleryItem, thumbUrl: string) => void;
  onToggleSelect: (id: string) => void;
  onAddReference: (url: string) => void;
  onReuse: ReusePromptFn;
  onAskAssistant: (item: GalleryItem, shownUrl: string) => void;
  onDownload: (url: string, isVideo: boolean) => void;
  onDelete: (id: string, source: "generation" | "upload") => void;
  onMarkSeen: (id: string) => void;
  /** Visual order of finished items (for lightbox prev/next). */
  onOrderChange: (ordered: GalleryItem[]) => void;
}) {
  const measureRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [ratioVersion, setRatioVersion] = useState(0);
  const [videoMuted, setVideoMuted] = useState(true);
  const anySelected = selectedIds.size > 0;

  useEffect(() => {
    const el = measureRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  // Probe media without a stored ratio so the layout settles on real shapes.
  useEffect(() => {
    const toProbe = items.filter(i => !parseRatio(i.aspect_ratio) && !naturalRatioCache.has(i.url));
    if (!toProbe.length) return;
    let cancelled = false;
    const found = (url: string, ratio: string) => {
      naturalRatioCache.set(url, ratio);
      if (!cancelled) setRatioVersion(v => v + 1);
    };
    for (const item of toProbe) {
      if (item.mediaType === "video") {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.onloadedmetadata = () => found(item.url, v.videoWidth && v.videoHeight ? `${v.videoWidth} / ${v.videoHeight}` : "16 / 9");
        v.onerror = () => found(item.url, "16 / 9");
        v.src = item.url;
      } else {
        const img = new window.Image();
        img.onload = () => found(item.url, img.naturalWidth && img.naturalHeight ? `${img.naturalWidth} / ${img.naturalHeight}` : "4 / 3");
        img.onerror = () => found(item.url, "4 / 3");
        img.src = item.imageUrls?.[0] ?? item.url;
      }
    }
    return () => { cancelled = true; };
  }, [items]);

  useEffect(() => { if (ratioVersion) persistNaturalRatios(); }, [ratioVersion]);

  const rows = useMemo(() => layoutRows(items, pending, columns, width), [items, pending, columns, width, ratioVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const ordered = useMemo(() => rows.flatMap(r => r.cells).flatMap(c => (c.kind === "gallery" ? [c.item] : [])), [rows]);
  useEffect(() => { onOrderChange(ordered); }, [ordered]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={measureRef} className="w-full">
      {rows.map((row, i) => (
        <div key={i} className="flex" style={{ height: row.height, gap: GRID_GAP, marginBottom: i < rows.length - 1 ? GRID_GAP : 0 }}>
          {row.cells.map(cell => {
            if (cell.kind === "pending") {
              return (
                <div key={cell.pg.id} className="h-full shrink-0" style={{ width: cell.width }}>
                  <PendingTile pg={cell.pg} onReuse={onReuse} />
                </div>
              );
            }
            const item = cell.item;
            const selected = selectedIds.has(item.id);
            return (
              <div
                key={item.id}
                data-item-id={item.id}
                className={cn(
                  "h-full shrink-0",
                  (selected || focusedId === item.id) && "crop-marks [--crop-gap:4px] [--crop:10px]",
                  selected && "[--crop-color:var(--lapis)]",
                )}
                style={{ width: cell.width }}
              >
                <GenerationCard
                  item={item}
                  displayWidth={cell.width}
                  onOpen={thumb => onOpen(item, thumb)}
                  onAddReference={item.mediaType === "image" && canAddReference ? onAddReference : undefined}
                  onReuse={onReuse}
                  onAskAssistant={shownUrl => onAskAssistant(item, shownUrl)}
                  onDownload={onDownload}
                  onDelete={onDelete}
                  videoMuted={videoMuted}
                  onToggleMute={() => setVideoMuted(m => !m)}
                  onNaturalRatioDiscovered={() => setRatioVersion(v => v + 1)}
                  selected={selected}
                  anySelected={anySelected}
                  onSelect={() => onToggleSelect(item.id)}
                  scrollContainer={scrollRef}
                  isTagged={referencedUrls.has(item.url)}
                  isNew={newItemIds.has(item.id)}
                  onMarkSeen={() => onMarkSeen(item.id)}
                />
              </div>
            );
          })}
          {Array.from({ length: row.empty }).map((_, j) => (
            <div key={`empty-${j}`} className="h-full shrink-0" style={{ width: row.cells[0]?.width ?? 0 }} />
          ))}
        </div>
      ))}
    </div>
  );
}
