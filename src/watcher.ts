import chokidar, { FSWatcher } from 'chokidar';
import { config } from './config.js';

export interface FileEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  timestamp: string;
}

type EventCallback = (event: FileEvent) => void;

let watcher: FSWatcher | null = null;
const listeners: EventCallback[] = [];

export function startWatcher() {
  if (watcher) return;
  if (config.mountedPaths.length === 0) {
    console.log('[watcher] No mounted paths — skipping file watcher');
    return;
  }

  console.log(`[watcher] Watching: ${config.mountedPaths.join(', ')}`);

  watcher = chokidar.watch(config.mountedPaths, {
    ignored: [
      /(^|[/\\])\../,        // dotfiles
      /node_modules/,
      /\.git/,
      /\.DS_Store/,
    ],
    persistent: true,
    ignoreInitial: true,
    depth: 4,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
  });

  const emit = (type: FileEvent['type']) => (path: string) => {
    const event: FileEvent = { type, path, timestamp: new Date().toISOString() };
    listeners.forEach(fn => fn(event));
  };

  watcher
    .on('add', emit('add'))
    .on('change', emit('change'))
    .on('unlink', emit('unlink'))
    .on('error', err => console.error('[watcher] Error:', err));
}

export function onFileEvent(callback: EventCallback) {
  listeners.push(callback);
}

export function stopWatcher() {
  watcher?.close();
  watcher = null;
}
