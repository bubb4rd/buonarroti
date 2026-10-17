import type { Node } from "@xyflow/react";
import type { NodeData } from "./store";

/**
 * What a workflow is doing, for the sidebar and the workflows dashboard.
 * `generating`: nodes with a job in flight or waiting in a pipeline run.
 * `attention`: nodes whose last run failed, was interrupted or was rejected by
 * its checks; they stay flagged until the user re-runs or clears them.
 */
export interface WorkflowActivity {
  generating: number;
  attention: number;
}

export function workflowActivity(nodes: Node<NodeData>[]): WorkflowActivity {
  let generating = 0;
  let attention = 0;
  for (const { data } of nodes) {
    if (!data) continue;
    if (data.status === "running" || data.status === "pending" || data.pendingGenerate || data.pipelineQueued) generating++;
    else if (data.status === "error") attention++;
  }
  return { generating, attention };
}
