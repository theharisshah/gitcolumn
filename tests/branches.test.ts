import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { createApi, dispatch } from '../server/api.ts';
import type { BranchReviewRow, Commit, FileDiff, Ref, UndoSpec, Worktree } from '../shared/types.ts';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } }).trim();
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe('branches', () => {
  let root: string;
  let repo: string;
  let call: <T = unknown>(method: string, args?: object) => Promise<T>;
  const write = (f: string, c: string) => writeFileSync(path.join(repo, f), c);
  const commitFile = (f: string, c: string, msg: string) => {
    write(f, c);
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', msg);
    return sh(repo, 'rev-parse', 'HEAD');
  };
  const at = (rev: string) => sh(repo, 'rev-parse', rev);

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'gitcolumn-branches-'));
    roots.push(root);
    repo = path.join(root, 'repo');
    mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.name', 'T');
    sh(repo, 'config', 'user.email', 't@example.com');
    commitFile('a.txt', '1\n', 'base');
    const api = createApi({ electron: false });
    call = <T,>(method: string, args: object = {}) => dispatch(api, method, { repo, ...args }) as Promise<T>;
  });

  test('default base: origin/HEAD, then main/master, then init.defaultBranch', async () => {
    assert.equal(await call('branches.defaultBase'), 'main');
    const bare = path.join(root, 'origin.git');
    sh(root, 'init', '-q', '--bare', '-b', 'trunk', bare);
    sh(repo, 'remote', 'add', 'origin', bare);
    sh(repo, 'push', '-q', 'origin', 'main:trunk');
    sh(repo, 'fetch', '-q', 'origin');
    sh(repo, 'remote', 'set-head', 'origin', 'trunk');
    assert.equal(await call('branches.defaultBase'), 'origin/trunk');
  });

  test('review: ahead/behind, merged, gone upstream, flags and validation', async () => {
    sh(repo, 'branch', 'merged-one');
    sh(repo, 'switch', '-q', '-c', 'feature');
    commitFile('f.txt', 'f\n', 'feature 1');
    commitFile('f.txt', 'f2\n', 'feature 2');
    sh(repo, 'switch', '-q', 'main');
    commitFile('m.txt', 'm\n', 'main moves on');
    sh(repo, 'remote', 'add', 'origin', path.join(root, 'nowhere.git'));
    sh(repo, 'config', 'branch.feature.remote', 'origin');
    sh(repo, 'config', 'branch.feature.merge', 'refs/heads/feature');
    sh(repo, 'update-ref', 'refs/remotes/origin/other', at('main'));
    await call('branch.setFlag', { branch: 'feature', flag: 'pinned', value: true });
    const rows = await call<BranchReviewRow[]>('branches.review', { base: 'main' });
    const row = (n: string) => rows.find((r) => r.name === n)!;
    assert.deepEqual([row('feature').ahead, row('feature').behind, row('feature').merged], [2, 1, false]);
    assert.deepEqual([row('merged-one').ahead, row('merged-one').behind, row('merged-one').merged], [0, 1, true]);
    assert.equal(row('main').current, true);
    assert.equal(row('feature').pinned, true);
    assert.equal(row('feature').gone, true, 'upstream origin/feature does not exist');
    assert.ok(!rows.some((r) => r.type === 'remote'));
    const withRemote = await call<BranchReviewRow[]>('branches.review', { base: 'main', includeRemote: true });
    assert.ok(withRemote.some((r) => r.name === 'origin/other' && r.merged));
    await assert.rejects(call('branches.review', { base: 'nope' }), /Unknown base/);
  });

  test('delete many in one transaction, refusing current/pinned/base, undoable with settings', async () => {
    sh(repo, 'branch', 'old-1');
    sh(repo, 'branch', 'old-2');
    sh(repo, 'branch', 'keep');
    sh(repo, 'config', 'branch.old-1.remote', 'origin');
    await call('branch.setFlag', { branch: 'keep', flag: 'pinned', value: true });
    const head = at('HEAD');
    await assert.rejects(call('branches.deleteMany', { branches: [{ name: 'main', hash: head }] }), /checked out/);
    await assert.rejects(call('branches.deleteMany', { branches: [{ name: 'keep', hash: head }] }), /pinned/);
    await assert.rejects(call('branches.deleteMany', { branches: [{ name: 'old-1', hash: head }], base: 'old-1' }), /base branch/);
    await assert.rejects(
      call('branches.deleteMany', { branches: [{ name: 'old-1', hash: head }, { name: 'old-2', hash: '0'.repeat(40) }] }),
      /nothing was deleted/,
    );
    assert.equal(sh(repo, 'branch', '--list', 'old-1', '--format=%(refname:short)'), 'old-1', 'all or nothing');

    const { deleted } = await call<{ deleted: { name: string; hash: string; config: [string, string][] }[] }>('branches.deleteMany', {
      branches: [{ name: 'old-1', hash: head }, { name: 'old-2', hash: head }],
    });
    assert.equal(sh(repo, 'branch', '--list', 'old-*'), '');
    const spec: UndoSpec = {
      kind: 'refs',
      updates: deleted.map((d) => ({ ref: `refs/heads/${d.name}`, old: null, new: d.hash })),
      config: deleted.flatMap((d) => d.config),
    };
    await call('undo.push', { label: 'Delete Branches', spec });
    await call('undo.run');
    assert.equal(sh(repo, 'branch', '--list', 'old-*', '--format=%(refname:short)'), 'old-1\nold-2');
    assert.equal(sh(repo, 'config', 'branch.old-1.remote'), 'origin');
  });

  test('pinned/archived/parent flags and other worktrees show on refs', async () => {
    sh(repo, 'branch', 'a');
    sh(repo, 'branch', 'b');
    await call('branch.setFlag', { branch: 'a', flag: 'archived', value: true });
    await call('branch.setParent', { branch: 'b', parent: 'main' });
    const wt = path.join(root, 'wt');
    await call('worktree.add', { path: wt, branch: 'b' });
    const refs = await call<Ref[]>('refs');
    const ref = (n: string) => refs.find((r) => r.type === 'head' && r.name === n)!;
    assert.equal(ref('a').archived, true);
    assert.equal(ref('b').parent, 'main');
    assert.ok(ref('b').worktree?.endsWith('wt'));
    await call('branch.setFlag', { branch: 'a', flag: 'archived', value: false });
    assert.equal((await call<Ref[]>('refs')).find((r) => r.name === 'a')!.archived, undefined);

    const list = await call<Worktree[]>('worktree.list');
    assert.equal(list.length, 2);
    assert.ok(list.find((w) => w.current)!.branch === 'main');
    await call('worktree.remove', { path: wt });
    assert.equal((await call<Worktree[]>('worktree.list')).length, 1);
  });

  test('push to a differently named remote branch; rebase --onto', async () => {
    const bare = path.join(root, 'remote.git');
    sh(root, 'init', '-q', '--bare', bare);
    sh(repo, 'remote', 'add', 'origin', bare);
    await call('push', { branch: 'main', remote: 'origin', remoteBranch: 'release/x' });
    assert.equal(sh(bare, 'rev-parse', 'refs/heads/release/x'), at('main'));
    assert.throws(() => sh(repo, 'config', 'branch.main.merge'), 'pushing elsewhere does not change the upstream');

    const base = at('main');
    sh(repo, 'switch', '-q', '-c', 'topic');
    commitFile('t.txt', '1\n', 'topic 1');
    sh(repo, 'switch', '-q', '-c', 'onto', base);
    commitFile('o.txt', 'o\n', 'other line');
    sh(repo, 'switch', '-q', 'topic');
    await call('rebase', { onto: 'onto', upstream: base });
    assert.equal(at('topic~1'), at('onto'));
  });

  test('stacked branches: create, restack after the parent was amended, children, undo', async () => {
    sh(repo, 'switch', '-q', '-c', 'p');
    commitFile('p.txt', 'p1\n', 'parent work');
    await call('branch.createStacked', { name: 'c1', parent: 'p' });
    commitFile('c1.txt', 'c1\n', 'child 1 work');
    await call('branch.createStacked', { name: 'c2', parent: 'c1' });
    commitFile('c2.txt', 'c2\n', 'child 2 work');
    await assert.rejects(call('branch.setParent', { branch: 'p', parent: 'c2' }), /loop/);

    // The parent gets amended: its old commit is no longer on it.
    sh(repo, 'switch', '-q', 'p');
    write('p.txt', 'p1 amended\n');
    sh(repo, 'commit', '-q', '-a', '--amend', '-m', 'parent work (amended)');
    sh(repo, 'switch', '-q', 'c2');
    const before = { c1: at('c1'), c2: at('c2') };

    const r = await call<{ moved: { name: string; old: string; new: string; oldBase: string | null }[]; conflicts: boolean; original: string }>('branch.restack', {
      branch: 'c1',
      children: true,
    });
    assert.equal(r.conflicts, false);
    assert.deepEqual(r.moved.map((m) => m.name), ['c1', 'c2']);
    assert.equal(at('c1~1'), at('p'), 'c1 now sits on the amended parent');
    assert.equal(sh(repo, 'log', '--format=%s', 'p..c1'), 'child 1 work', 'only its own commit was replayed');
    assert.equal(at('c2~1'), at('c1'));
    assert.equal(sh(repo, 'symbolic-ref', '--short', 'HEAD'), 'c2', 'back on the original branch');
    assert.equal(sh(repo, 'config', 'branch.c1.gitcolumn-parent-base'), at('p'));

    // Undo as the app records it: other branches by compare-and-swap, the checked-out one by reset.
    const steps: UndoSpec[] = [];
    const others = r.moved.filter((m) => m.name !== r.original);
    if (others.length) {
      steps.push({
        kind: 'refs',
        updates: others.map((m) => ({ ref: `refs/heads/${m.name}`, old: m.new, new: m.old })),
        config: r.moved.map((m): [string, string | null] => [`branch.${m.name}.gitcolumn-parent-base`, m.oldBase]),
      });
    }
    const self = r.moved.find((m) => m.name === r.original);
    if (self) steps.push({ kind: 'head-reset', from: self.new, to: self.old, mode: 'keep', branch: r.original });
    await call('undo.push', { label: 'Restack', spec: { kind: 'multi', steps } });
    await call('undo.run');
    assert.deepEqual({ c1: at('c1'), c2: at('c2') }, before);
  });

  test('restack stops at a conflict', async () => {
    sh(repo, 'switch', '-q', '-c', 'p');
    commitFile('x.txt', 'p\n', 'p');
    await call('branch.createStacked', { name: 'c', parent: 'p' });
    commitFile('x.txt', 'c\n', 'c changes x');
    sh(repo, 'switch', '-q', 'p');
    write('x.txt', 'p amended\n');
    sh(repo, 'commit', '-q', '-a', '--amend', '-m', 'p amended');
    const r = await call<{ conflicts: boolean; stoppedAt: string }>('branch.restack', { branch: 'c' });
    assert.deepEqual([r.conflicts, r.stoppedAt], [true, 'c']);
    sh(repo, 'rebase', '--abort');
  });

  test('restack from a detached HEAD returns there; a branch checked out elsewhere blocks the undo', async () => {
    sh(repo, 'switch', '-q', '-c', 'p');
    commitFile('p.txt', 'p1\n', 'p');
    await call('branch.createStacked', { name: 'c', parent: 'p' });
    commitFile('c.txt', 'c\n', 'c');
    sh(repo, 'switch', '-q', 'p');
    commitFile('p.txt', 'p2\n', 'p more');
    const detachedAt = at('main');
    sh(repo, 'switch', '-q', '--detach', 'main');
    const r = await call<{ moved: { name: string; old: string; new: string; oldBase: string | null }[]; original: string | null }>('branch.restack', { branch: 'c' });
    assert.equal(r.original, null);
    assert.equal(at('HEAD'), detachedAt);
    assert.throws(() => sh(repo, 'symbolic-ref', '-q', 'HEAD'), 'still detached');
    const spec: UndoSpec = {
      kind: 'multi',
      steps: [{ kind: 'refs', updates: r.moved.map((m) => ({ ref: `refs/heads/${m.name}`, old: m.new, new: m.old })), config: [] }],
    };
    await call('undo.push', { label: 'Restack', spec });
    sh(repo, 'switch', '-q', 'c'); // now it's checked out: the undo must not move it under the working tree
    await assert.rejects(call('undo.run'), /checked out/);
    assert.equal(at('c'), r.moved[0].new);
    sh(repo, 'switch', '-q', 'main');
    await call('undo.run');
    assert.equal(at('c'), r.moved[0].old);
  });

  test('a restack finished after a conflict records the new base', async () => {
    sh(repo, 'switch', '-q', '-c', 'p');
    commitFile('x.txt', 'p\n', 'p');
    await call('branch.createStacked', { name: 'c', parent: 'p' });
    commitFile('x.txt', 'c\n', 'c changes x');
    sh(repo, 'switch', '-q', 'p');
    write('x.txt', 'p amended\n');
    sh(repo, 'commit', '-q', '-a', '--amend', '-m', 'p amended');
    const r = await call<{ conflicts: boolean }>('branch.restack', { branch: 'c' });
    assert.equal(r.conflicts, true);
    write('x.txt', 'resolved\n');
    sh(repo, 'add', 'x.txt');
    execFileSync('git', ['-c', 'core.editor=true', 'rebase', '--continue'], { cwd: repo });
    // Next restack: nothing to replay, and the base is the amended parent.
    const again = await call<{ moved: unknown[]; conflicts: boolean }>('branch.restack', { branch: 'c' });
    assert.deepEqual([again.moved.length, again.conflicts], [0, false]);
    assert.equal(sh(repo, 'config', 'branch.c.gitcolumn-parent-base'), at('p'));
  });

  test('renaming a parent keeps its children stacked on it; re-saving the same parent keeps the base', async () => {
    sh(repo, 'branch', 'p');
    await call('branch.createStacked', { name: 'c', parent: 'p', checkout: false });
    const base = sh(repo, 'config', 'branch.c.gitcolumn-parent-base');
    await call('branch.rename', { oldName: 'p', newName: 'parent' });
    assert.equal(sh(repo, 'config', 'branch.c.gitcolumn-parent'), 'parent');
    await call('branch.setParent', { branch: 'c', parent: 'parent' });
    assert.equal(sh(repo, 'config', 'branch.c.gitcolumn-parent-base'), base);
  });

  test('review details: base beats a same-named tag; local twin of a remote base is protected; settings of v1 ≠ v1.2', async () => {
    sh(repo, 'branch', 'side');
    commitFile('m.txt', 'm\n', 'main moves');
    sh(repo, 'tag', 'side', 'HEAD'); // a tag named like the base branch, pointing elsewhere
    const rows = await call<BranchReviewRow[]>('branches.review', { base: 'side' });
    assert.equal(rows.find((r) => r.name === 'main')!.ahead, 1, 'compared with the branch, not the tag');
    sh(repo, 'tag', '-d', 'side');

    sh(repo, 'update-ref', 'refs/remotes/origin/main', at('main'));
    sh(repo, 'switch', '-q', 'side');
    await assert.rejects(call('branches.deleteMany', { branches: [{ name: 'main', hash: at('main') }], base: 'origin/main' }), /base branch/);

    sh(repo, 'branch', 'v1');
    sh(repo, 'branch', 'v1.2');
    sh(repo, 'config', 'branch.v1.remote', 'origin');
    sh(repo, 'config', 'branch.v1.2.remote', 'fork');
    const entries = await call<[string, string][]>('config.branchEntries', { branch: 'v1' });
    assert.deepEqual(entries, [['branch.v1.remote', 'origin']]);
  });

  test('worktree folders are relative to the repository; a file named like a branch does not confuse diffs', async () => {
    const r = await call<{ path: string }>('worktree.add', { path: '../relative-wt', newBranch: 'wt-branch', start: 'main' });
    assert.equal(r.path, path.join(fs.realpathSync(root), 'relative-wt'));
    await call('worktree.remove', { path: r.path });

    commitFile('feature', 'a file named like a branch\n', 'file');
    sh(repo, 'branch', 'feature', 'HEAD~1');
    const diffs = await call<FileDiff[]>('diff.range', { from: 'feature', to: 'main' });
    assert.deepEqual(diffs.map((d) => d.newPath), ['feature']);
  });

  test('compare: merge base, commits in a range, range diff', async () => {
    const base = at('main');
    sh(repo, 'switch', '-q', '-c', 'f');
    commitFile('f.txt', 'f\n', 'f1');
    sh(repo, 'switch', '-q', 'main');
    commitFile('m.txt', 'm\n', 'm1');
    assert.equal(await call('merge.base', { a: 'main', b: 'f' }), base);
    const commits = await call<Commit[]>('log.range', { from: 'main', to: 'f' });
    assert.deepEqual(commits.map((c) => c.subject), ['f1']);
    const diffs = await call<FileDiff[]>('diff.range', { from: base, to: 'f' });
    assert.deepEqual(diffs.map((d) => d.newPath), ['f.txt']);
  });
});
