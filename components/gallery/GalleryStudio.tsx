"use client";

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { QuickAssist } from "@/components/QuickAssist";
import { useFolderStore } from "@/lib/folderStore";
import { galleryCache, getToken, thumbSrc } from "@/lib/galleryUtils";
import { useWorkflowStore } from "@/lib/store";
import { useUiPref } from "@/lib/uiPrefs";
import { cn } from "@/lib/utils";
import { askAboutItem } from "./askAssistant";
import { Composer } from "./Composer";
import { DownloadToast } from "./DownloadToast";
import { EmptyState } from "./EmptyState";
import { GalleryHeader, ZOOM_MAX, ZOOM_MIN } from "./GalleryHeader";
import { GenerationGrid, GRID_GAP } from "./GenerationGrid";
import { GENERATIONS_ARRIVED, mergeByNewest, randomUUID, usePendingGenerations, type GenerationsArrivedDetail } from "./generationStore";
import { Lightbox } from "./Lightbox";
import { persistLoadedImages } from "./media";
import { SelectionBar } from "./SelectionBar";
import { useComposer } from "./useComposer";
import type { DownloadTask, GalleryItem, SourceFilter, Tab } from "./types";

const ZOOM_KEY = "aiui-gallery-zoom";

const noopSubscribe = () => () => {};
/** False during SSR and hydration, true after — everything below reads localStorage. */
const useMounted = () => useSyncExternalStore(noopSubscribe, () => true, () => false);

/** The image / video studio at /gallery?tab=images|videos&source=generated|uploaded. */
export function GalleryStudio() {
  const mounted = useMounted();
  if (!mounted) return <div className="flex-1 bg-paper" />;
  return <Studio />;
}

const cacheKeyFor = (tab: Tab, source: SourceFilter) => `${tab}-${source === "uploaded" ? "upload" : "generation"}`;

function Studio() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab: Tab = searchParams.get("tab") === "videos" ? "videos" : "images";
  const source: SourceFilter = searchParams.get("source") === "uploaded" ? "uploaded" : "generated";

  const selectedFolderId = useFolderStore(s => s.selectedFolderId);
  const folders = useFolderStore(s => s.folders);
  const itemFolderMap = useFolderStore(s => s.itemFolderMap);
  const kieKeySet = useWorkflowStore(s => s.kieKeySet);
  const allPending = usePendingGenerations(s => s.pending);

  const composer = useComposer({ tab, folderId: selectedFolderId });
  const composerCollapsed = useUiPref("composerCollapsed", false);

  const setParam = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set(key, value);
    router.replace(`${pathname}?${params.toString()}`);
  };

  // ── Items ──────────────────────────────────────────────────────────────────

  const [items, setItems] = useState<GalleryItem[]>(() => galleryCache.get(cacheKeyFor(tab, source))?.items ?? []);
  const [hasMore, setHasMore] = useState(() => galleryCache.get(cacheKeyFor(tab, source))?.hasMore ?? true);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef({ tab, source });
  const pageRef = useRef(0);
  const busyRef = useRef(false);
  const hasMoreRef = useRef(hasMore);
  useLayoutEffect(() => {
    viewRef.current = { tab, source };
    hasMoreRef.current = hasMore;
  }, [tab, source, hasMore]);

  const loadPage = useCallback(async (page: number) => {
    const { tab: t, source: s } = viewRef.current;
    const key = cacheKeyFor(t, s);
    if (page === 0) {
      const cached = galleryCache.get(key);
      if (cached) { setItems(cached.items); setHasMore(cached.hasMore); } else { setItems([]); setLoading(true); }
    } else {
      if (busyRef.current) return;
      setLoadingMore(true);
    }
    busyRef.current = true;
    try {
      const token = await getToken();
      const res = await fetch(`/api/gallery?type=${t === "videos" ? "video" : "image"}&page=${page}&source=${s === "uploaded" ? "upload" : "generation"}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: { items: GalleryItem[]; hasMore: boolean; total?: number } = await res.json();
      // The user may have switched tab/source while this was in flight.
      if (viewRef.current.tab !== t || viewRef.current.source !== s) return;
      setItems(prev => {
        const next = page === 0 ? data.items : mergeByNewest(prev, data.items);
        galleryCache.set(key, { items: next, hasMore: data.hasMore });
        return next;
      });
      setHasMore(data.hasMore);
      pageRef.current = page;
      if (typeof data.total === "number" && s === "generated") useFolderStore.getState().setGalleryCount(t, data.total);
    } catch (e) {
      console.warn("[gallery] loading items failed:", e);
      if (page === 0 && !galleryCache.get(key)) {
        useWorkflowStore.getState().addToast("Your gallery couldn't be loaded. Check that the app is running, then reload.", "error");
      }
    } finally {
      busyRef.current = false;
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  // Reload page 0 whenever the view changes (and when a key gets configured).
  useEffect(() => {
    pageRef.current = 0;
    void loadPage(0);
  }, [tab, source, kieKeySet, loadPage]);

  // Infinite scroll. Also re-checks after each load in case the page doesn't fill the viewport.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => {
      if (!hasMoreRef.current || busyRef.current) return;
      // In a folder only a few items per page match; let scrolling drive it.
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 800) void loadPage(pageRef.current + 1);
    };
    el.addEventListener("scroll", check, { passive: true });
    if (!loading && !loadingMore && !selectedFolderId) requestAnimationFrame(check);
    return () => el.removeEventListener("scroll", check);
  }, [loadPage, loading, loadingMore, hasMore, selectedFolderId]);

  // Finished generations land in the cache from the runner; pick them up here.
  const [newItemIds, setNewItemIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const onArrived = (e: Event) => {
      const { tab: t, freshIds } = (e as CustomEvent<GenerationsArrivedDetail>).detail;
      if (t !== viewRef.current.tab) return;
      if (viewRef.current.source === "generated") {
        const cached = galleryCache.get(cacheKeyFor(t, "generated"));
        if (cached) setItems(cached.items);
      }
      if (freshIds.length) setNewItemIds(prev => new Set([...prev, ...freshIds]));
    };
    window.addEventListener(GENERATIONS_ARRIVED, onArrived);
    return () => window.removeEventListener(GENERATIONS_ARRIVED, onArrived);
  }, []);

  useEffect(() => () => persistLoadedImages(), []);

  const folderScope = useMemo(() => {
    if (!selectedFolderId) return null;
    const ids = new Set<string>([selectedFolderId]);
    const queue = [selectedFolderId];
    while (queue.length) {
      const id = queue.shift()!;
      for (const f of folders) if (f.parentId === id && !ids.has(f.id)) { ids.add(f.id); queue.push(f.id); }
    }
    return ids;
  }, [selectedFolderId, folders]);

  const visibleItems = useMemo(() => {
    const bySource = items.filter(i => i.source === (source === "uploaded" ? "upload" : "generation"));
    return folderScope ? bySource.filter(i => itemFolderMap[i.id]?.some(f => folderScope.has(f))) : bySource;
  }, [items, source, folderScope, itemFolderMap]);

  const visiblePending = useMemo(
    () => source === "generated"
      ? allPending.filter(pg => (pg.tab == null || pg.tab === tab) && (!folderScope || (pg.folderId != null && folderScope.has(pg.folderId))))
      : [],
    [allPending, source, tab, folderScope],
  );

  // ── Zoom ───────────────────────────────────────────────────────────────────

  const [zoom, setZoom] = useState(() => {
    const saved = parseInt(localStorage.getItem(ZOOM_KEY) ?? "", 10);
    if (saved >= ZOOM_MIN && saved <= ZOOM_MAX) return saved;
    return window.innerWidth >= 1400 ? 6 : window.innerWidth >= 640 ? 5 : 4;
  });
  useEffect(() => { localStorage.setItem(ZOOM_KEY, String(zoom)); }, [zoom]);

  // ── Selection (click, marquee, Esc) ────────────────────────────────────────

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  // Switching medium or source starts with nothing selected.
  const [selectionView, setSelectionView] = useState(`${tab}|${source}`);
  if (selectionView !== `${tab}|${source}`) {
    setSelectionView(`${tab}|${source}`);
    setSelectedIds(new Set());
  }
  const toggleSelect = (id: string) => setSelectedIds(prev => { const s = new Set(prev); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  const clearSelection = () => setSelectedIds(new Set());
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  const preMarquee = useRef<Set<string>>(new Set());
  const dragged = useRef(false);

  useEffect(() => {
    const MIN_DRAG = 5;
    let active = false;
    const onMove = (e: MouseEvent) => {
      const start = marqueeStart.current;
      if (!start) return;
      if (!active && Math.abs(e.clientX - start.x) < MIN_DRAG && Math.abs(e.clientY - start.y) < MIN_DRAG) return;
      active = true;
      const r = { x: Math.min(start.x, e.clientX), y: Math.min(start.y, e.clientY), w: Math.abs(e.clientX - start.x), h: Math.abs(e.clientY - start.y) };
      setMarquee(r);
      const hit = new Set(preMarquee.current);
      scrollRef.current?.querySelectorAll<HTMLElement>("[data-item-id]").forEach(el => {
        const b = el.getBoundingClientRect();
        if (b.right > r.x && b.left < r.x + r.w && b.bottom > r.y && b.top < r.y + r.h) hit.add(el.dataset.itemId!);
      });
      setSelectedIds(hit);
    };
    const onUp = () => {
      marqueeStart.current = null;
      setMarquee(null);
      if (active) { dragged.current = true; setTimeout(() => { dragged.current = false; }, 80); }
      active = false;
    };
    // Swallow the click that ends a marquee drag so it doesn't open/toggle a card.
    const onClickCapture = (e: MouseEvent) => { if (dragged.current) { e.stopPropagation(); e.preventDefault(); } };
    // Native drag would steal mousemove during a marquee.
    const onDragStart = (e: DragEvent) => { if (marqueeStart.current) e.preventDefault(); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("dragstart", onDragStart, true);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("dragstart", onDragStart, true);
    };
  }, []);

  // ── Lightbox ───────────────────────────────────────────────────────────────

  const [lightbox, setLightbox] = useState<{ item: GalleryItem; thumb: string } | null>(null);
  const [ordered, setOrdered] = useState<GalleryItem[]>([]);
  const lightboxIdx = lightbox ? ordered.findIndex(i => i.id === lightbox.item.id) : -1;
  const openAt = (idx: number) => {
    const it = ordered[idx];
    if (it) setLightbox({ item: it, thumb: thumbSrc(it.imageUrls?.[0] ?? it.url, 300) });
  };

  useEffect(() => {
    if (selectedIds.size === 0 || lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "Escape" && !t.closest("input, textarea, [contenteditable]")) setSelectedIds(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds.size, lightbox]);

  // ── Downloads & deletes ────────────────────────────────────────────────────

  const [downloads, setDownloads] = useState<DownloadTask[]>([]);
  const download = useCallback(async (url: string, isVideo: boolean) => {
    const base = url.split("?")[0].split("/").pop() ?? "";
    const ext = base.split(".").pop()?.toLowerCase();
    // Characters keep their own name (dwarf.glb); media gets a timestamp.
    const filename = ext === "glb" ? base
      : `${Date.now()}.${isVideo ? "mp4" : ext && ["png", "jpg", "jpeg", "webp", "gif"].includes(ext) ? ext : "png"}`;
    const id = randomUUID();
    setDownloads(prev => [...prev, { id, filename, status: "preparing" }]);
    try {
      const res = await fetch(`/api/download?url=${encodeURIComponent(url)}&filename=${filename}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const objectUrl = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
      setDownloads(prev => prev.map(d => (d.id === id ? { ...d, status: "ready" } : d)));
    } catch (e) {
      console.warn("[gallery] download failed:", e);
      setDownloads(prev => prev.map(d => (d.id === id ? { ...d, status: "error" } : d)));
    }
  }, []);

  useEffect(() => {
    if (!downloads.length || downloads.some(d => d.status === "preparing")) return;
    const t = setTimeout(() => setDownloads([]), 4000);
    return () => clearTimeout(t);
  }, [downloads]);

  const removeItems = useCallback(async (toDelete: GalleryItem[]) => {
    if (!toDelete.length) return;
    const token = await getToken();
    const results = await Promise.all(toDelete.map(item =>
      fetch("/api/gallery", {
        method: "DELETE",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ id: item.id, source: item.source }),
      }).then(r => r.ok, () => false),
    ));
    const removed = toDelete.filter((_, i) => results[i]);
    if (removed.length < toDelete.length) {
      useWorkflowStore.getState().addToast(`${toDelete.length - removed.length} item${toDelete.length - removed.length === 1 ? "" : "s"} couldn't be removed. Try again.`, "error");
    }
    if (!removed.length) return;
    clearDeletedFromNodes(new Set(removed.flatMap(i => [i.url, ...(i.imageUrls ?? [])])));
    const ids = new Set(removed.map(i => i.id));
    setItems(prev => {
      const next = prev.filter(i => !ids.has(i.id));
      galleryCache.set(cacheKeyFor(viewRef.current.tab, viewRef.current.source), { items: next, hasMore: hasMoreRef.current });
      return next;
    });
  }, []);

  const deleteOne = useCallback((id: string) => {
    const item = items.find(i => i.id === id);
    if (item) void removeItems([item]);
  }, [items, removeItems]);

  const selectedItems = () => items.filter(i => selectedIds.has(i.id));

  // ── Render ─────────────────────────────────────────────────────────────────

  const referencedUrls = useMemo(
    () => new Set([...composer.refImages.flatMap(r => (r.cdnUrl ? [r.cdnUrl] : [])), ...composer.taggedImages.map(t => t.url)]),
    [composer.refImages, composer.taggedImages],
  );
  const isEmpty = !loading && visibleItems.length === 0 && visiblePending.length === 0;

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col overflow-hidden text-ink", isEmpty ? "fresco paper-grain" : "bg-paper")}>
      <GalleryHeader
        tab={tab}
        source={source}
        zoom={zoom}
        onTab={t => setParam("tab", t)}
        onSource={s => setParam("source", s)}
        onZoom={setZoom}
      />

      <div
        ref={scrollRef}
        className={cn("relative flex min-h-0 flex-1 flex-col overflow-y-auto", marquee && "cursor-crosshair select-none")}
        onMouseDown={e => {
          if (e.button !== 0) return;
          if ((e.target as HTMLElement).closest("button, a, input, [role=button]")) return;
          marqueeStart.current = { x: e.clientX, y: e.clientY };
          preMarquee.current = new Set(selectedIds);
        }}
      >
        {isEmpty ? (
          <EmptyState tab={tab} source={source} inFolder={!!selectedFolderId} />
        ) : (
          <div className={cn("px-8 pt-2", composerCollapsed ? "pb-[104px]" : "pb-[280px]")}>
            {loading && visibleItems.length === 0 ? (
              <SkeletonGrid columns={zoom} />
            ) : (
              <GenerationGrid
                items={visibleItems}
                pending={visiblePending}
                columns={zoom}
                scrollRef={scrollRef}
                selectedIds={selectedIds}
                focusedId={lightbox?.item.id ?? null}
                referencedUrls={referencedUrls}
                newItemIds={newItemIds}
                canAddReference={composer.canAddImgs}
                onOpen={(item, thumb) => setLightbox({ item, thumb })}
                onToggleSelect={toggleSelect}
                onAddReference={composer.addReference}
                onReuse={composer.reuse}
                onAskAssistant={askAboutItem}
                onDownload={download}
                onDelete={deleteOne}
                onMarkSeen={id => setNewItemIds(prev => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; })}
                onOrderChange={setOrdered}
              />
            )}
            {loadingMore && (
              <div className="flex justify-center py-6 text-[12.5px] text-ink-3">Loading more…</div>
            )}
          </div>
        )}
      </div>

      {marquee && (
        <div
          className="pointer-events-none fixed z-[9999] rounded-[3px] bg-lapis-soft shadow-[inset_0_0_0_1.5px_var(--lapis)]"
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}

      <SelectionBar
        selectedIds={selectedIds}
        items={items}
        onClear={clearSelection}
        onDownload={async () => {
          const toDownload = selectedItems();
          clearSelection();
          for (const item of toDownload) await download(item.modelUrl ?? item.url, item.mediaType === "video");
        }}
        onRemove={() => {
          const toDelete = selectedItems();
          clearSelection();
          void removeItems(toDelete);
        }}
      />

      <Composer c={composer} hidden={selectedIds.size > 0} />

      {lightbox && (
        <Lightbox
          item={lightbox.item}
          thumbUrl={lightbox.thumb}
          onClose={() => setLightbox(null)}
          onReuse={composer.reuse}
          onAskAssistant={askAboutItem}
          onDownload={download}
          onPrev={lightboxIdx > 0 ? () => openAt(lightboxIdx - 1) : undefined}
          onNext={lightboxIdx >= 0 && lightboxIdx < ordered.length - 1 ? () => openAt(lightboxIdx + 1) : undefined}
        />
      )}

      <DownloadToast downloads={downloads} onClear={() => setDownloads([])} />
      <QuickAssist />
    </div>
  );
}

function SkeletonGrid({ columns }: { columns: number }) {
  return (
    <div className="grid items-start" style={{ gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: GRID_GAP }}>
      {Array.from({ length: columns * 3 }).map((_, i) => (
        <div
          key={i}
          className="ink-shimmer rounded-[var(--radius-sm)]"
          style={{ aspectRatio: i % 3 === 1 ? "4 / 5" : i % 5 === 0 ? "16 / 9" : "1 / 1" }}
        />
      ))}
    </div>
  );
}

/** Generations deleted here are also removed from any canvas node history that showed them. */
function clearDeletedFromNodes(deletedUrls: Set<string>) {
  const { nodes, updateNodeData } = useWorkflowStore.getState();
  for (const node of nodes) {
    const gens = (node.data.generations as (string | null | { error: string })[]) ?? [];
    const filtered = gens.filter(g => !(typeof g === "string" && deletedUrls.has(g)));
    if (filtered.length === gens.length) continue;
    const idx = Math.max(0, Math.min((node.data.currentGenIdx as number | undefined) ?? 0, filtered.length - 1));
    const current = filtered[idx];
    const url = typeof current === "string" ? current : undefined;
    updateNodeData(node.id, {
      generations: filtered,
      currentGenIdx: filtered.length ? idx : 0,
      ...(node.type === "videoGeneratorNode" ? { videoUrl: url } : { imageUrl: url }),
      status: filtered.length ? "done" : "idle",
    });
  }
}
