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
  before you spend credits on them, or, with **Explore** on, helps you work
  out what you want in the first place. It can use the models from
  subscriptions you already have (Claude Code, Codex, Gemini CLI) as well as
  kie.ai models.
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

## The assistant

By default the assistant answers with a finished prompt. Turn on **Explore**
(the compass next to the model picker, in Chat or the ⌘K panel) when you don't
know yet what you want: it asks a few questions, offers directions you can pick
with one click, keeps a short brief of what's decided, and writes prompts as
cards with their own **Use as prompt**.

You can open the assistant on what you're already looking at, without copying
anything across:

- **The composer's draft** — the speech-bubble button by Generate, or ⇧⌘K. Its
  prompt, model, aspect ratio and reference images come along.
- **A picture you made** — **Ask the assistant** on a card, or **A** in the
  lightbox. It sees the result and the references it was made with, names what
  went wrong against the prompt, and asks what bothers you. **Use as prompt**
  then puts the new prompt back in the composer with that picture's model,
  settings and references, like **Reuse**.

The chat shows what it was opened on at the top; remove it there to carry on
without it. A message carries up to four images, so the rest of a long
reference list is mentioned but not sent. The assistant has no web access: it
researches with you, not online.

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

## Game assets (optional)

The **Game** nodes on the canvas make 3D game assets for Godot 4 and Unreal 5.
Each node produces a typed artifact (`lib/game/artifacts.ts`) with measured
checks, and a node refuses an upstream artifact that failed a check, so nothing
is spent on a bad input. Every asset follows the same rule: the image model
draws over a layout template picture (pose, framing, scale), budgets are fixed
before any run, and an outside program (Godot, glTF-Validator, Blender) loads
the result.

### Style guide

Wire one or more reference images (and optionally a Text node with notes) into
a **Style guide** node. Its palette is measured from the references (k-means in
CIELAB). Wire the style guide into any node that draws a picture: the
references are sent after the layout template, with an instruction to take
only their rendering and colour, never their subjects. Each picture drawn
with a style is checked for palette fit: the share of pixels within CIEDE2000
15 of a palette colour. On one test the unstyled sheet scored 0.18 against a
painterly style and the styled sheet 0.55. The check only warns until it is
calibrated against people's "same game" verdicts, because the concept's own
colours (a green tunic) legitimately fall outside a palette.

### Characters

The **Game character** nodes turn a text concept into a rigged, animated
character: **Turnaround sheet → Image to 3D mesh → Auto-rig → Animation set →
glTF export**.

| Step | Runs on | Cost |
| --- | --- | --- |
| Turnaround sheet | kie.ai `nano-banana-pro`, 2K, 3:2, drawn over a mannequin pose template | 18 credits |
| Image to 3D mesh | Hunyuan3D-2mv on Hugging Face ZeroGPU (shape), texture projected from the sheet in Blender after warping each view onto the mesh's outline | free, rate-limited quota |
| Auto-rig | Blender (geometric joint fit, bone heat weights) | local |
| Animation set | Blender, retargets four CMU mocap trials in `scripts/game/mocap` onto the rig: idle, walk and run as in-place loops, jump as a one-shot. Checks per clip: loop seam, edge stretch, ground contact; idle and jump feet planted; jump leaves the ground, lands, and doesn't drift | local |
| glTF export | Khronos glTF-Validator, Godot headless import + playback of every clip (loop flag, loop seam, edge stretch and seam cracks, every frame), Blender budget check | local |
| Unreal export | Blender: the rig rebuilt on the UE5 mannequin's bone names, parent chain and bone orientations (`scripts/game/unreal/manny.json`, `manny_ref.json`), in centimeters; a mesh FBX with no animation plus one FBX per clip, each read back. Then, when Unreal is installed, UnrealEditor-Cmd imports them headless: bind pose vs our rest pose, texture, every clip as the engine poses it (edge stretch), and the mesh imported onto Manny's own `SK_Mannequin` with four of Manny's clips measured on it (advisory) | local |

The animation set feeds either export node, or both. Godot imports `idle`,
`walk` and `run` looping and `jump` once. From the terminal:
`pnpm game:character --run <runId> --from unreal --export unreal`.

The Unreal node downloads `<name>_unreal.zip`: `<name>.fbx` (skeletal mesh),
`<name>_albedo.png`, and `<name>_idle.fbx`, `_walk`, `_run`, `_jump`. In
Unreal, import `<name>.fbx` (keep the PNG next to it so its material finds the
texture), then each clip FBX with **Skeleton** set to the mesh's skeleton and
*Import Only Animations*. To use the Third Person template's animations
instead, pick `SK_Mannequin` as the skeleton when importing the mesh: the bones
are a subset of it (no fingers, twist or IK bones) with Manny's orientations,
so his clips play on the character with its own proportions. Without foot IK
the feet can dip a few centimeters under the floor (the node's checks report
how far). Unreal logs "Imported skeleton has some invalid bind poses … rebind
using the time zero pose" for every Blender FBX; the mesh file has no
animation, so time zero is the rest pose, and `unreal.bind_pose` checks it.
The engine is found at `UNREAL_EDITOR_CMD` or the newest
`/Users/Shared/Epic Games/UE_5.*`; the check project (a copy of the engine's
mannequin content) is made once under `data/unreal/`.

The pose comes from a picture, not from the prompt: the turnaround request
carries a mannequin turnaround (`scripts/game/bpy/pose_template.py`) in the
A-pose the rig needs, and your concept only describes the character. Pick the
mannequin's **Build** (Average, Stocky, Slender) on the Turnaround node; its
proportions carry into the drawing, so a dwarf wants Stocky. Builds are entries
in `scripts/game/poses/builds.json`. The sheet step measures the arm angle the
same way the rig does and rejects an off-pose sheet before any mesh is made.
The mannequin's hands are closed fists, so every character has the same grip
for holding an item. The rig places the wrist by the hand shape the sheet
was drawn with: characters made before fists keep open hands.

A step interrupted by a restart picks up again on its own: a sheet still
rendering on kie.ai is polled, not paid for twice. In the gallery, a finished
character's **Download** saves its `.glb`.

Needs **Blender 4.2+**, **Godot 4.3+** and **Tesseract 5** (`brew install
tesseract`, for the world map's text check) on your `PATH` (or `BLENDER_BIN` /
`GODOT_BIN` / `TESSERACT_BIN`). Anonymous ZeroGPU quota covers a few meshes a day; for more, add a
Hugging Face token in **Settings → API Keys** (or `HF_TOKEN`). The same steps run headless:

```bash
pnpm game:character --name dwarf --build stocky --concept "a stocky dwarf blacksmith…"
pnpm game:character --name dwarf --concept "…" --style <styleRunId>
pnpm game:verify path/to/dwarf.glb path/to/knight.glb --movie /tmp/frames
```

Any single step runs headless with `pnpm game:step`. The step's first input
comes from `--run`'s saved artifacts; any other input comes from another run
via `--input`:

```bash
pnpm game:step --step style --images ref1.png,ref2.jpg --text "flat cel shading, thick outlines"
pnpm game:step --step turnaround --text "a dwarf smith" --input style=<styleRunId>
pnpm game:step --step mesh --run <runId>
```

The clips are from the CMU Graphics Lab Motion Capture Database
(mocap.cs.cmu.edu), BVH conversions by Bruce Hahne (cgspeed), which is free to
use: idle subject 140 trial 06, walk subject 02 trial 01, run subject 02 trial
03, jump subject 16 trial 01.

### Surfaces

The **Seamless material** node (Game surfaces) turns a text like "mossy
cobblestone path" into a tiling PBR material for ground and walls: albedo,
normal and roughness PNGs and a Godot `StandardMaterial3D` (`.tres`) that uses
them, downloaded as one `.zip` with Godot import presets for each PNG
(mipmaps, VRAM compression, the normal map flagged as one). Unzip it anywhere
in a Godot project; the `.tres` refers to the PNGs by relative path. In Unreal,
import the PNGs and tick **Flip Green Channel** on the normal map (it is
OpenGL-style, +Y up).

| Step | Runs on | Cost |
| --- | --- | --- |
| Picture | kie.ai `nano-banana-2`, 1K, 1:1, drawn over a template: a flat grey 2.4 m patch seen straight down with 20 cm scale marks on its edges | 8 credits (2K: 12) |
| Tiling and maps | Node (`lib/game/surface.ts`): baked light removed by dividing out a luminance plane fit; the wrap seam repaired by joining a 1/6 overlap strip to the opposite edge, detail along a minimum-error cut and tone cross-faded over the strip, x then y; resampled to 1024 px with wrap-around; normal and roughness from high-passed luminance | local |
| Godot check | Godot imports the PNGs with the shipped presets (headless), loads the `.tres` on an 8 × 8 m plane and renders straight down from 1.5, 3.5 and 7 m (`scripts/game/godot/render_surface.gd`; opens a window briefly, the headless driver can't render) | local |

One repeat covers 2 m (512 px/m at 1024 px): the material maps world-triplanar
with `uv1_scale` 0.5, so the texel density holds on any mesh, whatever its UVs.
Checks (`SURFACE_BUDGET`): the step across the wrap edges and across the repair
cuts against the step between any two pixels the same distance apart in the same direction, the
lighting gradient in the picture as drawn, power-of-two size, every texture
imported mipmapped and compressed with the normal map as one, and a seam
detector on the Godot renders that compares the screen lines where tiles meet
with lines at arbitrary offsets. Repetition (autocorrelation of the tiling and
of the picture) and palette fit only warn. The node previews the 7 m render.

```bash
pnpm game:step --step surface --text "mossy cobblestone path"
pnpm game:step --step surface --text "weathered wooden floor planks" --input style=<styleRunId>
```

### Props

The **Game props** nodes make items and weapons: a prop sheet, a game-ready
prop mesh, an inventory icon, and an Equip node that puts a handheld prop in a
rigged character's right fist.

| Node | Runs on | Cost |
| --- | --- | --- |
| Prop sheet | kie.ai `nano-banana-2`, 1K, 3:2, drawn over a template (metre ruler; handheld: a fist-sized grip box) | 8 credits |
| Prop mesh | Hunyuan3D-2mv (HF ZeroGPU, same call as the character mesh), Blender, glTF-Validator, Godot | free (ZeroGPU quota) |
| Inventory icon | Blender, fixed orthographic 3/4 camera | free |
| Equip | Blender, glTF-Validator, Godot (walk played frame by frame) | free |

**Prop sheet.** Wire a Text node with the item and pick *Handheld* (held in a
fist: sword, axe, mace, torch) or *Pickup* (resting on the ground: potion,
chest, pouch). The sheet is split by the template's three columns; the checks
are view heights and lower ends, mirrored back vs front, flat lighting (blocking
only for mirror-symmetric items) and, handheld, that the handle crosses the grip
box in every view.

**Prop mesh.** Scale: pickups keep the ruler's scale; handheld items are scaled
so the handle inside the grip box is 4 cm thick, because the image model drew
handheld items about as long as the ruler whatever they were. Pivot: handheld at
the grip centre, handle along +Y (business end up), the drawn front towards +Z,
its width along X; pickup at the centre of its base, lowest point at y = 0. The
albedo is baked at the reference character's texel density (413 px/m, the
forest ranger) in a 512 or 1024 texture. A convex hull of at most 64 points is
exported as `PropCollision-convcolonly`; Godot imports it as a StaticBody3D with
a ConvexPolygonShape3D, and `check_prop.gd` verifies the shape exists and holds
every visual vertex.

**Inventory icon.** 512 × 512 and 64 × 64 PNG, transparent. The camera direction
is fixed per category (45° round, 30° up; handheld also rolled 45°); only the
framing adapts, and fill (55–85 %) and centring are checked on the picture.
Edge contrast against a dark and a light slot at 64 px is reported only.

**Equip.** Wire a handheld Prop mesh and a character's Auto-rig node (another
run). Pickups are refused. The grip centre is the centroid of the fist (vertices
weighted ≥ 0.5 to `RightHand`); the handle runs forward through the fist, the
item's width along the hand bone. The prop is parented to `RightHand` (Godot: a
BoneAttachment3D). `check_equip.gd` plays the walk and fails the item if it does
not follow the hand or comes within 1 cm of the body, except the grip region
(body within 6 cm of it in the rest pose). Unreal is not built: it would need a
`hand_r` socket on SK_Mannequin with this grip frame re-expressed in hand_r's
axes, and a `UCX_` collision mesh instead of `-convcolonly`.

```bash
pnpm game:step --step propsheet --category handheld --text "a woodcutter's hand axe"
pnpm game:step --step prop --run <propRunId>
pnpm game:step --step icon --run <propRunId>
pnpm game:step --step equip --run <propRunId> --input skeleton=<characterRunId>
```

### Maps and skies

The **Game maps** nodes make pictures, not levels: a world or region map for a
game's map screen, and a sky panorama. Both download as PNG.

| Node | Runs on | Cost |
| --- | --- | --- |
| World map | kie.ai `nano-banana-2`, 1K, 16:9, drawn over a land/water guide; Tesseract OCR on the result | 8 credits |
| Skybox | kie.ai `nano-banana-2`, 2K, 21:9, drawn over an equirectangular guide and resampled to 2048 × 1024; Godot renders it | 12 credits |

**World map.** Wire a Text node with the world, and optionally a layout sketch
(an image node): land as filled shapes or closed outlines on plain paper. The
sketch is read as land and water (two colour clusters: the bluer one is water,
else the lighter; thin dark lines are coastlines and the sea is flooded in
from the frame). Without a sketch, the node's **Seed** generates the
coastlines (seeded value noise, sea toward the frame), so a rerun repeats them.
The model gets the mask as a flat tan/blue guide and is told to follow its
coastlines and to draw **no text**: image models garble words, and baked
labels can't be translated or moved, so place names belong in the engine.
Checks (`WORLDMAP_BUDGET`): 16:9 aspect; coastline agreement, the land IoU
between the mask and the picture segmented by colour (8 k-means clusters in
CIELAB, each labelled land or water by where most of its pixels fall on the
mask; `map-segmentation.png` shows the disagreement in red), at least 0.75;
and no text: Tesseract (sparse-text mode) finds no word of 3+ letters at
confidence 60+ and at least 1% of the picture's height. Map text has any colour
over busy ground, which plain Tesseract misses, so the picture is binarised at
six brightness cuts in both polarities and a word counts when the same box is
read under at least two of them (letters are flat colour and survive several
cuts; brush texture read as letters doesn't). Without Tesseract the text check
fails and says so.

**Skybox.** nano-banana has no 2:1 aspect, so the guide is the full sphere
squeezed to 21:9 (horizon at half height, 30° graticule, flat pole caps above
75°) and the picture is resampled back to 2:1. A visible wrap seam is repaired
by blending each row's colour offset across the edges (smoothed over 9 rows,
so a cut-off cloud or ridge isn't smeared into streaks and still fails).
Checks (`SKYBOX_BUDGET`): 2:1 power-of-two size; the luminance step across the
wrap against the step between any two neighbouring columns (1.5); the rows
nearest the zenith must be even (they collapse onto one point). Warnings only,
until calibrated: the nadir, the horizon height, guide lines copied into the
picture (a thin full-width line at the guide's horizon, cap or latitude rows),
and the same scenery drawn twice around the circle (row autocorrelation). On
the first runs the model often drew the guide's horizon line and repeated its
skyline at half a turn, so look at the renders. Godot then loads the PNG into a
`PanoramaSkyMaterial` on a `WorldEnvironment` and renders north, east, south,
west and up (`scripts/game/godot/check_sky.gd`, `sky-view-*.png`; it opens a
small window for a second because the headless driver can't render). The view
that straddles the texture's wrap is found with a test ramp, and the seam is
measured again on it as a player would see it (1.3). In Unreal, use the PNG on
a sky sphere material or an HDRI backdrop.

```bash
pnpm game:step --step worldmap --text "an archipelago of volcanic islands" --seed 7
pnpm game:step --step worldmap --text "a river delta kingdom" --images sketch.png --input style=<styleRunId>
pnpm game:step --step skybox --text "stormy dusk over mountains"
```

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
