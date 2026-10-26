import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

// config.ts reads MOUNTED_PATHS and writes ~/.ergora-remote/state.json as soon
// as it loads, so both point at a scratch folder before the tools are imported.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'ergora-tools-')));
const code = join(base, 'Code');
const nested = join(code, 'nested');
const outside = join(base, 'outside');
const alias = join(base, 'Alias');
const missingMount = join(base, 'Missing');
const longName = 'x'.repeat(300);
process.env.HOME = process.env.USERPROFILE = join(base, 'home');
// Code/nested is mounted as well as Code, to check overlapping folders are
// searched once. Alias is a symlink to Real. Missing doesn't exist.
process.env.MOUNTED_PATHS = [code, nested, alias, missingMount].join(',');

let tools: typeof import('../src/tools.js');

before(async () => {
  mkdirSync(join(nested, 'deep'), { recursive: true });
  mkdirSync(join(nested, 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true });
  mkdirSync(join(base, 'Code-private'));
  mkdirSync(join(base, 'Codebase'));
  mkdirSync(join(outside, 'sub'), { recursive: true });
  mkdirSync(join(base, 'Real'));
  writeFileSync(join(code, 'notes.txt'), 'hello');
  writeFileSync(join(code, '..notes.txt'), 'two dots');
  writeFileSync(join(nested, 'deep', 'report.txt'), 'deep');
  writeFileSync(join(nested, 'a', 'b', 'c', 'd', 'e', 'f', 'deepest.txt'), 'deepest');
  writeFileSync(join(base, 'Code-private', 'secret.txt'), 'private');
  writeFileSync(join(base, 'Codebase', 'secret.txt'), 'codebase');
  writeFileSync(join(outside, 'secret.txt'), 'outside secret');
  writeFileSync(join(outside, 'report-outside.txt'), 'outside report');
  writeFileSync(join(base, 'Real', 'alias-doc.txt'), 'via alias');
  symlinkSync(join(outside, 'secret.txt'), join(code, 'link-out.txt'));
  symlinkSync(join(outside, 'secret.txt'), join(code, 'secret-link.txt'));
  symlinkSync('notes.txt', join(code, 'link-in.txt'));
  symlinkSync(outside, join(code, 'linkdir'), 'dir');
  symlinkSync(code, join(code, 'up'), 'dir');
  symlinkSync('loopy', join(code, 'loopy'));
  symlinkSync('loop', join(outside, 'loop'));
  symlinkSync(join(outside, 'nowhere'), join(code, 'dangling-out'));
  symlinkSync(join(code, 'nowhere'), join(code, 'dangling-in'));
  symlinkSync(join(base, 'Real'), alias, 'dir');
  tools = await import('../src/tools.js');
});

after(() => rmSync(base, { recursive: true, force: true }));

const denied = /Access denied: /;
const notFound = /Not found: /;

describe('assertMounted, through readFile and listFolder', () => {
  it('rejects sibling folders that only share the mounted name as a prefix', () => {
    assert.throws(() => tools.readFile(join(base, 'Code-private', 'secret.txt')), denied);
    assert.throws(() => tools.readFile(join(base, 'Codebase', 'secret.txt')), denied);
    assert.throws(() => tools.listFolder(join(base, 'Code-private')), denied);
  });

  it('rejects .. that climbs out of a mounted folder', () => {
    assert.throws(() => tools.readFile([code, '..', 'outside', 'secret.txt'].join(sep)), denied);
  });

  it('rejects a symlink to a file outside, without naming its target', () => {
    assert.throws(() => tools.readFile(join(code, 'link-out.txt')), (err: Error) => {
      assert.match(err.message, denied);
      assert.ok(!err.message.includes(outside));
      return true;
    });
  });

  it('rejects a symlinked folder that points outside, and anything under it', () => {
    assert.throws(() => tools.listFolder(join(code, 'linkdir')), denied);
    assert.throws(() => tools.readFile(join(code, 'linkdir', 'secret.txt')), denied);
    assert.throws(() => tools.readFile(join(code, 'linkdir', 'missing.txt')), denied);
  });

  it('gives the same answer through an outside symlink whatever the OS error, so existence does not leak', () => {
    assert.throws(() => tools.readFile(join(code, 'linkdir', 'sub', longName)), denied);
    assert.throws(() => tools.readFile(join(code, 'linkdir', 'nosuch', longName)), denied);
    assert.throws(() => tools.readFile(join(code, 'linkdir', 'loop')), denied);
  });

  it('judges a dangling symlink by where it points', () => {
    assert.throws(() => tools.readFile(join(code, 'dangling-out')), denied);
    assert.throws(() => tools.readFile(join(code, 'dangling-in')), notFound);
  });

  it('passes on an OS error for a path that really is inside', () => {
    assert.throws(() => tools.readFile(join(code, 'loopy')), /Cannot open .*\(ELOOP\)/);
    assert.throws(() => tools.readFile(join(code, longName)), /Cannot open .*\(ENAMETOOLONG\)/);
  });

  it('reads a normal nested file', () => {
    assert.equal(tools.readFile(join(nested, 'deep', 'report.txt')), 'deep');
  });

  it('follows a symlink that stays inside the mounted folder', () => {
    assert.equal(tools.readFile(join(code, 'link-in.txt')), 'hello');
  });

  it('allows the mounted folder itself and names that start with two dots', () => {
    assert.ok(tools.listFolder(code).some(e => e.name === 'notes.txt'));
    assert.equal(tools.readFile(join(code, '..notes.txt')), 'two dots');
  });

  it('works through a mounted folder that is itself a symlink', () => {
    assert.equal(tools.readFile(join(alias, 'alias-doc.txt')), 'via alias');
    assert.equal(tools.readFile(join(base, 'Real', 'alias-doc.txt')), 'via alias');
  });

  it('reports a missing file in a mounted folder as not found, not access denied', () => {
    assert.throws(() => tools.readFile(join(code, 'missing.txt')), notFound);
    assert.throws(() => tools.listFolder(join(code, 'no', 'such', 'folder')), notFound);
    assert.throws(() => tools.readFile(join(code, 'notes.txt', 'child')), notFound);
    assert.throws(() => tools.readFile(join(missingMount, 'x.txt')), notFound);
    assert.throws(() => tools.listFolder(missingMount), notFound);
  });

  it('reports a missing file outside as access denied, so existence does not leak', () => {
    assert.throws(() => tools.readFile(join(base, 'nowhere.txt')), denied);
    assert.throws(() => tools.readFile(join(base, 'Code-private', 'missing.txt')), denied);
  });

  it('rejects an empty or missing path', () => {
    assert.throws(() => tools.readFile(''), /A path is required/);
    assert.throws(() => tools.listFolder(undefined as unknown as string), /A path is required/);
  });
});

describe('readFile', () => {
  it('refuses to read a folder as a file', () => {
    assert.throws(() => tools.readFile(nested), /Not a file: /);
  });

  // If this regresses, the blocking open hangs the whole run rather than failing.
  it('refuses a named pipe instead of hanging on it', { skip: process.platform === 'win32' }, () => {
    const fifo = join(code, 'pipe');
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    assert.throws(() => tools.readFile(fifo), /Not a file: /);
  });

  it('truncates at maxBytes and says how big the file is', () => {
    assert.equal(tools.readFile(join(code, 'notes.txt'), 2), 'he\n\n[...truncated at 2 bytes of 5]');
  });
});

describe('listFolder', () => {
  it('lists symlinks as links instead of following them', () => {
    const byName = new Map(tools.listFolder(code).map(e => [e.name, e.type]));
    assert.equal(byName.get('notes.txt'), 'file');
    assert.equal(byName.get('nested'), 'dir');
    assert.equal(byName.get('link-out.txt'), 'link');
    assert.equal(byName.get('linkdir'), 'link');
    assert.equal(byName.get('dangling-out'), 'link');
  });
});

describe('findFiles', () => {
  it('skips symlinks, so it never walks into a symlinked folder or loops through one', () => {
    assert.deepEqual(tools.findFiles('secret'), []);
    assert.deepEqual(tools.findFiles('secret', code), []);
  });

  it('finds a nested file once, even though two mounted folders contain it', () => {
    const found = tools.findFiles('report');
    assert.deepEqual(found.map(f => f.path), [join(nested, 'deep', 'report.txt')]);
    assert.equal(found[0].relativePath, join('nested', 'deep', 'report.txt'));
  });

  it('still searches a nested mounted folder to its full depth', () => {
    const found = tools.findFiles('deepest');
    assert.deepEqual(found.map(f => f.path), [join(nested, 'a', 'b', 'c', 'd', 'e', 'f', 'deepest.txt')]);
  });

  it('reports files under a symlinked mounted folder by the path as mounted', () => {
    const found = tools.findFiles('alias-doc');
    assert.deepEqual(found.map(f => f.path), [join(alias, 'alias-doc.txt')]);
    assert.equal(found[0].relativePath, 'alias-doc.txt');
  });

  it('rejects a base path outside the mounted folders', () => {
    assert.throws(() => tools.findFiles('secret', join(base, 'Codebase')), denied);
    assert.throws(() => tools.findFiles('secret', join(code, 'linkdir')), denied);
  });
});

describe('isInsideMountedPath', () => {
  it('goes by where a path really leads', () => {
    assert.equal(tools.isInsideMountedPath(join(code, 'notes.txt')), true);
    assert.equal(tools.isInsideMountedPath(join(code, 'missing.txt')), true);
    assert.equal(tools.isInsideMountedPath(join(code, 'dangling-in')), true);
    assert.equal(tools.isInsideMountedPath(join(code, 'link-out.txt')), false);
    assert.equal(tools.isInsideMountedPath(join(code, 'dangling-out')), false);
    assert.equal(tools.isInsideMountedPath(join(code, 'linkdir', 'secret.txt')), false);
    assert.equal(tools.isInsideMountedPath(join(base, 'Code-private', 'secret.txt')), false);
  });
});
