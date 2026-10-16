// Isomorphic helpers + shared types for ACP (Agent Client Protocol) agents.
// Safe to import from client components — no node imports here.

export type AgentId = "claude" | "codex" | "gemini";

export const AGENT_IDS: readonly AgentId[] = ["claude", "codex", "gemini"];

export interface AgentModel {
  id: string;
  name: string;
  description?: string;
}

export type AgentStatus = "ready" | "needs_login" | "not_installed" | "error" | "checking";

export interface AgentInfo {
  id: AgentId;
  name: string;
  via: string;
  status: AgentStatus;
  detail?: string;
  setupHint?: string;
  models: AgentModel[];
  defaultModelId?: string;
  checkedAt: number;
}

const PREFIX = "acp:";

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

export function isAcpModelId(id: string | null | undefined): boolean {
  return typeof id === "string" && parseAcpModelId(id) !== null;
}

/** `acp:<agentId>:<modelValue>` → parts. Model values may themselves contain `:`. */
export function parseAcpModelId(
  id: string,
): { agentId: AgentId; modelValue: string } | null {
  if (!id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  const agentId = rest.slice(0, sep);
  const modelValue = rest.slice(sep + 1);
  if (!isAgentId(agentId) || !modelValue) return null;
  return { agentId, modelValue };
}

export function toAcpModelId(agentId: AgentId, modelValue: string): string {
  return `${PREFIX}${agentId}:${modelValue}`;
}
