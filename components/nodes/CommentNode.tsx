"use client";
import { useCallback } from "react";
import { NodeProps, Node, NodeResizer } from "@xyflow/react";
import { MessageSquare, Trash2 } from "lucide-react";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { useReadOnly } from "@/lib/readOnlyContext";
import { ToolbarButton } from "@/components/ui/floating-toolbar";

type CommentNodeType = Node<NodeData, "commentNode">;

/** A sticky note: ochre-tinted paper, free text. */
export default function CommentNode({ id, data, selected }: NodeProps<CommentNodeType>) {
  const readOnly = useReadOnly();
  const updateNodeData = useWorkflowStore((s) => s.updateNodeData);
  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);

  const editable = selected && !readOnly;

  const handleDelete = useCallback(() => {
    onNodesChange([{ type: "remove", id }]);
  }, [id, onNodesChange]);

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-lg)] transition-shadow duration-150"
      style={{
        background: "color-mix(in srgb, var(--ochre) 9%, var(--surface))",
        boxShadow: selected
          ? "0 0 0 1.5px var(--ochre), var(--shadow-md)"
          : "inset 0 0 0 1px rgb(var(--ochre-rgb) / 0.28), var(--shadow-sm)",
      }}
    >
      <NodeResizer
        isVisible={editable}
        minWidth={140}
        minHeight={90}
        color="var(--ochre)"
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
      />

      {/* Header — doubles as the drag handle */}
      <div className="flex items-center justify-between gap-2 border-b border-[rgb(var(--ochre-rgb)/0.2)] px-3 py-1.5 select-none">
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-ochre">
          <MessageSquare className="size-3" strokeWidth={2} />
          Comment
        </span>
        {editable && (
          <ToolbarButton onClick={handleDelete} tooltip="Delete comment" danger className="nodrag size-5">
            <Trash2 className="size-3" strokeWidth={1.75} />
          </ToolbarButton>
        )}
      </div>

      {/* Editable only while selected, so an unselected note drags from anywhere on its body. */}
      <textarea
        className="nodrag nowheel w-full flex-1 resize-none bg-transparent p-3 text-[13px] leading-relaxed text-ink placeholder:text-ink-4 focus:outline-none"
        style={{ pointerEvents: editable ? "auto" : "none" }}
        placeholder="Write a comment…"
        value={(data.comment as string) ?? ""}
        readOnly={readOnly}
        onChange={(e) => updateNodeData(id, { comment: e.target.value })}
      />
    </div>
  );
}
