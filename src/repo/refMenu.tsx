import { useApp } from '../AppContext';
import type { Ref } from '../../shared/types';
import { copyText } from '../lib/format';
import { useUI, type MenuItem } from '../ui/UIProvider';
import { useActions } from './actions';
import { useRepo } from './RepoContext';

/** The context menu for a branch or tag, shared by the sidebar, History badges and Branches Review. */
export function useRefMenu() {
  const { status, remotes, refs, setView } = useRepo();
  const actions = useActions();
  const ui = useUI();
  const app = useApp();

  return (e: React.MouseEvent, r: Ref) => {
    const branch = status?.branch;
    const items: MenuItem[] = [];
    const elsewhere = r.type === 'head' && !!r.worktree;
    const children = r.type === 'head' ? refs.filter((x) => x.type === 'head' && x.parent === r.name) : [];

    if (r.type === 'head') {
      if (!r.current) {
        items.push({
          label: elsewhere ? `Checked out in ${r.worktree}` : `Check Out "${r.name}"`,
          disabled: elsewhere,
          onClick: () => actions.checkout(r),
        });
      }
      if (elsewhere) items.push({ label: 'Open Its Worktree in a New Tab', onClick: () => app.openRepo(r.worktree!) });
      else if (!r.current) items.push({ label: 'Check Out in New Worktree…', onClick: () => actions.checkoutInWorktree(r, app.openRepo) });
      items.push('separator');
      items.push({ label: r.pinned ? 'Unpin' : 'Pin to Top', onClick: () => actions.setFlag(r, 'pinned', !r.pinned) });
      items.push({ label: r.archived ? 'Unarchive' : 'Archive', disabled: r.current, onClick: () => actions.setFlag(r, 'archived', !r.archived) });
      items.push('separator');
      if (r.current) {
        if (r.upstream) items.push({ label: 'Sync (Pull, then Push)', onClick: () => actions.sync() });
        if (!r.upstream && remotes.length) items.push({ label: `Publish "${r.name}"…`, onClick: () => actions.push(r.name) });
      } else if (branch) {
        items.push({ label: `Merge "${r.name}" into "${branch}"…`, onClick: () => actions.merge(r.name) });
        items.push({ label: `Rebase "${branch}" onto "${r.name}"…`, onClick: () => actions.rebase(r.name) });
      }
      if (r.current) {
        items.push({ label: 'Merge With Revision…', onClick: () => actions.mergeRevision() });
        items.push({ label: 'Rebase On Revision…', onClick: () => actions.rebaseOnRevision() });
        items.push({ label: 'Rebase Onto Revision… (--onto)', onClick: () => actions.rebaseOntoRevision() });
      }
      items.push('separator');
      if (r.upstream) items.push({ label: `Push "${r.name}"`, onClick: () => actions.push(r.name) });
      if (remotes.length) items.push({ label: 'Push To…', onClick: () => actions.pushTo(r) });
      if (r.upstream) items.push({ label: `Force Push "${r.name}"…`, onClick: () => actions.push(r.name, { force: true }) });
      items.push({ label: 'Track Remote Branch…', onClick: () => actions.setUpstream(r) });
      if (remotes.length) items.push({ label: 'Create Pull Request…', onClick: () => actions.createPullRequest(r.name) });
      items.push('separator', { header: 'Stack' });
      items.push({ label: 'Create Stacked Branch…', onClick: () => actions.createStackedBranch(r.name) });
      items.push({ label: r.parent ? `Parent: ${r.parent}…` : 'Track Parent Branch…', onClick: () => actions.trackParent(r) });
      if (r.parent) items.push({ label: `Restack onto "${r.parent}"`, onClick: () => actions.restack(r) });
      if (r.parent && children.length) items.push({ label: 'Restack with Children', onClick: () => actions.restack(r, true) });
      items.push('separator');
      items.push({ label: `New Branch from "${r.name}"…`, onClick: () => actions.createBranch(r.name) });
      items.push({ label: `New Tag on "${r.name}"…`, onClick: () => actions.createTag(r.name, r.name) });
      if (branch && !r.current) items.push({ label: `Compare with "${branch}"`, onClick: () => actions.compare(branch, r.name) });
      items.push({ label: 'Compare with Revision…', onClick: async () => {
        const rev = await actions.askRevision(`Compare "${r.name}" With…`, 'Compare');
        if (rev) actions.compare(rev, r.name);
      } });
      items.push({ label: 'Show in History', onClick: () => setView({ kind: 'history', select: r.hash }) });
      items.push({ label: 'Show Reflog', onClick: () => setView({ kind: 'reflog', ref: r.name }) });
      items.push({ label: 'Export Files…', onClick: () => actions.exportFiles(r.name, r.name) });
      items.push('separator');
      items.push({ label: 'Rename…', onClick: () => actions.renameBranch(r) });
      items.push({ label: `Delete "${r.name}"…`, danger: true, disabled: r.current || elsewhere, onClick: () => actions.deleteBranch(r) });
    } else if (r.type === 'remote') {
      items.push({ label: `Check Out "${r.name}"`, onClick: () => actions.checkout(r) });
      items.push({ label: 'Check Out in New Worktree…', onClick: () => actions.checkoutInWorktree(r, app.openRepo) });
      if (branch) {
        items.push('separator');
        items.push({ label: `Merge "${r.name}" into "${branch}"…`, onClick: () => actions.merge(r.name) });
        items.push({ label: `Rebase "${branch}" onto "${r.name}"…`, onClick: () => actions.rebase(r.name) });
        items.push({ label: `Compare with "${branch}"`, onClick: () => actions.compare(branch, r.name) });
      }
      items.push('separator');
      items.push({ label: `New Branch from "${r.name}"…`, onClick: () => actions.createBranch(r.name) });
      items.push({ label: 'Show in History', onClick: () => setView({ kind: 'history', select: r.hash }) });
      items.push({ label: 'Export Files…', onClick: () => actions.exportFiles(r.name, r.name) });
      items.push('separator');
      items.push({ label: `Delete "${r.name}" on Remote…`, danger: true, onClick: () => actions.deleteRemoteBranch(r) });
    } else {
      items.push({ label: `Check Out "${r.name}"…`, onClick: () => actions.checkout(r) });
      items.push({ label: `New Branch from "${r.name}"…`, onClick: () => actions.createBranch(r.name) });
      if (branch) items.push({ label: `Compare with "${branch}"`, onClick: () => actions.compare(branch, r.name) });
      items.push({ label: 'Show in History', onClick: () => setView({ kind: 'history', select: r.hash }) });
      items.push({ label: 'Export Files…', onClick: () => actions.exportFiles(r.name, r.name) });
      if (remotes.length) items.push({ label: `Push Tag to ${remotes[0].name}`, onClick: () => actions.pushTag(r.name) });
      items.push('separator');
      items.push({ label: `Delete Tag "${r.name}"…`, danger: true, onClick: () => actions.deleteTag(r.name) });
    }
    items.push('separator', { label: 'Copy Name', onClick: () => copyText(r.name) });
    ui.menu(e, items);
  };
}
