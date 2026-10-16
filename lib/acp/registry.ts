// Server-only. How to find, launch and isolate each ACP agent.

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AgentId } from "@/lib/agentModels";
import { findExecutable } from "./shellEnv";

export type Launch =
  | { ok: true; command: string; args: string[]; env?: Record<string, string> }
  | { ok: false; status: "not_installed" | "needs_login" | "error"; detail: string; setupHint?: string };

export interface AgentSpec {
  id: AgentId;
  name: string;
  via: string;
  /** Shown when the agent reports it is not signed in. */
  loginHint: string;
  resolveLaunch(env: NodeJS.ProcessEnv): Promise<Launch>;
  /**
   * `_meta` for `session/new`. When `systemPrompt` is given and the agent can
   * take it natively, it goes here and is NOT prepended to the first turn.
   */
  sessionMeta(systemPrompt: string | undefined): Record<string, unknown> | undefined;
  /** True when `sessionMeta` carries the system prompt itself. */
  nativeSystemPrompt: boolean;
}

/** Resolve installed packages from the app root — the Next server's cwd in dev
 *  (repo root) and in the standalone desktop sidecar (server.js chdirs there). */
const appRequire = createRequire(join(process.cwd(), "package.json"));

function packageDir(name: string, from: NodeRequire = appRequire): string | null {
  try {
    return dirname(from.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

const EXE = process.platform === "win32" ? ".exe" : "";

/** Prompt-writing assistant, not a coding agent: answer in text, never act. */
const NEUTRAL_SYSTEM_PROMPT =
  "You are a helpful writing assistant. Answer in plain text. You have no tools and cannot read or change files.";

const CLAUDE_INSTALL_HINT =
  "Install Claude Code (`npm i -g @anthropic-ai/claude-code`), then run `claude` once in Terminal to sign in.";

const claude: AgentSpec = {
  id: "claude",
  name: "Claude",
  via: "Claude Code subscription",
  loginHint: "Run `claude` once in Terminal to sign in.",
  async resolveLaunch(env) {
    // The agent itself is the user's own Claude Code install; we only ship
    // the small ACP adapter that talks to it.
    const cli = findExecutable("claude", env);
    if (!cli) {
      return {
        ok: false,
        status: "not_installed",
        detail: "Claude Code isn't installed on this computer.",
        setupHint: CLAUDE_INSTALL_HINT,
      };
    }
    const dir = packageDir("@agentclientprotocol/claude-agent-acp");
    const bin = dir && join(dir, "dist", "index.js");
    if (!bin || !existsSync(bin)) {
      return {
        ok: false,
        status: "error",
        detail: "The bundled Claude adapter is missing from this install.",
        setupHint: "Reinstall Buonarroti, then retry.",
      };
    }
    // Run the adapter with the very Node running this server (the bundled
    // runtime in the desktop app) — no npx, no reliance on the user's Node.
    return { ok: true, command: process.execPath, args: [bin], env: { CLAUDE_CODE_EXECUTABLE: cli } };
  },
  sessionMeta(systemPrompt) {
    return {
      // A plain string replaces Claude Code's coding-agent preset prompt.
      systemPrompt: systemPrompt?.trim() || NEUTRAL_SYSTEM_PROMPT,
      claudeCode: {
        options: {
          // No ~/.claude settings, CLAUDE.md, hooks, plugins or MCP servers.
          settingSources: [],
          strictMcpConfig: true,
          mcpServers: {},
          plugins: [],
          skills: [],
          agents: {},
          // No built-in tools at all; nothing is pre-approved.
          tools: [],
          allowedTools: [],
          // Don't add these chats to the user's `claude --resume` history.
          persistSession: false,
        },
      },
    };
  },
  nativeSystemPrompt: true,
};

const CODEX_INSTALL_HINT =
  "Install Codex and its ACP adapter (`npm i -g @openai/codex @zed-industries/codex-acp`), then run `codex login` in Terminal.";

const codex: AgentSpec = {
  id: "codex",
  name: "Codex",
  via: "ChatGPT / Codex",
  loginHint: "Run `codex login` in Terminal.",
  async resolveLaunch(env) {
    // codex-acp is Codex itself behind ACP; the user installs it.
    const native = findExecutable("codex-acp", env);
    if (!native) {
      return {
        ok: false,
        status: "not_installed",
        detail: "The Codex ACP adapter isn't installed on this computer.",
        setupHint: CODEX_INSTALL_HINT,
      };
    }
    const command = nativeCodexAcp(native) ?? native;
    return {
      ok: true,
      command,
      // `-c` overrides beat ~/.codex/config.toml: no MCP servers, no AGENTS.md,
      // no web search, read-only sandbox, and every action needs approval
      // (which this client always rejects).
      args: [
        "-c", 'sandbox_mode="read-only"',
        "-c", 'approval_policy="untrusted"',
        "-c", "mcp_servers={}",
        "-c", "project_doc_max_bytes=0",
        "-c", 'web_search="disabled"',
        "-c", "features.shell_tool=false",
      ],
    };
  },
  sessionMeta: () => undefined,
  nativeSystemPrompt: false,
};

/**
 * `npm i -g @zed-industries/codex-acp` puts a JS shim on PATH that spawns the
 * platform binary and doesn't forward kill signals. Find that binary next to
 * the shim so stopping a chat really stops Codex; null → use the shim.
 */
function nativeCodexAcp(shim: string): string | null {
  try {
    const pkgDir = dirname(dirname(realpathSync(shim))); // <pkg>/bin/codex-acp.js → <pkg>
    const platformDir = packageDir(
      `@zed-industries/codex-acp-${process.platform}-${process.arch}`,
      createRequire(join(pkgDir, "package.json")),
    );
    const bin = platformDir && join(platformDir, "bin", `codex-acp${EXE}`);
    return bin && existsSync(bin) ? bin : null;
  } catch {
    return null;
  }
}

/** `gemini --help` text, cached per binary path. */
const geminiHelp = new Map<string, Promise<string>>();

function readHelp(bin: string, env: NodeJS.ProcessEnv): Promise<string> {
  let cached = geminiHelp.get(bin);
  if (!cached) {
    const { promise, resolve } = Promise.withResolvers<string>();
    execFile(bin, ["--help"], { env, timeout: 10_000, encoding: "utf8" }, (_err, stdout, stderr) =>
      resolve(`${stdout ?? ""}\n${stderr ?? ""}`),
    );
    cached = promise;
    geminiHelp.set(bin, cached);
  }
  return cached;
}

const GEMINI_INSTALL_HINT =
  "Install Gemini CLI: `npm i -g @google/gemini-cli`, then run `gemini` once to sign in.";

const gemini: AgentSpec = {
  id: "gemini",
  name: "Gemini",
  via: "Gemini CLI",
  loginHint: "Run `gemini` once in Terminal to sign in.",
  async resolveLaunch(env) {
    const bin = findExecutable("gemini", env);
    if (!bin) {
      return {
        ok: false,
        status: "not_installed",
        detail: "Gemini CLI isn't installed.",
        setupHint: GEMINI_INSTALL_HINT,
      };
    }
    const help = await readHelp(bin, env);
    const acpFlag = /--acp\b/.test(help) ? "--acp" : /--experimental-acp\b/.test(help) ? "--experimental-acp" : null;
    if (!acpFlag) {
      return {
        ok: false,
        status: "not_installed",
        detail: "This Gemini CLI version can't talk to other apps yet.",
        setupHint: "Update Gemini CLI: `npm i -g @google/gemini-cli@latest`.",
      };
    }
    const args = [acpFlag];
    // Tools ask for approval (which this client always rejects); no MCP
    // servers or extensions from ~/.gemini.
    if (/--approval-mode\b/.test(help)) args.push("--approval-mode", "default");
    if (/--allowed-mcp-server-names\b/.test(help)) args.push("--allowed-mcp-server-names", "none");
    if (/--extensions\b/.test(help)) args.push("--extensions", "none");
    return { ok: true, command: bin, args };
  },
  sessionMeta: () => undefined,
  nativeSystemPrompt: false,
};

export const AGENT_SPECS: Record<AgentId, AgentSpec> = { claude, codex, gemini };
