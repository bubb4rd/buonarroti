import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import { useWorkflowStore } from "./store";

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** User turns only: attached images as stored `/generated/...` URLs (never inline data). */
  images?: string[];
  /** Assistant turns only. "stopped" = cut short by the user or a reload; "error" = the request failed. */
  status?: "stopped" | "error";
  /** Human-readable failure reason for `status: "error"`. */
  error?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: StoredMessage[];
  model: string;
  createdAt: number;
  updatedAt: number;
  /** Unsent composer text. */
  draft?: string;
  /** Images attached to the unsent message (stored `/generated/...` URLs). */
  draftImages?: string[];
}

/** kie.ai fallback for new chats when the user has never picked a model and no subscription is ready. */
export const DEFAULT_CHAT_MODEL = "claude-sonnet-4-6";

const STORAGE_KEY = "buonarroti-chats";
const LEGACY_STORAGE_KEY = "heliosgen-chats-guest";
const TITLE_MAX = 50;

export function newMessageId(): string {
  return crypto.randomUUID();
}

/** First line of `text`, trimmed to a sidebar-friendly title. */
export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

export function isEmptySession(s: ChatSession): boolean {
  return s.messages.length === 0 && !s.draft?.trim() && !s.draftImages?.length;
}

/** Sidebar title for a turn; an image-only message still gets a name. */
function titleForTurn(text: string, images?: string[]): string {
  return titleFrom(text) || (images?.length ? (images.length > 1 ? "Images" : "Image") : "");
}

const byRecent = (a: ChatSession, b: ChatSession) => b.updatedAt - a.updatedAt;

interface ChatSessionState {
  sessions: ChatSession[];
  /** The model the user last picked; `null` until they pick one (see `useDefaultChatModel`). */
  preferredModel: string | null;
  setPreferredModel: (model: string) => void;
  createSession: (model: string, opts?: { title?: string; draft?: string; draftImages?: string[] }) => string;
  /** Reuses an existing session with no messages and no draft, or creates one. Returns its id. */
  ensureDraftSession: (model: string, draft: string, draftImages?: string[]) => string;
  setDraft: (id: string, draft: string, draftImages?: string[]) => void;
  setSessionModel: (id: string, model: string) => void;
  setMessages: (id: string, messages: StoredMessage[]) => void;
  deleteSession: (id: string) => void;
  clearSessions: () => void;
}

function patchSession(
  sessions: ChatSession[],
  id: string,
  patch: (s: ChatSession) => ChatSession,
): ChatSession[] {
  let changed = false;
  const next = sessions.map((s) => {
    if (s.id !== id) return s;
    changed = true;
    return patch(s);
  });
  return changed ? next.sort(byRecent) : sessions;
}

// ── Storage: legacy-key migration + quota handling ───────────────────────────

let quotaToastShown = false;

const chatStorage: StateStorage = {
  getItem: (name) => {
    const current = localStorage.getItem(name);
    if (current !== null) return current;
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy === null) return null;
    try {
      localStorage.setItem(name, legacy);
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      // Keep the legacy key if the copy failed; we still read from it this session.
    }
    return legacy;
  },
  setItem: (name, value) => {
    try {
      localStorage.setItem(name, value);
      quotaToastShown = false;
    } catch {
      if (quotaToastShown) return;
      quotaToastShown = true;
      useWorkflowStore
        .getState()
        .addToast(
          "Your browser storage is full, so recent chat changes are not being saved. Delete a few old chats to free space.",
          "error",
          undefined,
          "Chats not saved",
        );
    }
  },
  removeItem: (name) => localStorage.removeItem(name),
};

interface PersistedChats {
  sessions?: ChatSession[];
  preferredModel?: string | null;
}

/** v0 (HeliosGen) messages had no ids. */
function migrateChats(persisted: unknown, version: number): PersistedChats {
  const state = (persisted ?? {}) as PersistedChats;
  if (version < 1) {
    state.sessions = (state.sessions ?? []).map((s) => ({
      ...s,
      messages: (s.messages ?? []).map((m) => ({ ...m, id: m.id ?? newMessageId() })),
    }));
  }
  // Before v2 an untouched picker stored the default; treat it as "never chosen".
  if (version < 2 && state.preferredModel === DEFAULT_CHAT_MODEL) {
    state.preferredModel = null;
  }
  // v3 added optional `images` / `draftImages`; older data needs nothing.
  return state;
}

export const useChatSessionStore = create<ChatSessionState>()(
  persist(
    (set, get) => ({
      sessions: [],
      preferredModel: null,

      setPreferredModel: (model) => set({ preferredModel: model }),

      createSession: (model, opts) => {
        const id = crypto.randomUUID();
        const now = Date.now();
        const draft = opts?.draft ?? "";
        const draftImages = opts?.draftImages ?? [];
        const session: ChatSession = {
          id,
          title: opts?.title ?? titleForTurn(draft, draftImages),
          messages: [],
          model,
          createdAt: now,
          updatedAt: now,
          draft,
          ...(draftImages.length ? { draftImages } : {}),
        };
        set((s) => ({ sessions: [session, ...s.sessions] }));
        return id;
      },

      ensureDraftSession: (model, draft, draftImages = []) => {
        const reusable = get().sessions.find(isEmptySession);
        if (!reusable) return get().createSession(model, { draft, draftImages });
        const now = Date.now();
        set((s) => ({
          sessions: patchSession(s.sessions, reusable.id, (sess) => ({
            ...sess,
            model,
            draft,
            draftImages,
            title: titleForTurn(draft, draftImages),
            createdAt: now,
            updatedAt: now,
          })),
        }));
        return reusable.id;
      },

      setDraft: (id, draft, draftImages = []) => {
        const existing = get().sessions.find((s) => s.id === id);
        const prevImages = existing?.draftImages ?? [];
        const sameImages =
          prevImages.length === draftImages.length && prevImages.every((url, i) => url === draftImages[i]);
        if (!existing || ((existing.draft ?? "") === draft && sameImages)) return;
        set((s) => ({
          sessions: patchSession(s.sessions, id, (sess) => ({
            ...sess,
            draft,
            draftImages,
            // Untitled until the first message; the draft names it meanwhile.
            title: sess.messages.length === 0 ? titleForTurn(draft, draftImages) : sess.title,
            updatedAt: Date.now(),
          })),
        }));
      },

      setSessionModel: (id, model) => {
        set((s) => ({
          sessions: s.sessions.map((sess) => (sess.id === id ? { ...sess, model } : sess)),
        }));
      },

      setMessages: (id, messages) => {
        set((s) => ({
          sessions: patchSession(s.sessions, id, (sess) => {
            const firstUser = messages.find((m) => m.role === "user");
            const title =
              sess.messages.length === 0 && firstUser ? titleForTurn(firstUser.content, firstUser.images) : sess.title;
            return { ...sess, messages, title, updatedAt: Date.now() };
          }),
        }));
      },

      deleteSession: (id) => {
        set((s) => ({ sessions: s.sessions.filter((sess) => sess.id !== id) }));
      },

      clearSessions: () => set({ sessions: [] }),
    }),
    {
      name: STORAGE_KEY,
      version: 3,
      // Throwing here makes persist a no-op during server rendering.
      storage: createJSONStorage(() => {
        if (typeof window === "undefined") throw new Error("localStorage is unavailable on the server");
        return chatStorage;
      }),
      migrate: migrateChats,
      partialize: (s) => ({ sessions: s.sessions, preferredModel: s.preferredModel }),
      // Hydrate: drop sessions that hold nothing, newest first.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as PersistedChats;
        return {
          ...current,
          preferredModel: p.preferredModel ?? current.preferredModel,
          sessions: (p.sessions ?? []).filter((s) => !isEmptySession(s)).sort(byRecent),
        };
      },
    },
  ),
);
