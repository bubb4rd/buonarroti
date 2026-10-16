import { mkdir } from "fs/promises";
import { join } from "path";
import { randomUUID } from "crypto";
import { MEDIA_DIR } from "../guest/paths";

/** All files of one character live in MEDIA_DIR/game/<runId>/, served as /generated/game/<runId>/<file>. */
const RUN_ID_RE = /^[a-z0-9-]{8,64}$/;

export function newRunId(): string {
  return randomUUID();
}

export function runPath(runId: string, file = ""): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id: ${runId}`);
  if (file && !/^[\w.-]+$/.test(file)) throw new Error(`invalid run file: ${file}`);
  return join(MEDIA_DIR, "game", runId, file);
}

export async function runDir(runId: string): Promise<string> {
  const dir = runPath(runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

export function runUrl(runId: string, file: string): string {
  runPath(runId, file);
  return `/generated/game/${runId}/${file}`;
}

/** Inverse of `runUrl`: absolute path of a `/generated/game/<runId>/<file>` URL. */
export function pathForRunUrl(url: string): string {
  const m = url.match(/^\/generated\/game\/([a-z0-9-]+)\/([\w.-]+)$/);
  if (!m) throw new Error(`not a pipeline file URL: ${url}`);
  return runPath(m[1], m[2]);
}
