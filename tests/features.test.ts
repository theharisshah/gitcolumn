import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApi, dispatch } from '../server/api.ts';
import { configureGit } from '../server/git.ts';
import type { Blame, Blob, Commit, FileCommit, LfsStatus, RebasePlan, Snapshot, Status, Submodule } from '../shared/types.ts';

const api = createApi({ electron: false });
const call = <T>(method: string, args: object = {}) => dispatch(api, method, args) as Promise<T>;
const tmpDirs: string[] = [];

function sh(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });
}

function newRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gitcolumn-feat-'));
  tmpDirs.push(dir);
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test User');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function commit(repo: string, file: string, content: string, message: string) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), content);
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', message);
}

after(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('file history and blame', () => {
  let repo: string;
  before(() => {
    repo = newRepo();
    commit(repo, 'old.txt', 'one\ntwo\n', 'Add file');
    commit(repo, 'old.txt', 'one\ntwo\nthree\n', 'Append three');
    sh(repo, 'mv', 'old.txt', 'new.txt');
    sh(repo, 'commit', '-q', '-m', 'Rename file');
    commit(repo, 'new.txt', 'ONE\ntwo\nthree\n', 'Shout one');
  });

  test('history follows renames', async () => {
    const h = await call<FileCommit[]>('file.history', { repo, path: 'new.txt' });
    assert.deepEqual(h.map((c) => c.subject), ['Shout one', 'Rename file', 'Append three', 'Add file']);
    const rename = h.find((c) => c.subject === 'Rename file')!;
    assert.equal(rename.status, 'R');
    assert.equal(rename.oldPath, 'old.txt');
    assert.equal(h[3].path, 'old.txt');
  });

  test('blame attributes lines and marks uncommitted ones', async () => {
    writeFileSync(path.join(repo, 'new.txt'), 'ONE\ntwo\nthree\nfour\n');
    const b = await call<Blame>('blame', { repo, path: 'new.txt' });
    assert.equal(b.lines.length, 4);
    const summary = (i: number) => b.commits[b.lines[i].hash];
    assert.equal(summary(0).summary, 'Shout one');
    assert.equal(summary(1).summary, 'Add file');
    assert.equal(summary(2).summary, 'Append three');
    assert.equal(summary(3).uncommitted, true);
    assert.equal(b.lines[1].content, 'two');
    assert.equal(summary(0).previous?.path, 'new.txt');

    const atCommit = await call<Blame>('blame', { repo, path: 'new.txt', rev: 'HEAD~1' });
    assert.equal(atCommit.lines[0].content, 'one');
    sh(repo, 'checkout', '--', 'new.txt');
  });

  test('blob reads images from revisions, the index and the working tree', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a6e6e7b40000000049454e44ae426082', 'hex');
    writeFileSync(path.join(repo, 'pixel.png'), png);
    sh(repo, 'add', 'pixel.png');
    sh(repo, 'commit', '-q', '-m', 'Add pixel');
    const fromHead = await call<Blob>('file.blob', { repo, path: 'pixel.png', revs: ['HEAD'] });
    assert.equal(fromHead.size, png.length);
    assert.ok(fromHead.dataUrl.startsWith('data:image/png;base64,'));
    assert.equal(Buffer.from(fromHead.dataUrl.split(',')[1], 'base64').compare(png), 0);
    const fallback = await call<Blob>('file.blob', { repo, path: 'pixel.png', revs: ['HEAD~5', ':', null] });
    assert.equal(fallback.size, png.length);
    assert.equal(await call('file.blob', { repo, path: 'missing.png', revs: ['HEAD', null] }), null);
  });
});

describe('interactive rebase', () => {
  let repo: string;
  let base: string;
  before(() => {
    repo = newRepo();
    commit(repo, 'a.txt', 'a\n', 'Base');
    base = sh(repo, 'rev-parse', 'HEAD').trim();
    commit(repo, 'b.txt', 'b\n', 'Add b');
    commit(repo, 'c.txt', 'c\n', 'Add c');
    commit(repo, 'c.txt', 'c fixed\n', 'Fix c');
    commit(repo, 'd.txt', 'd\n', 'Add d');
  });

  test('plan lists commits oldest first', async () => {
    const plan = await call<RebasePlan>('rebase.plan', { repo, base });
    assert.deepEqual(plan.commits.map((c) => c.subject), ['Add b', 'Add c', 'Fix c', 'Add d']);
    assert.equal(plan.hasMerges, false);
    assert.ok(plan.commits.every((c) => !c.pushed));
    await assert.rejects(call('rebase.plan', { repo, base: 'deadbeef' }), /not part of the current branch/);
  });

  test('reword, squash, drop and reorder', async () => {
    const plan = await call<RebasePlan>('rebase.plan', { repo, base });
    const [b, c, fix, d] = plan.commits;
    const res = await call<{ conflicts: boolean; paused: boolean }>('rebase.interactive', {
      repo,
      base,
      steps: [
        { action: 'pick', hash: d.hash },
        { action: 'reword', hash: c.hash, message: 'Add c (reworded)\n\nWith a body.' },
        { action: 'fixup', hash: fix.hash },
        { action: 'drop', hash: b.hash },
      ],
    });
    assert.deepEqual(res, { conflicts: false, paused: false });
    const log = await call<Commit[]>('log', { repo });
    assert.deepEqual(log.map((x) => x.subject), ['Add c (reworded)', 'Add d', 'Base']);
    assert.equal(readFileSync(path.join(repo, 'c.txt'), 'utf8'), 'c fixed\n');
    assert.ok(!existsSync(path.join(repo, 'b.txt')));
    assert.match(sh(repo, 'log', '-1', '--format=%B'), /With a body\./);
  });

  test('edit pauses the rebase and squash cannot come first', async () => {
    const plan = await call<RebasePlan>('rebase.plan', { repo, base });
    await assert.rejects(
      call('rebase.interactive', { repo, base, steps: plan.commits.map((c, i) => ({ action: i === 0 ? 'squash' : 'pick', hash: c.hash })) }),
      /first commit/,
    );
    const res = await call<{ paused: boolean }>('rebase.interactive', {
      repo,
      base,
      steps: plan.commits.map((c, i) => ({ action: i === 0 ? 'edit' : 'pick', hash: c.hash })),
    });
    assert.equal(res.paused, true);
    assert.equal((await call<Status>('status', { repo })).state.rebasing, true);
    await call('op.continue', { repo });
    assert.equal((await call<Status>('status', { repo })).state.rebasing, false);
  });
});

describe('snapshots (undo)', () => {
  test('restores index and working tree files exactly', async () => {
    const repo = newRepo();
    commit(repo, 'f.txt', 'committed\n', 'Init');
    writeFileSync(path.join(repo, 'f.txt'), 'staged\n');
    sh(repo, 'add', 'f.txt');
    writeFileSync(path.join(repo, 'f.txt'), 'worktree\n');
    writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    const snap = await call<Snapshot>('snapshot.capture', { repo, paths: ['f.txt', 'new.txt', 'gone.txt'] });
    assert.ok(snap.index && snap.head);
    assert.equal(snap.branch, 'main');
    assert.equal(snap.files?.find((f) => f.path === 'gone.txt')?.blob, null);

    await call('discard', {
      repo,
      files: [
        { path: 'f.txt', index: 'M', worktree: 'M' },
        { path: 'new.txt', index: '.', worktree: '?', untracked: true },
      ],
    });
    writeFileSync(path.join(repo, 'gone.txt'), 'created later\n');
    assert.equal(readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'committed\n');

    await call('snapshot.restore', { repo, snapshot: snap });
    assert.equal(readFileSync(path.join(repo, 'f.txt'), 'utf8'), 'worktree\n');
    assert.equal(readFileSync(path.join(repo, 'new.txt'), 'utf8'), 'untracked\n');
    assert.ok(!existsSync(path.join(repo, 'gone.txt')));
    assert.equal(sh(repo, 'show', ':f.txt'), 'staged\n');
  });

  test('ref helpers restore deleted branches and annotated tags', async () => {
    const repo = newRepo();
    commit(repo, 'f.txt', 'x\n', 'Init');
    sh(repo, 'tag', '-a', 'v1', '-m', 'Version 1');
    const tagObj = await call<string>('rev.parse', { repo, rev: 'refs/tags/v1' });
    sh(repo, 'tag', '-d', 'v1');
    await call('ref.update', { repo, ref: 'refs/tags/v1', hash: tagObj });
    assert.equal(sh(repo, 'cat-file', '-t', 'v1').trim(), 'tag');
    await assert.rejects(call('ref.update', { repo, ref: 'HEAD', hash: tagObj }), /Invalid ref/);
  });
});

describe('submodules and LFS', () => {
  test('lists, initializes and reports submodule state', async () => {
    // Local file:// submodules are blocked by default since git 2.38.1.
    configureGit({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' });
    const lib = newRepo();
    commit(lib, 'lib.txt', 'lib\n', 'Lib init');
    const repo = newRepo();
    commit(repo, 'app.txt', 'app\n', 'App init');
    await call('submodule.add', { repo, url: lib, path: 'vendor/lib' });
    sh(repo, 'commit', '-q', '-m', 'Add submodule');
    let subs = await call<Submodule[]>('submodules', { repo });
    assert.equal(subs.length, 1);
    assert.equal(subs[0].path, 'vendor/lib');
    assert.equal(subs[0].url, lib);
    assert.equal(subs[0].state, 'ok');

    rmSync(path.join(repo, 'vendor/lib'), { recursive: true, force: true });
    sh(repo, 'submodule', 'deinit', '-q', '-f', 'vendor/lib');
    subs = await call<Submodule[]>('submodules', { repo });
    assert.equal(subs[0].state, 'uninitialized');
    await call('submodule.update', { repo, path: 'vendor/lib' });
    subs = await call<Submodule[]>('submodules', { repo });
    assert.equal(subs[0].state, 'ok');
    assert.ok(existsSync(path.join(repo, 'vendor/lib/lib.txt')));
  });

  test('LFS status reads patterns even without git-lfs installed', async () => {
    const repo = newRepo();
    writeFileSync(path.join(repo, '.gitattributes'), '*.psd filter=lfs diff=lfs merge=lfs -text\n# comment\n*.txt text\nassets/** filter=lfs -text\n');
    const s = await call<LfsStatus>('lfs.status', { repo });
    assert.deepEqual(s.patterns, ['*.psd', 'assets/**']);
    assert.equal(typeof s.installed, 'boolean');
  });
});
