/**
 * Local tools the character pipeline shells out to: Blender (bpy scripts in
 * scripts/game/bpy), Godot (scripts/game/godot) and, when installed, Unreal
 * (scripts/game/unreal). Like ffmpeg elsewhere in the app, they are found on the
 * user's PATH; BLENDER_BIN / GODOT_BIN / UNREAL_EDITOR_CMD override, and the
 * standard macOS install locations are tried last.
 */
import { execFile, spawn } from "child_process";
import { existsSync, readdirSync } from "fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join } from "path";
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

/** Homebrew's prefixes are listed because the desktop app's server doesn't inherit a shell PATH. */
export const tesseractBin = () =>
  locate("TESSERACT_BIN", ["tesseract"], ["/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract"]);

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

/** One clip as check_character.gd played it. */
export interface GodotClipResult {
  animation: string;
  loop: boolean;
  length: number;
  frames: number;
  max_stretch: number;
  edges_over_2x: number;
  /** Max distance between vertices that share a rest position, / height. */
  max_seam_gap: number;
  min_y: number;
  /** First vs last key over the imported rotation tracks, degrees / position tracks, meters. */
  loop_seam_deg: number;
  loop_seam_m: number;
}

export interface GodotCharacterResult {
  file: string;
  ok: boolean;
  problems: string[];
  bones?: number;
  max_influences?: number;
  weight_sum_err?: number;
  seam_pairs?: number;
  clips: GodotClipResult[];
}

/**
 * Import `glb` into a throwaway copy of scripts/game/godot and play every clip.
 * Returns the import log's warnings/errors and check_character.gd's measurements.
 */
export async function godotCheck(glb: string, name: string): Promise<{ importLog: string[]; character: GodotCharacterResult | null }> {
  const proj = await mkdtemp(join(tmpdir(), "bnr-godot-"));
  try {
    for (const f of ["project.godot", "check_character.gd", "preview.gd", "preview.tscn"]) {
      await writeFile(join(proj, f), await readFile(join(SCRIPTS, "godot", f)));
    }
    await run("mkdir", ["-p", join(proj, "characters")]);
    await writeFile(join(proj, "characters", `${name}.glb`), await readFile(glb));
    const bin = godotBin();
    const imp = await run(bin, ["--headless", "--import", "--path", proj], { maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 })
      .catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
    const importLog = `${imp.stdout}\n${imp.stderr}`.split("\n").filter((l) => /warn|error/i.test(l)).map((l) => l.trim());
    const play = await run(bin, ["--headless", "--path", proj, "-s", "res://check_character.gd"], { maxBuffer: 16 * 1024 * 1024, timeout: 5 * 60_000 })
      .catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
    const line = `${play.stdout}`.split("\n").find((l) => l.startsWith("{"));
    return { importLog, character: line ? (JSON.parse(line) as GodotCharacterResult) : null };
  } finally {
    await rm(proj, { recursive: true, force: true });
  }
}

// ── Unreal ───────────────────────────────────────────────────────────────────

/** UnrealEditor-Cmd: UNREAL_EDITOR_CMD, else the newest Epic Games Launcher install. Null when absent (the check is skipped, not failed). */
export function unrealEditorCmd(): string | null {
  if (process.env.UNREAL_EDITOR_CMD) return process.env.UNREAL_EDITOR_CMD;
  const root = "/Users/Shared/Epic Games";
  if (!existsSync(root)) return null;
  const engines = readdirSync(root).filter((d) => /^UE_5\.\d+$/.test(d))
    .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));
  for (const e of engines.reverse()) {
    const bin = join(root, e, "Engine", "Binaries", "Mac", "UnrealEditor-Cmd");
    if (existsSync(bin)) return bin;
  }
  return null;
}

/**
 * A scratch project holding a copy of the engine's own UE5 mannequin content
 * (SK_Mannequin, SKM_Manny_Simple and its animations, from the Third Person
 * template resources), made once per engine under `cacheDir`.
 */
async function unrealHarness(editorCmd: string, cacheDir: string): Promise<string> {
  const engine = join(editorCmd, "..", "..", "..", "..");
  const dir = join(cacheDir, basename(engine));
  const project = join(dir, "Harness.uproject");
  if (existsSync(project)) return project;
  await mkdir(join(dir, "Content", "Characters"), { recursive: true });
  await cp(join(engine, "Templates", "TemplateResources", "High", "Characters", "Content", "Mannequins"),
    join(dir, "Content", "Characters", "Mannequins"), { recursive: true });
  await writeFile(project, JSON.stringify({
    FileVersion: 3,
    Plugins: [{ Name: "PythonScriptPlugin", Enabled: true }, { Name: "EditorScriptingUtilities", Enabled: true }, { Name: "Interchange", Enabled: true }],
  }, null, 1));
  return project;
}

/**
 * Run scripts/game/unreal/<script>.py inside a headless Unreal editor
 * (-run=pythonscript) with `args` (+ a report path, via BNR_ARGS) and return
 * the parsed report plus the import warnings/errors Unreal logged.
 */
export async function runUnrealScript<T = Record<string, unknown>>(script: string, args: Record<string, unknown>, cacheDir: string): Promise<{ report: T; log: string[]; engine: string }> {
  const editorCmd = unrealEditorCmd();
  if (!editorCmd) throw new Error("Unreal Engine not found: install it or set UNREAL_EDITOR_CMD");
  const project = await unrealHarness(editorCmd, cacheDir);
  const dir = await mkdtemp(join(tmpdir(), "bnr-ue-"));
  try {
    const argsPath = join(dir, "args.json");
    const report = join(dir, "report.json");
    await writeFile(argsPath, JSON.stringify({ ...args, report }));
    const out = await run(editorCmd, [
      project, "-run=pythonscript", `-script=${join(SCRIPTS, "unreal", `${script}.py`)}`,
      "-unattended", "-nop4", "-nosplash", "-nullrhi", "-stdout", "-FullStdOutLogOutput",
    ], { env: { ...process.env, BNR_ARGS: argsPath }, maxBuffer: 256 * 1024 * 1024, timeout: 15 * 60_000 })
      .catch((e: { stdout?: string; stderr?: string; message: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? e.message }));
    if (!existsSync(report)) {
      const tail = `${out.stdout}\n${out.stderr}`.split("\n").filter((l) => /Error/.test(l)).slice(-6).join("\n");
      throw new Error(`unreal ${script}.py wrote no report: ${tail || "no output"}`);
    }
    // Interchange's own messages ("LogInterchange…: Warning: [file : node, kind] …"), once each.
    const log = [...new Set(`${out.stdout}`.split("\n")
      .filter((l) => /LogInterchange\w*: (Warning|Error): \[/.test(l) && !l.includes("LogInit"))
      // File names only: the run folder's absolute path adds nothing to the message.
      .map((l) => l.replace(/^\[[^\]]*\]\[[^\]]*\]/, "").replace(/\[[^\]]*\/([^/\]]+) :/, "[$1 :").trim()))];
    return { report: JSON.parse(await readFile(report, "utf8")) as T, log, engine: basename(join(editorCmd, "..", "..", "..", "..")) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
