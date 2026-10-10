import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AppInfo,
  ChangedFile,
  Commit,
  CommitDetail,
  FileDiff,
  FileStatus,
  LineSelection,
  PatchAction,
  Ref,
  Remote,
  RepoInfo,
  RepoState,
  Stash,
  Status,
} from '../shared/types.ts';
import { git, GitError } from './git.ts';
import {
  FS,
  LOG_FORMAT,
  parseDiff,
  parseLog,
  parseNameStatus,
  parseNumstat,
  parseRefs,
  parseRemotes,
  parseStashes,
  parseStatus,
  REF_FORMAT,
} from './parse.ts';
import { buildPatch } from './patch.ts';

export interface Host {
  electron: boolean;
  /** Move files to the system trash. When absent, discarded untracked files are deleted. */
  trash?: (absPaths: string[]) => Promise<void>;
  /** Show a native folder picker. */
  pickDirectory?: (title?: string) => Promise<string | null>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (args: any) => Promise<unknown>;

const NETWORK_TIMEOUT = 10 * 60_000;
const MAX_DIFF_BYTES = 30 * 1024 * 1024;

export interface ConflictResult {
  conflicts: boolean;
  message?: string;
}

export function createApi(host: Host): Record<string, Handler> {
  const gitDirCache = new Map<string, string>();

  async function gitDir(repo: string): Promise<string> {
    let dir = gitDirCache.get(repo);
    if (!dir) {
      dir = (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim();
      gitDirCache.set(repo, dir);
    }
    return dir;
  }

  async function repoState(repo: string): Promise<RepoState> {
    const dir = await gitDir(repo);
    const has = (p: string) => existsSync(path.join(dir, p));
    const state: RepoState = {
      merging: has('MERGE_HEAD'),
      rebasing: has('rebase-merge') || has('rebase-apply'),
      cherryPicking: has('CHERRY_PICK_HEAD'),
      reverting: has('REVERT_HEAD'),
    };
    if (state.merging || state.cherryPicking || state.reverting) {
      const msg = await readText(path.join(dir, 'MERGE_MSG'));
      if (msg) state.message = stripComments(msg);
    }
    if (state.rebasing) {
      const base = has('rebase-merge') ? 'rebase-merge' : 'rebase-apply';
      const num = await readText(path.join(dir, base, base === 'rebase-merge' ? 'msgnum' : 'next'));
      const end = await readText(path.join(dir, base, base === 'rebase-merge' ? 'end' : 'last'));
      if (num && end) state.rebaseProgress = `${num.trim()}/${end.trim()}`;
      const head = await readText(path.join(dir, base, 'head-name'));
      if (head) state.rebaseHeadName = head.trim().replace(/^refs\/heads\//, '');
    }
    return state;
  }

  async function getStatus(repo: string): Promise<Status> {
    const [raw, state] = await Promise.all([
      git(repo, ['status', '--porcelain=v2', '-z', '--branch', '--show-stash', '--untracked-files=all']),
      repoState(repo),
    ]);
    const parsed = parseStatus(raw);
    return { ...parsed, state };
  }

  /** Run a command that may stop with conflicts (merge, rebase, pull, cherry-pick...). */
  async function withConflicts(repo: string, run: () => Promise<unknown>): Promise<ConflictResult> {
    try {
      await run();
      return { conflicts: false };
    } catch (e) {
      const status = await getStatus(repo).catch(() => null);
      if (status && status.files.some((f) => f.conflicted)) {
        return { conflicts: true, message: e instanceof Error ? e.message : String(e) };
      }
      throw e;
    }
  }

  async function headExists(repo: string): Promise<boolean> {
    try {
      await git(repo, ['rev-parse', '--verify', '-q', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  async function configGet(repo: string, key: string): Promise<string | undefined> {
    try {
      return (await git(repo, ['config', '--get', key])).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  function pathspecInput(paths: string[]): string {
    return paths.join('\0') + '\0';
  }

  const api: Record<string, Handler> = {
    // ------------------------------------------------------------------ app
    async 'app.info'(): Promise<AppInfo> {
      const v = await git(os.homedir(), ['--version']).catch(() => 'git not found');
      return {
        platform: process.platform,
        home: os.homedir(),
        gitVersion: v.trim().replace(/^git version /, ''),
        electron: host.electron,
      };
    },

    async 'dialog.pickDirectory'({ title }: { title?: string }): Promise<string | null> {
      return host.pickDirectory ? host.pickDirectory(title) : null;
    },

    // ----------------------------------------------------------------- repo
    async 'repo.open'({ path: p }: { path: string }): Promise<RepoInfo> {
      const dir = expandHome(p);
      if (!existsSync(dir)) throw new Error(`Folder not found: ${dir}`);
      let top: string;
      try {
        top = (await git(dir, ['rev-parse', '--show-toplevel'])).trim();
      } catch {
        throw new Error(`Not a Git repository: ${dir}`);
      }
      if (!top) throw new Error(`Bare repositories are not supported: ${dir}`);
      return { path: top, name: path.basename(top) };
    },

    async 'repo.init'({ path: p }: { path: string }): Promise<RepoInfo> {
      const dir = expandHome(p);
      await fs.mkdir(dir, { recursive: true });
      await git(dir, ['init']);
      return { path: dir, name: path.basename(dir) };
    },

    async 'repo.clone'({ url, path: p }: { url: string; path: string }): Promise<RepoInfo> {
      const dir = expandHome(p);
      if (existsSync(dir) && (await fs.readdir(dir)).length > 0) throw new Error(`Destination is not empty: ${dir}`);
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await git(path.dirname(dir), ['clone', '--', url, dir], { timeout: 60 * 60_000 });
      return { path: dir, name: path.basename(dir) };
    },

    // ----------------------------------------------------------- read state
    async status({ repo }: { repo: string }): Promise<Status> {
      return getStatus(repo);
    },

    async refs({ repo }: { repo: string }): Promise<Ref[]> {
      const raw = await git(repo, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
      return parseRefs(raw);
    },

    async remotes({ repo }: { repo: string }): Promise<Remote[]> {
      return parseRemotes(await git(repo, ['remote', '-v']));
    },

    async log({
      repo,
      ref,
      all,
      skip = 0,
      limit = 400,
      search,
      searchMode = 'message',
      path: filePath,
    }: {
      repo: string;
      ref?: string;
      all?: boolean;
      skip?: number;
      limit?: number;
      search?: string;
      searchMode?: 'message' | 'author' | 'content';
      path?: string;
    }): Promise<Commit[]> {
      const args = ['log', '--topo-order', `--format=${LOG_FORMAT}`, `--skip=${skip}`, `--max-count=${limit}`];
      if (search) {
        if (searchMode === 'author') args.push(`--author=${search}`, '--regexp-ignore-case');
        else if (searchMode === 'content') args.push(`-S${search}`);
        else args.push(`--grep=${search}`, '--regexp-ignore-case');
      }
      if (all) {
        args.push('--branches', '--remotes', '--tags');
        if (await headExists(repo)) args.push('HEAD');
      } else {
        const rev = ref || 'HEAD';
        assertSafe(rev);
        if (rev === 'HEAD' && !(await headExists(repo))) return [];
        args.push(rev);
      }
      args.push('--');
      if (filePath) args.push(filePath);
      return parseLog(await git(repo, args));
    },

    async 'commit.detail'({ repo, hash }: { repo: string; hash: string }): Promise<CommitDetail> {
      assertSafe(hash);
      const raw = await git(repo, [
        'show',
        '-s',
        `--format=${['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join('%x1f')}`,
        hash,
      ]);
      const [h, parents, author, email, date, committer, committerEmail, committerDate, ...msg] = raw.split(FS);
      const message = msg.join(FS).replace(/\s+$/, '');
      const nl = message.indexOf('\n');
      const parentList = parents ? parents.split(' ') : [];
      const range = parentList.length ? [parentList[0], h] : null;
      const nameArgs = range
        ? ['diff', '-z', '--name-status', '-M', ...range]
        : ['diff-tree', '-r', '-z', '--root', '--no-commit-id', '--name-status', '-M', h];
      const numArgs = range
        ? ['diff', '-z', '--numstat', '-M', ...range]
        : ['diff-tree', '-r', '-z', '--root', '--no-commit-id', '--numstat', '-M', h];
      const [names, nums] = await Promise.all([git(repo, nameArgs), git(repo, numArgs)]);
      const stats = parseNumstat(nums);
      const files: ChangedFile[] = parseNameStatus(names).map((f) => ({ ...f, ...stats.get(f.path) }));
      return {
        hash: h,
        parents: parentList,
        author,
        email,
        date: Number(date),
        committer,
        committerEmail,
        committerDate: Number(committerDate),
        subject: nl === -1 ? message : message.slice(0, nl),
        body: nl === -1 ? '' : message.slice(nl + 1).replace(/^\n+/, ''),
        files,
      };
    },

    async 'commit.diff'({ repo, hash, parent }: { repo: string; hash: string; parent?: string }): Promise<FileDiff[]> {
      assertSafe(hash);
      let args: string[];
      if (parent) {
        assertSafe(parent);
        args = ['diff', '--no-ext-diff', '-M', parent, hash];
      } else {
        args = ['diff-tree', '-p', '-r', '--root', '--no-commit-id', '--no-ext-diff', '-M', hash];
      }
      return parseDiff(await git(repo, args, { maxBytes: MAX_DIFF_BYTES }));
    },

    async 'commit.lastMessage'({ repo }: { repo: string }): Promise<string> {
      if (!(await headExists(repo))) return '';
      return (await git(repo, ['log', '-1', '--format=%B'])).replace(/\s+$/, '');
    },

    async 'diff.working'({
      repo,
      file,
      staged,
      ignoreWhitespace,
      context = 3,
    }: {
      repo: string;
      file: FileStatus;
      staged: boolean;
      ignoreWhitespace?: boolean;
      context?: number;
    }): Promise<FileDiff | null> {
      const opts = ['--no-ext-diff', `-U${Math.max(0, Math.min(context, 1000))}`];
      if (ignoreWhitespace) opts.push('-w');
      let raw: string;
      if (file.untracked) {
        raw = await git(repo, ['diff', '--no-index', ...opts, '--', '/dev/null', file.path], {
          okCodes: [1],
          maxBytes: MAX_DIFF_BYTES,
        });
      } else if (staged) {
        const paths = file.origPath ? [file.origPath, file.path] : [file.path];
        raw = await git(repo, ['diff', '--cached', '-M', ...opts, '--', ...paths], { maxBytes: MAX_DIFF_BYTES });
      } else {
        raw = await git(repo, ['diff', ...opts, '--', file.path], { maxBytes: MAX_DIFF_BYTES });
      }
      const diffs = parseDiff(raw);
      return diffs.find((d) => d.newPath === file.path) ?? diffs[0] ?? null;
    },

    async 'file.read'({ repo, path: rel }: { repo: string; path: string }) {
      const abs = insideRepo(repo, rel);
      const stat = await fs.stat(abs);
      const limit = 2 * 1024 * 1024;
      const fh = await fs.open(abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(stat.size, limit));
        await fh.read(buf, 0, buf.length, 0);
        const binary = buf.subarray(0, 8000).includes(0);
        return { content: binary ? '' : buf.toString('utf8'), binary, size: stat.size, truncated: stat.size > limit };
      } finally {
        await fh.close();
      }
    },

    // ------------------------------------------------------------- staging
    async stage({ repo, paths }: { repo: string; paths: string[] }) {
      if (!paths.length) return;
      await git(repo, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: pathspecInput(paths) });
    },

    async stageAll({ repo }: { repo: string }) {
      await git(repo, ['add', '-A']);
    },

    async unstage({ repo, paths }: { repo: string; paths: string[] }) {
      if (!paths.length) return;
      if (await headExists(repo)) {
        await git(repo, ['restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          input: pathspecInput(paths),
        });
      } else {
        await git(repo, ['rm', '--cached', '-r', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          input: pathspecInput(paths),
        });
      }
    },

    async unstageAll({ repo }: { repo: string }) {
      if (await headExists(repo)) await git(repo, ['reset', '-q']);
      else await git(repo, ['rm', '--cached', '-r', '-q', '.']);
    },

    async discard({ repo, files }: { repo: string; files: FileStatus[] }) {
      const untracked = files.filter((f) => f.untracked).map((f) => f.path);
      const added = files.filter((f) => !f.untracked && f.index === 'A').map((f) => f.path);
      const renamedNew = files.filter((f) => f.origPath).map((f) => f.path);
      const restore = files
        .filter((f) => !f.untracked && f.index !== 'A')
        .map((f) => f.origPath ?? f.path);

      if (untracked.length) {
        if (host.trash) await host.trash(untracked.map((p) => insideRepo(repo, p)));
        else await git(repo, ['clean', '-f', '-q', '--', ...untracked]);
      }
      const remove = [...added, ...renamedNew];
      if (remove.length) {
        await git(repo, ['rm', '-f', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          input: pathspecInput(remove),
        });
      }
      if (restore.length) {
        await git(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          input: pathspecInput(restore),
        });
      }
    },

    async 'patch.apply'({
      repo,
      diff,
      selection,
      action,
    }: {
      repo: string;
      diff: FileDiff;
      selection: LineSelection;
      action: PatchAction;
    }) {
      const patch = buildPatch(diff, selection, action === 'stage' ? 'forward' : 'reverse');
      if (!patch) return;
      const args = ['apply', '--recount', '--whitespace=nowarn'];
      if (action !== 'discard') args.push('--cached');
      if (action !== 'stage') args.push('--reverse');
      args.push('-');
      await git(repo, args, { input: patch });
    },

    async 'conflict.resolve'({
      repo,
      path: p,
      side,
      conflictType = 'UU',
    }: {
      repo: string;
      path: string;
      side: 'ours' | 'theirs';
      conflictType?: string;
    }) {
      const missing = side === 'ours' ? conflictType[0] === 'D' : conflictType[1] === 'D';
      if (missing) {
        await git(repo, ['rm', '-q', '--', p]);
      } else {
        await git(repo, ['checkout', `--${side}`, '--', p]);
        await git(repo, ['add', '--', p]);
      }
    },

    // ------------------------------------------------------------- commits
    async commit({ repo, message, amend }: { repo: string; message: string; amend?: boolean }) {
      const args = ['commit', '-F', '-'];
      if (amend) args.push('--amend');
      await git(repo, args, { input: message });
    },

    async 'checkout'({ repo, branch }: { repo: string; branch: string }) {
      assertSafe(branch);
      await git(repo, ['switch', '--no-guess', branch]);
    },

    async 'checkout.detached'({ repo, ref }: { repo: string; ref: string }) {
      assertSafe(ref);
      await git(repo, ['switch', '--detach', ref]);
    },

    async 'checkout.remote'({ repo, remoteBranch, localName }: { repo: string; remoteBranch: string; localName: string }) {
      assertSafe(remoteBranch);
      assertSafe(localName);
      const exists = await git(repo, ['show-ref', '--verify', '-q', `refs/heads/${localName}`])
        .then(() => true)
        .catch(() => false);
      if (exists) await git(repo, ['switch', '--no-guess', localName]);
      else await git(repo, ['switch', '-c', localName, '--track', remoteBranch]);
    },

    async 'branch.create'({ repo, name, start, checkout }: { repo: string; name: string; start?: string; checkout?: boolean }) {
      assertSafe(name);
      if (start) assertSafe(start);
      if (checkout) await git(repo, ['switch', '-c', name, ...(start ? [start] : [])]);
      else await git(repo, ['branch', name, ...(start ? [start] : [])]);
    },

    async 'branch.delete'({ repo, name, force }: { repo: string; name: string; force?: boolean }) {
      assertSafe(name);
      await git(repo, ['branch', force ? '-D' : '-d', name]);
    },

    async 'branch.rename'({ repo, oldName, newName }: { repo: string; oldName: string; newName: string }) {
      assertSafe(oldName);
      assertSafe(newName);
      await git(repo, ['branch', '-m', oldName, newName]);
    },

    async 'branch.deleteRemote'({ repo, remote, name }: { repo: string; remote: string; name: string }) {
      assertSafe(remote);
      assertSafe(name);
      await git(repo, ['push', remote, '--delete', name], { timeout: NETWORK_TIMEOUT });
    },

    async 'branch.setUpstream'({ repo, branch, upstream }: { repo: string; branch: string; upstream: string | null }) {
      assertSafe(branch);
      if (upstream) {
        assertSafe(upstream);
        await git(repo, ['branch', `--set-upstream-to=${upstream}`, branch]);
      } else {
        await git(repo, ['branch', '--unset-upstream', branch]);
      }
    },

    async merge({ repo, ref, noFF, squash }: { repo: string; ref: string; noFF?: boolean; squash?: boolean }) {
      assertSafe(ref);
      const args = ['merge'];
      if (squash) args.push('--squash');
      else if (noFF) args.push('--no-ff');
      args.push('--no-edit', ref);
      return withConflicts(repo, () => git(repo, args));
    },

    async rebase({ repo, onto }: { repo: string; onto: string }) {
      assertSafe(onto);
      return withConflicts(repo, () => git(repo, ['rebase', onto]));
    },

    async 'cherryPick'({ repo, hash }: { repo: string; hash: string }) {
      assertSafe(hash);
      return withConflicts(repo, () => git(repo, ['cherry-pick', hash]));
    },

    async revert({ repo, hash, parent }: { repo: string; hash: string; parent?: number }) {
      assertSafe(hash);
      const args = ['revert', '--no-edit'];
      if (parent) args.push('-m', String(parent));
      args.push(hash);
      return withConflicts(repo, () => git(repo, args));
    },

    async reset({ repo, hash, mode }: { repo: string; hash: string; mode: 'soft' | 'mixed' | 'hard' }) {
      assertSafe(hash);
      if (!['soft', 'mixed', 'hard'].includes(mode)) throw new Error(`Invalid reset mode: ${mode}`);
      await git(repo, ['reset', `--${mode}`, hash]);
    },

    async 'op.continue'({ repo }: { repo: string }) {
      const s = await repoState(repo);
      if (s.rebasing) return withConflicts(repo, () => git(repo, ['rebase', '--continue']));
      if (s.cherryPicking) return withConflicts(repo, () => git(repo, ['cherry-pick', '--continue']));
      if (s.reverting) return withConflicts(repo, () => git(repo, ['revert', '--continue']));
      // Without an editor git keeps MERGE_MSG's "# Conflicts:" comment lines unless told to strip them.
      if (s.merging) return withConflicts(repo, () => git(repo, ['commit', '--no-edit', '--cleanup=strip']));
      throw new Error('No operation in progress');
    },

    async 'op.abort'({ repo }: { repo: string }) {
      const s = await repoState(repo);
      if (s.rebasing) await git(repo, ['rebase', '--abort']);
      else if (s.cherryPicking) await git(repo, ['cherry-pick', '--abort']);
      else if (s.reverting) await git(repo, ['revert', '--abort']);
      else if (s.merging) await git(repo, ['merge', '--abort']);
      else throw new Error('No operation in progress');
    },

    async 'op.skip'({ repo }: { repo: string }) {
      return withConflicts(repo, () => git(repo, ['rebase', '--skip']));
    },

    // ------------------------------------------------------------- remotes
    async fetch({ repo, remote }: { repo: string; remote?: string }) {
      if (remote) {
        assertSafe(remote);
        await git(repo, ['fetch', '--prune', '--tags', remote], { timeout: NETWORK_TIMEOUT });
      } else {
        await git(repo, ['fetch', '--all', '--prune', '--tags'], { timeout: NETWORK_TIMEOUT });
      }
    },

    async pull({ repo, rebase }: { repo: string; rebase?: boolean }) {
      return withConflicts(repo, () => git(repo, ['pull', rebase ? '--rebase' : '--no-rebase'], { timeout: NETWORK_TIMEOUT }));
    },

    async push({
      repo,
      branch,
      remote,
      force,
      setUpstream,
    }: {
      repo: string;
      branch: string;
      remote?: string;
      force?: boolean;
      setUpstream?: boolean;
    }) {
      assertSafe(branch);
      const upstreamRemote = await configGet(repo, `branch.${branch}.remote`);
      const upstreamMerge = await configGet(repo, `branch.${branch}.merge`);
      const target = remote || upstreamRemote || (await firstRemote(repo));
      if (!target) throw new Error('This repository has no remotes. Add one first.');
      assertSafe(target);
      const dest = target === upstreamRemote && upstreamMerge ? upstreamMerge : `refs/heads/${branch}`;
      const args = ['push'];
      if (force) args.push('--force-with-lease');
      if (setUpstream || !upstreamRemote) args.push('--set-upstream');
      args.push(target, `refs/heads/${branch}:${dest}`);
      await git(repo, args, { timeout: NETWORK_TIMEOUT });
      return { remote: target };
    },

    async 'remote.add'({ repo, name, url }: { repo: string; name: string; url: string }) {
      assertSafe(name);
      assertSafe(url);
      await git(repo, ['remote', 'add', name, url]);
    },

    async 'remote.remove'({ repo, name }: { repo: string; name: string }) {
      assertSafe(name);
      await git(repo, ['remote', 'remove', name]);
    },

    // -------------------------------------------------------------- stashes
    async 'stash.list'({ repo }: { repo: string }): Promise<Stash[]> {
      const raw = await git(repo, ['stash', 'list', `--format=%gd%x1f%H%x1f%at%x1f%gs`]);
      return parseStashes(raw);
    },

    async 'stash.save'({
      repo,
      message,
      includeUntracked,
      keepIndex,
    }: {
      repo: string;
      message?: string;
      includeUntracked?: boolean;
      keepIndex?: boolean;
    }) {
      const args = ['stash', 'push'];
      if (includeUntracked) args.push('--include-untracked');
      if (keepIndex) args.push('--keep-index');
      if (message) args.push('-m', message);
      await git(repo, args);
    },

    async 'stash.apply'({ repo, ref, pop }: { repo: string; ref: string; pop?: boolean }) {
      assertStash(ref);
      return withConflicts(repo, () => git(repo, ['stash', pop ? 'pop' : 'apply', '--index', ref]).catch((e) => {
        // --index fails when the stashed index can't be restored cleanly; retry without it.
        if (e instanceof GitError && /--index|Conflicts in index/.test(e.message)) {
          return git(repo, ['stash', pop ? 'pop' : 'apply', ref]);
        }
        throw e;
      }));
    },

    async 'stash.drop'({ repo, ref }: { repo: string; ref: string }) {
      assertStash(ref);
      await git(repo, ['stash', 'drop', ref]);
    },

    async 'stash.diff'({ repo, ref }: { repo: string; ref: string }): Promise<FileDiff[]> {
      assertStash(ref);
      const raw = await git(repo, ['stash', 'show', '-p', '-M', '--include-untracked', '--no-ext-diff', ref], {
        maxBytes: MAX_DIFF_BYTES,
      });
      return parseDiff(raw);
    },

    // ----------------------------------------------------------------- tags
    async 'tag.create'({ repo, name, target, message }: { repo: string; name: string; target?: string; message?: string }) {
      assertSafe(name);
      const args = ['tag'];
      if (message) args.push('-a', '-m', message);
      args.push(name);
      if (target) {
        assertSafe(target);
        args.push(target);
      }
      await git(repo, args);
    },

    async 'tag.delete'({ repo, name }: { repo: string; name: string }) {
      assertSafe(name);
      await git(repo, ['tag', '-d', name]);
    },

    async 'tag.push'({ repo, name, remote }: { repo: string; name: string; remote?: string }) {
      assertSafe(name);
      const target = remote || (await firstRemote(repo));
      if (!target) throw new Error('This repository has no remotes.');
      assertSafe(target);
      await git(repo, ['push', target, `refs/tags/${name}`], { timeout: NETWORK_TIMEOUT });
    },

    async 'tag.deleteRemote'({ repo, name, remote }: { repo: string; name: string; remote: string }) {
      assertSafe(name);
      assertSafe(remote);
      await git(repo, ['push', remote, '--delete', `refs/tags/${name}`], { timeout: NETWORK_TIMEOUT });
    },

    // --------------------------------------------------------------- config
    async 'config.identity'({ repo }: { repo: string }) {
      const [name, email] = await Promise.all([configGet(repo, 'user.name'), configGet(repo, 'user.email')]);
      return { name: name ?? '', email: email ?? '' };
    },

    async 'config.setIdentity'({ repo, name, email, global }: { repo: string; name: string; email: string; global?: boolean }) {
      const scope = global ? ['--global'] : ['--local'];
      await git(repo, ['config', ...scope, 'user.name', name]);
      await git(repo, ['config', ...scope, 'user.email', email]);
    },

    // ---------------------------------------------------------------- shell
    async 'shell.reveal'({ repo, path: rel }: { repo: string; path?: string }) {
      const abs = rel ? insideRepo(repo, rel) : repo;
      if (process.platform === 'darwin') await run('open', ['-R', abs]);
      else if (process.platform === 'win32') await run('explorer', [`/select,${abs}`]);
      else await run('xdg-open', [path.dirname(abs)]);
    },

    async 'shell.open'({ repo, path: rel }: { repo: string; path?: string }) {
      const abs = rel ? insideRepo(repo, rel) : repo;
      if (process.platform === 'darwin') await run('open', [abs]);
      else if (process.platform === 'win32') await run('cmd', ['/c', 'start', '', abs]);
      else await run('xdg-open', [abs]);
    },

    async 'shell.terminal'({ repo }: { repo: string }) {
      if (process.platform === 'darwin') await run('open', ['-a', 'Terminal', repo]);
      else if (process.platform === 'win32') await run('cmd', ['/c', 'start', 'cmd', '/K', `cd /d "${repo}"`]);
      else await run('x-terminal-emulator', [`--working-directory=${repo}`]);
    },
  };

  async function firstRemote(repo: string): Promise<string | undefined> {
    const remotes = parseRemotes(await git(repo, ['remote', '-v']));
    return remotes.find((r) => r.name === 'origin')?.name ?? remotes[0]?.name;
  }

  return api;
}

// ----------------------------------------------------------------- helpers

/** Wrap a handler map so every handler validates its `repo` argument. */
export async function dispatch(api: Record<string, Handler>, method: string, args: unknown): Promise<unknown> {
  const handler = Object.prototype.hasOwnProperty.call(api, method) ? api[method] : undefined;
  if (!handler) throw new Error(`Unknown method: ${method}`);
  const a = (args ?? {}) as { repo?: unknown };
  if (a.repo !== undefined) {
    if (typeof a.repo !== 'string' || !path.isAbsolute(a.repo) || !existsSync(a.repo)) {
      throw new Error(`Repository folder not found: ${String(a.repo)}`);
    }
  }
  return handler(a);
}

function assertSafe(value: string) {
  if (typeof value !== 'string' || !value || value.startsWith('-') || value.includes('\0')) {
    throw new Error(`Invalid name: ${value}`);
  }
}

function assertStash(ref: string) {
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error(`Invalid stash: ${ref}`);
}

function insideRepo(repo: string, rel: string): string {
  const abs = path.resolve(repo, rel);
  if (abs !== repo && !abs.startsWith(repo + path.sep)) throw new Error(`Path is outside the repository: ${rel}`);
  return abs;
}

function expandHome(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

function stripComments(msg: string): string {
  return msg
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .trim();
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}
