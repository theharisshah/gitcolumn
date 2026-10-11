// Branches Review, pinned/archived flags, stacked branches, worktrees and comparisons.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { BranchReviewRow, Commit, FileDiff, Ref, Worktree } from '../shared/types.ts';
import type { HandlerModule } from './ctx.ts';
import { git, GitError } from './git.ts';
import { LOG_FORMAT, parseDiff, parseLog } from './parse.ts';
import { assertHash, assertSafe, expandHome } from './util.ts';

const FS = '\x1f';
const FLAG = /^branch\.(.+)\.gitcolumn-(pinned|archived|parent|parent-base|restack-pending)$/i;

/** Branches git considers in use: checked out, or being rebased or bisected, in any worktree. */
export async function branchesInUse(repo: string): Promise<Set<string>> {
  const used = new Set<string>();
  const current = await git(repo, ['symbolic-ref', '-q', 'HEAD']).then((s) => s.trim(), () => '');
  if (current) used.add(current);
  const list = await git(repo, ['worktree', 'list', '--porcelain']).catch(() => '');
  for (const line of list.split('\n')) if (line.startsWith('branch ')) used.add(line.slice('branch '.length).trim());
  const common = path.resolve(repo, (await git(repo, ['rev-parse', '--git-common-dir'])).trim());
  const linked = await fs.readdir(path.join(common, 'worktrees')).catch(() => [] as string[]);
  for (const dir of [common, ...linked.map((n) => path.join(common, 'worktrees', n))]) {
    for (const f of ['rebase-merge/head-name', 'rebase-apply/head-name']) {
      const name = (await fs.readFile(path.join(dir, f), 'utf8').catch(() => '')).trim();
      if (name.startsWith('refs/heads/')) used.add(name);
    }
    // Branches a `rebase --update-refs` will move when it finishes.
    const updateRefs = await fs.readFile(path.join(dir, 'rebase-merge', 'update-refs'), 'utf8').catch(() => '');
    for (const line of updateRefs.split('\n')) if (line.startsWith('refs/heads/')) used.add(line.trim());
    const bisect = (await fs.readFile(path.join(dir, 'BISECT_START'), 'utf8').catch(() => '')).trim();
    if (bisect && !/^[0-9a-f]{40,64}$/.test(bisect)) used.add(`refs/heads/${bisect}`);
  }
  return used;
}

export function parseWorktrees(raw: string, currentPath: string): Worktree[] {
  const out: Worktree[] = [];
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n').filter(Boolean);
    const first = lines.find((l) => l.startsWith('worktree '));
    if (!first) continue;
    const wt: Worktree = { path: first.slice('worktree '.length), head: null, branch: null, bare: false, detached: false, current: false };
    for (const l of lines) {
      if (l.startsWith('HEAD ')) wt.head = l.slice(5);
      else if (l.startsWith('branch ')) wt.branch = l.slice(7).replace(/^refs\/heads\//, '');
      else if (l === 'bare') wt.bare = true;
      else if (l === 'detached') wt.detached = true;
      else if (l.startsWith('locked')) wt.locked = l.slice(6).trim() || 'locked';
      else if (l.startsWith('prunable')) wt.prunable = l.slice(8).trim() || 'prunable';
    }
    wt.current = path.resolve(wt.path) === path.resolve(currentPath);
    out.push(wt);
  }
  return out;
}

/** Children of a renamed branch follow it (their gitcolumn-parent setting names the old name). */
export async function renameParent(repo: string, from: string, to: string) {
  const out = await git(repo, ['config', '-z', '--get-regexp', '^branch\\..*\\.gitcolumn-parent$'], { okCodes: [1] });
  for (const rec of out.split('\0')) {
    const nl = rec.indexOf('\n');
    if (nl < 0 || rec.slice(nl + 1) !== from) continue;
    await git(repo, ['config', '--replace-all', rec.slice(0, nl), to]);
  }
}

/** GitColumn's per-branch flags and parents, plus where other worktrees have branches checked out. */
export async function annotateRefs(repo: string, refs: Ref[]): Promise<Ref[]> {
  const [config, worktrees, top] = await Promise.all([
    git(repo, ['config', '-z', '--get-regexp', '^branch\\..*\\.gitcolumn-'], { okCodes: [1] }),
    git(repo, ['worktree', 'list', '--porcelain']).catch(() => ''),
    git(repo, ['rev-parse', '--show-toplevel']).then((s) => s.trim(), () => repo),
  ]);
  const flags = new Map<string, { pinned?: boolean; archived?: boolean; parent?: string }>();
  for (const rec of config.split('\0')) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const key = nl < 0 ? rec : rec.slice(0, nl);
    const value = nl < 0 ? 'true' : rec.slice(nl + 1);
    const m = FLAG.exec(key);
    if (!m) continue;
    const f = flags.get(m[1]) ?? {};
    const what = m[2].toLowerCase();
    if (what === 'pinned') f.pinned = value !== 'false';
    else if (what === 'archived') f.archived = value !== 'false';
    else if (what === 'parent') f.parent = value;
    flags.set(m[1], f);
  }
  const elsewhere = new Map<string, string>();
  for (const wt of parseWorktrees(worktrees, top)) if (wt.branch && !wt.current) elsewhere.set(wt.branch, wt.path);
  return refs.map((r) => {
    if (r.type !== 'head') return r;
    const f = flags.get(r.name);
    const wt = elsewhere.get(r.name);
    return f || wt ? { ...r, ...f, ...(wt ? { worktree: wt } : {}) } : r;
  });
}

async function supportsAheadBehind(repo: string): Promise<boolean> {
  const v = /(\d+)\.(\d+)/.exec(await git(repo, ['version']));
  return !!v && (Number(v[1]) > 2 || (Number(v[1]) === 2 && Number(v[2]) >= 41));
}

export const branchesApi: HandlerModule = (ctx) => {
  const revParse = (repo: string, rev: string) => git(repo, ['rev-parse', '--verify', '-q', `${rev}^{commit}`]).then((s) => s.trim() || null, () => null);

  const setConfig = async (repo: string, key: string, value: string | null) => {
    if (value === null) await git(repo, ['config', '--unset-all', key], { okCodes: [5] });
    else await git(repo, ['config', '--replace-all', key, value]);
  };

  /** Descendants of a branch in its stack, parents before children. */
  async function stackBelow(repo: string, branch: string): Promise<string[]> {
    const refs = await annotateRefs(repo, (await ctx.call<Ref[]>('refs', { repo, plain: true })).filter((r) => r.type === 'head'));
    const children = new Map<string, string[]>();
    for (const r of refs) if (r.parent) children.set(r.parent, [...(children.get(r.parent) ?? []), r.name]);
    const order: string[] = [];
    const seen = new Set<string>([branch]);
    const queue = [...(children.get(branch) ?? [])];
    while (queue.length) {
      const b = queue.shift()!;
      if (seen.has(b)) continue; // a cycle in hand-edited config
      seen.add(b);
      order.push(b);
      queue.push(...(children.get(b) ?? []));
    }
    return order;
  }

  return {
    /** The branch to compare others with: origin's default branch, then main/master, then init.defaultBranch. */
    async 'branches.defaultBase'({ repo }: { repo: string }): Promise<string | null> {
      // Full names, stripped by hand: --short can answer "remotes/origin/main" when a tag or branch has the same name.
      const remoteHead = await git(repo, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD']).then((s) => s.trim().replace(/^refs\/remotes\//, ''), () => '');
      // origin/HEAD can point at a branch that was deleted since.
      if (remoteHead && (await revParse(repo, `refs/remotes/${remoteHead}`))) return remoteHead;
      for (const name of ['main', 'master', (await ctx.configGet(repo, 'init.defaultBranch')) ?? '']) {
        if (name && (await revParse(repo, `refs/heads/${name}`))) return name;
      }
      return git(repo, ['symbolic-ref', '-q', 'HEAD']).then((s) => s.trim().replace(/^refs\/heads\//, '') || null, () => null);
    },

    /** Every branch compared with `base`: commits ahead/behind, merged, last commit, flags. */
    async 'branches.review'({ repo, base, includeRemote }: { repo: string; base: string; includeRemote?: boolean }): Promise<BranchReviewRow[]> {
      assertSafe(base);
      // A branch name means that branch, even if a tag has the same name (git's own lookup prefers tags).
      const baseSha = (await revParse(repo, `refs/heads/${base}`)) ?? (await revParse(repo, `refs/remotes/${base}`)) ?? (await revParse(repo, base));
      if (!baseSha) throw new Error(`Unknown base: ${base}`);
      const patterns = includeRemote ? ['refs/heads', 'refs/remotes'] : ['refs/heads'];
      const fast = await supportsAheadBehind(repo);
      const fields = ['%(refname)', '%(objectname)', '%(committerdate:unix)', '%(authorname)', '%(contents:subject)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(HEAD)', '%(symref)'];
      if (fast) fields.push(`%(ahead-behind:${baseSha})`);
      const [raw, merged, refs] = await Promise.all([
        git(repo, ['for-each-ref', `--format=${fields.join('%1f')}`, ...patterns]),
        git(repo, ['for-each-ref', `--merged=${baseSha}`, '--format=%(refname)', ...patterns]),
        annotateRefs(repo, (await ctx.call<Ref[]>('refs', { repo, plain: true })).filter((r) => r.type === 'head')),
      ]);
      const mergedSet = new Set(merged.split('\n').filter(Boolean));
      const meta = new Map(refs.map((r) => [r.ref, r]));
      const rows: BranchReviewRow[] = [];
      for (const line of raw.split('\n')) {
        if (!line) continue;
        const [ref, hash, date, author, subject, upstream, track, head, symref, ab] = line.split(FS);
        if (symref) continue;
        const type = ref.startsWith('refs/heads/') ? 'head' : 'remote';
        const name = ref.replace(/^refs\/(heads|remotes)\//, '');
        let ahead = 0;
        let behind = 0;
        if (fast && ab) [ahead, behind] = ab.split(' ').map(Number);
        else {
          const counts = await git(repo, ['rev-list', '--left-right', '--count', `${hash}...${baseSha}`]);
          [ahead, behind] = counts.trim().split(/\s+/).map(Number);
        }
        const m = meta.get(ref);
        rows.push({
          name,
          ref,
          type,
          hash,
          ahead,
          behind,
          merged: mergedSet.has(ref),
          date: Number(date) || 0,
          author,
          subject,
          ...(upstream ? { upstream } : {}),
          ...(track === 'gone' ? { gone: true } : {}),
          ...(head === '*' ? { current: true } : {}),
          ...(m?.worktree ? { worktree: m.worktree } : {}),
          ...(m?.pinned ? { pinned: true } : {}),
          ...(m?.archived ? { archived: true } : {}),
          ...(m?.parent ? { parent: m.parent } : {}),
        });
      }
      return rows;
    },

    /**
     * Delete local branches in one compare-and-swap transaction (each only if it is still at the
     * given commit). Returns what an undo needs, including each branch's settings.
     */
    async 'branches.deleteMany'({
      repo,
      branches,
      base,
    }: {
      repo: string;
      branches: { name: string; hash: string }[];
      base?: string;
    }): Promise<{ deleted: { name: string; hash: string; config: [string, string][] }[] }> {
      if (!Array.isArray(branches) || !branches.length) return { deleted: [] };
      const inUse = await branchesInUse(repo);
      const refs = await annotateRefs(repo, (await ctx.call<Ref[]>('refs', { repo, plain: true })).filter((r) => r.type === 'head'));
      const byName = new Map(refs.map((r) => [r.name, r]));
      for (const b of branches) {
        assertSafe(b.name);
        assertHash(b.hash);
        if (inUse.has(`refs/heads/${b.name}`)) throw new Error(`${b.name} is checked out, so it can't be deleted.`);
        if (byName.get(b.name)?.pinned) throw new Error(`${b.name} is pinned. Unpin it first.`);
        // With a remote base (origin/main), the local branch of the same name is protected too.
        const baseLocal = base?.replace(/^refs\/(heads|remotes)\//, '').replace(/^[^/]+\//, '');
        if (base && (b.name === base || `refs/heads/${b.name}` === base || (base.includes('/') && b.name === baseLocal && !(await revParse(repo, `refs/heads/${base}`))))) {
          throw new Error(`${b.name} is the base branch.`);
        }
      }
      const deleted: { name: string; hash: string; config: [string, string][] }[] = [];
      for (const b of branches) {
        deleted.push({ name: b.name, hash: b.hash, config: await ctx.call<[string, string][]>('config.branchEntries', { repo, branch: b.name }) });
      }
      const cmds = branches.flatMap((b) => [`delete refs/heads/${b.name}`, b.hash]);
      try {
        await git(repo, ['update-ref', '--stdin', '-z'], { input: cmds.join('\0') + '\0' });
      } catch (e) {
        throw new Error(`Some branches changed since the list was loaded; nothing was deleted. Refresh and try again.\n${e instanceof Error ? e.message : e}`);
      }
      for (const b of branches) await git(repo, ['config', '--remove-section', `branch.${b.name}`], { okCodes: [1, 128] });
      return { deleted };
    },

    async 'branch.setFlag'({ repo, branch, flag, value }: { repo: string; branch: string; flag: 'pinned' | 'archived'; value: boolean }) {
      assertSafe(branch);
      if (flag !== 'pinned' && flag !== 'archived') throw new Error('Unknown flag');
      await setConfig(repo, `branch.${branch}.gitcolumn-${flag}`, value ? 'true' : null);
    },

    /** Record (or clear) the branch a branch is stacked on, and the parent commit it starts from. */
    async 'branch.setParent'({ repo, branch, parent }: { repo: string; branch: string; parent: string | null }) {
      assertSafe(branch);
      if (parent === null) {
        await setConfig(repo, `branch.${branch}.gitcolumn-parent`, null);
        await setConfig(repo, `branch.${branch}.gitcolumn-parent-base`, null);
        return;
      }
      assertSafe(parent);
      if (parent === branch) throw new Error('A branch can’t be its own parent.');
      // Unchanged: keep the recorded base (it may be an older parent commit, after the parent was amended).
      if ((await ctx.configGet(repo, `branch.${branch}.gitcolumn-parent`)) === parent) return;
      const below = await stackBelow(repo, branch);
      if (below.includes(parent)) throw new Error(`${parent} is stacked on ${branch}; that would make a loop.`);
      const mergeBase = (await git(repo, ['merge-base', `refs/heads/${parent}`, `refs/heads/${branch}`]).catch(() => '')).trim();
      if (!mergeBase) throw new Error(`${branch} and ${parent} have no common history.`);
      await setConfig(repo, `branch.${branch}.gitcolumn-parent`, parent);
      await setConfig(repo, `branch.${branch}.gitcolumn-parent-base`, mergeBase);
    },

    /** Create a branch on top of `parent` (its tip) and remember the parent. */
    async 'branch.createStacked'({ repo, name, parent, checkout = true }: { repo: string; name: string; parent: string; checkout?: boolean }) {
      assertSafe(name);
      assertSafe(parent);
      const tip = await revParse(repo, `refs/heads/${parent}`);
      if (!tip) throw new Error(`${parent} is not a local branch.`);
      if (checkout) await git(repo, ['switch', '--no-guess', '-c', name, tip]);
      else await git(repo, ['branch', name, tip]);
      await setConfig(repo, `branch.${name}.gitcolumn-parent`, parent);
      await setConfig(repo, `branch.${name}.gitcolumn-parent-base`, tip);
    },

    /**
     * Move a stacked branch (and optionally everything stacked on it) onto its parent's current tip:
     * `git rebase --onto <parent> <recorded base> <branch>` replays only the branch's own commits,
     * even after the parent was amended or rebased. Stops at the first conflict (the branch is marked
     * so its base is corrected once the rebase is finished); on other failures it returns to where it
     * started. Always reports what moved, so it can be undone.
     */
    async 'branch.restack'({
      repo,
      branch,
      children,
    }: {
      repo: string;
      branch: string;
      children?: boolean;
    }): Promise<{
      moved: { name: string; old: string; new: string; oldBase: string | null }[];
      conflicts: boolean;
      stoppedAt?: string;
      error?: string;
      original: string | null;
    }> {
      assertSafe(branch);
      // Not --short: that gives "heads/x" when a tag named x exists.
      const original = await git(repo, ['symbolic-ref', '-q', 'HEAD']).then((s) => s.trim().replace(/^refs\/heads\//, '') || null, () => null);
      const originalHead = await git(repo, ['rev-parse', '--verify', '-q', 'HEAD']).then((s) => s.trim() || null, () => null);
      const order = [branch, ...(children ? await stackBelow(repo, branch) : [])];
      const moved: { name: string; old: string; new: string; oldBase: string | null }[] = [];
      const goBack = async () => {
        const now = await git(repo, ['rev-parse', '--verify', '-q', 'HEAD']).then((s) => s.trim() || null, () => null);
        const nowBranch = await git(repo, ['symbolic-ref', '-q', 'HEAD']).then((s) => s.trim().replace(/^refs\/heads\//, '') || null, () => null);
        if (original && nowBranch !== original) await git(repo, ['switch', '--no-guess', original]);
        else if (!original && originalHead && (nowBranch || now !== originalHead)) await git(repo, ['switch', '--detach', originalHead]);
      };
      try {
        for (const b of order) {
          const parent = await ctx.configGet(repo, `branch.${b}.gitcolumn-parent`);
          if (!parent) {
            if (b === branch) throw new Error(`${b} isn't stacked on another branch. Use “Track Parent Branch…” first.`);
            continue;
          }
          const parentTip = await revParse(repo, `refs/heads/${parent}`);
          if (!parentTip) throw new Error(`The parent branch ${parent} no longer exists.`);
          const tip = (await revParse(repo, `refs/heads/${b}`))!;
          // A restack that stopped at a conflict and was finished since: the branch is now on that parent commit.
          const pending = await ctx.configGet(repo, `branch.${b}.gitcolumn-restack-pending`);
          if (pending) {
            const finished = await git(repo, ['merge-base', '--is-ancestor', pending, tip]).then(() => true, () => false);
            if (finished) await setConfig(repo, `branch.${b}.gitcolumn-parent-base`, pending);
            await setConfig(repo, `branch.${b}.gitcolumn-restack-pending`, null);
          }
          const recorded = (await ctx.configGet(repo, `branch.${b}.gitcolumn-parent-base`)) ?? null;
          const recordedOk = recorded && /^[0-9a-f]{40,64}$/.test(recorded) && (await revParse(repo, recorded));
          const base = recordedOk ? recorded! : (await git(repo, ['merge-base', `refs/heads/${parent}`, `refs/heads/${b}`])).trim();
          if (base === parentTip) continue; // already on top of its parent
          const result = await ctx.withConflicts(repo, () => git(repo, ['rebase', '--onto', parentTip, base, b]));
          if (result.conflicts) {
            await setConfig(repo, `branch.${b}.gitcolumn-restack-pending`, parentTip);
            return { moved, conflicts: true, stoppedAt: b, original };
          }
          moved.push({ name: b, old: tip, new: (await revParse(repo, `refs/heads/${b}`))!, oldBase: recorded });
          await setConfig(repo, `branch.${b}.gitcolumn-parent-base`, parentTip);
        }
        await goBack();
        return { moved, conflicts: false, original };
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const rebasing = (await ctx.repoState(repo)).rebasing;
        if (!rebasing) await goBack().catch(() => undefined);
        if (!moved.length) throw e;
        return { moved, conflicts: false, error: message, original };
      }
    },

    // ----------------------------------------------------------- worktrees
    async 'worktree.list'({ repo }: { repo: string }): Promise<Worktree[]> {
      const [raw, top] = await Promise.all([
        git(repo, ['worktree', 'list', '--porcelain']),
        git(repo, ['rev-parse', '--show-toplevel']).then((s) => s.trim(), () => repo),
      ]);
      return parseWorktrees(raw, top);
    },

    async 'worktree.add'({ repo, path: target, branch, newBranch, start }: { repo: string; path: string; branch?: string; newBranch?: string; start?: string }) {
      // Relative folders are relative to the repository, not to wherever the app was started.
      const dir = /^~(\/|$)/.test(target.trim()) ? expandHome(target) : path.resolve(repo, target.trim());
      const existing = await fs.readdir(dir).catch(() => null);
      if (existing && existing.length) throw new Error(`${dir} is not empty.`);
      const args = ['worktree', 'add'];
      if (newBranch) {
        assertSafe(newBranch);
        args.push('-b', newBranch);
      }
      args.push('--', dir);
      const rev = newBranch ? start : branch;
      if (rev) {
        assertSafe(rev);
        args.push(rev);
      }
      await git(repo, args);
      return { path: await fs.realpath(dir) };
    },

    async 'worktree.remove'({ repo, path: target, force }: { repo: string; path: string; force?: boolean }) {
      const args = ['worktree', 'remove'];
      // Twice: a locked worktree needs it (git worktree remove -f -f).
      if (force) args.push('--force', '--force');
      args.push('--', target);
      await git(repo, args);
    },

    async 'worktree.prune'({ repo }: { repo: string }) {
      await git(repo, ['worktree', 'prune']);
    },

    // ----------------------------------------------------------- compare
    async 'merge.base'({ repo, a, b }: { repo: string; a: string; b: string }): Promise<string | null> {
      assertSafe(a);
      assertSafe(b);
      return git(repo, ['merge-base', a, b]).then((s) => s.trim() || null, (e) => (e instanceof GitError && e.code === 1 ? null : Promise.reject(e)));
    },

    /** Commits reachable from `to` but not from `from` (newest first). */
    async 'log.range'({ repo, from, to, limit = 1000 }: { repo: string; from: string; to: string; limit?: number }): Promise<Commit[]> {
      assertSafe(from);
      assertSafe(to);
      return parseLog(await git(repo, ['log', '--topo-order', `--format=${LOG_FORMAT}`, `--max-count=${Math.min(limit, 5000)}`, `${from}..${to}`, '--']));
    },

    async 'diff.range'({ repo, from, to, paths }: { repo: string; from: string; to: string; paths?: string[] }): Promise<FileDiff[]> {
      assertSafe(from);
      assertSafe(to);
      const args = ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-M', from, to, '--'];
      if (paths?.length) args.push(...paths);
      return parseDiff(await git(repo, args, { maxBytes: 20 * 1024 * 1024 }));
    },
  };
};
