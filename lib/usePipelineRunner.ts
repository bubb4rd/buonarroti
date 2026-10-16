import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react";
import type { Node } from "@xyflow/react";
import { useWorkflowStore, type NodeData } from "./store";
import { buildPipelineWaves } from "./executor";

interface PipelineState {
  waves: string[][];
  waveIdx: number;
}

// ── Submit outcomes ───────────────────────────────────────────────────────────
// A generator node keeps `pendingGenerate: true` until its submit phase has
// settled, then reports whether a job actually started. That way a node that
// fails validation (empty prompt, missing input) can't stall a wave.

type SubmitListener = (nodeId: string, started: boolean) => void;
const submitListeners = new Set<SubmitListener>();

export function reportGenerateSubmitted(nodeId: string, started: boolean) {
  for (const l of submitListeners) l(nodeId, started);
}

export function usePipelineRunner(scopeNodeIds?: string[]) {
  const nodes = useWorkflowStore(s => s.nodes);
  const updateNodeData = useWorkflowStore(s => s.updateNodeData);
  const addToast = useWorkflowStore(s => s.addToast);

  const [pipeline, setPipeline] = useState<PipelineState | null>(null);
  const failedRef = useRef(new Set<string>());
  const scopeRef = useRef(scopeNodeIds);
  useLayoutEffect(() => { scopeRef.current = scopeNodeIds; });

  const isRunning = pipeline !== null;

  const scopedNodes = scopeNodeIds
    ? nodes.filter(n => scopeNodeIds.includes(n.id))
    : nodes;

  const genNodeCount = scopedNodes.filter(
    n => n.type === "generateNode" || n.type === "videoGeneratorNode"
  ).length;

  const startWave = useCallback((ids: string[]) => {
    for (const id of ids) {
      updateNodeData(id, { pendingGenerate: true, pipelineQueued: false });
    }
  }, [updateNodeData]);

  const run = useCallback(() => {
    if (pipeline) return;
    const { nodes, edges } = useWorkflowStore.getState();
    const scope = scopeRef.current;
    const filteredNodes = scope ? nodes.filter(n => scope.includes(n.id)) : nodes;
    const waves = buildPipelineWaves(filteredNodes, edges);
    if (waves.length === 0) return;

    // Mark future-wave nodes as queued so they show a waiting indicator
    for (let i = 1; i < waves.length; i++) {
      for (const id of waves[i]) {
        updateNodeData(id, { pipelineQueued: true });
      }
    }

    failedRef.current = new Set();
    startWave(waves[0]);
    setPipeline({ waves, waveIdx: 0 });
  }, [pipeline, startWave, updateNodeData]);

  // Collect nodes whose submit phase bailed before a job started.
  useEffect(() => {
    if (!pipeline) return;
    const wave = new Set(pipeline.waves[pipeline.waveIdx]);
    const listener: SubmitListener = (nodeId, started) => {
      if (!started && wave.has(nodeId)) failedRef.current.add(nodeId);
    };
    submitListeners.add(listener);
    return () => { submitListeners.delete(listener); };
  }, [pipeline]);

  // Clear any leftover queued flags when the pipeline ends (e.g. early error)
  useEffect(() => {
    if (pipeline !== null) return;
    const { nodes } = useWorkflowStore.getState();
    const scope = scopeRef.current;
    const scoped = scope ? nodes.filter(n => scope.includes(n.id)) : nodes;
    for (const node of scoped) {
      if (node.data.pipelineQueued) updateNodeData(node.id, { pipelineQueued: false });
    }
  }, [pipeline, updateNodeData]);

  // Advance waves as node state changes. Runs in a store subscription so state
  // updates happen in a callback, not synchronously in the effect body.
  useEffect(() => {
    if (!pipeline) return;
    const { waves, waveIdx } = pipeline;
    const currentWave = waves[waveIdx];
    let finished = false;

    const check = (nodes: Node<NodeData>[]) => {
      if (finished) return;
      // A node is settled once it has consumed its trigger and has no job in flight.
      const allSettled = currentWave.every(id => {
        const node = nodes.find(n => n.id === id);
        if (!node) return true;
        const s = node.data.status;
        return !node.data.pendingGenerate && s !== "pending" && s !== "running";
      });
      if (!allSettled) return;
      finished = true;

      const failed = currentWave.filter(id => {
        const node = nodes.find(n => n.id === id);
        return failedRef.current.has(id) || node?.data.status === "error";
      });

      // Terminal: stop rather than feed downstream nodes missing inputs.
      if (failed.length > 0) {
        const names = failed
          .map(id => nodes.find(n => n.id === id)?.data.label as string | undefined)
          .filter(Boolean)
          .join(", ");
        addToast(
          `${names || "A node"} didn't finish, so the run stopped. Fix it, then run again.`,
          "error",
        );
        setPipeline(null);
        return;
      }

      const nextIdx = waveIdx + 1;
      if (nextIdx >= waves.length) {
        setPipeline(null);
      } else {
        failedRef.current = new Set();
        startWave(waves[nextIdx]);
        setPipeline({ waves, waveIdx: nextIdx });
      }
    };

    const unsubscribe = useWorkflowStore.subscribe((s) => check(s.nodes));
    queueMicrotask(() => check(useWorkflowStore.getState().nodes));
    return () => { finished = true; unsubscribe(); };
  }, [pipeline, startWave, addToast]);

  return { run, isRunning, genNodeCount };
}
