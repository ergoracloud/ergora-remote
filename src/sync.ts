/**
 * sync — batches local file events and POSTs them to the cloud index
 * via /api/device/agent/file-sync. Batching keeps us well under the
 * Next.js API route overhead during file storms (git checkout, npm install).
 */
import { config } from './config.js';
import { FileEvent } from './watcher.js';
import { extname, basename } from 'path';
import { statSync } from 'fs';

const API = (config.apiUrl ?? 'https://ergora.cloud').replace(/\/$/, '');
const FLUSH_MS = 2000;
const MAX_BATCH = 500;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.mdx', '.csv', '.json', '.yaml', '.yml',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs',
  '.html', '.css', '.sql', '.sh',
]);

interface SyncPayload {
  type: 'add' | 'change' | 'unlink';
  path: string;
  name?: string;
  ext?: string;
  size?: number;
  is_text?: boolean;
  mtime?: string;
}

const queue: SyncPayload[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

export function enqueueFileEvent(event: FileEvent) {
  if (event.type === 'unlink') {
    queue.push({ type: 'unlink', path: event.path });
  } else {
    let size = 0;
    try { size = statSync(event.path).size; } catch { return; }
    const ext = extname(event.path).toLowerCase();
    queue.push({
      type: event.type,
      path: event.path,
      name: basename(event.path),
      ext,
      size,
      is_text: TEXT_EXTENSIONS.has(ext),
      mtime: event.timestamp,
    });
  }
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_MS);
  if (queue.length >= MAX_BATCH) flush();
}

async function flush() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (queue.length === 0) return;
  const batch = queue.splice(0, MAX_BATCH);
  try {
    await fetch(`${API}/api/device/agent/file-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.agentToken}`,
      },
      body: JSON.stringify({ device_id: config.deviceId, events: batch }),
    });
  } catch (err) {
    console.error('[sync] File sync failed:', (err as Error).message);
    // Re-queue on failure (front of line)
    queue.unshift(...batch);
  }
  // Keep draining if more queued
  if (queue.length > 0) scheduleFlush();
}

// Back-compat for callers still using syncFileEvent name
export const syncFileEvent = enqueueFileEvent;
