"use client";
import React from "react";
import { Plus, MousePointer2, Hand, Undo2, Redo2, Download } from "lucide-react";
import { FloatingBar, ToolbarButton, ToolbarSeparator } from "@/components/ui/floating-toolbar";

type ToolId = "select" | "hand";

interface CanvasToolbarProps {
  activeTool: ToolId;
  onToolChange: (tool: ToolId) => void;
  onAddNode: (anchorRect: DOMRect) => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onExport: () => void;
  exporting: boolean;
}

/** Left-middle canvas tools: add, select/hand, undo/redo, export. */
export default function CanvasToolbar({
  activeTool,
  onToolChange,
  onAddNode,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onExport,
  exporting,
}: CanvasToolbarProps) {
  return (
    <FloatingBar
      id="canvas-toolbar"
      orientation="vertical"
      className="absolute top-1/2 left-4 z-[100] -translate-y-1/2 gap-1 p-1.5 [&_[data-slot=toolbar-button]]:size-8 [&_svg]:size-4"
    >
      <ToolbarButton
        id="toolbar-add"
        tooltip="Add to canvas"
        shortcut="A"
        tooltipSide="right"
        stopPropagation={false}
        onClick={(e) => onAddNode(e.currentTarget.getBoundingClientRect())}
        className="bg-lapis text-lapis-ink hover:bg-lapis-hover hover:text-lapis-ink"
      >
        <Plus strokeWidth={2.25} />
      </ToolbarButton>

      <ToolbarSeparator orientation="horizontal" />

      <ToolbarButton
        id="toolbar-select"
        tooltip="Select"
        shortcut="V"
        tooltipSide="right"
        stopPropagation={false}
        active={activeTool === "select"}
        onClick={() => onToolChange("select")}
      >
        <MousePointer2 strokeWidth={1.75} />
      </ToolbarButton>

      <ToolbarButton
        id="toolbar-hand"
        tooltip="Pan"
        shortcut="H"
        tooltipSide="right"
        stopPropagation={false}
        active={activeTool === "hand"}
        onClick={() => onToolChange("hand")}
      >
        <Hand strokeWidth={1.75} />
      </ToolbarButton>

      <ToolbarSeparator orientation="horizontal" />

      <ToolbarButton
        id="toolbar-undo"
        tooltip="Undo"
        shortcut="⌘Z"
        tooltipSide="right"
        stopPropagation={false}
        disabled={!canUndo}
        onClick={onUndo}
      >
        <Undo2 strokeWidth={1.75} />
      </ToolbarButton>

      <ToolbarButton
        id="toolbar-redo"
        tooltip="Redo"
        shortcut="⇧⌘Z"
        tooltipSide="right"
        stopPropagation={false}
        disabled={!canRedo}
        onClick={onRedo}
      >
        <Redo2 strokeWidth={1.75} />
      </ToolbarButton>

      <ToolbarSeparator orientation="horizontal" />

      <ToolbarButton
        id="toolbar-export"
        tooltip={exporting ? "Exporting…" : "Export workflow (.zip)"}
        tooltipSide="right"
        stopPropagation={false}
        aria-busy={exporting}
        onClick={() => { if (!exporting) onExport(); }}
        className={exporting ? "cursor-wait text-lapis" : undefined}
      >
        <Download strokeWidth={1.75} style={exporting ? { animation: "spin 1s linear infinite" } : undefined} />
      </ToolbarButton>
    </FloatingBar>
  );
}
