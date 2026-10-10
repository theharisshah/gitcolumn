// Persistent undo: a per-worktree journal of serializable undo specs, validated before they run.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Snapshot, UndoResult, UndoSpec, UndoState } from '../shared/types.ts';
import type { HandlerModule } from './ctx.ts';
import { git, GitError } from './git.ts';
import { assertHash, assertRef, assertSafe } from './util.ts';

interface Stored {
  id: string;
  label: string;
  createdAt: number;
  spec: UndoSpec;
}

const MAX_ENTRIES = 30;
const TTL_MS = 7 * 24 * 3600 * 1000; // below git's default 2-week prune of unreachable objects
export const STALE = 'The repository changed since then, so this can no longer be undone.';

export class StaleError extends Error {
  constructor(message = STALE) {
    super(message);
  }
}

const KINDS = new Set<UndoSpec['kind']>([
  'head-reset', 'commit', 'index', 'files', 'refs', 'checkout', 'branch-rename',
  'upstream', 'stash-save', 'stash-apply', 'stash-drop', 'remote-add', 'remote-remove',
]);

const CONFIG_KEY = /^branch\.[^\s]+\.(remote|merge|rebase|pushRemote|gitcolumn-[a-z-]+)$/;

/** Every object id a spec depends on, so a pruned snapshot is detected before anything runs. */
function objectsOf(spec: UndoSpec): string[] {
  const snap = (s: Snapshot) => [s.index, ...(s.files ?? []).map((f) => f.blob)];
  const ids: (string | null | undefined)[] = [];
  switch (spec.kind) {
    case 'head-reset':
      ids.push(spec.to, spec.index);
      break;
    case 'commit':
      ids.push(spec.to);
      break;
    case 'index':
      ids.push(spec.tree);
      break;
    case 'files':
      ids.push(...snap(spec.snapshot));
      break;
    case 'refs':
      ids.push(...spec.updates.map((u) => u.new));
      break;
    case 'checkout':
      ids.push(spec.from.head);
      break;
    case 'stash-save':
      break;
    case 'stash-apply':
      ids.push(...snap(spec.snapshot), spec.restore?.hash);
      break;
    case 'stash-drop':
      ids.push(spec.hash);
      break;
    default:
      break;
  }
  return ids.filter((x): x is string => !!x);
}

export const undoApi: HandlerModule = (ctx) => {
  const locks = new Map<string, Promise<unknown>>();

  /** Serialize journal access per repository. */
  function locked<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(repo) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(repo, next.catch(() => undefined));
    return next;
  }

  async function journalPath(repo: string) {
    return path.join(await ctx.gitDir(repo), 'gitcolumn', 'undo.json');
  }

  async function read(repo: string): Promise<Stored[]> {
    try {
      const data = JSON.parse(await fs.readFile(await journalPath(repo), 'utf8')) as { entries?: Stored[] };
      return Array.isArray(data.entries) ? data.entries : [];
    } catch {
      return [];
    }
  }

  async function write(repo: string, entries: Stored[]) {
    const file = await journalPath(repo);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, entries }, null, 1));
    await fs.rename(tmp, file);
  }

  const head = (repo: string) => git(repo, ['rev-parse', '--verify', '-q', 'HEAD']).then((s) => s.trim() || null, () => null);
  const branch = (repo: string) => git(repo, ['symbolic-ref', '-q', '--short', 'HEAD']).then((s) => s.trim() || null, () => null);

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

  async function refTransaction(repo: string, updates: { ref: string; old: string | null; new: string | null }[]) {
    const cmds: string[] = [];
    for (const u of updates) {
      assertRef(u.ref);
      if (u.old) assertHash(u.old);
      if (u.new) assertHash(u.new);
      if (u.new === null && u.old) cmds.push(`delete ${u.ref}`, u.old);
      else if (u.old === null && u.new) cmds.push(`create ${u.ref}`, u.new);
      else if (u.new && u.old) cmds.push(`update ${u.ref}`, u.new, u.old);
      else throw new Error('Invalid ref update');
    }
    try {
      // All updates are applied in one transaction, each only if the ref still has its expected value.
      await git(repo, ['update-ref', '--stdin', '-z'], { input: cmds.join('\0') + '\0' });
    } catch (e) {
      throw new StaleError(`${STALE}\n${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function setConfig(repo: string, entries: [string, string | null][]) {
    for (const [key, value] of entries) {
      if (!CONFIG_KEY.test(key)) throw new Error(`Config key not allowed: ${key}`);
      if (value === null) await git(repo, ['config', '--unset-all', key], { okCodes: [5] });
      else await git(repo, ['config', '--replace-all', key, value]);
    }
  }

  /** Files are always put back; the index only while HEAD is where it was (otherwise it would stage unrelated differences). */
  async function restoreSnapshot(repo: string, snapshot: Snapshot) {
    const index = !!snapshot.index && (await head(repo)) === snapshot.head;
    await ctx.call('snapshot.restore', { repo, snapshot, index });
  }

  async function deleteBranch(repo: string, name: string, hash: string) {
    assertSafe(name);
    await refTransaction(repo, [{ ref: `refs/heads/${name}`, old: hash, new: null }]);
    await git(repo, ['config', '--remove-section', `branch.${name}`], { okCodes: [1, 128] });
  }

  async function switchTo(repo: string, pos: { head: string | null; branch: string | null }) {
    if (pos.branch) {
      assertSafe(pos.branch);
      await git(repo, ['switch', '--no-guess', pos.branch]);
    } else if (pos.head) {
      assertHash(pos.head);
      await git(repo, ['switch', '--detach', pos.head]);
    }
  }

  async function execute(repo: string, spec: UndoSpec): Promise<string | undefined> {
    switch (spec.kind) {
      case 'head-reset': {
        await expect(repo, { head: spec.from, branch: spec.branch });
        assertHash(spec.to);
        await git(repo, ['reset', `--${spec.mode}`, spec.to]);
        if (spec.index) await git(repo, ['read-tree', spec.index]);
        return;
      }
      case 'commit': {
        await expect(repo, { head: spec.from, branch: spec.branch });
        if (spec.to) await git(repo, ['reset', '--soft', spec.to]);
        else if (spec.branch) await refTransaction(repo, [{ ref: `refs/heads/${spec.branch}`, old: spec.from, new: null }]); // back to an unborn branch
        return spec.message;
      }
      case 'index':
        await expect(repo, { head: spec.head });
        await git(repo, ['read-tree', spec.tree]);
        return;
      case 'files':
        await restoreSnapshot(repo, spec.snapshot);
        return;
      case 'refs':
        await refTransaction(repo, spec.updates);
        if (spec.config?.length) await setConfig(repo, spec.config);
        return;
      case 'checkout':
        await expect(repo, { head: spec.to.head, branch: spec.to.branch });
        await switchTo(repo, spec.from);
        if (spec.deleteBranch) await deleteBranch(repo, spec.deleteBranch.name, spec.deleteBranch.hash);
        return;
      case 'branch-rename': {
        assertSafe(spec.from);
        assertSafe(spec.to);
        const current = await git(repo, ['rev-parse', '--verify', '-q', `refs/heads/${spec.to}`]).then((s) => s.trim(), () => '');
        const taken = await git(repo, ['show-ref', '--verify', '-q', `refs/heads/${spec.from}`]).then(() => true, () => false);
        if (current !== spec.hash || taken) throw new StaleError();
        await git(repo, ['branch', '-m', spec.to, spec.from]);
        return;
      }
      case 'upstream':
        assertSafe(spec.branch);
        if (spec.previous) {
          assertSafe(spec.previous);
          await git(repo, ['branch', `--set-upstream-to=${spec.previous}`, spec.branch]);
        } else {
          await git(repo, ['branch', '--unset-upstream', spec.branch], { okCodes: [128] });
        }
        return;
      case 'stash-save': {
        const top = await git(repo, ['rev-parse', '--verify', '-q', 'refs/stash']).then((s) => s.trim(), () => '');
        if (top !== spec.hash) throw new StaleError();
        await ctx.call('stash.apply', { repo, ref: 'stash@{0}', pop: true });
        return;
      }
      case 'stash-apply':
        await restoreSnapshot(repo, spec.snapshot);
        if (spec.restore) await git(repo, ['stash', 'store', '-m', spec.restore.message, spec.restore.hash]);
        return;
      case 'stash-drop':
        assertHash(spec.hash);
        await git(repo, ['stash', 'store', '-m', spec.message, spec.hash]);
        return;
      case 'remote-add': {
        assertSafe(spec.name);
        const exists = await git(repo, ['remote', 'get-url', spec.name]).then(() => true, () => false);
        if (!exists) throw new StaleError();
        await git(repo, ['remote', 'remove', spec.name]);
        return;
      }
      case 'remote-remove': {
        assertSafe(spec.name);
        assertSafe(spec.url);
        const exists = await git(repo, ['remote', 'get-url', spec.name]).then(() => true, () => false);
        if (exists) throw new StaleError();
        await git(repo, ['remote', 'add', spec.name, spec.url]);
        return;
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

  return {
    async 'undo.push'({ repo, label, spec }: { repo: string; label: string; spec: UndoSpec }): Promise<UndoState> {
      if (!spec || typeof spec !== 'object' || !KINDS.has(spec.kind)) throw new Error('Invalid undo spec');
      return locked(repo, async () => {
        const entries = fresh(await read(repo));
        entries.push({ id: randomUUID(), label: String(label).slice(0, 200), createdAt: Date.now(), spec });
        const kept = entries.slice(-MAX_ENTRIES);
        await write(repo, kept);
        return state(kept);
      });
    },

    async 'undo.state'({ repo }: { repo: string }): Promise<UndoState> {
      return state(fresh(await read(repo)));
    },

    async 'undo.run'({ repo }: { repo: string }): Promise<UndoResult & { state: UndoState }> {
      return locked(repo, async () => {
        const all = await read(repo);
        const entries = fresh(all);
        const entry = entries.pop();
        if (!entry) {
          if (all.length !== entries.length) await write(repo, entries);
          throw new Error(all.length ? 'The last undoable operation is more than 7 days old.' : 'Nothing to undo.');
        }
        try {
          if (!(await objectsExist(repo, objectsOf(entry.spec)))) throw new StaleError('The saved state for this undo is no longer available.');
          const restoreMessage = await execute(repo, entry.spec);
          await write(repo, entries);
          return { label: entry.label, restoreMessage, state: state(entries) };
        } catch (e) {
          // Only a git command refusing (e.g. local changes in the way) is worth retrying;
          // stale or invalid entries can never succeed and would block everything below them.
          const retry = e instanceof GitError && !(e instanceof StaleError);
          await write(repo, retry ? [...entries, entry] : entries);
          throw e;
        }
      });
    },

    async 'undo.clear'({ repo }: { repo: string }) {
      await locked(repo, () => write(repo, []));
    },

    /** branch.<name>.* settings worth restoring when an undo recreates the branch. */
    async 'config.branchEntries'({ repo, branch: name }: { repo: string; branch: string }): Promise<[string, string][]> {
      assertSafe(name);
      const out = await git(repo, ['config', '-z', '--get-regexp', `^branch\\.${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`], { okCodes: [1] });
      return out
        .split('\0')
        .filter(Boolean)
        .map((rec): [string, string] => {
          const nl = rec.indexOf('\n');
          return [rec.slice(0, nl), rec.slice(nl + 1)];
        })
        .filter(([k]) => CONFIG_KEY.test(k));
    },
  };
};
