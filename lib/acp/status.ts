// Server-only. Which ACP agents are usable, with their live model lists.
// Cached in memory and in DATA_DIR/agents-cache.json so the picker is instant
// on boot; refreshed in the background once older than 10 minutes.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IDS, isAgentId, type AgentId, type AgentInfo } from "@/lib/agentModels";
import { DATA_DIR } from "@/lib/guest/paths";
import { AgentUnavailableError, getAgent, isAuthError, stopAgent } from "./pool";
import { AGENT_SPECS, hasCodexCli } from "./registry";
import { getShellEnv } from "./shellEnv";

const CACHE_FILE = join(DATA_DIR, "agents-cache.json");
const STALE_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 20_000;
const AUTH_REPORT_WAIT_MS = 2_000;

interface StatusState {
  infos: Map<AgentId, AgentInfo> | null;
  probing: Map<AgentId, Promise<AgentInfo>>;
}

const globalForStatus = globalThis as typeof globalThis & { __buonarrotiAcpStatus?: StatusState };
const state: StatusState = (globalForStatus.__buonarrotiAcpStatus ??= { infos: null, probing: new Map() });

function base(id: AgentId): Pick<AgentInfo, "id" | "name" | "via"> {
  const spec = AGENT_SPECS[id];
  return { id, name: spec.name, via: spec.via };
}

function loadInfos(): Map<AgentId, AgentInfo> {
  if (state.infos) return state.infos;
  const infos = new Map<AgentId, AgentInfo>();
  try {
    const parsed: unknown = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    const list = parsed && typeof parsed === "object" && "agents" in parsed ? parsed.agents : null;
    if (Array.isArray(list)) {
      for (const item of list as AgentInfo[]) {
        // A probe interrupted by a restart is not a result.
        if (item && typeof item.id === "string" && isAgentId(item.id) && item.status !== "checking") {
          infos.set(item.id, item);
        }
      }
    }
  } catch {
    // no cache yet
  }
  state.infos = infos;
  return infos;
}

function saveInfos() {
  const infos = state.infos;
  if (!infos) return;
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const agents = [...infos.values()].filter((a) => a.status !== "checking");
    writeFileSync(CACHE_FILE, JSON.stringify({ agents }, null, 2));
  } catch (err) {
    console.error("[agents] could not write cache", err instanceof Error ? err.message : err);
  }
}

/** Record a status learned outside a probe (e.g. a chat turn hit an auth error). */
export function setAgentStatus(info: AgentInfo) {
  loadInfos().set(info.id, info);
  saveInfos();
}

export async function needsLoginInfo(id: AgentId, detail?: string): Promise<AgentInfo> {
  const spec = AGENT_SPECS[id];
  let setupHint = spec.loginHint;
  if (id === "codex" && !hasCodexCli(await getShellEnv())) {
    setupHint = "Install Codex CLI (`npm i -g @openai/codex`), then run `codex login` in Terminal.";
  }
  return {
    ...base(id),
    status: "needs_login",
    detail: detail ?? `${spec.name} isn't signed in on this computer.`,
    setupHint,
    models: [],
    checkedAt: Date.now(),
  };
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

async function probe(id: AgentId): Promise<AgentInfo> {
  const spec = AGENT_SPECS[id];
  let timedOut = false;
  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    timedOut = true;
    timeout.reject(new Error(`${spec.name} didn't answer within ${PROBE_TIMEOUT_MS / 1000}s.`));
  }, PROBE_TIMEOUT_MS);
  let stderr = "";
  try {
    const run = async (): Promise<AgentInfo> => {
      const agent = await getAgent(id);
      const release = agent.hold();
      try {
        stderr = agent.stderr;
        const session = await agent.newSession();
        await agent.closeSession(session.sessionId);
        if ((await agent.waitForAuthKind(id === "claude" ? AUTH_REPORT_WAIT_MS : 0)) === "none") {
          return needsLoginInfo(id);
        }
        return {
          ...base(id),
          status: session.models.length > 0 ? "ready" : "error",
          ...(session.models.length > 0
            ? {}
            : { detail: `${spec.name} started but listed no models.`, setupHint: `Update ${spec.name}, then check again.` }),
          models: session.models,
          ...(session.defaultModelId ? { defaultModelId: session.defaultModelId } : {}),
          checkedAt: Date.now(),
        };
      } catch (err) {
        stderr = agent.stderr;
        throw err;
      } finally {
        release();
      }
    };
    return await Promise.race([run(), timeout.promise]);
  } catch (err) {
    if (timedOut) stopAgent(id);
    if (err instanceof AgentUnavailableError) {
      if (err.status === "needs_login") return needsLoginInfo(id, err.message);
      return {
        ...base(id),
        status: err.status,
        detail: err.message,
        ...(err.setupHint ? { setupHint: err.setupHint } : {}),
        models: [],
        checkedAt: Date.now(),
      };
    }
    if (isAuthError(err) || isAuthError(stderr)) return needsLoginInfo(id);
    console.error(`[agents] ${id} probe failed:`, errorText(err), stderr.slice(-500));
    stopAgent(id);
    return {
      ...base(id),
      status: "error",
      detail: `${spec.name} couldn't start: ${errorText(err)}`,
      setupHint: "Check again in a moment. If it keeps failing, update the CLI and sign in again.",
      models: [],
      checkedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe one agent (deduped while in flight) and store the result. */
function probeAndStore(id: AgentId): Promise<AgentInfo> {
  const inFlight = state.probing.get(id);
  if (inFlight) return inFlight;
  const run = probe(id).then((info) => {
    loadInfos().set(id, info);
    saveInfos();
    return info;
  });
  state.probing.set(id, run);
  void run.finally(() => state.probing.delete(id));
  return run;
}

/**
 * Current agent statuses. Unknown agents report `checking` while a background
 * probe runs; stale entries are returned as-is and refreshed in the background.
 * `refresh` re-probes every agent in parallel and waits for the results.
 */
export async function listAgents({ refresh = false }: { refresh?: boolean } = {}): Promise<AgentInfo[]> {
  if (refresh) return Promise.all(AGENT_IDS.map(probeAndStore));
  const infos = loadInfos();
  const now = Date.now();
  return AGENT_IDS.map((id) => {
    const cached = infos.get(id);
    if (!cached || now - cached.checkedAt > STALE_MS) void probeAndStore(id);
    return cached ?? { ...base(id), status: "checking", models: [], checkedAt: now };
  });
}

/** Cached info for one agent (no probing). */
export function cachedAgent(id: AgentId): AgentInfo | undefined {
  return loadInfos().get(id);
}
