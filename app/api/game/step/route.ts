import { NextRequest, NextResponse } from "next/server";
import { createOnce, parseClientRequestId } from "@/lib/jobStore";
import { ensureJobsRecovered } from "@/lib/kieJobPoller";
import { getKieToken } from "@/lib/getKieToken";
import { GUEST_USER_ID } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { STEP_IO, checkStepInputs, isPropCategory, type ArtifactKind, type StepInputs } from "@/lib/game/artifacts";
import { startGameStepJob, type GameStepRequest } from "@/lib/game/jobs";
import { isBuild } from "@/lib/game/poses";
import { newRunId } from "@/lib/game/runs";

export const maxDuration = 1000;

interface StepBody {
  step?: ArtifactKind;
  runId?: string;
  inputs?: StepInputs;
  build?: string;
  name?: string;
  heightM?: number;
  regenerate?: boolean;
  /** World map: seed of the land/water mask. */
  seed?: number;
  /** Prop sheet: "handheld" | "pickup". */
  category?: string;
  clientRequestId?: string;
}

/**
 * POST /api/game/step — run one game-asset pipeline step as an in-process job.
 * Body: { step, inputs: { artifacts (upstream artifacts by port id), text?,
 * images? }, build? (turnaround), seed? (worldmap), category? (propsheet), runId?, name?, heightM?, regenerate?,
 * clientRequestId }. Returns { taskId, runId }; the artifact arrives on the
 * usual job channel (/api/job-stream, /api/job-status) as
 * `{ status: "done", imageUrl: <preview>, artifact }`. The request is stored on
 * the job row, so a restart mid-step resumes it (lib/game/jobs.ts).
 *
 * The inputs are validated before a job is created, so a rejected input never
 * costs a generation.
 */
export async function POST(req: NextRequest) {
  void ensureJobsRecovered();
  const body = (await req.json().catch(() => ({}))) as StepBody;
  const step = body.step;
  if (!step || !(step in STEP_IO)) {
    return NextResponse.json({ error: "Unknown pipeline step.", code: "invalid" }, { status: 400 });
  }
  const inputs: StepInputs = {
    artifacts: body.inputs?.artifacts ?? {},
    text: typeof body.inputs?.text === "string" ? body.inputs.text : undefined,
    images: Array.isArray(body.inputs?.images) ? body.inputs.images.filter((u): u is string => typeof u === "string") : undefined,
  };
  const ok = checkStepInputs(step, inputs);
  if (!ok.ok) return NextResponse.json({ error: ok.reason, code: "invalid" }, { status: 400 });
  if (body.build !== undefined && !isBuild(body.build)) {
    return NextResponse.json({ error: `Unknown build "${body.build}".`, code: "invalid" }, { status: 400 });
  }
  if (body.category !== undefined && !isPropCategory(body.category)) {
    return NextResponse.json({ error: `Unknown item category "${body.category}".`, code: "invalid" }, { status: 400 });
  }
  const spec = STEP_IO[step];
  if (spec.kie && !(await getKieToken())) {
    return NextResponse.json({ error: "Add your kie.ai API key in Settings first.", code: "auth" }, { status: 401 });
  }
  const runId = inputs.artifacts[spec.inputs[0].id]?.runId ?? body.runId ?? newRunId();
  const clientRequestId = parseClientRequestId(body.clientRequestId);
  const request: GameStepRequest = {
    step, runId, inputs, build: isBuild(body.build) ? body.build : undefined,
    name: body.name, heightM: body.heightM, regenerate: body.regenerate,
    seed: Number.isSafeInteger(body.seed) ? body.seed : undefined,
    category: isPropCategory(body.category) ? body.category : undefined,
  };

  const outcome = await createOnce(clientRequestId, async () => {
    const taskId = `game-${step}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    guestDb.insertGeneration({
      task_id: taskId, user_id: GUEST_USER_ID, generation_type: "asset", status: "pending",
      provider: "game", client_request_id: clientRequestId, model: step,
      prompt: (inputs.text ?? runId).slice(0, 2000),
      request_json: JSON.stringify(request),
    });
    startGameStepJob(taskId, request);
    return { status: 200, body: { taskId, runId } };
  });
  return NextResponse.json(outcome.body, { status: outcome.status });
}
