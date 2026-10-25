# Ergora Remote — local agent

> **Status: paused.** Ergora Remote is on hold and isn't generally available
> yet. This repository stays public so you can read exactly what the agent
> would run on your machine, but the steps below are not a supported release
> and may change before launch. To hear when it ships, join the waitlist at
> [ergora.app/remote](https://ergora.app/remote).

A small background process that runs on your Mac, Windows PC, or Linux
machine, bridging your device to your [Ergora](https://ergora.cloud) workspace.

**It only works inside the folders you choose, but it does send data off your
machine.** To answer a request, the agent sends the request and the contents of
any files it reads to Anthropic's API (Claude), using your own API key. The
answer goes back to your Ergora workspace. Separately, while it runs, it sends
Ergora the names, paths and sizes of files that are added, changed or deleted
in those folders. [What leaves your machine](#what-leaves-your-machine) lists
exactly what is sent, and where.

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

- **Watch folders** you choose (via `MOUNTED_PATHS` in `.env`) and send your Ergora workspace each new, changed or deleted file it sees while running: names, paths and sizes, not contents
- **Answer questions about local files** asked by your cloud Intern (e.g. "find the Acme contract"), using Claude with your own Anthropic API key
- **Pick up again after sleep/wake** — it checks in with Ergora every few seconds rather than holding a connection open, so there is nothing to drop. It can't answer while your machine is asleep or switched off.

## What it won't do

- Read files outside the folders you list in `MOUNTED_PATHS`
- Change, move or delete your files, or run commands: its tools can only find, list and read files
- Upload whole files to Ergora's cloud. Ergora receives file names, paths and sizes, plus the agent's answers, which can quote or summarise what it read. The contents of files the agent reads do go to Anthropic's API (see [What leaves your machine](#what-leaves-your-machine))
- Persist once you uninstall: [Uninstall](#uninstall) lists what to remove, including the HUD's local history

## What leaves your machine

The agent does its work on your machine, but answering a request means sending
data to two services.

**Anthropic's API (Claude)**, called directly from your machine with your own
`ANTHROPIC_API_KEY`, each time your Intern sends the agent a request:

- The request, plus any context your Ergora workspace attached to it
- Your device name, platform and list of `MOUNTED_PATHS` (part of the agent's instructions to Claude)
- The result of every tool call the agent makes: the files it finds and folder listings (names, paths, sizes and modified times), and up to the first 50 KB of each file it reads (files over 10 MB are refused)

Anthropic handles this data under the terms of your own Anthropic API account.

**Ergora's cloud (`ergora.cloud`)**, while the agent is running:

- At start-up: a random device ID, your device name (your computer's hostname unless you set `DEVICE_NAME`), platform, agent version, the list of `MOUNTED_PATHS`, and the device role, tag and label if you set them
- Every 3 seconds: a heartbeat with your device ID, which is also how the agent picks up new requests (while a new device waits for approval, a status check every 5 seconds instead)
- A few seconds after a file is added, changed or deleted in a mounted folder: its path, name, extension, size, the time of the change and whether it looks like a text file (for a deleted file, just its path). Never its contents. Dotfiles, `node_modules` and `.git` are skipped
- After each request: the agent's final answer, which can quote or summarise files it read, and the names of the tools it used, or the error message if the request failed

The agent makes no other network calls. Your `ANTHROPIC_API_KEY` is only ever
sent to Anthropic (or the `ANTHROPIC_BASE_URL` you set), and your
`ERGORA_AGENT_TOKEN` only to Ergora (or the `ERGORA_API_URL` you set).

---

## Configuration

`~/ergora-remote/.env`:

```
ERGORA_AGENT_TOKEN=eal_...           # Required. From portal → Ergora Remote → Generate token.
ANTHROPIC_API_KEY=sk-ant-...         # Required. The agent calls Claude directly with your key.
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

The HUD reads its settings from `~/.ergora-remote/.env` (note the leading dot),
not from the agent's `~/ergora-remote/.env`. Until the two are unified, put
`ERGORA_AGENT_TOKEN` (and `ERGORA_API_URL`, if you override it) in both. The
headless agent and HUD can run independently or simultaneously — they don't
share a process.

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

- **Mic mode** (default) — circular mic button, animated pulse, VAD-light auto-stop after ~1.2s of silence. Audio is `webm/opus`, streamed to `/api/transcribe/stream` for live transcripts, falling back to a single upload to `/api/transcribe`.
- **Keyboard mode** — keyboard icon swap; auto-focused text input; Enter submits.
- **Intent dispatch** — transcript or typed text is POSTed to `/api/voice`. The five intents (`find-file`, `capture-to-brain`, `open-tool`, `run-task`, `chat`) each render their own result UI inside the expanded HUD panel.
- **TTS** — chat replies are spoken via `/api/tts` (toggleable in settings).
- **Privacy** — no always-on listening. Audio leaves the machine only when you trigger the HUD: it goes to Ergora's cloud, which uses a third-party speech-to-text service to transcribe it. The text you speak or type is then sent to Ergora's cloud to be answered, and, unless you turn off "Speak chat replies aloud", chat replies are sent to Ergora's cloud (`/api/tts`), which uses a third-party text-to-speech service to read them out. The HUD keeps your last 50 prompts (and, for chat, the reply) in `hud-history.json` in its app data folder (`~/Library/Application Support/cloud.ergora.hud` on macOS, `%APPDATA%\cloud.ergora.hud` on Windows, `~/.local/share/cloud.ergora.hud` on Linux). That file is plain, unencrypted JSON, protected only by your user account's file permissions and any disk encryption you've turned on (such as FileVault, BitLocker or LUKS). The HUD never uploads the file itself, but every prompt in it has already been sent to Ergora's cloud to be answered.
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

## Uninstall

1. If you set up pm2, stop the agent first: `pm2 delete ergora-remote && pm2 save`.
   If pm2 has nothing else to start at boot, also run `pm2 unstartup` and
   follow any instructions it prints.
2. Delete the agent, its device state and both `.env` files:
   `rm -rf ~/ergora-remote ~/.ergora-remote`
3. If you used the HUD: quit it (or end its process in Activity Monitor, Task
   Manager or your system monitor), delete the Ergora HUD app if you installed
   one, and delete its `cloud.ergora.hud` app data folder. That folder holds
   `hud-history.json` (your last 50 prompts and chat replies, in plain text)
   and `hud-prefs.json`. The path for each platform is in the HUD's
   [privacy notes](#what-it-does). The HUD's logs and webview data are kept
   in other folders with the same name, which you can delete too: for example
   `~/Library/Logs/cloud.ergora.hud` and `~/Library/Caches/cloud.ergora.hud`
   on macOS, or `%LOCALAPPDATA%\cloud.ergora.hud` on Windows.
4. Revoke the token: in the portal, open Ergora Remote and select
   **Generate token**. The new token replaces the old one, which stops working
   straight away. You don't need to use the new one. The button only appears
   while your Ergora Remote subscription is active; if yours has ended, email
   security@ergora.cloud and ask for the token to be revoked.

---

## Security

- The agent and HUD are built only from the code in this repo and the
  third-party packages it lists, so you can audit what they do before
  installing. The install script isn't in this repo: read it at
  <https://ergora.app/install.sh> before you pipe it to `bash`.
- The agent authenticates to Ergora with an `eal_*` token kept in your local
  `.env` (which is git-ignored). The token is sent only to Ergora, to
  authenticate each request, and Ergora stores only an HMAC-SHA256 hash of it.
- All traffic to Ergora and to Anthropic's API uses TLS, unless you point
  `ERGORA_API_URL` or `ANTHROPIC_BASE_URL` at a plain `http://` address.
- No inbound listeners — the agent only makes outbound HTTP calls.
- Revoke access: in the portal, open Ergora Remote and select
  **Generate token**, which stops the old token working. If your Ergora
  Remote subscription has ended, email security@ergora.cloud instead. To
  remove the agent and the HUD from your machine as well, follow
  [Uninstall](#uninstall).

Found a security issue? Email security@ergora.cloud. We'll reply within
one business day.

## Licence

MIT — see [LICENSE](./LICENSE).

## Links

- Product: https://ergora.app/remote
- Install guide: https://ergora.app/remote/install
- Privacy: https://ergora.app/privacy
- Status: https://ergora.cloud/api/health
