import { NextRequest, NextResponse } from "next/server";
import { createOnce, parseClientRequestId } from "@/lib/jobStore";
import { ensureJobsRecovered } from "@/lib/kieJobPoller";
import { getKieToken } from "@/lib/getKieToken";
import { GUEST_USER_ID } from "@/lib/guestMode";
import * as guestDb from "@/lib/guest/db";
import { STEP_IO, accepts, type Artifact, type ArtifactKind } from "@/lib/game/artifacts";
import { startGameStepJob, type GameStepRequest } from "@/lib/game/jobs";
import { isBuild } from "@/lib/game/poses";
import { newRunId } from "@/lib/game/runs";

export const maxDuration = 1000;

interface StepBody {
  step?: ArtifactKind;
  runId?: string;
  input?: Artifact;
  concept?: string;
  build?: string;
  name?: string;
  heightM?: number;
  regenerate?: boolean;
  clientRequestId?: string;
}

/**
 * POST /api/game/step — run one character-pipeline step as an in-process job.
 * Body: { step, input? (upstream artifact), concept? and build? (turnaround),
 * runId?, name?, heightM?, regenerate?, clientRequestId }. Returns { taskId, runId }; the
 * artifact arrives on the usual job channel (/api/job-stream, /api/job-status)
 * as `{ status: "done", imageUrl: <preview>, artifact }`. The request is stored
 * on the job row, so a restart mid-step resumes it (lib/game/jobs.ts).
 *
 * The upstream artifact is validated before a job is created, so a rejected
 * input never costs a generation.
 */
export async function POST(req: NextRequest) {
  void ensureJobsRecovered();
  const body = (await req.json().catch(() => ({}))) as StepBody;
  const step = body.step;
  if (!step || !(step in STEP_IO)) {
    return NextResponse.json({ error: "Unknown pipeline step.", code: "invalid" }, { status: 400 });
  }
  const need = STEP_IO[step].input;
  if (need === "prompt") {
    if (!body.concept?.trim()) {
      return NextResponse.json({ error: "Connect a text node with the character concept.", code: "invalid" }, { status: 400 });
    }
    if (body.build !== undefined && !isBuild(body.build)) {
      return NextResponse.json({ error: `Unknown build "${body.build}".`, code: "invalid" }, { status: 400 });
    }
  } else {
    const ok = accepts(body.input, need);
    if (!ok.ok) return NextResponse.json({ error: ok.reason, code: "invalid" }, { status: 400 });
  }
  const runId = body.input?.runId ?? body.runId ?? newRunId();
  if (need === "prompt" && !(await getKieToken())) {
    return NextResponse.json({ error: "Add your kie.ai API key in Settings first.", code: "auth" }, { status: 401 });
  }
  const clientRequestId = parseClientRequestId(body.clientRequestId);
  const request: GameStepRequest = {
    step, runId, input: body.input, concept: body.concept, build: isBuild(body.build) ? body.build : undefined,
    name: body.name, heightM: body.heightM, regenerate: body.regenerate,
  };

  const outcome = await createOnce(clientRequestId, async () => {
    const taskId = `game-${step}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    guestDb.insertGeneration({
      task_id: taskId, user_id: GUEST_USER_ID, generation_type: "asset", status: "pending",
      provider: "game", client_request_id: clientRequestId, model: step,
      prompt: (body.concept ?? body.input?.runId ?? "").slice(0, 2000),
      request_json: JSON.stringify(request),
    });
    startGameStepJob(taskId, request);
    return { status: 200, body: { taskId, runId } };
  });
  return NextResponse.json(outcome.body, { status: outcome.status });
}
