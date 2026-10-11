import { useMemo } from 'react';
import type { Commit, FileDiff, FileStatus, HeadPos, LineSelection, PatchAction, RebaseStep, Ref, Snapshot, Stash } from '../../shared/types';
import { RebaseDialog } from '../components/RebaseDialog';
import { api } from '../lib/api';
import { plural, shortHash } from '../lib/format';
import { getSetting } from '../lib/settings';
import { useUI } from '../ui/UIProvider';
import { useRepo, type UndoEntry } from './RepoContext';

/** High-level git operations with their confirmation dialogs and undo, shared by toolbar, sidebar and menus. */
export function useActions() {
  const ui = useUI();
  const ctx = useRepo();
  const { repo, run, status, refs, remotes, setView } = ctx;
  const path = repo.path;

  return useMemo(() => {
    const headName = status?.branch ?? (status?.head ? `HEAD (${shortHash(status.head)})` : 'HEAD');
    const localExists = (name: string) => refs.some((r) => r.type === 'head' && r.name === name);
    const pathsOf = (files: FileStatus[]) => files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));

    // ------------------------------------------------------------ undo specs
    // Undo entries are data (see UndoSpec), checked and executed by the backend, so they survive restarts.
    const currentHead = () => api.revParse(path, 'HEAD');
    const currentPos = async (): Promise<HeadPos> => {
      const s = await api.snapshot(path);
      return { head: s.head, branch: s.branch };
    };
    /** Undo an operation that moved HEAD (merge, rebase, pull, cherry-pick…) by resetting back, keeping local changes. */
    const undoHeadMove = (label: string, before: Snapshot) => async (): Promise<UndoEntry | null> => {
      const after = await currentHead();
      if (!before.head || !after || after === before.head) return null;
      return { label, spec: { kind: 'head-reset', from: after, to: before.head, mode: 'keep', branch: before.branch } };
    };
    /** Undo an index-only change (stage / unstage) by restoring the previous index tree. */
    const undoIndex = (label: string, before: Snapshot) => (): UndoEntry | null =>
      before.index ? { label, spec: { kind: 'index', tree: before.index, head: before.head } } : null;
    /** Return to the branch (or detached commit) that was checked out before, optionally deleting a branch the operation created. */
    const undoCheckout = (before: Snapshot, created?: string) => async (): Promise<UndoEntry | null> => {
      const to = await currentPos();
      if (to.head === before.head && to.branch === before.branch) return null;
      const hash = created ? await api.revParse(path, `refs/heads/${created}`) : null;
      return {
        label: 'Checkout',
        spec: { kind: 'checkout', from: { head: before.head, branch: before.branch }, to, deleteBranch: created && hash ? { name: created, hash } : undefined },
      };
    };
    /** Delete a ref again (only if it still points where the operation left it), with its branch settings. */
    const undoCreateRef = (label: string, ref: string) => async (): Promise<UndoEntry | null> => {
      const hash = await api.revParse(path, ref);
      if (!hash) return null;
      const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
      const config = branch ? (await api.branchConfig(path, branch)).map(([k]): [string, string | null] => [k, null]) : undefined;
      return { label, spec: { kind: 'refs', updates: [{ ref, old: hash, new: null }], config } };
    };

    const actions = {
      undo: () => ctx.undo(),

      fetch: (remote?: string) =>
        run(remote ? `Fetching ${remote}…` : 'Fetching…', () => api.fetch(path, remote), {
          success: remotes.length ? 'Fetched from ' + (remote ?? plural(remotes.length, 'remote')) : undefined,
        }),

      async pull() {
        if (!status?.branch) return ui.toast('warning', 'Cannot pull in detached HEAD state');
        if (!status.upstream) return ui.toast('warning', `"${status.branch}" has no upstream branch`, 'Push the branch first, or set an upstream from the sidebar.');
        const before = await api.snapshot(path);
        return run('Pulling…', () => api.pull(path, getSetting('pullRebase')), {
          success: `Pulled ${status.upstream}`,
          undo: (r) => (r?.conflicts ? null : undoHeadMove('Pull', before)()),
        });
      },

      async push(branch = status?.branch ?? undefined, opts: { force?: boolean } = {}) {
        if (!branch) return ui.toast('warning', 'Cannot push in detached HEAD state');
        if (!remotes.length) {
          const added = await actions.addRemote();
          if (!added) return;
        }
        const ref = refs.find((r) => r.type === 'head' && r.name === branch);
        let remote: string | undefined;
        let force = opts.force;
        if (!ref?.upstream || ref.upstreamGone || force) {
          const v = await ui.form({
            title: force ? `Force push "${branch}"` : `Push "${branch}"`,
            message: force
              ? 'Force pushing overwrites the remote branch. GitColumn uses --force-with-lease, which refuses if someone else pushed in the meantime.'
              : ref?.upstream
                ? undefined
                : 'This branch is not tracking a remote branch yet.',
            fields: [
              {
                name: 'remote',
                label: 'Remote',
                type: 'select',
                options: (remotes.length ? remotes : [{ name: 'origin' }]).map((r) => ({ value: r.name, label: r.name })),
                value: ref?.upstream?.split('/')[0] ?? remotes.find((r) => r.name === 'origin')?.name,
              },
              ...(force ? [] : [{ name: 'force', label: 'Force push (with lease)', type: 'checkbox' as const }]),
            ],
            confirmLabel: force ? 'Force Push' : 'Push',
            danger: force,
          });
          if (!v) return;
          remote = String(v.remote);
          force = force || !!v.force;
        }
        return run(`Pushing ${branch}…`, () => api.push(path, branch, { remote, force, setUpstream: !ref?.upstream }), {
          success: (r) => `Pushed ${branch} to ${r.remote}`,
        });
      },

      // ------------------------------------------------------------ staging
      async stage(paths: string[]) {
        if (!paths.length) return;
        const before = await api.snapshot(path);
        return run('Staging…', () => api.stage(path, paths), { undo: undoIndex('Stage', before) });
      },

      async unstage(paths: string[]) {
        if (!paths.length) return;
        const before = await api.snapshot(path);
        return run('Unstaging…', () => api.unstage(path, paths), { undo: undoIndex('Unstage', before) });
      },

      async stageAll() {
        const before = await api.snapshot(path);
        return run('Staging…', () => api.stageAll(path), { undo: undoIndex('Stage All', before) });
      },

      async unstageAll() {
        const before = await api.snapshot(path);
        return run('Unstaging…', () => api.unstageAll(path), { undo: undoIndex('Unstage All', before) });
      },

      async applyPatch(diff: FileDiff, selection: LineSelection, action: PatchAction) {
        const file = diff.newPath || diff.oldPath;
        if (action === 'discard') {
          const ok = await ui.confirm({
            title: 'Discard these changes?',
            message: 'The selected changes will be removed from your working copy. You can undo this with ⌘Z.',
            confirmLabel: 'Discard',
            danger: true,
          });
          if (!ok) return;
        }
        const before = await api.snapshot(path, action === 'discard' ? [file] : undefined);
        const label = action === 'stage' ? 'Stage Lines' : action === 'unstage' ? 'Unstage Lines' : 'Discard Lines';
        return run(action === 'stage' ? 'Staging…' : action === 'unstage' ? 'Unstaging…' : 'Discarding…', () => api.applyPatch(path, diff, selection, action), {
          undo: () => (action === 'discard' ? { label, spec: { kind: 'files', snapshot: before } } : undoIndex(label, before)()),
          success: action === 'discard' ? 'Changes discarded' : undefined,
        });
      },

      async discard(files: FileStatus[]) {
        if (!files.length) return;
        const untracked = files.filter((f) => f.untracked).length;
        const ok = await ui.confirm({
          title: `Discard changes in ${files.length === 1 ? `"${files[0].path}"` : plural(files.length, 'file')}?`,
          message:
            (untracked && window.gitcolumn ? 'Untracked files will be moved to the Trash. ' : '') + 'You can undo this with ⌘Z.',
          confirmLabel: 'Discard',
          danger: true,
        });
        if (!ok) return;
        const before = await api.snapshot(path, pathsOf(files));
        return run('Discarding…', () => api.discard(path, files), {
          success: `Discarded ${files.length === 1 ? files[0].path : plural(files.length, 'file')}`,
          undo: () => ({ label: 'Discard', spec: { kind: 'files', snapshot: before } }),
        });
      },

      async commit(message: string, opts: { amend?: boolean; stageAll?: boolean; undoable?: boolean } = {}) {
        const before = await api.snapshot(path);
        const subject = message.split('\n')[0];
        return run(
          opts.amend ? 'Amending commit…' : 'Committing…',
          async () => {
            if (opts.stageAll) await api.stageAll(path);
            await api.commit(path, message, opts.amend);
            return true;
          },
          {
            success: opts.amend ? 'Commit amended' : `Committed “${subject}”`,
            undo: async () => {
              // A soft reset can't restore MERGE_HEAD, so merge commits aren't undoable this way.
              if (opts.undoable === false) return null;
              const after = await currentHead();
              if (!after || after === before.head) return null;
              return { label: opts.amend ? 'Amend' : 'Commit', spec: { kind: 'commit', from: after, to: before.head, branch: before.branch, message } };
            },
          },
        );
      },

      // ----------------------------------------------------------- branches
      async createBranch(start?: string, startLabel?: string) {
        const v = await ui.form({
          title: 'Create New Branch',
          message: (
            <>
              Based on <b>{startLabel ?? start ?? headName}</b>
            </>
          ),
          fields: [
            { name: 'name', label: 'Branch name', placeholder: 'feature/my-change', required: true, mono: true },
            { name: 'checkout', label: 'Check out new branch', type: 'checkbox', value: true },
          ],
          validate: (v) => validateRefName(String(v.name)) ?? (localExists(String(v.name).trim()) ? 'A branch with this name already exists' : null),
          confirmLabel: 'Create Branch',
        });
        if (!v) return;
        const name = String(v.name).trim();
        const before = await api.snapshot(path);
        return run('Creating branch…', () => api.createBranch(path, name, start, !!v.checkout), {
          success: v.checkout ? `Created and checked out ${name}` : `Created ${name}`,
          undo: async () => {
            const entry = v.checkout ? await undoCheckout(before, name)() : await undoCreateRef('Create Branch', `refs/heads/${name}`)();
            return entry && { ...entry, label: 'Create Branch' };
          },
        });
      },

      async checkout(ref: Ref) {
        const before = await api.snapshot(path);
        if (ref.type === 'head') {
          if (ref.current) return;
          return run(`Checking out ${ref.name}…`, () => api.checkout(path, ref.name), { success: `Checked out ${ref.name}`, undo: undoCheckout(before) });
        }
        if (ref.type === 'remote') {
          const local = ref.name.slice((ref.remote?.length ?? 0) + 1);
          const existed = localExists(local);
          return run(`Checking out ${local}…`, () => api.checkoutRemote(path, ref.name, local), {
            success: existed ? `Checked out ${local}` : `Created ${local} tracking ${ref.name}`,
            undo: undoCheckout(before, existed ? undefined : local),
          });
        }
        return actions.checkoutDetached(ref.name, `tag ${ref.name}`);
      },

      async checkoutDetached(rev: string, label: string) {
        const ok = await ui.confirm({
          title: `Check out ${label}?`,
          message: 'You will be in "detached HEAD" state. Commits you make won\'t belong to any branch unless you create one.',
          confirmLabel: 'Check Out',
        });
        if (!ok) return;
        const before = await api.snapshot(path);
        return run('Checking out…', () => api.checkoutDetached(path, rev), {
          success: `Checked out ${label}`,
          undo: undoCheckout(before),
        });
      },

      async deleteBranch(ref: Ref) {
        const v = await ui.form({
          title: `Delete branch "${ref.name}"?`,
          message: 'The local branch will be removed. You can undo this with ⌘Z.',
          fields: ref.upstream && !ref.upstreamGone ? [{ name: 'remote', type: 'checkbox', label: `Also delete "${ref.upstream}" on the remote` }] : [],
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!v) return;
        const config = await api.branchConfig(path, ref.name).catch(() => [] as [string, string][]);
        let deleted = false;
        let remoteError: string | null = null;
        await run(
          `Deleting ${ref.name}…`,
          async () => {
            try {
              await api.deleteBranch(path, ref.name, false);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              if (!/not fully merged/.test(msg)) throw e;
              const force = await ui.confirm({
                title: `"${ref.name}" is not fully merged`,
                message: 'It contains commits that are not on your current branch or its upstream. Delete it anyway?',
                confirmLabel: 'Force Delete',
                danger: true,
              });
              if (!force) return;
              await api.deleteBranch(path, ref.name, true);
            }
            deleted = true;
            if (v.remote && ref.upstream) {
              const [remote, ...rest] = ref.upstream.split('/');
              // A failed remote delete must not lose the (undoable) local delete.
              await api.deleteRemoteBranch(path, remote, rest.join('/')).catch((e) => {
                remoteError = e instanceof Error ? e.message : String(e);
              });
            }
          },
          {
            success: () => {
              if (remoteError) ui.toast('error', `Couldn't delete ${ref.upstream} on the remote`, remoteError);
              return deleted ? `Deleted ${ref.name}` : undefined;
            },
            undo: () =>
              deleted
                ? {
                    label: 'Delete Branch',
                    spec: {
                      kind: 'refs',
                      updates: [{ ref: ref.ref, old: null, new: ref.hash }],
                      // The upstream is gone too when it was deleted on the remote.
                      config: config.filter(([k]) => !(v.remote && !remoteError && /\.(remote|merge)$/i.test(k))),
                    },
                  }
                : null,
          },
        );
      },

      async deleteRemoteBranch(ref: Ref) {
        const name = ref.name.slice((ref.remote?.length ?? 0) + 1);
        const ok = await ui.confirm({
          title: `Delete "${ref.name}" from the remote?`,
          message: `The branch "${name}" will be deleted on "${ref.remote}" for everyone. This cannot be undone from GitColumn.`,
          confirmLabel: 'Delete on Remote',
          danger: true,
        });
        if (ok) return run(`Deleting ${ref.name}…`, () => api.deleteRemoteBranch(path, ref.remote!, name), { success: `Deleted ${ref.name}` });
      },

      async renameBranch(ref: Ref) {
        const v = await ui.form({
          title: `Rename branch "${ref.name}"`,
          fields: [{ name: 'name', label: 'New name', value: ref.name, mono: true, required: true }],
          validate: (v) => validateRefName(String(v.name)),
          confirmLabel: 'Rename',
        });
        const newName = String(v?.name ?? '').trim();
        if (!v || newName === ref.name) return;
        return run('Renaming branch…', () => api.renameBranch(path, ref.name, newName), {
          success: `Renamed ${ref.name} to ${newName}`,
          undo: () => ({ label: 'Rename', spec: { kind: 'branch-rename', from: ref.name, to: newName, hash: ref.hash } }),
        });
      },

      async setUpstream(ref: Ref) {
        const remoteRefs = refs.filter((r) => r.type === 'remote');
        if (!remoteRefs.length) return ui.toast('info', 'No remote branches', 'Fetch or push first.');
        const v = await ui.form({
          title: `Track remote branch for "${ref.name}"`,
          fields: [
            {
              name: 'upstream',
              label: 'Upstream',
              type: 'select',
              value: ref.upstream ?? remoteRefs.find((r) => r.name.endsWith('/' + ref.name))?.name ?? '',
              options: [{ value: '', label: '(none)' }, ...remoteRefs.map((r) => ({ value: r.name, label: r.name }))],
            },
          ],
          confirmLabel: 'Save',
        });
        if (!v) return;
        const previous = new Map((await api.branchConfig(path, ref.name)).map(([k, val]) => [k.toLowerCase(), val]));
        const key = (k: string) => `branch.${ref.name}.${k}`;
        return run('Updating tracking…', () => api.setUpstream(path, ref.name, String(v.upstream) || null), {
          undo: () => ({
            label: 'Track Branch',
            spec: {
              kind: 'upstream',
              branch: ref.name,
              config: [
                [key('remote'), previous.get(key('remote').toLowerCase()) ?? null],
                [key('merge'), previous.get(key('merge').toLowerCase()) ?? null],
              ],
            },
          }),
        });
      },

      // --------------------------------------------------- merge & rebase
      async merge(name: string) {
        if (!status?.branch) return ui.toast('warning', 'Check out a branch before merging');
        const v = await ui.form({
          title: 'Merge',
          message: (
            <>
              Merge <b>{name}</b> into <b>{status.branch}</b>
            </>
          ),
          fields: [
            {
              name: 'mode',
              type: 'radio',
              value: 'default',
              options: [
                { value: 'default', label: 'Fast-forward if possible', description: 'Create a merge commit only when histories diverged' },
                { value: 'noff', label: 'Always create a merge commit', description: '--no-ff' },
                { value: 'squash', label: 'Squash', description: 'Stage all changes as a single new commit for you to commit' },
              ],
            },
          ],
          confirmLabel: 'Merge',
        });
        if (!v) return;
        const before = await api.snapshot(path);
        return run(`Merging ${name}…`, () => api.merge(path, name, { noFF: v.mode === 'noff', squash: v.mode === 'squash' }), {
          success: v.mode === 'squash' ? `Squashed ${name} — review and commit the staged changes` : `Merged ${name} into ${status.branch}`,
          undo: (r) => (r?.conflicts || v.mode === 'squash' ? null : undoHeadMove('Merge', before)()),
        });
      },

      async rebase(onto: string) {
        if (!status?.branch) return ui.toast('warning', 'Check out a branch before rebasing');
        const ok = await ui.confirm({
          title: 'Rebase',
          message: (
            <>
              Rebase <b>{status.branch}</b> onto <b>{onto}</b>? Commits on {status.branch} will be rewritten on top of {onto}. Avoid rebasing
              commits you've already pushed and shared.
            </>
          ),
          confirmLabel: 'Rebase',
        });
        if (!ok) return;
        const before = await api.snapshot(path);
        return run(`Rebasing onto ${onto}…`, () => api.rebase(path, onto), {
          success: `Rebased ${status.branch} onto ${onto}`,
          undo: (r) => (r?.conflicts ? null : undoHeadMove('Rebase', before)()),
        });
      },

      /** Open the interactive rebase editor for the commits after `base` (null = whole history). */
      async interactiveRebase(base: string | null, preset?: (steps: RebaseStep[]) => RebaseStep[]) {
        if (!status?.branch) return ui.toast('warning', 'Check out a branch before rebasing');
        let plan;
        try {
          plan = await api.rebasePlan(path, base);
        } catch (e) {
          return ui.toast('error', 'Can’t start interactive rebase', e instanceof Error ? e.message : String(e));
        }
        if (!plan.commits.length) return ui.toast('info', 'There are no commits after this one to rebase');
        if (plan.hasMerges) {
          return ui.toast('warning', 'This range contains merge commits', 'Interactive rebase would flatten them. Start from a commit after the most recent merge.');
        }
        const initial = plan.commits.map((c): RebaseStep => ({ action: 'pick', hash: c.hash }));
        const steps = await ui.modal<RebaseStep[]>((close) => (
          <RebaseDialog branch={status.branch!} plan={plan} initial={preset ? preset(initial) : initial} onClose={close} />
        ));
        if (!steps) return;
        return actions.runRebase(plan.base, steps);
      },

      async runRebase(base: string | null, steps: RebaseStep[]) {
        const before = await api.snapshot(path);
        return run('Rebasing…', () => api.rebaseInteractive(path, base, steps), {
          success: (r) => (r?.paused ? 'Rebase paused — amend the commit, then click Continue' : 'Interactive rebase complete'),
          undo: (r) => (r?.conflicts || r?.paused ? null : undoHeadMove('Interactive Rebase', before)()),
        });
      },

      /** Quick action: change a commit message (amends directly for HEAD). */
      async rewordCommit(c: Commit) {
        const detail = await api.commitDetail(path, c.hash);
        const v = await ui.form({
          title: 'Edit Commit Message',
          message: <span className="mono">{shortHash(c.hash)}</span>,
          fields: [
            { name: 'subject', label: 'Subject', value: detail.subject, required: true },
            { name: 'body', label: 'Description', type: 'textarea', value: detail.body },
          ],
          confirmLabel: 'Save Message',
        });
        if (!v) return;
        const message = String(v.body).trim() ? `${String(v.subject).trim()}\n\n${String(v.body).trim()}` : String(v.subject).trim();
        if (c.hash === status?.head) {
          const before = await api.snapshot(path);
          // --only: change just the message; staged changes stay staged and out of the commit.
          return run('Rewording…', () => api.commit(path, message, true, { only: true }), {
            success: 'Commit message updated',
            undo: async () => {
              const after = await currentHead();
              if (!before.head || !after || after === before.head) return null;
              return { label: 'Edit Message', spec: { kind: 'head-reset', from: after, to: before.head, mode: 'soft', branch: before.branch } };
            },
          });
        }
        if (!c.parents[0]) return ui.toast('warning', 'Editing the first commit isn’t supported');
        const plan = await api.rebasePlan(path, c.parents[0]).catch((e) => {
          ui.toast('error', 'Can’t edit this commit', String(e instanceof Error ? e.message : e));
          return null;
        });
        if (!plan) return;
        if (plan.hasMerges) return ui.toast('warning', 'Can’t edit this commit', 'There are merge commits after it.');
        return actions.runRebase(
          plan.base,
          plan.commits.map((pc) => (pc.hash === c.hash ? { action: 'reword', hash: pc.hash, message } : { action: 'pick', hash: pc.hash })),
        );
      },

      /** Quick action: squash or fixup a commit into its parent. */
      async squashIntoParent(c: Commit, mode: 'squash' | 'fixup') {
        const parent = c.parents[0];
        if (!parent) return ui.toast('warning', 'The first commit has no parent to squash into');
        const grand = await api.revParse(path, `${parent}^`);
        if (!grand) return ui.toast('warning', 'Squashing into the root commit isn’t supported');
        const plan = await api.rebasePlan(path, grand).catch(() => null);
        if (!plan) return ui.toast('error', 'That commit is not on the current branch');
        if (plan.hasMerges) return ui.toast('warning', 'Can’t squash here', 'There are merge commits in the way.');
        const ok = await ui.confirm({
          title: mode === 'squash' ? 'Squash into parent?' : 'Fixup into parent?',
          message:
            mode === 'squash'
              ? `“${c.subject}” will be combined with its parent commit, keeping both messages.`
              : `“${c.subject}” will be folded into its parent commit and its message discarded.`,
          confirmLabel: mode === 'squash' ? 'Squash' : 'Fixup',
        });
        if (!ok) return;
        return actions.runRebase(
          plan.base,
          plan.commits.map((pc) => ({ action: pc.hash === c.hash ? mode : 'pick', hash: pc.hash })),
        );
      },

      /** Quick action: remove a commit from the branch. */
      async dropCommit(c: Commit) {
        const parent = c.parents[0];
        const plan = await api.rebasePlan(path, parent ?? null).catch(() => null);
        if (!plan) return ui.toast('error', 'That commit is not on the current branch');
        if (plan.hasMerges) return ui.toast('warning', 'Can’t drop this commit', 'There are merge commits after it.');
        if (plan.commits.length === 1 && !parent) return ui.toast('warning', 'Can’t drop the only commit');
        const ok = await ui.confirm({
          title: 'Drop commit?',
          message: `“${c.subject}” and its changes will be removed from ${headName}. You can undo this with ⌘Z.`,
          confirmLabel: 'Drop Commit',
          danger: true,
        });
        if (!ok) return;
        return actions.runRebase(
          plan.base,
          plan.commits.map((pc) => ({ action: pc.hash === c.hash ? 'drop' : 'pick', hash: pc.hash })),
        );
      },

      // ------------------------------------------------------------ stashes
      async stashSave() {
        const v = await ui.form({
          title: 'Stash Local Changes',
          fields: [
            { name: 'message', label: 'Description', placeholder: 'Optional' },
            { name: 'untracked', type: 'checkbox', label: 'Include untracked files', value: true },
            { name: 'keepIndex', type: 'checkbox', label: 'Keep staged changes in the working copy' },
          ],
          confirmLabel: 'Stash',
        });
        if (!v) return;
        const previousTop = (await api.stashes(path))[0]?.hash;
        return run('Stashing…', () => api.stashSave(path, { message: String(v.message), includeUntracked: !!v.untracked, keepIndex: !!v.keepIndex }), {
          success: 'Changes stashed',
          undo: async () => {
            // git exits successfully when there was nothing to stash; don't pick up an older stash then.
            const top = (await api.stashes(path))[0];
            return top && top.hash !== previousTop ? { label: 'Stash', spec: { kind: 'stash-save', hash: top.hash } } : null;
          },
        });
      },

      async stashApply(s: Stash, pop: boolean) {
        const diffs = await api.stashDiff(path, s.ref).catch(() => [] as FileDiff[]);
        const touched = diffs.flatMap((d) => [d.oldPath, d.newPath]).filter(Boolean);
        const before = await api.snapshot(path, touched);
        return run(pop ? 'Popping stash…' : 'Applying stash…', () => api.stashApply(path, s.ref, pop), {
          success: pop ? 'Stash applied and removed' : 'Stash applied',
          undo: (r) =>
            r?.conflicts
              ? null
              : {
                  label: pop ? 'Pop Stash' : 'Apply Stash',
                  spec: { kind: 'stash-apply', snapshot: before, restore: pop ? { hash: s.hash, message: s.message } : undefined },
                },
        });
      },

      async stashDrop(s: Stash) {
        const ok = await ui.confirm({
          title: 'Delete stash?',
          message: <>“{s.message}” will be deleted. You can undo this with ⌘Z.</>,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        return run('Deleting stash…', () => api.stashDrop(path, s.ref), {
          success: 'Stash deleted',
          undo: () => ({ label: 'Delete Stash', spec: { kind: 'stash-drop', hash: s.hash, message: s.message } }),
        });
      },

      // --------------------------------------------------------------- tags
      async createTag(target?: string, label?: string) {
        const v = await ui.form({
          title: 'Create New Tag',
          message: (
            <>
              On <b>{label ?? headName}</b>
            </>
          ),
          fields: [
            { name: 'name', label: 'Tag name', placeholder: 'v1.0.0', required: true, mono: true },
            { name: 'message', label: 'Message', type: 'textarea', placeholder: 'Optional — creates an annotated tag' },
            ...(remotes.length ? [{ name: 'push', type: 'checkbox' as const, label: `Push to ${remotes[0].name}` }] : []),
          ],
          validate: (v) => validateRefName(String(v.name)) ?? (refs.some((r) => r.type === 'tag' && r.name === String(v.name).trim()) ? 'Tag already exists' : null),
          confirmLabel: 'Create Tag',
        });
        if (!v) return;
        const name = String(v.name).trim();
        return run(
          'Creating tag…',
          async () => {
            await api.createTag(path, name, target, String(v.message ?? '').trim() || undefined);
            if (v.push) await api.pushTag(path, name, remotes[0].name);
          },
          {
            success: `Created tag ${name}`,
            undo: () => (v.push ? null : undoCreateRef('Create Tag', `refs/tags/${name}`)()),
          },
        );
      },

      async deleteTag(name: string) {
        const v = await ui.form({
          title: `Delete tag "${name}"?`,
          fields: remotes.length ? [{ name: 'remote', type: 'checkbox', label: `Also delete from ${remotes[0].name}` }] : [],
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!v) return;
        const object = await api.revParse(path, `refs/tags/${name}`);
        return run(
          'Deleting tag…',
          async () => {
            await api.deleteTag(path, name);
            if (v.remote) await api.deleteRemoteTag(path, name, remotes[0].name);
          },
          {
            success: `Deleted tag ${name}`,
            undo: () => (object && !v.remote ? { label: 'Delete Tag', spec: { kind: 'refs', updates: [{ ref: `refs/tags/${name}`, old: null, new: object }] } } : null),
          },
        );
      },

      pushTag: (name: string) => run(`Pushing tag ${name}…`, () => api.pushTag(path, name), { success: `Pushed tag ${name}` }),

      // ------------------------------------------------------- commit actions
      async cherryPick(c: Commit) {
        const before = await api.snapshot(path);
        return run('Cherry-picking…', () => api.cherryPick(path, c.hash), {
          success: `Cherry-picked ${shortHash(c.hash)} onto ${headName}`,
          undo: (r) => (r?.conflicts ? null : undoHeadMove('Cherry-Pick', before)()),
        });
      },

      async revert(c: Commit) {
        const ok = await ui.confirm({
          title: 'Revert commit?',
          message: (
            <>
              Creates a new commit that undoes the changes from <b>{shortHash(c.hash)}</b> “{c.subject}”.
            </>
          ),
          confirmLabel: 'Revert',
        });
        if (!ok) return;
        const before = await api.snapshot(path);
        return run('Reverting…', () => api.revert(path, c.hash, c.parents.length > 1 ? 1 : undefined), {
          success: `Reverted ${shortHash(c.hash)}`,
          undo: (r) => (r?.conflicts ? null : undoHeadMove('Revert', before)()),
        });
      },

      async reset(c: Pick<Commit, 'hash' | 'subject'>) {
        const v = await ui.form({
          title: `Reset "${headName}" to ${shortHash(c.hash)}`,
          message: <>“{c.subject}”</>,
          fields: [
            {
              name: 'mode',
              type: 'radio',
              value: 'mixed',
              options: [
                { value: 'soft', label: 'Soft', description: 'Keep all changes, staged' },
                { value: 'mixed', label: 'Mixed', description: 'Keep all changes, unstaged' },
                { value: 'hard', label: 'Hard', description: 'Discard all local changes — uncommitted work cannot be recovered' },
              ],
            },
          ],
          confirmLabel: 'Reset',
          danger: true,
        });
        if (!v) return;
        const mode = v.mode as 'soft' | 'mixed' | 'hard';
        if (mode === 'hard' && status?.files.length) {
          const sure = await ui.confirm({
            title: 'Discard all local changes?',
            message: `You have ${plural(status.files.length, 'changed file')}. A hard reset will permanently discard them.`,
            confirmLabel: 'Reset Hard',
            danger: true,
          });
          if (!sure) return;
        }
        const before = await api.snapshot(path);
        return run('Resetting…', () => api.reset(path, c.hash, mode), {
          success: `Reset ${headName} to ${shortHash(c.hash)}`,
          undo: async () => {
            const after = await currentHead();
            if (!before.head || !after) return null;
            // A hard reset discarded the local changes for good; for the others, the old index comes back too.
            return {
              label: 'Reset',
              spec:
                mode === 'hard'
                  ? { kind: 'head-reset', from: after, to: before.head, mode: 'keep', branch: before.branch }
                  : { kind: 'head-reset', from: after, to: before.head, mode: 'soft', index: before.index, branch: before.branch },
            };
          },
        });
      },

      async undoLastCommit(c: Commit) {
        if (!c.parents.length) return ui.toast('warning', 'Cannot undo the first commit');
        const ok = await ui.confirm({
          title: 'Undo last commit?',
          message: <>“{c.subject}” will be removed from {headName}; its changes stay staged in your working copy.</>,
          confirmLabel: 'Undo Commit',
        });
        if (!ok) return;
        const branch = status?.branch ?? null;
        return run('Undoing commit…', () => api.reset(path, c.parents[0], 'soft'), {
          success: 'Commit undone — changes are staged',
          undo: () => ({ label: 'Undo Commit', spec: { kind: 'head-reset', from: c.parents[0], to: c.hash, mode: 'soft', branch } }),
        });
      },

      // ------------------------------------------------------------ remotes
      async addRemote(): Promise<boolean> {
        const v = await ui.form({
          title: 'Add Remote',
          fields: [
            { name: 'name', label: 'Name', value: remotes.length ? '' : 'origin', required: true, mono: true },
            { name: 'url', label: 'URL', placeholder: 'git@github.com:user/repo.git', required: true, mono: true },
          ],
          confirmLabel: 'Add Remote',
        });
        if (!v) return false;
        const name = String(v.name).trim();
        const res = await run(
          'Adding remote…',
          async () => {
            await api.addRemote(path, name, String(v.url).trim());
            await api.fetch(path, name).catch(() => undefined);
            return true;
          },
          { success: `Added remote ${name}`, undo: () => ({ label: 'Add Remote', spec: { kind: 'remote-add', name } }) },
        );
        return !!res;
      },

      async removeRemote(name: string) {
        const ok = await ui.confirm({
          title: `Remove remote "${name}"?`,
          message: 'Its remote-tracking branches will be removed locally. Nothing is deleted on the server.',
          confirmLabel: 'Remove',
          danger: true,
        });
        if (!ok) return;
        const [config, trackingRefs] = await Promise.all([
          api.remoteConfig(path, name).catch(() => [] as [string, string][]),
          api.remoteTrackingRefs(path, name).catch(() => [] as [string, string][]),
        ]);
        return run('Removing remote…', () => api.removeRemote(path, name), {
          success: `Removed remote ${name}`,
          undo: () => (config.length ? { label: 'Remove Remote', spec: { kind: 'remote-remove', name, config, refs: trackingRefs } } : null),
        });
      },

      // ------------------------------------------------------- in progress
      continueOp: () => run('Continuing…', () => api.continueOp(path)),
      skipOp: () => run('Skipping…', () => api.skipOp(path)),
      async abortOp() {
        const ok = await ui.confirm({
          title: 'Abort?',
          message: 'Your branch will return to the state before the operation started. Conflict resolutions will be lost.',
          confirmLabel: 'Abort',
          danger: true,
        });
        if (ok) return run('Aborting…', () => api.abortOp(path), { success: 'Aborted' });
      },

      // ---------------------------------------------------------- submodules
      updateSubmodule: (subPath?: string) =>
        run(subPath ? `Updating ${subPath}…` : 'Updating submodules…', () => api.updateSubmodule(path, subPath), {
          success: subPath ? `Updated ${subPath}` : 'Submodules updated',
        }),

      async addSubmodule() {
        const v = await ui.form({
          title: 'Add Submodule',
          fields: [
            { name: 'url', label: 'Repository URL', placeholder: 'https://github.com/user/library.git', required: true, mono: true },
            { name: 'path', label: 'Path in this repository', placeholder: 'vendor/library', required: true, mono: true },
          ],
          onChange: (name, values) => {
            if (name !== 'url') return;
            const m = /([^/:]+?)(\.git)?\/?$/.exec(String(values.url).trim());
            return m ? { path: m[1] } : undefined;
          },
          confirmLabel: 'Add Submodule',
        });
        if (!v) return;
        return run('Adding submodule…', () => api.addSubmodule(path, String(v.url).trim(), String(v.path).trim()), {
          success: `Added submodule ${String(v.path).trim()} — commit to record it`,
        });
      },

      // ----------------------------------------------------------- identity
      async editIdentity() {
        const id = await api.identity(path);
        const v = await ui.form({
          title: 'Commit Author',
          fields: [
            { name: 'name', label: 'Name', value: id.name, required: true },
            { name: 'email', label: 'Email', value: id.email, required: true },
            { name: 'global', type: 'checkbox', label: 'Use for all repositories (global config)', value: true },
          ],
          confirmLabel: 'Save',
        });
        if (!v) return false;
        await run('Saving identity…', () => api.setIdentity(path, String(v.name), String(v.email), !!v.global));
        return true;
      },

      showFileHistory: (filePath: string, rev?: string | null) => setView({ kind: 'file', path: filePath, mode: 'history', rev }),

      /** Save the files of a revision (optionally one folder) as a zip archive. */
      async exportFiles(rev: string, label: string, folder?: string) {
        const name = `${repo.name}-${(label || rev).replace(/[\/]+/g, '-')}${folder ? `-${folder.replace(/[\/]+/g, '-')}` : ''}`;
        const dest = await run('Exporting files…', () => api.exportArchive(path, rev, name, folder), { noRefresh: true });
        if (dest) ui.toast('success', `Exported ${folder ?? label}`, dest, { label: 'Reveal', onClick: () => void api.revealExport(dest) });
      },
      blame: (filePath: string, rev?: string | null) => setView({ kind: 'file', path: filePath, mode: 'blame', rev }),
    };
    return actions;
  }, [ui, ctx, run, path, status, refs, remotes, setView]);
}

export type Actions = ReturnType<typeof useActions>;

export function validateRefName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Name is required';
  if (/\s/.test(n)) return 'Name cannot contain spaces';
  if (/^[-/.]|[/.]$|\.\.|\/\/|@\{|[~^:?*[\\\x00-\x1f\x7f]|\.lock$/.test(n)) return 'Not a valid Git ref name';
  return null;
}
