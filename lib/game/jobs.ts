/**
 * Game-asset pipeline steps as in-process jobs. The request (never the keys) is
 * stored on the job row, so a step cut off by a server restart is started again
 * by job recovery instead of failing as "interrupted". Every step is safe to
 * re-run: outputs are rewritten, a paid kie.ai picture already downloaded (or
 * still rendering) is reused, and `regenerate` discards the cache when the job
 * first starts, not on resume.
 */
import { runLocalJob, type JobRecord, type TerminalJobResult } from "../jobStore";
import { getKieToken } from "../getKieToken";
import { getHfToken } from "../guest/db";
import { STEP_IO } from "./artifacts";
import { runStep, type StepRequest } from "./pipeline";

export type GameStepRequest = Omit<StepRequest, "kieApiKey" | "hfToken">;

export function startGameStepJob(taskId: string, req: GameStepRequest): void {
  runLocalJob(taskId, async (): Promise<TerminalJobResult> => {
    const artifact = await runStep({
      ...req,
      kieApiKey: STEP_IO[req.step].kie ? (await getKieToken()) ?? undefined : undefined,
      hfToken: getHfToken() ?? undefined,
    });
    return { status: "done", imageUrl: artifact.previewUrl, artifact };
  });
}

/** Restart a pending step left behind by a previous process; false if it can't be. */
export function resumeGameStepJob(job: JobRecord): boolean {
  const req = job.request as GameStepRequest | undefined;
  if (!req?.step || !req.runId || !req.inputs) return false;
  console.log(`[game] resuming ${job.taskId} (${req.step}, run ${req.runId})`);
  startGameStepJob(job.taskId, { ...req, regenerate: false });
  return true;
}
