import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join, resolve, relative } from 'path';
import { config } from './config.js';

// Security: ensure path is within a mounted folder
function assertMounted(targetPath: string): string {
  const abs = resolve(targetPath);
  const allowed = config.mountedPaths.some(mp => abs.startsWith(resolve(mp)));
  if (!allowed) {
    throw new Error(`Access denied: ${abs} is not within a mounted path. Mounted: ${config.mountedPaths.join(', ')}`);
  }
  return abs;
}

export interface FoundFile {
  path: string;
  name: string;
  size: number;
  modified: string;
  relativePath: string;
}

export function findFiles(query: string, basePath?: string): FoundFile[] {
  const roots = basePath ? [assertMounted(basePath)] : config.mountedPaths.map(p => resolve(p));
  const results: FoundFile[] = [];
  const queryLower = query.toLowerCase();

  function walk(dir: string, depth = 0) {
    if (depth > 6) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'node_modules') continue;
      const full = join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      if (stat.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.toLowerCase().includes(queryLower)) {
        const root = roots.find(r => full.startsWith(r)) ?? roots[0];
        results.push({
          path: full,
          name: entry,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          relativePath: relative(root, full),
        });
      }
    }
  }

  for (const root of roots) walk(root);
  return results.slice(0, 20);
}

export function listFolder(folderPath: string): { name: string; type: 'file' | 'dir'; size: number; modified: string }[] {
  const abs = assertMounted(folderPath);
  return readdirSync(abs)
    .filter(n => !n.startsWith('.'))
    .map(name => {
      const full = join(abs, name);
      const stat = statSync(full);
      return { name, type: stat.isDirectory() ? 'dir' as const : 'file' as const, size: stat.size, modified: stat.mtime.toISOString() };
    })
    .slice(0, 50);
}

export function readFile(filePath: string, maxBytes = 50_000): string {
  const abs = assertMounted(filePath);
  if (!existsSync(abs)) throw new Error(`File not found: ${abs}`);
  const stat = statSync(abs);
  if (stat.size > 10_000_000) throw new Error('File too large (>10MB) to read directly');
  const buf = readFileSync(abs);
  const text = buf.toString('utf8', 0, Math.min(buf.length, maxBytes));
  return text + (buf.length > maxBytes ? `\n\n[...truncated at ${maxBytes} bytes of ${buf.length}]` : '');
}

export function getMountedPaths(): string[] {
  return config.mountedPaths;
}

// Anthropic tool definitions for the agent
export const LOCAL_TOOLS = [
  {
    name: 'find_files',
    description: 'Search for files by name across mounted local folders.',
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
    description: 'List contents of a local folder.',
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
    description: 'Read the contents of a local file (text files only, max 50KB returned).',
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
