// Persistent undo: a per-worktree journal of serializable undo specs, validated before they run.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Snapshot, UndoResult, UndoSpec, UndoState } from '../shared/types.ts';
import type { HandlerModule } from './ctx.ts';
import { git, GitError, gitRaw, hashFiles, IndexLockedError, writeTree } from './git.ts';
import { branchesInUse, renameParent } from './branches.ts';
import { ignoreFile } from './ignore.ts';
import { assertHash, assertRef, assertSafe, insideRepo } from './util.ts';

/**
 * What a path holds: a blob id, null (absent), 'link' (a symbolic link), 'dir' (a folder) or
 * '!' (anything else, e.g. a parent folder turned into a file).
 */
type PathState = string | null;

interface Guard {
  /** `git write-tree` right after the operation (null with conflicts, '?' when it couldn't be read) */
  index?: string | null;
  files?: { path: string; state: PathState }[];
}

interface Stored {
  id: string;
  label: string;
  createdAt: number;
  spec: UndoSpec;
  guard?: Guard;
}

const MAX_ENTRIES = 30;
const TTL_MS = 7 * 24 * 3600 * 1000;
const JOURNAL_VERSION = 2;
/** A lock file not touched for this long belongs to a crashed process (holders refresh it every few seconds). */
const LOCK_STALE_MS = 15_000;
const LOCK_HEARTBEAT_MS = 4_000;
const LOCK_WAIT_MS = 30_000;
export const STALE = 'The repository changed since then, so this can no longer be undone.';

/** The undo can never succeed; the entry is dropped. */
export class StaleError extends Error {
  constructor(message = STALE) {
    super(message);
  }
}

/** A temporary obstacle (a lock held by another git process…); the entry is kept for another try. */
class RetryableError extends Error {}

/** Something the user can change is in the way (edited files, the branch is checked out); the entry is kept. */
class BlockedError extends Error {}

const KINDS = new Set<UndoSpec['kind']>([
  'head-reset', 'commit', 'index', 'files', 'refs', 'checkout', 'branch-rename',
  'upstream', 'stash-save', 'stash-apply', 'stash-drop', 'remote-add', 'remote-remove', 'ignore', 'multi',
]);

// git prints config variable names in lower case, so compare case-insensitively.
const BRANCH_KEY = /^branch\.[^\s]+\.(remote|merge|rebase|pushremote|gitcolumn-[a-z-]+)$/i;
// Not uploadpack/receivepack/proxy/vcs: those run programs or redirect traffic, so they are never written back.
const REMOTE_KEY = (name: string) =>
  new RegExp(
    `^remote\\.${escapeRegExp(name)}\\.(url|pushurl|fetch|push|tagopt|prune|prunetags|mirror|skipdefaultupdate|skipfetchall|followremotehead|promisor|partialclonefilter|serveroption|lfsurl|lfspushurl|gh-resolved)$`,
    'i',
  );
const LINK_KEY = /^(branch\.[^\s]+\.(remote|merge|pushremote)|remote\.pushdefault)$/i;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * git refusals caused by local state the user can change (edits in the way, a merge in progress) or by
 * another git process holding a lock: keep the entry, the undo can work later. Anything else is final.
 */
const TRANSIENT = new RegExp(
  [
    'would be overwritten', 'your local changes', 'untracked working tree files would be', 'commit your changes or stash them',
    'not uptodate', 'cannot switch branch', 'already exists, no checkout', 'would lose untracked', 'would be removed by',
    'in the middle of a merge', 'resolve your current index first', 'needs merge', 'unmerged files',
    'already used by worktree', 'is already checked out at',
    "\\.lock'?: file exists", "unable to create '[^']*\\.lock'", 'could not lock config file', 'another git process',
    'unable to write new index file', 'no space left on device',
  ].join('|'),
  'i',
);
const TRANSIENT_FS = new Set(['EACCES', 'EPERM', 'EBUSY', 'ENOSPC', 'EMFILE', 'EAGAIN']);

function isRetryable(e: unknown): boolean {
  if (e instanceof StaleError) return false;
  if (e instanceof RetryableError || e instanceof BlockedError || e instanceof IndexLockedError) return true;
  if (e instanceof GitError) return TRANSIENT.test(`${e.message}\n${e.stderr}`);
  return TRANSIENT_FS.has((e as NodeJS.ErrnoException)?.code ?? '');
}

/** Commits and tags a spec brings back; they may be old enough for gc to prune once unreachable. */
function revivedObjects(spec: UndoSpec): string[] {
  const ids: (string | null | undefined)[] = [];
  if (spec.kind === 'refs') ids.push(...spec.updates.map((u) => u.new));
  else if (spec.kind === 'stash-drop') ids.push(spec.hash);
  else if (spec.kind === 'stash-apply') ids.push(spec.restore?.hash);
  else if (spec.kind === 'checkout') ids.push(spec.from.head);
  else if (spec.kind === 'head-reset') ids.push(spec.to);
  else if (spec.kind === 'commit') ids.push(spec.to);
  else if (spec.kind === 'multi') ids.push(...spec.steps.flatMap(revivedObjects));
  return ids.filter((x): x is string => !!x);
}

/** Every object id a spec depends on, so a pruned object is detected before anything runs. */
function objectsOf(spec: UndoSpec): string[] {
  const snap = (s: Snapshot) => [s.index, ...(s.files ?? []).map((f) => f.blob)];
  const ids: (string | null | undefined)[] = [...revivedObjects(spec)];
  if (spec.kind === 'head-reset') ids.push(spec.index);
  else if (spec.kind === 'index') ids.push(spec.tree);
  else if (spec.kind === 'files' || spec.kind === 'stash-apply') ids.push(...snap(spec.snapshot));
  else if (spec.kind === 'ignore') ids.push(spec.index);
  else if (spec.kind === 'multi') ids.push(...spec.steps.flatMap(objectsOf));
  return ids.filter((x): x is string => !!x);
}

/** Cheap structural checks; executors validate every value they pass to git. */
function validate(spec: UndoSpec) {
  if (!spec || typeof spec !== 'object' || !KINDS.has(spec.kind)) throw new Error('Invalid undo spec');
  if (spec.kind === 'head-reset' && spec.mode !== 'keep' && spec.mode !== 'soft') throw new Error('Invalid reset mode');
  if ((spec.kind === 'files' || spec.kind === 'stash-apply') && !Array.isArray(spec.snapshot?.files ?? [])) throw new Error('Invalid snapshot');
  if (spec.kind === 'refs' && !Array.isArray(spec.updates)) throw new Error('Invalid ref updates');
  if ((spec.kind === 'upstream' || spec.kind === 'remote-remove') && !Array.isArray(spec.config)) throw new Error('Invalid config');
  if (spec.kind === 'ignore' && (!['gitignore', 'exclude'].includes(spec.file) || typeof spec.after !== 'string')) throw new Error('Invalid ignore spec');
  if (spec.kind === 'multi') {
    if (!Array.isArray(spec.steps) || !spec.steps.length) throw new Error('Invalid undo spec');
    // Only steps that are safe to run one after another (and resume).
    for (const step of spec.steps) {
      if (step.kind !== 'refs' && step.kind !== 'head-reset') throw new Error('Invalid undo spec');
      validate(step);
    }
  }
}

function validEntry(e: unknown): e is Stored {
  const s = e as Stored;
  return (
    !!s &&
    typeof s === 'object' &&
    typeof s.id === 'string' &&
    typeof s.label === 'string' &&
    Number.isFinite(s.createdAt) &&
    !!s.spec &&
    KINDS.has(s.spec.kind)
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const undoApi: HandlerModule = (ctx) => {
  const locks = new Map<string, Promise<unknown>>();

  /** Not cached: a path can be reused by another repository or worktree while the app runs. */
  async function journalPath(repo: string) {
    const dir = (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim();
    return path.join(dir, 'gitcolumn', 'undo.json');
  }

  /** Serialize journal access: per journal file within this process, and with a lock file across processes. */
  async function locked<T>(repo: string, fn: (file: string) => Promise<T>): Promise<T> {
    const file = await journalPath(repo);
    const prev = locks.get(file) ?? Promise.resolve();
    const run = async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const lock = `${file}.lock`;
      const token = randomUUID();
      const started = Date.now();
      for (;;) {
        try {
          await fs.writeFile(lock, token, { flag: 'wx' });
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
          const st = await fs.stat(lock).catch(() => null);
          if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
            // Left by a crashed process. Only remove the lock we judged stale, not one someone took meanwhile.
            const owner = await fs.readFile(lock, 'utf8').catch(() => null);
            const again = await fs.stat(lock).catch(() => null);
            if (owner !== null && again && again.mtimeMs === st.mtimeMs && (await fs.readFile(lock, 'utf8').catch(() => null)) === owner) {
              await fs.rm(lock, { force: true });
            }
          }
          else if (Date.now() - started > LOCK_WAIT_MS) throw new RetryableError('The undo history is busy. Try again in a moment.');
          else await sleep(25);
        }
      }
      // Keep the lock fresh while a slow undo runs (hooks, big checkouts), so nobody takes it as stale.
      const heartbeat = setInterval(() => {
        const now = new Date();
        fs.utimes(lock, now, now).catch(() => undefined);
      }, LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
      try {
        return await fn(file);
      } finally {
        clearInterval(heartbeat);
        // Only remove our own lock.
        if ((await fs.readFile(lock, 'utf8').catch(() => '')) === token) await fs.rm(lock, { force: true });
      }
    };
    const next = prev.then(run, run);
    locks.set(file, next.catch(() => undefined));
    return next;
  }

  async function read(file: string): Promise<Stored[]> {
    let text: string;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new RetryableError(`Couldn't read the undo history: ${(e as Error).message}`);
    }
    try {
      const data = JSON.parse(text) as { version?: number; entries?: unknown[] };
      // Older journals lack the guards that make undo safe; they are not used.
      if (data.version !== JOURNAL_VERSION || !Array.isArray(data.entries)) return [];
      return data.entries.filter(validEntry);
    } catch {
      return [];
    }
  }

  async function write(file: string, entries: Stored[]) {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: JOURNAL_VERSION, entries }, null, 1));
    await fs.rename(tmp, file);
  }

  const head = (repo: string) => git(repo, ['rev-parse', '--verify', '-q', 'HEAD']).then((s) => s.trim() || null, () => null);
  // Not --short: that yields "heads/main" when a tag named "main" exists.
  const branch = (repo: string) =>
    git(repo, ['symbolic-ref', '-q', 'HEAD']).then((s) => s.trim().replace(/^refs\/heads\//, '') || null, () => null);
  const branchExists = (repo: string, name: string) =>
    git(repo, ['show-ref', '--verify', '-q', `refs/heads/${name}`]).then(() => true, () => false);

  async function expect(repo: string, pos: { head?: string | null; branch?: string | null }) {
    if (pos.head !== undefined && (await head(repo)) !== pos.head) throw new StaleError();
    if (pos.branch !== undefined && (await branch(repo)) !== pos.branch) throw new StaleError();
  }

  async function objectsExist(repo: string, ids: string[]): Promise<boolean> {
    if (!ids.length) return true;
    ids.forEach(assertHash);
    const out = await git(repo, ['cat-file', '--batch-check'], { input: ids.join('\n') + '\n' });
    return !/ missing$/m.test(out);
  }

  /**
   * Re-write existing objects so git counts them as recent: gc keeps recent unreachable objects and
   * everything reachable from them, so a dropped stash or deleted branch survives the undo window.
   */
  async function freshen(repo: string, ids: string[]) {
    for (const id of new Set(ids)) {
      try {
        assertHash(id);
        const type = (await git(repo, ['cat-file', '-t', id])).trim();
        if (type !== 'commit' && type !== 'tag') continue;
        await git(repo, ['hash-object', '-w', '-t', type, '--stdin'], { input: await gitRaw(repo, ['cat-file', type, id]) });
      } catch {
        /* best effort */
      }
    }
  }

  /** Current state of working tree paths, comparable with snapshot blobs (same --no-filters hashing). */
  async function pathStates(repo: string, paths: string[]): Promise<PathState[]> {
    const states: PathState[] = [];
    const files: { i: number; path: string }[] = [];
    for (const [i, p] of paths.entries()) {
      let st: import('node:fs').Stats | null = null;
      let state: PathState = null;
      try {
        st = await fs.lstat(insideRepo(repo, p));
        state = st.isFile() ? '' : st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : '!';
      } catch (e) {
        // A parent that is now a file (ENOTDIR) is not "absent": writing there would fail.
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') state = '!';
      }
      states.push(state);
      if (st?.isFile()) files.push({ i, path: p });
    }
    if (files.length) (await hashFiles(repo, files.map((f) => f.path))).forEach((h, k) => (states[files[k].i] = h));
    return states;
  }

  async function guardFor(repo: string, spec: UndoSpec): Promise<Guard | undefined> {
    const guard: Guard = {};
    if (spec.kind === 'index' || spec.kind === 'files' || spec.kind === 'stash-apply' || ((spec.kind === 'head-reset' || spec.kind === 'ignore') && spec.index)) {
      try {
        guard.index = await writeTree(repo);
      } catch (e) {
        // Without the staging area the undo of a stage or reset is meaningless; others can skip the index.
        if (!(e instanceof IndexLockedError) || spec.kind === 'index' || spec.kind === 'head-reset') throw e;
        guard.index = '?';
      }
    }
    if (spec.kind === 'files' || spec.kind === 'stash-apply') {
      const paths = (spec.snapshot.files ?? []).map((f) => f.path);
      const states = await pathStates(repo, paths);
      guard.files = paths.map((p, i) => ({ path: p, state: states[i] }));
    }
    return Object.keys(guard).length ? guard : undefined;
  }

  /** Refuse to overwrite files changed since the operation (files already back in the old state are fine). */
  /** Returns links to remove before writing (the operation created them where files were). */
  async function checkFiles(repo: string, snapshot: Snapshot, guard: Guard | undefined): Promise<string[]> {
    const files = snapshot.files ?? [];
    if (!guard?.files) return [];
    const after = new Map(guard.files.map((f) => [f.path, f.state]));
    const states = await pathStates(repo, files.map((f) => f.path));
    // All paths are checked before anything is written.
    const unlink: string[] = [];
    files.forEach((f, i) => {
      const now = states[i];
      const was = after.get(f.path);
      if (now === f.blob) return; // already back
      // The operation left a link (or a folder) here; the undo may replace a link, or write where it was removed.
      if (was === 'link' && (now === 'link' || now === null)) {
        if (now === 'link') unlink.push(f.path);
        return;
      }
      if (was === 'dir' && now === null) return;
      if (now === 'dir' || now === '!' || (now === 'link' && was !== 'link')) {
        throw new BlockedError(`"${f.path}" is now ${now === 'dir' ? 'a folder' : now === 'link' ? 'a link' : 'in the way'}, so it can't be restored.`);
      }
      if (now !== was) throw new BlockedError(`"${f.path}" was changed since then, and undoing would overwrite those changes.`);
    });
    return unlink;
  }

  /** Put files back; the index too while HEAD and the staging area are as the operation left them. Returns a note when the index was left alone. */
  async function restoreSnapshot(repo: string, snapshot: Snapshot, guard: Guard | undefined): Promise<string | undefined> {
    const unlink = await checkFiles(repo, snapshot, guard);
    let index = !!snapshot.index;
    let note: string | undefined;
    if (index) {
      const tree = await writeTree(repo);
      const unknown = guard?.index === '?';
      if (tree !== snapshot.index && (unknown || (await head(repo)) !== snapshot.head || (guard?.index !== undefined && tree !== guard.index))) {
        index = false;
        note = 'The staging area changed since then, so it was left as it is.';
      }
    }
    for (const p of unlink) await fs.unlink(insideRepo(repo, p));
    await ctx.call('snapshot.restore', { repo, snapshot, index });
    return note;
  }

  /** The index must be as the operation left it before restoring an older one over it. */
  async function checkIndex(repo: string, target: string, guard: Guard | undefined) {
    const tree = await writeTree(repo);
    if (tree === target) return;
    if (tree === null) throw new BlockedError('There are unresolved conflicts. Finish or abort the merge first.');
    if (guard?.index === undefined) return;
    if (guard.index === '?' || tree !== guard.index) {
      throw new BlockedError('Changes were staged or unstaged since then, and undoing would replace them.');
    }
  }

  /** Would this step of a multi undo run? Throws the error its execution would, without changing anything. */
  async function precheck(repo: string, step: UndoSpec) {
    if (step.kind === 'refs') {
      const now = await Promise.all(step.updates.map((u) => git(repo, ['rev-parse', '--verify', '-q', u.ref]).then((s) => s.trim() || null, () => null)));
      if (step.updates.every((u, i) => now[i] === u.new)) return;
      if (step.updates.some((u, i) => now[i] !== u.old && now[i] !== u.new)) throw new StaleError();
      const inUse = await branchesInUse(repo);
      const busy = step.updates.find((u, i) => u.old !== null && now[i] !== u.new && inUse.has(u.ref));
      if (busy) throw new BlockedError(`${busy.ref.replace(/^refs\/heads\//, '')} is checked out (or being rebased), so it can't be moved yet. Switch away from it, then undo.`);
    } else if (step.kind === 'head-reset') {
      const h = await head(repo);
      if (h !== step.from && h !== step.to) throw new StaleError();
      if ((await branch(repo)) !== step.branch) throw new StaleError();
    }
  }

  /** Returns 'already' when every ref was already at its target (a resumed undo, or the user did it). */
  async function refTransaction(repo: string, updates: { ref: string; old: string | null; new: string | null }[]): Promise<'already' | void> {
    if (!updates.length) return;
    // Resuming after a partial run: nothing to do if every ref is already where the undo wants it.
    const now = await Promise.all(updates.map((u) => git(repo, ['rev-parse', '--verify', '-q', u.ref]).then((s) => s.trim() || null, () => null)));
    if (updates.every((u, i) => now[i] === u.new)) return 'already';
    const cmds: string[] = [];
    // A branch that is checked out (or being rebased) somewhere must not be moved or deleted under it:
    // its working tree would no longer match.
    const inUse = updates.some((u, i) => u.old !== null && now[i] !== u.new) ? await branchesInUse(repo) : new Set<string>();
    for (const [i, u] of updates.entries()) {
      assertRef(u.ref);
      if (u.old) assertHash(u.old);
      if (u.new) assertHash(u.new);
      if (u.old !== null && now[i] !== u.new && inUse.has(u.ref)) {
        const name = u.ref.replace(/^refs\/heads\//, '');
        throw new BlockedError(`${name} is checked out (or being rebased), so it can't be ${u.new === null ? 'deleted' : 'moved'} yet. Switch away from it, then undo.`);
      }
      if (u.new === null && u.old) cmds.push(`delete ${u.ref}`, u.old);
      else if (u.old === null && u.new) cmds.push(`create ${u.ref}`, u.new);
      else if (u.new && u.old) cmds.push(`update ${u.ref}`, u.new, u.old);
      else throw new Error('Invalid ref update');
    }
    try {
      // One transaction; each ref only changes if it still has its expected value.
      await git(repo, ['update-ref', '--stdin', '-z'], { input: cmds.join('\0') + '\0' });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (TRANSIENT.test(`${detail}\n${e instanceof GitError ? e.stderr : ''}`)) throw new RetryableError(detail);
      throw new StaleError(`${STALE}\n${detail}`);
    }
  }

  async function setConfig(repo: string, entries: [string, string | null][], allowed: (key: string) => boolean = (k) => BRANCH_KEY.test(k)) {
    for (const [key, value] of entries) {
      if (!allowed(key)) throw new Error(`Config key not allowed: ${key}`);
      if (value === null) await git(repo, ['config', '--unset-all', key], { okCodes: [5] });
      else await git(repo, ['config', '--replace-all', key, value]);
    }
  }

  async function filterUnset(repo: string, entries: [string, string | null][]) {
    const out: [string, string | null][] = [];
    for (const e of entries) if ((await ctx.configGet(repo, e[0])) === undefined) out.push(e);
    return out;
  }

  async function deleteBranch(repo: string, name: string, hash: string) {
    assertSafe(name);
    await refTransaction(repo, [{ ref: `refs/heads/${name}`, old: hash, new: null }]);
    await git(repo, ['config', '--remove-section', `branch.${name}`], { okCodes: [1, 128] });
  }

  async function execute(repo: string, spec: UndoSpec, guard: Guard | undefined): Promise<Omit<UndoResult, 'label'>> {
    switch (spec.kind) {
      case 'head-reset': {
        assertHash(spec.to);
        // HEAD already at the target means an earlier attempt got halfway: only the index is left to do.
        const resumed = (await head(repo)) === spec.to;
        await expect(repo, resumed ? { branch: spec.branch } : { head: spec.from, branch: spec.branch });
        if (spec.index) {
          assertHash(spec.index);
          await checkIndex(repo, spec.index, guard);
        }
        if (!resumed) await git(repo, ['reset', spec.mode === 'soft' ? '--soft' : '--keep', spec.to]);
        if (spec.index) await git(repo, ['read-tree', spec.index]);
        return {};
      }
      case 'commit': {
        await expect(repo, { head: spec.from, branch: spec.branch });
        if (spec.to) {
          assertHash(spec.to);
          await git(repo, ['reset', '--soft', spec.to]);
        } else if (spec.branch) {
          // Back to an unborn branch: only the ref goes (compare-and-swap), the index keeps the changes.
          // Not refTransaction: deleting the checked-out branch is exactly the point here.
          assertSafe(spec.branch);
          assertHash(spec.from);
          await git(repo, ['update-ref', '-d', `refs/heads/${spec.branch}`, spec.from]).catch((e) => {
            const detail = e instanceof Error ? e.message : String(e);
            if (TRANSIENT.test(`${detail}\n${e instanceof GitError ? e.stderr : ''}`)) throw new RetryableError(detail);
            throw new StaleError(`${STALE}\n${detail}`);
          });
        }
        return { restoreMessage: spec.message };
      }
      case 'index': {
        await expect(repo, { head: spec.head });
        assertHash(spec.tree);
        if ((await writeTree(repo)) === spec.tree) return {};
        await checkIndex(repo, spec.tree, guard);
        await git(repo, ['read-tree', spec.tree]);
        return {};
      }
      case 'files':
        return { note: await restoreSnapshot(repo, spec.snapshot, guard) };
      case 'refs': {
        const already = (await refTransaction(repo, spec.updates)) === 'already';
        // When the refs were already in place, don't overwrite settings the user may have made since.
        const config = already && spec.config ? await filterUnset(repo, spec.config) : spec.config;
        if (config?.length) await setConfig(repo, config);
        return {};
      }
      case 'checkout': {
        // Already back where we came from (an earlier attempt got halfway): only the branch deletion is left.
        const resumed = spec.from.branch ? (await branch(repo)) === spec.from.branch : !!spec.from.head && (await head(repo)) === spec.from.head && !(await branch(repo));
        if (resumed) {
          if (spec.deleteBranch) await deleteBranch(repo, spec.deleteBranch.name, spec.deleteBranch.hash);
          return {};
        }
        await expect(repo, { head: spec.to.head, branch: spec.to.branch });
        if (spec.from.branch) {
          assertSafe(spec.from.branch);
          if (!spec.from.head) throw new StaleError(`Can't switch back to ${spec.from.branch}: it has no commits yet.`);
          if (!(await branchExists(repo, spec.from.branch))) throw new StaleError(`The branch ${spec.from.branch} no longer exists.`);
          await git(repo, ['switch', '--no-guess', spec.from.branch]);
        } else if (spec.from.head) {
          assertHash(spec.from.head);
          await git(repo, ['switch', '--detach', spec.from.head]);
        }
        if (spec.deleteBranch) await deleteBranch(repo, spec.deleteBranch.name, spec.deleteBranch.hash);
        return {};
      }
      case 'branch-rename': {
        assertSafe(spec.from);
        assertSafe(spec.to);
        const at = (name: string) => git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${name}`]).then((s) => s.trim(), () => '');
        const [current, original] = [await at(spec.to), await at(spec.from)];
        if (!current && original === spec.hash) {
          // An earlier attempt renamed the branch but couldn't move its settings ("update of config-file failed").
          await git(repo, ['config', '--rename-section', `branch.${spec.to}`, `branch.${spec.from}`], { okCodes: [1, 128] });
          return {};
        }
        if (current !== spec.hash || original) throw new StaleError();
        await git(repo, ['branch', '-m', spec.to, spec.from]);
        await renameParent(repo, spec.to, spec.from);
        return {};
      }
      case 'upstream': {
        assertSafe(spec.branch);
        const prefix = `branch.${spec.branch}.`.toLowerCase();
        // Raw config values: the old upstream may no longer exist as a remote-tracking branch.
        await setConfig(repo, spec.config, (k) => k.toLowerCase() === `${prefix}remote` || k.toLowerCase() === `${prefix}merge`);
        return {};
      }
      case 'stash-save': {
        assertHash(spec.hash);
        const top = await git(repo, ['rev-parse', '--verify', '-q', 'refs/stash']).then((s) => s.trim(), () => '');
        if (top !== spec.hash) throw new StaleError();
        try {
          const r = await ctx.call<{ conflicts?: boolean }>('stash.apply', { repo, ref: 'stash@{0}', pop: true });
          return { conflicts: !!r?.conflicts };
        } catch (e) {
          // A failed pop may have applied part of the stash, so retrying could apply it twice. The stash
          // itself stays in the list, so nothing is lost by not keeping this entry.
          throw new StaleError(`Couldn't put the changes back: ${e instanceof Error ? e.message : String(e)} The stash is still in the list.`);
        }
      }
      case 'stash-apply': {
        if (spec.restore) {
          // Bring the stash back first, even if the files can't be restored: after a pop,
          // this entry is the only thing that still knows the stash.
          assertHash(spec.restore.hash);
          const listed = await git(repo, ['log', '-g', '--format=%H', 'refs/stash']).catch(() => '');
          if (!listed.split('\n').includes(spec.restore.hash)) await git(repo, ['stash', 'store', '-m', spec.restore.message, spec.restore.hash]);
        }
        try {
          return { note: await restoreSnapshot(repo, spec.snapshot, guard) };
        } catch (e) {
          if (spec.restore && e instanceof Error) e.message += ' The stash is back in the list.';
          throw e;
        }
      }
      case 'stash-drop': {
        assertHash(spec.hash);
        const listed = await git(repo, ['log', '-g', '--format=%H', 'refs/stash']).catch(() => '');
        if (listed.split('\n').includes(spec.hash)) throw new StaleError('That stash is already in the list.');
        await git(repo, ['stash', 'store', '-m', spec.message, spec.hash]);
        return {};
      }
      case 'remote-add': {
        assertSafe(spec.name);
        const exists = await git(repo, ['remote', 'get-url', spec.name]).then(() => true, () => false);
        if (!exists) throw new StaleError();
        await git(repo, ['remote', 'remove', spec.name]);
        return {};
      }
      case 'remote-remove': {
        assertSafe(spec.name);
        const remoteKey = REMOTE_KEY(spec.name);
        const url = spec.config.find(([k]) => k.toLowerCase() === `remote.${spec.name}.url`.toLowerCase())?.[1];
        const existing = await configEntries(repo, `^remote\\.${escapeRegExp(spec.name)}\\.`);
        if (existing.length) {
          // Resuming is fine when it's this remote coming back (same URL); anything else is someone else's remote.
          const existingUrl = existing.find(([k]) => k.toLowerCase() === `remote.${spec.name}.url`.toLowerCase())?.[1];
          if (!url || existingUrl !== url) throw new StaleError(`A remote named ${spec.name} exists again.`);
        }
        const have = new Set(existing.map(([k, v]) => `${k.toLowerCase()}\0${v}`));
        const skipped: string[] = [];
        for (const [key, value] of spec.config) {
          if (remoteKey.test(key)) {
            if (!have.has(`${key.toLowerCase()}\0${value}`)) await git(repo, ['config', '--add', key, value]);
          } else if (LINK_KEY.test(key)) {
            // Re-link branches (and pushDefault) to this remote, unless they point somewhere else by now.
            if ((await ctx.configGet(repo, key)) === undefined) await git(repo, ['config', key, value]);
          } else {
            skipped.push(key);
          }
        }
        // Remote-tracking branches come back too when their commits are still around (a fetch restores the rest).
        const prefix = `refs/remotes/${spec.name}/`;
        const refs = (spec.refs ?? []).filter(([ref]) => ref.startsWith(prefix) && !ref.includes('..'));
        const plain = refs.filter(([, oid]) => /^[0-9a-f]{40,64}$/.test(oid));
        if (plain.length) {
          const present = (await git(repo, ['cat-file', '--batch-check'], { input: plain.map(([, oid]) => oid).join('\n') + '\n' })).split('\n');
          const cmds = plain.flatMap(([ref, oid], i) => (/ missing$/.test(present[i] ?? '') ? [] : [`create ${ref}`, oid]));
          if (cmds.length) await git(repo, ['update-ref', '--stdin', '-z'], { input: cmds.join('\0') + '\0' }).catch(() => undefined);
        }
        for (const [ref, target] of refs) {
          const to = target.startsWith('ref:') ? target.slice(4) : '';
          if (to.startsWith(prefix) && !to.includes('..')) await git(repo, ['symbolic-ref', ref, to]).catch(() => undefined);
        }
        return skipped.length ? { note: `Not restored (not allowed): ${skipped.join(', ')}` } : {};
      }
      case 'multi': {
        // Check every step before changing anything, so a refusal never leaves the undo half done.
        for (const step of spec.steps) await precheck(repo, step);
        // In order; each step resumes (refs already in place, HEAD already reset) if an earlier try got halfway.
        for (const step of spec.steps) await execute(repo, step, undefined);
        return {};
      }
      case 'ignore': {
        await expect(repo, { head: spec.head });
        const file = await ignoreFile(repo, spec.file);
        const current = await fs.readFile(file, 'utf8').catch(() => null);
        const name = spec.file === 'gitignore' ? '.gitignore' : '.git/info/exclude';
        if (current !== spec.after && current !== spec.before) {
          throw new BlockedError(`${name} was changed since then. Edit it by hand, or skip this undo.`);
        }
        if (spec.index) {
          assertHash(spec.index);
          await checkIndex(repo, spec.index, guard);
        }
        if (current !== spec.before) {
          if (spec.before === null) await fs.rm(file, { force: true });
          else {
            // Through a symlinked info/exclude (or .gitignore) to its target, keeping the link.
            const real = await fs.realpath(file).catch(() => file);
            const tmp = path.join(path.dirname(real), `.gitcolumn-${randomUUID().slice(0, 8)}.tmp`);
            await fs.writeFile(tmp, spec.before);
            await fs.rename(tmp, real);
          }
        }
        if (spec.index) await git(repo, ['read-tree', spec.index]);
        return {};
      }
      default: {
        const unknown: never = spec;
        throw new Error(`Unknown undo kind: ${(unknown as { kind: string }).kind}`);
      }
    }
  }

  const state = (entries: Stored[]): UndoState => {
    const top = entries[entries.length - 1];
    return { count: entries.length, top: top ? { id: top.id, label: top.label, createdAt: top.createdAt } : null };
  };
  const fresh = (entries: Stored[]) => entries.filter((e) => Date.now() - e.createdAt < TTL_MS);

  const configEntries = async (repo: string, pattern: string): Promise<[string, string][]> => {
    const out = await git(repo, ['config', '-z', '--get-regexp', pattern], { okCodes: [1] });
    return out
      .split('\0')
      .filter(Boolean)
      .map((rec): [string, string] => {
        const nl = rec.indexOf('\n');
        return nl < 0 ? [rec, ''] : [rec.slice(0, nl), rec.slice(nl + 1)];
      });
  };

  return {
    async 'undo.push'({ repo, label, spec }: { repo: string; label: string; spec: UndoSpec }): Promise<UndoState> {
      validate(spec);
      // Captured now, right after the operation: what the undo may overwrite later.
      const guard = await guardFor(repo, spec);
      await freshen(repo, revivedObjects(spec));
      return locked(repo, async (file) => {
        const entries = fresh(await read(file));
        entries.push({ id: randomUUID(), label: String(label).slice(0, 200), createdAt: Date.now(), spec, guard });
        const kept = entries.slice(-MAX_ENTRIES);
        await write(file, kept);
        return state(kept);
      });
    },

    async 'undo.state'({ repo }: { repo: string }): Promise<UndoState> {
      return state(fresh(await read(await journalPath(repo))));
    },

    /** Undo the newest entry (only if it is `id`, when given). */
    async 'undo.run'({ repo, id }: { repo: string; id?: string }): Promise<UndoResult & { state: UndoState }> {
      return locked(repo, async (file) => {
        const all = await read(file);
        const entries = fresh(all);
        const entry = entries[entries.length - 1];
        if (!entry) {
          if (all.length !== entries.length) await write(file, entries);
          throw new Error(all.length ? 'The last undoable operation is more than 7 days old.' : 'Nothing to undo.');
        }
        if (id && entry.id !== id) throw new Error('The undo history changed in the meantime. Nothing was undone.');
        // At most once: the entry leaves the journal before it runs and only comes back if retrying can help.
        entries.pop();
        await write(file, entries);
        try {
          if (!(await objectsExist(repo, objectsOf(entry.spec)))) throw new StaleError('The saved state for this undo is no longer available.');
          const result = await execute(repo, entry.spec, entry.guard);
          return { label: entry.label, ...result, state: state(entries) };
        } catch (e) {
          if (isRetryable(e)) {
            try {
              await write(file, [...entries, entry]);
            } catch (w) {
              if (e instanceof Error) e.message += ` (It couldn't be kept for another try: ${(w as Error).message})`;
            }
          }
          throw e;
        }
      });
    },

    /** Drop one entry without running it (for an undo that keeps failing). */
    async 'undo.drop'({ repo, id }: { repo: string; id: string }): Promise<UndoState> {
      return locked(repo, async (file) => {
        const entries = fresh(await read(file)).filter((e) => e.id !== id);
        await write(file, entries);
        return state(entries);
      });
    },

    async 'undo.clear'({ repo }: { repo: string }) {
      await locked(repo, (file) => write(file, []));
    },

    /** branch.<name>.* settings worth restoring when an undo recreates the branch. */
    async 'config.branchEntries'({ repo, branch: name }: { repo: string; branch: string }): Promise<[string, string][]> {
      assertSafe(name);
      // Only branch.<name>.<var>: the pattern also matches the settings of e.g. "<name>.2".
      const prefix = `branch.${name}.`.toLowerCase();
      return (await configEntries(repo, `^branch\\.${escapeRegExp(name)}\\.`)).filter(
        ([k]) => BRANCH_KEY.test(k) && k.toLowerCase().startsWith(prefix) && !k.slice(prefix.length).includes('.'),
      );
    },

    /** Everything `git remote remove <name>` deletes from the config, for undoing it. */
    async 'config.remoteEntries'({ repo, name }: { repo: string; name: string }): Promise<[string, string][]> {
      assertSafe(name);
      const remoteKey = REMOTE_KEY(name);
      // Everything, even keys that won't be written back, so the undo can say what it left out.
      void remoteKey;
      const own = await configEntries(repo, `^remote\\.${escapeRegExp(name)}\\.`);
      const pointing = (await configEntries(repo, '^(branch\\..*\\.(remote|pushremote)|remote\\.pushdefault)$')).filter(([, v]) => v === name);
      const linked: [string, string][] = [];
      for (const [key, value] of pointing) {
        linked.push([key, value]);
        if (/\.remote$/i.test(key)) {
          const mergeKey = key.replace(/\.remote$/i, '.merge');
          const merge = await ctx.configGet(repo, mergeKey);
          if (merge !== undefined) linked.push([mergeKey, merge]);
        }
      }
      return [...own, ...linked];
    },

    /** Remote-tracking refs of a remote, for restoring them when its removal is undone. */
    async 'refs.remoteTracking'({ repo, name }: { repo: string; name: string }): Promise<[string, string][]> {
      assertSafe(name);
      const out = await git(repo, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', `refs/remotes/${name}/`]);
      // Leave out the refs of nested remotes ("origin/fork" next to "origin").
      const nested = (await git(repo, ['remote']).catch(() => '')).split('\n').filter((r) => r.startsWith(`${name}/`));
      return out
        .split('\n')
        .filter(Boolean)
        .map((l): [string, string] => {
          const [ref, oid, symref] = l.split('\0');
          return [ref, symref ? `ref:${symref}` : oid];
        })
        .filter(([ref]) => !nested.some((n) => ref.startsWith(`refs/remotes/${n}/`)));
    },
  };
};
