import type { KlingElement, ReuseMeta, TaggedImage, Tab } from "./types";

/**
 * Persisted composer drafts — everything the user has set up in the prompt box,
 * per tab and per folder. Written on every change so leaving the page, switching
 * tabs or reloading never loses what was typed.
 *
 * Storage: localStorage["buonarroti-composer-draft"] = { [scope]: ComposerDraft }
 *   scope = "images" | "videos" | "images@<folderId>" | "videos@<folderId>"
 * Migrated from the inherited per-key `nf-gallery-<tab>[-folder-<id>]` entries.
 */
export interface ComposerDraft {
  prompt: string;
  modelId: string;
  aspectRatio: string;
  quality: string;
  count: number;
  duration: number;
  mode: string;
  sound?: boolean;
  refImageUrls?: string[];
  azureResolution?: string;
  azureCustomWidth?: number;
  azureCustomHeight?: number;
  promptTextMode?: "text" | "json" | "yaml";
  multiPromptMode?: boolean;
  vidStartFrameUrl?: string | null;
  vidEndFrameUrl?: string | null;
  vidResourceUrls?: string[];
  vidVideoRefUrl?: string | null;
  vidRefVideoUrls?: string[];
  vidRefAudioUrls?: string[];
  vidElements?: KlingElement[];
  taggedImages?: TaggedImage[];
  updatedAt?: number;
}

const DRAFT_KEY = "buonarroti-composer-draft";
const HANDOFF_KEY = "buonarroti-composer-handoff";
export const HANDOFF_EVENT = "composer-handoff";
const LEGACY_KEY_RE = /^nf-gallery-(images|videos)(?:-folder-(.+))?$/;

type DraftStore = Record<string, Partial<ComposerDraft>>;

const scopeOf = (tab: Tab, folderId: string | null) => (folderId ? `${tab}@${folderId}` : tab);

let migrated = false;

function readStore(): DraftStore {
  let store: DraftStore = {};
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (raw) store = JSON.parse(raw) as DraftStore;
  } catch { store = {}; }

  // One-time migration of the inherited keys: copy any scope we don't have yet,
  // then remove the old key. Never overwrite a newer draft.
  if (migrated) return store;
  migrated = true;
  const legacy: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && LEGACY_KEY_RE.test(k)) legacy.push(k);
  }
  if (legacy.length) {
    for (const k of legacy) {
      const [, tab, folderId] = k.match(LEGACY_KEY_RE)!;
      const scope = scopeOf(tab as Tab, folderId ?? null);
      if (!store[scope]) {
        try { store[scope] = JSON.parse(localStorage.getItem(k) ?? "null") ?? undefined; } catch {}
      }
    }
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(store));
      for (const k of legacy) localStorage.removeItem(k);
    } catch {}
  }
  return store;
}

export function loadDraft(tab: Tab, folderId: string | null): Partial<ComposerDraft> | null {
  if (typeof window === "undefined") return null;
  return readStore()[scopeOf(tab, folderId)] ?? null;
}

export function saveDraft(tab: Tab, folderId: string | null, draft: ComposerDraft) {
  if (typeof window === "undefined") return;
  try {
    const store = readStore();
    store[scopeOf(tab, folderId)] = { ...draft, updatedAt: Date.now() };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(store));
  } catch {}
}

// ── Hand-off from other surfaces (e.g. chat "Use as prompt") ────────────────

export interface ComposerHandoff {
  tab: Tab;
  prompt: string;
  at: number;
  /** Present when the prompt belongs to a known setup (a generation): load it the way "Reuse" does. */
  setup?: { refUrls: string[]; meta: ReuseMeta };
}

/** Queues `prompt` (and optionally its setup) for the gallery composer of `tab`; call before navigating there. */
export function handOffPromptToComposer(tab: Tab, prompt: string, setup?: ComposerHandoff["setup"]) {
  try {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify({ tab, prompt, at: Date.now(), setup } satisfies ComposerHandoff));
    window.dispatchEvent(new Event(HANDOFF_EVENT));
  } catch {}
}

/** Returns and removes a pending hand-off for `tab`, if any. */
export function takeHandoff(tab: Tab): ComposerHandoff | null {
  try {
    const raw = localStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    const h = JSON.parse(raw) as ComposerHandoff;
    if (h.tab !== tab || typeof h.prompt !== "string") return null;
    localStorage.removeItem(HANDOFF_KEY);
    return h;
  } catch { return null; }
}
