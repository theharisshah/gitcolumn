import { useMemo } from 'react';
import type { Commit, FileStatus, Ref, Stash } from '../../shared/types';
import { api } from '../lib/api';
import { plural, shortHash } from '../lib/format';
import { useUI } from '../ui/UIProvider';
import { useRepo } from './RepoContext';

/** High-level git operations with their confirmation dialogs, shared by toolbar, sidebar and menus. */
export function useActions() {
  const ui = useUI();
  const ctx = useRepo();
  const { repo, run, status, refs, remotes, currentBranch } = ctx;
  const path = repo.path;

  return useMemo(() => {
    const headName = status?.branch ?? (status?.head ? `HEAD (${shortHash(status.head)})` : 'HEAD');
    const localExists = (name: string) => refs.some((r) => r.type === 'head' && r.name === name);

    const actions = {
      fetch: (remote?: string) =>
        run(remote ? `Fetching ${remote}…` : 'Fetching…', () => api.fetch(path, remote), {
          success: remotes.length ? 'Fetched from ' + (remote ?? plural(remotes.length, 'remote')) : undefined,
        }),

      async pull() {
        if (!status?.branch) return ui.toast('warning', 'Cannot pull in detached HEAD state');
        if (!status.upstream) return ui.toast('warning', `"${status.branch}" has no upstream branch`, 'Push the branch first, or set an upstream from the sidebar.');
        const rebase = localStorage.getItem('gitcolumn.pullRebase') === '1';
        return run('Pulling…', () => api.pull(path, rebase), { success: `Pulled ${status.upstream}` });
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
              { name: 'remote', label: 'Remote', type: 'select', options: (remotes.length ? remotes : [{ name: 'origin' }]).map((r) => ({ value: r.name, label: r.name })), value: ref?.upstream?.split('/')[0] ?? remotes.find((r) => r.name === 'origin')?.name },
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

      async createBranch(start?: string, startLabel?: string) {
        const v = await ui.form({
          title: 'Create New Branch',
          message: <>Based on <b>{startLabel ?? start ?? headName}</b></>,
          fields: [
            { name: 'name', label: 'Branch name', placeholder: 'feature/my-change', required: true, mono: true },
            { name: 'checkout', label: 'Check out new branch', type: 'checkbox', value: true },
          ],
          validate: (v) => validateRefName(String(v.name)) ?? (localExists(String(v.name).trim()) ? 'A branch with this name already exists' : null),
          confirmLabel: 'Create Branch',
        });
        if (!v) return;
        const name = String(v.name).trim();
        return run('Creating branch…', () => api.createBranch(path, name, start, !!v.checkout), {
          success: v.checkout ? `Created and checked out ${name}` : `Created ${name}`,
        });
      },

      checkout(ref: Ref) {
        if (ref.type === 'head') {
          if (ref.current) return;
          return run(`Checking out ${ref.name}…`, () => api.checkout(path, ref.name), { success: `Checked out ${ref.name}` });
        }
        if (ref.type === 'remote') {
          const local = ref.name.slice((ref.remote?.length ?? 0) + 1);
          return run(`Checking out ${local}…`, () => api.checkoutRemote(path, ref.name, local), {
            success: localExists(local) ? `Checked out ${local}` : `Created ${local} tracking ${ref.name}`,
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
        if (ok) return run('Checking out…', () => api.checkoutDetached(path, rev), { success: `Checked out ${label}` });
      },

      async deleteBranch(ref: Ref) {
        const v = await ui.form({
          title: `Delete branch "${ref.name}"?`,
          message: 'The local branch will be removed. Commits that are not on any other branch can only be recovered from the reflog.',
          fields: ref.upstream && !ref.upstreamGone ? [{ name: 'remote', type: 'checkbox', label: `Also delete "${ref.upstream}" on the remote` }] : [],
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!v) return;
        await run(`Deleting ${ref.name}…`, async () => {
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
          if (v.remote && ref.upstream) {
            const [remote, ...rest] = ref.upstream.split('/');
            await api.deleteRemoteBranch(path, remote, rest.join('/'));
          }
        });
      },

      async deleteRemoteBranch(ref: Ref) {
        const name = ref.name.slice((ref.remote?.length ?? 0) + 1);
        const ok = await ui.confirm({
          title: `Delete "${ref.name}" from the remote?`,
          message: `The branch "${name}" will be deleted on "${ref.remote}" for everyone.`,
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
        if (!v || String(v.name).trim() === ref.name) return;
        return run('Renaming branch…', () => api.renameBranch(path, ref.name, String(v.name).trim()));
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
        return run('Updating tracking…', () => api.setUpstream(path, ref.name, String(v.upstream) || null));
      },

      async merge(name: string) {
        if (!status?.branch) return ui.toast('warning', 'Check out a branch before merging');
        const v = await ui.form({
          title: 'Merge',
          message: <>Merge <b>{name}</b> into <b>{status.branch}</b></>,
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
        return run(`Merging ${name}…`, () => api.merge(path, name, { noFF: v.mode === 'noff', squash: v.mode === 'squash' }), {
          success: v.mode === 'squash' ? `Squashed ${name} — review and commit the staged changes` : `Merged ${name} into ${status.branch}`,
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
        if (ok) return run(`Rebasing onto ${onto}…`, () => api.rebase(path, onto), { success: `Rebased ${status.branch} onto ${onto}` });
      },

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
        return run('Stashing…', () => api.stashSave(path, { message: String(v.message), includeUntracked: !!v.untracked, keepIndex: !!v.keepIndex }), {
          success: 'Changes stashed',
        });
      },

      stashApply: (s: Stash, pop: boolean) =>
        run(pop ? 'Popping stash…' : 'Applying stash…', () => api.stashApply(path, s.ref, pop), {
          success: pop ? 'Stash applied and removed' : 'Stash applied',
        }),

      async stashDrop(s: Stash) {
        const ok = await ui.confirm({ title: 'Delete stash?', message: <>“{s.message}” will be permanently deleted.</>, confirmLabel: 'Delete', danger: true });
        if (ok) return run('Deleting stash…', () => api.stashDrop(path, s.ref));
      },

      async createTag(target?: string, label?: string) {
        const v = await ui.form({
          title: 'Create New Tag',
          message: <>On <b>{label ?? headName}</b></>,
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
        return run('Creating tag…', async () => {
          await api.createTag(path, name, target, String(v.message ?? '').trim() || undefined);
          if (v.push) await api.pushTag(path, name, remotes[0].name);
        }, { success: `Created tag ${name}` });
      },

      async deleteTag(name: string) {
        const v = await ui.form({
          title: `Delete tag "${name}"?`,
          fields: remotes.length ? [{ name: 'remote', type: 'checkbox', label: `Also delete from ${remotes[0].name}` }] : [],
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!v) return;
        return run('Deleting tag…', async () => {
          await api.deleteTag(path, name);
          if (v.remote) await api.deleteRemoteTag(path, name, remotes[0].name);
        });
      },

      pushTag: (name: string) => run(`Pushing tag ${name}…`, () => api.pushTag(path, name), { success: `Pushed tag ${name}` }),

      cherryPick: (c: Commit) =>
        run('Cherry-picking…', () => api.cherryPick(path, c.hash), { success: `Cherry-picked ${shortHash(c.hash)} onto ${headName}` }),

      async revert(c: Commit) {
        const ok = await ui.confirm({
          title: 'Revert commit?',
          message: <>Creates a new commit that undoes the changes from <b>{shortHash(c.hash)}</b> “{c.subject}”.</>,
          confirmLabel: 'Revert',
        });
        if (ok) return run('Reverting…', () => api.revert(path, c.hash, c.parents.length > 1 ? 1 : undefined), { success: `Reverted ${shortHash(c.hash)}` });
      },

      async reset(c: Commit) {
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
                { value: 'hard', label: 'Hard', description: 'Discard all local changes — cannot be undone' },
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
        return run('Resetting…', () => api.reset(path, c.hash, mode), { success: `Reset ${headName} to ${shortHash(c.hash)}` });
      },

      async undoLastCommit(c: Commit) {
        if (!c.parents.length) return ui.toast('warning', 'Cannot undo the first commit');
        const ok = await ui.confirm({
          title: 'Undo last commit?',
          message: <>“{c.subject}” will be removed from {headName}; its changes stay staged in your working copy.</>,
          confirmLabel: 'Undo Commit',
        });
        if (ok) return run('Undoing commit…', () => api.reset(path, c.parents[0], 'soft'), { success: 'Commit undone — changes are staged' });
      },

      async discard(files: FileStatus[]) {
        if (!files.length) return;
        const untracked = files.filter((f) => f.untracked).length;
        const ok = await ui.confirm({
          title: `Discard changes in ${files.length === 1 ? `"${files[0].path}"` : plural(files.length, 'file')}?`,
          message:
            untracked && window.gitcolumn
              ? 'Untracked files will be moved to the Trash. Changes to tracked files will be lost.'
              : 'This cannot be undone.',
          confirmLabel: 'Discard',
          danger: true,
        });
        if (ok) return run('Discarding…', () => api.discard(path, files));
      },

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
        const res = await run('Adding remote…', async () => {
          await api.addRemote(path, String(v.name).trim(), String(v.url).trim());
          await api.fetch(path, String(v.name).trim()).catch(() => undefined);
          return true;
        });
        return !!res;
      },

      async removeRemote(name: string) {
        const ok = await ui.confirm({
          title: `Remove remote "${name}"?`,
          message: 'Its remote-tracking branches will be removed locally. Nothing is deleted on the server.',
          confirmLabel: 'Remove',
          danger: true,
        });
        if (ok) return run('Removing remote…', () => api.removeRemote(path, name));
      },

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
    };
    return actions;
  }, [ui, run, path, status, refs, remotes, currentBranch]);
}

export type Actions = ReturnType<typeof useActions>;

export function validateRefName(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Name is required';
  if (/\s/.test(n)) return 'Name cannot contain spaces';
  if (/^[-/.]|[/.]$|\.\.|\/\/|@\{|[~^:?*[\\\x00-\x1f\x7f]|\.lock$/.test(n)) return 'Not a valid Git ref name';
  return null;
}
