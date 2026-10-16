"use client";
import React from "react";
import { NodeToolbar, Position } from "@xyflow/react";
import { Copy, Download, Loader2, Maximize2, Trash2 } from "lucide-react";
import { FloatingBar, ToolbarButton, ToolbarSeparator } from "@/components/ui/floating-toolbar";

interface Props {
  visible: boolean;
  hasContent: boolean;
  isSaving?: boolean;
  onPreview?: () => void;
  onDelete: () => void;
  onSave?: () => void;
  onDuplicate: () => void;
}

/** Floating actions above a selected media node: preview, duplicate, delete, save. */
export default function NodeActionBar({ visible, hasContent, isSaving, onPreview, onDelete, onSave, onDuplicate }: Props) {
  return (
    <NodeToolbar isVisible={visible} position={Position.Top} offset={16}>
      <FloatingBar className="node-action-bar-enter relative z-10">
        {onPreview !== undefined && (
          <>
            <ToolbarButton onClick={onPreview} disabled={!hasContent} tooltip="Open preview">
              <Maximize2 strokeWidth={1.75} />
            </ToolbarButton>
            <ToolbarSeparator />
          </>
        )}

        <ToolbarButton onClick={onDuplicate} tooltip="Duplicate">
          <Copy strokeWidth={1.75} />
        </ToolbarButton>

        <ToolbarButton onClick={onDelete} tooltip="Delete" shortcut="⌫" danger>
          <Trash2 strokeWidth={1.75} />
        </ToolbarButton>

        {onSave !== undefined && (
          <ToolbarButton
            onClick={onSave}
            disabled={!hasContent || isSaving}
            tooltip={isSaving ? "Downloading…" : "Save to disk"}
          >
            {isSaving ? <Loader2 strokeWidth={1.75} className="size-3.5 animate-spin" /> : <Download strokeWidth={1.75} />}
          </ToolbarButton>
        )}
      </FloatingBar>
    </NodeToolbar>
  );
}
