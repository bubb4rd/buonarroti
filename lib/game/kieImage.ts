/**
 * One picture from a kie.ai image model, for the pipeline steps that ask for
 * one (turnaround sheet, and every other step drawn over a layout template).
 *
 * The kie task id is kept next to the output file until the picture lands, so
 * a step resumed after a restart polls the task it already paid for instead of
 * submitting a second one.
 */
import { existsSync } from "fs";
import { readFile, rm, writeFile } from "fs/promises";
import { setTimeout as sleep } from "timers/promises";
import { KIE_BASE, createKieTask, fetchKieRecord } from "../kieApi";
import { ensureKieReachable } from "../kieUpload";

const POLL_MS = 3_000;
const TIMEOUT_MS = 10 * 60_000;

export interface KieImageRequest {
  model: string;
  prompt: string;
  /** Local PNG/JPEG files sent as image_input, in order (layout template first, then style references). */
  images: string[];
  aspectRatio: string;
  resolution: "1K" | "2K" | "4K";
  outFile: string;
  apiKey: string;
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
 * Submit (or resume), poll and download. Returns the credits spent: the balance
 * delta around a new submission (exact unless other kie jobs run concurrently),
 * undefined when an earlier attempt submitted the task.
 */
export async function generateKieImage(req: KieImageRequest): Promise<number | undefined> {
  const taskFile = `${req.outFile}.task`;
  const pending = existsSync(taskFile) ? (await readFile(taskFile, "utf8")).trim() : "";
  let taskId = pending;
  const before = pending ? undefined : await kieBalance(req.apiKey);
  if (!taskId) {
    const imageInput: string[] = [];
    for (const file of req.images) {
      const mime = file.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      imageInput.push(await ensureKieReachable(`data:${mime};base64,${(await readFile(file)).toString("base64")}`, req.apiKey));
    }
    taskId = await createKieTask(`${KIE_BASE}/api/v1/jobs/createTask`, req.apiKey, {
      model: req.model,
      input: { prompt: req.prompt, image_input: imageInput, aspect_ratio: req.aspectRatio, resolution: req.resolution, output_format: "png" },
    });
    await writeFile(taskFile, taskId);
  }
  const deadline = Date.now() + TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const rec = await fetchKieRecord(taskId, req.apiKey, "jobs");
      if (rec.state === "done") {
        const res = await fetch(rec.urls[0], { signal: AbortSignal.timeout(120_000) });
        if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
        await writeFile(req.outFile, Buffer.from(await res.arrayBuffer()));
        const after = before === undefined ? undefined : await kieBalance(req.apiKey);
        return before !== undefined && after !== undefined ? +(before - after).toFixed(2) : undefined;
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
