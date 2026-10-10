import { useEffect, type ReactNode } from 'react';
import type { RepoInfo } from '../../shared/types';
import { useActions } from '../repo/actions';
import { RepoProvider, useRepo } from '../repo/RepoContext';
import { FileView } from './FileView';
import { History } from './History';
import { SettingsView } from './SettingsView';
import { Sidebar } from './Sidebar';
import { Splitter, usePersistentSize } from './Splitter';
import { Stashes } from './Stashes';
import { StateBanner, Toolbar } from './Toolbar';
import { WorkingCopy } from './WorkingCopy';

interface Props {
  repo: RepoInfo;
  active: boolean;
  tabs: ReactNode;
  onRepoMenu: (e: React.MouseEvent) => void;
  onClose: () => void;
}

export function RepoWindow(props: Props) {
  return (
    <RepoProvider repo={props.repo} active={props.active}>
      <RepoLayout {...props} />
    </RepoProvider>
  );
}

const isEditable = (el: Element | null) =>
  !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || (el as HTMLElement).isContentEditable);

function RepoLayout({ active, tabs, onRepoMenu, onClose }: Props) {
  const { view, setView, status, error, loading, refresh, repo, undo } = useRepo();
  const actions = useActions();
  const [sidebarWidth, setSidebarWidth] = usePersistentSize('sidebar', 240);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // In Electron these shortcuts are menu accelerators and arrive through onMenu below.
      if (!mod || window.gitcolumn || document.querySelector('.modal-backdrop')) return;
      const k = e.key.toLowerCase();
      if (!e.shiftKey && k === 'z') {
        if (isEditable(document.activeElement)) return;
        undo();
      } else if (!e.shiftKey && k === '1') setView({ kind: 'working' });
      else if (!e.shiftKey && k === '2') setView({ kind: 'history' });
      else if (!e.shiftKey && k === '3') setView({ kind: 'stashes' });
      else if (!e.shiftKey && k === ',') setView({ kind: 'settings' });
      else if (!e.shiftKey && k === 'r') refresh();
      else if (e.shiftKey && k === 'f') actions.fetch();
      else if (e.shiftKey && k === 'l') actions.pull();
      else if (e.shiftKey && k === 'p') actions.push();
      else if (e.shiftKey && k === 'b') actions.createBranch();
      else if (e.shiftKey && k === 's') actions.stashSave();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, setView, refresh, actions, undo]);

  // Commands from the native application menu (Electron only).
  useEffect(() => {
    if (!active || !window.gitcolumn) return;
    return window.gitcolumn.onMenu((command) => {
      if (command === 'undo') {
        if (isEditable(document.activeElement)) document.execCommand('undo');
        else if (!document.querySelector('.modal-backdrop')) undo();
      } else if (command === 'settings') setView({ kind: 'settings' });
      else if (command === 'fetch') actions.fetch();
      else if (command === 'pull') actions.pull();
      else if (command === 'push') actions.push();
      else if (command === 'new-branch') actions.createBranch();
      else if (command === 'stash') actions.stashSave();
      else if (command === 'refresh') refresh();
      else if (command === 'view-working') setView({ kind: 'working' });
      else if (command === 'view-history') setView({ kind: 'history' });
      else if (command === 'view-stashes') setView({ kind: 'stashes' });
    });
  }, [active, actions, undo, refresh, setView]);

  if (!active) return null;

  if (error && !status) {
    return (
      <div className="repo-window">
        {tabs}
        <div className="empty-state">
          <div className="empty-title">Could not open “{repo.name}”</div>
          <div className="error-text">{error}</div>
          <div className="empty-actions">
            <button className="button" onClick={() => refresh()}>
              Retry
            </button>
            <button className="button" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  let main: ReactNode;
  if (loading && !status) main = <div className="empty-state muted">Loading repository…</div>;
  else if (view.kind === 'working') main = <WorkingCopy />;
  else if (view.kind === 'history') main = <History refName={view.ref} label={view.label} select={view.select} />;
  else if (view.kind === 'stashes') main = <Stashes initial={view.selected} />;
  else if (view.kind === 'file') main = <FileView path={view.path} mode={view.mode} rev={view.rev} select={view.select} />;
  else main = <SettingsView />;

  return (
    <div className="repo-window">
      <Toolbar onRepoMenu={onRepoMenu} />
      {tabs}
      <div className="repo-body">
        <div style={{ width: sidebarWidth, flex: 'none', display: 'flex' }}>
          <Sidebar />
        </div>
        <Splitter value={sidebarWidth} onChange={setSidebarWidth} min={180} max={420} />
        <main className="main">
          <StateBanner />
          {main}
        </main>
      </div>
    </div>
  );
}
