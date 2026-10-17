/**
 * Shared by the pipeline CLIs: every run keeps its artifacts, by kind, in
 * <media>/game/<runId>/artifacts.json, so a later command (another step, or a
 * step in a different run that takes this run's artifact) picks them up.
 */
import { existsSync } from "fs";
import { readFile, writeFile } from "fs/promises";
import type { Artifact, ArtifactKind } from "../../lib/game/artifacts";
import { runPath } from "../../lib/game/runs";

export interface SavedRun {
  name?: string;
  concept?: string;
  artifacts: Partial<Record<ArtifactKind, Artifact>>;
}

export async function loadRun(runId: string): Promise<SavedRun> {
  const file = runPath(runId, "artifacts.json");
  return existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : { artifacts: {} };
}

export async function saveRun(runId: string, run: SavedRun): Promise<void> {
  await writeFile(runPath(runId, "artifacts.json"), JSON.stringify(run, null, 1));
}

/** One line of time / cost / verdict, then every failing check (all of them with VERBOSE=1). */
export function printArtifact(art: Artifact): void {
  const failed = art.checks.filter((c) => !c.pass && !c.advisory);
  const cost = art.cost.kieCredits !== undefined ? `, ${art.cost.kieCredits} kie credits` : "";
  console.log(`${art.cost.seconds.toFixed(1)}s${cost} — ${failed.length ? "REJECTED" : "ok"}`);
  for (const c of art.checks) {
    if (!c.pass || process.env.VERBOSE) {
      console.log(`    ${c.pass ? "pass" : c.advisory ? "warn" : "FAIL"} ${c.id} = ${JSON.stringify(c.value)} (limit ${JSON.stringify(c.limit)})${c.detail ? ` — ${c.detail}` : ""}`);
    }
  }
}
