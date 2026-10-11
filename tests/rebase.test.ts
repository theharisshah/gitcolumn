import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { createApi, dispatch } from '../server/api.ts';
import type { RebasePlan, RebaseStep } from '../shared/types.ts';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } }).trim();
const roots: string[] = [];
after(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

describe('interactive rebase across merges', () => {
  let repo: string;
  let call: <T = unknown>(method: string, args?: object) => Promise<T>;
  let base: string;
  const write = (f: string, c: string) => writeFileSync(path.join(repo, f), c);
  const commit = (f: string, c: string, msg: string) => {
    write(f, c);
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', msg);
    return sh(repo, 'rev-parse', 'HEAD');
  };
  const subjects = () => sh(repo, 'log', '--format=%s', `${base}..HEAD`).split('\n');
  const parentsOfMerge = () => sh(repo, 'log', '--merges', '--format=%P', `${base}..HEAD`).split('\n').filter(Boolean);
  const plan = () => call<RebasePlan>('rebase.plan', { base });
  const steps = (p: RebasePlan, change: Record<string, Partial<RebaseStep>> = {}): RebaseStep[] =>
    p.commits.map((c) => ({ action: 'pick', hash: c.hash, ...(change[c.subject] ?? {}) }) as RebaseStep);

  beforeEach(() => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gitcolumn-rebase-'));
    roots.push(root);
    repo = root;
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.name', 'T');
    sh(repo, 'config', 'user.email', 't@example.com');
    base = commit('base.txt', 'base\n', 'base');
    commit('a.txt', 'a\n', 'A');
    sh(repo, 'switch', '-q', '-c', 'feature');
    commit('f1.txt', 'f1\n', 'F1');
    commit('f2.txt', 'f2\n', 'F2');
    sh(repo, 'switch', '-q', 'main');
    commit('b.txt', 'b\n', 'B');
    sh(repo, 'merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
    commit('c.txt', 'c\n', 'C');
    const api = createApi({ electron: false });
    call = <T,>(method: string, args: object = {}) => dispatch(api, method, { repo, ...args }) as Promise<T>;
  });

  test('the plan marks merges, side-branch commits and whether merges can be recreated', async () => {
    const p = await plan();
    assert.equal(p.hasMerges, true);
    const by = new Map(p.commits.map((c) => [c.subject, c]));
    assert.equal(by.get('F1')!.mainline, false);
    assert.equal(by.get('B')!.mainline, true);
    assert.equal(by.get('Merge feature')!.mainline, true);
    assert.deepEqual(p.merges, [{ hash: by.get('Merge feature')!.hash, conflicts: false, evil: false }]);
  });

  test('reword a commit below the merge: the merge is recreated with both parents', async () => {
    const tree = sh(repo, 'rev-parse', 'HEAD^{tree}');
    const p = await plan();
    const r = await call<{ conflicts: boolean }>('rebase.interactive', { base, steps: steps(p, { B: { action: 'reword', message: 'B, reworded' } }) });
    assert.equal(r.conflicts, false);
    assert.ok(subjects().includes('B, reworded'));
    assert.equal(parentsOfMerge()[0].split(' ').length, 2, 'still a merge');
    assert.equal(sh(repo, 'rev-parse', 'HEAD^{tree}'), tree, 'same content');
    assert.equal(sh(repo, 'log', '-1', '--format=%s'), 'C');
  });

  test('drop and squash on the side branch keep the merge', async () => {
    let p = await plan();
    await call('rebase.interactive', { base, steps: steps(p, { F1: { action: 'drop' } }) });
    assert.ok(!existsSync(path.join(repo, 'f1.txt')), 'F1 is gone');
    assert.equal(parentsOfMerge()[0].split(' ').length, 2);

    p = await plan();
    sh(repo, 'reset', '-q', '--hard', 'ORIG_HEAD');
    p = await plan();
    await call('rebase.interactive', { base, steps: steps(p, { F2: { action: 'fixup' } }) });
    assert.ok(!subjects().includes('F2'));
    assert.ok(existsSync(path.join(repo, 'f2.txt')), 'F2 folded into F1');
    const [, side] = parentsOfMerge()[0].split(' ');
    assert.equal(sh(repo, 'log', '-1', '--format=%s', side), 'F1');
  });

  test('a squash with nothing to combine with is refused, leaving HEAD and local changes alone', async () => {
    const head = sh(repo, 'rev-parse', 'HEAD');
    write('c.txt', 'local edit\n');
    const p = await plan();
    // F1 starts the side branch: the line before it in git's list is a "reset".
    await assert.rejects(call('rebase.interactive', { base, steps: steps(p, { F1: { action: 'squash' } }) }), /can't be combined/);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), head);
    assert.equal(readFileSync(path.join(repo, 'c.txt'), 'utf8'), 'local edit\n', 'autostash restored');
    assert.ok(!existsSync(path.join(repo, '.git', 'rebase-merge')), 'no rebase left in progress');
  });

  test('reordering and changing merges are refused', async () => {
    const p = await plan();
    const s = steps(p);
    [s[1], s[2]] = [s[2], s[1]];
    await assert.rejects(call('rebase.interactive', { base, steps: s }), /reordered/);
    await assert.rejects(call('rebase.interactive', { base, steps: steps(p, { 'Merge feature': { action: 'drop' } }) }), /Merge commits can only be kept/);
  });

  test('a merge with changes of its own is not recreated (refused)', async () => {
    // Amend the merge to add content no parent has ("evil merge"), then rebuild C on top of it.
    sh(repo, 'reset', '-q', '--hard', 'HEAD~1');
    write('evil.txt', 'only in the merge\n');
    sh(repo, 'add', 'evil.txt');
    sh(repo, 'commit', '-q', '--amend', '--no-edit');
    commit('c.txt', 'c\n', 'C');
    const head = sh(repo, 'rev-parse', 'HEAD');
    const p = await plan();
    assert.equal(p.merges![0].evil, true);
    await assert.rejects(call('rebase.interactive', { base, steps: steps(p, { A: { action: 'reword', message: 'A2' } }) }), /changes of its own/);
    assert.equal(sh(repo, 'rev-parse', 'HEAD'), head);
    // Changing only commits above the merge doesn't recreate it: allowed.
    await call('rebase.interactive', { base, steps: steps(p, { C: { action: 'reword', message: 'C2' } }) });
    assert.ok(existsSync(path.join(repo, 'evil.txt')));
    assert.equal(sh(repo, 'log', '-1', '--format=%s'), 'C2');
  });

  test('a merge that needed conflict resolution is flagged and conflicts again', async () => {
    sh(repo, 'reset', '-q', '--hard', base);
    commit('x.txt', 'main\n', 'main x');
    sh(repo, 'switch', '-q', '-c', 'side', base);
    commit('x.txt', 'side\n', 'side x');
    sh(repo, 'switch', '-q', 'main');
    try {
      sh(repo, 'merge', '-q', 'side');
    } catch {
      /* conflict */
    }
    write('x.txt', 'resolved\n');
    sh(repo, 'add', 'x.txt');
    sh(repo, 'commit', '-q', '--no-edit');
    const p = await plan();
    assert.equal(p.merges![0].conflicts, true);
    const r = await call<{ conflicts: boolean }>('rebase.interactive', { base, steps: steps(p, { 'main x': { action: 'reword', message: 'main x 2' } }) });
    assert.equal(r.conflicts, true);
    sh(repo, 'rebase', '--abort');
  });
});
