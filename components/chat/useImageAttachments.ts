"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getToken } from "@/lib/galleryUtils";
import { useWorkflowStore } from "@/lib/store";

export const MAX_CHAT_IMAGES = 4;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** What every chat provider can read (and what local storage keeps under the right extension). */
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export interface ImageAttachment {
  id: string;
  /** What the chip shows: an object URL while uploading, the stored URL once ready. */
  src: string;
  status: "uploading" | "ready" | "failed";
  /** Stored `/generated/...` URL once uploaded. */
  url?: string;
}

export interface ImageAttachments {
  items: ImageAttachment[];
  /** Stored URLs of the uploaded images, in order. */
  urls: string[];
  uploading: boolean;
  add: (files: File[]) => void;
  remove: (id: string) => void;
  /** Replace everything with already-stored URLs (a restored draft, or [] after sending). */
  reset: (urls: string[]) => void;
}

const fromUrls = (urls: string[]): ImageAttachment[] =>
  urls.map((url) => ({ id: crypto.randomUUID(), src: url, url, status: "ready" }));

async function uploadImage(file: File): Promise<string> {
  const token = await getToken();
  const res = await fetch("/api/upload-asset", {
    method: "POST",
    headers: { "Content-Type": file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: file,
  });
  const data: { cdnUrl?: string; error?: string } = await res.json().catch(() => ({}));
  if (!res.ok || !data.cdnUrl) throw new Error(data.error ?? "Upload failed");
  return data.cdnUrl;
}

/**
 * Images attached to a chat message. Each one shows at once from an object
 * URL, uploads to local storage, then swaps to its stored `/generated/...`
 * URL; only stored URLs ever leave this hook. `onChange` hears about
 * user-made changes to the uploaded set (not `reset`), for draft saving.
 */
export function useImageAttachments(initial: string[] = [], onChange?: (urls: string[]) => void): ImageAttachments {
  const [items, setItems] = useState<ImageAttachment[]>(() => fromUrls(initial));
  const itemsRef = useRef(items);
  const objectUrls = useRef(new Set<string>());
  const onChangeRef = useRef(onChange);
  const notified = useRef(initial.join("\n"));

  useEffect(() => {
    itemsRef.current = items;
    onChangeRef.current = onChange;
  });

  const urls = useMemo(
    () => items.flatMap((i) => (i.status === "ready" && i.url ? [i.url] : [])),
    [items],
  );

  useEffect(() => {
    const key = urls.join("\n");
    if (key === notified.current) return;
    notified.current = key;
    onChangeRef.current?.(urls);
  }, [urls]);

  useEffect(() => {
    const owned = objectUrls.current;
    return () => {
      for (const u of owned) URL.revokeObjectURL(u);
      owned.clear();
    };
  }, []);

  const release = useCallback((list: ImageAttachment[]) => {
    for (const item of list) {
      if (objectUrls.current.delete(item.src)) URL.revokeObjectURL(item.src);
    }
  }, []);

  const add = useCallback((files: File[]) => {
    const addToast = useWorkflowStore.getState().addToast;
    const images = files.filter((f) => IMAGE_TYPES.includes(f.type));
    if (images.length < files.length) addToast("Only PNG, JPEG, GIF and WebP images can be attached.", "info");
    const fitting = images.filter((f) => {
      if (f.size <= MAX_IMAGE_BYTES) return true;
      addToast(`“${f.name}” is larger than 10 MB, so it wasn't attached.`, "error");
      return false;
    });
    const room = MAX_CHAT_IMAGES - itemsRef.current.length;
    if (fitting.length > room) {
      addToast(
        room > 0
          ? `A message can carry ${MAX_CHAT_IMAGES} images. Attached the first ${room}.`
          : `A message can carry ${MAX_CHAT_IMAGES} images. Remove one to add another.`,
        "info",
      );
    }
    const accepted = fitting.slice(0, Math.max(0, room));
    if (accepted.length === 0) return;

    const added: ImageAttachment[] = accepted.map((file) => {
      const src = URL.createObjectURL(file);
      objectUrls.current.add(src);
      return { id: crypto.randomUUID(), src, status: "uploading" };
    });
    itemsRef.current = [...itemsRef.current, ...added];
    setItems(itemsRef.current);

    accepted.forEach((file, i) => {
      const { id, src } = added[i];
      uploadImage(file).then(
        (url) => {
          setItems((list) => list.map((it) => (it.id === id ? { ...it, status: "ready", url, src: url } : it)));
          if (objectUrls.current.delete(src)) URL.revokeObjectURL(src);
        },
        (err: unknown) => {
          console.error("[chat] image upload failed", err);
          // Already removed (or sent / switched away): nothing to report.
          if (!itemsRef.current.some((it) => it.id === id)) return;
          setItems((list) => list.map((it) => (it.id === id ? { ...it, status: "failed" } : it)));
          addToast("An image couldn't be attached. Remove it and try again.", "error");
        },
      );
    });
  }, []);

  const remove = useCallback(
    (id: string) => {
      const gone = itemsRef.current.filter((it) => it.id === id);
      release(gone);
      itemsRef.current = itemsRef.current.filter((it) => it.id !== id);
      setItems(itemsRef.current);
    },
    [release],
  );

  const reset = useCallback(
    (next: string[]) => {
      release(itemsRef.current);
      notified.current = next.join("\n");
      itemsRef.current = fromUrls(next);
      setItems(itemsRef.current);
    },
    [release],
  );

  return { items, urls, uploading: items.some((i) => i.status === "uploading"), add, remove, reset };
}
