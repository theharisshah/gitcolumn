import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { createApi, dispatch } from '../server/api.ts';
import { normalizeChecks, normalizePull, parseGitHubRemote } from '../server/github.ts';
import type { GhPullDetail, GhPullSummary, GhStatus } from '../shared/types.ts';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'gh');
const fixture = (name: string) => JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
const roots: string[] = [];
after(() => {
  roots.forEach((r) => rmSync(r, { recursive: true, force: true }));
  delete process.env.GITCOLUMN_GH;
});

describe('gh parsing', () => {
  test('remote URLs in every form', () => {
    const want = { host: 'github.com', owner: 'o', name: 'r' };
    for (const url of [
      'git@github.com:o/r.git',
      'git@github.com:o/r',
      'ssh://git@github.com/o/r.git',
      'ssh://git@github.com:22/o/r.git',
      'https://github.com/o/r',
      'https://github.com/o/r.git',
      'https://user@github.com/o/r.git/',
      'git://github.com/o/r.git',
    ]) {
      assert.deepEqual(parseGitHubRemote(url), want, url);
    }
    assert.deepEqual(parseGitHubRemote('git@ghe.corp.example:team/app.git'), { host: 'ghe.corp.example', owner: 'team', name: 'app' });
    assert.equal(parseGitHubRemote('/srv/git/repo.git'), null);
    assert.equal(parseGitHubRemote('https://github.com/just-owner'), null);
  });

  test('check runs and status contexts get one shape', () => {
    const [open, failing] = fixture('pr-list.json');
    const a = normalizeChecks(open.statusCheckRollup);
    assert.deepEqual(a.summary, { state: 'pending', total: 3, passed: 2, failed: 0, pending: 1 });
    assert.deepEqual(a.runs.map((r) => [r.name, r.state]), [['test', 'success'], ['lint', 'pending'], ['ci/legacy', 'success']]);
    assert.equal(normalizeChecks(failing.statusCheckRollup).summary.state, 'failure');
    assert.deepEqual(normalizeChecks(null).summary, { state: 'none', total: 0, passed: 0, failed: 0, pending: 0 });
    const pr = normalizePull(failing);
    assert.deepEqual([pr.isDraft, pr.reviewDecision, pr.author.bot, pr.state], [true, null, true, 'open']);
  });
});

describe('gh handlers (fake gh)', () => {
  let repo: string;
  let log: string;
  let call: <T = unknown>(method: string, args?: object) => Promise<T>;
  const calls = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { args: string[]; stdin: string });

  /** A fake gh that logs its arguments and stdin, and answers from the fixtures. */
  function fakeGh(mode: 'ok' | 'noauth') {
    const dir = path.dirname(repo);
    const script = path.join(dir, 'gh');
    writeFileSync(
      script,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, stdin }) + '\\n');
const out = (s) => { process.stdout.write(s); process.exit(0); };
const fixture = (n) => fs.readFileSync(path.join(${JSON.stringify(FIXTURES)}, n), 'utf8');
if (args[0] === '--version') out('gh version 2.67.0 (2026-01-01)\\n');
if (${JSON.stringify(mode)} === 'noauth') { process.stderr.write('To get started with GitHub CLI, please run:  gh auth login\\n'); process.exit(4); }
if (args[0] === 'api' && args.includes('user')) out('octo\\n');
if (args[0] === 'repo' && args[1] === 'view') out(JSON.stringify({ nameWithOwner: 'o/r', url: 'https://github.com/o/r', defaultBranchRef: { name: 'main' }, isFork: false, parent: null, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false, viewerPermission: 'WRITE' }));
if (args[0] === 'pr' && args[1] === 'list') out(fixture('pr-list.json'));
if (args[0] === 'pr' && args[1] === 'view') out(fixture('pr-view.json'));
if (args[0] === 'pr' && args[1] === 'create') out('Creating pull request for feature into main in o/r\\n\\nhttps://github.com/o/r/pull/42\\n');
if (args[0] === 'pr' && args[1] === 'merge') out('');
if (args[0] === 'pr' && args[1] === 'diff') out('diff --git a/x.txt b/x.txt\\n--- a/x.txt\\n+++ b/x.txt\\n@@ -1 +1 @@\\n-a\\n+b\\n');
process.stderr.write('unexpected: ' + args.join(' ')); process.exit(1);
`,
    );
    chmodSync(script, 0o755);
    process.env.GITCOLUMN_GH = script;
  }

  beforeEach(() => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'gitcolumn-gh-'));
    roots.push(root);
    repo = path.join(root, 'repo');
    log = path.join(root, 'gh.log');
    writeFileSync(log, '');
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:o/r.git']);
    const api = createApi({ electron: false });
    call = <T,>(method: string, args: object = {}) => dispatch(api, method, { repo, ...args }) as Promise<T>;
  });

  test('status: ready, with the repository and allowed merge methods', async () => {
    fakeGh('ok');
    const s = await call<GhStatus>('gh.status');
    assert.equal(s.state, 'ready');
    if (s.state !== 'ready') return;
    assert.deepEqual([s.host, s.user, s.repo.nameWithOwner, s.repo.defaultBranch, s.repo.remote], ['github.com', 'octo', 'o/r', 'main', 'origin']);
    assert.deepEqual(s.repo.mergeMethods, ['merge', 'squash']);
    assert.equal(s.repo.canMerge, true);
    assert.ok(calls().every((c) => !c.args.includes('--force')));
  });

  test('status: not authenticated, not installed, not on GitHub', async () => {
    fakeGh('noauth');
    assert.equal((await call<GhStatus>('gh.status')).state, 'not-authenticated');
    process.env.GITCOLUMN_GH = path.join(path.dirname(repo), 'no-such-gh');
    assert.equal((await call<GhStatus>('gh.status', { refresh: true })).state, 'not-installed');
    execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', '/srv/git/repo.git']);
    fakeGh('ok');
    assert.equal((await call<GhStatus>('gh.status', { refresh: true })).state, 'not-github');
  });

  test('list and view use -R with the target repository', async () => {
    fakeGh('ok');
    const list = await call<GhPullSummary[]>('gh.prList', { state: 'open', search: 'search' });
    assert.deepEqual(list.map((p) => p.number), [12, 11]);
    const listCall = calls().find((c) => c.args[0] === 'pr' && c.args[1] === 'list')!;
    assert.deepEqual(listCall.args.slice(2, 6), ['-R', 'github.com/o/r', '--state', 'open']);
    assert.ok(listCall.args.includes('--search'));
    const pr = await call<GhPullDetail>('gh.prView', { number: 12 });
    assert.deepEqual(pr.conversation.map((c) => [c.kind, c.author]), [['review', 'carol'], ['comment', 'bob']]);
    assert.equal(pr.checkRuns[0].state, 'success');
    assert.deepEqual(pr.files, [{ path: 'src/search.js', additions: 6, deletions: 1 }]);
    await assert.rejects(call('gh.prView', { number: '12; rm -rf /' }), /Invalid pull request number/);
  });

  test('create sends the body on stdin and returns the new number', async () => {
    fakeGh('ok');
    const r = await call<{ number: number; url: string }>('gh.prCreate', { title: 'My change', body: 'Long\n\nbody', base: 'main', head: 'feature', draft: true });
    assert.deepEqual(r, { number: 42, url: 'https://github.com/o/r/pull/42' });
    const c = calls().find((x) => x.args[1] === 'create')!;
    assert.equal(c.stdin, 'Long\n\nbody');
    assert.ok(c.args.includes('--draft') && c.args.includes('--body-file'));
    await assert.rejects(call('gh.prCreate', { title: ' ', body: '', base: 'main', head: 'feature' }), /needs a title/);
  });

  test('merge pins the head commit and never deletes branches', async () => {
    fakeGh('ok');
    await call('gh.prMerge', { number: 12, method: 'squash', headOid: '1'.repeat(40) });
    const c = calls().find((x) => x.args[1] === 'merge')!;
    assert.ok(c.args.includes('--squash'));
    assert.deepEqual(c.args.slice(c.args.indexOf('--match-head-commit'), c.args.indexOf('--match-head-commit') + 2), ['--match-head-commit', '1'.repeat(40)]);
    assert.ok(!c.args.includes('-d') && !c.args.includes('--delete-branch'));
    await assert.rejects(call('gh.prMerge', { number: 12, method: 'force', headOid: '1'.repeat(40) }), /Invalid merge method/);
  });

  test('diff comes back parsed', async () => {
    fakeGh('ok');
    const diffs = await call<{ newPath: string }[]>('gh.prDiff', { number: 12 });
    assert.deepEqual(diffs.map((d) => d.newPath), ['x.txt']);
  });
});
