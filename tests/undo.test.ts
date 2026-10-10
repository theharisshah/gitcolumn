import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    await push('Track Branch', { kind: 'upstream', branch: 'old', previous: null });
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

    await push('Remove Remote', { kind: 'remote-remove', name: 'origin', url: 'git@example.com:me/r.git' });
    await undoAfterRestart();
    assert.equal(sh(repo, 'remote', 'get-url', 'origin'), 'git@example.com:me/r.git');
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
    const state = await call<UndoState>('undo.state', { repo });
    assert.equal(state.count, 30);
    assert.equal(state.top?.label, 'Op 34');
    await call('undo.clear', { repo });
    assert.equal(await count(), 0);
  });

  test('nothing to undo', async () => {
    await assert.rejects(undoAfterRestart(), /Nothing to undo/);
  });
});
