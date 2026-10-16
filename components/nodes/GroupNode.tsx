"use client";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { NodeProps, Node, useReactFlow, NodeResizeControl, NodeToolbar, Position } from "@xyflow/react";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { RUNNABLE_NODE_TYPES } from "@/lib/executor";
import { NODE_LABELS, gameStepOf, gameSourceTypes } from "@/lib/nodeTypes";
import { STEP_IO, accepts } from "@/lib/game/artifacts";
import { useReadOnly } from "@/lib/readOnlyContext";
import { arrangeNodes } from "@/lib/arrangeNodes";
import { usePipelineRunner } from "@/lib/usePipelineRunner";
import { makeZip } from "@/lib/makeZip";
import { VIDEO_MODELS } from "@/lib/modelConfig";
import { cn } from "@/lib/utils";
import { FloatingBar, ToolbarButton, ToolbarSeparator, floatingPanelClass } from "@/components/ui/floating-toolbar";

export type GroupNodeType = Node<NodeData, "groupNode">;

function collectAncestors(startId: string, allNodes: Node<NodeData>[], edges: { source: string; target: string }[]): string[] {
  const visited = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const e of edges) {
      if (e.target === current && allNodes.some(n => n.id === e.source)) {
        queue.push(e.source);
      }
    }
  }
  visited.delete(startId);
  return [...visited];
}

// Categorical pigments (user data — DESIGN.md). Stored in node `data.color`.
export const GROUP_COLORS = [
  "#2d4db0", // lapis (default)
  "#b0442a", // sanguine
  "#3b7a5a", // verdigris
  "#a8741f", // ochre
  "#7a5a3a", // umber
  "#5b6b7a", // slate
  "#a4506a", // rose madder
  "#6a5a9a", // violet
] as const;

const DEFAULT_GROUP_COLOR = GROUP_COLORS[0];

// Legacy saved colours (pre-Buonarroti palette) → nearest pigment. Read-time only.
const LEGACY_GROUP_COLORS: Record<string, string> = {
  "#3b82f6": "#2d4db0", // blue → lapis
  "#0d9488": "#3b7a5a", // dark teal → verdigris
  "#ec4899": "#a4506a", // pink → rose madder
  "#ef4444": "#b0442a", // red → sanguine
  "#f97316": "#b0442a", // orange → sanguine
  "#eab308": "#a8741f", // yellow → ochre
  "#22c55e": "#3b7a5a", // green → verdigris
  "#14b8a6": "#3b7a5a", // teal → verdigris
  "#06b6d4": "#2d4db0", // cyan → lapis
  "#9ca3af": "#5b6b7a", // gray → slate
  "#2dd4bf": "#2d4db0", // accent teal → lapis
};

/** Resolve a saved group colour to a palette pigment (legacy values mapped, unknown → lapis). */
export function resolveGroupColor(saved: string | undefined): string {
  if (!saved) return DEFAULT_GROUP_COLOR;
  const key = saved.trim().toLowerCase();
  if ((GROUP_COLORS as readonly string[]).includes(key)) return key;
  return LEGACY_GROUP_COLORS[key] ?? DEFAULT_GROUP_COLOR;
}

const mix = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

// ── Lock overlay shown on the group itself when locked ─────────────────────────
function LockBadge({ color }: { color: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center"
        style={{ background: mix(color, 12), border: `1.5px solid ${mix(color, 35)}` }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>
    </div>
  );
}

// ── Scrolling label (overflows are revealed on hover) ─────────────────────────
function ScrollLabel({ text, className }: { text: string; className?: string }) {
  const containerRef = useRef<HTMLSpanElement>(null);
  const innerRef = useRef<HTMLSpanElement>(null);

  const startScroll = () => {
    const c = containerRef.current;
    const t = innerRef.current;
    if (!c || !t) return;
    const overflow = t.scrollWidth - c.clientWidth;
    if (overflow <= 2) return;
    t.style.transition = `transform ${Math.max(800, overflow * 20)}ms linear 350ms`;
    t.style.transform = `translateX(-${overflow}px)`;
  };

  const stopScroll = () => {
    const t = innerRef.current;
    if (!t) return;
    t.style.transition = "transform 180ms ease";
    t.style.transform = "translateX(0)";
  };

  return (
    <span
      ref={containerRef}
      className="inline-block max-w-[88px] overflow-hidden align-middle"
      onPointerEnter={startScroll}
      onPointerLeave={stopScroll}
    >
      <span ref={innerRef} className={cn("inline-block whitespace-nowrap", className)}>
        {text}
      </span>
    </span>
  );
}

// ── Inline warning icon with tooltip ──────────────────────────────────────────
function InlineWarning({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <span className="group/warn relative inline-flex shrink-0 items-center text-sanguine">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="block cursor-default">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span
        className={cn(
          floatingPanelClass,
          "pointer-events-none absolute right-0 bottom-[calc(100%+4px)] z-[200] hidden flex-col gap-0.5 whitespace-nowrap px-2 py-1 text-[11px] text-ink-2 group-hover/warn:flex"
        )}
      >
        {messages.map((msg, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className="size-1 shrink-0 rounded-full bg-sanguine" />
            {msg}
          </span>
        ))}
      </span>
    </span>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────
export default function GroupNode({ id, data, selected }: NodeProps<GroupNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData  = useWorkflowStore((s) => s.updateNodeData);
  const updateNodeSize  = useWorkflowStore((s) => s.updateNodeSize);
  const onNodesChange   = useWorkflowStore((s) => s.onNodesChange);
  const { fitBounds }   = useReactFlow();

  const color  = resolveGroupColor(data.color as string | undefined);
  const locked = (data.locked as boolean) ?? false;
  const label  = data.label   as string;

  const memberIds = (data.memberIds as string[] | undefined) ?? [];
  const { run: runPipeline, isRunning: pipelineRunning, genNodeCount } = usePipelineRunner(memberIds);
  const [isDownloading, setIsDownloading] = useState(false);
  const [runDropdownOpen, setRunDropdownOpen] = useState(false);
  const runDropdownRef = useRef<HTMLDivElement>(null);

  const allNodes = useWorkflowStore((s) => s.nodes);
  const edges = useWorkflowStore((s) => s.edges);

  const jobs = useMemo(() => {
    const genNodes = allNodes.filter(
      (n) => memberIds.includes(n.id) && RUNNABLE_NODE_TYPES[n.type ?? ""]
    );
    return genNodes.map((genNode) => {
      const incomingEdges = edges.filter((e) => e.target === genNode.id);
      const sourcesById = new Map(
        incomingEdges
          .map((e) => allNodes.find((n) => n.id === e.source))
          .filter((n): n is Node<NodeData> => !!n)
          .map((n) => [n.id, n])
      );
      const allSources = [...sourcesById.values()];

      // Prefer text-type sources (same logic as resolveInputs)
      const textSources = allSources.filter(
        (n) => n.type === "promptNode" || n.type === "assistantNode"
      );
      const sources = textSources.length > 0 ? textSources : allSources;
      const sourceLabel =
        sources.length > 0
          ? sources.map((n) => (n.data.label as string) || n.type).join(", ")
          : "—";

      // Compute missing required inputs
      const missingInputs: string[] = [];
      const promptConnected = incomingEdges.some((e) => e.targetHandle === "prompt");
      const gameStep = gameStepOf(genNode.type);
      if (gameStep) {
        const need = STEP_IO[gameStep].input;
        const src = allSources[0];
        if (!src) {
          missingInputs.push(need === "prompt" ? "A text node is required" : `Connect a ${NODE_LABELS[gameSourceTypes(gameStep)[0]]} node`);
        } else if (need !== "prompt" && !memberIds.includes(src.id)) {
          // Upstream outside the group won't run: its current artifact must already be usable.
          const ok = accepts(src.data.artifact, need);
          if (!ok.ok) missingInputs.push(ok.reason);
        }
      } else if (genNode.type === "generateNode") {
        if (!promptConnected) missingInputs.push("A text node is required");
      } else {
        const videoModelId = (genNode.data.videoModel as string) ?? "kling-3.0";
        const cfg = VIDEO_MODELS.find((m) => m.id === videoModelId) ?? VIDEO_MODELS[0];
        if (!cfg.promptOptional && !promptConnected) missingInputs.push("A text node is required");
      }

      return {
        genNodeId: genNode.id,
        isVideo: genNode.type === "videoGeneratorNode",
        genLabel: (genNode.data.label as string) || NODE_LABELS[genNode.type ?? ""] || "Generator",
        sourceLabel,
        missingInputs,
        allAncestorIds: collectAncestors(genNode.id, allNodes, edges),
      };
    });
  }, [allNodes, edges, memberIds]);

  const readyJobCount = useMemo(() => jobs.filter((j) => j.missingInputs.length === 0).length, [jobs]);

  const handleDownload = useCallback(async () => {
    if (isDownloading) return;
    const { nodes } = useWorkflowStore.getState();
    const members = nodes.filter((n) => memberIds.includes(n.id));

    // Collect all output URLs from member nodes
    const assets: { url: string; name: string }[] = [];
    for (const node of members) {
      const nodeLabel = (node.data.label as string | undefined) ?? node.id;
      const ext = node.type === "videoGeneratorNode" ? "mp4" : "png";

      // Prefer the full generations history, fall back to single URL
      const gens = node.data.generations as (string | null | { error: string })[] | undefined;
      if (gens && gens.length > 0) {
        gens.forEach((entry, i) => {
          if (typeof entry === "string") {
            const suffix = gens.length > 1 ? `-${i + 1}` : "";
            assets.push({ url: entry, name: `${nodeLabel}${suffix}.${ext}` });
          }
        });
      } else {
        const url = (node.data.imageUrl ?? node.data.videoUrl) as string | undefined;
        if (url) assets.push({ url, name: `${nodeLabel}.${ext}` });
      }
    }

    if (assets.length === 0) return;
    setIsDownloading(true);
    try {
      const entries = await Promise.all(
        assets.map(async ({ url, name }) => {
          const resp = await fetch(`/api/download?url=${encodeURIComponent(url)}&filename=${name}`);
          const buf = await resp.arrayBuffer();
          return { name, data: new Uint8Array(buf) };
        })
      );
      const blob = makeZip(entries);
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = `${label || "group"}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
    } finally {
      setIsDownloading(false);
    }
  }, [isDownloading, memberIds, label]);

  const cardRef = useRef<HTMLDivElement>(null);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const colorPickerRef = useRef<HTMLDivElement>(null);

  // Keep store's style.width/height in sync as the group is resized.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      updateNodeSize(id, el.offsetWidth, el.offsetHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [id, updateNodeSize]);

  // Close color picker on click outside
  useEffect(() => {
    if (!colorPickerOpen) return;
    const handler = (e: MouseEvent) => {
      if (colorPickerRef.current && !colorPickerRef.current.contains(e.target as Element)) {
        setColorPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [colorPickerOpen]);

  const flashNode = useCallback((nodeId: string, anim = "node-identify-blink") => {
    const styleId = `identify-flash-${nodeId}`;
    document.getElementById(styleId)?.remove();
    requestAnimationFrame(() => {
      const styleEl = document.createElement("style");
      styleEl.id = styleId;
      styleEl.textContent = `.react-flow__node[data-id="${CSS.escape(nodeId)}"] .node-card { animation: ${anim} 1.3s ease 1 forwards; }`;
      document.head.appendChild(styleEl);
      setTimeout(() => document.getElementById(styleId)?.remove(), 1400);
    });
  }, []);

  // Close run dropdown on click outside
  useEffect(() => {
    if (!runDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (runDropdownRef.current && !runDropdownRef.current.contains(e.target as Element)) {
        setRunDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [runDropdownOpen]);
  const toolbarVisible = !!selected && !readOnly;

  // ── Ungroup ──────────────────────────────────────────────────────────────
  const handleUngroup = useCallback(() => {
    const state = useWorkflowStore.getState();
    // Members already hold absolute positions — just remove the group node
    const newNodes = state.nodes.filter((n) => n.id !== id);
    useWorkflowStore.setState((s) => ({
      nodes: newNodes,
      spaces: s.spaces.map((sp) =>
        sp.id === s.activeSpaceId ? { ...sp, nodes: newNodes } : sp
      ),
    }));
  }, [id]);

  // ── Lock / Unlock ─────────────────────────────────────────────────────────
  const handleLock = useCallback(() => {
    updateNodeData(id, { locked: true });
    const state = useWorkflowStore.getState();
    const groupNode = state.nodes.find((n) => n.id === id);
    const memberIdSet = new Set((groupNode?.data?.memberIds as string[] | undefined) ?? []);
    const newNodes = state.nodes.map((n) =>
      memberIdSet.has(n.id) ? { ...n, data: { ...n.data, locked: true } } : n
    );
    useWorkflowStore.setState((s) => ({
      nodes: newNodes,
      spaces: s.spaces.map((sp) =>
        sp.id === s.activeSpaceId ? { ...sp, nodes: newNodes } : sp
      ),
    }));
  }, [id, updateNodeData]);

  const handleUnlock = useCallback(() => {
    updateNodeData(id, { locked: false });
    const state = useWorkflowStore.getState();
    const groupNode = state.nodes.find((n) => n.id === id);
    const memberIdSet = new Set((groupNode?.data?.memberIds as string[] | undefined) ?? []);
    const newNodes = state.nodes.map((n) =>
      memberIdSet.has(n.id) ? { ...n, data: { ...n.data, locked: false } } : n
    );
    useWorkflowStore.setState((s) => ({
      nodes: newNodes,
      spaces: s.spaces.map((sp) =>
        sp.id === s.activeSpaceId ? { ...sp, nodes: newNodes } : sp
      ),
    }));
  }, [id, updateNodeData]);

  // ── Focus view ────────────────────────────────────────────────────────────
  const handleFocus = useCallback(() => {
    const state = useWorkflowStore.getState();
    const groupNode = state.nodes.find((n) => n.id === id);
    if (!groupNode) return;
    const w = groupNode.measured?.width  ?? (groupNode.style?.width  as number | undefined) ?? 400;
    const h = groupNode.measured?.height ?? (groupNode.style?.height as number | undefined) ?? 300;
    fitBounds({ x: groupNode.position.x, y: groupNode.position.y, width: w, height: h }, { duration: 500, padding: 0.15 });
  }, [id, fitBounds]);

  const handleDelete = useCallback(() => {
    const state = useWorkflowStore.getState();
    const groupNode = state.nodes.find((n) => n.id === id);
    const memberIds = (groupNode?.data?.memberIds as string[] | undefined) ?? [];
    const allIds = new Set([id, ...memberIds]);
    onNodesChange([...allIds].map((nid) => ({ type: "remove" as const, id: nid })));
  }, [id, onNodesChange]);

  // ── Arrange members ───────────────────────────────────────────────────────
  const handleArrange = useCallback(() => {
    const state = useWorkflowStore.getState();
    const memberIds = (state.nodes.find((n) => n.id === id)?.data?.memberIds as string[] | undefined) ?? [];
    arrangeNodes(memberIds, { groupId: id });
  }, [id]);

  // ── Duplicate group + members ─────────────────────────────────────────────
  const handleDuplicate = useCallback(() => {
    const state = useWorkflowStore.getState();
    const groupNode = state.nodes.find((n) => n.id === id);
    if (!groupNode) return;

    const memberIds = (groupNode.data?.memberIds as string[] | undefined) ?? [];
    const members = state.nodes.filter((n) => memberIds.includes(n.id));

    const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const newGroupId = genId();
    const idMap: Record<string, string> = { [id]: newGroupId };
    members.forEach((m) => { idMap[m.id] = genId(); });

    const offset = 20;
    const newMemberIds = members.map((m) => idMap[m.id]);
    const groupCount = (state.nodeCounters["groupNode"] ?? 0) + 1;

    const newGroup = {
      ...groupNode,
      id: newGroupId,
      position: { x: groupNode.position.x + offset, y: groupNode.position.y + offset },
      selected: false,
      data: { ...groupNode.data, locked: false, memberIds: newMemberIds, label: `Group #${groupCount}` },
    };

    const newMembers = members.map((m) => ({
      ...m,
      id: idMap[m.id],
      position: { x: m.position.x + offset, y: m.position.y + offset },
      selected: false,
      data: { ...m.data, locked: false },
    }));

    const newEdges = state.edges
      .filter((e) => idMap[e.source] && idMap[e.target])
      .map((e) => ({ ...e, id: genId(), source: idMap[e.source], target: idMap[e.target] }));

    const nodes = [...state.nodes, newGroup, ...newMembers];
    const edges = [...state.edges, ...newEdges];
    const nodeCounters = { ...state.nodeCounters, groupNode: groupCount };

    useWorkflowStore.setState((s) => ({
      nodes,
      edges,
      nodeCounters,
      spaces: s.spaces.map((sp) =>
        sp.id === s.activeSpaceId
          ? { ...sp, nodes, edges, nodeCounters, updatedAt: Date.now() }
          : sp
      ),
    }));
  }, [id]);

  type ResizePos = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top" | "right" | "bottom" | "left";

  // Corner and edge resize handle definitions (colour-matched to the group)
  const resizeHandles: Array<{ position: ResizePos; style: React.CSSProperties }> = [
    // Corners — bracket marks
    { position: "top-left",     style: { width: 10, height: 10, background: "transparent", border: "none", borderTop: `2px solid ${color}`, borderLeft:  `2px solid ${color}`, borderTopLeftRadius:     3, top:    -6, left:   -6, zIndex: 100 } },
    { position: "top-right",    style: { width: 10, height: 10, background: "transparent", border: "none", borderTop: `2px solid ${color}`, borderRight: `2px solid ${color}`, borderTopRightRadius:    3, top:    -6, right:  -6, zIndex: 100 } },
    { position: "bottom-left",  style: { width: 10, height: 10, background: "transparent", border: "none", borderBottom: `2px solid ${color}`, borderLeft:  `2px solid ${color}`, borderBottomLeftRadius:  3, bottom: -6, left:   -6, zIndex: 100 } },
    { position: "bottom-right", style: { width: 10, height: 10, background: "transparent", border: "none", borderBottom: `2px solid ${color}`, borderRight: `2px solid ${color}`, borderBottomRightRadius: 3, bottom: -6, right:  -6, zIndex: 100 } },
    // Edges — small pill handles centred on each side
    { position: "top",    style: { width: 22, height: 4,  border: "none", background: color, borderRadius: 2, opacity: 0.6, top:    -5, left: "50%", transform: "translateX(-50%)", zIndex: 100 } },
    { position: "right",  style: { width: 4,  height: 22, border: "none", background: color, borderRadius: 2, opacity: 0.6, right:  -5, top:  "50%", transform: "translateY(-50%)", zIndex: 100 } },
    { position: "bottom", style: { width: 22, height: 4,  border: "none", background: color, borderRadius: 2, opacity: 0.6, bottom: -5, left: "50%", transform: "translateX(-50%)", zIndex: 100 } },
    { position: "left",   style: { width: 4,  height: 22, border: "none", background: color, borderRadius: 2, opacity: 0.6, left:   -5, top:  "50%", transform: "translateY(-50%)", zIndex: 100 } },
  ];

  const labelledButtonClass = "w-auto gap-1.5 px-2.5";
  const iconProps = { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const runDisabled = readyJobCount === 0 || pipelineRunning;

  return (
    <div
      ref={cardRef}
      className="relative w-full h-full rounded-[var(--radius-lg)] transition-[box-shadow,opacity] duration-150"
      style={{
        border: `1px solid ${mix(color, 35)}`,
        background: mix(color, 6),
        boxShadow: selected ? `0 0 0 1.5px ${mix(color, 70)}` : undefined,
        opacity: locked ? 0.85 : 1,
      }}
    >
      {/* Resize handles — only when selected and unlocked */}
      {selected && !locked && resizeHandles.map(({ position, style }) => (
        <NodeResizeControl
          key={position}
          position={position}
          minWidth={200}
          minHeight={150}
          style={style}
        />
      ))}
      {/* Label — outside top-left */}
      <span className="pointer-events-none absolute -top-[22px] left-0 select-none whitespace-nowrap text-[12.5px] font-medium text-ink-2">
        <span className="mr-1.5 inline-block size-2 rounded-full align-[1px]" style={{ background: color }} />
        {label}
      </span>

      {locked && <LockBadge color={color} />}

      {/* ── Toolbar ──────────────────────────────────────────────────────── */}
      <NodeToolbar isVisible={toolbarVisible} position={Position.Top} offset={16}>
      <FloatingBar className="node-action-bar-enter relative z-10">
        {locked ? (
          /* Locked: only show unlock */
          <ToolbarButton onClick={handleUnlock} title="Unlock group">
            <svg {...iconProps}>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 9.9-1" />
            </svg>
          </ToolbarButton>
        ) : (
          <>
            {/* Focus / center view */}
            <ToolbarButton onClick={handleFocus} title="Center view on group" className={labelledButtonClass}>
              <svg {...iconProps}>
                <circle cx="12" cy="12" r="7" />
                <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
                <line x1="12" y1="2" x2="12" y2="5" />
                <line x1="12" y1="19" x2="12" y2="22" />
                <line x1="2" y1="12" x2="5" y2="12" />
                <line x1="19" y1="12" x2="22" y2="12" />
              </svg>
              <span className="text-[12px] font-medium leading-none">Center</span>
            </ToolbarButton>

            {/* Arrange members */}
            <ToolbarButton onClick={handleArrange} title="Auto-arrange nodes in group" className={labelledButtonClass}>
              <svg {...iconProps}>
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
              <span className="text-[12px] font-medium leading-none">Arrange</span>
            </ToolbarButton>

            {/* Ungroup */}
            <ToolbarButton onClick={handleUngroup} title="Ungroup" className={labelledButtonClass}>
              <svg {...iconProps}>
                <rect x="2" y="7" width="8" height="8" rx="1.5" />
                <rect x="14" y="7" width="8" height="8" rx="1.5" />
                <path d="M6 7V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v2" />
              </svg>
              <span className="text-[12px] font-medium leading-none">Ungroup</span>
            </ToolbarButton>

            <ToolbarSeparator />

            {/* Color picker trigger */}
            <div className="relative">
              <ToolbarButton
                onClick={() => setColorPickerOpen((o) => !o)}
                title="Change colour"
                active={colorPickerOpen}
              >
                <span className="size-3.5 rounded-full shadow-[inset_0_0_0_1px_var(--rule)]" style={{ background: color }} />
              </ToolbarButton>

              {colorPickerOpen && (
                <div
                  ref={colorPickerRef}
                  className={cn(floatingPanelClass, "absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 flex-row gap-1.5 whitespace-nowrap p-2")}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {GROUP_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Use colour ${c}`}
                      aria-pressed={color === c}
                      onClick={(e) => {
                        e.stopPropagation();
                        updateNodeData(id, { color: c });
                        setColorPickerOpen(false);
                      }}
                      className={cn(
                        "size-5 shrink-0 rounded-full transition-transform duration-150 hover:scale-110 outline-none focus-visible:shadow-[var(--focus-ring)]",
                        color === c && "ring-2 ring-ink ring-offset-2 ring-offset-surface-raised"
                      )}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Lock */}
            <ToolbarButton onClick={handleLock} title="Lock group">
              <svg {...iconProps}>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </ToolbarButton>

            <ToolbarSeparator />

            {/* Duplicate */}
            <ToolbarButton onClick={handleDuplicate} title="Duplicate group">
              <svg {...iconProps}>
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </ToolbarButton>

            {/* Delete */}
            <ToolbarButton onClick={handleDelete} title="Delete group and nodes" danger>
              <svg {...iconProps}>
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4h6v2" />
              </svg>
            </ToolbarButton>

            <ToolbarSeparator />

            {/* Download all outputs */}
            <ToolbarButton onClick={handleDownload} title="Download all outputs as ZIP">
              {isDownloading ? (
                <svg width="13" height="13" viewBox="0 0 10 10" fill="none" className="animate-spin">
                  <circle cx="5" cy="5" r="4" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
                  <path d="M5 1 A4 4 0 0 1 9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              ) : (
                <svg {...iconProps}>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              )}
            </ToolbarButton>

            {/* Run pipeline — split button with jobs dropdown */}
            <div className="relative ml-0.5" ref={runDropdownRef}>
              <div
                className={cn(
                  "flex h-7 items-center rounded-[var(--radius-sm)] transition-[background-color,opacity] duration-150",
                  readyJobCount === 0
                    ? "bg-wash text-ink-4 opacity-60"
                    : pipelineRunning ? "bg-lapis-soft text-lapis" : "bg-lapis text-lapis-ink"
                )}
              >
                {/* Run part */}
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => { e.stopPropagation(); runPipeline(); }}
                  title={readyJobCount === 0 ? "No ready generation nodes in group" : `Run ${readyJobCount} generation node${readyJobCount === 1 ? "" : "s"}`}
                  disabled={runDisabled}
                  className={cn("flex h-full items-center gap-1.5 pl-2.5 pr-2 outline-none", runDisabled ? "cursor-not-allowed" : "cursor-pointer")}
                >
                  {pipelineRunning ? (
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="none" className="shrink-0 animate-spin">
                      <circle cx="5" cy="5" r="4" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1.5" />
                      <path d="M5 1 A4 4 0 0 1 9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor" className="shrink-0">
                      <path d="M2 1.5 L9 5 L2 8.5 Z" />
                    </svg>
                  )}
                  <span className="text-[12px] font-medium leading-none">Run</span>
                  {readyJobCount > 0 && (
                    <span className="rounded-full bg-current/15 px-1.5 py-0.5 text-[10.5px] font-semibold leading-none tabular-nums">
                      {readyJobCount}
                    </span>
                  )}
                </button>

                {/* Divider */}
                <span className="h-3.5 w-px shrink-0 bg-current opacity-25" />

                {/* Chevron */}
                <button
                  type="button"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (jobs.length > 0) setRunDropdownOpen((o) => !o);
                  }}
                  disabled={genNodeCount === 0 || pipelineRunning}
                  title="Show generate jobs"
                  className={cn("flex h-full items-center justify-center px-1.5 outline-none", genNodeCount === 0 ? "cursor-not-allowed" : "cursor-pointer")}
                >
                  <svg
                    width="10" height="10" viewBox="0 0 10 10" fill="none"
                    className={cn("transition-transform duration-150", runDropdownOpen && "rotate-180")}
                  >
                    <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
              </div>

              {/* Jobs dropdown */}
              {runDropdownOpen && jobs.length > 0 && (
                <div
                  className={cn(floatingPanelClass, "node-action-bar-enter absolute bottom-full right-0 mb-2 min-w-[220px] overflow-hidden py-1")}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <div className="px-3 pt-1.5 pb-1">
                    <span className="text-[12px] font-medium text-ink-3">Generate jobs</span>
                  </div>
                  {jobs.map((job) => (
                    <div
                      key={job.genNodeId}
                      className="mx-1 flex cursor-pointer items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 text-[12px] transition-colors duration-100 hover:bg-wash"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        flashNode(job.genNodeId);
                        job.allAncestorIds.forEach((aid) => flashNode(aid, "node-identify-input-blink"));
                      }}
                    >
                      {/* Source icon */}
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-ink-4">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                        <line x1="16" y1="13" x2="8" y2="13" />
                        <line x1="16" y1="17" x2="8" y2="17" />
                      </svg>
                      <ScrollLabel text={job.sourceLabel} className="text-ink-3" />

                      {/* Arrow */}
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0 text-ink-4">
                        <path d="M2 6H10M10 6L7 3M10 6L7 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>

                      {/* Target icon */}
                      {job.isVideo ? (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-lapis">
                          <polygon points="23 7 16 12 23 17 23 7" />
                          <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                        </svg>
                      ) : (
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-lapis">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                          <circle cx="8.5" cy="8.5" r="1.5" />
                          <polyline points="21 15 16 10 5 21" />
                        </svg>
                      )}
                      <ScrollLabel text={job.genLabel} className="text-ink" />
                      {job.missingInputs.length > 0 && (
                        <span className="ml-auto">
                          <InlineWarning messages={job.missingInputs} />
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </FloatingBar>
      </NodeToolbar>
    </div>
  );
}
