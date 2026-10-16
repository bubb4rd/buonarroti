/**
 * Local tools the character pipeline shells out to: Blender (bpy scripts in
 * scripts/game/bpy) and Godot (scripts/game/godot). Like ffmpeg elsewhere in
 * the app, they are found on the user's PATH; BLENDER_BIN / GODOT_BIN override,
 * and the standard macOS app locations are tried last.
 */
import { execFile, spawn } from "child_process";
import { existsSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";

const run = promisify(execFile);

const SCRIPTS = join(process.cwd(), "scripts", "game");

function locate(envVar: string, names: string[], appPaths: string[]): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  }
  for (const p of appPaths) if (existsSync(p)) return p;
  throw new Error(`${names[0]} not found: install it or set ${envVar}`);
}

export const blenderBin = () =>
  locate("BLENDER_BIN", ["blender"], ["/Applications/Blender.app/Contents/MacOS/Blender"]);

export const godotBin = () =>
  locate("GODOT_BIN", ["godot", "godot4"], ["/Applications/Godot.app/Contents/MacOS/Godot"]);

/**
 * Run scripts/game/bpy/<script>.py with `args` (+ a report path) and return the
 * parsed report. Blender's stdout (render/bake progress, megabytes per run) is
 * discarded rather than buffered in the server; tracebacks arrive on stderr,
 * of which only the tail is kept.
 */
export async function runBlender<T = Record<string, unknown>>(script: string, args: Record<string, unknown>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "bnr-bpy-"));
  try {
    const argsPath = join(dir, "args.json");
    const report = join(dir, "report.json");
    await writeFile(argsPath, JSON.stringify({ ...args, report }));
    const child = spawn(blenderBin(), [
      "-b", "--factory-startup", "--python-exit-code", "1",
      "-P", join(SCRIPTS, "bpy", `${script}.py`), "--", argsPath,
    ], { stdio: ["ignore", "ignore", "pipe"], timeout: 15 * 60_000 });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-16_384); });
    const { promise, resolve, reject } = Promise.withResolvers<number | null>();
    child.on("error", reject);
    child.on("close", resolve);
    const code = await promise;
    if (code !== 0) {
      const tail = stderr.split("\n").filter((l) => /Error|Traceback|line \d+/.test(l)).slice(-6).join("\n");
      throw new Error(`blender ${script}.py failed (exit ${code}): ${tail || "no output"}`);
    }
    return JSON.parse(await readFile(report, "utf8")) as T;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface GodotWalkResult {
  file: string;
  ok: boolean;
  problems: string[];
  animation?: string;
  loop?: boolean;
  length?: number;
  frames?: number;
  bones?: number;
  max_influences?: number;
  weight_sum_err?: number;
  max_stretch?: number;
  edges_over_2x?: number;
  seam_pairs?: number;
  /** Max distance between vertices that share a rest position, / height. */
  max_seam_gap?: number;
  min_y?: number;
}

/**
 * Import `glb` into a throwaway copy of scripts/game/godot and play it.
 * Returns the import log's warnings/errors and check_walk.gd's measurements.
 */
export async function godotCheck(glb: string, name: string): Promise<{ importLog: string[]; walk: GodotWalkResult | null }> {
  const proj = await mkdtemp(join(tmpdir(), "bnr-godot-"));
  try {
    for (const f of ["project.godot", "check_walk.gd", "preview.gd", "preview.tscn"]) {
      await writeFile(join(proj, f), await readFile(join(SCRIPTS, "godot", f)));
    }
    await run("mkdir", ["-p", join(proj, "characters")]);
    await writeFile(join(proj, "characters", `${name}.glb`), await readFile(glb));
    const bin = godotBin();
    const imp = await run(bin, ["--headless", "--import", "--path", proj], { maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 })
      .catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
    const importLog = `${imp.stdout}\n${imp.stderr}`.split("\n").filter((l) => /warn|error/i.test(l)).map((l) => l.trim());
    const walk = await run(bin, ["--headless", "--path", proj, "-s", "res://check_walk.gd"], { maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 })
      .catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
    const line = `${walk.stdout}`.split("\n").find((l) => l.startsWith("{"));
    return { importLog, walk: line ? (JSON.parse(line) as GodotWalkResult) : null };
  } finally {
    await rm(proj, { recursive: true, force: true });
  }
}
