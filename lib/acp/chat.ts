// Server-only. Runs one assistant turn on an ACP agent and streams it as
// OpenAI-shaped SSE (`data: {"choices":[{"delta":{"content":…}}]}` … `[DONE]`).
//
// Each chat (conversationId) keeps one ACP session per agent, so later turns
// send only the newest user message. If the session is gone (restart, crash,
// expiry) or the client's history no longer matches what the session has
// seen, a fresh session is seeded with the whole transcript.

import { createHash } from "node:crypto";
import type { ContentBlock, StopReason } from "@agentclientprotocol/sdk";
import type { AgentId } from "@/lib/agentModels";
import { AgentUnavailableError, getAgent, isAuthError, type AgentProcess } from "./pool";
import { AGENT_SPECS } from "./registry";
import { cachedAgent, needsLoginInfo, setAgentStatus } from "./status";

const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 30 * 60_000;
const INACTIVITY_MS = 120_000;

/** An attached image, already read from local storage. */
export interface ChatImage {
  /** Stored `/generated/...` URL; identifies the image in history hashes. */
  url: string;
  mimeType: string;
  /** Base64 bytes. */
  data: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  images?: ChatImage[];
}

const IMAGES_DROPPED_NOTE = "\n\n_(This model can't see images, so they weren't sent.)_";

export interface AcpChatRequest {
  agentId: AgentId;
  modelValue: string;
  conversationId?: string;
  system?: string;
  /** Transcript ending with the user message to answer. */
  messages: ChatMessage[];
  signal: AbortSignal;
}

export type AcpChatResult =
  | { ok: true; body: ReadableStream<Uint8Array> }
  | { ok: false; status: number; error: string; code: "auth" | "invalid" | "upstream" };

interface MappedSession {
  agent: AgentProcess;
  sessionId: string;
  systemHash: string;
  /** Hash of every message the session has seen, assistant replies included. */
  historyHash: string;
  lastUsed: number;
  busy: boolean;
}

const globalForChat = globalThis as typeof globalThis & { __buonarrotiAcpSessions?: Map<string, MappedSession> };
const sessions: Map<string, MappedSession> = (globalForChat.__buonarrotiAcpSessions ??= new Map());

function hashOf(parts: string[]): string {
  const h = createHash("sha256");
  for (const part of parts) h.update(part).update("\u0000");
  return h.digest("hex");
}

function historyHash(messages: ChatMessage[]): string {
  return hashOf(messages.flatMap((m) => [m.role, m.content.trim(), ...(m.images ?? []).map((i) => i.url)]));
}

function forget(key: string, entry: MappedSession) {
  if (sessions.get(key) === entry) sessions.delete(key);
  void entry.agent.closeSession(entry.sessionId);
}

/** Drop expired sessions and trim to the LRU cap (never a session mid-turn). */
function sweep() {
  const now = Date.now();
  for (const [key, entry] of sessions) {
    if (!entry.busy && (entry.agent.dead || now - entry.lastUsed > SESSION_TTL_MS)) forget(key, entry);
  }
  for (const [key, entry] of sessions) {
    if (sessions.size <= MAX_SESSIONS) break;
    if (!entry.busy) forget(key, entry);
  }
}

/** "[image]" stand-ins for an agent that can't see images. */
const imagePlaceholders = (m: ChatMessage) => (m.images ?? []).map(() => " [image]").join("");

const imageBlocks = (m: ChatMessage): ContentBlock[] =>
  (m.images ?? []).map((img) => ({ type: "image", mimeType: img.mimeType, data: img.data }));

/**
 * First-turn prompt: instructions (when the agent can't take them natively) + transcript.
 * Each turn's images follow its text when the agent can see them; otherwise "[image]" marks them.
 */
function seedPrompt(system: string | undefined, messages: ChatMessage[], withImages: boolean): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let text = system ? `<instructions>\n${system}\n</instructions>\n\n` : "";
  const attach = (m: ChatMessage) => {
    if (!m.images?.length) return;
    if (!withImages) {
      text += imagePlaceholders(m);
      return;
    }
    if (text) blocks.push({ type: "text", text });
    text = "";
    blocks.push(...imageBlocks(m));
  };
  const latest = messages[messages.length - 1];
  const history = messages.slice(0, -1);
  if (history.length > 0) {
    text += "Conversation so far:";
    for (const m of history) {
      text += `\n\n${m.role === "user" ? "User" : "Assistant"}: ${m.content.trim()}`;
      attach(m);
    }
    text += `\n\nNow reply to the user's latest message.\n\nUser: ${latest.content.trim()}`;
  } else {
    text += latest.content.trim();
  }
  attach(latest);
  if (text.trim()) blocks.push({ type: "text", text });
  return blocks;
}

/** A later turn on a session that has seen the rest: just this message, images first. */
function turnPrompt(message: ChatMessage, withImages: boolean): ContentBlock[] {
  const text = withImages ? message.content.trim() : `${message.content.trim()}${imagePlaceholders(message)}`.trim();
  return [...(withImages ? imageBlocks(message) : []), ...(text ? [{ type: "text" as const, text }] : [])];
}

const encoder = new TextEncoder();
const sseChunk = (text: string) =>
  encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
const sseError = (message: string, code: string) =>
  encoder.encode(`data: ${JSON.stringify({ type: "error", error: { message, code } })}\n\n`);
const SSE_DONE = encoder.encode("data: [DONE]\n\n");

export async function runAcpChat(req: AcpChatRequest): Promise<AcpChatResult> {
  const { agentId, modelValue, conversationId, signal } = req;
  const spec = AGENT_SPECS[agentId];
  const messages = req.messages.filter((m) => m.content.trim() || m.images?.length);
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return { ok: false, status: 400, error: "Write a message first.", code: "invalid" };
  }

  const known = cachedAgent(agentId);
  if (known && (known.status === "not_installed" || known.status === "needs_login")) {
    return {
      ok: false,
      status: known.status === "needs_login" ? 401 : 400,
      error: `${known.detail ?? `${spec.name} isn't ready.`} ${known.setupHint ?? ""}`.trim(),
      code: known.status === "needs_login" ? "auth" : "invalid",
    };
  }

  let agent: AgentProcess;
  try {
    agent = await getAgent(agentId);
  } catch (err) {
    if (err instanceof AgentUnavailableError) {
      return {
        ok: false,
        status: err.status === "needs_login" ? 401 : 400,
        error: `${err.message} ${err.setupHint ?? ""}`.trim(),
        code: err.status === "needs_login" ? "auth" : "invalid",
      };
    }
    console.error(`[assistant] ${agentId} failed to start`, err instanceof Error ? err.message : err);
    return { ok: false, status: 502, error: `${spec.name} couldn't start. Try again in a moment.`, code: "upstream" };
  }

  const release = agent.hold();
  const system = req.system?.trim() || undefined;
  const systemHash = hashOf([system ?? ""]);
  const key = conversationId ? `${agentId}:${conversationId}` : undefined;
  sweep();

  // Reuse the chat's session only if it has seen exactly this history.
  let entry = key ? sessions.get(key) : undefined;
  const reusable =
    entry &&
    entry.agent === agent &&
    !agent.dead &&
    !entry.busy &&
    entry.systemHash === systemHash &&
    entry.historyHash === historyHash(messages.slice(0, -1));

  // Images go only to agents that advertised them; others get "[image]" and a note in the reply.
  const withImages = agent.acceptsImages;
  const droppedImages = !withImages && !!messages[messages.length - 1].images?.length;
  let prompt: ContentBlock[];
  const startedAt = Date.now();
  try {
    if (reusable && entry) {
      prompt = turnPrompt(messages[messages.length - 1], withImages);
    } else {
      if (key && entry && !entry.busy) forget(key, entry);
      const session = await agent.newSession(system);
      entry = { agent, sessionId: session.sessionId, systemHash, historyHash: "", lastUsed: Date.now(), busy: false };
      if (key) sessions.set(key, entry);
      prompt = seedPrompt(spec.nativeSystemPrompt ? undefined : system, messages, withImages);
    }
    await agent.setModel(entry.sessionId, modelValue);
  } catch (err) {
    release();
    if (entry && key) forget(key, entry);
    if (isAuthError(err) || isAuthError(agent.stderr)) {
      const info = needsLoginInfo(agentId);
      setAgentStatus(info);
      return { ok: false, status: 401, error: `${info.detail} ${info.setupHint}`, code: "auth" };
    }
    console.error(`[assistant] ${agentId} session setup failed`, err instanceof Error ? err.message : err);
    return {
      ok: false,
      status: 400,
      error: `${spec.name} couldn't use that model. Pick another model, then retry.`,
      code: "invalid",
    };
  }

  const active = entry;
  active.busy = true;
  active.lastUsed = Date.now();
  // Keyed sessions live on; one-off requests close theirs after the turn.
  const ownedKey = key;
  console.log(
    `[assistant] ${agentId}/${modelValue} ${reusable ? "reused" : "new"} session ${active.sessionId} (setup ${Date.now() - startedAt}ms)`,
  );

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let text = "";
      let finished = false;
      let closed = false;
      let inactivity: NodeJS.Timeout | undefined;
      let failure: { message: string; code: string } | undefined;

      // The client may have gone away (stream cancelled) before the agent finishes.
      const send = (bytes: Uint8Array) => {
        if (closed) return;
        try {
          controller.enqueue(bytes);
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already cancelled
        }
      };
      const cancelTurn = () => {
        void agent.conn.cancel({ sessionId: active.sessionId }).catch(() => {});
      };
      const armInactivity = () => {
        clearTimeout(inactivity);
        inactivity = setTimeout(() => {
          failure ??= { message: `${spec.name} stopped responding. Retry to try again.`, code: "upstream" };
          cancelTurn();
        }, INACTIVITY_MS);
      };

      const stopUpdates = agent.onUpdate(active.sessionId, (update) => {
        armInactivity();
        if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
          if (finished) return;
          text += update.content.text;
          send(sseChunk(update.content.text));
        } else if (update.sessionUpdate === "tool_call") {
          // Tools are disabled and permission is always refused; log if an agent tries anyway.
          console.warn(`[assistant] ${agentId} attempted a tool call (refused): ${update.title}`);
        }
      });

      const finish = (stopReason: StopReason | undefined, err?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(inactivity);
        signal.removeEventListener("abort", cancelTurn);
        stopUpdates();
        stopExit();
        active.busy = false;
        active.lastUsed = Date.now();

        const ok =
          !err &&
          !failure &&
          (stopReason === "end_turn" || stopReason === "max_tokens" || stopReason === "max_turn_requests");
        if (ok && stopReason === "max_tokens") {
          const note = "\n\n_(Reply cut off: the model reached its length limit.)_";
          text += note;
          send(sseChunk(note));
        }
        if (ok && droppedImages) {
          text += IMAGES_DROPPED_NOTE;
          send(sseChunk(IMAGES_DROPPED_NOTE));
        }
        if (ok && ownedKey) {
          active.historyHash = historyHash([...messages, { role: "assistant", content: text }]);
        } else if (ownedKey) {
          forget(ownedKey, active); // partial/cancelled turn: the session's history is unknown now
        } else {
          void agent.closeSession(active.sessionId);
        }
        release();

        if (signal.aborted) return close();
        if (!ok) {
          let message = failure?.message;
          let code = failure?.code ?? "upstream";
          if (!message && stopReason === "refusal") {
            if (text.trim()) {
              send(sseChunk("\n\n_(The model stopped here.)_"));
            } else {
              message = `${spec.name} declined to answer this. Try rephrasing, then retry.`;
              code = "invalid";
            }
          } else if (!message && stopReason === "cancelled") {
            message = `${spec.name} stopped before finishing. Retry to try again.`;
          } else if (!message) {
            if (isAuthError(err) || isAuthError(agent.stderr)) {
              code = "auth";
              message = `${spec.name} isn't signed in. ${spec.loginHint}`;
              setAgentStatus(needsLoginInfo(agentId));
            } else {
              message = `${spec.name} had a problem answering. Try again in a moment.`;
              console.error(`[assistant] ${agentId} prompt failed`, err instanceof Error ? err.message : err);
            }
          }
          if (message) send(sseError(message, code));
        }
        send(SSE_DONE);
        close();
      };

      // A crashed agent never answers the pending prompt; end the stream ourselves.
      // The pool drops the dead process, so the next request starts a fresh one.
      const stopExit = agent.onExit((detail) => {
        console.error(`[assistant] ${agentId} exited mid-turn`, detail);
        failure ??= { message: `${spec.name} quit unexpectedly. Retry to start it again.`, code: "upstream" };
        finish(undefined, new Error("agent exited"));
      });

      if (signal.aborted) cancelTurn();
      else signal.addEventListener("abort", cancelTurn, { once: true });
      armInactivity();
      agent.conn.prompt({ sessionId: active.sessionId, prompt }).then(
        (res) => {
          console.log(`[assistant] ${agentId} turn ${res.stopReason} in ${Date.now() - startedAt}ms`);
          finish(res.stopReason);
        },
        (err: unknown) => finish(undefined, err),
      );
    },
    cancel() {
      void agent.conn.cancel({ sessionId: active.sessionId }).catch(() => {});
    },
  });

  return { ok: true, body };
}
