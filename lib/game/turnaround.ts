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
import { analyzeSheet } from "./sheet";
import type { Hands, StyleGuide, TurnaroundSheet } from "./artifacts";
import { generateKieImage } from "./kieImage";
import { POSE, buildSpec, type Build } from "./poses";
import { runDir, runUrl } from "./runs";
import { paletteFitCheck, stylePrompt, styleRefFiles } from "./style";
import { runBlender } from "./tools";

export const TURNAROUND_MODEL = "nano-banana-pro";

export function turnaroundPrompt(concept: string, style?: StyleGuide): string {
  return [
    `Character turnaround model sheet of ${concept.trim().replace(/\.$/, "")}, for a 3D game character.`,
    "Attached image 1 is the pose and layout guide. Draw the character three times, exactly where the mannequin figures are: front view on the left, strict left profile facing the left edge in the middle, back view on the right.",
    "Match the mannequin's pose exactly (arm angle, gap between arms and body, leg spread), its proportions, its scale and its ground line. Orthographic, no perspective.",
    style
      ? "Take only pose, proportions, camera and layout from the guide; costume and colours come from the description."
      : "Take only pose, proportions, camera and layout from the guide; costume, colours and style come from the description.",
    stylePrompt(style, 2),
    "Neutral expression, mouth closed. Both hands clenched into empty closed fists, like the mannequin's. No weapon, no props, no cape, nothing held in the hands.",
    "Flat, even, unlit albedo shading: no shadows, no ambient occlusion, no rim light, no specular highlights, no gradients from a light direction.",
    "Plain pure white background (#FFFFFF) everywhere, no ground shadow, no floor, no text, no labels, no arrows, no borders, no color swatches.",
  ].filter(Boolean).join(" ");
}

/** Render the mannequin for `build` (2528×1696, the sheet's 3:2 at 2K). */
export async function renderPoseTemplate(build: Build, outPng: string): Promise<void> {
  await runBlender("pose_template", {
    out_png: outPng, arm_deg: POSE.armDeg, stance: POSE.stance, build: buildSpec(build), width: 2528, height: 1696,
  });
}

/**
 * Generate (or, when the run already has a sheet and `regenerate` is false,
 * re-analyse for free) the turnaround sheet. `regenerate` deletes the cached
 * sheet first, so a resumed job (always regenerate: false) keeps what the
 * interrupted attempt paid for. The mannequin used is kept as pose.png, its
 * build and the prompt actually sent in pose.json, next to the sheet it produced.
 */
export async function runTurnaround(opts: { runId: string; concept: string; build: Build; style?: StyleGuide; apiKey: string; regenerate?: boolean }): Promise<TurnaroundSheet> {
  const t0 = Date.now();
  const dir = await runDir(opts.runId);
  const sheet = join(dir, "sheet.png");
  const pose = join(dir, "pose.png");
  const poseInfo = join(dir, "pose.json");
  if (opts.regenerate) {
    await rm(sheet, { force: true });
    await rm(`${sheet}.task`, { force: true });
  }
  let kieCredits: number | undefined = 0;
  if (!existsSync(sheet)) {
    if (!existsSync(`${sheet}.task`)) {
      await renderPoseTemplate(opts.build, pose);
      await writeFile(poseInfo, JSON.stringify({ build: opts.build, ...POSE, prompt: turnaroundPrompt(opts.concept, opts.style), style: opts.style?.runId }));
    }
    const sent = JSON.parse(await readFile(poseInfo, "utf8")) as { prompt: string };
    kieCredits = await generateKieImage({
      model: TURNAROUND_MODEL, prompt: sent.prompt, images: [pose, ...styleRefFiles(opts.style)],
      aspectRatio: "3:2", resolution: "2K", outFile: sheet, apiKey: opts.apiKey,
    });
  }
  const analysis = await analyzeSheet(sheet, dir);
  const used = existsSync(poseInfo)
    ? (JSON.parse(await readFile(poseInfo, "utf8")) as { build: Build; hands?: Hands; prompt?: string; style?: string })
    : undefined;
  // The palette check needs the style the sheet was drawn with, not whichever is wired now.
  const fit = used?.style && used.style === opts.style?.runId ? await paletteFitCheck(sheet, opts.style) : undefined;
  return {
    kind: "turnaround",
    runId: opts.runId,
    concept: opts.concept,
    prompt: used?.prompt ?? turnaroundPrompt(opts.concept),
    model: TURNAROUND_MODEL,
    build: used?.build,
    hands: used?.hands,
    styleRun: used?.style,
    poseUrl: used ? runUrl(opts.runId, "pose.png") : undefined,
    sheetUrl: runUrl(opts.runId, "sheet.png"),
    previewUrl: runUrl(opts.runId, "sheet.png"),
    width: analysis.width,
    height: analysis.height,
    views: analysis.views,
    checks: fit ? [...analysis.checks, fit] : analysis.checks,
    createdAt: new Date().toISOString(),
    cost: { seconds: (Date.now() - t0) / 1000, kieCredits },
  };
}
