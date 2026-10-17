/**
 * kie.ai HTTP helpers shared by the generate routes and the job poller:
 * task creation with failure classification, and status lookups for both the
 * jobs API (`/api/v1/jobs/recordInfo`) and the Veo API (`/api/v1/veo/record-info`).
 */

export const KIE_BASE = "https://api.kie.ai";

/** Error classes for `POST /api/generate*` failures (see the generation contract). */
export type CreateErrorCode = "credits" | "auth" | "invalid" | "upstream" | "rate_limited";

export class KieCreateError extends Error {
  constructor(
    message: string,
    readonly code: CreateErrorCode,
    readonly httpStatus: number,
  ) {
    super(message);
  }
}

/** Map a kie.ai HTTP status or body `code` to the create-error contract. */
export function classifyKieFailure(status: number, detail?: string): KieCreateError {
  const tail = detail ? ` (${detail.slice(0, 300)})` : "";
  if (status === 401 || status === 403) {
    return new KieCreateError("kie.ai didn't accept your API key. Update it in Settings, then try again.", "auth", 401);
  }
  if (status === 402) {
    return new KieCreateError("Your kie.ai balance is too low for this generation. Top up at kie.ai, then try again.", "credits", 402);
  }
  if (status === 429) {
    return new KieCreateError("kie.ai is limiting requests right now. Wait a moment, then try again.", "rate_limited", 429);
  }
  if (status >= 400 && status < 500) {
    return new KieCreateError(detail?.trim() || "kie.ai rejected the request. Check the prompt and settings, then try again.", "invalid", 400);
  }
  return new KieCreateError(`kie.ai couldn't start the generation${tail}. Try again in a minute.`, "upstream", 502);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Connection-level failures where the request provably never reached kie.ai, so
// retrying cannot create a second paid task.
const UNSENT_ERRORS = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH"]);

function unsentNetworkError(e: unknown): boolean {
  if (!(e instanceof Error) || !e.cause || typeof e.cause !== "object" || !("code" in e.cause)) return false;
  return typeof e.cause.code === "string" && UNSENT_ERRORS.has(e.cause.code);
}

/**
 * Create a kie.ai task and return its id. Retries only when no task can have
 * been created (429, 503, or a connection that never opened). Throws
 * `KieCreateError` on failure.
 */
export async function createKieTask(endpoint: string, apiKey: string, body: unknown): Promise<string> {
  const payload = JSON.stringify(body);
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= 3;
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: payload,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      if (!last && unsentNetworkError(e)) {
        await sleep(1_000 * attempt);
        continue;
      }
      throw new KieCreateError(
        `Couldn't reach kie.ai (${(e as Error).message}). Check your connection, then try again.`,
        "upstream",
        502,
      );
    }

    const text = await res.text();
    let json: { code?: number; msg?: string; data?: { taskId?: string; id?: string }; taskId?: string; id?: string } | null = null;
    try { json = JSON.parse(text); } catch { /* handled below */ }

    const status = !res.ok ? res.status : (json?.code ?? 200);
    if ((status === 429 || status === 503) && !last) {
      await sleep(1_500 * attempt);
      continue;
    }
    if (!res.ok || (json?.code !== undefined && json.code !== 200)) {
      throw classifyKieFailure(status, json?.msg ?? text);
    }
    if (!json) throw classifyKieFailure(502, `unexpected response: ${text.slice(0, 120)}`);

    const taskId = json.data?.taskId ?? json.data?.id ?? json.taskId ?? json.id;
    if (!taskId) throw classifyKieFailure(502, "no task id in response");
    return taskId;
  }
}

// ── Status lookups ──────────────────────────────────────────────────────────

export type KieEndpoint = "jobs" | "veo";

export type KieRecord =
  | { state: "pending" }
  | { state: "done"; urls: string[] }
  /** kie.ai reported success but sent no output file. */
  | { state: "no_output" }
  | { state: "failed"; error: string; code: "credits" | "failed" | "rejected" }
  /** kie.ai has no record (yet) — `recordInfo is null`, 404, 422. */
  | { state: "missing"; detail: string }
  | { state: "auth" }
  /** Network error, 429, 5xx, maintenance — retry later. */
  | { state: "transient"; detail: string };

const REJECTED_RE = /(polic|flagged|sensitive|nsfw|moderat|safety|prohibit|violat|unsafe)/i;

function failure(message: string | undefined, fallback: string): KieRecord {
  const error = message?.trim() || fallback;
  return { state: "failed", error, code: REJECTED_RE.test(error) ? "rejected" : "failed" };
}

export async function fetchKieRecord(taskId: string, apiKey: string, endpoint: KieEndpoint): Promise<KieRecord> {
  const path = endpoint === "veo" ? "/api/v1/veo/record-info" : "/api/v1/jobs/recordInfo";
  let res: Response;
  try {
    res = await fetch(`${KIE_BASE}${path}?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch (e) {
    return { state: "transient", detail: (e as Error).message };
  }

  let json: { code?: number; msg?: string; data?: Record<string, unknown> | null } | null = null;
  try { json = await res.json(); } catch { /* handled below */ }

  const code = !res.ok ? res.status : (json?.code ?? 200);
  const msg = json?.msg ?? `HTTP ${res.status}`;
  if (code === 401 || code === 403) return { state: "auth" };
  if (code === 402) {
    return {
      state: "failed",
      error: "Your kie.ai balance ran out before this generation finished. Top up at kie.ai, then retry.",
      code: "credits",
    };
  }
  if (code === 404 || code === 422) return { state: "missing", detail: msg };
  if (code !== 200 && code !== 0) return { state: "transient", detail: `${code}: ${msg}` };
  if (!json) return { state: "transient", detail: `non-JSON response (HTTP ${res.status})` };

  const data = json.data;
  if (!data) return { state: "missing", detail: msg };
  return endpoint === "veo" ? mapVeoRecord(data) : mapJobsRecord(data);
}

/**
 * Veo record-info (docs.kie.ai/veo3-api/get-veo-3-video-details):
 * `data.successFlag` 0 = generating, 1 = success, 2 = failed, 3 = generation
 * failed; outputs in `data.response.resultUrls` (also `fullResultUrls`,
 * `originUrls`); failures in `data.errorCode` / `data.errorMessage`.
 */
function mapVeoRecord(data: Record<string, unknown>): KieRecord {
  const flag = Number(data.successFlag);
  if (flag === 1) {
    const response = (data.response ?? {}) as Record<string, unknown>;
    const urls = [response.resultUrls, response.fullResultUrls, response.originUrls]
      .map((v) => (Array.isArray(v) ? v.filter((u): u is string => typeof u === "string" && !!u) : []))
      .find((list) => list.length > 0);
    return urls ? { state: "done", urls } : { state: "no_output" };
  }
  if (flag === 2 || flag === 3) {
    return failure(data.errorMessage as string | undefined, "Veo couldn't generate this video.");
  }
  return { state: "pending" };
}

/**
 * Jobs recordInfo (docs.kie.ai/market/common/get-task-detail): `data.state` is
 * waiting | queuing | generating | success | fail; outputs live in the
 * `data.resultJson` string (`resultUrls`); failures in `failCode` / `failMsg`.
 */
function mapJobsRecord(data: Record<string, unknown>): KieRecord {
  const state = String(data.state ?? data.status ?? "").toLowerCase();
  if (state === "success" || state === "succeeded") {
    const urls = extractUrls(data);
    return urls.length > 0 ? { state: "done", urls } : { state: "no_output" };
  }
  if (state === "fail" || state === "failed" || state === "error") {
    return failure(
      (data.failMsg as string) || (data.error as string) || (data.failReason as string),
      "kie.ai couldn't complete this generation.",
    );
  }
  return { state: "pending" };
}

function extractUrls(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (Array.isArray(v)) for (const u of v) { if (typeof u === "string" && u) out.push(u); }
    else if (typeof v === "string" && v) out.push(v);
  };

  if (typeof data.resultJson === "string" && data.resultJson) {
    try {
      const parsed = JSON.parse(data.resultJson) as Record<string, unknown>;
      push(parsed.resultUrls ?? parsed.resultUrl ?? parsed.result_urls);
    } catch (e) {
      console.warn("[kie] resultJson is not valid JSON:", (e as Error).message);
    }
  }
  if (out.length === 0) push(data.videoUrl);
  if (out.length === 0) push(Array.isArray(data.output) ? data.output.slice(0, 1) : data.output);
  return out;
}
