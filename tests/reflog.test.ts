import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApi, dispatch } from '../server/api.ts';
import type { ReflogEntry } from '../shared/types.ts';

const api = createApi({ electron: false });
const call = <T>(method: string, args: object = {}) => dispatch(api, method, args) as Promise<T>;
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });

describe('reflog', () => {
  let repo: string;
  const write = (f: string, c: string) => writeFileSync(path.join(repo, f), c);
  before(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'gitcolumn-reflog-'));
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.name', 'Test User');
    sh(repo, 'config', 'user.email', 'test@example.com');
    write('a.txt', '1\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'First');
    write('a.txt', '2\n');
    sh(repo, 'commit', '-qam', 'Second');
    sh(repo, 'commit', '-q', '--amend', '-m', 'Second (amended)');
    sh(repo, 'checkout', '-q', '-b', 'topic');
    write('b.txt', 'b\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'Topic work');
    sh(repo, 'checkout', '-q', 'main');
    sh(repo, 'reset', '-q', '--hard', 'HEAD~1');
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  test('lists HEAD movements newest first with actions and selectors', async () => {
    const { entries, hasMore } = await call<{ entries: ReflogEntry[]; hasMore: boolean }>('reflog.list', { repo });
    assert.equal(hasMore, false);
    assert.deepEqual(entries.map((e) => e.action), ['reset', 'checkout', 'commit', 'checkout', 'commit (amend)', 'commit', 'commit (initial)']);
    assert.equal(entries[0].selector, 'HEAD@{0}');
    assert.equal(entries[1].detail, 'moving from topic to main');
    assert.equal(entries[4].subject, 'Second (amended)');
    assert.equal(entries[0].previous, entries[1].hash);
    assert.ok(entries[0].time > 1_000_000_000);
    assert.equal(entries[6].previous, undefined);
  });

  test('pages with skip and reports more', async () => {
    const page = await call<{ entries: ReflogEntry[]; hasMore: boolean }>('reflog.list', { repo, skip: 2, limit: 3 });
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.entries.map((e) => e.index), [2, 3, 4]);
    assert.equal(page.entries[0].selector, 'HEAD@{2}');
    assert.ok(page.entries[2].previous, 'last row of a page still knows its previous hash');
  });

  test('per-branch reflog and validation', async () => {
    const topic = await call<{ entries: ReflogEntry[] }>('reflog.list', { repo, ref: 'topic' });
    assert.deepEqual(topic.entries.map((e) => e.selector), ['topic@{0}', 'topic@{1}']);
    assert.equal(topic.entries[0].subject, 'Topic work');
    const full = await call<{ entries: ReflogEntry[] }>('reflog.list', { repo, ref: 'refs/heads/topic' });
    assert.equal(full.entries.length, 2);
    await assert.rejects(call('reflog.list', { repo, ref: '--all' }), /Invalid ref/);
    await assert.rejects(call('reflog.list', { repo, ref: 'refs/stash' }), /No such branch/);
    await assert.rejects(call('reflog.list', { repo, ref: 'nope' }), /No such branch/);
  });
});
