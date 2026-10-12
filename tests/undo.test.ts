import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { createApi, dispatch } from '../server/api.ts';
import type { Snapshot, UndoResult, UndoSpec, UndoState } from '../shared/types.ts';

// Each "session" is a separate API instance, the way a restarted app would be.
const session = () => {
  const api = createApi({ electron: false });
  return <T = unknown>(method: string, args: object = {}) => dispatch(api, method, args) as Promise<T>;
};
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } }).trim();

const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function makeRepo(commit = true) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'gitcolumn-undo-'));
  roots.push(root);
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.name', 'Test User');
  sh(repo, 'config', 'user.email', 'test@example.com');
  if (commit) {
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'First');
  }
  return repo;
}

describe('persistent undo', () => {
  let repo: string;
  let call: ReturnType<typeof session>;
  const write = (f: string, c: string) => writeFileSync(path.join(repo, f), c);
  const read = (f: string) => readFileSync(path.join(repo, f), 'utf8');
  const head = () => sh(repo, 'rev-parse', 'HEAD');
  const snapshot = (paths?: string[]) => call<Snapshot>('snapshot.capture', { repo, paths });
  const push = (label: string, spec: UndoSpec) => call<UndoState>('undo.push', { repo, label, spec });
  /** Undo from a brand-new API instance, as after a restart. */
  const undoAfterRestart = () => session()<UndoResult & { state: UndoState }>('undo.run', { repo });
  const count = async () => (await call<UndoState>('undo.state', { repo })).count;

  beforeEach(() => {
    repo = makeRepo();
    call = session();
  });

  test('commit: survives a restart and gives the message back', async () => {
    const before = await snapshot();
    write('a.txt', 'two\n');
    sh(repo, 'commit', '-qam', 'Second\n\nBody');
    const state = await push('Commit', { kind: 'commit', from: head(), to: before.head, branch: 'main', message: 'Second\n\nBody' });
    assert.deepEqual([state.count, state.top?.label], [1, 'Commit']);
    assert.ok(existsSync(path.join(repo, '.git', 'gitcolumn', 'undo.json')));

    const result = await undoAfterRestart();
    assert.equal(head(), before.head);
    assert.equal(result.restoreMessage, 'Second\n\nBody');
    assert.equal(result.state.count, 0);
    assert.equal(sh(repo, 'diff', '--cached', '--name-only'), 'a.txt', 'changes stay staged');
  });

  test('commit: the first commit returns to an unborn branch', async () => {
    repo = makeRepo(false);
    write('a.txt', 'x\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'Initial');
    await push('Commit', { kind: 'commit', from: head(), to: null, branch: 'main', message: 'Initial' });
    await undoAfterRestart();
    assert.throws(() => sh(repo, 'rev-parse', '--verify', '-q', 'HEAD'));
    assert.equal(sh(repo, 'diff', '--cached', '--name-only'), 'a.txt');
  });

  test('a stale entry is refused and dropped', async () => {
    const before = await snapshot();
    write('a.txt', 'two\n');
    sh(repo, 'commit', '-qam', 'Second');
    await push('Commit', { kind: 'commit', from: head(), to: before.head, branch: 'main', message: 'Second' });
    sh(repo, 'commit', '-q', '--allow-empty', '-m', 'Third');
    const third = head();
    await assert.rejects(undoAfterRestart(), /changed since then/);
    assert.equal(head(), third, 'nothing was changed');
    assert.equal(await count(), 0);
  });

  test('a refusal from git keeps the entry for another try', async () => {
    sh(repo, 'switch', '-q', '-c', 'other');
    write('a.txt', 'other\n');
    sh(repo, 'commit', '-qam', 'Other');
    sh(repo, 'switch', '-q', 'main');
    const before = await snapshot();
    sh(repo, 'switch', '-q', 'other');
    await push('Checkout', { kind: 'checkout', from: { head: before.head, branch: 'main' }, to: { head: head(), branch: 'other' } });
    write('a.txt', 'local edit\n'); // switching back would overwrite it
    await assert.rejects(undoAfterRestart());
    assert.equal(await count(), 1);
    sh(repo, 'checkout', '--', 'a.txt');
    await undoAfterRestart();
    assert.equal(sh(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
  });

  test('index: unstaging restores the previous index', async () => {
    write('a.txt', 'staged\n');
    write('b.txt', 'new\n');
    sh(repo, 'add', 'a.txt');
    const before = await snapshot();
    sh(repo, 'add', 'b.txt');
    await push('Stage', { kind: 'index', tree: before.index!, head: before.head });
    await undoAfterRestart();
    assert.equal(sh(repo, 'diff', '--cached', '--name-only'), 'a.txt');
    assert.equal(read('b.txt'), 'new\n', 'working tree untouched');
  });

  test('files: discarded edits and untracked files come back', async () => {
    write('a.txt', 'edited\n');
    write('new.txt', 'untracked\n');
    const before = await snapshot(['a.txt', 'new.txt']);
    sh(repo, 'checkout', '--', 'a.txt');
    rmSync(path.join(repo, 'new.txt'));
    await push('Discard', { kind: 'files', snapshot: before });
    await undoAfterRestart();
    assert.equal(read('a.txt'), 'edited\n');
    assert.equal(read('new.txt'), 'untracked\n');
  });

  test('files: after HEAD moved, files are restored but the index is left alone', async () => {
    write('a.txt', 'edited\n');
    const before = await snapshot(['a.txt']);
    sh(repo, 'checkout', '--', 'a.txt');
    await push('Discard', { kind: 'files', snapshot: before });
    write('c.txt', 'c\n');
    sh(repo, 'add', 'c.txt');
    sh(repo, 'commit', '-q', '-m', 'Moved on');
    write('d.txt', 'd\n');
    sh(repo, 'add', 'd.txt');
    await undoAfterRestart();
    assert.equal(read('a.txt'), 'edited\n');
    assert.equal(sh(repo, 'diff', '--cached', '--name-only'), 'd.txt');
  });

  test('head-reset keep (merge undo) and soft with the old index (mixed reset undo)', async () => {
    const base = head();
    sh(repo, 'switch', '-q', '-c', 'topic');
    write('t.txt', 't\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'Topic');
    sh(repo, 'switch', '-q', 'main');
    sh(repo, 'merge', '-q', '--no-ff', '--no-edit', 'topic');
    write('local.txt', 'keep me\n');
    await push('Merge', { kind: 'head-reset', from: head(), to: base, mode: 'keep', branch: 'main' });
    await undoAfterRestart();
    assert.equal(head(), base);
    assert.equal(read('local.txt'), 'keep me\n');

    rmSync(path.join(repo, 'local.txt'));
    write('a.txt', 'two\n');
    sh(repo, 'commit', '-qam', 'Second');
    write('a.txt', 'three\n');
    sh(repo, 'add', 'a.txt');
    const before = await snapshot();
    sh(repo, 'reset', '-q', '--mixed', base);
    await push('Reset', { kind: 'head-reset', from: head(), to: before.head!, mode: 'soft', index: before.index, branch: 'main' });
    await undoAfterRestart();
    assert.equal(head(), before.head);
    assert.equal(sh(repo, 'show', ':a.txt'), 'three', 'staged content is back');
  });

  test('refs: all updates apply in one transaction, or none do', async () => {
    const first = head();
    sh(repo, 'commit', '-q', '--allow-empty', '-m', 'Second');
    const second = head();
    sh(repo, 'branch', 'x', first);
    sh(repo, 'branch', 'y', first);
    await push('Bulk', {
      kind: 'refs',
      updates: [
        { ref: 'refs/heads/x', old: first, new: second },
        { ref: 'refs/heads/y', old: second, new: first }, // y is not at `second`, so the whole thing must fail
      ],
    });
    await assert.rejects(undoAfterRestart(), /changed since then/);
    assert.equal(sh(repo, 'rev-parse', 'x'), first, 'x was not moved');
    assert.equal(await count(), 0);
  });

  test('refs: deleting a created branch removes its settings; re-creating a deleted one restores them', async () => {
    sh(repo, 'branch', 'feature');
    sh(repo, 'config', 'branch.feature.remote', 'origin');
    sh(repo, 'config', 'branch.feature.merge', 'refs/heads/feature');
    const entries = await call<[string, string][]>('config.branchEntries', { repo, branch: 'feature' });
    assert.deepEqual(entries, [
      ['branch.feature.remote', 'origin'],
      ['branch.feature.merge', 'refs/heads/feature'],
    ]);
    await push('Create Branch', { kind: 'refs', updates: [{ ref: 'refs/heads/feature', old: head(), new: null }], config: entries.map(([k]) => [k, null]) });
    await undoAfterRestart();
    assert.equal(sh(repo, 'branch', '--list', 'feature'), '');
    assert.throws(() => sh(repo, 'config', 'branch.feature.remote'));

    await push('Delete Branch', { kind: 'refs', updates: [{ ref: 'refs/heads/feature', old: null, new: head() }], config: entries });
    await undoAfterRestart();
    assert.equal(sh(repo, 'rev-parse', 'feature'), head());
    assert.equal(sh(repo, 'config', 'branch.feature.merge'), 'refs/heads/feature');
  });

  test('refs: only branch settings may be changed', async () => {
    sh(repo, 'branch', 'feature');
    await push('Sneaky', { kind: 'refs', updates: [{ ref: 'refs/heads/feature', old: head(), new: null }], config: [['core.hooksPath', '/tmp/evil']] });
    await assert.rejects(undoAfterRestart(), /not allowed/);
    assert.throws(() => sh(repo, 'config', 'core.hooksPath'));
    assert.equal(await count(), 0, 'an invalid entry does not block the stack');
    await assert.rejects(push('Bad', { kind: 'nope' } as unknown as UndoSpec), /Invalid undo spec/);
  });

  test('checkout of a new tracking branch: switches back and deletes it with its settings', async () => {
    const before = await snapshot();
    sh(repo, 'switch', '-q', '-c', 'tracking');
    sh(repo, 'config', 'branch.tracking.remote', 'origin');
    await push('Checkout', {
      kind: 'checkout',
      from: { head: before.head, branch: 'main' },
      to: { head: head(), branch: 'tracking' },
      deleteBranch: { name: 'tracking', hash: head() },
    });
    await undoAfterRestart();
    assert.equal(sh(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(sh(repo, 'branch', '--list', 'tracking'), '');
    assert.throws(() => sh(repo, 'config', 'branch.tracking.remote'));
  });

  test('branch rename and upstream', async () => {
    sh(repo, 'branch', 'old');
    sh(repo, 'branch', '-m', 'old', 'new');
    await push('Rename', { kind: 'branch-rename', from: 'old', to: 'new', hash: head() });
    await undoAfterRestart();
    assert.equal(sh(repo, 'branch', '--list', 'old', '--format=%(refname:short)'), 'old');

    sh(repo, 'branch', 'up');
    sh(repo, 'branch', '--set-upstream-to=up', 'old');
    await push('Track Branch', { kind: 'upstream', branch: 'old', config: [['branch.old.remote', null], ['branch.old.merge', null]] });
    await undoAfterRestart();
    assert.throws(() => sh(repo, 'config', 'branch.old.merge'));
  });

  test('stash save, pop and drop', async () => {
    write('a.txt', 'stashed\n');
    sh(repo, 'stash', 'push', '-q', '-m', 'work');
    const hash = sh(repo, 'rev-parse', 'refs/stash');
    await push('Stash', { kind: 'stash-save', hash });
    await undoAfterRestart();
    assert.equal(read('a.txt'), 'stashed\n');
    assert.equal(sh(repo, 'stash', 'list'), '');

    sh(repo, 'stash', 'push', '-q', '-m', 'work');
    const stash = sh(repo, 'rev-parse', 'refs/stash');
    const before = await snapshot(['a.txt']);
    sh(repo, 'stash', 'pop', '-q');
    await push('Pop Stash', { kind: 'stash-apply', snapshot: before, restore: { hash: stash, message: 'work' } });
    await undoAfterRestart();
    assert.equal(read('a.txt'), 'one\n');
    assert.equal(sh(repo, 'rev-parse', 'refs/stash'), stash);

    sh(repo, 'stash', 'drop', '-q');
    await push('Delete Stash', { kind: 'stash-drop', hash: stash, message: 'work' });
    await undoAfterRestart();
    assert.match(sh(repo, 'stash', 'list'), /work/);
  });

  test('remote add and remove', async () => {
    sh(repo, 'remote', 'add', 'upstream', 'https://example.com/r.git');
    await push('Add Remote', { kind: 'remote-add', name: 'upstream' });
    await undoAfterRestart();
    assert.equal(sh(repo, 'remote'), '');

    sh(repo, 'remote', 'add', 'origin', 'git@example.com:me/r.git');
    sh(repo, 'config', 'remote.origin.pushurl', 'git@example.com:me/push.git');
    sh(repo, 'config', 'branch.main.remote', 'origin');
    sh(repo, 'config', 'branch.main.merge', 'refs/heads/main');
    const config = await call<[string, string][]>('config.remoteEntries', { repo, name: 'origin' });
    sh(repo, 'remote', 'remove', 'origin');
    assert.throws(() => sh(repo, 'config', 'branch.main.remote'), 'git remote remove unlinks tracking branches');
    await push('Remove Remote', { kind: 'remote-remove', name: 'origin', config });
    await undoAfterRestart();
    assert.equal(sh(repo, 'remote', 'get-url', 'origin'), 'git@example.com:me/r.git');
    assert.equal(sh(repo, 'config', 'remote.origin.pushurl'), 'git@example.com:me/push.git');
    assert.equal(sh(repo, 'config', 'remote.origin.fetch'), '+refs/heads/*:refs/remotes/origin/*');
    assert.equal(sh(repo, 'config', 'branch.main.remote'), 'origin');
    assert.equal(sh(repo, 'config', 'branch.main.merge'), 'refs/heads/main');
  });

  test('entries older than 7 days are dropped', async () => {
    await push('Old', { kind: 'remote-add', name: 'x' });
    const file = path.join(repo, '.git', 'gitcolumn', 'undo.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.entries[0].createdAt -= 8 * 24 * 3600 * 1000;
    writeFileSync(file, JSON.stringify(data));
    assert.equal(await count(), 0);
    await assert.rejects(undoAfterRestart(), /more than 7 days/);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries.length, 0);
  });

  test('a missing object makes the entry unusable', async () => {
    await push('Delete Tag', { kind: 'refs', updates: [{ ref: 'refs/tags/gone', old: null, new: 'deadbeef'.repeat(5) }] });
    await assert.rejects(undoAfterRestart(), /no longer available/);
    assert.equal(await count(), 0);
  });

  test('keeps the newest 30 entries and serializes concurrent pushes', async () => {
    await Promise.all(Array.from({ length: 35 }, (_, i) => push(`Op ${i}`, { kind: 'remote-add', name: `r${i}` })));
    assert.equal(await count(), 30, 'no concurrent push was lost, and the journal is capped');
    const state = await push('Last', { kind: 'remote-add', name: 'last' });
    assert.deepEqual([state.count, state.top?.label], [30, 'Last']);
    await call('undo.clear', { repo });
    assert.equal(await count(), 0);
  });

  // ------------------------------------------------ regressions from the M3 review

  test('files: refuses to overwrite work done after the discard', async () => {
    write('a.txt', 'discarded edit\n');
    const before = await snapshot(['a.txt']);
    sh(repo, 'checkout', '--', 'a.txt');
    await push('Discard', { kind: 'files', snapshot: before });
    write('a.txt', 'new important work\n');
    await assert.rejects(undoAfterRestart(), /"a.txt" was changed since then/);
    assert.equal(read('a.txt'), 'new important work\n');
    assert.equal(await count(), 1, 'kept: the user can move their work away and retry, or skip it');
    await call('undo.clear', { repo });

    // A discarded deletion, then the file was edited again: not deleted by the undo.
    sh(repo, 'checkout', '--', 'a.txt');
    sh(repo, 'rm', '-q', 'a.txt');
    const del = await snapshot(['a.txt']);
    sh(repo, 'checkout', 'HEAD', '--', 'a.txt');
    await push('Discard', { kind: 'files', snapshot: del });
    write('a.txt', 'edited after\n');
    await assert.rejects(undoAfterRestart(), /was changed since then/);
    assert.equal(read('a.txt'), 'edited after\n');
  });

  test('files: refuses symlinked folders and .git paths', async () => {
    mkdirSync(path.join(repo, 'conf'));
    write('conf/settings.json', 'local edit\n');
    const before = await snapshot(['conf/settings.json']);
    rmSync(path.join(repo, 'conf'), { recursive: true });
    await push('Discard', { kind: 'files', snapshot: before }); // the file is absent now, as the discard left it
    // Later "conf" becomes a symlink to a folder outside the repository (the file is still absent there).
    const outside = mkdtempSync(path.join(os.tmpdir(), 'gitcolumn-outside-'));
    roots.push(outside);
    symlinkSync(outside, path.join(repo, 'conf'));
    await assert.rejects(undoAfterRestart(), /symbolic link: conf/);
    assert.ok(!existsSync(path.join(outside, 'settings.json')), 'nothing written outside');

    await assert.rejects(
      call('snapshot.restore', { repo, snapshot: { head: null, branch: null, index: null, files: [{ path: '.git/hooks/pre-commit', blob: null }] }, index: false }),
      /inside .git/,
    );
  });

  test('index: refuses when the staging area changed since', async () => {
    write('a.txt', 'staged\n');
    const before = await snapshot();
    sh(repo, 'add', 'a.txt');
    await push('Stage', { kind: 'index', tree: before.index!, head: before.head });
    write('a.txt', 'staged differently\n');
    sh(repo, 'add', 'a.txt');
    await assert.rejects(undoAfterRestart(), /staged or unstaged since then/);
    assert.equal(sh(repo, 'show', ':a.txt'), 'staged differently');
    assert.equal(await count(), 1, 'kept: unstaging those changes makes it possible again');
  });

  test('permanent failures are dropped instead of blocking the stack', async () => {
    await push('Older', { kind: 'remote-add', name: 'never-added' });
    sh(repo, 'switch', '-q', '-c', 'temp');
    const before = await snapshot();
    sh(repo, 'switch', '-q', '-c', 'next');
    await push('Checkout', { kind: 'checkout', from: { head: before.head, branch: 'temp' }, to: { head: head(), branch: 'next' } });
    sh(repo, 'branch', '-D', 'temp');
    await assert.rejects(undoAfterRestart(), /temp no longer exists/);
    const state = await call<UndoState>('undo.state', { repo });
    assert.deepEqual([state.count, state.top?.label], [1, 'Older']);
  });

  test('upstream: restores raw values even when the old remote branch is gone', async () => {
    sh(repo, 'branch', 'feature');
    sh(repo, 'config', 'branch.feature.remote', 'origin');
    sh(repo, 'config', 'branch.feature.merge', 'refs/heads/feature'); // origin/feature doesn't exist
    await push('Track Branch', {
      kind: 'upstream',
      branch: 'feature',
      config: [['branch.feature.remote', 'origin'], ['branch.feature.merge', 'refs/heads/feature']],
    });
    sh(repo, 'config', 'branch.feature.merge', 'refs/heads/main');
    await undoAfterRestart();
    assert.equal(sh(repo, 'config', 'branch.feature.merge'), 'refs/heads/feature');
    await push('Sneaky', { kind: 'upstream', branch: 'feature', config: [['branch.other.merge', 'x']] });
    await assert.rejects(undoAfterRestart(), /not allowed/);
  });

  test('stash pop undo puts the stash back even when the files changed since', async () => {
    write('build', 'stashed\n');
    sh(repo, 'stash', 'push', '-q', '-u', '-m', 'work');
    const stash = sh(repo, 'rev-parse', 'refs/stash');
    const before = await snapshot(['build']);
    sh(repo, 'stash', 'pop', '-q');
    await push('Pop Stash', { kind: 'stash-apply', snapshot: before, restore: { hash: stash, message: 'work' } });
    rmSync(path.join(repo, 'build'));
    mkdirSync(path.join(repo, 'build'));
    await assert.rejects(undoAfterRestart(), /The stash is back in the list/);
    assert.equal(sh(repo, 'rev-parse', 'refs/stash'), stash);
  });

  test('stash save undo reports conflicts', async () => {
    write('a.txt', 'staged\n');
    sh(repo, 'add', 'a.txt');
    write('a.txt', 'worktree\n');
    sh(repo, 'stash', 'push', '-q', '--keep-index');
    await push('Stash', { kind: 'stash-save', hash: sh(repo, 'rev-parse', 'refs/stash') });
    const result = await undoAfterRestart();
    assert.equal(result.conflicts, true);
  });

  test('never deletes a branch that is checked out', async () => {
    sh(repo, 'branch', 'feature');
    await push('Create Branch', { kind: 'refs', updates: [{ ref: 'refs/heads/feature', old: head(), new: null }] });
    sh(repo, 'switch', '-q', 'feature');
    await assert.rejects(undoAfterRestart(), /feature is checked out/);
    assert.equal(sh(repo, 'rev-parse', 'feature'), head());
    assert.equal(await count(), 1, 'kept: works once the user switches away');
    sh(repo, 'switch', '-q', 'main');
    await undoAfterRestart();
    assert.equal(sh(repo, 'branch', '--list', 'feature'), '');
  });

  test('a branch being rebased counts as in use', async () => {
    sh(repo, 'switch', '-q', '-c', 'feature');
    sh(repo, 'commit', '-q', '--allow-empty', '-m', 'F1');
    const tip = head();
    sh(repo, 'switch', '-q', 'main');
    await push('Create Branch', { kind: 'refs', updates: [{ ref: 'refs/heads/feature', old: tip, new: null }] });
    execFileSync('git', ['rebase', '-i', 'HEAD', 'feature'], { cwd: repo, env: { ...process.env, GIT_SEQUENCE_EDITOR: 'sed -i.bak "1s/^/break\\n/"' } });
    await assert.rejects(undoAfterRestart(), /being rebased/);
    sh(repo, 'rebase', '--abort');
    assert.equal(sh(repo, 'rev-parse', 'feature'), tip);
  });

  test('git refusing because of local edits keeps the entry (not uptodate)', async () => {
    const base = head();
    sh(repo, 'switch', '-q', '-c', 'topic');
    write('t.txt', 't\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'Topic');
    sh(repo, 'switch', '-q', 'main');
    sh(repo, 'merge', '-q', '--ff-only', 'topic');
    await push('Merge', { kind: 'head-reset', from: head(), to: base, mode: 'keep', branch: 'main' });
    write('t.txt', 'unstaged edit\n');
    await assert.rejects(undoAfterRestart());
    assert.equal(await count(), 1);
    sh(repo, 'checkout', '--', 't.txt');
    await undoAfterRestart();
    assert.equal(head(), base);
  });

  test('another process holding index.lock is retryable, not "staging area changed"', async () => {
    write('a.txt', 'staged\n');
    const before = await snapshot();
    sh(repo, 'add', 'a.txt');
    await push('Stage', { kind: 'index', tree: before.index!, head: before.head });
    const lock = path.join(repo, '.git', 'index.lock');
    writeFileSync(lock, '');
    await assert.rejects(undoAfterRestart(), /Another git process/);
    assert.equal(await count(), 1);
    rmSync(lock);
    await undoAfterRestart();
    assert.equal(sh(repo, 'diff', '--cached', '--name-only'), '');
  });

  test('restores never go through a symlink inside the repository', async () => {
    mkdirSync(path.join(repo, 'tools'));
    write('tools/pre-commit', 'echo hi\n');
    const before = await snapshot(['tools/pre-commit']);
    rmSync(path.join(repo, 'tools'), { recursive: true });
    await push('Discard', { kind: 'files', snapshot: before });
    symlinkSync('.git/hooks', path.join(repo, 'tools'));
    await assert.rejects(undoAfterRestart(), /symbolic link: tools/);
    assert.ok(!existsSync(path.join(repo, '.git', 'hooks', 'pre-commit')));
  });

  // Windows doesn't allow " in file names.
  test('paths starting with a double quote are hashed literally', { skip: process.platform === 'win32' }, async () => {
    write('a.txt', 'other file\n');
    sh(repo, 'add', 'a.txt');
    sh(repo, 'commit', '-q', '-m', 'a');
    write('"a.txt"', 'quoted original\n');
    const before = await snapshot(['"a.txt"']);
    assert.equal(before.files?.[0].blob, sh(repo, 'hash-object', '--', '"a.txt"'));
    rmSync(path.join(repo, '"a.txt"'));
    await push('Discard', { kind: 'files', snapshot: before });
    write('"a.txt"', 'new work\n');
    await assert.rejects(undoAfterRestart(), /was changed since then/);
    assert.equal(read('"a.txt"'), 'new work\n');
  });

  // Relies on a read-only folder refusing writes (chmod), which Windows doesn't do.
  test('a failed write leaves the file intact and the entry ready for a retry', { skip: process.platform === 'win32' }, async () => {
    mkdirSync(path.join(repo, 'ro'));
    write('ro/f.txt', 'discarded\n');
    const before = await snapshot(['ro/f.txt']);
    write('ro/f.txt', 'after discard\n');
    const after = await snapshot(['ro/f.txt']);
    await push('Discard', { kind: 'files', snapshot: before });
    void after;
    chmodSync(path.join(repo, 'ro'), 0o555);
    try {
      await assert.rejects(undoAfterRestart(), /EACCES|permission/i);
      assert.equal(read('ro/f.txt'), 'after discard\n');
      assert.equal(await count(), 1);
    } finally {
      chmodSync(path.join(repo, 'ro'), 0o755);
    }
    await undoAfterRestart();
    assert.equal(read('ro/f.txt'), 'discarded\n');
    assert.deepEqual(readdirSync(path.join(repo, 'ro')), ['f.txt'], 'no temp files left behind');
  });

  test('a half-done undo resumes: soft reset done, index still to restore', async () => {
    write('a.txt', 'two\n');
    sh(repo, 'commit', '-qam', 'Second');
    write('a.txt', 'three\n');
    sh(repo, 'add', 'a.txt');
    const before = await snapshot();
    const first = sh(repo, 'rev-parse', 'HEAD~1');
    sh(repo, 'reset', '-q', '--mixed', first);
    await push('Reset', { kind: 'head-reset', from: head(), to: before.head!, mode: 'soft', index: before.index, branch: 'main' });
    sh(repo, 'reset', '-q', '--soft', before.head!); // as if the first attempt stopped after the reset
    await undoAfterRestart();
    assert.equal(head(), before.head);
    assert.equal(sh(repo, 'show', ':a.txt'), 'three');
  });

  test('a half-done checkout undo resumes with the branch deletion', async () => {
    const before = await snapshot();
    sh(repo, 'switch', '-q', '-c', 'created');
    await push('Checkout', { kind: 'checkout', from: { head: before.head, branch: 'main' }, to: { head: head(), branch: 'created' }, deleteBranch: { name: 'created', hash: head() } });
    sh(repo, 'switch', '-q', 'main');
    await undoAfterRestart();
    assert.equal(sh(repo, 'branch', '--list', 'created'), '');
  });

  test('older journal versions are ignored; future timestamps are kept', async () => {
    const file = path.join(repo, '.git', 'gitcolumn', 'undo.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 1, entries: [{ id: 'x', label: 'Old', createdAt: Date.now(), spec: { kind: 'remote-add', name: 'x' } }] }));
    assert.equal(await count(), 0);
    await push('Now', { kind: 'remote-add', name: 'y' });
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(data.version, 2);
    data.entries[0].createdAt = Date.now() + 3600_000;
    writeFileSync(file, JSON.stringify(data));
    assert.equal(await count(), 1);
  });

  test('a stale lock file from a crashed process is broken', async () => {
    const file = path.join(repo, '.git', 'gitcolumn', 'undo.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(`${file}.lock`, 'someone else');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    await push('After crash', { kind: 'remote-add', name: 'z' });
    assert.equal(await count(), 1);
    assert.ok(!existsSync(`${file}.lock`));
  });

  test('remove remote: pushRemote, pushDefault and remote-tracking branches come back', async () => {
    const remote = path.join(path.dirname(repo), 'remote.git');
    sh(path.dirname(repo), 'init', '-q', '--bare', remote);
    sh(repo, 'remote', 'add', 'origin', remote);
    sh(repo, 'push', '-q', 'origin', 'main');
    sh(repo, 'fetch', '-q', 'origin');
    sh(repo, 'config', 'branch.main.pushRemote', 'origin');
    sh(repo, 'config', 'remote.pushDefault', 'origin');
    sh(repo, 'config', 'remote.origin.prune', 'true');
    const config = await call<[string, string][]>('config.remoteEntries', { repo, name: 'origin' });
    const refs = await call<[string, string][]>('refs.remoteTracking', { repo, name: 'origin' });
    const head = refs.find(([r]) => r === 'refs/remotes/origin/HEAD');
    assert.ok(refs.some(([r]) => r === 'refs/remotes/origin/main'));
    sh(repo, 'remote', 'remove', 'origin');
    await push('Remove Remote', { kind: 'remote-remove', name: 'origin', config, refs });
    await undoAfterRestart();
    assert.equal(sh(repo, 'config', 'branch.main.pushRemote'), 'origin');
    assert.equal(sh(repo, 'config', 'remote.pushDefault'), 'origin');
    assert.equal(sh(repo, 'config', 'remote.origin.prune'), 'true');
    assert.equal(sh(repo, 'rev-parse', 'refs/remotes/origin/main'), sh(repo, 'rev-parse', 'HEAD'));
    if (head) assert.equal(sh(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD'), head[1].slice('ref:'.length));
    sh(repo, 'remote', 'remove', 'origin');
    const r = await (async () => {
      await push('Bad', { kind: 'remote-remove', name: 'evil', config: [['remote.evil.url', 'https://example.com/e.git'], ['remote.evil.uploadpack', 'touch /tmp/pwned']] });
      return undoAfterRestart();
    })();
    assert.match(r.note ?? '', /Not restored.*remote\.evil\.uploadpack/);
    assert.throws(() => sh(repo, 'config', 'remote.evil.uploadpack'));
    assert.equal(sh(repo, 'config', 'remote.evil.url'), 'https://example.com/e.git');
  });

  test('a pull that succeeds but leaves conflicts (autostash) reports them', async () => {
    const remote = path.join(path.dirname(repo), 'up.git');
    sh(path.dirname(repo), 'init', '-q', '--bare', remote);
    sh(repo, 'remote', 'add', 'origin', remote);
    sh(repo, 'push', '-q', '-u', 'origin', 'main');
    const other = path.join(path.dirname(repo), 'other');
    sh(path.dirname(repo), 'clone', '-q', remote, other);
    sh(other, 'config', 'user.name', 'O');
    sh(other, 'config', 'user.email', 'o@example.com');
    writeFileSync(path.join(other, 'a.txt'), 'theirs\n');
    sh(other, 'commit', '-qam', 'Theirs');
    sh(other, 'push', '-q');
    sh(repo, 'config', 'rebase.autoStash', 'true');
    write('a.txt', 'mine, uncommitted\n');
    const r = await call<{ conflicts: boolean }>('pull', { repo, rebase: true });
    assert.equal(r.conflicts, true);
  });

  test('an unmerged file named like a lock file is a conflict, not lock contention', async () => {
    write('yarn.lock', 'base\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'lock');
    const before = await snapshot();
    write('x.txt', 'x\n');
    sh(repo, 'add', 'x.txt');
    await push('Stage', { kind: 'index', tree: before.index!, head: before.head });
    sh(repo, 'reset', '-q');
    sh(repo, 'switch', '-q', '-c', 'other');
    write('yarn.lock', 'theirs\n');
    sh(repo, 'commit', '-qam', 'theirs');
    sh(repo, 'switch', '-q', 'main');
    write('yarn.lock', 'ours\n');
    sh(repo, 'commit', '-qam', 'ours');
    try {
      sh(repo, 'merge', '-q', 'other');
    } catch {
      /* conflict expected */
    }
    const t0 = Date.now();
    await assert.rejects(undoAfterRestart(), /unresolved conflicts|changed since then/);
    assert.ok(Date.now() - t0 < 1000, 'no waiting for a lock that does not exist');
    sh(repo, 'merge', '--abort');
  });

  test('a snapshot taken while another process holds index.lock fails instead of losing the index', async () => {
    const lock = path.join(repo, '.git', 'index.lock');
    writeFileSync(lock, '');
    try {
      await assert.rejects(snapshot(), /Another git process/);
    } finally {
      rmSync(lock);
    }
  });

  // Beyond Windows' path length limit for git without core.longpaths.
  test('files with very long names are restored (short temp names)', { skip: process.platform === 'win32' }, async () => {
    const long = `${'n'.repeat(240)}.txt`;
    write(long, 'precious\n');
    const before = await snapshot([long]);
    rmSync(path.join(repo, long));
    await push('Discard', { kind: 'files', snapshot: before });
    await undoAfterRestart();
    assert.equal(read(long), 'precious\n');
  });

  test('a discard that left a symlink (typechange) is undone by replacing the link', async () => {
    symlinkSync('a.txt', path.join(repo, 'link'));
    sh(repo, 'add', 'link');
    sh(repo, 'commit', '-q', '-m', 'link');
    rmSync(path.join(repo, 'link'));
    write('link', 'now a file\n');
    const before = await snapshot(['link']);
    sh(repo, 'checkout', '--', 'link'); // the discard brings the symlink back
    await push('Discard', { kind: 'files', snapshot: before });
    await undoAfterRestart();
    assert.equal(read('link'), 'now a file\n');
  });

  test('remove remote resumes when the remote came back halfway', async () => {
    sh(repo, 'remote', 'add', 'origin', 'https://example.com/r.git');
    sh(repo, 'config', 'remote.origin.pushurl', 'https://example.com/push.git');
    const config = await call<[string, string][]>('config.remoteEntries', { repo, name: 'origin' });
    sh(repo, 'remote', 'remove', 'origin');
    await push('Remove Remote', { kind: 'remote-remove', name: 'origin', config });
    sh(repo, 'config', 'remote.origin.url', 'https://example.com/r.git'); // as if the first attempt stopped here
    await undoAfterRestart();
    assert.equal(sh(repo, 'config', 'remote.origin.pushurl'), 'https://example.com/push.git');
    assert.equal(sh(repo, 'config', '--get-all', 'remote.origin.url'), 'https://example.com/r.git', 'not added twice');

    sh(repo, 'remote', 'remove', 'origin');
    await push('Remove Remote', { kind: 'remote-remove', name: 'origin', config });
    sh(repo, 'remote', 'add', 'origin', 'https://elsewhere.example/other.git');
    await assert.rejects(undoAfterRestart(), /exists again/);
  });

  test('branch rename resumes after the settings could not be moved', async () => {
    sh(repo, 'branch', 'old');
    sh(repo, 'config', 'branch.old.remote', 'origin');
    sh(repo, 'branch', '-m', 'old', 'new');
    await push('Rename', { kind: 'branch-rename', from: 'old', to: 'new', hash: head() });
    sh(repo, 'branch', '-m', 'new', 'old'); // ref renamed back…
    sh(repo, 'config', '--rename-section', 'branch.old', 'branch.new'); // …but the settings stayed behind
    await undoAfterRestart();
    assert.equal(sh(repo, 'config', 'branch.old.remote'), 'origin');
  });

  test('when refs are already in place, settings are only filled in, not overwritten', async () => {
    const hash = head();
    sh(repo, 'branch', 'feature');
    await push('Delete Branch', { kind: 'refs', updates: [{ ref: 'refs/heads/feature', old: null, new: hash }], config: [['branch.feature.remote', 'origin'], ['branch.feature.merge', 'refs/heads/feature']] });
    sh(repo, 'config', 'branch.feature.remote', 'fork'); // the user re-created it and set it up differently
    await undoAfterRestart();
    assert.equal(sh(repo, 'config', 'branch.feature.remote'), 'fork');
    assert.equal(sh(repo, 'config', 'branch.feature.merge'), 'refs/heads/feature');
  });

  test('a stash that fails to re-apply is not retried (it stays in the list)', async () => {
    write('u.txt', 'stashed untracked\n');
    sh(repo, 'stash', 'push', '-q', '-u');
    const hash = sh(repo, 'rev-parse', 'refs/stash');
    await push('Stash', { kind: 'stash-save', hash });
    write('u.txt', 'in the way\n');
    await assert.rejects(undoAfterRestart(), /still in the list/);
    assert.equal(await count(), 0);
    assert.equal(sh(repo, 'rev-parse', 'refs/stash'), hash);
  });

  test('checkout undo waits while the old branch is checked out in another worktree', async () => {
    const before = await snapshot();
    sh(repo, 'switch', '-q', '-c', 'feature');
    await push('Checkout', { kind: 'checkout', from: { head: before.head, branch: 'main' }, to: { head: head(), branch: 'feature' } });
    const wt = path.join(path.dirname(repo), 'wt-main');
    sh(repo, 'worktree', 'add', '-q', wt, 'main');
    await assert.rejects(undoAfterRestart(), /already used by worktree|already checked out/);
    assert.equal(await count(), 1);
    sh(repo, 'worktree', 'remove', wt);
    await undoAfterRestart();
    assert.equal(sh(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
  });

  test('a branch with the same name as a tag is still recognised', async () => {
    sh(repo, 'tag', 'main');
    const s = await snapshot();
    assert.equal(s.branch, 'main');
    const before = s.head!;
    sh(repo, 'commit', '-q', '--allow-empty', '-m', 'Next');
    await push('Undo Commit', { kind: 'head-reset', from: head(), to: before, mode: 'soft', branch: 'main' });
    await undoAfterRestart();
    assert.equal(head(), before);
  });

  test('a lock held by another git process keeps the entry for a retry', async () => {
    sh(repo, 'branch', 'x');
    await push('Create Branch', { kind: 'refs', updates: [{ ref: 'refs/heads/x', old: head(), new: null }] });
    const lock = path.join(repo, '.git', 'refs', 'heads', 'x.lock');
    writeFileSync(lock, '');
    await assert.rejects(undoAfterRestart());
    assert.equal(await count(), 1);
    rmSync(lock);
    await undoAfterRestart();
    assert.equal(sh(repo, 'branch', '--list', 'x'), '');
  });

  test('undo by id refuses when something newer was recorded; drop removes an entry', async () => {
    const first = await push('First', { kind: 'remote-add', name: 'a' });
    await push('Second', { kind: 'remote-add', name: 'b' });
    await assert.rejects(call('undo.run', { repo, id: first.top!.id }), /changed in the meantime/);
    assert.equal(await count(), 2);
    const state = await call<UndoState>('undo.drop', { repo, id: first.top!.id });
    assert.deepEqual([state.count, state.top?.label], [1, 'Second']);
  });

  test('validates specs and ignores malformed journal entries', async () => {
    await assert.rejects(push('Hard', { kind: 'head-reset', from: head(), to: head(), mode: 'hard' as 'keep', branch: 'main' }), /Invalid reset mode/);
    await push('Good', { kind: 'remote-add', name: 'x' });
    const file = path.join(repo, '.git', 'gitcolumn', 'undo.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.entries.unshift(null, { id: 1, label: {}, createdAt: 'soon', spec: {} });
    writeFileSync(file, JSON.stringify(data));
    const state = await call<UndoState>('undo.state', { repo });
    assert.deepEqual([state.count, state.top?.label], [1, 'Good']);
  });

  test('pushRemote is part of the branch settings', async () => {
    sh(repo, 'branch', 'feat');
    sh(repo, 'config', 'branch.feat.remote', 'origin');
    sh(repo, 'config', 'branch.feat.pushRemote', 'fork');
    const entries = await call<[string, string][]>('config.branchEntries', { repo, branch: 'feat' });
    assert.deepEqual(entries.map(([k]) => k.toLowerCase()), ['branch.feat.remote', 'branch.feat.pushremote']);
  });

  test('two spellings of one repository share one lock', async () => {
    const link = path.join(path.dirname(repo), 'link');
    symlinkSync(repo, link);
    await Promise.all(Array.from({ length: 12 }, (_, i) => call('undo.push', { repo: i % 2 ? link : repo, label: `Op ${i}`, spec: { kind: 'remote-add', name: `r${i}` } })));
    assert.equal(await count(), 12);
  });

  test('old objects brought back by an undo survive gc', async () => {
    write('a.txt', 'stashed\n');
    sh(repo, 'stash', 'push', '-q', '-m', 'old work');
    const stash = sh(repo, 'rev-parse', 'refs/stash');
    sh(repo, 'repack', '-adq');
    const packDir = path.join(repo, '.git', 'objects', 'pack');
    const old = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    for (const f of readdirSync(packDir)) utimesSync(path.join(packDir, f), old, old);
    sh(repo, 'stash', 'drop', '-q');
    await push('Delete Stash', { kind: 'stash-drop', hash: stash, message: 'old work' });
    sh(repo, 'gc', '-q');
    await undoAfterRestart();
    assert.match(sh(repo, 'stash', 'list'), /old work/);
  });

  test('nothing to undo', async () => {
    await assert.rejects(undoAfterRestart(), /Nothing to undo/);
  });
});

describe('undo of a pull request checkout', () => {
  test('switches back first, then moves the branch gh fast-forwarded back, with its settings', async () => {
    const repo = makeRepo();
    const call = session();
    const sha = (r: string) => sh(repo, 'rev-parse', r);
    sh(repo, 'branch', 'feature');
    sh(repo, 'config', 'branch.feature.remote', 'origin');
    const old = sha('feature');
    // What gh did: switch to the existing feature branch and fast-forward it (and change its settings).
    sh(repo, 'switch', '-q', 'feature');
    writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'From the PR');
    sh(repo, 'config', 'branch.feature.remote', 'https://github.com/me/r.git');
    const moved = sha('feature');
    const spec: UndoSpec = {
      kind: 'multi',
      steps: [
        { kind: 'checkout', from: { head: old, branch: 'main' }, to: { head: moved, branch: 'feature' } },
        { kind: 'refs', updates: [{ ref: 'refs/heads/feature', old: moved, new: old }], config: [['branch.feature.remote', 'origin']] },
      ],
    };
    await call('undo.push', { repo, label: 'Checkout', spec });
    await session()('undo.run', { repo });
    assert.equal(sh(repo, 'symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(sha('feature'), old);
    assert.equal(sh(repo, 'config', 'branch.feature.remote'), 'origin');
  });

  test('a stale step is caught before anything changes', async () => {
    const repo = makeRepo();
    const call = session();
    sh(repo, 'branch', 'feature');
    const old = sh(repo, 'rev-parse', 'feature');
    sh(repo, 'switch', '-q', 'feature');
    writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-qm', 'From the PR');
    const moved = sh(repo, 'rev-parse', 'feature');
    await call('undo.push', {
      repo,
      label: 'Checkout',
      spec: {
        kind: 'multi',
        steps: [
          { kind: 'checkout', from: { head: old, branch: 'main' }, to: { head: moved, branch: 'feature' } },
          { kind: 'refs', updates: [{ ref: 'refs/heads/feature', old: '1'.repeat(40), new: old }] },
        ],
      } satisfies UndoSpec,
    });
    await assert.rejects(session()('undo.run', { repo }));
    assert.equal(sh(repo, 'symbolic-ref', '--short', 'HEAD'), 'feature', 'still where it was');
  });
});
