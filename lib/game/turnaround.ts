/**
 * Step 1 — concept prompt → TurnaroundSheet, through kie.ai (nano-banana-pro).
 *
 * One sheet with three views is asked for (not three separate images) because
 * a single generation keeps proportions, palette and costume consistent across
 * views; the sheet is then split and checked by `analyzeSheet`.
 */
import { existsSync } from "fs";
import { writeFile } from "fs/promises";
import { join } from "path";
import { setTimeout as sleep } from "timers/promises";
import { KIE_BASE, createKieTask, fetchKieRecord } from "../kieApi";
import { analyzeSheet } from "./sheet";
import type { TurnaroundSheet } from "./artifacts";
import { runDir, runUrl } from "./runs";

export const TURNAROUND_MODEL = "nano-banana-pro";

export function turnaroundPrompt(concept: string): string {
  return [
    `Character turnaround model sheet of ${concept.trim().replace(/\.$/, "")}, for a 3D game character.`,
    "Exactly three full-body views of the same character side by side in one row, evenly spaced, not overlapping, in this order from left to right:",
    "1) FRONT view facing the viewer; 2) SIDE view in strict profile, facing the left edge of the image; 3) BACK view showing the character's back.",
    "Orthographic projection, no perspective. All three views at the same scale and the same height, feet on one shared ground line, tops of the heads aligned.",
    "A-pose: arms straight and angled about 45 degrees down and away from the body so there is clear space between arms and torso, palms facing the thighs, fingers together, legs straight with feet a shoulder-width apart so there is a clear gap between the legs.",
    "Neutral expression, mouth closed. No weapon, no props, no cape, nothing held in the hands.",
    "Flat, even, unlit albedo shading: no shadows, no ambient occlusion, no rim light, no specular highlights, no gradients from a light direction.",
    "Plain pure white background (#FFFFFF) everywhere, no ground shadow, no floor, no text, no labels, no arrows, no borders, no color swatches.",
  ].join(" ");
}

const POLL_MS = 3_000;
const TIMEOUT_MS = 10 * 60_000;

/** Submit, poll and download the sheet; returns the file path and the kie task id. */
async function generateSheet(prompt: string, apiKey: string, outFile: string): Promise<string> {
  const taskId = await createKieTask(`${KIE_BASE}/api/v1/jobs/createTask`, apiKey, {
    model: TURNAROUND_MODEL,
    input: { prompt, aspect_ratio: "3:2", resolution: "2K", output_format: "png" },
  });
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const rec = await fetchKieRecord(taskId, apiKey, "jobs");
    if (rec.state === "done") {
      const res = await fetch(rec.urls[0], { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`sheet download failed: HTTP ${res.status}`);
      await writeFile(outFile, Buffer.from(await res.arrayBuffer()));
      return taskId;
    }
    if (rec.state === "failed") throw new Error(`kie.ai: ${rec.error}`);
    if (rec.state === "auth") throw new Error("kie.ai rejected the API key");
    if (rec.state === "no_output") throw new Error("kie.ai finished without an image");
  }
  throw new Error(`kie.ai task ${taskId} timed out`);
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
 * re-analyse for free) the turnaround sheet.
 */
export async function runTurnaround(opts: { runId: string; concept: string; apiKey: string; regenerate?: boolean }): Promise<TurnaroundSheet> {
  const t0 = Date.now();
  const dir = await runDir(opts.runId);
  const prompt = turnaroundPrompt(opts.concept);
  let kieCredits: number | undefined = 0;
  if (opts.regenerate || !existsSync(join(dir, "sheet.png"))) {
    // Balance delta = what this sheet cost (exact unless other kie jobs run concurrently).
    const before = await kieBalance(opts.apiKey);
    await generateSheet(prompt, opts.apiKey, join(dir, "sheet.png"));
    const after = await kieBalance(opts.apiKey);
    kieCredits = before !== undefined && after !== undefined ? +(before - after).toFixed(2) : undefined;
  }
  const analysis = await analyzeSheet(join(dir, "sheet.png"), dir);
  return {
    kind: "turnaround",
    runId: opts.runId,
    concept: opts.concept,
    prompt,
    model: TURNAROUND_MODEL,
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
