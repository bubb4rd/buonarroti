/**
 * Character-pipeline steps as in-process jobs. The request (never the keys) is
 * stored on the job row, so a step cut off by a server restart is started again
 * by job recovery instead of failing as "interrupted". Every step is safe to
 * re-run: outputs are rewritten, a paid kie.ai sheet already downloaded (or
 * still rendering) is reused, and `regenerate` discards the cache when the job
 * first starts, not on resume.
 */
import { runLocalJob, type JobRecord, type TerminalJobResult } from "../jobStore";
import { getKieToken } from "../getKieToken";
import { getHfToken } from "../guest/db";
import type { Artifact, ArtifactKind } from "./artifacts";
import type { Build } from "./poses";
import { runStep } from "./pipeline";

export interface GameStepRequest {
  step: ArtifactKind;
  runId: string;
  input?: Artifact;
  concept?: string;
  build?: Build;
  name?: string;
  heightM?: number;
  regenerate?: boolean;
}

export function startGameStepJob(taskId: string, req: GameStepRequest): void {
  runLocalJob(taskId, async (): Promise<TerminalJobResult> => {
    const artifact = await runStep({
      ...req,
      kieApiKey: req.step === "turnaround" ? (await getKieToken()) ?? undefined : undefined,
      hfToken: getHfToken() ?? undefined,
    });
    return { status: "done", imageUrl: artifact.previewUrl, artifact };
  });
}

/** Restart a pending step left behind by a previous process; false if it can't be. */
export function resumeGameStepJob(job: JobRecord): boolean {
  const req = job.request as GameStepRequest | undefined;
  if (!req?.step || !req.runId) return false;
  console.log(`[game] resuming ${job.taskId} (${req.step}, run ${req.runId})`);
  startGameStepJob(job.taskId, { ...req, regenerate: false });
  return true;
}
