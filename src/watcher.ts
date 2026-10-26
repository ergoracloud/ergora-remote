import chokidar, { FSWatcher } from 'chokidar';
import { config } from './config.js';
import { displayPath, isInsideMountedPath, locate, mounts } from './tools.js';

export interface FileEvent {
  type: 'add' | 'change' | 'unlink';
  path: string;
  timestamp: string;
}

type EventCallback = (event: FileEvent) => void;

let watcher: FSWatcher | null = null;
const listeners: EventCallback[] = [];

const IGNORED = [
  /(^|[/\\])\../,        // dotfiles
  /node_modules/,
  /\.git/,
  /\.DS_Store/,
];

export function startWatcher() {
  if (watcher) return;
  if (config.mountedPaths.length === 0) {
    console.log('[watcher] No mounted paths — skipping file watcher');
    return;
  }

  console.log(`[watcher] Watching: ${config.mountedPaths.join(', ')}`);

  // Watch each mounted folder at its real location without following the
  // symlinks inside it, so no event can come from outside a mounted folder.
  const list = mounts();
  watcher = chokidar.watch(list.map(m => m.real), {
    // Apply the ignore rules to the path inside its mounted folder, so a folder
    // whose real location is under a dot-folder isn't skipped whole.
    ignored: (p: string) => {
      const rel = locate(p, list)?.rel ?? p;
      return IGNORED.some(re => re.test(rel));
    },
    followSymlinks: false,
    persistent: true,
    ignoreInitial: true,
    depth: 4,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 100 },
  });

  const emit = (type: FileEvent['type']) => (path: string) => {
    // A symlink is reported as itself. Drop one that points outside the
    // mounted folders.
    if (!isInsideMountedPath(path, list)) return;
    const event: FileEvent = { type, path: displayPath(path, list), timestamp: new Date().toISOString() };
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
