"use client";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useWorkflowStore, INTERRUPTED_MESSAGE } from "./store";

// ── Shared client side of the generation status contract ─────────────────────
// POST /api/generate | /api/generate-video → { taskId, warnings? } | { error, code? }
// GET  /api/job-status?taskId=  → pending | done | error | not_found
// GET  /api/job-stream?taskId=  → same shapes as SSE `data:` events

export type JobErrorCode =
  | "credits" | "auth" | "invalid" | "upstream" | "rate_limited"
  | "interrupted" | "timeout" | "failed" | "rejected" | "not_found" | "network";

export interface JobDone {
  status: "done";
  imageUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  /** Character-pipeline steps (POST /api/game/step): the typed artifact (lib/game/artifacts.ts). */
  artifact?: unknown;
}

export interface JobFailure {
  /** Calm, user-facing copy (already mapped from the code). */
  message: string;
  code?: JobErrorCode;
}

type JobPayload =
  | { status: "pending" }
  | JobDone
  | { status: "error"; error?: string; code?: JobErrorCode }
  | { status: "not_found" };

/** Hard client-side cap; the server guarantees termination well before this. */
export const JOB_CLIENT_CAP_MS = 65 * 60 * 1000;
const POLL_MIN_MS = 2_000;
const POLL_MAX_MS = 5_000;

/** Map a contract error code (plus the server's text) to calm copy. */
export function jobErrorCopy(code: string | undefined, serverText?: string): string {
  switch (code) {
    case "credits":      return "kie.ai is out of credits. Top up, then retry. Your prompt is saved.";
    case "auth":         return "kie.ai didn't accept your API key. Check it in Settings, then retry.";
    case "rate_limited": return "kie.ai is busy right now. Wait a moment, then retry.";
    case "interrupted":
    case "not_found":    return INTERRUPTED_MESSAGE;
    case "timeout":      return "This generation took too long and was stopped. Retry when you're ready.";
    case "rejected":     return serverText
      ? `kie.ai declined this request: ${serverText}`
      : "kie.ai declined this request. Adjust the prompt, then retry.";
    case "network":      return "Couldn't reach the generation server. Check your connection, then retry.";
    default:             return serverText?.trim() || "The generation failed. Try again.";
  }
}

export class JobSubmitError extends Error {
  code?: JobErrorCode;
  constructor(message: string, code?: JobErrorCode) {
    super(message);
    this.code = code;
  }
}

/** Notify the sidebar balance that a generation finished (done or error). */
export function notifyCreditsChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("credits-refresh"));
}

export function newClientRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * POST a generation. Sends `clientRequestId` (server dedupes on it), toasts any
 * `warnings` as info, and throws `JobSubmitError` with calm copy on failure.
 */
export async function submitGeneration(
  endpoint: "/api/generate" | "/api/generate-video" | "/api/game/step",
  body: Record<string, unknown>,
  clientRequestId: string,
): Promise<{ taskId: string }> {
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer guest" },
      body: JSON.stringify({ ...body, clientRequestId }),
    });
  } catch {
    throw new JobSubmitError(jobErrorCopy("network"), "network");
  }
  const json = (await res.json().catch(() => ({}))) as {
    taskId?: string; warnings?: string[]; error?: string; code?: JobErrorCode;
  };
  if (!res.ok || !json.taskId) {
    const code = json.code ?? (res.status === 402 ? "credits" : res.status === 429 ? "rate_limited" : undefined);
    throw new JobSubmitError(jobErrorCopy(code, json.error ?? `Request failed (${res.status})`), code);
  }
  const { addToast } = useWorkflowStore.getState();
  for (const w of json.warnings ?? []) addToast(w, "info");
  return { taskId: json.taskId };
}

// ── Polling / streaming ───────────────────────────────────────────────────────

export interface UseJobStatusOptions {
  /** Epoch ms the job was submitted (persisted), so the cap survives reloads. */
  startedAt?: number;
  /** Prefer the SSE stream (falls back to polling on any stream error). */
  stream?: boolean;
  onDone: (result: JobDone) => void;
  onError: (failure: JobFailure) => void;
}

/**
 * Watch a server job until it settles. One in-flight request at a time,
 * 2s→5s polling backoff, SSE with polling fallback, 65-minute hard cap,
 * `not_found` is terminal. Fires `credits-refresh` on every terminal outcome.
 * Pass `undefined` to stop watching.
 */
export function useJobStatus(taskId: string | undefined, opts: UseJobStatusOptions) {
  const optsRef = useRef(opts);
  // Latest callbacks, synced before the watching effect below can fire them.
  useLayoutEffect(() => { optsRef.current = opts; });

  useEffect(() => {
    if (!taskId) return;
    const startedAt = optsRef.current.startedAt ?? Date.now();
    let settled = false;
    let inFlight = false;
    let delay = POLL_MIN_MS;
    let timer: number | undefined;
    let es: EventSource | null = null;
    let polling = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      notifyCreditsChanged();
      fn();
    };

    const handle = (p: JobPayload): boolean => {
      if (p.status === "done") {
        finish(() => optsRef.current.onDone(p));
        return true;
      }
      if (p.status === "error") {
        finish(() => optsRef.current.onError({ message: jobErrorCopy(p.code, p.error), code: p.code ?? "failed" }));
        return true;
      }
      if (p.status === "not_found") {
        finish(() => optsRef.current.onError({ message: jobErrorCopy("not_found"), code: "not_found" }));
        return true;
      }
      return false;
    };

    const capReached = () => {
      if (Date.now() - startedAt < JOB_CLIENT_CAP_MS) return false;
      finish(() => optsRef.current.onError({ message: jobErrorCopy("timeout"), code: "timeout" }));
      return true;
    };

    const schedule = (ms: number) => {
      if (settled) return;
      clearTimeout(timer);
      timer = window.setTimeout(poll, ms);
    };

    const poll = async () => {
      timer = undefined;
      if (settled || inFlight || capReached()) return;
      inFlight = true;
      try {
        const res = await fetch(`/api/job-status?taskId=${encodeURIComponent(taskId)}`, { cache: "no-store" });
        if (settled) return;
        if (res.status === 404) { handle({ status: "not_found" }); return; }
        if (!res.ok) throw new Error(`job-status ${res.status}`);
        const json = (await res.json()) as JobPayload;
        if (settled || handle(json)) return;
      } catch (err) {
        // Transient (server restart, network blip): keep trying with backoff.
        console.warn(`[useJobStatus] ${taskId}:`, err);
      } finally {
        inFlight = false;
      }
      delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.5));
      schedule(delay);
    };

    const startPolling = () => {
      if (polling || settled) return;
      polling = true;
      schedule(0);
    };

    const openStream = () => {
      if (typeof EventSource === "undefined") { startPolling(); return; }
      es = new EventSource(`/api/job-stream?taskId=${encodeURIComponent(taskId)}`);
      es.onmessage = (ev) => {
        try { handle(JSON.parse(ev.data) as JobPayload); } catch { /* malformed frame: ignore */ }
      };
      es.onerror = () => {
        // Stream dropped without a terminal event: fall back to polling.
        es?.close();
        es = null;
        startPolling();
      };
    };

    const onVisible = () => {
      if (document.hidden || settled || !polling) return;
      clearTimeout(timer);
      void poll();
    };

    const capTimer = setTimeout(
      () => capReached(),
      Math.max(0, startedAt + JOB_CLIENT_CAP_MS - Date.now()) + 50,
    );

    function cleanup() {
      clearTimeout(timer);
      clearTimeout(capTimer);
      es?.close();
      es = null;
      document.removeEventListener("visibilitychange", onVisible);
    }

    document.addEventListener("visibilitychange", onVisible);
    if (!capReached()) {
      if (optsRef.current.stream) openStream();
      else startPolling();
    }

    return () => {
      settled = true;
      cleanup();
    };
  }, [taskId]);
}

// ── Elapsed time ──────────────────────────────────────────────────────────────

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}
