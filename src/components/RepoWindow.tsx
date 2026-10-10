import { useEffect, type ReactNode } from 'react';
import type { RepoInfo } from '../../shared/types';
import { useActions } from '../repo/actions';
import { RepoProvider, useRepo } from '../repo/RepoContext';
import { History } from './History';
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

function RepoLayout({ active, tabs, onRepoMenu, onClose }: Props) {
  const { view, setView, status, error, loading, refresh, repo } = useRepo();
  const actions = useActions();
  const [sidebarWidth, setSidebarWidth] = usePersistentSize('sidebar', 240);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || document.querySelector('.modal-backdrop')) return;
      const k = e.key.toLowerCase();
      if (!e.shiftKey && k === '1') setView({ kind: 'working' });
      else if (!e.shiftKey && k === '2') setView({ kind: 'history' });
      else if (!e.shiftKey && k === '3') setView({ kind: 'stashes' });
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
  }, [active, setView, refresh, actions]);

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
          {loading && !status ? (
            <div className="empty-state muted">Loading repository…</div>
          ) : view.kind === 'working' ? (
            <WorkingCopy />
          ) : view.kind === 'history' ? (
            <History refName={view.ref} label={view.label} />
          ) : (
            <Stashes initial={view.selected} />
          )}
        </main>
      </div>
    </div>
  );
}
