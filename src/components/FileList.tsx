import { AlertTriangle, Check, ChevronDown, ChevronRight, ChevronUp, FolderTree, List, Minus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { FileStatus } from '../../shared/types';
import { FileIcon } from '../lib/fileIcons';
import { basename, dirname, plural } from '../lib/format';
import { buildPathTree, flattenTree, type TreeRow } from '../lib/pathTree';
import { useRepo } from '../repo/RepoContext';
import { StatusBadge, primaryStatus } from './StatusBadge';

export type StageState = 'full' | 'partial' | 'none' | 'conflict';

export function stageState(f: FileStatus): StageState {
  if (f.conflicted) return 'conflict';
  if (f.untracked) return 'none';
  const staged = f.index !== '.';
  const unstaged = f.worktree !== '.';
  if (staged && unstaged) return 'partial';
  return staged ? 'full' : 'none';
}

/** Combined state of several files (a folder, or the whole list). */
export function groupState(files: FileStatus[]): StageState {
  const stageable = files.filter((f) => !f.conflicted);
  if (!stageable.length) return files.length ? 'conflict' : 'none';
  if (stageable.every((f) => stageState(f) === 'full')) return 'full';
  return stageable.some((f) => stageState(f) !== 'none') ? 'partial' : 'none';
}

/** Unique row id: a path can appear twice (staged deletion + untracked file of the same name). */
export const keyOf = (f: FileStatus) => (f.untracked ? `?${f.path}` : f.path);

type SortKey = 'status' | 'path';
interface Sort {
  key: SortKey;
  dir: 1 | -1;
}
type Mode = 'flat' | 'tree';

const STATUS_RANK: Record<string, number> = { U: 0, M: 1, T: 1, A: 2, '?': 3, R: 4, C: 4, D: 5 };

function load<T>(key: string, fallback: T, valid: (v: unknown) => boolean): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null');
    return valid(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export function comparer(sort: Sort) {
  const byPath = (a: FileStatus, b: FileStatus) => a.path.localeCompare(b.path);
  return (a: FileStatus, b: FileStatus) => {
    if (sort.key === 'status') {
      const d = (STATUS_RANK[primaryStatus(a)] ?? 9) - (STATUS_RANK[primaryStatus(b)] ?? 9);
      return (d || byPath(a, b)) * sort.dir;
    }
    // Conflicts stay on top when sorting by name: they block committing.
    return Number(b.conflicted) - Number(a.conflicted) || byPath(a, b) * sort.dir;
  };
}

/** The Working Copy's file table: sortable, flat or as a folder tree, with staging checkboxes. */
export function FileList({
  files,
  selected,
  onSelect,
  onToggleStage,
  onStageAll,
  onUnstageAll,
  onDiscard,
  onContextMenu,
}: {
  files: FileStatus[];
  selected: string[];
  onSelect: (keys: string[]) => void;
  onToggleStage: (files: FileStatus[]) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onDiscard: (files: FileStatus[]) => void;
  onContextMenu: (e: React.MouseEvent, f: FileStatus) => void;
}) {
  const { viewMemo, status } = useRepo();
  const [sort, setSortState] = useState<Sort>(() =>
    load('gitcolumn.wcSort', { key: 'path', dir: 1 }, (v) => !!v && typeof v === 'object' && ['status', 'path'].includes((v as Sort).key)),
  );
  const [mode, setModeState] = useState<Mode>(() => load<Mode>('gitcolumn.wcMode', 'flat', (v) => v === 'flat' || v === 'tree'));
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(viewMemo.get<string[]>('wc:collapsed') ?? []));
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const setSort = (key: SortKey) => {
    const next: Sort = sort.key === key ? { key, dir: sort.dir === 1 ? -1 : 1 } : { key, dir: 1 };
    setSortState(next);
    save('gitcolumn.wcSort', next);
  };
  const setMode = (m: Mode) => {
    setModeState(m);
    save('gitcolumn.wcMode', m);
  };
  const toggleFolder = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      viewMemo.set('wc:collapsed', [...next]);
      return next;
    });

  const rows: TreeRow<FileStatus>[] = useMemo(() => {
    const compare = comparer(sort);
    if (mode === 'flat') return [...files].sort(compare).map((item) => ({ kind: 'file', item, depth: 0 }));
    return flattenTree(buildPathTree(files, (f) => f.path), collapsed, compare);
  }, [files, sort, mode, collapsed]);

  /** Files in display order, for keyboard and shift-click ranges. */
  const order = useMemo(() => rows.flatMap((r) => (r.kind === 'file' ? [r.item] : [])), [rows]);
  // Every selected file counts, also those inside collapsed folders.
  const selectedFiles = files.filter((f) => selected.includes(keyOf(f)));
  const hasConflicts = files.some((f) => f.conflicted);
  const stagedCount = files.filter((f) => !f.conflicted && f.index !== '.').length;
  const allState = groupState(files);

  const onRowClick = (e: React.MouseEvent, f: FileStatus) => {
    const k = keyOf(f);
    if (e.metaKey || e.ctrlKey) {
      onSelect(selected.includes(k) ? selected.filter((p) => p !== k) : [...selected, k]);
      anchor.current = k;
    } else if (e.shiftKey && anchor.current) {
      const a = order.findIndex((x) => keyOf(x) === anchor.current);
      const b = order.findIndex((x) => keyOf(x) === k);
      if (a < 0 || b < 0) return onSelect([k]);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      onSelect(order.slice(lo, hi + 1).map(keyOf));
    } else {
      onSelect([k]);
      anchor.current = k;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!order.length) return;
    const idx = order.findIndex((f) => keyOf(f) === (anchor.current ?? selected[0]));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = order[Math.max(0, Math.min(order.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
      onSelect([keyOf(next)]);
      anchor.current = keyOf(next);
      listRef.current?.querySelector(`[data-key="${CSS.escape(keyOf(next))}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === ' ') {
      e.preventDefault();
      onToggleStage(selectedFiles);
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onDiscard(selectedFiles);
    } else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onSelect(order.map(keyOf));
    }
  };

  const sortIcon = (key: SortKey) => (sort.key === key ? sort.dir === 1 ? <ChevronUp size={11} /> : <ChevronDown size={11} /> : null);
  const indent = (depth: number) => ({ paddingLeft: 10 + depth * 14 });

  return (
    <>
      <div className="pane-header wc-list-header">
        <Checkbox
          state={allState === 'conflict' ? 'none' : allState}
          disabled={!files.length || files.every((f) => f.conflicted)}
          onClick={() => {
            // With conflicts, never stage conflicted files (that marks them resolved) or reset the index.
            if (hasConflicts) onToggleStage(files.filter((f) => !f.conflicted));
            else if (allState === 'full') onUnstageAll();
            else onStageAll();
          }}
          title={allState === 'full' ? 'Unstage all' : hasConflicts ? 'Stage all resolved files' : 'Stage all'}
        />
        <span className="pane-title">
          {files.length ? plural(files.length, 'changed file') : 'No changes'}
          {stagedCount > 0 && <span className="muted"> · {stagedCount} staged</span>}
        </span>
        <span className="spacer" />
        <div className="segmented segmented-icons">
          <button className={mode === 'flat' ? 'active' : ''} onClick={() => setMode('flat')} title="Show as a list">
            <List size={13} />
          </button>
          <button className={mode === 'tree' ? 'active' : ''} onClick={() => setMode('tree')} title="Show as a folder tree">
            <FolderTree size={13} />
          </button>
        </div>
      </div>
      {files.length > 0 && (
        <div className="file-table-head">
          <button className={`sort-header status-col ${sort.key === 'status' ? 'active' : ''}`} onClick={() => setSort('status')} title="Sort by status">
            Status {sortIcon('status')}
          </button>
          <button className={`sort-header ${sort.key === 'path' ? 'active' : ''}`} onClick={() => setSort('path')} title="Sort by file path">
            File {sortIcon('path')}
          </button>
        </div>
      )}
      <div className="file-list" tabIndex={0} ref={listRef} onKeyDown={onKeyDown}>
        {rows.map((row) => {
          if (row.kind === 'dir') {
            const st = groupState(row.items);
            const conflicts = row.items.filter((f) => f.conflicted).length;
            return (
              <div
                key={`dir:${row.path}`}
                className={`file-row folder-row ${conflicts ? 'conflicted' : ''}`}
                style={indent(row.depth)}
                onClick={() => toggleFolder(row.path)}
                title={conflicts ? `${row.path} — ${plural(conflicts, 'conflict')}` : row.path}
              >
                <span className="folder-chevron">{row.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>
                <Checkbox
                  state={st === 'conflict' ? 'none' : st}
                  disabled={st === 'conflict'}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleStage(row.items);
                  }}
                  title={st === 'full' ? `Unstage ${row.name}` : `Stage ${row.name}`}
                />
                <FileIcon path={row.path} type="tree" open={!row.collapsed} />
                <span className="file-name">{row.name}</span>
                {conflicts > 0 && <AlertTriangle size={12} className="folder-conflict" />}
                <span className="folder-count muted">{row.items.length}</span>
              </div>
            );
          }
          const f = row.item;
          const k = keyOf(f);
          const isSel = selected.includes(k);
          return (
            <div
              key={k}
              data-key={k}
              className={`file-row ${isSel ? 'selected' : ''} ${f.conflicted ? 'conflicted' : ''}`}
              style={mode === 'tree' ? indent(row.depth + 1) : undefined}
              onMouseDown={(e) => {
                if (e.button === 0) onRowClick(e, f);
              }}
              onContextMenu={(e) => onContextMenu(e, f)}
              onDoubleClick={() => onToggleStage([f])}
            >
              <Checkbox
                state={stageState(f)}
                disabled={f.conflicted}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleStage(isSel ? selectedFiles : [f]);
                }}
              />
              <StatusBadge status={primaryStatus(f)} />
              <FileIcon path={f.path} />
              <span className="file-name" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
                {f.path.endsWith('/') ? `${basename(f.path.slice(0, -1))}/` : basename(f.path)}
                {mode === 'flat' && <span className="file-dir">{dirname(f.path)}</span>}
                {f.origPath && (
                  <span className="file-dir">
                    ← {mode === 'flat' || dirname(f.origPath) !== dirname(f.path) ? f.origPath : basename(f.origPath)}
                  </span>
                )}
              </span>
            </div>
          );
        })}
        {!files.length && status && (
          <div className="empty-state small">
            <Check size={28} strokeWidth={1.5} />
            <div>Working copy is clean</div>
          </div>
        )}
      </div>
    </>
  );
}

export function Checkbox({
  state,
  onClick,
  disabled,
  title,
}: {
  state: StageState;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`checkbox checkbox-${state}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
      disabled={disabled}
      title={title ?? (state === 'full' ? 'Unstage' : 'Stage')}
      aria-checked={state === 'full' ? true : state === 'partial' ? 'mixed' : false}
      role="checkbox"
    >
      {state === 'full' ? <Check size={11} strokeWidth={3} /> : state === 'partial' ? <Minus size={11} strokeWidth={3} /> : state === 'conflict' ? <AlertTriangle size={10} strokeWidth={2.5} /> : null}
    </button>
  );
}
