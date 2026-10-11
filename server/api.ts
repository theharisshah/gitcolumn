import { randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AppInfo,
  Blame,
  Blob,
  BlobSpec,
  Commit,
  CommitDetail,
  FileCommit,
  FileDiff,
  FileSnapshot,
  FileStatus,
  LfsFile,
  LfsStatus,
  LineSelection,
  PatchAction,
  RebasePlan,
  RebasePlanCommit,
  RebaseStep,
  Ref,
  Remote,
  RepoInfo,
  RepoState,
  Snapshot,
  Stash,
  Status,
  Submodule,
} from '../shared/types.ts';
import { git, GitError, gitRaw, hashFiles, writeTree } from './git.ts';
import {
  FILE_LOG_FORMAT,
  FS,
  LOG_FORMAT,
  parseBlame,
  parseDiff,
  parseFileLog,
  parseLfsFiles,
  parseLfsPatterns,
  parseLog,
  parseRefs,
  parseRemotes,
  parseStashes,
  parseStatus,
  parseSubmodules,
  REF_FORMAT,
  RS,
} from './parse.ts';
import { buildPatch } from './patch.ts';
import { changedFiles } from './changes.ts';
import { filesApi } from './files.ts';
import { reflogApi } from './reflog.ts';
import { undoApi } from './undo.ts';
import { ignoreApi } from './ignore.ts';
import { annotateRefs, branchesApi, renameParent } from './branches.ts';
import { checkMerges, rebaseWithMerges } from './rebase.ts';
import { githubApi } from './github.ts';
import type { ApiCtx, HandlerModule } from './ctx.ts';
import {
  assertHash,
  assertRef,
  assertSafe,
  assertStash,
  expandHome,
  insideRepo,
  MAX_DIFF_BYTES,
  mimeType,
  NETWORK_TIMEOUT,
  readText,
  writablePath,
  run,
  shellQuote,
  stripComments,
} from './util.ts';

export interface Host {
  electron: boolean;
  /** Move files to the system trash. When absent, discarded untracked files are deleted. */
  trash?: (absPaths: string[]) => Promise<void>;
  /** Show a native folder picker. */
  pickDirectory?: (title?: string) => Promise<string | null>;
  /** Ask where to save a file. When absent, files are saved to ~/Downloads. */
  saveFile?: (opts: { title?: string; defaultName: string; filters?: { name: string; extensions: string[] }[] }) => Promise<string | null>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Handler = (args: any) => Promise<unknown>;

/** Feature modules (files, reflog, undo, branches, rebase, github) contributing handlers. */
const HANDLER_MODULES: HandlerModule[] = [filesApi, reflogApi, undoApi, ignoreApi, branchesApi, githubApi];

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
      // Some commands succeed yet leave conflicts (e.g. pull --rebase re-applying an autostash).
      const unmerged = await git(repo, ['diff', '--name-only', '--diff-filter=U']).catch(() => '');
      return unmerged.trim() ? { conflicts: true } : { conflicts: false };
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

  /** Diff output the parser and git apply can rely on, whatever the user's diff.* / color.* settings. */
  const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];

  /** The same selected lines (by line number and content) in a fresh diff of the file with 3 lines of context. */
  async function withContext(repo: string, diff: FileDiff, selection: LineSelection, action: PatchAction) {
    const key = (l: { type: string; oldNo?: number; newNo?: number }) => `${l.type}:${l.type === 'add' ? l.newNo : l.oldNo}`;
    const wanted = new Map<string, string>();
    diff.hunks.forEach((h, hi) => {
      const sel = selection[hi];
      if (!sel) return;
      h.lines.forEach((l, li) => {
        if (l.type !== 'context' && (sel === 'all' || sel.includes(li))) wanted.set(key(l), l.content);
      });
    });
    const staged = action === 'unstage';
    const file: FileStatus = { path: diff.newPath || diff.oldPath, index: staged ? 'M' : '.', worktree: staged ? '.' : 'M' };
    const fresh = await api['diff.working']({ repo, file, staged, context: 3 }) as FileDiff | null;
    const mapped: LineSelection = {};
    let found = 0;
    fresh?.hunks.forEach((h, hi) => {
      const idx = h.lines.flatMap((l, li) => (l.type !== 'context' && wanted.get(key(l)) === l.content ? [li] : []));
      found += idx.length;
      if (idx.length) mapped[hi] = idx;
    });
    if (!fresh || found !== wanted.size) throw new Error('The file changed since its changes were shown. Try again.');
    return { diff: fresh, selection: mapped };
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
      const commonDir = (await git(top, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => '')).trim();
      return { path: top, name: path.basename(top), commonDir: commonDir || undefined };
    },

    async 'repo.init'({ path: p }: { path: string }): Promise<RepoInfo> {
      const dir = expandHome(p);
      await fs.mkdir(dir, { recursive: true });
      await git(dir, ['init']);
      const real = await fs.realpath(dir);
      return { path: real, name: path.basename(real) };
    },

    async 'repo.clone'({ url, path: p }: { url: string; path: string }): Promise<RepoInfo> {
      const dir = expandHome(p);
      if (existsSync(dir) && (await fs.readdir(dir)).length > 0) throw new Error(`Destination is not empty: ${dir}`);
      await fs.mkdir(path.dirname(dir), { recursive: true });
      await git(path.dirname(dir), ['clone', '--', url, dir], { timeout: 60 * 60_000 });
      const real = await fs.realpath(dir);
      return { path: real, name: path.basename(real) };
    },

    // ----------------------------------------------------------- read state
    async status({ repo }: { repo: string }): Promise<Status> {
      return getStatus(repo);
    },

    async refs({ repo, plain }: { repo: string; plain?: boolean }): Promise<Ref[]> {
      const raw = await git(repo, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']);
      const refs = parseRefs(raw);
      // Pinned/archived/parent flags and branches checked out in other worktrees.
      return plain ? refs : annotateRefs(repo, refs);
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
        `--format=${['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%T', '%B'].join('%x1f')}`,
        hash,
      ]);
      const [h, parents, author, email, date, committer, committerEmail, committerDate, tree, ...msg] = raw.split(FS);
      const message = msg.join(FS).replace(/\s+$/, '');
      const nl = message.indexOf('\n');
      const parentList = parents ? parents.split(' ') : [];
      const files = await changedFiles(repo, parentList[0] ?? null, h);
      return {
        hash: h,
        tree,
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

    async 'commit.diff'({ repo, hash, parent, paths }: { repo: string; hash: string; parent?: string; paths?: string[] }): Promise<FileDiff[]> {
      assertSafe(hash);
      let args: string[];
      if (parent) {
        assertSafe(parent);
        args = ['diff', ...DIFF_FLAGS, '-M', parent, hash];
      } else {
        args = ['diff-tree', '-p', '-r', '--root', '--no-commit-id', ...DIFF_FLAGS, '-M', hash];
      }
      if (paths?.length) args.push('--', ...paths);
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
      // --no-textconv: these hunks are applied to the real file contents when staging lines.
      const opts = [...DIFF_FLAGS, '--no-textconv', `-U${Math.max(0, Math.min(Math.floor(context) || 0, 1_000_000))}`];
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
      const state = await repoState(repo);
      if (state.merging || state.cherryPicking || state.reverting || state.rebasing) {
        // `git reset` would also end the merge (or lose the conflict stages): unstage only resolved paths.
        const staged = (await getStatus(repo)).files.filter((f) => !f.conflicted && f.index !== '.');
        const paths = staged.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));
        if (paths.length) {
          await git(repo, ['restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: pathspecInput(paths) });
        }
        return;
      }
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
      unidiffZero,
    }: {
      repo: string;
      diff: FileDiff;
      selection: LineSelection;
      action: PatchAction;
      /** The diff was made without context lines (-U0) */
      unidiffZero?: boolean;
    }) {
      if (unidiffZero) {
        // Hunks without context are placed by line numbers alone, and git's --unidiff-zero matching is
        // ambiguous near an incomplete last line. Re-select the same lines in a fresh -U3 diff instead.
        ({ diff, selection } = await withContext(repo, diff, selection, action));
      }
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
    async commit({ repo, message, amend, signoff, only }: { repo: string; message: string; amend?: boolean; signoff?: boolean; only?: boolean }) {
      const args = ['commit', '-F', '-'];
      if (amend) args.push('--amend');
      // With --amend and no paths: change only the message, leaving staged changes alone.
      if (amend && only) args.push('--only');
      if (signoff) args.push('--signoff');
      await git(repo, args, { input: message });
    },

    /** The commit.template text without comment lines (git ignores templates when the message is passed with -F). */
    async 'commit.template'({ repo }: { repo: string }): Promise<string | null> {
      const file = (await git(repo, ['config', '--path', '--get', 'commit.template'], { okCodes: [1] })).trim();
      if (!file) return null;
      // --path already expanded "~"; relative paths are relative to the worktree, like git's own lookup.
      const text = await readText(path.resolve(repo, file));
      if (!text || text.length > 64 * 1024) return null;
      // core.commentString (git 2.45+) or core.commentChar, which may be several characters; "auto" means "#".
      const configured = (await configGet(repo, 'core.commentString')) ?? (await configGet(repo, 'core.commentChar')) ?? '#';
      const c = !configured || configured === 'auto' ? '#' : configured;
      const stripped = text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .filter((l) => !l.startsWith(c))
        .join('\n')
        .trim();
      return stripped || null;
    },

    /** Who the next commit will be attributed to (honours GIT_AUTHOR_* and config), or null when unset. */
    async 'identity.author'({ repo }: { repo: string }): Promise<{ name: string; email: string; configured: boolean } | null> {
      const ident = await git(repo, ['var', 'GIT_AUTHOR_IDENT']).catch(() => '');
      const m = /^(.*) <([^>]*)> \d+ [+-]\d{4}$/.exec(ident.trim()) ?? /^(.*?) <([^>]*)>/.exec(ident.trim());
      if (!m || !m[1] || !m[2]) return null;
      // Without user.name/user.email git may guess an identity from the system; the composer asks to set one.
      const [name, email] = await Promise.all([configGet(repo, 'user.name'), configGet(repo, 'user.email')]);
      const env = process.env.GIT_AUTHOR_NAME && process.env.GIT_AUTHOR_EMAIL;
      return { name: m[1], email: m[2], configured: !!env || (!!name && !!email) };
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
      await renameParent(repo, oldName, newName);
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

    /** Rebase the current branch onto `onto`; with `upstream`, only its commits after `upstream` (--onto). */
    async rebase({ repo, onto, upstream }: { repo: string; onto: string; upstream?: string }) {
      assertSafe(onto);
      if (upstream) {
        assertSafe(upstream);
        return withConflicts(repo, () => git(repo, ['rebase', '--onto', onto, upstream]));
      }
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

    async reset({ repo, hash, mode }: { repo: string; hash: string; mode: 'soft' | 'mixed' | 'hard' | 'keep' }) {
      assertSafe(hash);
      if (!['soft', 'mixed', 'hard', 'keep'].includes(mode)) throw new Error(`Invalid reset mode: ${mode}`);
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
    async fetch({ repo, remote, quiet }: { repo: string; remote?: string; quiet?: boolean }) {
      // Background fetches must never pop up credential prompts: an empty GIT_ASKPASS disables them.
      const env = quiet ? { GIT_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never' } : undefined;
      if (remote) {
        assertSafe(remote);
        await git(repo, ['fetch', '--prune', '--tags', remote], { timeout: NETWORK_TIMEOUT, env });
      } else {
        await git(repo, ['fetch', '--all', '--prune', '--tags'], { timeout: NETWORK_TIMEOUT, env });
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
      remoteBranch,
    }: {
      repo: string;
      branch: string;
      remote?: string;
      force?: boolean;
      setUpstream?: boolean;
      /** Push to a branch of another name on the remote ("Push To…") */
      remoteBranch?: string;
    }) {
      assertSafe(branch);
      const upstreamRemote = await configGet(repo, `branch.${branch}.remote`);
      const upstreamMerge = await configGet(repo, `branch.${branch}.merge`);
      const target = remote || upstreamRemote || (await firstRemote(repo));
      if (!target) throw new Error('This repository has no remotes. Add one first.');
      assertSafe(target);
      if (remoteBranch) assertSafe(remoteBranch);
      const dest = remoteBranch
        ? `refs/heads/${remoteBranch.replace(/^refs\/heads\//, '')}`
        : target === upstreamRemote && upstreamMerge
          ? upstreamMerge
          : `refs/heads/${branch}`;
      const args = ['push'];
      if (force) args.push('--force-with-lease');
      if (setUpstream || (!upstreamRemote && !remoteBranch)) args.push('--set-upstream');
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
      const raw = await git(repo, ['stash', 'show', '-p', '-M', '--include-untracked', ...DIFF_FLAGS, ref], {
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

    // -------------------------------------------------------- file history
    async 'file.history'({
      repo,
      path: p,
      rev,
      skip = 0,
      limit = 300,
    }: {
      repo: string;
      path: string;
      rev?: string | null;
      skip?: number;
      limit?: number;
    }): Promise<FileCommit[]> {
      if (rev) assertSafe(rev);
      else if (!(await headExists(repo))) return [];
      const raw = await git(repo, [
        'log',
        '--follow',
        '-M',
        '--name-status',
        `--format=${FILE_LOG_FORMAT}`,
        `--skip=${skip}`,
        `--max-count=${limit}`,
        rev || 'HEAD',
        '--',
        p,
      ]);
      return parseFileLog(raw, p);
    },

    async blame({ repo, path: p, rev }: { repo: string; path: string; rev?: string | null }): Promise<Blame> {
      const args = ['blame', '--porcelain'];
      if (rev) {
        assertSafe(rev);
        args.push(rev);
      }
      args.push('--', p);
      return parseBlame(await git(repo, args, { maxBytes: MAX_DIFF_BYTES }), p, rev ?? null);
    },

    /** Read a file version as a data URL (used for image diffs). Tries each revision in order. */
    async 'file.blob'({ repo, revs, path: p }: BlobSpec & { repo: string }): Promise<Blob | null> {
      const max = 15 * 1024 * 1024;
      for (const rev of revs) {
        try {
          let data: Buffer;
          if (rev === null) {
            const abs = insideRepo(repo, p);
            if ((await fs.stat(abs)).size > max) continue;
            data = await fs.readFile(abs);
          } else {
            if (rev !== ':') assertSafe(rev);
            const spec = rev === ':' ? `:${p}` : `${rev}:${p}`;
            const size = Number((await git(repo, ['cat-file', '-s', spec])).trim());
            if (size > max) continue;
            data = await gitRaw(repo, ['cat-file', 'blob', spec]);
          }
          return { dataUrl: `data:${mimeType(p)};base64,${data.toString('base64')}`, size: data.length };
        } catch {
          /* try the next revision */
        }
      }
      return null;
    },

    async 'gitignore.write'({ repo, content }: { repo: string; content: string }) {
      await fs.writeFile(path.join(repo, '.gitignore'), content.endsWith('\n') || !content ? content : content + '\n');
    },

    // ---------------------------------------------------- interactive rebase
    /** `checks: false` skips re-merging every merge (rebase.interactive checks the ones it recreates). */
    async 'rebase.plan'({ repo, base, checks = true }: { repo: string; base: string | null; checks?: boolean }): Promise<RebasePlan> {
      if (base) {
        assertSafe(base);
        try {
          await git(repo, ['merge-base', '--is-ancestor', base, 'HEAD']);
        } catch {
          throw new Error('That commit is not part of the current branch.');
        }
      }
      const range = base ? `${base}..HEAD` : 'HEAD';
      const fmt = ['%H', '%P', '%an', '%ae', '%at', '%s', '%b'].join('%x1f') + '%x1e';
      const [raw, unpushedRaw, baseHash, firstParent] = await Promise.all([
        git(repo, ['log', '--reverse', '--topo-order', `--format=${fmt}`, range, '--']),
        git(repo, ['rev-list', range, '--not', '--remotes']),
        base ? git(repo, ['rev-parse', '--verify', `${base}^{commit}`]).then((h) => h.trim()) : Promise.resolve(null),
        git(repo, ['rev-list', '--first-parent', range]),
      ]);
      const unpushed = new Set(unpushedRaw.split('\n').filter(Boolean));
      const mainline = new Set(firstParent.split('\n').filter(Boolean));
      const commits: RebasePlanCommit[] = raw
        .split(RS)
        .map((r) => r.replace(/^\n/, ''))
        .filter(Boolean)
        .map((r) => {
          const [hash, parents, author, email, date, subject, ...body] = r.split(FS);
          return {
            hash,
            parents: parents ? parents.split(' ') : [],
            author,
            email,
            date: Number(date),
            subject: subject ?? '',
            body: body.join(FS).trim(),
            pushed: !unpushed.has(hash),
            mainline: mainline.has(hash),
          };
        });
      const plan: RebasePlan = { base: baseHash, commits, hasMerges: commits.some((c) => c.parents.length > 1) };
      if (plan.hasMerges && checks) plan.merges = await checkMerges(repo, plan);
      return plan;
    },

    async 'rebase.interactive'({ repo, base, steps }: { repo: string; base: string | null; steps: RebaseStep[] }) {
      const actions = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];
      for (const s of steps) {
        if (!actions.includes(s.action)) throw new Error(`Invalid rebase action: ${s.action}`);
        if (!/^[0-9a-f]{7,64}$/.test(s.hash)) throw new Error(`Invalid commit: ${s.hash}`);
      }
      const firstKept = steps.find((s) => s.action !== 'drop');
      if (!firstKept) throw new Error('At least one commit must be kept.');
      if (firstKept.action === 'squash' || firstKept.action === 'fixup') {
        throw new Error('The first commit can’t be squashed — there is no earlier commit in the range to combine it with.');
      }
      const plan = (await api['rebase.plan']({ repo, base, checks: false })) as RebasePlan;
      if (plan.hasMerges) {
        if (steps.every((s, i) => s.action === 'pick' && s.hash === plan.commits[i]?.hash)) return { conflicts: false, paused: false };
        // Recreates the merges (git rebase --rebase-merges) instead of flattening them.
        return rebaseWithMerges({
          repo,
          base,
          steps,
          plan,
          gitDir: await gitDir(repo),
          withConflicts: (run) => withConflicts(repo, run),
          isRebasing: async () => (await repoState(repo)).rebasing,
        });
      }
      const planned = new Set(plan.commits.map((c) => c.hash));
      if (steps.length !== plan.commits.length || !steps.every((s) => planned.has(s.hash))) {
        throw new Error('The branch changed since the rebase was planned. Please try again.');
      }
      const unchanged = steps.every((s, i) => s.action === 'pick' && s.hash === plan.commits[i].hash);
      if (unchanged) return { conflicts: false, paused: false };

      // Message files must outlive this call: exec lines run later if the rebase stops.
      const dir = path.join(await gitDir(repo), 'gitcolumn-rebase');
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      const todo: string[] = [];
      for (const [i, s] of steps.entries()) {
        if (s.action === 'reword' && s.message?.trim()) {
          const msgFile = path.join(dir, `message-${i}.txt`);
          await fs.writeFile(msgFile, s.message.trim() + '\n');
          todo.push(`pick ${s.hash}`);
          todo.push(`exec git commit --amend --allow-empty --quiet --cleanup=whitespace -F ${shellQuote(msgFile)}`);
        } else {
          todo.push(`${s.action === 'reword' ? 'pick' : s.action} ${s.hash}`);
        }
      }
      const todoFile = path.join(dir, 'todo');
      await fs.writeFile(todoFile, todo.join('\n') + '\n');
      const result = await withConflicts(repo, () =>
        git(repo, ['rebase', '-i', '--autostash', base ?? '--root'], { env: { GIT_SEQUENCE_EDITOR: `cp ${shellQuote(todoFile)}` } }),
      );
      const state = await repoState(repo);
      return { ...result, paused: !result.conflicts && state.rebasing };
    },

    // ------------------------------------------------------------ snapshots
    /** Capture HEAD, the index and (optionally) working tree files so an operation can be undone. */
    async 'snapshot.capture'({ repo, paths }: { repo: string; paths?: string[] }): Promise<Snapshot> {
      const [head, branch, index] = await Promise.all([
        git(repo, ['rev-parse', '--verify', '-q', 'HEAD']).then((s) => s.trim() || null, () => null),
        // Not --short: that turns "main" into "heads/main" when a tag of the same name exists.
        git(repo, ['symbolic-ref', '-q', 'HEAD']).then((s) => s.trim().replace(/^refs\/heads\//, '') || null, () => null),
        // Throws (instead of a silent null) when another process holds index.lock: an undo
        // recorded without the index would quietly lose staged changes.
        writeTree(repo),
      ]);
      const snapshot: Snapshot = { head, branch, index };
      if (paths?.length) {
        const files: FileSnapshot[] = [];
        const existing: { path: string; mode: number }[] = [];
        for (const p of [...new Set(paths)]) {
          let st: import('node:fs').Stats | null = null;
          try {
            st = await fs.lstat(insideRepo(repo, p));
          } catch {
            st = null;
          }
          if (!st) files.push({ path: p, blob: null });
          else if (st.isFile()) existing.push({ path: p, mode: st.mode & 0o777 });
          // symlinks, directories and submodules are left out of the snapshot
        }
        if (existing.length) {
          const hashes = await hashFiles(repo, existing.map((e) => e.path), true);
          existing.forEach((e, i) => files.push({ path: e.path, blob: hashes[i], mode: e.mode }));
        }
        snapshot.files = files;
      }
      return snapshot;
    },

    async 'snapshot.restore'({ repo, snapshot, index = true }: { repo: string; snapshot: Snapshot; index?: boolean }) {
      const targets = await Promise.all((snapshot.files ?? []).map((f) => writablePath(repo, f.path)));
      for (const [i, f] of (snapshot.files ?? []).entries()) {
        const abs = targets[i];
        if (f.blob) {
          assertHash(f.blob);
          const data = await gitRaw(repo, ['cat-file', 'blob', f.blob]);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          // Write next to the file and rename into place, so a failed write (disk full…) never leaves it
          // truncated. A short name: a long file name plus a suffix could exceed the name length limit.
          const tmp = path.join(path.dirname(abs), `.gitcolumn-${randomUUID().slice(0, 8)}.tmp`);
          try {
            await fs.writeFile(tmp, data, { mode: f.mode ?? 0o644 });
            if (f.mode) await fs.chmod(tmp, f.mode);
            await fs.rename(tmp, abs);
          } catch (e) {
            await fs.rm(tmp, { force: true });
            throw e;
          }
        } else {
          await fs.rm(abs, { force: true });
        }
      }
      if (index && snapshot.index) {
        assertHash(snapshot.index);
        await git(repo, ['read-tree', snapshot.index]);
      }
    },

    async 'rev.parse'({ repo, rev }: { repo: string; rev: string }): Promise<string | null> {
      assertSafe(rev);
      return git(repo, ['rev-parse', '--verify', '-q', rev]).then((s) => s.trim() || null, () => null);
    },

    async 'ref.update'({ repo, ref, hash }: { repo: string; ref: string; hash: string }) {
      assertRef(ref);
      assertHash(hash);
      await git(repo, ['update-ref', ref, hash]);
    },

    async 'ref.delete'({ repo, ref }: { repo: string; ref: string }) {
      assertRef(ref);
      await git(repo, ['update-ref', '-d', ref]);
    },

    async 'stash.store'({ repo, hash, message }: { repo: string; hash: string; message: string }) {
      assertHash(hash);
      await git(repo, ['stash', 'store', '-m', message, hash]);
    },

    // ------------------------------------------------------------ submodules
    async submodules({ repo }: { repo: string }): Promise<Submodule[]> {
      if (!existsSync(path.join(repo, '.gitmodules'))) return [];
      const [config, status] = await Promise.all([
        git(repo, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url|branch)$'], { okCodes: [1] }),
        git(repo, ['submodule', 'status']).catch(() => ''),
      ]);
      return parseSubmodules(config, status);
    },

    async 'submodule.update'({ repo, path: p }: { repo: string; path?: string }) {
      const args = ['submodule', 'update', '--init', '--recursive'];
      if (p) args.push('--', p);
      await git(repo, args, { timeout: NETWORK_TIMEOUT });
    },

    async 'submodule.add'({ repo, url, path: p }: { repo: string; url: string; path: string }) {
      assertSafe(url);
      insideRepo(repo, p);
      await git(repo, ['submodule', 'add', '--', url, p], { timeout: NETWORK_TIMEOUT });
    },

    async 'submodule.sync'({ repo }: { repo: string }) {
      await git(repo, ['submodule', 'sync', '--recursive']);
    },

    // ------------------------------------------------------------------ LFS
    async 'lfs.status'({ repo }: { repo: string }): Promise<LfsStatus> {
      const [version, attrs] = await Promise.all([
        git(repo, ['lfs', 'version']).then((v) => v.trim(), () => null),
        readText(path.join(repo, '.gitattributes')),
      ]);
      return { installed: !!version, version: version ?? undefined, patterns: parseLfsPatterns(attrs ?? '') };
    },

    async 'lfs.files'({ repo }: { repo: string }): Promise<LfsFile[]> {
      return parseLfsFiles(await git(repo, ['lfs', 'ls-files', '--long']));
    },

    async 'lfs.install'({ repo }: { repo: string }) {
      await git(repo, ['lfs', 'install', '--local']);
    },

    async 'lfs.track'({ repo, pattern }: { repo: string; pattern: string }) {
      assertSafe(pattern);
      await git(repo, ['lfs', 'track', pattern]);
    },

    async 'lfs.untrack'({ repo, pattern }: { repo: string; pattern: string }) {
      assertSafe(pattern);
      await git(repo, ['lfs', 'untrack', pattern]);
    },

    async 'lfs.pull'({ repo }: { repo: string }) {
      await git(repo, ['lfs', 'pull'], { timeout: NETWORK_TIMEOUT });
    },

    async 'remote.setUrl'({ repo, name, url }: { repo: string; name: string; url: string }) {
      assertSafe(name);
      assertSafe(url);
      await git(repo, ['remote', 'set-url', name, url]);
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

  const ctx: ApiCtx = {
    host,
    gitDir,
    repoState,
    getStatus,
    withConflicts,
    headExists,
    configGet,
    firstRemote,
    call: <T,>(method: string, args: object) => api[method](args) as Promise<T>,
  };
  for (const mod of HANDLER_MODULES) Object.assign(api, mod(ctx));

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
