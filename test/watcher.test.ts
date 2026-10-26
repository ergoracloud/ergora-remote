import { after, before, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileEvent } from '../src/watcher.js';

// As in tools.test.ts, config.ts must load against a scratch HOME and MOUNTED_PATHS.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'ergora-watcher-')));
const code = join(base, 'Code');
const outside = join(base, 'outside');
// A mounted folder that is a symlink to a real folder under a dot-folder.
const notes = join(base, 'Notes');
const notesReal = join(base, '.hidden', 'notes');
process.env.HOME = process.env.USERPROFILE = join(base, 'home');
process.env.MOUNTED_PATHS = [code, notes].join(',');

let watcher: typeof import('../src/watcher.js');
const events: FileEvent[] = [];

// Resolves once the watcher has reported an event for this exact path.
async function eventFor(path: string, timeoutMs = 10_000): Promise<FileEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = events.find(e => e.path === path);
    if (hit) return hit;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`No event for ${path} within ${timeoutMs}ms. Saw: ${events.map(e => e.path).join(', ')}`);
}

before(async () => {
  mkdirSync(code);
  mkdirSync(outside);
  mkdirSync(notesReal, { recursive: true });
  symlinkSync(outside, join(code, 'linkdir'), 'dir');
  symlinkSync(notesReal, notes, 'dir');
  watcher = await import('../src/watcher.js');
  watcher.onFileEvent(e => events.push(e));
  watcher.startWatcher();
  // chokidar doesn't say when it's ready, so write a probe until one is seen.
  for (let i = 0; ; i++) {
    const probe = join(code, `probe-${i}.txt`);
    writeFileSync(probe, 'probe');
    try { await eventFor(probe, 1_500); break; } catch { if (i === 10) throw new Error('watcher never started'); }
  }
});

after(() => {
  watcher?.stopWatcher();
  rmSync(base, { recursive: true, force: true });
});

it('only reports files that are really inside a mounted folder', async () => {
  writeFileSync(join(outside, 'leak-direct.txt'), 'x');
  writeFileSync(join(code, 'linkdir', 'leak-via-link.txt'), 'x');
  symlinkSync(join(outside, 'leak-direct.txt'), join(code, 'leak-link.txt'));
  symlinkSync(join(outside, 'leak-nowhere'), join(code, 'leak-dangling'));
  writeFileSync(join(code, 'inside.txt'), 'x');
  writeFileSync(join(notes, 'in-notes.txt'), 'x');

  await eventFor(join(code, 'inside.txt'));
  // Notes is watched at its real location, under a dot-folder, but isn't
  // ignored for that, and its events are reported under Notes as mounted.
  await eventFor(join(notes, 'in-notes.txt'));
  assert.ok(!events.some(e => e.path.startsWith(notesReal)));

  // Give any event for the files above another full settle time to arrive.
  writeFileSync(join(code, 'marker-1.txt'), 'x');
  await eventFor(join(code, 'marker-1.txt'));

  // Removing the symlinked folder must not report the names of files behind it.
  unlinkSync(join(code, 'linkdir'));
  writeFileSync(join(code, 'marker-2.txt'), 'x');
  await eventFor(join(code, 'marker-2.txt'));

  const leaked = events.filter(e => e.path.includes('leak'));
  assert.deepEqual(leaked, []);
});
