"use client";
import { useCallback, useEffect, useState } from "react";
import { useReactFlow, Node } from "@xyflow/react";
import { LayoutGrid, Group, Copy, Trash2 } from "lucide-react";
import { useWorkflowStore, NodeData } from "@/lib/store";
import { arrangeNodes } from "@/lib/arrangeNodes";
import { FloatingBar, ToolbarButton, ToolbarSeparator } from "@/components/ui/floating-toolbar";
import { GROUP_COLORS } from "@/components/nodes/GroupNode";

const GROUP_PADDING = 24;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function getAbsoluteBounds(nodes: Node[]) {
  if (!nodes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const w = (n.measured?.width  ?? n.width  ?? 240);
    const h = (n.measured?.height ?? n.height ?? 160);
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// Runs inside the ReactFlow provider
export default function SelectionToolbar() {
  const { flowToScreenPosition } = useReactFlow();
  const nodes      = useWorkflowStore((s) => s.nodes);
  const edges      = useWorkflowStore((s) => s.edges);
  const onNodesChange = useWorkflowStore((s) => s.onNodesChange);
  const addNode    = useWorkflowStore((s) => s.addNode);
  const insertEdge = useWorkflowStore((s) => s.insertEdge);

  // Selected non-group nodes — hide entirely when a group is selected (group has its own toolbar)
  const anyGroupSelected = nodes.some((n) => n.selected && n.type === "groupNode");
  const selected = nodes.filter((n) => n.selected && n.type !== "groupNode");
  const visible  = selected.length >= 2 && !anyGroupSelected;

  // For smooth animation we track mounted
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (visible) {
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    } else {
      setShown(false);
    }
  }, [visible]);

  // Compute screen position (top-center of selection bounding box)
  const bounds = getAbsoluteBounds(selected);
  const screenPos = bounds
    ? flowToScreenPosition({ x: bounds.x + bounds.width / 2, y: bounds.y })
    : null;

  // ── Arrange ─────────────────────────────────────────────────────────────────
  const handleArrange = useCallback(() => {
    const sel = useWorkflowStore.getState().nodes.filter((n) => n.selected && n.type !== "groupNode");
    arrangeNodes(sel.map((n) => n.id));
  }, []);

  // ── Group ───────────────────────────────────────────────────────────────────
  const handleGroup = useCallback(() => {
    const state = useWorkflowStore.getState();
    const sel   = state.nodes.filter((n) => n.selected && n.type !== "groupNode");
    if (sel.length === 0) return;

    const b = getAbsoluteBounds(sel);
    if (!b) return;

    const gx = b.x - GROUP_PADDING;
    const gy = b.y - GROUP_PADDING;
    const gw = b.width  + GROUP_PADDING * 2;
    const gh = b.height + GROUP_PADDING * 2;
    const groupId = uid();

    const memberIds = sel.map((n) => n.id);
    const groupCount = (state.nodeCounters["groupNode"] ?? 0) + 1;

    // Create group node — members stay at absolute positions (no parentId)
    const groupNode: Node<NodeData> = {
      id:       groupId,
      type:     "groupNode",
      position: { x: gx, y: gy },
      style:    { width: gw, height: gh, zIndex: -1 },
      data:     { label: `Group #${groupCount}`, color: GROUP_COLORS[0], locked: false, memberIds } as NodeData,
      selected: true,
      zIndex:   -1,
    };

    // Deselect member nodes; they keep absolute positions — no parentId
    const newNodes = state.nodes.map((n) => ({ ...n, selected: false }));

    // Insert group at front so it renders behind members
    const nodesWithGroup = [groupNode, ...newNodes];

    useWorkflowStore.setState((s) => ({
      nodes: nodesWithGroup,
      nodeCounters: { ...s.nodeCounters, groupNode: groupCount },
      spaces: s.spaces.map((sp) =>
        sp.id === s.activeSpaceId
          ? { ...sp, nodes: nodesWithGroup, nodeCounters: { ...s.nodeCounters, groupNode: groupCount } }
          : sp
      ),
    }));
  }, []);

  // ── Delete selection ────────────────────────────────────────────────────────
  const handleDelete = useCallback(() => {
    const state = useWorkflowStore.getState();
    const ids   = state.nodes.filter((n) => n.selected && n.type !== "groupNode").map((n) => n.id);
    onNodesChange(ids.map((id) => ({ type: "remove" as const, id })));
  }, [onNodesChange]);

  // ── Duplicate selection ─────────────────────────────────────────────────────
  const handleDuplicate = useCallback(() => {
    const state  = useWorkflowStore.getState();
    const sel    = state.nodes.filter((n) => n.selected && n.type !== "groupNode");
    const idMap: Record<string, string> = {};
    sel.forEach((n) => { idMap[n.id] = uid(); });

    // Deselect originals
    onNodesChange(sel.map((n) => ({ type: "select" as const, id: n.id, selected: false })));

    sel.forEach((n) => {
      addNode({
        ...n,
        id:       idMap[n.id],
        position: { x: n.position.x + 20, y: n.position.y + 20 },
        selected: true,
        data:     { ...n.data, status: "idle" as const, taskId: undefined, hasError: false },
      });
    });

    // Copy edges within the selection
    state.edges
      .filter((e) => idMap[e.source] && idMap[e.target])
      .forEach((e) => insertEdge({
        ...e,
        id:     uid(),
        source: idMap[e.source],
        target: idMap[e.target],
      }));
  }, [onNodesChange, addNode, insertEdge]);

  if (!screenPos) return null;

  return (
    <div
      className="transition-[opacity,transform] duration-200 ease-[var(--ease-out)]"
      style={{
        position: "fixed",
        left:     screenPos.x,
        top:      screenPos.y - 52,
        transform: `translateX(-50%) translateY(${shown ? "0px" : "6px"})`,
        opacity:   shown ? 1 : 0,
        zIndex:    9998,
        pointerEvents: shown ? "auto" : "none",
      }}
    >
      <FloatingBar>
        <ToolbarButton onClick={handleArrange} tooltip="Tidy up">
          <LayoutGrid strokeWidth={1.75} />
        </ToolbarButton>
        <ToolbarButton onClick={handleGroup} tooltip="Group">
          <Group strokeWidth={1.75} />
        </ToolbarButton>
        <ToolbarSeparator />
        <ToolbarButton onClick={handleDuplicate} tooltip="Duplicate">
          <Copy strokeWidth={1.75} />
        </ToolbarButton>
        <ToolbarButton onClick={handleDelete} tooltip="Delete" shortcut="⌫" danger>
          <Trash2 strokeWidth={1.75} />
        </ToolbarButton>
      </FloatingBar>
    </div>
  );
}
