<p align="center">
  <img src="src-tauri/icons/128x128.png" alt="" width="96" />
</p>

<h1 align="center">Buonarroti</h1>

<p align="center">
  A calm desktop studio for making images and film from your words.
</p>

---

Buonarroti is a desktop app for image and video generation. You describe what
you want, pick a model, and the result lands in your gallery. When one prompt
is not enough, you can lay the work out as a workflow on an open canvas and let
each step feed the next.

- **Workflows** — an infinite canvas of nodes: prompts, reference images,
  models and outputs, wired together and run in sequence or in parallel.
- **Assistant** — a chat partner that helps you shape and refine prompts
  before you spend credits on them. It can use the models from subscriptions
  you already have (Claude Code, Codex, Gemini CLI) as well as kie.ai models.
- **Gallery** — everything you make and upload, organised in folders and kept
  on your own disk.
- **Local by design** — no account and no cloud storage. Your work stays on
  your machine; generation runs through your own kie.ai key.

The name honours Michelangelo Buonarroti. The mark is his *tre cerchi*, three
interlaced rings.

## Download

Builds are published on the
[releases page](https://github.com/bubb4rd/buonarroti/releases).

| OS | File |
| --- | --- |
| macOS (Apple Silicon) | `Buonarroti_<version>_aarch64.dmg` |
| Windows | Not published yet — build from source |
| Linux | Not published yet — build from source |

Tauri does not cross-compile, so each platform has to be built on that
platform. If you can build for Windows or Linux, artifacts attached to an issue
or pull request are welcome.

The app is not code-signed yet:

- **macOS** — right-click the app and choose **Open** once, or run
  `xattr -cr /Applications/Buonarroti.app`.
- **Windows** — at the SmartScreen prompt, choose **More info → Run anyway**.

## First run

1. Open Buonarroti.
2. Go to **Settings → API Keys** and paste your
   [kie.ai](https://kie.ai?ref=25abb3f2236cbff9780ab9c2f84479ec) API key.
3. Write a prompt and generate.

Credits are bought on your own kie.ai account and do not expire. You pay only
for what you generate; there is no subscription.

### Where your data lives

Generations, uploads, folders, workflows and settings are kept in a local
SQLite database (`guest.db`); media is saved alongside it in `generated/`.

| OS | Data location |
| --- | --- |
| macOS | `~/Library/Application Support/app.buonarroti.desktop/` |
| Windows | `%APPDATA%\app.buonarroti.desktop\` |
| Linux | `~/.local/share/app.buonarroti.desktop/` |

Delete that folder to reset the app.

If you used HeliosGen before, its data (`cash.sdd.helios.desktop` in the same
parent folder) is copied into the Buonarroti folder automatically the first
time you open the app. The original folder is left as it was; remove it
yourself once you are happy everything came across.

## Models

### Images

- GPT Image 2 (OpenAI)
- Nano Banana / Nano Banana 2 / Nano Banana 2 Lite / Nano Banana Pro (Google)
- Seedream 5.0 Lite / Pro (Seedream)
- Z-Image (Z-AI)
- Grok Imagine (X)

### Video

- Veo 3.1 Lite / Fast / Quality, Gemini Omni Video (Google)
- Kling 3.0, Kling 3.0 Turbo, Motion Control 2.6 / 3.0 (Kling)
- Seedance 2.0 / Fast / Mini (Bytedance)
- Grok Imagine, Grok Imagine 1.5 preview (X)
- HappyHorse (Alibaba)

## Use your own subscriptions

The prompt assistant (chat, Quick Assist, the Assistant node) can run on the AI
subscriptions you already pay for, alongside the kie.ai / Azure models. Buonarroti
talks to each one through the [Agent Client Protocol](https://agentclientprotocol.com)
and lists whatever models your plan offers — nothing is hardcoded.

| Agent | How it signs in |
| --- | --- |
| **Claude** (Claude Code) | Install Claude Code (`npm i -g @anthropic-ai/claude-code`), then run `claude` once in Terminal and sign in (or set `ANTHROPIC_API_KEY`). |
| **Codex** (ChatGPT) | Install Codex and its ACP adapter (`npm i -g @openai/codex @zed-industries/codex-acp`), then run `codex login` (or set `OPENAI_API_KEY`). |
| **Gemini** (Gemini CLI) | Install it with `npm i -g @google/gemini-cli`, then run `gemini` once to sign in. |

Buonarroti doesn't bundle any of these: it finds them on your shell `PATH` and
uses whichever you have.

**Settings → Subscriptions** shows each one as ready, needing sign-in, or not
installed, with the exact command to fix it; **Check again** re-tests after you
sign in. Ready agents' models appear in the model picker.

These are coding agents, so Buonarroti locks them down: every tool, MCP server,
hook, plugin and your personal instructions (`CLAUDE.md`, `AGENTS.md`, settings)
are switched off, any permission request is refused, and each one runs in an
empty folder under your data directory. They only write text. Your messages go
from your computer straight to that provider — nothing passes through anyone
else.

## Codex CLI (optional)

Instead of spending kie.ai credits on GPT Image 2, Buonarroti can generate
through your own ChatGPT Codex subscription via
[`codex-imagegen-cli`](https://github.com/jdmnk/codex-imagegen-cli). The desktop
app finds `codex` on your `PATH` automatically. If it is missing, the option
shows **NOT CONFIGURED** and everything else keeps working.

You need:

- a ChatGPT Plus, Pro, Team or Enterprise account with Codex access
- the [`codex`](https://github.com/openai/codex) CLI
- [`uv`](https://docs.astral.sh/uv/) (Python package manager)

### 1. Install the Codex CLI

```bash
# macOS
brew install codex

# or, cross-platform
npm install -g @openai/codex
```

### 2. Install codex-imagegen-cli

```bash
git clone https://github.com/jdmnk/codex-imagegen-cli.git
cd codex-imagegen-cli
uv sync --dev
uv tool install -e .
```

This installs the `codex-imagegen` binary. Make sure it is on your `PATH`.

### 3. Sign in

Either run `codex login` in a terminal (it opens a browser), or open
**Settings → API Keys → Codex CLI → Connect Codex** in the app and follow the
device-code steps: visit the URL shown and enter the code.

Starting a new login, either way, immediately ends any existing Codex session
on that machine — the CLI clears old credentials as soon as a login begins,
whether or not it finishes. Only start one when the status shows
**NOT CONFIGURED**.

### 4. Use it for GPT Image 2

In **Settings → Image Models**, set GPT Image 2's provider to **Codex CLI**.
**Settings → API Keys** shows **READY** once the CLI and login are both in
place.

## Game characters (optional)

The **Game character** nodes on the canvas turn a text concept into a rigged,
walking character for Godot 4: **Turnaround sheet → Image to 3D mesh → Auto-rig →
Walk cycle → glTF export**. Each node produces a typed artifact
(`lib/game/artifacts.ts`) with measured checks; a node refuses an upstream
artifact that failed a check, so nothing is spent on a bad input.

| Step | Runs on | Cost |
| --- | --- | --- |
| Turnaround sheet | kie.ai `nano-banana-pro`, 2K, 3:2, drawn over a mannequin pose template | 18 credits |
| Image to 3D mesh | Hunyuan3D-2mv on Hugging Face ZeroGPU (shape), texture projected from the sheet in Blender | free, rate-limited quota |
| Auto-rig | Blender (geometric joint fit, bone heat weights) | local |
| Walk cycle | Blender, retargets the CMU mocap walk in `scripts/game/mocap` | local |
| glTF export | Khronos glTF-Validator, Godot headless import + playback (edge stretch and seam cracks, every frame), Blender budget check | local |

The pose comes from a picture, not from the prompt: the turnaround request
carries a mannequin turnaround (`scripts/game/bpy/pose_template.py`) in the
A-pose the rig needs, and your concept only describes the character. Pick the
mannequin's **Build** (Average, Stocky, Slender) on the Turnaround node; its
proportions carry into the drawing, so a dwarf wants Stocky. Builds are entries
in `scripts/game/poses/builds.json`. The sheet step measures the arm angle the
same way the rig does and rejects an off-pose sheet before any mesh is made.

A step interrupted by a restart picks up again on its own: a sheet still
rendering on kie.ai is polled, not paid for twice. In the gallery, a finished
character's **Download** saves its `.glb`.

Needs **Blender 4.2+** and **Godot 4.3+** on your `PATH` (or `BLENDER_BIN` /
`GODOT_BIN`). Anonymous ZeroGPU quota covers a few meshes a day; for more, add a
Hugging Face token in **Settings → API Keys** (or `HF_TOKEN`). The same steps run headless:

```bash
pnpm game:character --name dwarf --build stocky --concept "a stocky dwarf blacksmith…"
pnpm game:verify path/to/dwarf.glb path/to/knight.glb --movie /tmp/frames
```

The walk clip is from the CMU Graphics Lab Motion Capture Database
(mocap.cs.cmu.edu, subject 02 trial 01), which is free to use.

## Tech stack

| Layer | Technology |
| --- | --- |
| Desktop shell | Tauri 2 (Rust) |
| App | Next.js, React, TypeScript (bundled Node sidecar) |
| Database | SQLite via `node:sqlite` (local) |
| Storage | Local disk |
| Generation | kie.ai (optionally Codex CLI for GPT Image 2) |

## Build from source

Build on the operating system you want to target.

### Prerequisites

| Tool | Notes |
| --- | --- |
| Node 22+ | The bundled server uses `node:sqlite`. `nvm use 22 && corepack enable`. |
| pnpm | Pinned in `package.json` (`packageManager`); Corepack provides it. |
| Rust | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Tauri system deps | See <https://v2.tauri.app/start/prerequisites/> |

Platform notes:

- **macOS** — Xcode Command Line Tools: `xcode-select --install`.
- **Windows** — [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
  (Desktop development with C++) and
  [WebView2](https://developer.microsoft.com/microsoft-edge/webview2/)
  (preinstalled on Windows 11).
- **Linux** — `webkit2gtk-4.1`, `librsvg2`, `build-essential`, `curl`, `wget`,
  `file`, `libssl-dev`, `libayatana-appindicator3-dev` (Debian/Ubuntu names;
  see the Tauri prerequisites page for other distributions).

### Build

```bash
git clone https://github.com/bubb4rd/buonarroti
cd buonarroti
pnpm install
pnpm desktop:build
```

Artifacts are written to `src-tauri/target/release/bundle/`:

| OS | Output |
| --- | --- |
| macOS | `macos/Buonarroti.app`, `dmg/Buonarroti_<ver>_<arch>.dmg` |
| Windows | `msi/Buonarroti_<ver>_x64_en-US.msi`, `nsis/Buonarroti_<ver>_x64-setup.exe` |
| Linux | `deb/`, `rpm/`, `appimage/Buonarroti_<ver>_amd64.AppImage` |

Unsigned macOS builds are blocked by Gatekeeper on first launch: right-click and
choose **Open**, or run
`xattr -cr "src-tauri/target/release/bundle/macos/Buonarroti.app"`.

## Develop

```bash
pnpm desktop:dev
```

This runs `next dev` and `tauri dev` together, with hot reload. The first run
compiles the Rust shell, which takes a minute or two. To work on the web UI
alone, `pnpm dev` serves it at <http://localhost:3000>.

[`DESKTOP.md`](DESKTOP.md) covers the architecture, data locations, the
HeliosGen data migration, and signing and notarization.

## Contributing

Issues and pull requests are welcome at
[bubb4rd/buonarroti](https://github.com/bubb4rd/buonarroti).

## Credits and license

Buonarroti is a fork of [HeliosGen](https://github.com/SegFault42/HeliosGen) by
SegFault42, and builds on its generation pipeline, workflow canvas and desktop
shell. Thank you to its author and contributors.

HeliosGen's README declares the MIT License, but neither the upstream repository
nor this one currently ships a `LICENSE` file. This fork is offered under the
same MIT terms, with attribution to the HeliosGen authors retained.
