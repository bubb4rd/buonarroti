"use client";

import { create } from "zustand";
import { useWorkflowStore } from "@/lib/store";
import { useFolderStore } from "@/lib/folderStore";
import { galleryCache, getToken, type GalleryItem } from "@/lib/galleryUtils";
import { browserNotify } from "@/lib/browserNotify";
import type { GenerationErrorCode, PendingGen, Tab } from "./types";

/**
 * In-flight generations for the studio, independent of any mounted component.
 *
 * Every generation is driven by exactly one runner (`active`), which lives at
 * module scope, so navigating away from the gallery does not stop it, and
 * coming back (or React re-running effects) does not start a second one. The
 * list is persisted after every change; on reload `resumePending()` picks each
 * unfinished entry up again:
 *   - not yet posted → POST with its stored `clientRequestId` (deduped server-side)
 *   - posted, no taskId → POST again with the same `clientRequestId` (same task back)
 *   - has taskId → poll /api/job-status until done | error | not_found | 65-min cap
 */

const STORAGE_KEY = "aiui-pending-gens"; // shared with AppSidebar's "clean failed jobs"
const CANCEL_WINDOW_MS = 3_000;
const CLIENT_CAP_MS = 65 * 60_000;
const POLL_MIN_MS = 2_000;
const POLL_MAX_MS = 5_000;
/** Consecutive failed status checks (≈2.5 min at the max interval) before giving up. */
const MAX_STATUS_FAILURES = 30;
const POST_ATTEMPTS = 4;

/** Fired on `window` when finished generations have been merged into `galleryCache`. */
export const GENERATIONS_ARRIVED = "gallery-generations-arrived";
export interface GenerationsArrivedDetail { tab: Tab; freshIds: string[] }

export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function mergeByNewest(prev: GalleryItem[], incoming: GalleryItem[]): GalleryItem[] {
  const seen = new Set(prev.map(i => i.id));
  const brandNew = incoming.filter(i => !seen.has(i.id));
  if (brandNew.length === 0) return prev;
  return [...prev, ...brandNew].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

// ── Store ─────────────────────────────────────────────────────────────────────

function loadPersisted(): PendingGen[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PendingGen[]) : [];
  } catch { return []; }
}

export const usePendingGenerations = create<{ pending: PendingGen[]; unseenTabs: Tab[] }>(() => ({
  pending: typeof window === "undefined" ? [] : loadPersisted(),
  /** Tabs that received results while the user was elsewhere; cleared by `markTabSeen`. */
  unseenTabs: [],
}));

/** True while the user is looking at `tab` in the gallery. */
function isViewingTab(tab: Tab): boolean {
  if (window.location.pathname !== "/gallery") return false;
  return (new URLSearchParams(window.location.search).get("tab") ?? "images") === tab;
}

export function markTabSeen(tab: Tab) {
  usePendingGenerations.setState(s =>
    s.unseenTabs.includes(tab) ? { unseenTabs: s.unseenTabs.filter(t => t !== tab) } : s,
  );
}

function syncFolderIndicators(pending: PendingGen[]) {
  const live = pending.filter(pg => !pg.error);
  const folders = useFolderStore.getState();
  folders.setGeneratingFolderIds([...new Set(live.filter(pg => pg.folderId).map(pg => pg.folderId!))]);
  folders.setGeneratingAllAssets(live.some(pg => !pg.folderId));
}

if (typeof window !== "undefined") {
  syncFolderIndicators(usePendingGenerations.getState().pending);
  usePendingGenerations.subscribe(({ pending }, prev) => {
    if (pending === prev.pending) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(pending)); } catch {}
    syncFolderIndicators(pending);
  });
  // "Clean failed jobs" from the sidebar folder menu.
  window.addEventListener("clean-failed-jobs", e => {
    const { folderId } = (e as CustomEvent<{ folderId: string | null }>).detail;
    usePendingGenerations.setState(s => ({
      pending: s.pending.filter(pg => !pg.error || (folderId !== null && pg.folderId !== folderId)),
    }));
  });
}

const getPending = (id: string) => usePendingGenerations.getState().pending.find(p => p.id === id);

function patchPending(id: string, patch: Partial<PendingGen>) {
  usePendingGenerations.setState(s => ({ pending: s.pending.map(p => (p.id === id ? { ...p, ...patch } : p)) }));
}

/** Ids with a live runner or cancel-window timer. Guarantees one runner per generation. */
const active = new Set<string>();
const cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── Errors ────────────────────────────────────────────────────────────────────

class GenerationError extends Error {
  constructor(message: string, readonly code: GenerationErrorCode) { super(message); }
}
/** Thrown inside a runner when its entry was dismissed; ends the runner quietly. */
const DISMISSED = Symbol("dismissed");

/** Calm, actionable copy for each failure class. Server text is kept where it is the real reason. */
export function describeFailure(code: GenerationErrorCode | undefined, serverMessage?: string): string {
  switch (code) {
    case "credits": return "kie.ai is out of credits. Top up, then retry. Your prompt is saved.";
    case "auth": return "Your kie.ai key wasn't accepted. Check it in Settings, then retry.";
    case "rate_limited": return "kie.ai is busy right now. Wait a moment, then retry.";
    case "interrupted": return "This generation was interrupted. Retry?";
    case "timeout": return "This took longer than expected and was stopped. Retry to check again.";
    case "network": return "Couldn't reach the server. Retry when you're back online.";
    case "rejected": return serverMessage?.trim() || "The provider declined this prompt. Try rewording it.";
    default: return serverMessage?.trim() || "The generation failed. Retry, or adjust the prompt.";
  }
}

/** Resolves after `ms`, or as soon as the tab becomes visible again (timers are throttled while hidden). */
function waitOrVisible(ms: number) {
  return new Promise<void>(resolve => {
    const finish = () => { clearTimeout(t); document.removeEventListener("visibilitychange", onVisible); resolve(); };
    const onVisible = () => { if (!document.hidden) finish(); };
    const t = setTimeout(finish, ms);
    document.addEventListener("visibilitychange", onVisible);
  });
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function post(id: string): Promise<void> {
  const pg = getPending(id);
  if (!pg) throw DISMISSED;
  if (!pg.endpoint || !pg.request || !pg.clientRequestId) {
    throw new GenerationError("This generation was interrupted before it started. Retry?", "interrupted");
  }
  // Persist "posted" before the request leaves, so a reload re-posts with the same id.
  patchPending(id, { prePending: false, postedAt: pg.postedAt ?? new Date().toISOString() });
  const token = await getToken();
  const body = JSON.stringify({ ...pg.request, clientRequestId: pg.clientRequestId });

  for (let attempt = 0; attempt < POST_ATTEMPTS; attempt++) {
    if (attempt > 0) await waitOrVisible(1_000 * 2 ** attempt);
    if (!getPending(id)) throw DISMISSED;
    let res: Response;
    try {
      res = await fetch(pg.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body,
      });
    } catch (e) {
      // Safe to repeat: the server dedupes on clientRequestId.
      console.warn(`[gallery] submitting generation failed (attempt ${attempt + 1}):`, e);
      continue;
    }
    const data = (await res.json().catch(() => ({}))) as { taskId?: string; warnings?: string[]; error?: string; code?: GenerationErrorCode };
    if (res.ok && data.taskId) {
      patchPending(id, { taskId: data.taskId });
      const addToast = useWorkflowStore.getState().addToast;
      for (const w of data.warnings ?? []) addToast(w, "info");
      return;
    }
    const code: GenerationErrorCode = data.code
      ?? (res.status === 402 ? "credits"
        : res.status === 401 || res.status === 403 ? "auth"
        : res.status === 429 ? "rate_limited"
        : res.status >= 500 || res.ok ? "upstream"
        : "invalid");
    throw new GenerationError(describeFailure(code, data.error ?? (res.ok ? "The server didn't return a task. Retry?" : `Server error ${res.status}`)), code);
  }
  throw new GenerationError(describeFailure("network"), "network");
}

type JobStatus =
  | { status: "pending" }
  | { status: "done" }
  | { status: "error"; error?: string; code?: GenerationErrorCode }
  | { status: "not_found" };

async function poll(id: string, immediate: boolean): Promise<void> {
  const first = getPending(id);
  if (!first?.taskId) throw DISMISSED;
  const startedAt = Date.parse(first.postedAt ?? first.createdAt ?? "") || Date.now();
  let delay = POLL_MIN_MS;
  let failures = 0;
  let wait = !immediate;

  for (;;) {
    if (wait) await waitOrVisible(delay);
    wait = true;
    const pg = getPending(id);
    if (!pg?.taskId) throw DISMISSED;
    if (Date.now() - startedAt > CLIENT_CAP_MS) throw new GenerationError(describeFailure("timeout"), "timeout");

    let result: JobStatus;
    try {
      const res = await fetch(`/api/job-status?taskId=${encodeURIComponent(pg.taskId)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      result = (await res.json()) as JobStatus;
      failures = 0;
    } catch (e) {
      failures++;
      console.warn(`[gallery] status check for ${pg.taskId} failed (${failures}/${MAX_STATUS_FAILURES}):`, e);
      if (failures >= MAX_STATUS_FAILURES) throw new GenerationError(describeFailure("network"), "network");
      delay = POLL_MAX_MS;
      continue;
    }
    if (result.status === "done") return;
    if (result.status === "error") throw new GenerationError(describeFailure(result.code, result.error), result.code ?? "failed");
    if (result.status === "not_found") throw new GenerationError(describeFailure("interrupted"), "interrupted");
    delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.25));
  }
}

async function fetchLatest(tab: Tab): Promise<GalleryItem[]> {
  const token = await getToken();
  if (!token) return [];
  try {
    const res = await fetch(`/api/gallery?type=${tab === "videos" ? "video" : "image"}&page=0&source=generation`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    // Response of our own /api/gallery route.
    const data: { items?: GalleryItem[] } = await res.json();
    return data.items ?? [];
  } catch { return []; }
}

async function settleDone(id: string) {
  const pg = getPending(id);
  if (!pg) return;
  const tab: Tab = pg.tab ?? "images";
  const cacheKey = `${tab}-generation`;
  const existingIds = new Set((galleryCache.get(cacheKey)?.items ?? []).map(i => i.id));
  const fresh = await fetchLatest(tab);
  usePendingGenerations.setState(s => ({ pending: s.pending.filter(p => p.id !== id) }));

  const folders = useFolderStore.getState();
  if (fresh.length > 0) {
    if (pg.folderId) {
      const since = pg.createdAt ? new Date(pg.createdAt).getTime() - 30_000 : 0;
      const untagged = fresh
        .filter(i => new Date(i.created_at).getTime() >= since && !folders.itemFolderMap[i.id])
        .map(i => i.id);
      if (untagged.length > 0) folders.assignItemsToFolder(untagged, pg.folderId);
    }
    const cached = galleryCache.get(cacheKey);
    galleryCache.set(cacheKey, { items: mergeByNewest(cached?.items ?? [], fresh), hasMore: cached?.hasMore ?? true });
  }
  if (pg.folderId && pg.folderId !== folders.selectedFolderId) folders.addUnseenFolder(pg.folderId);
  if (!pg.folderId && folders.selectedFolderId !== null) folders.setUnseenAllAssets(true);
  if (!isViewingTab(tab)) {
    usePendingGenerations.setState(s => (s.unseenTabs.includes(tab) ? s : { unseenTabs: [...s.unseenTabs, tab] }));
  }

  const freshIds = fresh.filter(i => !existingIds.has(i.id)).map(i => i.id);
  window.dispatchEvent(new CustomEvent<GenerationsArrivedDetail>(GENERATIONS_ARRIVED, { detail: { tab, freshIds } }));
  browserNotify(tab === "videos" ? "Video ready" : "Image ready", (pg.prompt || "Your generation is ready").slice(0, 100));
}

/** Drives one generation to a terminal state. Callers must hold `active` for `id`. */
async function run(id: string, resume: boolean) {
  cancelTimers.delete(id);
  try {
    let pg = getPending(id);
    if (!pg) return;
    let immediate = resume;
    if (!pg.taskId) {
      await post(id);
      immediate = false;
      pg = getPending(id);
      if (!pg) return;
    }
    await poll(id, immediate);
    await settleDone(id);
    window.dispatchEvent(new Event("credits-refresh"));
  } catch (e) {
    if (e === DISMISSED) return;
    const err = e instanceof GenerationError ? e : new GenerationError(describeFailure("failed", e instanceof Error ? e.message : String(e)), "failed");
    if (!getPending(id)) return;
    patchPending(id, { error: err.message, errorCode: err.code, prePending: false });
    window.dispatchEvent(new Event("credits-refresh"));
    browserNotify("Generation failed", err.message.slice(0, 100));
  } finally {
    active.delete(id);
  }
}

function start(id: string, resume: boolean) {
  if (active.has(id)) return;
  active.add(id);
  void run(id, resume);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Adds generations to the top of the list and submits them after the 3-second
 * cancel window. Each entry must carry `endpoint`, `request` and `clientRequestId`.
 * `simulate` (debug mode) shows the tiles briefly without calling the API.
 */
export function enqueueGenerations(entries: PendingGen[], { simulate = false } = {}) {
  usePendingGenerations.setState(s => ({ pending: [...entries, ...s.pending] }));
  for (const pg of entries) {
    active.add(pg.id);
    cancelTimers.set(pg.id, setTimeout(() => {
      if (simulate) {
        active.delete(pg.id);
        cancelTimers.delete(pg.id);
        usePendingGenerations.setState(s => ({ pending: s.pending.filter(p => p.id !== pg.id) }));
      } else {
        void run(pg.id, false);
      }
    }, CANCEL_WINDOW_MS));
  }
}

/** Cancels a generation still inside its cancel window. Nothing was sent. */
export function cancelPending(id: string) {
  const t = cancelTimers.get(id);
  if (t) { clearTimeout(t); cancelTimers.delete(id); active.delete(id); }
  usePendingGenerations.setState(s => ({ pending: s.pending.filter(p => p.id !== id) }));
}

/** Removes a failed entry. A runner still holding it stops at its next check. */
export function dismissPending(id: string) {
  cancelPending(id);
}

/** True when Retry can re-run the job: same task (resume) or the stored request (new task). */
export function canRetry(pg: PendingGen): boolean {
  return isResumable(pg) || (!!pg.request && !!pg.endpoint);
}

function isResumable(pg: PendingGen): boolean {
  if (pg.errorCode === "network") return !!pg.taskId || !!pg.clientRequestId;
  return pg.errorCode === "timeout" && !!pg.taskId;
}

/**
 * Retry a failed generation. Lost-contact failures resume the same job (no
 * second charge); everything else re-sends the stored request as a new task.
 */
export function retryPending(id: string) {
  const pg = getPending(id);
  if (!pg || active.has(id) || !pg.error) return;
  if (isResumable(pg)) {
    patchPending(id, {
      error: undefined,
      errorCode: undefined,
      ...(pg.errorCode === "timeout" ? { postedAt: new Date().toISOString() } : {}),
    });
    start(id, true);
    return;
  }
  if (!pg.request || !pg.endpoint) return;
  const fresh: PendingGen = {
    ...pg,
    id: randomUUID(),
    clientRequestId: randomUUID(),
    taskId: undefined,
    error: undefined,
    errorCode: undefined,
    postedAt: undefined,
    prePending: false,
    retried: true,
    createdAt: pg.createdAt ?? new Date().toISOString(),
  };
  usePendingGenerations.setState(s => ({ pending: s.pending.map(p => (p.id === id ? fresh : p)) }));
  start(fresh.id, false);
}

/** Picks up every unfinished generation that has no runner yet (after reload or HMR). Idempotent. */
export function resumePending() {
  for (const pg of usePendingGenerations.getState().pending) {
    if (!pg.error) start(pg.id, true);
  }
}
