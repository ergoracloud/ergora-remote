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
