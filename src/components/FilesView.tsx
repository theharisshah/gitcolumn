import { Download, FolderTree, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { StatusCode, TreeEntry } from '../../shared/types';
import { api } from '../lib/api';
import { FileIcon } from '../lib/fileIcons';
import { copyText } from '../lib/format';
import { fuzzyFilter } from '../lib/fuzzy';
import { useActions } from '../repo/actions';
import { useRepo } from '../repo/RepoContext';
import { useUI, type MenuItem } from '../ui/UIProvider';
import { FileContent } from './FileContent';
import { FileTree } from './FileTree';
import { RevPicker } from './RevPicker';
import { Splitter, usePersistentSize } from './Splitter';
import { primaryStatus } from './StatusBadge';

/** The Files view: browse the working copy or any revision. */
export function FilesView({ rev, label, path }: { rev: string | null; label?: string; path?: string }) {
  const { setView } = useRepo();
  const actions = useActions();
  return (
    <div className="files-view">
      <div className="pane-header files-header">
        <FolderTree size={14} className="muted" />
        <RevPicker rev={rev} label={label} onChange={(r, l) => setView({ kind: 'files', rev: r, label: r === null ? undefined : l }, { replace: true })} />
        <span className="spacer" />
        <button className="button button-small" onClick={() => actions.exportFiles(rev ?? 'HEAD', rev === null ? 'HEAD' : label ?? rev)} title="Save the files of this revision as a zip archive">
          <Download size={12} /> Export Files…
        </button>
      </div>
      <FilesBrowser key={rev ?? ':wc'} rev={rev} initialPath={path} />
    </div>
  );
}

/** Tree + content browser for one revision; also used for the Tree tab in commit details. */
export function FilesBrowser({ rev, initialPath, compact }: { rev: string | null; initialPath?: string; compact?: boolean }) {
  const { repo, status, version, viewMemo } = useRepo();
  const ui = useUI();
  const actions = useActions();
  const memoKey = `files:${rev ?? ':wc'}`;
  const [selected, setSelected] = useState<TreeEntry | null>(() => {
    const p = initialPath ?? viewMemo.get<string>(`${memoKey}:selected`);
    return p ? { name: p.slice(p.lastIndexOf('/') + 1), path: p, type: 'blob' } : null;
  });
  const [size, setSize] = usePersistentSize(compact ? 'files.tree.compact' : 'files.tree', compact ? 220 : 300);
  const [filter, setFilter] = useState('');
  const [allPaths, setAllPaths] = useState<string[] | null>(null);
  const [revealPath, setRevealPath] = useState<string | undefined>(initialPath);

  useEffect(() => {
    if (selected) viewMemo.set(`${memoKey}:selected`, selected.path);
  }, [selected, memoKey, viewMemo]);

  // Every path, loaded when the filter is first used (and refreshed for the working copy).
  useEffect(() => {
    if (!filter.trim()) return;
    let cancelled = false;
    api
      .filesSearch(repo.path, rev)
      .then((p) => !cancelled && setAllPaths(p))
      .catch(() => !cancelled && setAllPaths([]));
    return () => {
      cancelled = true;
    };
  }, [repo.path, rev, filter === '' ? 0 : 1, rev === null ? version : 0]);

  const matches = useMemo(
    () => (filter.trim() && allPaths ? fuzzyFilter(allPaths, filter, (p) => p, { path: true, limit: 300 }) : []),
    [allPaths, filter],
  );

  const statusByPath = useMemo(() => {
    if (rev !== null || !status) return undefined;
    const m = new Map<string, StatusCode>();
    for (const f of status.files) m.set(f.path, primaryStatus(f));
    return m;
  }, [rev, status]);

  const entryMenu = (e: React.MouseEvent, entry: TreeEntry) => {
    const items: MenuItem[] = [];
    if (entry.type === 'blob' || entry.type === 'symlink') {
      items.push({ label: 'Blame', onClick: () => actions.blame(entry.path, rev) });
      items.push({ label: 'Show File History', onClick: () => actions.showFileHistory(entry.path, rev) });
    }
    if (entry.type === 'tree') items.push({ label: 'Export This Folder…', onClick: () => actions.exportFiles(rev ?? 'HEAD', rev ?? 'HEAD', entry.path) });
    if (rev === null) {
      items.push('separator');
      items.push({ label: 'Ignore…', onClick: () => actions.ignore(entry.path) });
      items.push({ label: 'Reveal in Finder', onClick: () => api.reveal(repo.path, entry.path).catch((err) => ui.toast('error', 'Could not reveal', String(err))) });
      if (entry.type !== 'tree') items.push({ label: 'Open with Default App', onClick: () => api.openPath(repo.path, entry.path).catch((err) => ui.toast('error', 'Could not open', String(err))) });
    }
    items.push('separator', { label: 'Copy Path', onClick: () => copyText(entry.path) });
    ui.menu(e, items);
  };

  const showFile = selected && selected.type !== 'tree';
  return (
    <div className={`files-browser ${compact ? 'compact' : ''}`}>
      <div className="files-tree-pane" style={compact ? { height: size } : { width: size }}>
        <div className="files-filter search-box">
          <Search size={12} />
          <input placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setFilter('')} spellCheck={false} />
          {filter && (
            <button className="icon-button" onClick={() => setFilter('')}>
              <X size={12} />
            </button>
          )}
        </div>
        {filter.trim() ? (
          <div className="file-tree">
            {!allPaths ? (
              <div className="tree-note muted">Searching…</div>
            ) : !matches.length ? (
              <div className="tree-note muted">No matching files</div>
            ) : (
              matches.map(({ item: p, match }) => (
                <div
                  key={p}
                  className={`tree-row flat ${selected?.path === p ? 'selected' : ''}`}
                  onMouseDown={() => setSelected({ name: p.slice(p.lastIndexOf('/') + 1), path: p, type: 'blob' })}
                  onDoubleClick={() => {
                    setFilter('');
                    setRevealPath(p);
                  }}
                  onContextMenu={(e) => entryMenu(e, { name: p, path: p, type: 'blob' })}
                  title={p}
                >
                  <FileIcon path={p} />
                  <span className="tree-name">
                    <Highlighted text={p} positions={match.positions} />
                  </span>
                </div>
              ))
            )}
          </div>
        ) : (
          <FileTree
            rev={rev}
            selected={selected?.path}
            onSelect={setSelected}
            onContextMenu={entryMenu}
            statusByPath={statusByPath}
            memoKey={memoKey}
            revealPath={revealPath}
          />
        )}
      </div>
      <Splitter value={size} onChange={setSize} min={compact ? 100 : 180} max={compact ? 600 : 700} vertical={compact} />
      <div className="files-content-pane">
        {showFile ? (
          <FileContent key={selected.path} rev={rev} path={selected.path} />
        ) : (
          <div className="empty-state muted">{selected ? `Folder ${selected.path}` : 'Select a file to view it'}</div>
        )}
      </div>
    </div>
  );
}

function Highlighted({ text, positions }: { text: string; positions: number[] }) {
  if (!positions.length) return <>{text}</>;
  const set = new Set(positions);
  return (
    <>
      {[...text].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : ch))}
    </>
  );
}
