"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import NextImage from "next/image";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Copy,
  Download,
  Ellipsis,
  ImageIcon,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useWorkflowStore } from "@/lib/store";
import type { Space } from "@/lib/store";
import { makeUGCTemplate } from "@/lib/templates";
import { timeAgo } from "@/lib/useSpaceSync";
import { workflowActivity } from "@/lib/workflowActivity";
import { StatusChip } from "@/components/nodes/JobSlot";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Segmented } from "@/components/ui/segmented";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const TEMPLATE_NAME = "UGC Template";

type SortKey = "recent" | "name";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Recent" },
  { value: "name", label: "Name" },
];

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-5";

/** Card shell shared by workflow and template cards. */
const CARD =
  "group/card relative flex flex-col gap-3 rounded-[var(--radius-lg)] bg-surface p-2.5 pb-3.5 text-left transition-shadow duration-200 ease-[var(--ease-out)]";

/** Crop marks that register around a card's frame on hover, and in lapis on keyboard focus. */
const FRAME_MARKS =
  "crop-marks block [--crop:10px] [--crop-gap:5px] [--crop-color:transparent]! group-hover/card:[--crop-color:var(--ink-3)]! group-has-[:focus-visible]/card:[--crop-color:var(--lapis)]!";

const FRAME = "relative block aspect-[3/2] overflow-hidden rounded-[var(--radius)] bg-mat";

// ── Media ─────────────────────────────────────────────────────────────────────

type MediaItem = { type: "image" | "video"; url: string };

function collectMedia(space: Space): MediaItem[] {
  const items: MediaItem[] = [];
  for (const node of space.nodes) {
    const { r2Url, imageUrl, videoUrl } = node.data;
    if (typeof videoUrl === "string" && videoUrl) {
      items.push({ type: "video", url: videoUrl });
    } else if (typeof r2Url === "string" && r2Url) {
      items.push({ type: "image", url: r2Url });
    } else if (typeof imageUrl === "string" && imageUrl) {
      items.push({ type: "image", url: imageUrl });
    }
  }
  return items;
}

/** Up to four pieces, laid out to fill the frame: 1 full, 2 side by side, 3 with a lead, 4 in a grid. */
function Mosaic({ media }: { media: MediaItem[] }) {
  const items = media.slice(0, 4);
  if (items.length === 0) {
    return (
      <span className="absolute inset-0 grid place-items-center text-ink-4">
        <ImageIcon className="size-5" strokeWidth={1.5} />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "absolute inset-0 grid gap-px",
        items.length > 1 && "grid-cols-2",
        items.length > 2 && "grid-rows-2",
      )}
    >
      {items.map((item, i) => (
        <span
          key={i}
          className={cn("relative block overflow-hidden", items.length === 3 && i === 0 && "row-span-2")}
        >
          {item.type === "video" ? (
            <video
              src={item.url}
              muted
              loop
              playsInline
              autoPlay
              preload="metadata"
              className="block size-full object-cover"
            />
          ) : (
            <NextImage src={item.url} alt="" fill sizes="(max-width: 768px) 50vw, 240px" className="object-cover" />
          )}
        </span>
      ))}
    </span>
  );
}

// ── Workflow card ─────────────────────────────────────────────────────────────

function SpaceCard({ space, onOpen }: { space: Space; onOpen: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(space.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);

  const renameSpace = useWorkflowStore((s) => s.renameSpace);
  const deleteSpace = useWorkflowStore((s) => s.deleteSpace);
  const duplicateSpace = useWorkflowStore((s) => s.duplicateSpace);
  const isLastSpace = useWorkflowStore((s) => s.spaces.length <= 1);

  const nodeCount = space.nodes.length;
  const ts = space.updatedAt ?? space.createdAt;
  const activity = workflowActivity(space.nodes);
  const attentionLabel = activity.attention === 1 ? "Needs attention" : `${activity.attention} need attention`;
  const statusLabel = [
    activity.generating ? "generating" : null,
    activity.attention ? attentionLabel.toLowerCase() : null,
  ].filter(Boolean).join(", ");

  const startRename = () => {
    setDraft(space.name);
    setRenaming(true);
  };

  const commitRename = () => {
    if (draft.trim()) renameSpace(space.id, draft.trim());
    else setDraft(space.name);
    setRenaming(false);
  };

  return (
    <>
      <article
        className={cn(
          CARD,
          "cursor-pointer shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] has-[:focus-visible]:shadow-[var(--shadow-md)]",
        )}
        onClick={() => { if (!renaming && !menuOpen) onOpen(); }}
      >
        <span className={FRAME_MARKS}>
          {/* Keyboard entry point; its click bubbles to the card. */}
          <button
            type="button"
            aria-label={`Open ${space.name}${statusLabel ? `, ${statusLabel}` : ""}`}
            className={cn(FRAME, "w-full outline-none")}
          >
            <Mosaic media={collectMedia(space)} />
            {(activity.generating > 0 || activity.attention > 0) && (
              <span className="absolute top-2 left-2 flex flex-wrap gap-1.5">
                {activity.attention > 0 && <StatusChip tone="failed">{attentionLabel}</StatusChip>}
                {activity.generating > 0 && <StatusChip tone="running">Generating</StatusChip>}
              </span>
            )}
          </button>
        </span>

        <div className="flex items-start gap-2 px-1">
          <div className="min-w-0 flex-1">
            {renaming ? (
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") { setDraft(space.name); setRenaming(false); }
                }}
                onClick={(e) => e.stopPropagation()}
                autoFocus
                aria-label="Workflow name"
                className="-mx-1 block w-[calc(100%+0.5rem)] rounded-[var(--radius-xs)] bg-surface-raised px-1 font-serif text-[16.5px] leading-6 text-ink shadow-[inset_0_0_0_1px_var(--rule-strong)] outline-none focus:shadow-[var(--focus-ring)]"
              />
            ) : (
              <h3 className="truncate font-serif text-[16.5px] leading-6 text-ink">{space.name}</h3>
            )}
            <p className="mt-0.5 text-[12px] text-ink-3 tabular-nums">
              {nodeCount} {nodeCount === 1 ? "node" : "nodes"} · {timeAgo(new Date(ts))}
            </p>
          </div>

          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`More actions for ${space.name}`}
                  className="-mr-1 opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100"
                />
              }
              onClick={(e) => e.stopPropagation()}
            >
              <Ellipsis strokeWidth={1.75} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-44"
              onClick={(e) => e.stopPropagation()}
              finalFocus={() => inputRef.current ?? !confirmDelete}
            >
              <DropdownMenuItem onClick={onOpen}>
                <ArrowUpRight strokeWidth={1.75} />
                Open
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={startRename}>
                <Pencil strokeWidth={1.75} />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => duplicateSpace(space.id)}>
                <Copy strokeWidth={1.75} />
                Duplicate
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={isLastSpace}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 strokeWidth={1.75} />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </article>

      {/* Outside the card so dialog clicks don't bubble into it. */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="w-[min(92vw,420px)]" initialFocus={deleteRef}>
          <DialogHeader>
            <DialogTitle>Delete this workflow?</DialogTitle>
            <DialogDescription>
              {`“${space.name}” and its ${nodeCount} ${nodeCount === 1 ? "node" : "nodes"} will be removed. This can’t be undone.`}
            </DialogDescription>
          </DialogHeader>
          <div className="h-4" />
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button
              ref={deleteRef}
              variant="ink"
              className="bg-sanguine hover:bg-sanguine/90"
              onClick={() => { deleteSpace(space.id); setConfirmDelete(false); }}
            >
              Delete <Kbd className="bg-paper/14 text-paper/80 shadow-none">↵</Kbd>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Template card ─────────────────────────────────────────────────────────────

/** Row offsets for the four image → video pairs in the UGC template schematic (viewBox 300×200). */
const SCHEMATIC_ROWS = [23, 65, 107, 149];

/** A drawn plan of the template's graph: four image nodes, each feeding a video node. */
function TemplateSchematic() {
  return (
    <svg viewBox="0 0 300 200" className="absolute inset-0 size-full" fill="none" aria-hidden="true">
      {SCHEMATIC_ROWS.map((y) => (
        <g key={y}>
          <line x1={118} y1={y + 14} x2={182} y2={y + 14} className="stroke-ink-4" strokeDasharray="3 3" />
          <rect x={46.5} y={y + 0.5} width={72} height={28} rx={6} className="fill-surface stroke-rule-strong" />
          <path d={`M56 ${y + 19} l4 -5 3 3 2.5 -2 3.5 4 z`} className="fill-ink-4" />
          <rect x={74} y={y + 12} width={34} height={4} rx={2} className="fill-ink-4" />
          <rect x={182.5} y={y + 0.5} width={72} height={28} rx={6} className="fill-surface stroke-rule-strong" />
          <path d={`M193 ${y + 9.5} l8 4.5 -8 4.5 z`} className="fill-ink-3" />
          <rect x={210} y={y + 12} width={34} height={4} rx={2} className="fill-ink-4" />
          <circle cx={118.5} cy={y + 14.5} r={2} className="fill-ink-3" />
          <circle cx={182.5} cy={y + 14.5} r={2} className="fill-ink-3" />
        </g>
      ))}
    </svg>
  );
}

function TemplateCard({ onLoad }: { onLoad: () => void }) {
  return (
    <button
      type="button"
      onClick={onLoad}
      className={cn(
        CARD,
        "cursor-pointer outline-none shadow-[inset_0_0_0_1px_var(--rule)] hover:shadow-[var(--shadow-sm)] focus-visible:shadow-[var(--shadow-sm)]",
      )}
    >
      <span className={FRAME_MARKS}>
        <span className={FRAME}>
          <TemplateSchematic />
        </span>
      </span>
      <span className="block px-1">
        <span className="block truncate font-serif text-[16.5px] leading-6 text-ink">UGC set</span>
        <span className="mt-0.5 block text-[12px] text-ink-3 tabular-nums">4 images → 4 videos</span>
      </span>
    </button>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <section className="fresco paper-grain mt-10 flex flex-col items-center overflow-hidden rounded-[var(--radius-lg)] px-8 pt-14 pb-12 text-center shadow-[var(--shadow-sm)]">
      <div className="crop-marks w-[min(420px,100%)]">
        <div className="overflow-hidden rounded-[var(--radius)] bg-mat">
          <NextImage
            src="/art/the-touch.webp"
            alt="Two hands reaching toward each other, from Michelangelo’s Creation of Adam"
            width={1000}
            height={566}
            priority
            className="block h-auto w-full"
          />
        </div>
      </div>
      <h2 className="type-title mt-9 text-ink">Nothing here yet</h2>
      <p className="mt-2 max-w-[44ch] text-[14px] leading-relaxed text-ink-2">
        Connect a prompt to a model and your first workflow will appear here.
      </p>
      <Button variant="primary" size="lg" className="mt-6" onClick={onCreate}>
        <Plus strokeWidth={2} />
        New workflow <Kbd>N</Kbd>
      </Button>
    </section>
  );
}

// ── Section header ────────────────────────────────────────────────────────────

function SectionHeader({ title, meta, children }: { title: string; meta?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 className="type-heading text-ink">{title}</h2>
      {meta && <span className="text-[12.5px] text-ink-3 tabular-nums">{meta}</span>}
      {children && <div className="ml-auto">{children}</div>}
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

/** Single-key shortcuts only fire when focus isn't in a field, menu or dialog. */
function isShortcutBlocked(e: KeyboardEvent) {
  if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return true;
  const target = e.target as HTMLElement | null;
  return !!target?.closest?.(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="alertdialog"], [role="menu"]',
  );
}

export default function WorkflowDashboard() {
  const router = useRouter();
  const spaces = useWorkflowStore((s) => s.spaces);
  const createSpace = useWorkflowStore((s) => s.createSpace);
  const switchSpace = useWorkflowStore((s) => s.switchSpace);
  const deleteSpace = useWorkflowStore((s) => s.deleteSpace);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [sort, setSort] = useState<SortKey>("recent");

  const openSpace = (id: string) => {
    switchSpace(id);
    router.push(`/workflow/${id}`);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file
    if (!file) return;

    const { addToast } = useWorkflowStore.getState();
    setImporting(true);
    try {
      // Loaded on demand: the zip reader is heavy and only needed when importing.
      const { importWorkflowZip } = await import("@/lib/importWorkflow");
      const wf = await importWorkflowZip(file);

      createSpace(wf.name, {
        nodes: wf.nodes,
        edges: wf.edges,
        nodeCounters: wf.nodeCounters,
      });
      const newId = useWorkflowStore.getState().activeSpaceId;
      if (wf.viewport) useWorkflowStore.getState().saveViewport(wf.viewport);

      addToast(
        wf.skipped > 0
          ? `Imported “${wf.name}” with ${wf.assetCount} asset(s). ${wf.skipped} couldn’t be restored.`
          : `Imported “${wf.name}” with ${wf.assetCount} asset(s).`,
        wf.skipped > 0 ? "info" : "success",
      );
      router.push(`/workflow/${newId}`);
    } catch (err) {
      addToast((err as Error).message, "error", undefined, "Couldn't import that workflow");
    } finally {
      setImporting(false);
    }
  };

  const handleCreate = useCallback(() => {
    createSpace(`Space ${useWorkflowStore.getState().spaces.length + 1}`);
    router.push(`/workflow/${useWorkflowStore.getState().activeSpaceId}`);
  }, [createSpace, router]);

  const openTemplate = () => {
    const store = useWorkflowStore.getState();
    const existing = store.spaces.find((sp) => sp.name === TEMPLATE_NAME);
    if (existing) {
      if (store.spaces.length === 1) store.createSpace("Space 1");
      deleteSpace(existing.id);
    }
    createSpace(TEMPLATE_NAME, makeUGCTemplate());
    const newId = useWorkflowStore.getState().activeSpaceId;
    router.push(`/workflow/${newId}`);
  };

  // N: new workflow · I: import
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isShortcutBlocked(e)) return;
      const key = e.key.toLowerCase();
      if (key === "n") {
        e.preventDefault();
        handleCreate();
      } else if (key === "i" && !importing) {
        e.preventDefault();
        fileInputRef.current?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleCreate, importing]);

  const workflows = spaces
    .filter((sp) => sp.nodes.length > 0 && sp.name !== TEMPLATE_NAME)
    .sort(
      sort === "name"
        ? (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
        : (a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt),
    );
  const isEmpty = workflows.length === 0;

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1200px] px-8 pt-10 pb-20 md:px-12">
        <header className="flex flex-wrap items-end gap-x-6 gap-y-4">
          <div>
            <h1 className="type-title text-ink">Workflows</h1>
            <p className="mt-1.5 text-[13.5px] text-ink-2">
              Graphs that carry a prompt from first idea to finished image and video.
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              onChange={handleImportFile}
              className="hidden"
            />
            <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={importing}>
              {importing ? <LoaderCircle className="animate-spin" strokeWidth={1.75} /> : <Download strokeWidth={1.75} />}
              {importing ? "Importing…" : "Import"}
              <Kbd>I</Kbd>
            </Button>
            {/* The empty state carries the primary action when there's nothing to list. */}
            {!isEmpty && (
              <Button variant="primary" onClick={handleCreate}>
                <Plus strokeWidth={2} />
                New workflow <Kbd>N</Kbd>
              </Button>
            )}
          </div>
        </header>

        {isEmpty ? (
          <EmptyState onCreate={handleCreate} />
        ) : (
          <section className="mt-10">
            <SectionHeader
              title="Your workflows"
              meta={`${workflows.length} ${workflows.length === 1 ? "workflow" : "workflows"}`}
            >
              <Segmented size="sm" aria-label="Sort workflows" value={sort} onChange={setSort} options={SORT_OPTIONS} />
            </SectionHeader>
            <div className={GRID}>
              {workflows.map((sp) => (
                <SpaceCard key={sp.id} space={sp} onOpen={() => openSpace(sp.id)} />
              ))}
            </div>
          </section>
        )}

        <section className="mt-12">
          <SectionHeader title="Start from a template" meta="Ready-made graphs you can run as is, or adapt." />
          <div className={GRID}>
            <TemplateCard onLoad={openTemplate} />
          </div>
        </section>
      </div>
    </div>
  );
}
