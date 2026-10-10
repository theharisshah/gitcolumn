import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApi, dispatch } from '../server/api';
import type { CommitDetail, FileDiff, Ref, Stash, Status } from '../shared/types';

const api = createApi({ electron: false });
const call = <T>(method: string, args: object = {}) => dispatch(api, method, args) as Promise<T>;

function sh(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });
}

function newRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gitcolumn-test-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test User');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

const lines = (n: number, f = (i: number) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

describe('backend', () => {
  let repo: string;
  before(() => {
    repo = newRepo();
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  test('empty repo: status and log', async () => {
    const s = await call<Status>('status', { repo });
    assert.equal(s.head, null);
    assert.equal(s.branch, 'main');
    assert.deepEqual(await call('log', { repo }), []);
  });

  test('status parses untracked, staged, renamed and paths with spaces', async () => {
    writeFileSync(path.join(repo, 'a.txt'), lines(20));
    writeFileSync(path.join(repo, 'b c.txt'), 'hello\n');
    writeFileSync(path.join(repo, 'ünïcode.md'), 'x\n');
    let s = await call<Status>('status', { repo });
    assert.deepEqual(s.files.map((f) => f.path).sort(), ['a.txt', 'b c.txt', 'ünïcode.md']);
    assert.ok(s.files.every((f) => f.untracked));

    await call('stageAll', { repo });
    await call('commit', { repo, message: 'Initial commit\n\nWith a body.' });
    sh(repo, 'mv', 'b c.txt', 'renamed file.txt');
    s = await call<Status>('status', { repo });
    const r = s.files.find((f) => f.index === 'R');
    assert.ok(r);
    assert.equal(r.path, 'renamed file.txt');
    assert.equal(r.origPath, 'b c.txt');
    await call('commit', { repo, message: 'Rename' });
  });

  test('stage, unstage and discard selected lines', async () => {
    const file = path.join(repo, 'a.txt');
    const modified = lines(20, (i) => (i === 2 ? 'CHANGED 2' : i === 15 ? 'CHANGED 15' : `line ${i}`));
    writeFileSync(file, modified);
    const status = await call<Status>('status', { repo });
    const fs = status.files.find((f) => f.path === 'a.txt')!;
    const diff = (await call<FileDiff>('diff.working', { repo, file: fs, staged: false }))!;
    assert.equal(diff.hunks.length, 2);

    // Stage only the "+CHANGED 2" line of the first hunk (keep "-line 2" as context → pure insertion).
    const h0 = diff.hunks[0];
    const addIdx = h0.lines.findIndex((l) => l.type === 'add');
    await call('patch.apply', { repo, diff, selection: { 0: [addIdx] }, action: 'stage' });
    let cached = sh(repo, 'diff', '--cached');
    assert.match(cached, /^\+CHANGED 2$/m);
    assert.doesNotMatch(cached, /^-line 2$/m);
    assert.doesNotMatch(cached, /CHANGED 15/);

    // Stage the whole second hunk.
    await call('patch.apply', { repo, diff, selection: { 1: 'all' }, action: 'stage' });
    cached = sh(repo, 'diff', '--cached');
    assert.match(cached, /^\+CHANGED 15$/m);
    assert.match(cached, /^-line 15$/m);

    // Unstage the second hunk again.
    const stagedFs = (await call<Status>('status', { repo })).files.find((f) => f.path === 'a.txt')!;
    const stagedDiff = (await call<FileDiff>('diff.working', { repo, file: stagedFs, staged: true }))!;
    const hi = stagedDiff.hunks.findIndex((h) => h.lines.some((l) => l.content === 'CHANGED 15'));
    await call('patch.apply', { repo, diff: stagedDiff, selection: { [hi]: 'all' }, action: 'unstage' });
    cached = sh(repo, 'diff', '--cached');
    assert.doesNotMatch(cached, /CHANGED 15/);
    assert.match(cached, /CHANGED 2/);

    // Discard the "CHANGED 15" lines from the working tree.
    const wtDiff = (await call<FileDiff>('diff.working', { repo, file: stagedFs, staged: false }))!;
    const wi = wtDiff.hunks.findIndex((h) => h.lines.some((l) => l.content === 'CHANGED 15'));
    await call('patch.apply', { repo, diff: wtDiff, selection: { [wi]: 'all' }, action: 'discard' });
    const content = readFileSync(file, 'utf8');
    assert.match(content, /^line 15$/m);
    assert.match(content, /^CHANGED 2$/m);

    await call('commit', { repo, message: 'Partial change' });
    assert.equal(sh(repo, 'status', '--porcelain'), ' M a.txt\n');
    await call('discard', { repo, files: [{ path: 'a.txt', index: '.', worktree: 'M' }] });
    assert.equal(sh(repo, 'status', '--porcelain'), '');
  });

  test('discard removes untracked and newly added files', async () => {
    writeFileSync(path.join(repo, 'junk.txt'), 'junk\n');
    writeFileSync(path.join(repo, 'added.txt'), 'added\n');
    sh(repo, 'add', 'added.txt');
    await call('discard', {
      repo,
      files: [
        { path: 'junk.txt', index: '.', worktree: '?', untracked: true },
        { path: 'added.txt', index: 'A', worktree: '.' },
      ],
    });
    assert.ok(!existsSync(path.join(repo, 'junk.txt')));
    assert.ok(!existsSync(path.join(repo, 'added.txt')));
    assert.equal(sh(repo, 'status', '--porcelain'), '');
  });

  test('log, refs and commit detail', async () => {
    const log = await call<{ hash: string; subject: string; parents: string[] }[]>('log', { repo });
    assert.deepEqual(log.map((c) => c.subject), ['Partial change', 'Rename', 'Initial commit']);
    const detail = await call<CommitDetail>('commit.detail', { repo, hash: log[1].hash });
    assert.equal(detail.files.length, 1);
    assert.equal(detail.files[0].status, 'R');
    assert.equal(detail.files[0].origPath, 'b c.txt');
    const root = await call<CommitDetail>('commit.detail', { repo, hash: log[2].hash });
    assert.equal(root.body, 'With a body.');
    assert.equal(root.files.length, 3);
    assert.equal(root.files.find((f) => f.path === 'a.txt')?.additions, 20);
    const diffs = await call<FileDiff[]>('commit.diff', { repo, hash: log[2].hash });
    assert.equal(diffs.length, 3);
    assert.ok(diffs.every((d) => d.isNew));

    await call('branch.create', { repo, name: 'feature/x', checkout: false });
    await call('tag.create', { repo, name: 'v1.0', message: 'Release 1.0' });
    const refs = await call<Ref[]>('refs', { repo });
    assert.ok(refs.find((r) => r.name === 'main' && r.current));
    assert.ok(refs.find((r) => r.name === 'feature/x' && r.type === 'head'));
    const tag = refs.find((r) => r.type === 'tag' && r.name === 'v1.0');
    assert.equal(tag?.hash, log[0].hash, 'annotated tag is peeled to its commit');
  });

  test('merge conflicts are reported and can be resolved', async () => {
    await call('checkout', { repo, branch: 'feature/x' });
    writeFileSync(path.join(repo, 'a.txt'), lines(20, (i) => (i === 1 ? 'feature' : `line ${i}`)));
    await call('stageAll', { repo });
    await call('commit', { repo, message: 'Feature change' });
    await call('checkout', { repo, branch: 'main' });
    writeFileSync(path.join(repo, 'a.txt'), lines(20, (i) => (i === 1 ? 'main' : `line ${i}`)));
    await call('stageAll', { repo });
    await call('commit', { repo, message: 'Main change' });

    const res = await call<{ conflicts: boolean }>('merge', { repo, ref: 'feature/x' });
    assert.equal(res.conflicts, true);
    let s = await call<Status>('status', { repo });
    assert.equal(s.state.merging, true);
    assert.match(s.state.message ?? '', /Merge branch 'feature\/x'/);
    const c = s.files.find((f) => f.conflicted)!;
    assert.equal(c.conflictType, 'UU');
    await call('conflict.resolve', { repo, path: c.path, side: 'theirs', conflictType: c.conflictType });
    await call('op.continue', { repo });
    s = await call<Status>('status', { repo });
    assert.equal(s.state.merging, false);
    assert.match(readFileSync(path.join(repo, 'a.txt'), 'utf8'), /^feature$/m);
    const log = await call<{ hash: string; parents: string[] }[]>('log', { repo, limit: 1 });
    assert.equal(log[0].parents.length, 2);
    const merge = await call<CommitDetail>('commit.detail', { repo, hash: log[0].hash });
    assert.doesNotMatch(merge.body, /#/, 'conflict comment lines are stripped from the merge message');
  });

  test('stash save, list, diff, pop', async () => {
    writeFileSync(path.join(repo, 'a.txt'), 'stashed\n');
    writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    await call('stash.save', { repo, message: 'WIP thing', includeUntracked: true });
    assert.equal(sh(repo, 'status', '--porcelain'), '');
    const stashes = await call<Stash[]>('stash.list', { repo });
    assert.equal(stashes.length, 1);
    assert.match(stashes[0].message, /WIP thing/);
    const diffs = await call<FileDiff[]>('stash.diff', { repo, ref: stashes[0].ref });
    assert.deepEqual(diffs.map((d) => d.newPath).sort(), ['a.txt', 'new.txt']);
    await call('stash.apply', { repo, ref: stashes[0].ref, pop: true });
    assert.equal((await call<Stash[]>('stash.list', { repo })).length, 0);
    assert.ok(existsSync(path.join(repo, 'new.txt')));
  });

  test('rejects option injection and paths outside the repo', async () => {
    await assert.rejects(call('checkout', { repo, branch: '--orphan' }), /Invalid name/);
    await assert.rejects(call('file.read', { repo, path: '../../etc/passwd' }), /outside the repository/);
    await assert.rejects(call('status', { repo: 'relative/path' }), /not found/);
    await assert.rejects(call('nope', {}), /Unknown method/);
  });
});
