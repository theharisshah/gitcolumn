import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  FolderOpen,
  GitBranch,
  GitMerge,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SquareTerminal,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, isElectron } from '../lib/api';
import { isMac, modKey, shortHash } from '../lib/format';
import { getSetting, setSetting } from '../lib/settings';
import { useActions } from '../repo/actions';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';

export function Toolbar({ onRepoMenu }: { onRepoMenu: (e: React.MouseEvent) => void }) {
  const { repo, status, refs, stashes, busy, refresh, setView, back, forward, canGoBack, canGoForward } = useRepo();
  const actions = useActions();
  const ui = useUI();
  const [pickerOpen, setPickerOpen] = useState(false);

  const branchLabel = status?.branch ?? (status?.head ? `Detached at ${shortHash(status.head)}` : '…');
  const hasRemote = refs.some((r) => r.type === 'remote');

  const pickMerge = async () => {
    if (!status?.branch) return ui.toast('warning', 'Check out a branch before merging');
    const candidates = refs.filter((r) => (r.type === 'head' && !r.current) || r.type === 'remote');
    if (!candidates.length) return ui.toast('info', 'There are no other branches to merge');
    const v = await ui.form({
      title: `Merge into "${status.branch}"`,
      fields: [
        {
          name: 'ref',
          label: 'Branch to merge',
          type: 'select',
          value: candidates.find((c) => c.name === status.upstream)?.name ?? candidates[0].name,
          options: candidates.map((c) => ({ value: c.name, label: c.type === 'remote' ? `${c.name} (remote)` : c.name })),
        },
      ],
      confirmLabel: 'Continue',
    });
    if (v) actions.merge(String(v.ref));
  };

  return (
    <header className={`toolbar ${isElectron && isMac ? 'toolbar-inset' : ''}`}>
      <div className="toolbar-repo">
        <button className="repo-button" onClick={onRepoMenu} title={repo.path}>
          <span className="repo-name">{repo.name}</span>
          <ChevronDown size={12} />
        </button>
        <div className="branch-picker-anchor">
          <button className="branch-button" onClick={() => setPickerOpen((o) => !o)} title="Switch branch">
            <GitBranch size={13} />
            <span className="branch-name">{branchLabel}</span>
            {!!status?.ahead && <span className="tb-count">↑{status.ahead}</span>}
            {!!status?.behind && <span className="tb-count">↓{status.behind}</span>}
            <ChevronDown size={12} />
          </button>
          {pickerOpen && <BranchPicker onClose={() => setPickerOpen(false)} />}
        </div>
      </div>

      <div className="toolbar-nav">
        <button className="icon-button nav-button" disabled={!canGoBack} onClick={back} title={`Back (${modKey}[)`}>
          <ChevronLeft size={16} />
        </button>
        <button className="icon-button nav-button" disabled={!canGoForward} onClick={forward} title={`Forward (${modKey}])`}>
          <ChevronRight size={16} />
        </button>
      </div>
      <div className="toolbar-group">
        <ToolButton icon={<CloudDownload size={18} />} label="Fetch" onClick={() => actions.fetch()} disabled={!!busy} title={`Fetch all remotes (${modKey}⇧F)`} />
        <ToolButton
          icon={<ArrowDownToLine size={18} />}
          label="Pull"
          badge={status?.behind || undefined}
          onClick={() => actions.pull()}
          onContextMenu={(e) => {
            const rebase = getSetting('pullRebase');
            ui.menu(e, [
              { header: 'When pulling' },
              { label: 'Merge remote changes', checked: !rebase, onClick: () => setSetting('pullRebase', false) },
              { label: 'Rebase onto remote changes', checked: rebase, onClick: () => setSetting('pullRebase', true) },
            ]);
          }}
          disabled={!!busy || !hasRemote}
          title={`Pull (${modKey}⇧L) — right-click for options`}
        />
        <ToolButton
          icon={<ArrowUpFromLine size={18} />}
          label="Push"
          badge={status?.ahead || undefined}
          onClick={() => actions.push()}
          disabled={!!busy}
          title={`Push (${modKey}⇧P)`}
        />
      </div>
      <div className="toolbar-group">
        <ToolButton icon={<GitBranch size={18} />} label="Branch" onClick={() => actions.createBranch()} disabled={!!busy || !status?.head} title={`New branch (${modKey}⇧B)`} />
        <ToolButton icon={<GitMerge size={18} />} label="Merge" onClick={pickMerge} disabled={!!busy || !status?.head} />
        <ToolButton icon={<Archive size={18} />} label="Stash" onClick={() => actions.stashSave()} disabled={!!busy || !status?.files.length} title={`Stash changes (${modKey}⇧S)`} />
        <ToolButton icon={<ArchiveRestore size={18} />} label="Pop" onClick={() => stashes[0] && actions.stashApply(stashes[0], true)} disabled={!!busy || !stashes.length} title={stashes[0] ? `Pop “${stashes[0].message}”` : 'No stashes'} />
      </div>

      <div className="toolbar-spacer" />

      {busy && (
        <div className="activity">
          <LoaderCircle size={14} className="spin" />
          <span>{busy}</span>
        </div>
      )}
      <div className="toolbar-group compact">
        <ToolButton icon={<RefreshCw size={16} />} onClick={() => refresh()} title={`Refresh (${modKey}R)`} small />
        <ToolButton icon={<FolderOpen size={16} />} onClick={() => api.reveal(repo.path).catch((e) => ui.toast('error', 'Could not open folder', String(e)))} title="Show in Finder" small />
        <ToolButton icon={<SquareTerminal size={16} />} onClick={() => api.openTerminal(repo.path).catch((e) => ui.toast('error', 'Could not open terminal', String(e)))} title="Open in Terminal" small />
        <ToolButton icon={<Settings size={16} />} onClick={() => setView({ kind: 'settings' })} title={`Repository settings (${modKey},)`} small />
      </div>
    </header>
  );
}

function ToolButton({
  icon,
  label,
  onClick,
  onContextMenu,
  disabled,
  title,
  badge,
  small,
}: {
  icon: ReactNode;
  label?: string;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  title?: string;
  badge?: number;
  small?: boolean;
}) {
  return (
    <button className={`tool-button ${small ? 'small' : ''}`} onClick={onClick} onContextMenu={onContextMenu} disabled={disabled} title={title ?? label}>
      <span className="tool-icon">
        {icon}
        {badge !== undefined && <span className="tool-badge">{badge}</span>}
      </span>
      {label && <span className="tool-label">{label}</span>}
    </button>
  );
}

function BranchPicker({ onClose }: { onClose: () => void }) {
  const { refs } = useRepo();
  const actions = useActions();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const list = useMemo(() => {
    const f = q.trim().toLowerCase();
    const locals = refs.filter((r) => r.type === 'head' && (!f || r.name.toLowerCase().includes(f)));
    const localNames = new Set(refs.filter((r) => r.type === 'head').map((r) => r.name));
    const remotes = f
      ? refs.filter((r) => r.type === 'remote' && r.name.toLowerCase().includes(f) && !localNames.has(r.name.slice((r.remote?.length ?? 0) + 1)))
      : [];
    return [...locals.sort((a, b) => Number(!!b.current) - Number(!!a.current) || b.date - a.date), ...remotes];
  }, [refs, q]);

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.branch-button') && onClose();
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [onClose]);

  useEffect(() => setActive(0), [q]);

  const choose = (i: number) => {
    const r = list[i];
    if (!r) return;
    onClose();
    actions.checkout(r);
  };

  return (
    <div className="popover branch-picker" ref={ref}>
      <div className="search-box popover-search">
        <Search size={13} />
        <input
          autoFocus
          placeholder="Switch to branch…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(list.length - 1, a + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === 'Enter') choose(active);
          }}
          spellCheck={false}
        />
      </div>
      <div className="popover-list">
        {list.map((r, i) => (
          <button key={r.ref} className={`popover-item ${i === active ? 'active' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>
            <span className="popover-check">{r.current && <Check size={12} strokeWidth={3} />}</span>
            <span className="popover-label">{r.name}</span>
            {r.type === 'remote' && <span className="muted small">remote</span>}
            {(!!r.ahead || !!r.behind) && (
              <span className="ahead-behind">
                {!!r.behind && <span>↓{r.behind}</span>}
                {!!r.ahead && <span>↑{r.ahead}</span>}
              </span>
            )}
          </button>
        ))}
        {!list.length && <div className="popover-empty">No matching branches</div>}
      </div>
      <button
        className="popover-footer"
        onClick={() => {
          onClose();
          actions.createBranch();
        }}
      >
        <Plus size={13} /> New Branch…
      </button>
    </div>
  );
}

export function StateBanner() {
  const { status } = useRepo();
  const actions = useActions();
  if (!status) return null;
  const s = status.state;
  const conflicts = status.files.filter((f) => f.conflicted).length;
  let title: string | null = null;
  if (s.rebasing) title = `Rebasing${s.rebaseHeadName ? ` “${s.rebaseHeadName}”` : ''}${s.rebaseProgress ? ` (${s.rebaseProgress})` : ''}`;
  else if (s.merging) title = 'Merge in progress';
  else if (s.cherryPicking) title = 'Cherry-pick in progress';
  else if (s.reverting) title = 'Revert in progress';
  if (!title) return null;

  const detail = conflicts
    ? `${conflicts} conflicted file${conflicts === 1 ? '' : 's'} left to resolve.`
    : s.merging && !s.rebasing
      ? 'All conflicts resolved. Commit to complete the merge.'
      : 'All conflicts resolved. Continue when ready.';

  return (
    <div className={`state-banner ${conflicts ? 'has-conflicts' : 'resolved'}`}>
      <div>
        <b>{title}</b> <span>{detail}</span>
      </div>
      <div className="state-banner-actions">
        <button className="button button-small" onClick={() => actions.abortOp()}>
          Abort
        </button>
        {s.rebasing && (
          <button className="button button-small" onClick={() => actions.skipOp()}>
            Skip Commit
          </button>
        )}
        <button className="button button-small button-primary" disabled={conflicts > 0} onClick={() => actions.continueOp()}>
          {s.merging && !s.rebasing ? 'Commit Merge' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
