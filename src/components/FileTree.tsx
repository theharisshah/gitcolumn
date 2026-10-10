import { ChevronDown, ChevronRight } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StatusCode, TreeEntry } from '../../shared/types';
import { api } from '../lib/api';
import { FileIcon } from '../lib/fileIcons';
import { useVirtualList } from '../lib/useVirtualList';
import { useRepo } from '../repo/RepoContext';

const ROW_H = 24;

interface Row {
  entry: TreeEntry;
  depth: number;
  expanded: boolean;
}

type DirState = TreeEntry[] | 'loading' | { error: string };

/** Lazily loaded, virtualized tree of a revision (or the working copy when rev is null). */
export function FileTree({
  rev,
  selected,
  onSelect,
  onContextMenu,
  statusByPath,
  memoKey,
  revealPath,
}: {
  rev: string | null;
  selected?: string;
  onSelect: (entry: TreeEntry) => void;
  onContextMenu?: (e: React.MouseEvent, entry: TreeEntry) => void;
  statusByPath?: Map<string, StatusCode>;
  /** Key for remembering expanded folders while navigating */
  memoKey: string;
  /** Expand the folders leading to this path */
  revealPath?: string;
}) {
  const { repo, version, viewMemo } = useRepo();
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(viewMemo.get<string[]>(`${memoKey}:expanded`) ?? []));
  const scrollRef = useRef<HTMLDivElement>(null);
  const dirsRef = useRef(dirs);
  dirsRef.current = dirs;

  useEffect(() => viewMemo.set(`${memoKey}:expanded`, [...expanded]), [expanded, memoKey, viewMemo]);

  const load = useCallback(
    (dir: string, quiet = false) => {
      if (!quiet) setDirs((m) => new Map(m).set(dir, 'loading'));
      api
        .treeList(repo.path, rev, dir)
        .then((entries) => setDirs((m) => new Map(m).set(dir, entries)))
        .catch((e) => setDirs((m) => new Map(m).set(dir, { error: e instanceof Error ? e.message : String(e) })));
    },
    [repo.path, rev],
  );

  // A different revision is a different tree.
  useEffect(() => {
    setDirs(new Map());
    load('');
  }, [load]);

  // Expanded folders load on demand.
  useEffect(() => {
    for (const dir of expanded) if (!dirsRef.current.has(dir)) load(dir);
  }, [expanded, load]);

  // The working copy changes underneath us: refresh what's visible without flashing.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (rev !== null) return;
    for (const dir of ['', ...expanded]) if (dirsRef.current.has(dir)) load(dir, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(() => {
    if (!revealPath) return;
    const parts = revealPath.split('/');
    const parents = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
    if (parents.length) setExpanded((s) => new Set([...s, ...parents]));
  }, [revealPath]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (dir: string, depth: number) => {
      const state = dirs.get(dir);
      if (!Array.isArray(state)) return;
      for (const entry of state) {
        const isOpen = entry.type === 'tree' && expanded.has(entry.path);
        out.push({ entry, depth, expanded: isOpen });
        if (isOpen) walk(entry.path, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }, [dirs, expanded]);

  // Folders containing working-copy changes get a marker too.
  const changedDirs = useMemo(() => {
    const set = new Set<string>();
    statusByPath?.forEach((_, p) => {
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    });
    return set;
  }, [statusByPath]);

  const { start, end, totalHeight, scrollToIndex } = useVirtualList(scrollRef, rows.length, ROW_H);
  const selIndex = rows.findIndex((r) => r.entry.path === selected);
  useEffect(() => {
    if (selIndex >= 0) scrollToIndex(selIndex);
  }, [selIndex, scrollToIndex]);

  const toggle = (path: string, open?: boolean) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (open ?? !next.has(path)) next.add(path);
      else next.delete(path);
      return next;
    });

  const onKeyDown = (e: React.KeyboardEvent) => {
    const row = rows[selIndex];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = rows[Math.max(0, Math.min(rows.length - 1, selIndex + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) onSelect(next.entry);
    } else if (e.key === 'ArrowRight' && row?.entry.type === 'tree') {
      e.preventDefault();
      if (!row.expanded) toggle(row.entry.path, true);
      else if (rows[selIndex + 1]?.depth > row.depth) onSelect(rows[selIndex + 1].entry);
    } else if (e.key === 'ArrowLeft' && row) {
      e.preventDefault();
      if (row.expanded) toggle(row.entry.path, false);
      else {
        const parent = row.entry.path.split('/').slice(0, -1).join('/');
        const p = rows.find((r) => r.entry.path === parent);
        if (p) onSelect(p.entry);
      }
    } else if (e.key === 'Enter' && row?.entry.type === 'tree') {
      toggle(row.entry.path);
    }
  };

  const root = dirs.get('');
  const items = [];
  for (let i = start; i < end; i++) {
    const r = rows[i];
    items.push(
      <TreeRow
        key={r.entry.path}
        row={r}
        top={i * ROW_H}
        selected={r.entry.path === selected}
        status={statusByPath?.get(r.entry.path)}
        changedInside={r.entry.type === 'tree' && changedDirs.has(r.entry.path)}
        loading={r.expanded && dirs.get(r.entry.path) === 'loading'}
        onClick={() => {
          onSelect(r.entry);
          if (r.entry.type === 'tree') toggle(r.entry.path);
        }}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, r.entry) : undefined}
      />,
    );
  }

  return (
    <div className="file-tree" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown}>
      {root === 'loading' || !root ? (
        <div className="tree-note muted">Loading…</div>
      ) : !Array.isArray(root) ? (
        <div className="tree-note error-text">{root.error}</div>
      ) : !rows.length ? (
        <div className="tree-note muted">Empty</div>
      ) : (
        <div style={{ height: totalHeight, position: 'relative' }}>{items}</div>
      )}
    </div>
  );
}

const STATUS_CLASS: Partial<Record<StatusCode, string>> = { M: 'modified', T: 'modified', A: 'added', '?': 'added', D: 'deleted', R: 'renamed', C: 'renamed', U: 'conflicted' };

const TreeRow = memo(function TreeRow({
  row,
  top,
  selected,
  status,
  changedInside,
  loading,
  onClick,
  onContextMenu,
}: {
  row: Row;
  top: number;
  selected: boolean;
  status?: StatusCode;
  changedInside: boolean;
  loading: boolean;
  onClick: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const { entry, depth, expanded } = row;
  const isDir = entry.type === 'tree';
  return (
    <div
      className={`tree-row ${selected ? 'selected' : ''} ${status ? `tree-status-${STATUS_CLASS[status] ?? 'modified'}` : ''}`}
      style={{ top, height: ROW_H, paddingLeft: 8 + depth * 16 }}
      onMouseDown={(e) => e.button === 0 && onClick()}
      onContextMenu={onContextMenu}
      title={entry.path}
    >
      <span className="tree-chevron">{isDir ? expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} /> : null}</span>
      <FileIcon path={entry.path} type={entry.type} open={expanded} />
      <span className="tree-name">{entry.name}</span>
      {loading && <span className="muted small">…</span>}
      {status && <span className="tree-status">{status === '?' ? 'U' : status}</span>}
      {!status && changedInside && <span className="tree-dot" />}
    </div>
  );
});
