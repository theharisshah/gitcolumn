import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { createApi, dispatch } from '../server/api.ts';
import { appendPatterns, escapeIgnore, ignoreSuggestions } from '../server/ignore.ts';
import type { Snapshot, UndoSpec } from '../shared/types.ts';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe('ignore patterns', () => {
  test('escapes special characters and anchors exact paths', () => {
    assert.equal(escapeIgnore('a*b?[c].txt'), 'a\\*b\\?\\[c\\].txt');
    assert.equal(escapeIgnore('#notes'), '\\#notes');
    assert.equal(escapeIgnore('!important'), '\\!important');
    assert.equal(escapeIgnore('trailing  '), 'trailing\\ \\ ');
    assert.deepEqual(ignoreSuggestions('build/out/app.log', false), [
      { pattern: '/build/out/app.log', label: 'This file (build/out/app.log)' },
      { pattern: '*.log', label: 'All .log files' },
      { pattern: '/build/out/', label: 'The folder build/out/' },
    ]);
    assert.deepEqual(ignoreSuggestions('dist', true), [{ pattern: '/dist/', label: 'This folder (dist/)' }]);
    assert.deepEqual(ignoreSuggestions('.env', false).map((s) => s.pattern), ['/.env'], 'dotfiles have no extension suggestion');
  });

  test('appends only new patterns and keeps line endings', () => {
    assert.equal(appendPatterns('', ['*.log']), '*.log\n');
    assert.equal(appendPatterns('node_modules', ['*.log']), 'node_modules\n*.log\n');
    assert.equal(appendPatterns('a\r\nb\r\n', ['c']), 'a\r\nb\r\nc\r\n');
    assert.equal(appendPatterns('*.log\n', ['*.log', ' *.log ']), '*.log\n');
    assert.equal(appendPatterns('', ['/name\\ ']), '/name\\ \n', 'an escaped trailing space is kept');
    assert.equal(appendPatterns('*.log\n!keep.log\n', ['*.log']), '*.log\n!keep.log\n*.log\n', 'a later negation makes it worth adding again');
  });
});

describe('ignore handlers', () => {
  let repo: string;
  let call: <T = unknown>(method: string, args?: object) => Promise<T>;
  beforeEach(() => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gitcolumn-ignore-'));
    roots.push(root);
    repo = path.join(root, 'repo');
    mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.name', 'T');
    sh(repo, 'config', 'user.email', 't@example.com');
    writeFileSync(path.join(repo, 'tracked.log'), 'x\n');
    writeFileSync(path.join(repo, 'keep.txt'), 'k\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'init');
    const api = createApi({ electron: false });
    call = <T,>(method: string, args: object = {}) => dispatch(api, method, { repo, ...args }) as Promise<T>;
  });

  test('info reports tracked state and suggestions', async () => {
    writeFileSync(path.join(repo, 'new.tmp'), 't\n');
    mkdirSync(path.join(repo, 'cache'));
    assert.equal((await call<{ tracked: boolean }>('ignore.info', { path: 'tracked.log' })).tracked, true);
    const untracked = await call<{ tracked: boolean; isDir: boolean }>('ignore.info', { path: 'new.tmp' });
    assert.deepEqual([untracked.tracked, untracked.isDir], [false, false]);
    assert.equal((await call<{ isDir: boolean }>('ignore.info', { path: 'cache' })).isDir, true);
  });

  test('adds to .gitignore, untracks while keeping the file, and is undoable', async () => {
    const before = await call<Snapshot>('snapshot.capture');
    const r = await call<{ file: 'gitignore'; before: string | null; after: string }>('ignore.add', { patterns: ['*.log'], target: 'gitignore', untrack: ['tracked.log'] });
    assert.equal(r.before, null);
    assert.equal(readFileSync(path.join(repo, '.gitignore'), 'utf8'), '*.log\n');
    assert.ok(existsSync(path.join(repo, 'tracked.log')), 'file kept on disk');
    assert.equal(sh(repo, 'ls-files', 'tracked.log'), '');
    writeFileSync(path.join(repo, 'other.log'), 'o\n');
    assert.equal(sh(repo, 'check-ignore', 'other.log'), 'other.log');

    const spec: UndoSpec = { kind: 'ignore', file: r.file, before: r.before, after: r.after, index: before.index, head: before.head };
    await call('undo.push', { label: 'Ignore', spec });
    await dispatch(createApi({ electron: false }), 'undo.run', { repo });
    assert.ok(!existsSync(path.join(repo, '.gitignore')), 'a .gitignore created by the ignore is removed again');
    assert.equal(sh(repo, 'ls-files', 'tracked.log'), 'tracked.log', 'tracked again');
  });

  test('undo refuses when the ignore file was edited since', async () => {
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n');
    const before = await call<Snapshot>('snapshot.capture');
    const r = await call<{ file: 'gitignore'; before: string | null; after: string }>('ignore.add', { patterns: ['/keep.txt'], target: 'gitignore' });
    assert.equal(r.after, 'node_modules\n/keep.txt\n');
    await call('undo.push', { label: 'Ignore', spec: { kind: 'ignore', file: r.file, before: r.before, after: r.after, head: before.head } });
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n/keep.txt\ndist/\n');
    await assert.rejects(call('undo.run'), /.gitignore was changed since then/);
    writeFileSync(path.join(repo, '.gitignore'), r.after);
    await call('undo.run');
    assert.equal(readFileSync(path.join(repo, '.gitignore'), 'utf8'), 'node_modules\n');
  });

  test('info/exclude goes to the common git dir, also from a linked worktree', async () => {
    const wt = path.join(path.dirname(repo), 'wt');
    sh(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
    const api = createApi({ electron: false });
    await dispatch(api, 'ignore.add', { repo: wt, patterns: ['*.secret'], target: 'exclude' });
    assert.match(readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\*\.secret$/m);
    writeFileSync(path.join(repo, 'x.secret'), 's\n');
    assert.equal(sh(repo, 'check-ignore', 'x.secret'), 'x.secret');
  });

  test('refuses to rewrite a .gitignore that is not UTF-8', async () => {
    writeFileSync(path.join(repo, '.gitignore'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await assert.rejects(call('ignore.add', { patterns: ['*.log'], target: 'gitignore' }), /isn't UTF-8/);
    assert.deepEqual([...readFileSync(path.join(repo, '.gitignore'))], [0x63, 0x61, 0x66, 0xe9, 0x0a]);
  });

  test('undo writes through a symlinked info/exclude and keeps the link', async () => {
    const real = path.join(path.dirname(repo), 'shared-exclude');
    writeFileSync(real, '# shared\n');
    rmSync(path.join(repo, '.git', 'info', 'exclude'), { force: true });
    mkdirSync(path.join(repo, '.git', 'info'), { recursive: true });
    symlinkSync(real, path.join(repo, '.git', 'info', 'exclude'));
    const before = await call<Snapshot>('snapshot.capture');
    const r = await call<{ file: 'exclude'; before: string | null; after: string }>('ignore.add', { patterns: ['*.tmp'], target: 'exclude' });
    await call('undo.push', { label: 'Ignore', spec: { kind: 'ignore', file: r.file, before: r.before, after: r.after, head: before.head } });
    await call('undo.run');
    assert.ok(lstatSync(path.join(repo, '.git', 'info', 'exclude')).isSymbolicLink());
    assert.equal(readFileSync(real, 'utf8'), '# shared\n');
  });

  test('rejects multi-line patterns and paths outside the repository', async () => {
    await assert.rejects(call('ignore.add', { patterns: ['a\nb'], target: 'gitignore' }), /Invalid ignore pattern/);
    await assert.rejects(call('ignore.add', { patterns: ['x'], target: 'gitignore', untrack: ['../etc/passwd'] }), /outside the repository/);
    await assert.rejects(call('ignore.add', { patterns: ['x'], target: 'elsewhere' }), /Unknown ignore file/);
  });
});
