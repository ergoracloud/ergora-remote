import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { config } from './config.js';

// Security: paths are checked by where they really lead on disk, with every
// symlink resolved, so a link inside a mounted folder can't reach outside it.

const MAX_LINK_HOPS = 40;

// Where a dangling symlink points, against the real folder it sits in, or
// undefined when p isn't a symlink.
function danglingTarget(p: string): string | undefined {
  try {
    if (!lstatSync(p).isSymbolicLink()) return undefined;
    return resolve(realpathSync.native(dirname(p)), readlinkSync(p));
  } catch {
    return undefined;
  }
}

// Where an absolute path really leads. When part of it doesn't exist, the
// nearest existing folder is resolved and the missing names are kept on the
// end, so a missing file in a mounted folder still lands inside it. A dangling
// symlink is followed by hand, so it's judged by where it points, not where it
// sits. Any other error (a symlink loop, a name that's too long, no permission
// to look) comes back alongside the resolved path rather than being thrown, so
// callers only pass it on when that path is inside a mounted folder. The .native
// realpath returns the on-disk case on macOS and Windows, so mounted folders and
// targets compare like for like on case-insensitive filesystems.
function realpathNearest(abs: string): { real: string; exists: boolean; error?: NodeJS.ErrnoException } {
  const missing: string[] = [];
  let cur = abs;
  let error: NodeJS.ErrnoException | undefined;
  let hops = 0;
  for (;;) {
    let real: string;
    try {
      real = realpathSync.native(cur);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      const target = e.code === 'ENOENT' ? danglingTarget(cur) : undefined;
      if (target !== undefined && hops < MAX_LINK_HOPS) {
        hops++;
        cur = target;
        continue;
      }
      if (target !== undefined) error ??= Object.assign(new Error(`Too many symlinks: ${abs}`), { code: 'ELOOP' });
      else if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') error ??= e;
      const parent = dirname(cur);
      if (parent === cur) throw e;
      missing.unshift(basename(cur));
      cur = parent;
      continue;
    }
    return { real: join(real, ...missing), exists: missing.length === 0, error };
  }
}

// True when target is root or inside it. path.relative compares
// case-insensitively on Windows.
function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export interface Mount {
  path: string; // as configured in MOUNTED_PATHS, made absolute
  real: string; // where it really is
}

// The mounted folders. One that can't be resolved is left out, so nothing can
// be reached through it.
export function mounts(): Mount[] {
  const list: Mount[] = [];
  for (const mp of config.mountedPaths) {
    const path = resolve(mp);
    try { list.push({ path, real: realpathNearest(path).real }); } catch { /* left out */ }
  }
  return list;
}

// The mount a real path is in (the deepest one, if mounts overlap) and the
// path's place inside it.
export function locate(real: string, list: Mount[] = mounts()): { mount: Mount; rel: string } | undefined {
  let best: Mount | undefined;
  for (const m of list) {
    if (isWithin(m.real, real) && (best === undefined || m.real.length > best.real.length)) best = m;
  }
  return best && { mount: best, rel: relative(best.real, real) };
}

// A real path as the user knows it: under the mounted folder as configured,
// e.g. ~/Dropbox/x rather than wherever ~/Dropbox really points.
export function displayPath(real: string, list: Mount[] = mounts()): string {
  const at = locate(real, list);
  return at ? join(at.mount.path, at.rel) : real;
}

function accessDenied(abs: string): Error {
  return new Error(`Access denied: ${abs} is not within a mounted path. Mounted: ${config.mountedPaths.join(', ')}`);
}

// Security: ensure path is within a mounted folder. Returns the real path,
// which is the one to open.
function assertMounted(targetPath: string, list: Mount[] = mounts()): string {
  if (typeof targetPath !== 'string' || targetPath === '') throw new Error('A path is required');
  const abs = resolve(targetPath);
  let target: ReturnType<typeof realpathNearest>;
  try { target = realpathNearest(abs); } catch { throw accessDenied(abs); }
  if (!locate(target.real, list)) throw accessDenied(abs);
  if (target.error) throw new Error(`Cannot open ${abs} (${target.error.code})`);
  if (!target.exists) throw new Error(`Not found: ${abs}`);
  return target.real;
}

// For the file watcher: whether a path really is inside a mounted folder.
export function isInsideMountedPath(targetPath: string, list: Mount[] = mounts()): boolean {
  try {
    return locate(realpathNearest(resolve(targetPath)).real, list) !== undefined;
  } catch {
    return false;
  }
}

export interface FoundFile {
  path: string;
  name: string;
  size: number;
  modified: string;
  relativePath: string;
}

export function findFiles(query: string, basePath?: string): FoundFile[] {
  const list = mounts();
  const roots = basePath ? [assertMounted(basePath, list)] : list.map(m => m.real);
  const results: FoundFile[] = [];
  const queryLower = query.toLowerCase();
  // The shallowest depth each folder (by real path) was walked at, and the
  // files already found, so overlapping mounted folders are searched once
  // without losing depth. Symlinks are skipped, never followed, so the walk
  // can't leave a mounted folder or loop through a link.
  const walkedAt = new Map<string, number>();
  const found = new Set<string>();

  function walk(dir: string, root: string, depth = 0) {
    if (depth > 6 || (walkedAt.get(dir) ?? Infinity) <= depth) return;
    walkedAt.set(dir, depth);
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const full = join(dir, entry);
      let stat;
      try { stat = lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(full, root, depth + 1);
      } else if (!found.has(full) && entry.toLowerCase().includes(queryLower)) {
        found.add(full);
        results.push({
          path: displayPath(full, list),
          name: entry,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          relativePath: relative(root, full),
        });
      }
    }
  }

  for (const root of roots) walk(root, root);
  return results.slice(0, 20);
}

export function listFolder(folderPath: string): { name: string; type: 'file' | 'dir' | 'link'; size: number; modified: string }[] {
  const abs = assertMounted(folderPath);
  return readdirSync(abs)
    .filter(n => !n.startsWith('.'))
    .flatMap(name => {
      // lstat: a symlink is listed as a link, not as whatever it points at,
      // which may be outside the mounted folder.
      let stat;
      try { stat = lstatSync(join(abs, name)); } catch { return []; }
      const type = stat.isSymbolicLink() ? 'link' as const : stat.isDirectory() ? 'dir' as const : 'file' as const;
      return [{ name, type, size: stat.size, modified: stat.mtime.toISOString() }];
    })
    .slice(0, 50);
}

export function readFile(filePath: string, maxBytes = 50_000): string {
  const abs = assertMounted(filePath);
  // One descriptor for the checks and the read. O_NOFOLLOW stops the file
  // being swapped for a symlink after the check above, and O_NONBLOCK stops a
  // named pipe hanging the agent. Windows has neither, so they're 0 there.
  const fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Not a file: ${resolve(filePath)}`);
    if (stat.size > 10_000_000) throw new Error('File too large (>10MB) to read directly');
    const buf = Buffer.alloc(maxBytes);
    let length = 0;
    while (length < maxBytes) {
      const n = readSync(fd, buf, length, maxBytes - length, length);
      if (n === 0) break;
      length += n;
    }
    const text = buf.toString('utf8', 0, length);
    return text + (stat.size > maxBytes ? `\n\n[...truncated at ${maxBytes} bytes of ${stat.size}]` : '');
  } finally {
    closeSync(fd);
  }
}

export function getMountedPaths(): string[] {
  return config.mountedPaths;
}

// Anthropic tool definitions for the agent
export const LOCAL_TOOLS = [
  {
    name: 'find_files',
    description: 'Search for files by name across mounted local folders. Symlinks are skipped.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Filename pattern or substring to search for' },
        base_path: { type: 'string', description: 'Optional: limit search to this subfolder (must be within mounted paths)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_folder',
    description: 'List contents of a local folder. Symlinks are listed with type "link", and are only followed if they point inside a mounted path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        folder_path: { type: 'string', description: 'Absolute path to folder (must be within mounted paths)' },
      },
      required: ['folder_path'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a local file (text files only, max 50KB returned). A symlink is only followed if it points inside a mounted path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        file_path: { type: 'string', description: 'Absolute path to file (must be within mounted paths)' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'get_mounted_paths',
    description: 'Get the list of local folder paths this agent has access to.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
] as const;

export function executeTool(name: string, input: Record<string, unknown>): unknown {
  switch (name) {
    case 'find_files':
      return findFiles(input.query as string, input.base_path as string | undefined);
    case 'list_folder':
      return listFolder(input.folder_path as string);
    case 'read_file':
      return readFile(input.file_path as string);
    case 'get_mounted_paths':
      return getMountedPaths();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
