# Ergora Remote — local agent

A small background process that runs on your Mac, Windows PC, or Linux
machine, bridging your device to your [Ergora](https://ergora.cloud) workspace.

**Your files never leave your machine.** Ergora's cloud tells the agent
what to look for; the agent does the work locally and only sends back the
result.

---

## Install

```
curl -sSL https://ergora.app/install.sh | ERGORA_TOKEN=eal_your_token_here bash
```

This:
1. Verifies Node.js 20+ is installed (installs via package manager if missing on Linux)
2. Downloads the latest `ergora-local` release tarball
3. Unpacks to `~/ergora-remote`
4. Installs dependencies and writes your token to `.env`
5. Prints "start the agent" instructions

Get your token at [ergora.cloud/portal](https://ergora.cloud/portal) → Cmd+K → Ergora Remote.

Full step-by-step guide with platform-specific screenshots:
[ergora.app/remote/install](https://ergora.app/remote/install)

---

## What the agent can do

- **Watch folders** you choose for new/changed files (via `MOUNTED_PATHS` in `.env`)
- **Answer questions about local files** asked by your cloud Intern (e.g. "find the Acme contract")
- **Run commands** inside mounted folders if you grant write mode
- **Stay online through sleep/wake** on macOS and Windows — your intern can always reach it

## What it won't do

- Read files outside the folders you list in `MOUNTED_PATHS`
- Upload raw files to Ergora's cloud (file contents stay local; only query results are transmitted)
- Persist once you uninstall — `rm -rf ~/ergora-remote` and revoke the token from the portal

---

## Configuration

`~/ergora-remote/.env`:

```
ERGORA_AGENT_TOKEN=eal_...           # Required. From portal → Ergora Remote → Generate token.
ANTHROPIC_API_KEY=sk-ant-...         # Required only if using BYOK-Claude mode.
MOUNTED_PATHS=/Users/you/Documents,/Users/you/Code
ERGORA_API_URL=https://ergora.cloud  # Default. Override only for self-hosted.
```

## Run

```
cd ~/ergora-remote
npm run dev
```

For unattended running (auto-restart + boot start):

```
npm install -g pm2
cd ~/ergora-remote
pm2 start "npm run dev" --name ergora-remote
pm2 save
pm2 startup    # follow the printed instructions once
```

---

## HUD — top-of-screen voice + keyboard overlay

Alongside the headless agent, this repo ships an optional **Ergora HUD**: a
Tauri-based always-on-top overlay that lets you dictate to or chat with your
Ergora workspace from anywhere on your machine. Press the global hotkey
(`Cmd+Shift+Space` on macOS, `Ctrl+Shift+Space` on Windows/Linux) and the
HUD slides down from the top edge of whichever monitor your cursor is on.

It uses the same `~/.ergora-remote/.env` as the headless agent, so you only
configure Ergora Remote once. The headless agent and HUD can run independently
or simultaneously — they don't share a process.

### Layout

```
src/                    # existing Node CLI headless agent (unchanged)
src-tauri/              # Tauri Rust shell — window, hotkey, OS integration
hud/                    # Vite + React + Tailwind front-end
```

### Develop

Requires the Rust toolchain (`rustup`) and the Tauri prerequisites for your
platform: <https://v2.tauri.app/start/prerequisites/>.

```
cd ~/ergora-remote
npm install                # root deps (incl. @tauri-apps/cli)
npm run hud:install        # front-end deps
npm run hud:dev            # launches Tauri + Vite together
```

`hud:dev` opens the HUD already configured against the credentials in
`~/.ergora-remote/.env`. If `ERGORA_AGENT_TOKEN` is missing, the HUD shows
an inline setup banner and stays in offline mode.

For offline UI iteration without hitting the cloud:

```
VITE_MOCK_VOICE=1 npm run hud:dev
```

Mock mode returns canned responses for transcription, intent dispatch, and
chat — perfect for working on the UI without a working tunnel to ergora.cloud.

### Bundle

```
npm run hud:build              # platform-default bundle (DMG / MSI / AppImage)
npm run hud:bundle:mac         # universal (Intel + Apple Silicon) DMG
```

Output lands in `src-tauri/target/release/bundle/`.

### What it does

- **Mic mode** (default) — circular mic button, animated pulse, VAD-light auto-stop after ~1.2s of silence. Audio is `webm/opus`, posted to `/api/transcribe`.
- **Keyboard mode** — keyboard icon swap; auto-focused text input; Enter submits.
- **Intent dispatch** — transcript or typed text is POSTed to `/api/voice`. The five intents (`find-file`, `capture-to-brain`, `open-tool`, `run-task`, `chat`) each render their own result UI inside the expanded HUD panel.
- **TTS** — chat replies are spoken via `/api/tts` (toggleable in settings).
- **Privacy** — no always-on listening. Audio leaves the machine only when you trigger the HUD. A 50-entry local ring buffer of prompts is kept in the encrypted Tauri app data dir; nothing about the HUD's history syncs to the cloud.
- **Multi-monitor** — appears on the monitor where the cursor currently is.
- **Esc / blur** — dismisses (hides, doesn't quit). Hotkey toggles visibility.

### Cross-platform notes

| | Status |
|---|---|
| macOS | Primary target. Window is promoted to a floating panel level so it sits above fullscreen apps. |
| Windows | Builds. `WS_EX_TOOLWINDOW` / topmost behaviour TODO — see `src-tauri/src/lib.rs`. |
| Linux | Builds. Above-fullscreen behaviour depends on the WM (Wayland layer-shell or `_NET_WM_WINDOW_TYPE_DOCK` on X11) — TODO. |

### Settings

Open the gear icon inside the HUD to:
- Change the global hotkey.
- Override the project ID (defaults to `ERGORA_PROJECT_ID` from the env).
- Toggle "Speak chat replies aloud".

User prefs persist to the Tauri app data dir (`hud-prefs.json`).

---

## Security

- Every line of code that runs on your machine is in this repo. You can
  audit what it does before installing.
- The agent authenticates to Ergora with an HMAC-hashed `eal_*` token
  stored only in your local `.env` — never committed, never uploaded.
- All traffic to ergora.cloud is TLS.
- No inbound listeners — the agent only makes outbound HTTP calls.
- Revoke access at any time: portal → Ergora Remote → rotate token, and/or
  `rm -rf ~/ergora-remote`.

Found a security issue? Email security@ergora.cloud. We'll reply within
one business day.

## Licence

MIT — see [LICENSE](./LICENSE).

## Links

- Product: https://ergora.app/remote
- Install guide: https://ergora.app/remote/install
- Privacy: https://ergora.app/privacy
- Status: https://ergora.cloud/api/health
