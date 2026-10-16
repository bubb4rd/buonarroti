import type { CSSProperties } from "react";

/**
 * Wires are ink at rest and lapis when selected or in flight (see the
 * `.canvas-edge` rules in app/globals.css). Per-type colour lives on the
 * handles, not the wires.
 */
export const EDGE_STROKE = "var(--edge-stroke)";
export const EDGE_STROKE_ACTIVE = "var(--edge-stroke-active)";

// Handles that carry image data get a slightly heavier stroke
const IMAGE_HANDLES: Record<string, true> = { image: true, startFrame: true, endFrame: true, resource: true };

/** Stroke width for a wire ending at `targetHandle`. */
export function edgeStrokeWidth(targetHandle?: string | null): number {
  return IMAGE_HANDLES[targetHandle ?? ""] ? 2 : 1.5;
}

/** Inline style stored on new edges. CuttableEdge styles itself from CSS; this keeps other renderers consistent. */
export function edgeStyle(targetHandle?: string | null | undefined): CSSProperties {
  return { stroke: EDGE_STROKE, strokeWidth: edgeStrokeWidth(targetHandle) };
}
