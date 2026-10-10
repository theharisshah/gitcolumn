import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { RepoInfo } from '../../shared/types';
import { shortcutFromEvent, useCommands, type Command } from '../repo/commands';
import type { View } from '../repo/navigation';
import { RepoProvider, useRepo } from '../repo/RepoContext';
import { BranchesReview } from './BranchesReview';
import { CompareView } from './CompareView';
import { FilesView } from './FilesView';
import { FileView } from './FileView';
import { History } from './History';
import { PullRequests } from './PullRequests';
import { QuickActions } from './QuickActions';
import { ReflogView } from './ReflogView';
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
  const { view, status, error, loading, refresh, repo, back, forward } = useRepo();
  const [sidebarWidth, setSidebarWidth] = usePersistentSize('sidebar', 240);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const commands = useCommands({ openPalette });
  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  useEffect(() => {
    if (!active) return;
    const runCommand = (cmd: Command | undefined) => {
      if (!cmd || cmd.enabled === false) return false;
      if (cmd.id === 'edit.undo' && isEditable(document.activeElement)) return false;
      cmd.run();
      return true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('.modal-backdrop')) return;
      const key = shortcutFromEvent(e);
      if (!key) return;
      const cmd = commandsRef.current.find((c) => c.shortcut === key);
      // In Electron the app menu owns these accelerators and delivers them through onMenu.
      if (!cmd || (window.gitcolumn && cmd.menu)) return;
      if (runCommand(cmd)) e.preventDefault();
    };
    // Mouse back/forward buttons.
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3) back();
      else if (e.button === 4) forward();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mouseup', onMouse);
    const offMenu = window.gitcolumn?.onMenu((id) => {
      if (id === 'edit.undo' && isEditable(document.activeElement)) {
        document.execCommand('undo');
        return;
      }
      if (document.querySelector('.modal-backdrop') && id !== 'edit.undo') return;
      runCommand(commandsRef.current.find((c) => c.id === id));
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouse);
      offMenu?.();
    };
  }, [active, back, forward]);

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
          {loading && !status ? <div className="empty-state muted">Loading repository…</div> : renderView(view)}
        </main>
      </div>
      {paletteOpen && <QuickActions commands={commands} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

function renderView(view: View): ReactNode {
  switch (view.kind) {
    case 'working':
      return <WorkingCopy />;
    case 'history':
      return <History refName={view.ref} label={view.label} select={view.select} search={view.search} scope={view.scope} />;
    case 'stashes':
      return <Stashes initial={view.selected} />;
    case 'file':
      return <FileView path={view.path} mode={view.mode} rev={view.rev} select={view.select} />;
    case 'files':
      return <FilesView rev={view.rev ?? null} label={view.label} path={view.path} />;
    case 'reflog':
      return <ReflogView refName={view.ref} select={view.select} />;
    case 'branches':
      return <BranchesReview base={view.base} />;
    case 'pulls':
      return <PullRequests state={view.state} number={view.number} />;
    case 'compare':
      return <CompareView base={view.base} head={view.head} baseLabel={view.baseLabel} headLabel={view.headLabel} />;
    case 'settings':
      return <SettingsView />;
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }
}
