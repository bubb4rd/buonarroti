/**
 * Step 1 — concept prompt → TurnaroundSheet, through kie.ai (nano-banana-pro).
 *
 * One sheet with three views is asked for (not three separate images) because
 * a single generation keeps proportions, palette and costume consistent across
 * views; the sheet is then split and checked by `analyzeSheet`.
 *
 * Pose and layout are given as an image, not as words: the request carries a
 * mannequin turnaround (./poses.ts) and the text only says to follow it. With
 * the pose described in words, arm angles came back anywhere from 46 to 68
 * degrees (3 of 5 sheets over the rig's 60); with the mannequin, 42-45 on 6 of 6.
 */
import { existsSync } from "fs";
import { readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
import { KIE_BASE, createKieTask, fetchKieRecord } from "../kieApi";
import { ensureKieReachable } from "../kieUpload";
import { analyzeSheet } from "./sheet";
import type { TurnaroundSheet } from "./artifacts";
import { POSE, buildSpec, type Build } from "./poses";
import { runDir, runUrl } from "./runs";
import { runBlender } from "./tools";

export const TURNAROUND_MODEL = "nano-banana-pro";

export function turnaroundPrompt(concept: string): string {
  return [
    `Character turnaround model sheet of ${concept.trim().replace(/\.$/, "")}, for a 3D game character.`,
    "The attached image is the pose and layout guide. Draw the character three times, exactly where the mannequin figures are: front view on the left, strict left profile facing the left edge in the middle, back view on the right.",
    "Match the mannequin's pose exactly (arm angle, gap between arms and body, leg spread), its proportions, its scale and its ground line. Orthographic, no perspective.",
    "Take only pose, proportions, camera and layout from the guide; costume, colours and style come from the description.",
    "Neutral expression, mouth closed. No weapon, no props, no cape, nothing held in the hands.",
    "Flat, even, unlit albedo shading: no shadows, no ambient occlusion, no rim light, no specular highlights, no gradients from a light direction.",
    "Plain pure white background (#FFFFFF) everywhere, no ground shadow, no floor, no text, no labels, no arrows, no borders, no color swatches.",
  ].join(" ");
}

/** Render the mannequin for `build` (2528×1696, the sheet's 3:2 at 2K). */
export async function renderPoseTemplate(build: Build, outPng: string): Promise<void> {
  await runBlender("pose_template", {
    out_png: outPng, arm_deg: POSE.armDeg, stance: POSE.stance, build: buildSpec(build), width: 2528, height: 1696,
  });
}

const POLL_MS = 3_000;
const TIMEOUT_MS = 10 * 60_000;

/**
 * Submit, poll and download the sheet. The kie task id is kept next to the
 * sheet until it lands, so a step resumed after a restart polls the task it
 * already paid for instead of submitting a second one. Returns true when a new
 * task was submitted.
 */
async function generateSheet(prompt: string, posePng: string, apiKey: string, outFile: string): Promise<boolean> {
  const taskFile = `${outFile}.task`;
  const pending = existsSync(taskFile) ? (await readFile(taskFile, "utf8")).trim() : "";
  let taskId = pending;
  if (!taskId) {
    const guide = await ensureKieReachable(`data:image/png;base64,${(await readFile(posePng)).toString("base64")}`, apiKey);
    taskId = await createKieTask(`${KIE_BASE}/api/v1/jobs/createTask`, apiKey, {
      model: TURNAROUND_MODEL,
      input: { prompt, image_input: [guide], aspect_ratio: "3:2", resolution: "2K", output_format: "png" },
    });
    await writeFile(taskFile, taskId);
  }
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const rec = await fetchKieRecord(taskId, apiKey, "jobs");
      if (rec.state === "done") {
        const res = await fetch(rec.urls[0], { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`sheet download failed: HTTP ${res.status}`);
        await writeFile(outFile, Buffer.from(await res.arrayBuffer()));
        return !pending;
      }
      if (rec.state === "failed") throw new Error(`kie.ai: ${rec.error}`);
      if (rec.state === "auth") throw new Error("kie.ai rejected the API key");
      if (rec.state === "no_output") throw new Error("kie.ai finished without an image");
    }
    throw new Error(`kie.ai task ${taskId} timed out`);
  } finally {
    // Settled either way (a restart never reaches this): the next attempt starts fresh.
    await rm(taskFile, { force: true });
  }
}

/** kie.ai balance in credits (the same endpoint the app's credit badge uses). */
export async function kieBalance(apiKey: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${KIE_BASE}/api/v1/chat/credit`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json()) as { data?: number };
    return typeof json.data === "number" ? json.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Generate (or, when the run already has a sheet and `regenerate` is false,
 * re-analyse for free) the turnaround sheet. `regenerate` deletes the cached
 * sheet first, so a resumed job (always regenerate: false) keeps what the
 * interrupted attempt paid for. The mannequin used is kept as pose.png, its
 * build in pose.json, next to the sheet it produced.
 */
export async function runTurnaround(opts: { runId: string; concept: string; build: Build; apiKey: string; regenerate?: boolean }): Promise<TurnaroundSheet> {
  const t0 = Date.now();
  const dir = await runDir(opts.runId);
  const sheet = join(dir, "sheet.png");
  const pose = join(dir, "pose.png");
  const poseInfo = join(dir, "pose.json");
  const prompt = turnaroundPrompt(opts.concept);
  if (opts.regenerate) {
    await rm(sheet, { force: true });
    await rm(`${sheet}.task`, { force: true });
  }
  let kieCredits: number | undefined = 0;
  if (!existsSync(sheet)) {
    if (!existsSync(`${sheet}.task`)) {
      await renderPoseTemplate(opts.build, pose);
      await writeFile(poseInfo, JSON.stringify({ build: opts.build, ...POSE }));
    }
    // Balance delta = what this sheet cost (exact unless other kie jobs run
    // concurrently); unknown when an earlier attempt submitted the task.
    const before = await kieBalance(opts.apiKey);
    const submitted = await generateSheet(prompt, pose, opts.apiKey, sheet);
    const after = await kieBalance(opts.apiKey);
    kieCredits = submitted && before !== undefined && after !== undefined ? +(before - after).toFixed(2) : undefined;
  }
  const analysis = await analyzeSheet(sheet, dir);
  const used = existsSync(poseInfo) ? (JSON.parse(await readFile(poseInfo, "utf8")) as { build: Build }) : undefined;
  return {
    kind: "turnaround",
    runId: opts.runId,
    concept: opts.concept,
    prompt,
    model: TURNAROUND_MODEL,
    build: used?.build,
    poseUrl: used ? runUrl(opts.runId, "pose.png") : undefined,
    sheetUrl: runUrl(opts.runId, "sheet.png"),
    previewUrl: runUrl(opts.runId, "sheet.png"),
    width: analysis.width,
    height: analysis.height,
    views: analysis.views,
    checks: analysis.checks,
    createdAt: new Date().toISOString(),
    cost: { seconds: (Date.now() - t0) / 1000, kieCredits },
  };
}
