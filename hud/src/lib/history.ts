// Local ring buffer of HUD interactions (last 50). Stored encrypted-at-rest by
// Tauri's app data dir + OS-level disk encryption — deliberately NOT synced
// to the cloud (privacy promise).
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
