// Server-only. GUI-launched macOS apps (the Tauri desktop build) inherit a
// minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so user-installed CLIs like
// `gemini`, `codex`, `node` (nvm/Homebrew) are invisible. Resolve the user's
// login-shell environment once per process and use it for every agent spawn.

import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, join } from "node:path";

const SHELL_TIMEOUT_MS = 3000;
const BEGIN = "__BUONARROTI_ENV_BEGIN__";
const END = "__BUONARROTI_ENV_END__";

/** Credentials/config the agents read from the environment. Only these (plus PATH)
 *  are lifted from the login shell; anything already set on this process wins. */
const PASSTHROUGH_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_GENAI_USE_VERTEXAI",
] as const;

/** Where CLIs usually live when the login shell can't be read. */
function fallbackPathDirs(): string[] {
  const home = homedir();
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    join(home, "Library", "pnpm"),
  ];
  try {
    const nvm = join(home, ".nvm", "versions", "node");
    const versions = readdirSync(nvm).sort((a, b) =>
      b.localeCompare(a, undefined, { numeric: true }),
    );
    for (const v of versions) dirs.push(join(nvm, v, "bin"));
  } catch {
    // no nvm
  }
  return dirs;
}

function readLoginShellEnv(): Promise<Record<string, string>> {
  if (process.platform === "win32") return Promise.resolve({});
  // Finder-launched apps don't always get $SHELL; the passwd entry is authoritative.
  let shell = process.env.SHELL;
  try {
    shell ||= userInfo().shell ?? undefined;
  } catch {
    // no passwd entry
  }
  shell ||= process.platform === "darwin" ? "/bin/zsh" : "/bin/sh";
  const { promise, resolve } = Promise.withResolvers<Record<string, string>>();
  execFile(
    shell,
    ["-ilc", `printf '%s\\n' '${BEGIN}'; /usr/bin/env; printf '%s\\n' '${END}'`],
    { timeout: SHELL_TIMEOUT_MS, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    (_err, stdout) => {
      // A non-zero exit (noisy rc files) still yields usable output between the markers.
      const start = stdout?.indexOf(BEGIN) ?? -1;
      const end = stdout?.indexOf(END, start) ?? -1;
      if (start < 0 || end < 0) return resolve({});
      const out: Record<string, string> = {};
      for (const line of stdout.slice(start + BEGIN.length, end).split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
      }
      resolve(out);
    },
  );
  return promise;
}

async function buildShellEnv(): Promise<NodeJS.ProcessEnv> {
  const shellEnv = await readLoginShellEnv();
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of PASSTHROUGH_KEYS) {
    if (!env[key] && shellEnv[key]) env[key] = shellEnv[key];
  }
  const seen = new Set<string>();
  const path: string[] = [];
  for (const dir of [
    ...(shellEnv.PATH ?? "").split(delimiter),
    ...(process.env.PATH ?? "").split(delimiter),
    ...fallbackPathDirs(),
  ]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      path.push(dir);
    }
  }
  env.PATH = path.join(delimiter);
  return env;
}

const globalForShellEnv = globalThis as typeof globalThis & {
  __buonarrotiShellEnv?: Promise<NodeJS.ProcessEnv>;
};

/**
 * The environment to spawn user CLIs with: this process's env, the login
 * shell's PATH (plus common install dirs) and agent credentials from the shell.
 * Resolved once per process. Other spawners of user-installed CLIs (e.g. the
 * `codex` image generator) can use it too.
 */
export function getShellEnv(): Promise<NodeJS.ProcessEnv> {
  globalForShellEnv.__buonarrotiShellEnv ??= buildShellEnv();
  return globalForShellEnv.__buonarrotiShellEnv;
}

/** Absolute path of `name` on `env.PATH`, or null. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv): string | null {
  const exts = process.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}
