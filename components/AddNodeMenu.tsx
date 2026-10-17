"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useReactFlow } from "@xyflow/react";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { NODES, NODE_SIZE, FALLBACK_SIZE, NODE_META, TypeBadge, getLastNodeSettings, getDefaultNodeSize, nextNodeLabel, GAME_GROUPS, GAME_NODES, GAME_NODE_TYPES, gameStepOf, type GameGroup } from "@/lib/nodeTypes";
import { getToken } from "@/lib/galleryUtils";
import { MediaPickerModal } from "@/components/MediaPickerModal";
import { Kbd } from "@/components/ui/kbd";
import { floatingPanelClass } from "@/components/ui/floating-toolbar";
import { cn } from "@/lib/utils";

import { Search, X, Upload, LayoutGrid } from "lucide-react";

const TOOLBAR_OFFSET_PX = 80;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* Node types replaced by Upload/Assets — hidden from search results */
const HIDDEN_FROM_MENU: Record<string, true> = { imageInputNode: true, videoInputNode: true };

const SECTIONS: Array<{ id: string; label: string; nodeTypes: string[] }> = [
  {
    id: "generators",
    label: "Generators",
    nodeTypes: ["generateNode", "videoGeneratorNode", "assistantNode"],
  },
  {
    id: "resources",
    label: "Inputs",
    nodeTypes: ["promptNode"],
  },
  ...(Object.keys(GAME_GROUPS) as GameGroup[]).map((g) => ({
    id: `game-${g}`,
    label: GAME_GROUPS[g].label,
    nodeTypes: GAME_NODE_TYPES.filter((t) => GAME_NODES[t].group === g),
  })),
  {
    id: "annotate",
    label: "Annotate",
    nodeTypes: ["commentNode"],
  },
];

interface MenuRow {
  id: string;
  label: string;
  description: string;
  accent?: string;
  icon: React.ReactNode;
  run: (point?: { x: number; y: number }) => void;
}

interface AddNodeMenuProps {
  anchorRect: DOMRect;
  onClose: () => void;
}

export default function AddNodeMenu({ anchorRect, onClose }: AddNodeMenuProps) {
  const { screenToFlowPosition } = useReactFlow();
  const addNode = useWorkflowStore((s) => s.addNode);

  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerPos, setPickerPos] = useState({ x: 0, y: 0 });

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerOpen) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [onClose, pickerOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") { if (pickerOpen) setPickerOpen(false); else onClose(); } };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, pickerOpen]);

  const q = query.trim().toLowerCase();
  const allNodes = NODES.filter((n) => !HIDDEN_FROM_MENU[n.type]);
  // Label matches rank above description-only matches.
  const filtered = q
    ? [
        ...allNodes.filter((n) => n.label.toLowerCase().includes(q)),
        ...allNodes.filter((n) => !n.label.toLowerCase().includes(q) && n.description.toLowerCase().includes(q)),
      ]
    : null;

  function rectsOverlap(
    ax: number, ay: number, aw: number, ah: number,
    bx: number, by: number, bw: number, bh: number,
    pad = 0,
  ) {
    return ax - pad < bx + bw && ax + aw + pad > bx && ay - pad < by + bh && ay + ah + pad > by;
  }

  /* Calculate position and label for a new node, then add it. Returns the nodeId. */
  const addNextToToolbar = useCallback(
    (type: string, extraData?: Partial<NodeData>): string => {
      const container = document.querySelector(".react-flow") as HTMLElement | null;
      const rect = container?.getBoundingClientRect();
      const storeState = useWorkflowStore.getState();
      const size = getDefaultNodeSize(type, storeState.lastNodeSize);
      const GAP = 40;
      const nodesNow = storeState.nodes;
      const label = nextNodeLabel(type, nodesNow);

      let nodeX: number;
      let nodeY: number;

      if (nodesNow.length === 0) {
        const screenX = (rect?.left ?? 0) + TOOLBAR_OFFSET_PX;
        const screenY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
        const flowPos = screenToFlowPosition({ x: screenX, y: screenY });
        nodeX = flowPos.x;
        nodeY = flowPos.y - size.h / 2;
      } else {
        const vpCentreScreen = {
          x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
          y: rect ? rect.top + rect.height / 2 : window.innerHeight / 2,
        };
        const vpCentreFlow = screenToFlowPosition(vpCentreScreen);

        let nearest = nodesNow[0];
        let nearestDist = Infinity;
        for (const n of nodesNow) {
          const s = NODE_SIZE[n.type ?? ""] ?? FALLBACK_SIZE;
          const cx = n.position.x + s.w / 2;
          const cy = n.position.y + s.h / 2;
          const d = Math.hypot(cx - vpCentreFlow.x, cy - vpCentreFlow.y);
          if (d < nearestDist) { nearestDist = d; nearest = n; }
        }

        const nearestSize = NODE_SIZE[nearest.type ?? ""] ?? FALLBACK_SIZE;
        let candidateX = nearest.position.x + nearestSize.w + GAP;
        const candidateY = nearest.position.y + nearestSize.h / 2 - size.h / 2;

        const MAX_ATTEMPTS = 40;
        for (let i = 0; i < MAX_ATTEMPTS; i++) {
          const overlapping = nodesNow.some((n) => {
            const s = NODE_SIZE[n.type ?? ""] ?? FALLBACK_SIZE;
            return rectsOverlap(candidateX, candidateY, size.w, size.h, n.position.x, n.position.y, s.w, s.h, GAP / 2);
          });
          if (!overlapping) break;
          candidateX += size.w + GAP;
        }

        nodeX = candidateX;
        nodeY = candidateY;
      }

      const nodeId = `${type}-${uid()}`;
      addNode({
        id: nodeId,
        type,
        position: { x: nodeX, y: nodeY },
        style:
          type === "imageInputNode" || type === "videoInputNode" || gameStepOf(type)
            ? { width: size.w }
            : { width: size.w, height: size.h },
        data: { label, status: "idle", ...getLastNodeSettings(type, nodesNow), ...extraData },
      });

      onClose();
      return nodeId;
    },
    [addNode, screenToFlowPosition, onClose],
  );

  /* Handle file selected via the Upload button */
  const handleFileSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = "";

      const isVideo = file.type.startsWith("video/");
      const type = isVideo ? "videoInputNode" : "imageInputNode";
      const blobUrl = URL.createObjectURL(file);

      const nodeId = addNextToToolbar(type, isVideo ? { videoUrl: blobUrl } : { inputImage: blobUrl });

      if (!isVideo) {
        const img = new window.Image();
        img.onload = () => {
          useWorkflowStore.getState().updateNodeData(nodeId, {
            imageNaturalRatio: `${img.naturalWidth} / ${img.naturalHeight}`,
          });
        };
        img.src = blobUrl;
      }

      const bytes = await file.arrayBuffer();
      const token = await getToken();
      const headers: Record<string, string> = { "Content-Type": file.type || (isVideo ? "video/mp4" : "image/jpeg") };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      try {
        const res = await fetch("/api/upload-asset", {
          method: "POST",
          headers,
          body: bytes,
        });
        const { cdnUrl } = await res.json() as { cdnUrl?: string };
        if (cdnUrl) {
          URL.revokeObjectURL(blobUrl);
          useWorkflowStore.getState().updateNodeData(
            nodeId,
            isVideo ? { videoUrl: cdnUrl } : { inputImage: cdnUrl, r2Url: cdnUrl },
          );
        }
      } catch {
        // blob URL stays as fallback until page reload
      }
    },
    [addNextToToolbar],
  );

  /* Handle asset selected from the picker */
  const handleAssetPick = useCallback(
    async (url: string, mediaType: "image" | "video") => {
      setPickerOpen(false);
      if (mediaType === "image") {
        const thumbnailSrc = url;
        const ratio = await new Promise<string | undefined>((resolve) => {
          const img = new window.Image();
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve(img.naturalWidth && img.naturalHeight
              ? `${img.naturalWidth} / ${img.naturalHeight}`
              : undefined);
          };
          img.onload = finish;
          img.onerror = () => { done = true; resolve(undefined); };
          img.src = thumbnailSrc;
          if (img.complete && img.naturalWidth > 0) finish();
        });
        addNextToToolbar("imageInputNode", {
          inputImage: url,
          r2Url: url,
          ...(ratio ? { imageNaturalRatio: ratio } : {}),
        });
      } else {
        addNextToToolbar("videoInputNode", { videoUrl: url });
      }
    },
    [addNextToToolbar],
  );

  /* Menu position */
  const MENU_W = 288;
  const MENU_MAX_H = 460;
  const left = anchorRect.right + 10;
  const topRaw = anchorRect.top + anchorRect.height / 2 - MENU_MAX_H / 2;
  const top = Math.max(12, Math.min(topRaw, window.innerHeight - MENU_MAX_H - 12));

  /* Rows: node types, plus Upload / Library under Inputs */
  const nodeRow = (type: string): MenuRow[] => {
    const node = allNodes.find((n) => n.type === type);
    if (!node) return [];
    return [{
      id: type,
      label: node.label,
      description: node.description,
      accent: NODE_META[type]?.accent,
      icon: NODE_META[type]?.bigIcon ?? node.icon,
      run: () => addNextToToolbar(type),
    }];
  };
  const mediaRows: MenuRow[] = [
    {
      id: "upload",
      label: "Upload",
      description: "An image or video from your computer",
      accent: "var(--verdigris)",
      icon: <Upload size={18} strokeWidth={1.7} />,
      run: () => fileInputRef.current?.click(),
    },
    {
      id: "assets",
      label: "From your library",
      description: "Your generations and uploads",
      accent: "var(--handle-image)",
      icon: <LayoutGrid size={18} strokeWidth={1.7} />,
      run: (point) => {
        setPickerPos(point ?? { x: left + MENU_W, y: top + 40 });
        setPickerOpen(true);
      },
    },
  ];
  const groups: Array<{ id: string; label?: string; rows: MenuRow[] }> = filtered
    ? [{ id: "results", rows: filtered.flatMap((n) => nodeRow(n.type)) }]
    : SECTIONS.map((s) => ({
        id: s.id,
        label: s.label,
        rows: [...s.nodeTypes.flatMap(nodeRow), ...(s.id === "resources" ? mediaRows : [])],
      }));
  const flatRows = groups.flatMap((g) => g.rows);

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flatRows.length === 0) return;
      const idx = flatRows.findIndex((r) => r.id === focused);
      const next = e.key === "ArrowDown"
        ? flatRows[(idx + 1) % flatRows.length]
        : flatRows[(idx <= 0 ? flatRows.length : idx) - 1];
      setFocused(next.id);
      document.getElementById(`add-node-${next.id}`)?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      (flatRows.find((r) => r.id === focused) ?? flatRows[0])?.run();
    }
  }

  const menu = (
    <>
      {/* Hidden file input for Upload */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,video/*"
        className="hidden"
        onChange={handleFileSelected}
      />

      <div
        id="add-node-menu"
        ref={menuRef}
        onMouseDown={(e) => e.stopPropagation()}
        className={cn(
          floatingPanelClass,
          "fixed z-[99999] flex flex-col overflow-hidden animate-in fade-in-0 slide-in-from-left-2 duration-150",
        )}
        style={{ left, top, width: MENU_W, maxHeight: MENU_MAX_H }}
      >
        {/* Search */}
        <div className="flex items-center gap-2 border-b border-rule px-3.5 py-2.5">
          <Search className="size-3.5 shrink-0 text-ink-3" strokeWidth={1.75} />
          <input
            ref={searchRef}
            id="add-node-search"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setFocused(null); }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Add to canvas…"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink caret-lapis outline-none placeholder:text-ink-4 focus-visible:shadow-none"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="text-ink-3 transition-colors hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* Rows */}
        <div className="flex-1 overflow-y-auto p-1.5">
          {flatRows.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12.5px] text-ink-3">
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.id} className="mb-1 last:mb-0">
                {group.label && (
                  <p className="type-label px-2.5 pt-2 pb-1">{group.label}</p>
                )}
                {group.rows.map((row) => {
                  const active = focused === row.id;
                  return (
                    <button
                      key={row.id}
                      id={`add-node-${row.id}`}
                      type="button"
                      data-active={active || undefined}
                      onMouseEnter={() => setFocused(row.id)}
                      onMouseLeave={() => setFocused(null)}
                      onClick={(e) => row.run({ x: e.clientX, y: e.clientY })}
                      className="flex w-full items-center gap-3 rounded-[var(--radius)] px-2.5 py-2 text-left transition-colors duration-100 data-[active]:bg-wash"
                    >
                      <TypeBadge accent={row.accent} icon={row.icon} />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-[13px] leading-tight font-medium text-ink">{row.label}</span>
                        <span className="truncate text-[11.5px] leading-snug text-ink-3">{row.description}</span>
                      </span>
                      {active && <Kbd className="ml-auto">↵</Kbd>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Hints */}
        <div className="flex items-center gap-3 border-t border-rule bg-paper/50 px-3.5 py-2 text-[11.5px] text-ink-3">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> Move</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> Add</span>
          <span className="ml-auto flex items-center gap-1"><Kbd>esc</Kbd> Close</span>
        </div>
      </div>

      <MediaPickerModal
        open={pickerOpen}
        mediaKind="any"
        onClose={() => setPickerOpen(false)}
        onPickUrl={handleAssetPick}
        x={pickerPos.x}
        y={pickerPos.y}
      />
    </>
  );

  return createPortal(menu, document.body);
}
