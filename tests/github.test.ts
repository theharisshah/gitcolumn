import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, test } from 'node:test';
import { createApi, dispatch } from '../server/api.ts';
import { knownGitHubHosts, normalizeChecks, normalizeHost, normalizePull, parseGitHubRemote } from '../server/github.ts';
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
    assert.equal(normalizeHost(parseGitHubRemote('ssh://git@ssh.github.com:443/o/r.git')!.host), 'github.com');
    assert.equal(normalizeHost('GHE.corp.example'), 'ghe.corp.example');
  });

  test('known hosts: github.com plus the ones gh is signed in to', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gitcolumn-ghcfg-'));
    roots.push(dir);
    writeFileSync(path.join(dir, 'hosts.yml'), 'github.com:\n    user: octo\nghe.corp.example:\n    users:\n        me:\n    git_protocol: ssh\n');
    const prev = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = dir;
    try {
      assert.deepEqual([...(await knownGitHubHosts())].sort(), ['ghe.corp.example', 'github.com']);
    } finally {
      if (prev === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = prev;
    }
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
const state = (n) => { try { return fs.readFileSync(path.join(${JSON.stringify('DIR')}, n), 'utf8'); } catch { return null; } };
if (args[0] === 'pr' && args[1] === 'list') out(fixture('pr-list.json'));
if (args[0] === 'pr' && args[1] === 'view' && args.includes('state,autoMergeRequest')) out(state('merge-state.json') ?? '{"state":"MERGED","autoMergeRequest":null}');
if (args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid,baseRefOid,baseRefName')) out(state('oids-' + args[2] + '.json'));
if (args[0] === 'pr' && args[1] === 'view') out(fixture('pr-view.json'));
if (args[0] === 'pr' && args[1] === 'diff' && state('diff-fails')) { process.stderr.write('HTTP 406: Sorry, the diff exceeded the maximum number of files'); process.exit(1); }
if (args[0] === 'pr' && args[1] === 'create') out('Creating pull request for feature into main in o/r\\n\\nhttps://github.com/o/r/pull/42\\n');
if (args[0] === 'pr' && args[1] === 'merge') out('');
if (args[0] === 'pr' && args[1] === 'diff') out('diff --git a/x.txt b/x.txt\\n--- a/x.txt\\n+++ b/x.txt\\n@@ -1 +1 @@\\n-a\\n+b\\n');
process.stderr.write('unexpected: ' + args.join(' ')); process.exit(1);
`,
    );
    writeFileSync(script, readFileSync(script, 'utf8').replace(JSON.stringify('DIR'), JSON.stringify(dir)));
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
    assert.equal(s.repo.targetRemote, 'origin');
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

  test('a remote on a host that isn’t GitHub is never contacted; a GitHub remote next to it is used', async () => {
    fakeGh('ok');
    execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.invalid/o/r.git']);
    const s = await call<GhStatus>('gh.status', { refresh: true });
    assert.equal(s.state, 'not-github');
    assert.ok(!calls().some((c) => c.args.includes('--hostname')), 'no request to the other host');
    execFileSync('git', ['-C', repo, 'remote', 'add', 'github', 'https://github.com/o/r.git']);
    const s2 = await call<GhStatus>('gh.status', { refresh: true });
    assert.equal(s2.state, 'ready');
    if (s2.state === 'ready') assert.deepEqual([s2.host, s2.repo.remote], ['github.com', 'github']);
    assert.ok(calls().every((c) => !c.args.includes('--hostname') || c.args[c.args.indexOf('--hostname') + 1] === 'github.com'));
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
    assert.equal(pr.headRemote, 'origin');
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

  test('create names the head where the branch was pushed: another name, or another repository', async () => {
    fakeGh('ok');
    const headOf = async (branch: string) => {
      await call('gh.prCreate', { title: 'T', body: '', base: 'main', head: branch });
      const c = calls().filter((x) => x.args[1] === 'create').pop()!;
      return c.args[c.args.indexOf('--head') + 1];
    };
    const config = (k: string, v: string) => execFileSync('git', ['-C', repo, 'config', k, v]);
    // Tracks origin/haris/fix: the head is that branch.
    config('branch.fix.remote', 'origin');
    config('branch.fix.merge', 'refs/heads/haris/fix');
    assert.equal(await headOf('fix'), 'haris/fix');
    // Published to a second remote (the user's fork): owner:branch.
    execFileSync('git', ['-C', repo, 'remote', 'add', 'mine', 'git@github.com:me/r.git']);
    config('branch.feature.remote', 'mine');
    config('branch.feature.merge', 'refs/heads/feature');
    assert.equal(await headOf('feature'), 'me:feature');
    // Pushes going elsewhere than the upstream (pushRemote) keep the local name.
    config('branch.fix.pushRemote', 'mine');
    assert.equal(await headOf('fix'), 'me:fix');
    // Not pushed anywhere known: the local name.
    assert.equal(await headOf('other'), 'other');
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

  test('merge reports a merge queue or auto-merge instead of "merged"', async () => {
    fakeGh('ok');
    const dir = path.dirname(repo);
    assert.deepEqual(await call('gh.prMerge', { number: 12, method: 'squash', headOid: '1'.repeat(40) }), { state: 'merged' });
    writeFileSync(path.join(dir, 'merge-state.json'), '{"state":"OPEN","autoMergeRequest":null}');
    assert.deepEqual(await call('gh.prMerge', { number: 12, method: 'squash', headOid: '1'.repeat(40) }), { state: 'queued' });
    writeFileSync(path.join(dir, 'merge-state.json'), '{"state":"OPEN","autoMergeRequest":{"enabledAt":"2026-10-11T00:00:00Z"}}');
    assert.deepEqual(await call('gh.prMerge', { number: 12, method: 'squash', headOid: '1'.repeat(40) }), { state: 'auto' });
  });

  test('diff comes back parsed', async () => {
    fakeGh('ok');
    const diffs = await call<{ newPath: string }[]>('gh.prDiff', { number: 12 });
    assert.deepEqual(diffs.map((d) => d.newPath), ['x.txt']);
  });

  test('a diff too large for GitHub is built locally from the exact commits, even with fetches running at once', async () => {
    fakeGh('ok');
    const dir = path.dirname(repo);
    writeFileSync(path.join(dir, 'diff-fails'), '1');
    // A local "GitHub": origin's SSH URL is served from dir/hub/o/r.git by a fake ssh.
    const bare = path.join(dir, 'hub', 'o', 'r.git');
    const work = path.join(dir, 'work');
    const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
    execFileSync('git', ['init', '-q', '--bare', bare]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    g(work, 'config', 'user.name', 'T');
    g(work, 'config', 'user.email', 't@example.com');
    writeFileSync(path.join(work, 'base.txt'), 'base\n');
    g(work, 'add', '-A');
    g(work, 'commit', '-qm', 'base');
    const base = g(work, 'rev-parse', 'HEAD');
    const pr = (n: number) => {
      g(work, 'switch', '-q', '-c', `pr${n}`, base);
      writeFileSync(path.join(work, `pr${n}.txt`), `${n}\n`);
      g(work, 'add', '-A');
      g(work, 'commit', '-qm', `pr ${n}`);
      const head = g(work, 'rev-parse', 'HEAD');
      g(work, 'push', '-q', bare, `HEAD:refs/pull/${n}/head`);
      writeFileSync(path.join(dir, `oids-${n}.json`), JSON.stringify({ headRefOid: head, baseRefOid: base, baseRefName: 'main' }));
    };
    g(work, 'push', '-q', bare, 'main');
    pr(1);
    pr(2);
    const ssh = path.join(dir, 'fake-ssh');
    writeFileSync(ssh, `#!/bin/sh\nfor last; do :; done\ncd ${JSON.stringify(path.join(dir, 'hub'))} && sleep 0.2 && exec sh -c "$(printf '%s' "$last" | sed 's/^git-/git /')"\n`);
    chmodSync(ssh, 0o755);
    g(repo, 'config', 'core.sshCommand', ssh);
    g(repo, 'config', 'ssh.variant', 'simple');
    for (let i = 0; i < 3; i++) {
      const [a, b] = await Promise.all([1, 2].map((n) => call<{ newPath: string }[]>('gh.prDiff', { number: n })));
      assert.deepEqual([a.map((d) => d.newPath), b.map((d) => d.newPath)], [['pr1.txt'], ['pr2.txt']]);
    }
  });
});
