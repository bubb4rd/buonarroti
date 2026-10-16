"use client";
import { useEffect, useRef } from "react";
import { useReactFlow, Node, Edge } from "@xyflow/react";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { edgeStyle } from "@/lib/edgeStyles";
import { NODES, NODE_SIZE, FALLBACK_SIZE, NODE_META, TypeBadge, getLastNodeSettings, getDefaultNodeSize, nextNodeLabel, gameStepOf, gameNodeTypeFor, gameNextType, gameOutHandle } from "@/lib/nodeTypes";
import { STEP_IO } from "@/lib/game/artifacts";
import { floatingPanelClass } from "@/components/ui/floating-toolbar";
import { cn } from "@/lib/utils";
import { VIDEO_MODELS, IMAGE_MODELS } from "@/lib/modelConfig";

// Extract the aspect ratio as a float from any source node type
function nodeAspectRatioFloat(data: Record<string, unknown> | undefined): number | null {
  if (!data) return null;
  // generateNode / videoGeneratorNode: "W:H"
  const std = data.aspectRatio as string | undefined;
  if (std) { const [w, h] = std.split(":").map(Number); if (w && h) return w / h; }
  // videoInputNode: "W / H" (CSS)
  const vAR = data.videoAspectRatio as string | undefined;
  if (vAR) { const [w, h] = vAR.split("/").map((s) => Number(s.trim())); if (w && h) return w / h; }
  // imageInputNode: "W / H" (natural dimensions)
  const iAR = data.imageNaturalRatio as string | undefined;
  if (iAR) { const [w, h] = iAR.split("/").map((s) => Number(s.trim())); if (w && h) return w / h; }
  return null;
}

// Find the ratio string in candidates closest to the given float value
function closestRatio(ratioFloat: number, candidates: string[]): string | null {
  if (!candidates.length) return null;
  return candidates.reduce((best, r) => {
    const [w, h] = r.split(":").map(Number);
    const [bw, bh] = best.split(":").map(Number);
    return Math.abs(w / h - ratioFloat) < Math.abs(bw / bh - ratioFloat) ? r : best;
  });
}

// Node types whose OUTPUT can feed a given input handle
function sourceNodeTypesFor(targetHandle: string | null): string[] {
  switch (targetHandle) {
    case "prompt":                         return ["promptNode", "assistantNode"];
    case "image":
    case "startFrame":
    case "endFrame":
    case "resource":                       return ["imageInputNode", "generateNode"];
    case "videoRef":
    case "referenceVideo":                 return ["videoInputNode"];
    // Game-character inputs: only the previous step's node
    case "turnaround":
    case "mesh":
    case "skeleton":
    case "animclip":                       return [gameNodeTypeFor(targetHandle)];
    default:                               return [];
  }
}

// The output handle ID to use on a newly-created source node for a given target handle
function outputHandleForNewNode(newNodeType: string, targetHandle: string): string | undefined {
  const step = gameStepOf(newNodeType);
  if (step) return gameOutHandle(step);
  if (newNodeType === "videoInputNode") {
    if (targetHandle === "videoRef" || targetHandle === "referenceVideo") return "videoRefOut";
    if (targetHandle === "startFrame") return "startFrameOut";
    if (targetHandle === "endFrame")   return "endFrameOut";
  }
  return undefined;
}

export interface DropState {
  screenX: number;
  screenY: number;
  sourceNodeId: string;
  sourceNodeType: string | undefined;
  sourceHandleId: string | null;
  /** true when the drag started from a target (input) handle */
  isInputHandle?: boolean;
}

interface Props {
  dropState: DropState;
  onClose: () => void;
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function targetHandleFor(
  sourceNodeType: string | undefined,
  targetNodeType: string,
  sourceHandleId: string | null,
): string | null {
  // Game nodes: a strict chain — prompt into turnaround, `${kind}Out` into the next step
  const targetStep = gameStepOf(targetNodeType);
  if (targetStep) {
    const need = STEP_IO[targetStep].input;
    if (need === "prompt") return sourceNodeType === "promptNode" || sourceNodeType === "assistantNode" ? "prompt" : null;
    return sourceHandleId === `${need}Out` ? need : null;
  }
  if (gameStepOf(sourceNodeType)) return null;
  // Typed output handles take priority
  if (sourceHandleId) {
    switch (sourceHandleId) {
      case "textOut":
        return "prompt";
      case "startFrameOut":
      case "imagePickOut":
        if (targetNodeType === "videoGeneratorNode") return "startFrame";
        if (targetNodeType === "generateNode")       return "image";
        return null;
      case "endFrameOut":
        if (targetNodeType === "videoGeneratorNode") return "endFrame";
        if (targetNodeType === "generateNode")       return "image";
        return null;
      case "videoRefOut":
        if (targetNodeType === "videoGeneratorNode") return "videoRef";
        return null;
      case "audioRefOut":
        if (targetNodeType === "videoGeneratorNode") return "audioRef";
        return null;
    }
  }
  // Single-output nodes — fall back to node-type routing
  if (sourceNodeType === "promptNode" || sourceNodeType === "assistantNode") return "prompt";
  if (sourceNodeType === "imageInputNode" || sourceNodeType === "generateNode") {
    if (targetNodeType === "videoGeneratorNode") return "startFrame";
    if (targetNodeType === "generateNode")       return "image";
  }
  if (sourceNodeType === "videoInputNode") {
    if (targetNodeType === "videoGeneratorNode") return "videoRef";
  }
  return null;
}

export default function NodePickerMenu({ dropState, onClose }: Props) {
  const { screenToFlowPosition, flowToScreenPosition, getInternalNode } = useReactFlow();
  const addNode    = useWorkflowStore((s) => s.addNode);
  const insertEdge = useWorkflowStore((s) => s.insertEdge);

  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handle = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handle, true);
    return () => document.removeEventListener("mousedown", handle, true);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [onClose]);

  const handleSelect = (type: string) => {
    const flowPos = screenToFlowPosition({ x: dropState.screenX, y: dropState.screenY });
    const storeState = useWorkflowStore.getState();
    const size    = getDefaultNodeSize(type, storeState.lastNodeSize);
    const isInput = dropState.isInputHandle === true;

    const position = {
      x: isInput ? flowPos.x - size.w - 20 : flowPos.x + 20,
      y: flowPos.y - size.h / 2,
    };

    const nodesInStore = storeState.nodes;
    const label  = nextNodeLabel(type, nodesInStore);

    const nodeStyle = ["imageInputNode", "videoInputNode", "generateNode", "videoGeneratorNode"].includes(type) || gameStepOf(type)
      ? { width: size.w }
      : { width: size.w, height: size.h };

    // Inherit aspect ratio from source node (output-handle direction only)
    const sourceNode    = nodesInStore.find((n) => n.id === dropState.sourceNodeId);
    const srcRatioFloat = isInput ? null : nodeAspectRatioFloat(sourceNode?.data as Record<string, unknown> | undefined);

    const extraData: Record<string, unknown> = {};

    if (!isInput) {
      const targetHandle = targetHandleFor(dropState.sourceNodeType, type, dropState.sourceHandleId);
      if (type === "videoGeneratorNode" && targetHandle) {
        const compatible = VIDEO_MODELS.find((m) => (m.handles as string[]).includes(targetHandle));
        if (compatible) {
          extraData.videoModel = compatible.id;
          if (srcRatioFloat !== null) {
            const r = closestRatio(srcRatioFloat, compatible.ratios);
            if (r) extraData.aspectRatio = r;
          }
        }
      } else if (type === "generateNode" && srcRatioFloat !== null) {
        const defaultModel = IMAGE_MODELS.find((m) => m.id === "nano-banana-2") ?? IMAGE_MODELS[0];
        const r = closestRatio(srcRatioFloat, defaultModel.ratios);
        if (r) extraData.aspectRatio = r;
      }
    }

    const nodeId = `${type}-${uid()}`;
    addNode({
      id:   nodeId,
      type,
      position,
      style: nodeStyle,
      data: { label, status: "idle", ...getLastNodeSettings(type, nodesInStore), ...extraData },
    });

    if (isInput) {
      // New node is the SOURCE; existing node is the TARGET
      const srcHandle = outputHandleForNewNode(type, dropState.sourceHandleId ?? "");
      const edge: Edge = {
        id:           `edge-${nodeId}-${dropState.sourceNodeId}`,
        source:       nodeId,
        sourceHandle: srcHandle,
        target:       dropState.sourceNodeId,
        targetHandle: dropState.sourceHandleId ?? undefined,
        animated:     false,
        style:        edgeStyle(dropState.sourceHandleId),
      };
      insertEdge(edge);
    } else {
      const targetHandle = targetHandleFor(dropState.sourceNodeType, type, dropState.sourceHandleId);
      if (targetHandle) {
        const edge: Edge = {
          id:           `edge-${dropState.sourceNodeId}-${nodeId}`,
          source:       dropState.sourceNodeId,
          sourceHandle: dropState.sourceHandleId ?? undefined,
          target:       nodeId,
          targetHandle: targetHandle ?? undefined,
          animated:     false,
          style:        edgeStyle(targetHandle),
        };
        insertEdge(edge);
      }
    }

    onClose();
  };

  // ── Pending connection line ──────────────────────────────────────────────────
  // Anchored to the dragged handle's on-screen centre; falls back to the node's
  // edge midpoint if the handle isn't in the DOM.
  const isInput = dropState.isInputHandle === true;
  const handleEl = document.querySelector(
    `.react-flow__node[data-id="${CSS.escape(dropState.sourceNodeId)}"] .react-flow__handle${
      dropState.sourceHandleId ? `[data-handleid="${CSS.escape(dropState.sourceHandleId)}"]` : isInput ? ".target" : ".source"
    }`,
  );
  let src: { x: number; y: number };
  if (handleEl) {
    const r = handleEl.getBoundingClientRect();
    src = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  } else {
    const internal = getInternalNode(dropState.sourceNodeId);
    const absX  = internal?.internals?.positionAbsolute?.x ?? 0;
    const absY  = internal?.internals?.positionAbsolute?.y ?? 0;
    const size  = NODE_SIZE[dropState.sourceNodeType ?? ""] ?? FALLBACK_SIZE;
    const nodeW = internal?.measured?.width  ?? size.w;
    const nodeH = internal?.measured?.height ?? size.h;
    src = flowToScreenPosition({ x: isInput ? absX : absX + nodeW, y: absY + nodeH / 2 });
  }
  const dst = { x: dropState.screenX, y: dropState.screenY };

  // Bezier control points — horizontal pull matching React Flow's default edge style
  const dx = Math.abs(dst.x - src.x) * 0.5;
  // For input handles the curve flows right-to-left, so flip the control points
  const svgPath = isInput
    ? [`M ${src.x} ${src.y}`, `C ${src.x - dx} ${src.y}, ${dst.x + dx} ${dst.y}, ${dst.x} ${dst.y}`].join(" ")
    : [`M ${src.x} ${src.y}`, `C ${src.x + dx} ${src.y}, ${dst.x - dx} ${dst.y}, ${dst.x} ${dst.y}`].join(" ");

  // ── Node list ────────────────────────────────────────────────────────────────
  const HANDLE_ONLY_VIDEO_GEN = new Set(["videoRefOut", "audioRefOut"]);
  const sourceStep = gameStepOf(dropState.sourceNodeType);
  // Game nodes appear only where the chain allows: after a text source (turnaround) or after the previous step.
  const gameTargetType = sourceStep
    ? gameNextType(sourceStep)
    : dropState.sourceNodeType === "promptNode" || dropState.sourceNodeType === "assistantNode"
      ? gameNodeTypeFor("turnaround")
      : undefined;
  const linkable = isInput
    ? (() => {
        const allowed = new Set(sourceNodeTypesFor(dropState.sourceHandleId));
        return NODES.filter((n) => allowed.has(n.type));
      })()
    : NODES.filter((n) => {
        if (!n.canReceiveConnection) return false;
        if (sourceStep || gameStepOf(n.type)) return n.type === gameTargetType;
        if (dropState.sourceHandleId && HANDLE_ONLY_VIDEO_GEN.has(dropState.sourceHandleId)) {
          return n.type === "videoGeneratorNode";
        }
        return true;
      });

  const menuW = 240;
  const menuH = linkable.length * 52 + 40;
  const left  = isInput
    ? Math.max(dropState.screenX - menuW - 16, 16)
    : Math.min(dropState.screenX + 16, window.innerWidth - menuW - 16);
  const top   = Math.min(dropState.screenY - 10, window.innerHeight - menuH - 16);

  return (
    <>
      {/* Animated dashed preview line from source handle to drop point */}
      <svg
        style={{
          position: "fixed",
          inset: 0,
          width: "100vw",
          height: "100vh",
          pointerEvents: "none",
          zIndex: 999,
          overflow: "visible",
        }}
      >
        <path
          d={svgPath}
          fill="none"
          strokeWidth={1.5}
          strokeDasharray="6 4"
          strokeDashoffset={0}
          strokeLinecap="round"
          className="pending-edge-line"
          style={{ stroke: "var(--edge-stroke-active)" }}
        />
      </svg>

      {/* Node picker */}
      <div
        ref={menuRef}
        style={{ position: "fixed", left, top, width: menuW, zIndex: 1000 }}
        className={cn(floatingPanelClass, "overflow-hidden p-1.5 animate-in fade-in-0 zoom-in-95 duration-150")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p className="type-label px-2.5 pt-1.5 pb-1">Connect to</p>

        {linkable.map((n) => (
          <button
            key={n.type}
            type="button"
            onClick={() => handleSelect(n.type)}
            onMouseDown={(e) => e.stopPropagation()}
            className="flex w-full items-center gap-2.5 rounded-[var(--radius)] px-2.5 py-1.5 text-left transition-colors duration-100 hover:bg-wash"
          >
            <TypeBadge accent={NODE_META[n.type]?.accent} icon={NODE_META[n.type]?.bigIcon ?? n.icon} size={30} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] leading-tight font-medium text-ink">{n.label}</span>
              <span className="truncate text-[11.5px] leading-snug text-ink-3">{n.description}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
