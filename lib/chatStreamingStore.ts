import { create } from "zustand";
import { getToken } from "./galleryUtils";
import { SYSTEM_PROMPT } from "./systemPrompt";
import { useChatSessionStore, newMessageId, type StoredMessage } from "./chatSessionStore";
import { useWorkflowStore } from "./store";
import { keyProviderFor } from "./models";
import { loadAzureBaseUrl, loadAzureTextDeployment, loadAzureTextModelName } from "@/components/SettingsModal";

// ── Shared SSE client for /api/assistant ─────────────────────────────────────

class AssistantError extends Error {}

/**
 * POSTs to /api/assistant and streams the reply. Handles both the Anthropic
 * (`content_block_delta`) and OpenAI (`choices[0].delta.content`) SSE shapes.
 * Resolves with the full text; rejects with AssistantError (readable message)
 * or the fetch AbortError.
 */
async function streamAssistant(opts: {
  model: string;
  messages: { role: "user" | "assistant"; content: string; images?: string[] }[];
  /** Chat session id; lets subscription (ACP) agents keep one warm session per chat. */
  conversationId: string;
  signal: AbortSignal;
  onDelta: (accumulated: string) => void;
}): Promise<string> {
  const token = await getToken();
  const azureConfig =
    keyProviderFor(opts.model) === "azure"
      ? {
          azureEndpoint: loadAzureBaseUrl(),
          azureDeployment: loadAzureTextDeployment(),
          azureModelName: loadAzureTextModelName(),
        }
      : {};

  let res: Response;
  try {
    res = await fetch("/api/assistant", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...opts.messages],
        conversationId: opts.conversationId,
        ...azureConfig,
      }),
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new AssistantError("Buonarroti could not reach the assistant. Check your connection, then retry.");
  }

  if (!res.ok || !res.body) {
    let message = "The assistant could not answer. Try again in a moment.";
    try {
      const j: unknown = await res.json();
      if (j && typeof j === "object" && "error" in j && typeof j.error === "string") message = j.error;
    } catch {
      // Non-JSON error body: keep the generic message rather than showing raw text.
    }
    throw new AssistantError(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let accumulated = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    let grew = false;
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json || json === "[DONE]") continue;
      let parsed: {
        type?: string;
        error?: { message?: string } | string;
        delta?: { text?: string };
        choices?: { delta?: { content?: string } }[];
      };
      try {
        parsed = JSON.parse(json);
      } catch {
        continue; // partial or keep-alive line
      }
      if (parsed.type === "error" || parsed.error) {
        throw new AssistantError("The model stopped with an error partway through. Retry to try again.");
      }
      const chunk =
        (parsed.type === "content_block_delta" ? parsed.delta?.text : undefined) ??
        parsed.choices?.[0]?.delta?.content;
      if (chunk) {
        accumulated += chunk;
        grew = true;
      }
    }
    if (grew) opts.onDelta(accumulated);
  }

  if (!accumulated.trim()) {
    throw new AssistantError("The model returned an empty reply. Retry, or pick another model.");
  }
  return accumulated;
}

// ── Who is looking at which chat (for the "Response ready" toast) ────────────

const watchers = new Map<string, number>();

/** Mark a session as on-screen. Returns the cleanup that unmarks it. */
export function watchSession(sessionId: string): () => void {
  watchers.set(sessionId, (watchers.get(sessionId) ?? 0) + 1);
  return () => {
    const n = (watchers.get(sessionId) ?? 1) - 1;
    if (n <= 0) watchers.delete(sessionId);
    else watchers.set(sessionId, n);
  };
}

const isOnScreen = (sessionId: string) =>
  watchers.has(sessionId) && document.visibilityState === "visible";

// ── Store ────────────────────────────────────────────────────────────────────

export interface LiveStream {
  /** Id the assistant turn will be saved under. */
  messageId: string;
  content: string;
}

interface ChatStreamingState {
  /** Present only while a reply is streaming. */
  streams: Record<string, LiveStream>;
  /** Append a user turn (text and/or stored image URLs) to the session and stream the reply. */
  send: (sessionId: string, text: string, images?: string[]) => void;
  /** Re-run the last user turn, replacing a failed or stopped reply (never duplicates the user turn). */
  retry: (sessionId: string) => void;
  stop: (sessionId: string) => void;
}

const controllers = new Map<string, AbortController>();
const PARTIAL_SAVE_MS = 1500;

export const useChatStreamingStore = create<ChatStreamingState>()((set, get) => {
  const sessions = () => useChatSessionStore.getState();
  const findSession = (id: string) => sessions().sessions.find((s) => s.id === id);

  function endStream(sessionId: string) {
    controllers.delete(sessionId);
    set((s) => {
      const streams = { ...s.streams };
      delete streams[sessionId];
      return { streams };
    });
  }

  async function run(sessionId: string, base: StoredMessage[]) {
    const session = findSession(sessionId);
    if (!session) return;
    const model = session.model;
    const messageId = newMessageId();
    const controller = new AbortController();
    controllers.set(sessionId, controller);
    set((s) => ({ streams: { ...s.streams, [sessionId]: { messageId, content: "" } } }));
    sessions().setMessages(sessionId, base);

    const saveAssistant = (content: string, extra?: Pick<StoredMessage, "status" | "error">) => {
      if (!findSession(sessionId)) return; // deleted mid-stream
      sessions().setMessages(sessionId, [...base, { id: messageId, role: "assistant", content, ...extra }]);
    };

    // Save partial output periodically, flagged "stopped", so a reload mid-reply keeps what arrived.
    let lastSave = Date.now();
    let accumulated = "";

    try {
      const content = await streamAssistant({
        model,
        messages: base
          .filter((m) => m.status !== "error")
          .map((m) => ({ role: m.role, content: m.content, ...(m.images?.length ? { images: m.images } : {}) })),
        conversationId: sessionId,
        signal: controller.signal,
        onDelta: (text) => {
          accumulated = text;
          set((s) =>
            s.streams[sessionId] ? { streams: { ...s.streams, [sessionId]: { messageId, content: text } } } : s,
          );
          if (Date.now() - lastSave > PARTIAL_SAVE_MS) {
            lastSave = Date.now();
            saveAssistant(text, { status: "stopped" });
          }
        },
      });
      saveAssistant(content);
      if (!isOnScreen(sessionId)) {
        useWorkflowStore
          .getState()
          .addToast(
            "Response ready",
            "success",
            `/chat?id=${sessionId}`,
            findSession(sessionId)?.title || "Chat",
            content.replace(/[*_`#]/g, "").replace(/\s+/g, " ").slice(0, 100),
          );
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        if (accumulated.trim()) saveAssistant(accumulated, { status: "stopped" });
        else sessions().setMessages(sessionId, base);
      } else {
        const message =
          err instanceof AssistantError ? err.message : "The reply was cut off. Retry to try again.";
        saveAssistant(accumulated, { status: "error", error: message });
        if (!isOnScreen(sessionId)) {
          useWorkflowStore
            .getState()
            .addToast(message, "error", `/chat?id=${sessionId}`, findSession(sessionId)?.title || "Chat");
        }
      }
    } finally {
      endStream(sessionId);
    }
  }

  return {
    streams: {},

    send: (sessionId, text, images = []) => {
      const trimmed = text.trim();
      const session = findSession(sessionId);
      if ((!trimmed && images.length === 0) || !session || get().streams[sessionId]) return;
      void run(sessionId, [
        ...session.messages,
        { id: newMessageId(), role: "user", content: trimmed, ...(images.length ? { images } : {}) },
      ]);
    },

    retry: (sessionId) => {
      const session = findSession(sessionId);
      const last = session?.messages[session.messages.length - 1];
      // Retry only a user turn with no reply, or a reply that failed / was stopped.
      if (!session || !last || get().streams[sessionId]) return;
      if (last.role === "user") void run(sessionId, session.messages);
      else if (last.status) void run(sessionId, session.messages.slice(0, -1));
    },

    stop: (sessionId) => {
      controllers.get(sessionId)?.abort();
    },
  };
});
