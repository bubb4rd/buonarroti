# Buonarroti desktop (Tauri)

A fully local, self-contained desktop app. No accounts, no Supabase, no R2, no
ngrok — it runs the Next.js app as a bundled Node sidecar and stores everything
in a per-user app-data directory. This is the only way the app runs; there is no
hosted/web deployment.

## Architecture

```
┌─ Buonarroti.app ──────────────────────────────────────┐
│  Tauri shell (Rust)                                   │
│    ├─ copies HeliosGen data over once (see below)     │
│    ├─ picks a free localhost port                     │
│    ├─ spawns the `buonarroti-node` sidecar shim,      │
│    │    which hides itself from the Dock, then exec's │
│    │    node  server/server.js                        │
│    │      BUONARROTI_DATA_DIR  = <appData>            │
│    │      BUONARROTI_MEDIA_DIR = <appData>/generated  │
│    └─ navigates the webview to                        │
│         http://127.0.0.1:<port>/?desktop=1            │
└───────────────────────────────────────────────────────┘
```

- The Node runtime is a **resource** (`Contents/Resources/server/node-bin/node`),
  not the sidecar. A binary launched from a bundle's `Contents/MacOS/` gets its
  own macOS Dock tile ([tauri#14014]); the sidecar is a ~20-line Rust shim
  (`src-tauri/loader/`) that calls `TransformProcessType` to drop its Dock tile,
  then `exec`s the real node (path passed in `BUONARROTI_NODE_BIN`).

[tauri#14014]: https://github.com/tauri-apps/tauri/issues/14014

- `next.config.ts` emits `output: "standalone"` when `DESKTOP_BUILD=1`.
- `scripts/desktop/build-server.mjs` builds it, then **discards the traced
  `node_modules`** (nft is unreliable with pnpm and leaves packages truncated)
  and runs a clean `npm install --omit=dev` into `src-tauri/server/` for a flat,
  symlink-free tree. It also copies `.next/static` + `public` in, copies the
  current `node` binary to `src-tauri/server/node-bin/node` (bundled as a
  resource), and `cargo build`s the `src-tauri/loader` shim to
  `src-tauri/binaries/buonarroti-node-<target-triple>` as the Tauri sidecar.
- `lib/guest/paths.ts` resolves `DATA_DIR` / `MEDIA_DIR` from the env vars the
  shell sets; `app/generated/[...path]/route.ts` serves media from outside
  `public/` in the packaged app.
- The webview's first URL carries `?desktop=1` (dev and packaged), and Tauri
  injects `window.__TAURI_INTERNALS__`; the web UI uses either as its desktop
  signal.
- **ACP agents** (`lib/acp/`, see README "Use your own subscriptions"): only the
  small Claude adapter (`@agentclientprotocol/claude-agent-acp`) ships; the
  agents are the user's own installs — `claude` (passed to the adapter as
  `CLAUDE_CODE_EXECUTABLE`), `codex-acp`, `gemini`. `build-server.mjs` checks the
  adapter is staged and prunes the Agent SDK's bundled Claude Code binary
  (`@anthropic-ai/claude-agent-sdk-<platform>`, ~240 MB). The adapter runs on the
  bundled Node (`process.execPath`), never via `npx`. Because a Finder-launched app gets a bare
  `PATH`, `lib/acp/shellEnv.ts` reads the login shell's `PATH` (plus agent API-key
  vars) once at startup, falling back to Homebrew / `~/.local/bin` / nvm dirs,
  so a user-installed `gemini` is found. Agent processes are killed when the
  server exits.

### Window

The main window (`tauri.conf.json` → `app.windows[0]`) uses an overlay title
bar on macOS: `titleBarStyle: "Overlay"`, `hiddenTitle: true`,
`trafficLightPosition: { x: 18, y: 22 }` and `backgroundColor: "#f5f2eb"`
(paper, so there is no flash before the page paints). The web UI draws its own
top strip; elements with `data-tauri-drag-region` (or CSS
`-webkit-app-region: drag`) move the window. Because the UI is served from the
loopback server, Tauri treats it as a remote origin:
`src-tauri/capabilities/remote.json` grants `core:window:allow-start-dragging`
to `http://127.0.0.1:*` and `http://localhost:*` (dev). The bundled loading
page (`src-tauri/loading/index.html`) gets the same permission through
`capabilities/default.json`.

### Data migration from HeliosGen

Buonarroti was forked from HeliosGen, which used the identifier
`cash.sdd.helios.desktop`. On launch, before the sidecar starts, the shell
checks whether `<appData>/guest.db` exists. If it does not, and a sibling
`cash.sdd.helios.desktop` directory exists in the same base directory, its
contents are copied recursively into `app.buonarroti.desktop` (existing files
are never overwritten). The legacy directory is left untouched. What happened
is logged to stderr with a `[tauri]` prefix; a failed copy is logged and the app
starts anyway.

## Prerequisites (one-time)

| Tool | Notes |
| --- | --- |
| **Rust** | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` (installed: rustc 1.98). |
| **Node 22+** | Repo's `pnpm@9.15.9` needs Node ≥ 22.13. `nvm use 22 && corepack enable`. |
| **Tauri system deps** | macOS: Xcode CLT. Linux: webkit2gtk + build-essential. See <https://v2.tauri.app/start/prerequisites/>. |

App icons are generated in `src-tauri/icons/` from `src-tauri/icon-source.png`
(a 1024² render of the tre cerchi mark on a paper squircle). To regenerate after
a logo change: `pnpm tauri icon src-tauri/icon-source.png`, then delete the
`android/`, `ios/` and `Square*`/`StoreLogo` files it adds (desktop only).

Install JS deps (adds `@tauri-apps/cli`): `pnpm install` (or `npm install`).

## Run it

**Development** (hot reload, two processes):

```bash
pnpm desktop:dev
```

Runs `next dev` on :3000 and `tauri dev` together; the shell reads
`BUONARROTI_DEV_URL` and points its window there (no sidecar in dev). First run
compiles the Rust shell (~1–2 min).

**Packaged build:**

```bash
pnpm desktop:build            # → src-tauri/target/release/bundle/
open "src-tauri/target/release/bundle/macos/Buonarroti.app"
```

- macOS: produces `Buonarroti.app` and (with `CI=true`, which the script sets)
  `Buonarroti_<ver>_aarch64.dmg`. The `.app` is ~440 MB (bundled Node runtime +
  prod `node_modules`).
- The app is **unsigned** — on first launch macOS Gatekeeper blocks it.
  Right-click → Open, or `xattr -cr "src-tauri/target/release/bundle/macos/Buonarroti.app"`.
- Data lives in `~/Library/Application Support/app.buonarroti.desktop/`:
  `guest.db` (SQLite — generations, uploads, folders, workflows, settings) and
  `generated/` (media). Delete that folder to reset.

To just run the compiled binary without bundling:
`./src-tauri/target/release/buonarroti-desktop`

## Signed & notarized release build

Needs a **Developer ID Application** certificate (not "Apple Development") in the
login keychain + notarization credentials.

1. `cp scripts/desktop/sign.env.example scripts/desktop/sign.env` and fill it in
   (identity string from `security find-identity -v -p codesigning`; an App Store
   Connect API key or Apple-ID app-specific password).
2. ```bash
   set -a; source scripts/desktop/sign.env; set +a
   pnpm desktop:build
   ```

With `APPLE_SIGNING_IDENTITY` set, `build-server.mjs` codesigns the Mach-O in
the staged server — the bundled `node` runtime and sharp's `.node`/`.dylib` —
with hardened runtime + entitlements; Tauri then signs the app shell + the
`buonarroti-node` sidecar shim, notarizes, and staples. Entitlements are in
`src-tauri/entitlements.plist` (JIT + unsigned-exec-memory +
disable-library-validation — the bundled Node/V8 needs them).

Verify the result:
```bash
spctl -a -vvv "src-tauri/target/release/bundle/macos/Buonarroti.app"   # → accepted, source=Notarized Developer ID
xcrun stapler validate "src-tauri/target/release/bundle/dmg/Buonarroti_1.2.0_aarch64.dmg"
```

## Local data store

`lib/guest/sqlite.ts` (SQLite via `node:sqlite`, built into Node 22 — no native
dep) backs `lib/guest/db.ts` (generations, uploads, folders, settings, asset
hashes) and `lib/guest/spaces.ts` (workflows, served to `useSpaceSync` via
`app/api/workflows`). Media bytes go to `MEDIA_DIR` on disk and are served
same-origin from `app/generated/[...path]/route.ts`. The loopback port is fixed
(`41730`) so the webview's `localStorage` survives across launches.

Export a workflow (canvas toolbar → Export) to a `.zip` bundling `workflow.json`
plus every referenced image/video — portable and shareable as a file
(`lib/exportWorkflow.ts`).

## Status / remaining work

- [x] Phase 0 — branch + Tauri scaffold
- [x] Phase 1 — standalone output + Node sidecar + writable data dir + icons.
      `Buonarroti.app` + `.dmg` build and launch; all routes serve, guest DB
      writes to `~/Library/Application Support/app.buonarroti.desktop/`.
- [x] Phase 2 — kie.ai webhook replaced with polling (`lib/kieJobPoller.ts`).
      `/api/generate` + `/api/generate-video` record a durable `pending` row in
      the SQLite `generations` table, then poll `/api/v1/jobs/recordInfo` (or
      `/api/v1/veo/record-info` for Google Veo). Transient kie errors (429/5xx,
      network) back off and retry; caps are 30 min (image) / 60 min (video).
      On the first API hit after a restart, pending kie jobs resume with the
      right poller; Azure/Codex jobs that can't resume become `interrupted`.
      No callback URL needed.
- [x] Phase 3 — reference/uploaded images reach kie.ai without a tunnel.
      `lib/kieUpload.ts` pushes local `/generated` + `data:` media to kie's temp
      store (`kieai.redpandaai.co/api/file-base64-upload`, 3-day retention) and
      swaps in the returned URL. `/api/generate` does it for image inputs;
      `/api/generate-video` deep-walks the payload (its shape varies by model).
      Verified end-to-end (nano-banana-2-lite image-to-image, no tunnel).
      **Gap:** video *file* inputs >10 MB should use kie's stream-upload API
      instead of base64.
- [x] Local-only — no accounts, no Supabase, no R2. The web/cloud code path was
      removed entirely (`@supabase/*` + `@aws-sdk/*` dropped); all storage is the
      local SQLite DB + disk. Fixed loopback port (41730) so `localStorage`
      survives launches; sidecar is killed on app exit.
- [x] External CLIs — the shell resolves the login-shell `$PATH` for the sidecar
      so `ffmpeg`/`ffprobe` (video trim, frame extract) and `codex`/
      `codex-imagegen` (optional Codex provider) are found. They're not bundled;
      if absent the feature degrades cleanly (Codex badge shows NOT CONFIGURED,
      video-trim errors). Codex still needs a one-time `codex login` in Settings.
- [~] Phase 4 — signing/notarization wired up (config + entitlements +
      native-module signing in `build-server.mjs`); needs a Developer ID cert to
      actually run.
- [x] Update check — `app/api/update-check/route.ts` asks the GitHub Releases
      API (`repos/bubb4rd/buonarroti/releases/latest`, cached ~1 h) whether
      `tag_name` is newer than `NEXT_PUBLIC_APP_VERSION` (baked from
      `tauri.conf.json` by `build-server.mjs` / `dev.mjs`). When it is,
      `components/UpdateBanner.tsx` shows a yellow "Update available" bar under
      the Kie banner; tapping it opens a modal with the release notes and a
      **Download** button (opens the release page via the external-link handler).
      No self-install. Cut a release by bumping `version` in `tauri.conf.json`,
      `package.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock` (the
      `buonarroti-desktop` entry) to the same `X.Y.Z`, then `node
      scripts/desktop/check-version.mjs X.Y.Z` to confirm they agree. Commit,
      then tag `vX.Y.Z`. Tauri bakes `tauri.conf.json` `version` into the macOS
      Info.plist / Windows installer and into `NEXT_PUBLIC_APP_VERSION`. `npm run
      desktop:build` runs the check first, and the `version-check` CI job fails
      any tag push whose version files disagree (issue #12).
      `NEXT_PUBLIC_UPDATE_CHECK_FORCE=1` (dev) forces the banner on for eyeballing.
- [ ] Bundle size — was ~330 MB stage / ~440 MB `.app`; dropping `@aws-sdk` +
      `@supabase` (~web/cloud removal) should trim it further. Remaining bulk is
      the bundled Node runtime (~108 MB) and the prod `node_modules`.

Image and video generation — including from uploaded/reference images — work
with no tunnel. Still needing work: Google Veo (needs a callback URL) and large
video-file inputs (base64 upload is capped ~10 MB).
