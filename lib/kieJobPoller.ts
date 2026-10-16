/**
 * Background watcher for kie.ai tasks, plus process-start recovery.
 *
 * The desktop app has no public URL for kie.ai callbacks, so each task is
 * polled — jobs API tasks via `/api/v1/jobs/recordInfo`, Veo tasks via
 * `/api/v1/veo/record-info` — until it reaches a terminal state. The output is
 * mirrored to local storage and settled into the `generations` table.
 *
 * Guarantee: no job stays pending forever. Every watched job settles within its
 * cap (30 min image / 60 min video, counted from creation), only after a final
 * re-check; jobs a restart orphaned are resumed, or marked `interrupted` when
 * they cannot be.
 */
import {
  getJob,
  isLocalJobRunning,
  isLocalProvider,
  listPendingJobs,
  migrateLegacyJobFile,
  settleJob,
  type JobKind,
  type JobRecord,
  type JobResult,
  type TerminalJobResult,
} from "./jobStore";
import { fetchKieRecord, type KieRecord } from "./kieApi";
import { mirrorToStorage } from "./storage";
import { getKieToken } from "./getKieToken";
import { resumeGameStepJob } from "./game/jobs";

const CAP_MS: Record<JobKind, number> = { image: 30 * 60_000, video: 60 * 60_000, asset: 30 * 60_000 };
/** How long kie.ai may report "no record" before we believe it. */
const MISSING_GRACE_MS = 10 * 60_000;
/** kie.ai keeps task records for 14 days. */
const RECORD_RETENTION_MS = 14 * 24 * 60 * 60_000;

const g = globalThis as typeof globalThis & {
  __buonarrotiKiePolling?: Set<string>;
  __buonarrotiJobsRecovered?: boolean;
};
// Process-wide guard against two loops for one task (Next may load this module
// once per route bundle).
const active = (g.__buonarrotiKiePolling ??= new Set<string>());

type KieProvider = "kie" | "kie-veo";

/** Start watching a kie.ai task in the background. Safe to call more than once. */
export function pollKieJob(
  taskId: string,
  apiKey: string,
  kind: JobKind,
  provider: KieProvider,
  createdAt = Date.now(),
): void {
  if (!taskId || active.has(taskId)) return;
  active.add(taskId);
  void loop(taskId, apiKey, kind, provider, createdAt)
    .catch((e) => {
      console.error(`[kie-poller] ${taskId} crashed:`, e);
      settleJob(taskId, {
        status: "error",
        error: "Something went wrong while checking this generation. Retry it.",
        code: "failed",
      });
    })
    .finally(() => active.delete(taskId));
}

/**
 * Make sure a pending job has something driving it to a terminal state:
 * resume the kie.ai poller or a character-pipeline step, or mark it interrupted
 * when nothing can finish it (an in-process Azure/Codex job from a previous
 * process, or a kie.ai job with no API key to poll with).
 */
async function watch(job: JobRecord): Promise<void> {
  if (job.result.status !== "pending") return;

  if (isLocalProvider(job.provider)) {
    if (!isLocalJobRunning(job.taskId) && !(job.provider === "game" && resumeGameStepJob(job))) {
      settleJob(job.taskId, {
        status: "error",
        error: "This generation was interrupted when Buonarroti restarted. Retry it.",
        code: "interrupted",
      });
    }
    return;
  }

  if (active.has(job.taskId)) return;
  const key = await getKieToken();
  if (!key) {
    settleJob(job.taskId, {
      status: "error",
      error: "This generation can't be checked because no kie.ai key is saved. Add your key in Settings, then retry.",
      code: "interrupted",
    });
    return;
  }
  pollKieJob(job.taskId, key, job.kind, job.provider === "kie-veo" ? "kie-veo" : "kie", job.createdAt);
}

/**
 * Once per process: import the legacy job file, then resume or interrupt
 * every job left pending by a previous run.
 */
export async function ensureJobsRecovered(): Promise<void> {
  if (g.__buonarrotiJobsRecovered) return;
  g.__buonarrotiJobsRecovered = true;
  try {
    migrateLegacyJobFile();
    const pending = listPendingJobs();
    for (const job of pending) await watch(job);
    if (pending.length > 0) console.log(`[kie-poller] recovered ${pending.length} pending job(s)`);
  } catch (e) {
    console.error("[kie-poller] job recovery failed:", e);
  }
}

/**
 * Current status of a task for `/api/job-status` and `/api/job-stream`. A
 * pending job is (re)attached to its watcher first, so this never returns a
 * pending state that nothing is working on.
 */
export async function checkJob(taskId: string): Promise<JobResult> {
  await ensureJobsRecovered();
  const job = getJob(taskId);
  if (!job) return { status: "not_found" };
  if (job.result.status !== "pending") return job.result;
  await watch(job);
  return getJob(taskId)?.result ?? { status: "not_found" };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loop(
  taskId: string,
  apiKey: string,
  kind: JobKind,
  provider: KieProvider,
  createdAt: number,
): Promise<void> {
  const endpoint = provider === "kie-veo" ? "veo" : "jobs";
  const deadline = createdAt + CAP_MS[kind];
  let transientStreak = 0;
  let missingSince: number | null = null;

  /** Act on a record; returns true once the job is settled. */
  const handle = async (rec: KieRecord): Promise<boolean> => {
    if (rec.state !== "transient") transientStreak = 0;
    if (rec.state !== "missing") missingSince = null;
    switch (rec.state) {
      case "done":
        await settleSuccess(taskId, kind, rec.urls);
        return true;
      case "no_output":
        settleJob(taskId, {
          status: "error",
          error: "kie.ai reported success but sent back no file. Retry it, or check your kie.ai logs.",
          code: "failed",
        });
        return true;
      case "failed":
        settleJob(taskId, { status: "error", error: rec.error, code: rec.code });
        return true;
      case "auth":
        settleJob(taskId, {
          status: "error",
          error: "kie.ai no longer accepts your API key, so this result can't be fetched. Update the key in Settings, then retry.",
          code: "failed",
        });
        return true;
      case "missing": {
        const now = Date.now();
        missingSince ??= now;
        if (now - missingSince >= MISSING_GRACE_MS || now - createdAt >= RECORD_RETENTION_MS) {
          settleJob(taskId, {
            status: "error",
            error: "kie.ai has no record of this generation. Retry it.",
            code: "failed",
          });
          return true;
        }
        return false;
      }
      case "transient":
        transientStreak++;
        if (transientStreak === 1 || transientStreak % 10 === 0) {
          console.warn(`[kie-poller] ${taskId} transient poll error (x${transientStreak}): ${rec.detail}`);
        }
        return false;
      case "pending":
        return false;
    }
  };

  while (Date.now() < deadline) {
    const age = Date.now() - createdAt;
    const base = age < 2 * 60_000 ? 3_000 : age < 10 * 60_000 ? 5_000 : 10_000;
    const backoff = transientStreak > 0 ? Math.min(30_000, 3_000 * 2 ** Math.min(transientStreak, 4)) : base;
    await sleep(Math.max(1_000, Math.min(backoff, deadline - Date.now())));
    if (await handle(await fetchKieRecord(taskId, apiKey, endpoint))) return;
  }

  // Cap reached: one last look before giving up, so a job that finished at the
  // wire is never written off.
  if (await handle(await fetchKieRecord(taskId, apiKey, endpoint))) return;
  const minutes = CAP_MS[kind] / 60_000;
  settleJob(taskId, {
    status: "error",
    error: `Stopped waiting after ${minutes} minutes. kie.ai may still finish it — check your kie.ai logs, or retry.`,
    code: "timeout",
  });
}

async function settleSuccess(taskId: string, kind: JobKind, kieUrls: string[]): Promise<void> {
  const folder = kind === "video" ? "videos" : "images";
  const stored = await Promise.all(
    kieUrls.map((u) =>
      mirrorToStorage(u, folder).catch((e: unknown) => {
        // kie.ai's URL still works for a while; keep the result rather than fail it.
        console.error(`[kie-poller] ${taskId} couldn't save ${u} locally, keeping the kie.ai URL:`, (e as Error).message);
        return u;
      }),
    ),
  );

  const result: TerminalJobResult =
    kind === "video"
      ? { status: "done", videoUrl: stored[0] }
      : { status: "done", imageUrl: stored[0], imageUrls: stored };
  settleJob(taskId, result);
}
