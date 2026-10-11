import { ChevronDown, ChevronUp, FolderGit2, Layers, ListChecks, Pin, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { BranchReviewRow, Ref } from '../../shared/types';
import { api } from '../lib/api';
import { fullDate, plural, relativeTime } from '../lib/format';
import { useSetting } from '../lib/settings';
import { useVirtualList } from '../lib/useVirtualList';
import { useActions } from '../repo/actions';
import { useRefMenu } from '../repo/refMenu';
import { useRepo } from '../repo/RepoContext';

const ROW_H = 30;
type Filter = 'all' | 'merged' | 'stale' | 'ahead' | 'gone';
type SortKey = 'name' | 'ahead' | 'behind' | 'date';

/** Every branch compared with a base branch: what's merged, stale or gone, with bulk cleanup. */
export function BranchesReview({ base: baseProp }: { base?: string }) {
  const { repo, refs, version, setView } = useRepo();
  const actions = useActions();
  const refMenu = useRefMenu();
  const [staleDays] = useSetting('staleBranchDays');
  const [base, setBase] = useState<string | null>(baseProp ?? null);
  const [includeRemote, setIncludeRemote] = useState(false);
  const [rows, setRows] = useState<BranchReviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'date', dir: -1 });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [reload, setReload] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (base) return;
    api.defaultBase(repo.path).then((b) => setBase(b ?? 'HEAD'), () => setBase('HEAD'));
  }, [repo.path, base]);

  useEffect(() => {
    if (!base) return;
    let cancelled = false;
    api.branchesReview(repo.path, base, includeRemote).then(
      (r) => {
        if (cancelled) return;
        setRows(r);
        setError(null);
        // Drop checks for branches that are gone or moved.
        setChecked((prev) => new Set([...prev].filter((k) => r.some((x) => `${x.ref}@${x.hash}` === k))));
      },
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [repo.path, base, includeRemote, version, reload]);

  const now = Date.now() / 1000;
  const isStale = (r: BranchReviewRow) => now - r.date > staleDays * 86400;
  const baseName = base?.replace(/^refs\/(heads|remotes)\//, '') ?? '';
  // With a remote base (origin/main), the local branch of that name counts as the base too.
  const baseLocal = baseName.includes('/') && !refs.some((x) => x.type === 'head' && x.name === baseName) ? baseName.replace(/^[^/]+\//, '') : null;
  const isBase = (r: BranchReviewRow) => r.name === baseName || (r.type === 'head' && r.name === baseLocal);
  const deletable = (r: BranchReviewRow) => r.type === 'head' && !r.current && !r.worktree && !r.pinned && !isBase(r);
  const keyOf = (r: BranchReviewRow) => `${r.ref}@${r.hash}`;

  const counts = useMemo(() => {
    const all = rows ?? [];
    return {
      all: all.length,
      merged: all.filter((r) => r.merged && !isBase(r)).length,
      stale: all.filter(isStale).length,
      ahead: all.filter((r) => r.ahead > 0).length,
      gone: all.filter((r) => r.gone).length,
    };
  }, [rows, staleDays, baseName]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (rows ?? []).filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false;
      if (filter === 'merged') return r.merged && !isBase(r);
      if (filter === 'stale') return isStale(r);
      if (filter === 'ahead') return r.ahead > 0;
      if (filter === 'gone') return !!r.gone;
      return true;
    });
    const cmp = (a: BranchReviewRow, b: BranchReviewRow) => {
      const v = sort.key === 'name' ? a.name.localeCompare(b.name) : sort.key === 'date' ? a.date - b.date : a[sort.key] - b[sort.key];
      return (v || a.name.localeCompare(b.name)) * sort.dir;
    };
    // Pinned and current branches first, then the chosen order.
    return list.sort((a, b) => Number(!!b.current) - Number(!!a.current) || Number(!!b.pinned) - Number(!!a.pinned) || cmp(a, b));
  }, [rows, filter, query, sort, staleDays, baseName]);

  const { start, end, totalHeight } = useVirtualList(scrollRef, shown.length, ROW_H);
  const maxDiverge = useMemo(() => Math.max(1, ...shown.map((r) => Math.max(r.ahead, r.behind))), [shown]);
  const selected = (rows ?? []).filter((r) => checked.has(keyOf(r)) && deletable(r));

  const toggle = (r: BranchReviewRow) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(keyOf(r))) next.delete(keyOf(r));
      else next.add(keyOf(r));
      return next;
    });
  const setSortKey = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'name' ? 1 : -1 }));
  const sortIcon = (key: SortKey) => (sort.key === key ? sort.dir === 1 ? <ChevronUp size={11} /> : <ChevronDown size={11} /> : null);
  const refFor = (r: BranchReviewRow): Ref | undefined => refs.find((x) => x.ref === r.ref);

  const localBranches = refs.filter((r) => r.type === 'head').map((r) => r.name);
  const baseOptions = [...new Set([...(base ? [baseName] : []), ...localBranches, ...refs.filter((r) => r.type === 'remote' && /\/(main|master|develop|trunk)$/.test(r.name)).map((r) => r.name)])];

  return (
    <div className="branches-review">
      <div className="pane-header branches-header">
        <ListChecks size={14} className="muted" />
        <span className="pane-title">Branches Review</span>
        <span className="muted small">compared with</span>
        <select className="input branches-base" value={baseName} onChange={(e) => setBase(e.target.value)} title="Base branch">
          {baseOptions.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <label className="toggle">
          <input type="checkbox" checked={includeRemote} onChange={(e) => setIncludeRemote(e.target.checked)} />
          Remote branches
        </label>
        <span className="spacer" />
        <button className="icon-button" title="Reload" onClick={() => setReload((n) => n + 1)}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="branches-toolbar">
        <div className="segmented">
          {(['all', 'merged', 'stale', 'ahead', 'gone'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)} title={FILTER_HINT[f](staleDays, baseName)}>
              {FILTER_LABEL[f]} <span className="muted">{counts[f]}</span>
            </button>
          ))}
        </div>
        <div className="search-box branches-search">
          <Search size={12} />
          <input placeholder="Filter branches" value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} />
          {query && (
            <button className="icon-button" onClick={() => setQuery('')}>
              <X size={12} />
            </button>
          )}
        </div>
        <span className="spacer" />
        <button
          className="button button-small"
          onClick={() => setChecked(new Set((rows ?? []).filter((r) => r.merged && deletable(r)).map(keyOf)))}
          disabled={!(rows ?? []).some((r) => r.merged && deletable(r))}
          title="Select every merged branch that can be deleted (not current, pinned, checked out elsewhere or the base)"
        >
          Select Merged
        </button>
        <button
          className="button button-small button-danger-outline"
          disabled={!selected.length}
          onClick={async () => {
            const done = await actions.deleteBranches(selected.map((r) => ({ name: r.name, hash: r.hash })), baseName);
            // Keep the selection when the user cancels or the delete fails.
            if (done) setChecked(new Set());
          }}
        >
          <Trash2 size={12} /> Delete {selected.length ? plural(selected.length, 'Branch', 'Branches') : 'Branches'}
        </button>
      </div>
      <div className="branches-table-head">
        <span className="branches-check" />
        <button className={`sort-header bcol-name ${sort.key === 'name' ? 'active' : ''}`} onClick={() => setSortKey('name')}>
          Branch {sortIcon('name')}
        </button>
        <button className={`sort-header bcol-diverge ${sort.key === 'behind' || sort.key === 'ahead' ? 'active' : ''}`} onClick={() => setSortKey(sort.key === 'behind' ? 'ahead' : 'behind')} title="Behind | ahead of the base (click to sort by either)">
          Behind | Ahead {sortIcon('behind') ?? sortIcon('ahead')}
        </button>
        <button className={`sort-header bcol-date ${sort.key === 'date' ? 'active' : ''}`} onClick={() => setSortKey('date')}>
          Last Commit {sortIcon('date')}
        </button>
        <span className="bcol-upstream">Upstream</span>
      </div>
      <div className="branches-scroll" ref={scrollRef}>
        {error ? (
          <div className="empty-state error-text">{error}</div>
        ) : !rows ? (
          <div className="empty-state muted">Comparing branches…</div>
        ) : !shown.length ? (
          <div className="empty-state muted">No branches match.</div>
        ) : (
          <div style={{ height: totalHeight, position: 'relative' }}>
            {shown.slice(start, end).map((r, k) => {
              const i = start + k;
              const can = deletable(r);
              const ref = refFor(r);
              return (
                <div
                  key={r.ref}
                  className={`branches-row ${r.current ? 'current' : ''} ${checked.has(keyOf(r)) && can ? 'checked' : ''}`}
                  style={{ top: i * ROW_H, height: ROW_H }}
                  onContextMenu={(e) => ref && refMenu(e, ref)}
                  onDoubleClick={() => setView({ kind: 'history', ref: r.ref, label: r.name })}
                >
                  <span className="branches-check">
                    <input type="checkbox" disabled={!can} checked={can && checked.has(keyOf(r))} onChange={() => toggle(r)} title={can ? 'Select for deletion' : WHY_NOT(r, isBase(r))} />
                  </span>
                  <span className="bcol-name" title={r.name}>
                    <span className="branch-name">{r.name}</span>
                    {r.current && <span className="branch-flag current">current</span>}
                    {isBase(r) && <span className="branch-flag">base</span>}
                    {r.pinned && <Pin size={11} className="muted" />}
                    {r.worktree && (
                      <span title={`Checked out in ${r.worktree}`}>
                        <FolderGit2 size={11} className="muted" />
                      </span>
                    )}
                    {r.parent && (
                      <span className="branch-parent muted" title={`Stacked on ${r.parent}`}>
                        <Layers size={11} /> {r.parent}
                      </span>
                    )}
                    {r.merged && !isBase(r) && <span className="branch-flag merged">merged</span>}
                  </span>
                  <span className="bcol-diverge" title={`${r.behind} behind, ${r.ahead} ahead of ${baseName}`}>
                    <span className="diverge-side behind">
                      <span className="diverge-count">{r.behind || ''}</span>
                      <span className="diverge-bar" style={{ width: `${(r.behind / maxDiverge) * 100}%` }} />
                    </span>
                    <span className="diverge-side ahead">
                      <span className="diverge-bar" style={{ width: `${(r.ahead / maxDiverge) * 100}%` }} />
                      <span className="diverge-count">{r.ahead || ''}</span>
                    </span>
                  </span>
                  <span className={`bcol-date ${isStale(r) ? 'stale' : ''}`} title={`${fullDate(r.date)} · ${r.subject}`}>
                    {relativeTime(r.date)} <span className="muted">· {r.author}</span>
                  </span>
                  <span className="bcol-upstream" title={r.upstream}>
                    {r.gone ? <span className="gone-badge">gone</span> : r.upstream ?? <span className="muted">—</span>}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const FILTER_LABEL: Record<Filter, string> = { all: 'All', merged: 'Merged', stale: 'Stale', ahead: 'Ahead', gone: 'Gone' };
const FILTER_HINT: Record<Filter, (days: number, base: string) => string> = {
  all: () => 'Every branch',
  merged: (_d, base) => `All commits are in ${base}`,
  stale: (days) => `No commits for ${days} days (change in Settings)`,
  ahead: (_d, base) => `Has commits ${base} doesn't have`,
  gone: () => 'Its upstream branch was deleted on the remote',
};

function WHY_NOT(r: BranchReviewRow, base: boolean): string {
  if (r.type === 'remote') return 'Remote branches are deleted one by one from their menu';
  if (r.current) return 'Checked out';
  if (r.worktree) return `Checked out in ${r.worktree}`;
  if (r.pinned) return 'Pinned';
  if (base) return 'The base branch';
  return '';
}
