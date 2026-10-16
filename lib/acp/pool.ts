// Server-only. One warm ACP agent process per agent id: lazy start, restart
// after a crash, killed after 10 idle minutes and when this server exits.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type InitializeResponse,
  type NewSessionResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AgentId, AgentModel } from "@/lib/agentModels";
import { DATA_DIR } from "@/lib/guest/paths";
import { AGENT_SPECS } from "./registry";
import { getShellEnv } from "./shellEnv";

const IDLE_KILL_MS = 10 * 60_000;
const START_TIMEOUT_MS = 20_000;
const STDERR_TAIL = 4096;

export type SessionUpdate = SessionNotification["update"];
export type SessionUpdateHandler = (update: SessionUpdate) => void;

/** A launch/auth failure with a user-facing explanation. */
export class AgentUnavailableError extends Error {
  constructor(
    readonly status: "not_installed" | "needs_login" | "error",
    message: string,
    readonly setupHint?: string,
  ) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

/** ACP's `authRequired` (-32000), or an agent error whose text says so. */
export function isAuthError(err: unknown): boolean {
  if (err instanceof RequestError && err.code === RequestError.authRequired().code) return true;
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /auth(entication)? required|not (logged|signed) in|please (log|sign) ?in|\/login|invalid api key|unauthori[sz]ed/i.test(text);
}

/** Empty per-agent working directory: the agent never sees a real project. */
export function sandboxDir(agentId: AgentId): string {
  const dir = join(DATA_DIR, "agent-sandbox", agentId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface SessionInfo {
  sessionId: string;
  models: AgentModel[];
  defaultModelId?: string;
}

interface LegacyModelState {
  currentModelId?: string;
  availableModels?: { modelId: string; name?: string; description?: string | null }[];
}

/** Pull the model list out of `session/new`: the `model` config option, else legacy `models`. */
function readModels(resp: NewSessionResponse): { models: AgentModel[]; current?: string; legacy: boolean } {
  const option = resp.configOptions?.find(
    (o: SessionConfigOption) => o.type === "select" && (o.category === "model" || o.id === "model"),
  );
  if (option && option.type === "select") {
    const flat = option.options.flatMap((o) => ("group" in o ? o.options : [o]));
    return {
      models: flat.map((o) => ({ id: o.value, name: o.name, ...(o.description ? { description: o.description } : {}) })),
      current: option.currentValue,
      legacy: false,
    };
  }
  const legacy: LegacyModelState | undefined =
    "models" in resp && resp.models && typeof resp.models === "object" ? (resp.models as LegacyModelState) : undefined;
  return {
    models: (legacy?.availableModels ?? []).map((m) => ({
      id: m.modelId,
      name: m.name || m.modelId,
      ...(m.description ? { description: m.description } : {}),
    })),
    current: legacy?.currentModelId,
    legacy: true,
  };
}

/**
 * Drop the "default" pseudo-model when a concrete option is named in it
 * (Claude: "Default (recommended)" → "Haiku 5.5"); otherwise keep it, labelled.
 */
function tidyModels(models: AgentModel[], current?: string): { models: AgentModel[]; defaultModelId?: string } {
  const pseudo = models.find((m) => m.id === "default");
  if (!pseudo) return { models, defaultModelId: current ?? models[0]?.id };
  const rest = models.filter((m) => m !== pseudo);
  const label = `${pseudo.name} ${pseudo.description ?? ""}`.toLowerCase();
  const equivalent = rest.find((m) => label.includes(m.name.toLowerCase()));
  if (equivalent) {
    return { models: rest, defaultModelId: current === "default" || !current ? equivalent.id : current };
  }
  const labelled = pseudo.name.toLowerCase().includes("default") ? pseudo : { ...pseudo, name: `Default (${pseudo.name})` };
  return { models: [labelled, ...rest], defaultModelId: current ?? labelled.id };
}

export class AgentProcess {
  readonly conn: ClientSideConnection;
  init!: InitializeResponse;
  dead = false;
  private stderrTail = "";
  private readonly handlers = new Map<string, SessionUpdateHandler>();
  /** Current model value per session, as last set/reported. */
  private readonly sessionModels = new Map<string, { value?: string; legacy: boolean }>();
  private holds = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private readonly exitWaiters = new Set<(detail: string) => void>();
  private readonly authWaiters = new Set<() => void>();
  /** Last `_auth/status_update` kind, when the agent reports one. */
  authKind: string | undefined;

  constructor(
    readonly id: AgentId,
    private readonly child: ChildProcess,
  ) {
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
    });
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    this.conn = new ClientSideConnection(
      () => ({
        // Never let an agent act: reject every tool permission request.
        requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
          const reject =
            params.options.find((o) => o.kind === "reject_always") ??
            params.options.find((o) => o.kind === "reject_once");
          return reject
            ? { outcome: { outcome: "selected", optionId: reject.optionId } }
            : { outcome: { outcome: "cancelled" } };
        },
        sessionUpdate: async (n: SessionNotification) => {
          this.handlers.get(n.sessionId)?.(n.update);
        },
        // Claude's adapter pushes its sign-in state (`kind: "none"` = signed out).
        extNotification: async (method: string, params: Record<string, unknown>) => {
          if (method !== "_auth/status_update") return;
          const status = params.authStatus;
          if (status && typeof status === "object" && "kind" in status && typeof status.kind === "string") {
            this.authKind = status.kind;
            for (const waiter of this.authWaiters) waiter();
            this.authWaiters.clear();
          }
        },
      }),
      stream,
    );
    const onGone = () => this.markDead();
    child.once("exit", onGone);
    child.once("error", (err) => {
      this.stderrTail += `\n${err.message}`;
      onGone();
    });
    this.conn.signal.addEventListener("abort", onGone);
  }

  /** Last lines the agent wrote to stderr (for logs and auth detection). */
  get stderr(): string {
    return this.stderrTail;
  }

  /** Wait (bounded) for the agent's first sign-in report, if it sends one. */
  async waitForAuthKind(ms: number): Promise<string | undefined> {
    if (this.authKind !== undefined || this.dead) return this.authKind;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.authWaiters.add(resolve);
    const timer = setTimeout(resolve, ms);
    await promise;
    clearTimeout(timer);
    this.authWaiters.delete(resolve);
    return this.authKind;
  }

  private markDead() {
    if (this.dead) return;
    this.dead = true;
    clearTimeout(this.idleTimer);
    pool().children.delete(this.child);
    if (pool().agents.get(this.id)?.process === this) pool().agents.delete(this.id);
    if (this.child.exitCode === null && !this.child.killed) this.child.kill("SIGTERM");
    const detail = this.stderrTail.trim().split("\n").slice(-3).join(" ").slice(0, 400);
    for (const waiter of this.exitWaiters) waiter(detail);
    this.exitWaiters.clear();
    this.handlers.clear();
  }

  /** Resolves (with a stderr excerpt) if the process dies; call the returned fn to stop listening. */
  onExit(cb: (detail: string) => void): () => void {
    if (this.dead) {
      const tail = this.stderrTail;
      queueMicrotask(() => cb(tail));
      return () => {};
    }
    this.exitWaiters.add(cb);
    return () => this.exitWaiters.delete(cb);
  }

  kill() {
    this.markDead();
  }

  /** Keep the process alive while in use; the returned release restarts the idle clock. */
  hold(): () => void {
    this.holds++;
    clearTimeout(this.idleTimer);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holds--;
      this.touch();
    };
  }

  private touch() {
    clearTimeout(this.idleTimer);
    if (this.holds > 0 || this.dead) return;
    this.idleTimer = setTimeout(() => this.kill(), IDLE_KILL_MS);
    this.idleTimer.unref?.();
  }

  onUpdate(sessionId: string, handler: SessionUpdateHandler): () => void {
    this.handlers.set(sessionId, handler);
    return () => {
      if (this.handlers.get(sessionId) === handler) this.handlers.delete(sessionId);
    };
  }

  async newSession(systemPrompt?: string): Promise<SessionInfo> {
    const spec = AGENT_SPECS[this.id];
    const meta = spec.sessionMeta(systemPrompt);
    const resp = await this.conn.newSession({
      cwd: sandboxDir(this.id),
      mcpServers: [],
      ...(meta ? { _meta: meta } : {}),
    });
    const { models, current, legacy } = readModels(resp);
    this.sessionModels.set(resp.sessionId, { value: current, legacy });
    this.touch();
    return { sessionId: resp.sessionId, ...tidyModels(models, current) };
  }

  async setModel(sessionId: string, value: string): Promise<void> {
    const state = this.sessionModels.get(sessionId);
    if (state?.value === value) return;
    if (state?.legacy) {
      await this.conn.request("session/set_model", { sessionId, modelId: value });
    } else {
      await this.conn.setSessionConfigOption({ sessionId, configId: "model", value });
    }
    this.sessionModels.set(sessionId, { value, legacy: state?.legacy ?? false });
  }

  async closeSession(sessionId: string): Promise<void> {
    this.sessionModels.delete(sessionId);
    this.handlers.delete(sessionId);
    if (this.dead || !this.init.agentCapabilities?.sessionCapabilities?.close) return;
    await this.conn.closeSession({ sessionId }).catch(() => {});
  }
}

interface PoolState {
  agents: Map<AgentId, { process?: AgentProcess; starting: Promise<AgentProcess> }>;
  children: Set<ChildProcess>;
  exitHooked: boolean;
}

const globalForPool = globalThis as typeof globalThis & { __buonarrotiAcpPool?: PoolState };

/** Survives Next dev module reloads so we never orphan a running agent. */
function pool(): PoolState {
  const state = (globalForPool.__buonarrotiAcpPool ??= {
    agents: new Map(),
    children: new Set(),
    exitHooked: false,
  });
  if (!state.exitHooked) {
    state.exitHooked = true;
    process.once("exit", () => {
      for (const child of state.children) child.kill("SIGTERM");
    });
  }
  return state;
}

async function startAgent(id: AgentId): Promise<AgentProcess> {
  const spec = AGENT_SPECS[id];
  const env = await getShellEnv();
  const launch = await spec.resolveLaunch(env);
  if (!launch.ok) throw new AgentUnavailableError(launch.status, launch.detail, launch.setupHint);

  const child = spawn(launch.command, launch.args, {
    cwd: sandboxDir(id),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  pool().children.add(child);
  const agent = new AgentProcess(id, child);

  const timeout = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => timeout.reject(new Error(`${spec.name} took too long to start.`)),
    START_TIMEOUT_MS,
  );
  const stopExit = agent.onExit((detail) =>
    timeout.reject(new Error(`${spec.name} exited while starting${detail ? `: ${detail}` : "."}`)),
  );
  try {
    agent.init = await Promise.race([
      agent.conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        // No fs / terminal capabilities: the agent can't touch this machine through us.
        clientCapabilities: {},
        clientInfo: { name: "buonarroti", version: "1" },
      }),
      timeout.promise,
    ]);
  } catch (err) {
    agent.kill();
    throw err;
  } finally {
    clearTimeout(timer);
    stopExit();
  }
  return agent;
}

/** The warm agent process, starting (or restarting after a crash) as needed. */
export async function getAgent(id: AgentId): Promise<AgentProcess> {
  const state = pool();
  const entry = state.agents.get(id);
  if (entry) {
    const agent = await entry.starting.catch(() => undefined);
    if (agent && !agent.dead) return agent;
    if (state.agents.get(id) === entry) state.agents.delete(id);
  }
  const starting = startAgent(id);
  const next: { process?: AgentProcess; starting: Promise<AgentProcess> } = { starting };
  state.agents.set(id, next);
  starting.then(
    (agent) => {
      next.process = agent;
    },
    () => {
      if (state.agents.get(id) === next) state.agents.delete(id);
    },
  );
  return starting;
}

/** Kill an agent's process (e.g. after a crash or a failed probe); the next use restarts it. */
export function stopAgent(id: AgentId) {
  pool().agents.get(id)?.process?.kill();
  pool().agents.delete(id);
}
