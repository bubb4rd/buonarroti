"use client";

import React, { useState } from "react";
import { Check, ChevronRight, Download, Folder, Minus, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useFolderStore, type Folder as FolderT } from "@/lib/folderStore";
import { cn } from "@/lib/utils";
import type { GalleryItem } from "./types";

/**
 * Floating toolbar shown while items are selected: download, remove, file into
 * folders, clear. Replaces the composer at the bottom of the studio.
 */
export function SelectionBar({
  selectedIds,
  items,
  onDownload,
  onRemove,
  onClear,
}: {
  selectedIds: Set<string>;
  items: GalleryItem[];
  onDownload: () => void;
  onRemove: () => void;
  onClear: () => void;
}) {
  const folders = useFolderStore(s => s.folders);
  const visible = selectedIds.size > 0;

  return (
    <div
      aria-hidden={!visible || undefined}
      className={cn(
        "absolute bottom-6 left-1/2 z-[300] flex -translate-x-1/2 items-center gap-1 rounded-[var(--radius-lg)] bg-surface-raised py-1.5 pr-1.5 pl-4 shadow-[var(--shadow-lg)] transition-[transform,opacity] duration-300 ease-[var(--ease-out)]",
        visible ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-20 opacity-0",
      )}
    >
      <span className="pr-2 text-[13px] whitespace-nowrap text-ink-2">
        <span className="text-ink tabular-nums">{selectedIds.size}</span> selected
      </span>
      <span className="h-5 w-px bg-rule" />
      <Button variant="ghost" size="sm" onClick={onDownload}>
        <Download />
        Download
      </Button>
      {folders.length > 0 && <FolderPicker selectedIds={[...selectedIds]} items={items} folders={folders} />}
      <Button variant="danger" size="sm" onClick={onRemove}>
        <Trash2 />
        Remove
      </Button>
      <span className="ml-0.5 h-5 w-px bg-rule" />
      <Button variant="ghost" size="sm" onClick={onClear} aria-label="Clear selection">
        <X />
        <Kbd>Esc</Kbd>
      </Button>
    </div>
  );
}

function FolderPicker({ selectedIds, items, folders }: { selectedIds: string[]; items: GalleryItem[]; folders: FolderT[] }) {
  const itemFolderMap = useFolderStore(s => s.itemFolderMap);
  const assign = useFolderStore(s => s.assignItemsToFolder);
  const unassign = useFolderStore(s => s.removeItemsFromFolder);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const byParent = (parentId: string | null) => folders.filter(f => f.parentId === parentId).sort((a, b) => a.orderIndex - b.orderIndex);

  const row = (folder: FolderT, depth: number): React.ReactNode => {
    const inFolder = (id: string) => (itemFolderMap[id] ?? []).includes(folder.id);
    const checked = selectedIds.filter(inFolder).length;
    const all = checked === selectedIds.length && selectedIds.length > 0;
    const some = checked > 0 && !all;
    const total = items.filter(it => inFolder(it.id)).length;
    const toAdd = selectedIds.length - checked;
    const children = byParent(folder.id);
    const open = expanded.has(folder.id);
    const toggle = () => (all ? unassign(selectedIds, folder.id) : assign(selectedIds, folder.id));

    return (
      <React.Fragment key={folder.id}>
        <div
          role="menuitemcheckbox"
          aria-checked={all ? true : some ? "mixed" : false}
          tabIndex={0}
          onClick={toggle}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } }}
          style={{ paddingLeft: 8 + depth * 16 }}
          className="flex cursor-pointer items-center gap-2 rounded-[var(--radius)] py-1.5 pr-2 outline-none hover:bg-wash focus-visible:bg-wash"
        >
          <button
            type="button"
            tabIndex={-1}
            aria-label={open ? "Collapse" : "Expand"}
            onClick={e => {
              e.stopPropagation();
              setExpanded(prev => { const n = new Set(prev); if (n.has(folder.id)) n.delete(folder.id); else n.add(folder.id); return n; });
            }}
            className={cn("flex size-4 shrink-0 items-center justify-center text-ink-3", !children.length && "invisible")}
          >
            <ChevronRight className={cn("size-3 transition-transform duration-150", open && "rotate-90")} />
          </button>
          <Folder className={cn("size-3.5 shrink-0", all || some ? "text-lapis" : "text-ink-3")} strokeWidth={1.75} />
          <div className="min-w-0 flex-1">
            <div className={cn("truncate text-[13px]", all || some ? "text-ink" : "text-ink-2")}>{folder.name}</div>
            <div className="text-[11.5px] text-ink-3 tabular-nums">
              {!all && toAdd > 0 ? `${total} → ${total + toAdd}` : total} item{(all ? total : total + toAdd) === 1 ? "" : "s"}
            </div>
          </div>
          <span
            aria-hidden
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-[var(--radius-xs)] shadow-[inset_0_0_0_1.5px_var(--rule-strong)] transition-colors",
              all && "bg-lapis text-lapis-ink shadow-none",
              some && "bg-lapis-soft text-lapis shadow-[inset_0_0_0_1.5px_var(--lapis)]",
            )}
          >
            {all && <Check className="size-3" strokeWidth={3} />}
            {some && <Minus className="size-3" strokeWidth={3} />}
          </span>
        </div>
        {open && children.map(child => row(child, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
        <Folder />
        Add to folder
      </PopoverTrigger>
      <PopoverContent side="top" align="center" sideOffset={10} className="w-[260px]">
        <div className="type-label px-2 pt-1.5 pb-1">Add to folder</div>
        <div className="max-h-[280px] overflow-y-auto">{byParent(null).map(f => row(f, 0))}</div>
      </PopoverContent>
    </Popover>
  );
}
