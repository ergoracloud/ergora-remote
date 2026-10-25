// Local ring buffer of HUD interactions (last 50). Plain JSON in
// BaseDirectory.AppData; the app does not encrypt it, so it is protected only
// by the user's file permissions and any OS-level disk encryption. Never
// uploaded, but every prompt in it was already sent to the cloud to be
// answered. Keep the README's HUD privacy notes in step with this.
//
// We use the JSON file approach rather than the keychain so users can audit
// what's stored.

import { exists, readTextFile, writeTextFile, mkdir, BaseDirectory } from '@tauri-apps/plugin-fs';

const HISTORY_FILE = 'hud-history.json';
const MAX = 50;

export interface HistoryEntry {
  ts: number;
  prompt: string;
  intent?: string;
  reply?: string;
}

export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    if (await exists(HISTORY_FILE, { baseDir: BaseDirectory.AppData })) {
      const raw = await readTextFile(HISTORY_FILE, { baseDir: BaseDirectory.AppData });
      const parsed = JSON.parse(raw) as HistoryEntry[];
      return Array.isArray(parsed) ? parsed.slice(-MAX) : [];
    }
  } catch (err) {
    console.warn('[history] load failed', err);
  }
  return [];
}

export async function appendHistory(entry: HistoryEntry): Promise<void> {
  try {
    await mkdir('', { baseDir: BaseDirectory.AppData, recursive: true });
  } catch {
    // exists
  }
  const current = await loadHistory();
  const next = [...current, entry].slice(-MAX);
  await writeTextFile(HISTORY_FILE, JSON.stringify(next, null, 2), {
    baseDir: BaseDirectory.AppData,
  });
}
