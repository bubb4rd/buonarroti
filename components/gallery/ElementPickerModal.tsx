"use client";

import * as React from "react";
import { AlertCircle, Check, ChevronLeft, Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { getToken } from "@/lib/galleryUtils";
import { cn } from "@/lib/utils";
import type { KlingElement } from "./types";

/** Saved Kling elements live in localStorage under this key. */
const ELEMENTS_KEY = "nf-kling-elements";
/** Kling accepts at most three elements per generation. */
const MAX_ATTACHED = 3;
const MAX_IMAGES = 4;
const MIN_IMAGES = 2;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function loadKlingElements(): KlingElement[] {
  if (typeof window === "undefined") return [];
  try { const r = localStorage.getItem(ELEMENTS_KEY); return r ? (JSON.parse(r) as KlingElement[]) : []; } catch { return []; }
}

function saveKlingElements(elements: KlingElement[]) {
  if (typeof window === "undefined") return;
  try { localStorage.setItem(ELEMENTS_KEY, JSON.stringify(elements)); } catch { }
}

function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

interface DraftImage {
  id: string;
  objectUrl: string;
  cdnUrl: string | null;
  uploading: boolean;
  error: boolean;
}

export interface ElementPickerModalProps {
  open: boolean;
  attached: KlingElement[];
  onClose: () => void;
  onAttach: (el: KlingElement) => void;
}

/** Browse saved Kling elements, or create one from 2–4 reference images. */
export function ElementPickerModal({ open, attached, onClose, onAttach }: ElementPickerModalProps) {
  const [view, setView] = React.useState<"browse" | "create">("browse");
  const [elements, setElements] = React.useState<KlingElement[]>([]);

  const [createName, setCreateName] = React.useState("");
  const [createDesc, setCreateDesc] = React.useState("");
  const [createImages, setCreateImages] = React.useState<DraftImage[]>([]);
  const [creating, setCreating] = React.useState(false);
  const createFileRef = React.useRef<HTMLInputElement>(null);

  // Each time the picker opens: fresh list from storage, empty create form.
  const [wasOpen, setWasOpen] = React.useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setView("browse");
      setElements(loadKlingElements());
      setCreateName("");
      setCreateDesc("");
      setCreateImages([]);
      setCreating(false);
    }
  }

  const handleDeleteElement = (id: string) => {
    const updated = elements.filter(e => e.id !== id);
    setElements(updated);
    saveKlingElements(updated);
  };

  const handleCreateImages = async (files: FileList) => {
    const remaining = MAX_IMAGES - createImages.length;
    const toAdd = Array.from(files).slice(0, remaining).filter(
      f => (f.type === "image/jpeg" || f.type === "image/png") && f.size <= MAX_IMAGE_BYTES
    );
    if (!toAdd.length) return;
    const newEntries: DraftImage[] = toAdd.map(f => ({
      id: randomUUID(),
      objectUrl: URL.createObjectURL(f),
      cdnUrl: null,
      uploading: true,
      error: false,
    }));
    setCreateImages(prev => [...prev, ...newEntries]);
    const token = await getToken();
    await Promise.all(toAdd.map(async (file, i) => {
      const entry = newEntries[i];
      try {
        const res = await fetch("/api/upload-asset", {
          method: "POST",
          headers: { "Content-Type": file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: file,
        });
        const data = await res.json() as { cdnUrl?: string; error?: string };
        if (!res.ok || !data.cdnUrl) throw new Error(data.error ?? "Upload failed");
        setCreateImages(prev => prev.map(e => e.id === entry.id ? { ...e, cdnUrl: data.cdnUrl!, uploading: false } : e));
      } catch {
        setCreateImages(prev => prev.map(e => e.id === entry.id ? { ...e, uploading: false, error: true } : e));
      }
    }));
  };

  const readyImages = createImages.filter(e => e.cdnUrl && !e.error);
  const canCreate = createName.trim().length > 0
    && readyImages.length >= MIN_IMAGES
    && !createImages.some(e => e.uploading)
    && !creating;

  const handleCreate = () => {
    if (!canCreate) return;
    setCreating(true);
    const newEl: KlingElement = {
      id: randomUUID(),
      name: createName.trim(),
      description: createDesc.trim(),
      imageUrls: readyImages.map(e => e.cdnUrl!),
    };
    saveKlingElements([...loadKlingElements(), newEl]);
    createImages.forEach(e => URL.revokeObjectURL(e.objectUrl));
    onAttach(newEl);
  };

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent
        data-element-picker-modal=""
        data-composer-popup=""
        className="w-[min(92vw,560px)]"
      >
        <DialogHeader className={cn(view === "create" && "flex-row items-start gap-2")}>
          {view === "create" && (
            <Button variant="ghost" size="icon-sm" aria-label="Back to elements" className="-ml-1.5 mt-0.5" onClick={() => setView("browse")}>
              <ChevronLeft aria-hidden />
            </Button>
          )}
          <div className="flex flex-col gap-1">
            <DialogTitle>{view === "browse" ? "Elements" : "New element"}</DialogTitle>
            <DialogDescription>
              {view === "browse"
                ? `Attach up to ${MAX_ATTACHED} saved characters or objects to your prompt.`
                : "Two to four images of the same subject, JPG or PNG, up to 10 MB each."}
            </DialogDescription>
          </div>
        </DialogHeader>

        {view === "browse" ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-6">
            <div className="grid grid-cols-4 gap-2.5">
              <button
                type="button"
                onClick={() => setView("create")}
                className="flex aspect-square flex-col items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed border-rule-strong text-ink-3 transition-colors duration-150 outline-none hover:border-ink/30 hover:bg-wash hover:text-ink focus-visible:shadow-[var(--focus-ring)]"
              >
                <span className="flex size-8 items-center justify-center rounded-full bg-wash-strong">
                  <Plus aria-hidden className="size-3.5" strokeWidth={2.25} />
                </span>
                <span className="text-[12px] font-medium">New element</span>
              </button>

              {elements.map(el => {
                const isAttached = attached.some(a => a.id === el.id);
                const atMax = attached.length >= MAX_ATTACHED && !isAttached;
                return (
                  <div key={el.id} className="relative aspect-square">
                    <button
                      type="button"
                      onClick={() => { if (!isAttached && !atMax) onAttach(el); }}
                      disabled={isAttached || atMax}
                      aria-pressed={isAttached}
                      aria-label={isAttached ? `${el.name}, attached` : `Attach ${el.name}`}
                      className={cn(
                        "relative block size-full overflow-hidden rounded-[var(--radius)] bg-mat ring-2 ring-transparent transition-[box-shadow,opacity] duration-150 outline-none focus-visible:ring-lapis",
                        isAttached ? "ring-lapis" : atMax ? "opacity-40" : "hover:ring-ink/25",
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={el.imageUrls[0]} alt="" className="block size-full object-cover" />
                      {el.imageUrls.length > 1 && (
                        <span className="absolute top-1.5 left-1.5 rounded-[var(--radius-xs)] bg-black/45 px-1.5 text-[10.5px] leading-4 font-semibold text-white tabular-nums backdrop-blur-md">
                          {el.imageUrls.length}
                        </span>
                      )}
                      <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-1.5 pt-4 pr-7 pb-1.5 text-left">
                        <span className="block truncate text-[11.5px] font-medium text-white">{el.name}</span>
                      </span>
                      {isAttached && (
                        <span className="absolute top-1.5 right-1.5 flex size-5 items-center justify-center rounded-full bg-lapis text-lapis-ink">
                          <Check aria-hidden className="size-3" strokeWidth={3} />
                        </span>
                      )}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${el.name}`}
                      onClick={e => { e.stopPropagation(); handleDeleteElement(el.id); }}
                      className="absolute right-1.5 bottom-1.5 z-[2] flex size-5 items-center justify-center rounded-full bg-black/45 text-white/80 backdrop-blur-md transition-colors duration-100 hover:bg-sanguine hover:text-white"
                    >
                      <X aria-hidden className="size-2.5" strokeWidth={3} />
                    </button>
                  </div>
                );
              })}

              {elements.length === 0 && (
                <p className="col-span-full py-8 text-center text-[13px] text-ink-3">
                  Nothing here yet. Your first element will appear here.
                </p>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-2 pb-6">
              <div className="flex flex-col gap-2">
                <span className="type-label">Images</span>
                <div className="flex flex-wrap gap-2">
                  {createImages.map((img, i) => (
                    <div
                      key={img.id}
                      title={img.error ? "Upload failed. Remove it and try again." : undefined}
                      className={cn(
                        "relative size-[72px] shrink-0 overflow-hidden rounded-[var(--radius)] bg-mat",
                        img.error ? "ring-2 ring-sanguine" : "shadow-[inset_0_0_0_1px_var(--rule)]",
                      )}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={img.objectUrl}
                        alt=""
                        className={cn("block size-full object-cover", img.uploading && "animate-pulse opacity-50")}
                      />
                      {img.error && (
                        <span className="absolute inset-0 flex items-center justify-center bg-black/45">
                          <AlertCircle aria-label="Upload failed" className="size-4 text-white" />
                        </span>
                      )}
                      <button
                        type="button"
                        aria-label="Remove image"
                        onClick={() => setCreateImages(prev => { URL.revokeObjectURL(img.objectUrl); return prev.filter((_, j) => j !== i); })}
                        className="absolute top-1 right-1 flex size-4 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md hover:bg-black/65"
                      >
                        <X aria-hidden className="size-2.5" strokeWidth={3} />
                      </button>
                    </div>
                  ))}
                  {createImages.length < MAX_IMAGES && (
                    <button
                      type="button"
                      onClick={() => createFileRef.current?.click()}
                      className="flex size-[72px] shrink-0 flex-col items-center justify-center gap-1 rounded-[var(--radius)] border border-dashed border-rule-strong text-ink-3 transition-colors duration-150 outline-none hover:border-ink/30 hover:bg-wash hover:text-ink focus-visible:shadow-[var(--focus-ring)]"
                    >
                      <Plus aria-hidden className="size-4" strokeWidth={2.25} />
                      <span className="text-[11.5px] font-medium">Add</span>
                    </button>
                  )}
                </div>
                <input
                  ref={createFileRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  multiple
                  className="hidden"
                  onChange={e => { if (e.target.files) { handleCreateImages(e.target.files); e.target.value = ""; } }}
                />
              </div>

              <label className="flex flex-col gap-2">
                <span className="type-label">Name</span>
                <Input
                  value={createName}
                  onChange={e => setCreateName(e.target.value)}
                  placeholder="Element name"
                  maxLength={50}
                />
              </label>

              <label className="flex flex-col gap-2">
                <span className="type-label">Description</span>
                <Textarea
                  value={createDesc}
                  onChange={e => setCreateDesc(e.target.value)}
                  placeholder="Describe this element…"
                  rows={3}
                  maxLength={500}
                />
              </label>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setView("browse")}>Cancel</Button>
              <Button variant="primary" onClick={handleCreate} disabled={!canCreate}>
                {creating ? "Creating…" : "Create element"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
