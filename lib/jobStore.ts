/**
 * Generation job state. The SQLite `generations` table is the single source of
 * truth — a row is inserted as `pending` when a task is created and settled to
 * `done` / `error` exactly once. `jobEvents` wakes open SSE streams on settle.
 */
import { existsSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "./guest/paths";
import { jobEvents } from "./jobEvents";
import { VIDEO_MODELS } from "./modelConfig";
import { GUEST_USER_ID } from "./guestMode";
import * as guestDb from "./guest/db";

/** "asset" = a character-pipeline step (lib/game); its result carries a typed artifact. */
export type JobKind = "image" | "video" | "asset";
/** "kie" = jobs API, "kie-veo" = Veo API, "azure"/"codex"/"game" = run in this process. */
export type JobProvider = "kie" | "kie-veo" | "azure" | "codex" | "game";
export type JobErrorCode = "credits" | "interrupted" | "timeout" | "failed" | "rejected";

export type JobDone = { status: "done"; imageUrl?: string; imageUrls?: string[]; videoUrl?: string; artifact?: unknown };
export type JobError = { status: "error"; error: string; code?: JobErrorCode };
export type TerminalJobResult = JobDone | JobError;
/** The exact `GET /api/job-status` / `job-stream` payloads. */
export type JobResult = { status: "pending" } | TerminalJobResult | { status: "not_found" };

export interface JobRecord {
  taskId: string;
  kind: JobKind;
  provider: JobProvider;
  createdAt: number;
  result: Exclude<JobResult, { status: "not_found" }>;
}

const ERROR_CODES = new Set<string>(["credits", "interrupted", "timeout", "failed", "rejected"]);
const PROVIDERS = new Set<string>(["kie", "kie-veo", "azure", "codex", "game"]);
const VEO_MODEL_IDS = new Set(VIDEO_MODELS.filter((m) => m.apiInput.useGoogleVeo).map((m) => m.id));

/** Rows written before the `provider` column existed are inferred from the id/model. */
function providerOf(gen: guestDb.Generation): JobProvider {
  if (gen.provider && PROVIDERS.has(gen.provider)) return gen.provider as JobProvider;
  if (gen.task_id.startsWith("azure-")) return "azure";
  if (gen.task_id.startsWith("codex-")) return "codex";
  if (gen.task_id.startsWith("game-")) return "game";
  return gen.model && VEO_MODEL_IDS.has(gen.model) ? "kie-veo" : "kie";
}

export function isLocalProvider(provider: JobProvider): boolean {
  return provider === "azure" || provider === "codex" || provider === "game";
}

function toRecord(gen: guestDb.Generation): JobRecord {
  const kind: JobKind = gen.generation_type === "video" ? "video" : gen.generation_type === "asset" ? "asset" : "image";
  let result: JobRecord["result"];
  if (gen.status === "done") {
    result = gen.video_url
      ? { status: "done", videoUrl: gen.video_url }
      : {
          status: "done", imageUrl: gen.image_url, imageUrls: gen.image_urls,
          ...(gen.artifact_json ? { artifact: JSON.parse(gen.artifact_json) } : {}),
        };
  } else if (gen.status === "error") {
    result = {
      status: "error",
      error: gen.error_msg || "This generation failed. Retry it.",
      ...(gen.error_code && ERROR_CODES.has(gen.error_code) ? { code: gen.error_code as JobErrorCode } : {}),
    };
  } else {
    result = { status: "pending" };
  }
  const createdAt = Date.parse(gen.created_at);
  return {
    taskId: gen.task_id,
    kind,
    provider: providerOf(gen),
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    result,
  };
}

export function getJob(taskId: string): JobRecord | null {
  const gen = guestDb.getGenerationByTaskId(taskId);
  return gen ? toRecord(gen) : null;
}

export function listPendingJobs(): JobRecord[] {
  return guestDb.listPendingGenerations().map(toRecord);
}

/**
 * Record a job's terminal result and wake any open stream. A job settles once:
 * later calls for an already-settled job are ignored, so a late timeout can
 * never overwrite a result that landed first.
 */
export function settleJob(taskId: string, result: TerminalJobResult): void {
  const current = guestDb.getGenerationByTaskId(taskId);
  if (current && current.status !== "pending") return;

  if (result.status === "done") {
    guestDb.updateGeneration(
      taskId,
      result.videoUrl
        ? { status: "done", video_url: result.videoUrl, error_msg: undefined, error_code: undefined }
        : {
            status: "done", image_url: result.imageUrl, image_urls: result.imageUrls, error_msg: undefined, error_code: undefined,
            ...(result.artifact !== undefined ? { artifact_json: JSON.stringify(result.artifact) } : {}),
          },
    );
  } else {
    guestDb.updateGeneration(taskId, { status: "error", error_msg: result.error, error_code: result.code });
  }
  jobEvents.emit(`job:${taskId}`, result);
}

// ── In-process jobs (Azure, Codex) ─────────────────────────────────────────

// Process-wide (globalThis survives Next's per-route module copies and HMR), so
// a pending azure-/codex- row that is NOT in this set was started by a previous
// process and can never finish.
const g = globalThis as typeof globalThis & {
  __buonarrotiLocalJobs?: Set<string>;
  __buonarrotiCreates?: Map<string, Promise<CreateOutcome>>;
};
const localJobs = (g.__buonarrotiLocalJobs ??= new Set<string>());

export function isLocalJobRunning(taskId: string): boolean {
  return localJobs.has(taskId);
}

/** Run an in-process generation in the background and settle its row. */
export function runLocalJob(taskId: string, work: () => Promise<TerminalJobResult>): void {
  localJobs.add(taskId);
  void work()
    .then((result) => settleJob(taskId, result))
    .catch((e: unknown) => {
      console.error(`[jobs] ${taskId} failed:`, e);
      settleJob(taskId, { status: "error", error: e instanceof Error ? e.message : String(e), code: "failed" });
    })
    .finally(() => localJobs.delete(taskId));
}

// ── Idempotent creation ────────────────────────────────────────────────────

export interface CreateOutcome {
  status: number;
  body: Record<string, unknown>;
}

const inflightCreates = (g.__buonarrotiCreates ??= new Map<string, Promise<CreateOutcome>>());

/** Accept a client idempotency key: a non-empty string up to 128 chars. */
export function parseClientRequestId(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : undefined;
}

/**
 * Create a job at most once per `clientRequestId`. A key already stored on a
 * generation row returns that task; a concurrent duplicate waits for the first
 * request and shares its outcome. Failed attempts are not remembered, so the
 * client can retry with the same key.
 */
export async function createOnce(
  clientRequestId: string | undefined,
  create: () => Promise<CreateOutcome>,
): Promise<CreateOutcome> {
  if (!clientRequestId) return create();

  const existing = guestDb.getGenerationByClientRequestId(clientRequestId);
  if (existing) return { status: 200, body: { taskId: existing.task_id } };

  const running = inflightCreates.get(clientRequestId);
  if (running) return running;

  const attempt = create().finally(() => inflightCreates.delete(clientRequestId));
  inflightCreates.set(clientRequestId, attempt);
  return attempt;
}

// ── Legacy `.job-store.json` ───────────────────────────────────────────────

const LEGACY_FILE = join(DATA_DIR, ".job-store.json");

type LegacyEntry =
  | { status: "pending"; type?: JobKind }
  | { status: "done"; imageUrl?: string; imageUrls?: string[]; videoUrl?: string }
  | { status: "error"; error?: string };

/**
 * Older builds kept job state in `DATA_DIR/.job-store.json`. Import the entries
 * the DB doesn't know about (pending ones then resume or are marked
 * interrupted), then move the file aside so it is never read again.
 */
export function migrateLegacyJobFile(): void {
  if (!existsSync(LEGACY_FILE)) return;
  try {
    const data = JSON.parse(readFileSync(LEGACY_FILE, "utf8")) as Record<string, LegacyEntry>;
    let imported = 0;
    for (const [taskId, entry] of Object.entries(data)) {
      if (!entry || typeof entry !== "object" || guestDb.getGenerationByTaskId(taskId)) continue;
      const isVideo = (entry.status === "pending" && entry.type === "video") || (entry.status === "done" && !!entry.videoUrl);
      guestDb.insertGeneration({
        task_id: taskId,
        user_id: GUEST_USER_ID,
        generation_type: isVideo ? "video" : "image",
        status: entry.status === "done" || entry.status === "error" ? entry.status : "pending",
        ...(entry.status === "done"
          ? { image_url: entry.imageUrl, image_urls: entry.imageUrls, video_url: entry.videoUrl }
          : {}),
        ...(entry.status === "error" ? { error_msg: entry.error, error_code: "failed" } : {}),
      });
      imported++;
    }
    console.log(`[jobs] imported ${imported} job(s) from legacy .job-store.json`);
  } catch (e) {
    console.error("[jobs] legacy .job-store.json is unreadable, setting it aside:", (e as Error).message);
  }
  renameSync(LEGACY_FILE, join(DATA_DIR, ".job-store.migrated.json"));
}
