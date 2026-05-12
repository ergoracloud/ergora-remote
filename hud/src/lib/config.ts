// Config loader for the HUD.
//
// The desktop client (headless agent) reads its credentials from
// ~/.ergora-remote/.env (see ../../src/config.ts on the Node side). The HUD
// reuses that file so the user only configures Ergora Remote once. We parse
// the .env manually rather than importing a node-only dotenv lib — this code
// runs inside the Tauri webview.

import { exists, readTextFile, writeTextFile, mkdir, BaseDirectory } from '@tauri-apps/plugin-fs';
import { homeDir, join } from '@tauri-apps/api/path';

export interface ErgoraConfig {
  agentToken: string;
  apiUrl: string;
  deviceId?: string;
  deviceName?: string;
  projectId?: string;
}

export interface ConfigStatus {
  ok: boolean;
  missing: string[];
  config: ErgoraConfig;
}

const DEFAULT_API = 'https://ergora.cloud';

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

async function envPath(): Promise<string> {
  const home = await homeDir();
  return join(home, '.ergora-remote', '.env');
}

async function statePath(): Promise<string> {
  const home = await homeDir();
  return join(home, '.ergora-remote', 'state.json');
}

export async function loadConfig(): Promise<ConfigStatus> {
  // MOCK_VOICE shortcut: if the env knob is set and we're running under Vite
  // dev, return a synthetic config so the UI works offline.
  const mock = (import.meta as { env?: Record<string, string> }).env?.VITE_MOCK_VOICE === '1';
  if (mock) {
    return {
      ok: true,
      missing: [],
      config: {
        agentToken: 'mock_token',
        apiUrl: 'mock://ergora',
        deviceId: 'mock-device',
        deviceName: 'Mock Device',
      },
    };
  }

  const config: ErgoraConfig = { agentToken: '', apiUrl: DEFAULT_API };
  const missing: string[] = [];

  try {
    const ep = await envPath();
    if (await exists(ep)) {
      const env = parseEnv(await readTextFile(ep));
      config.agentToken = env.ERGORA_AGENT_TOKEN ?? '';
      config.apiUrl = env.ERGORA_API_URL || DEFAULT_API;
      config.projectId = env.ERGORA_PROJECT_ID || undefined;
    } else {
      missing.push('ERGORA_AGENT_TOKEN');
    }
  } catch (err) {
    console.error('[config] failed reading .env', err);
    missing.push('ERGORA_AGENT_TOKEN');
  }

  // Pick up device identity from the headless agent's state.json if present.
  try {
    const sp = await statePath();
    if (await exists(sp)) {
      const state = JSON.parse(await readTextFile(sp));
      config.deviceId = state.deviceId;
      config.deviceName = state.deviceName;
    }
  } catch {
    // non-fatal — the route can run without a deviceId
  }

  if (!config.agentToken && !missing.includes('ERGORA_AGENT_TOKEN')) {
    missing.push('ERGORA_AGENT_TOKEN');
  }

  return { ok: missing.length === 0, missing, config };
}

/// Save user-tunable preferences (hotkey, TTS toggle, project) to the Tauri
/// app data dir. We deliberately do NOT touch ~/.ergora-remote/.env from the
/// HUD — the headless agent owns that file.
export interface UserPrefs {
  hotkey: string;
  ttsEnabled: boolean;
  projectId: string;
}

export const DEFAULT_PREFS: UserPrefs = {
  hotkey: navigator.platform.toUpperCase().includes('MAC')
    ? 'CmdOrCtrl+Shift+Space'
    : 'Ctrl+Shift+Space',
  ttsEnabled: true,
  projectId: '',
};

const PREFS_FILE = 'hud-prefs.json';

export async function loadPrefs(): Promise<UserPrefs> {
  try {
    if (await exists(PREFS_FILE, { baseDir: BaseDirectory.AppData })) {
      const raw = await readTextFile(PREFS_FILE, { baseDir: BaseDirectory.AppData });
      return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.warn('[prefs] load failed, using defaults', err);
  }
  return DEFAULT_PREFS;
}

export async function savePrefs(prefs: UserPrefs): Promise<void> {
  try {
    await mkdir('', { baseDir: BaseDirectory.AppData, recursive: true });
  } catch {
    // already exists
  }
  await writeTextFile(PREFS_FILE, JSON.stringify(prefs, null, 2), {
    baseDir: BaseDirectory.AppData,
  });
}
