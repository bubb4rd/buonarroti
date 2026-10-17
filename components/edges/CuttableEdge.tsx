"use client";
import { useState, useRef, useEffect } from "react";
import {
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
  useNodes,
  type EdgeProps,
} from "@xyflow/react";
import { Scissors } from "lucide-react";
import { edgeStrokeWidth } from "@/lib/edgeStyles";

export default function CuttableEdge({
  source,
  sourceX, sourceY,
  targetX, targetY,
  sourcePosition, targetPosition,
  sourceHandleId,
  targetHandleId,
  data,
}: EdgeProps) {
  const edgeData = data as Record<string, unknown> | undefined;
  const dying    = edgeData?.dying    === true;
  const error    = edgeData?.error    === true;
  const dimmed   = edgeData?.dimmed   === true;
  const colorKey = typeof edgeData?.colorKey === "string" ? edgeData.colorKey : undefined;

  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [pathLength, setPathLength] = useState(0);
  const leaveTimer = useRef<number | null>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const { screenToFlowPosition } = useReactFlow();

  const nodes = useNodes();
  const srcNode = nodes.find((n) => n.id === source);

  const isExtractingEdge =
    !!(srcNode?.data.extractingFrame as boolean | undefined) &&
    (sourceHandleId === "startFrameOut" || sourceHandleId === "endFrameOut" || sourceHandleId === "imagePickOut");

  const strokeWidth = edgeStrokeWidth(colorKey ?? targetHandleId);

  const [edgePath] = getBezierPath({
    sourceX, sourceY, sourcePosition,
    targetX, targetY, targetPosition,
  });

  // Measure path length after render
  useEffect(() => {
    if (pathRef.current) setPathLength(pathRef.current.getTotalLength());
  }, [edgePath]);

  function handleMouseMove(e: React.MouseEvent) {
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    const cursor = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const el = pathRef.current;
    if (el) {
      const total = el.getTotalLength();
      let lo = 0, hi = total;
      let best = el.getPointAtLength(0);
      let bestDist = Infinity;
      const STEPS = 64;
      for (let i = 0; i <= STEPS; i++) {
        const pt = el.getPointAtLength((i / STEPS) * total);
        const d = Math.hypot(pt.x - cursor.x, pt.y - cursor.y);
        if (d < bestDist) {
          bestDist = d; best = pt;
          lo = Math.max(0, (i - 1) / STEPS * total);
          hi = Math.min(total, (i + 1) / STEPS * total);
        }
      }
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2;
        const ptLo = el.getPointAtLength(mid - (hi - lo) / 4);
        const ptHi = el.getPointAtLength(mid + (hi - lo) / 4);
        const dLo = Math.hypot(ptLo.x - cursor.x, ptLo.y - cursor.y);
        const dHi = Math.hypot(ptHi.x - cursor.x, ptHi.y - cursor.y);
        if (dLo < dHi) { hi = mid; best = ptLo; } else { lo = mid; best = ptHi; }
      }
      setPos({ x: best.x, y: best.y });
    } else {
      setPos(cursor);
    }
    setVisible(true);
  }

  function handleMouseLeave() {
    leaveTimer.current = window.setTimeout(() => setVisible(false), 80);
  }

  function handleBadgeEnter() {
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
  }

  return (
    <>
      {/* Visible wire — ink at rest, lapis when selected/extracting (globals.css .canvas-edge).
          Animates out right-to-left when dying. */}
      <path
        ref={pathRef}
        d={edgePath}
        fill="none"
        className={`canvas-edge${isExtractingEdge ? " canvas-edge-active" : ""}`}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={isExtractingEdge ? "6 6" : pathLength > 0 ? pathLength : undefined}
        strokeDashoffset={isExtractingEdge ? undefined : dying ? pathLength : 0}
        style={{
          pointerEvents: "none",
          opacity: dimmed ? 0.15 : 1,
          transition: dying ? "stroke-dashoffset 0.42s ease-in, opacity 150ms" : undefined,
          animation: error
            ? "edge-error-blink 1.4s ease 1 forwards"
            : isExtractingEdge
            ? "edge-extracting 0.5s linear infinite"
            : undefined,
        }}
      />

      {/* Wide transparent hit area on top */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        style={{ cursor: "pointer", pointerEvents: dying ? "none" : "stroke" }}
      />

      <EdgeLabelRenderer>
        <div
          className="absolute transition-opacity duration-150 ease-[var(--ease-out)]"
          style={{
            transform: `translate(-50%, -50%) translate(${pos.x}px, ${pos.y}px)`,
            pointerEvents: visible && !dying ? "all" : "none",
            zIndex: 10,
            opacity: visible && !dying ? 1 : 0,
          }}
          onMouseEnter={handleBadgeEnter}
          onMouseLeave={handleMouseLeave}
        >
          <div
            title="Cut wire"
            className="flex size-[26px] cursor-pointer items-center justify-center rounded-full bg-surface-raised text-ink-2 shadow-[var(--shadow-md)] transition-colors duration-150 hover:text-sanguine"
          >
            <Scissors className="size-3.5" strokeWidth={1.75} />
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
