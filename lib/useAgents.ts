"use client";

import { useEffect } from "react";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { parseAcpModelId, toAcpModelId, type AgentInfo, type AgentModel } from "./agentModels";
import { DEFAULT_CHAT_MODEL, useChatSessionStore } from "./chatSessionStore";

// ── Store: GET /api/agents, last result kept in localStorage ────────────────

const STORAGE_KEY = "buonarroti-agents";
/** While the server still reports an agent as "checking", ask again this often… */
const CHECKING_POLL_MS = 2500;
/** …but give up after this many tries (the server keeps probing; "Check again" re-asks). */
const CHECKING_POLL_MAX = 24;

interface AgentsState {
  /** Last known agents (from this session's fetch, or localStorage until it lands). */
  agents: AgentInfo[];
  /** A request to /api/agents is in flight. */
  loading: boolean;
  /** /api/agents answered at least once this app session. */
  fetched: boolean;
  /** Fetch once per app session; later calls are no-ops. */
  ensureLoaded: () => void;
  /** Ask the server to probe every agent again. */
  refresh: () => Promise<void>;
}

let started = false;
let pollTimer: number | undefined;
let pollCount = 0;
/** Only the newest request may write; a forced refresh supersedes an in-flight poll. */
let requestSeq = 0;

export const useAgentsStore = create<AgentsState>()(
  persist(
    (set) => {
      async function load(force: boolean): Promise<void> {
        clearTimeout(pollTimer);
        pollTimer = undefined;
        const seq = ++requestSeq;
        set({ loading: true });
        try {
          const res = await fetch(force ? "/api/agents?refresh=1" : "/api/agents", { cache: "no-store" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const data = (await res.json()) as { agents?: AgentInfo[] };
          if (seq !== requestSeq) return;
          const agents = Array.isArray(data.agents) ? data.agents : [];
          set({ agents, fetched: true, loading: false });
          if (force) pollCount = 0;
          if (agents.some((a) => a.status === "checking") && pollCount < CHECKING_POLL_MAX) {
            pollCount += 1;
            pollTimer = window.setTimeout(() => void load(false), CHECKING_POLL_MS);
          }
        } catch {
          // Keep the last known agents; pickers stay usable and "Check again" can retry.
          if (seq === requestSeq) set({ loading: false, fetched: true });
        }
      }

      return {
        agents: [],
        loading: false,
        fetched: false,
        ensureLoaded: () => {
          if (started) return;
          started = true;
          void load(false);
        },
        refresh: async () => {
          started = true;
          await load(true);
        },
      };
    },
    {
      name: STORAGE_KEY,
      version: 1,
      // Throwing here makes persist a no-op during server rendering.
      storage: createJSONStorage(() => {
        if (typeof window === "undefined") throw new Error("localStorage is unavailable on the server");
        return localStorage;
      }),
      partialize: (s) => ({ agents: s.agents }),
    },
  ),
);

/** Agents for pickers and Settings; triggers the once-per-session fetch. */
export function useAgents(): Pick<AgentsState, "agents" | "loading" | "fetched" | "refresh"> {
  const agents = useAgentsStore((s) => s.agents);
  const loading = useAgentsStore((s) => s.loading);
  const fetched = useAgentsStore((s) => s.fetched);
  const refresh = useAgentsStore((s) => s.refresh);
  useEffect(() => useAgentsStore.getState().ensureLoaded(), []);
  return { agents, loading, fetched, refresh };
}

// ── Resolving `acp:<agent>:<model>` ids ─────────────────────────────────────

export interface ResolvedAcpModel {
  agentId: string;
  modelValue: string;
  agent?: AgentInfo;
  /** Present when the agent is ready and still offers this model. */
  model?: AgentModel;
}

/** Looks up an `acp:` id in the known agents; `null` for non-ACP ids. */
export function resolveAcpModel(agents: AgentInfo[], id: string): ResolvedAcpModel | null {
  const parsed = parseAcpModelId(id);
  if (!parsed) return null;
  const agent = agents.find((a) => a.id === parsed.agentId);
  const model = agent?.status === "ready" ? agent.models.find((m) => m.id === parsed.modelValue) : undefined;
  return { ...parsed, agent, model };
}

// ── Default model for new chats ─────────────────────────────────────────────

/**
 * Claude's own default, else its strongest listed model (Opus first), as an
 * `acp:` id; `null` unless Claude is ready.
 */
export function claudeDefaultModel(agents: AgentInfo[]): string | null {
  const claude = agents.find((a) => a.id === "claude");
  if (!claude || claude.status !== "ready" || claude.models.length === 0) return null;
  const pick =
    claude.models.find((m) => m.id === claude.defaultModelId) ??
    claude.models.find((m) => /opus/i.test(m.id) || /opus/i.test(m.name)) ??
    claude.models[0];
  return toAcpModelId("claude", pick.id);
}

/** Model a new chat starts on (reactive): the user's explicit pick, else Claude when ready, else kie.ai. */
export function useDefaultChatModel(): string {
  const preferred = useChatSessionStore((s) => s.preferredModel);
  const { agents } = useAgents();
  return preferred ?? claudeDefaultModel(agents) ?? DEFAULT_CHAT_MODEL;
}

/** `useDefaultChatModel`, read outside React. */
export function getDefaultChatModel(): string {
  return (
    useChatSessionStore.getState().preferredModel ??
    claudeDefaultModel(useAgentsStore.getState().agents) ??
    DEFAULT_CHAT_MODEL
  );
}
