/**
 * External acceptance checks for finished characters — nothing here reuses the
 * pipeline's own reports; every number is re-measured from the .glb files.
 *
 *   pnpm game:verify <a.glb> <b.glb> … [--movie out_dir]
 *
 * 1. Khronos glTF-Validator: 0 errors (warnings/infos/hints are listed).
 * 2. godot --headless --import of all files in one project: no WARNING/ERROR lines.
 * 3. check_character.gd: each character loads, every clip plays, and CPU skinning
 *    of every frame from Godot's imported Skin/Skeleton3D shows no tearing or cracks.
 * 4. Blender check_budgets.py: triangles, texture, materials, height, bones,
 *    influences, weights, A-pose, loop seam of every -loop clip against lib/game/artifacts.ts budgets.
 * --movie additionally renders preview.tscn with Godot's movie writer (PNG frames).
 */
import { execFile } from "child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";
import { promisify } from "util";
import { validateBytes } from "gltf-validator";
import { BPY_BUDGET } from "../../lib/game/artifacts";
import { blenderBin, godotBin, type GodotCharacterResult } from "../../lib/game/tools";

const run = promisify(execFile);
const here = resolve("scripts/game");
const argv = process.argv.slice(2);
const movieAt = argv.indexOf("--movie");
const movieDir = movieAt >= 0 ? resolve(argv.splice(movieAt, 2)[1]) : null;
const files = argv.map((f) => resolve(f));
let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  FAIL ${msg}`); };

console.log("== Khronos glTF-Validator");
for (const f of files) {
  const r = await validateBytes(new Uint8Array(await readFile(f)), { uri: basename(f), maxIssues: 0 });
  const i = r.issues;
  console.log(`  ${basename(f)}: ${i.numErrors} errors, ${i.numWarnings} warnings, ${i.numInfos} infos, ${i.numHints} hints (${r.validatorVersion})`);
  for (const m of i.messages) console.log(`    [${["ERROR", "WARNING", "INFO", "HINT"][m.severity]}] ${m.code} ${m.pointer ?? ""}`);
  if (i.numErrors) fail(`${basename(f)} has validator errors`);
}

const proj = await mkdtemp(join(tmpdir(), "bnr-verify-"));
try {
  for (const f of ["project.godot", "check_character.gd", "preview.gd", "preview.tscn"]) await copyFile(join(here, "godot", f), join(proj, f));
  await mkdir(join(proj, "characters"));
  for (const f of files) await copyFile(f, join(proj, "characters", basename(f)));
  const godot = godotBin();
  console.log(`== ${(await run(godot, ["--version"])).stdout.trim()} --headless --import`);
  const imp = await run(godot, ["--headless", "--import", "--path", proj], { maxBuffer: 1 << 26 })
    .catch((e) => { fail(`godot --import exited ${e.code}`); return e as { stdout: string; stderr: string }; });
  const noisy = `${imp.stdout}\n${imp.stderr}`.split("\n").filter((l) => /warn|error/i.test(l));
  console.log(`  ${files.length} files imported, ${noisy.length} warning/error lines`);
  for (const l of noisy) fail(l.trim());

  console.log("== check_character.gd (load, play every clip, CPU-skin every frame)");
  const play = await run(godot, ["--headless", "--path", proj, "-s", "res://check_character.gd"], { maxBuffer: 1 << 26 })
    .catch((e) => e as { stdout: string; stderr: string });
  const rows: GodotCharacterResult[] = `${play.stdout}`.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
  if (rows.length !== files.length) fail(`check_character.gd reported ${rows.length}/${files.length} characters`);
  for (const r of rows) {
    console.log(`  ${r.file}: ${r.clips.length} clips, ${r.bones} bones, ≤${r.max_influences} influences, ${r.seam_pairs} seam pairs`);
    for (const c of r.clips) {
      console.log(`    ${c.animation}: loop=${c.loop} ${c.frames} frames, max edge stretch ${c.max_stretch.toFixed(3)} (${c.edges_over_2x} edges >2x), ` +
        `max seam gap ${(100 * c.max_seam_gap).toFixed(3)}% of height, loop seam ${c.loop_seam_deg.toFixed(3)}°, min y ${c.min_y.toFixed(4)}`);
    }
    if (!r.clips.some((c) => c.loop)) fail(`${r.file}: no looping clip`);
    if (!r.ok) fail(`${r.file}: ${r.problems.join("; ")}`);
  }

  if (movieDir) {
    await mkdir(movieDir, { recursive: true });
    await run(godot, ["--path", proj, "--write-movie", join(movieDir, "frame.png"), "--fixed-fps", "30", "--quit-after", "45", "res://preview.tscn"], { maxBuffer: 1 << 26 })
      .catch((e) => fail(`movie render failed: ${(e as Error).message.split("\n")[0]}`));
    console.log(`  movie frames → ${movieDir}`);
  }

  console.log("== Blender check_budgets.py");
  for (const f of files) {
    const args = join(proj, `${basename(f)}.args.json`);
    const report = join(proj, `${basename(f)}.report.json`);
    await writeFile(args, JSON.stringify({ glb: f, report, budget: BPY_BUDGET }));
    await run(blenderBin(), ["-b", "--factory-startup", "--python-exit-code", "1", "-P", join(here, "bpy", "check_budgets.py"), "--", args], { maxBuffer: 1 << 26 });
    const { checks, measured } = JSON.parse(await readFile(report, "utf8"));
    const bad = checks.filter((c: { pass: boolean }) => !c.pass);
    console.log(`  ${basename(f)}: ${checks.length - bad.length}/${checks.length} budgets pass — ${JSON.stringify(measured)}`);
    for (const c of bad) fail(`${basename(f)} ${c.id} = ${JSON.stringify(c.value)} (limit ${JSON.stringify(c.limit)})`);
  }
} finally {
  await rm(proj, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failure(s)` : "\nall external checks pass");
process.exit(failures ? 1 : 0);
