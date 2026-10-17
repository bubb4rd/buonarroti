"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GalleryItem, galleryCache, getToken } from "@/lib/galleryUtils";

export type PickerTabId = "uploads" | "image-gen" | "video-gen";

function mergeByNewest(prev: GalleryItem[], incoming: GalleryItem[]): GalleryItem[] {
  const seen = new Set(prev.map(i => i.id));
  const brandNew = incoming.filter(i => !seen.has(i.id));
  if (brandNew.length === 0) return prev;
  return [...prev, ...brandNew].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

/** Whatever the gallery already has in memory for this kind, newest first. */
function readCachedItems(mediaKind: "image" | "video" | "any"): GalleryItem[] {
  const tabs = mediaKind === "any" ? ["images", "videos"] : [mediaKind === "image" ? "images" : "videos"];
  return tabs
    .flatMap((tab) => [
      ...(galleryCache.get(`${tab}-generation`)?.items ?? []),
      ...(galleryCache.get(`${tab}-upload`)?.items ?? []),
    ])
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

/**
 * The picker's media source: seeds from the gallery cache, fetches page 0 on open,
 * then pages in more as `scrollContainerRef` nears the bottom.
 */
export function useMediaLibrary({
  open,
  mediaKind,
  activeTab,
}: {
  open: boolean;
  mediaKind: "image" | "video" | "any";
  activeTab: PickerTabId;
}) {
  const [sourceItems, setSourceItems] = useState<GalleryItem[]>([]);
  const [fetching, setFetching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const imagePageRef = useRef(0);
  const videoPageRef = useRef(0);
  const imageHasMoreRef = useRef(true);
  const videoHasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

    const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    const needsImg = (mediaKind === "image" || mediaKind === "any") && imageHasMoreRef.current;
    const needsVid = (mediaKind === "video" || mediaKind === "any") && videoHasMoreRef.current;
    if (!needsImg && !needsVid) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const token = await getToken();
      if (!token) return;
      const fetches: Promise<void>[] = [];
      if (needsImg) {
        const nextPage = imagePageRef.current + 1;
        fetches.push(
          fetch(`/api/gallery?type=image&page=${nextPage}`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.ok ? r.json() as Promise<{ items: GalleryItem[]; hasMore: boolean }> : null)
            .then(data => {
              if (!data) return;
              imageHasMoreRef.current = data.hasMore;
              imagePageRef.current = nextPage;
              setSourceItems(prev => mergeByNewest(prev, data.items));
            })
        );
      }
      if (needsVid) {
        const nextPage = videoPageRef.current + 1;
        fetches.push(
          fetch(`/api/gallery?type=video&page=${nextPage}`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.ok ? r.json() as Promise<{ items: GalleryItem[]; hasMore: boolean }> : null)
            .then(data => {
              if (!data) return;
              videoHasMoreRef.current = data.hasMore;
              videoPageRef.current = nextPage;
              setSourceItems(prev => mergeByNewest(prev, data.items));
            })
        );
      }
      await Promise.all(fetches);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [mediaKind]);

  /* Seed from the gallery cache as soon as the picker opens (or its kind changes),
     during render rather than in an effect so the first open frame isn't empty. */
  const session = open ? mediaKind : null;
  const [seededSession, setSeededSession] = useState<typeof session>(null);
  if (session !== seededSession) {
    setSeededSession(session);
    if (session) {
      setSourceItems(readCachedItems(session));
      setFetching(true);
    }
  }

  useEffect(() => {
    if (!open) return;

    // Reset pagination
    imagePageRef.current = 0;
    videoPageRef.current = 0;
    imageHasMoreRef.current = true;
    videoHasMoreRef.current = true;
    loadingMoreRef.current = false;

    (async () => {
      const token = await getToken();
      if (!token) { setFetching(false); return; }

      if (mediaKind === "any") {
        const [imgRes, vidRes] = await Promise.all([
          fetch("/api/gallery?type=image&page=0", { headers: { Authorization: `Bearer ${token}` } }),
          fetch("/api/gallery?type=video&page=0", { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        const [imgData, vidData] = await Promise.all([
          imgRes.ok ? (imgRes.json() as Promise<{ items: GalleryItem[]; hasMore: boolean }>) : Promise.resolve({ items: [] as GalleryItem[], hasMore: false }),
          vidRes.ok ? (vidRes.json() as Promise<{ items: GalleryItem[]; hasMore: boolean }>) : Promise.resolve({ items: [] as GalleryItem[], hasMore: false }),
        ]);
        imageHasMoreRef.current = imgData.hasMore;
        videoHasMoreRef.current = vidData.hasMore;
        setSourceItems(prev => mergeByNewest(prev, [...imgData.items, ...vidData.items]));
      } else {
        const res = await fetch(`/api/gallery?type=${mediaKind}&page=0`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const data = await res.json() as { items: GalleryItem[]; hasMore: boolean };
          if (mediaKind === "image") imageHasMoreRef.current = data.hasMore;
          else videoHasMoreRef.current = data.hasMore;
          setSourceItems(prev => mergeByNewest(prev, data.items));
        }
      }
      setFetching(false);
    })();
  }, [open, mediaKind]);

  // Infinite scroll for the picker
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el || !open) return;

    const checkAndLoad = () => {
      if (loadingMoreRef.current) return;
      const needsImg = (mediaKind === "image" || mediaKind === "any") && imageHasMoreRef.current;
      const needsVid = (mediaKind === "video" || mediaKind === "any") && videoHasMoreRef.current;
      if (!needsImg && !needsVid) return;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 300) {
        loadMore();
      }
    };

    el.addEventListener("scroll", checkAndLoad, { passive: true });
    return () => el.removeEventListener("scroll", checkAndLoad);
  }, [open, mediaKind, loadMore, loadingMore]);

  const displayItems = useMemo(() => {
    if (activeTab === "uploads")   return sourceItems.filter((i) => i.source === "upload");
    if (activeTab === "image-gen") return sourceItems.filter((i) => i.source === "generation" && i.mediaType === "image");
    return sourceItems.filter((i) => i.source === "generation" && i.mediaType === "video");
  }, [activeTab, sourceItems]);

  return { displayItems, fetching, loadingMore, scrollContainerRef };
}
