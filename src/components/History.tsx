import { GitBranch, Search, X } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Commit } from '../../shared/types';
import { api, type SearchMode } from '../lib/api';
import { copyText, relativeTime, shortHash } from '../lib/format';
import { LANE_COLORS, layoutGraph, type GraphRow } from '../lib/graph';
import { useActions } from '../repo/actions';
import { useRepo } from '../repo/RepoContext';
import { useUI, type MenuItem } from '../ui/UIProvider';
import { CommitDetails } from './CommitDetails';
import { RefBadges, refsByHash, type BadgeRef } from './RefBadges';
import { Splitter, usePersistentSize } from './Splitter';

const ROW_H = 28;
const LANE_W = 14;
const PAGE = 500;

export function History({ refName, label }: { refName?: string; label?: string }) {
  const { repo, refs, status, setView } = useRepo();
  const ui = useUI();
  const actions = useActions();
  const [detailsWidth, setDetailsWidth] = usePersistentSize('history.details', 560);
  const [all, setAll] = useState(() => localStorage.getItem('gitcolumn.historyAll') === '1');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState<SearchMode>('message');
  const [commits, setCommits] = useState<Commit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const loadingMore = useRef(false);
  const requestId = useRef(0);

  const showAll = all && !refName;

  // Reload when refs move (commit, fetch, checkout...), not on every working copy change.
  const refsKey = useMemo(() => JSON.stringify([status?.head, refs.map((r) => r.ref + r.hash)]), [status?.head, refs]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    api
      .log(repo.path, { ref: refName, all: showAll, limit: PAGE, search: search || undefined, searchMode })
      .then((list) => {
        if (id !== requestId.current) return;
        setCommits(list);
        setHasMore(list.length === PAGE);
        setError(null);
        setSelected((sel) => (sel && list.some((c) => c.hash === sel) ? sel : list[0]?.hash ?? null));
      })
      .catch((e) => id === requestId.current && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => id === requestId.current && setLoading(false));
  }, [repo.path, refName, showAll, search, searchMode, refsKey]);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore.current) return;
    loadingMore.current = true;
    const id = requestId.current;
    api
      .log(repo.path, { ref: refName, all: showAll, limit: PAGE, skip: commits.length, search: search || undefined, searchMode })
      .then((list) => {
        if (id !== requestId.current) return;
        setCommits((prev) => [...prev, ...list]);
        setHasMore(list.length === PAGE);
      })
      .finally(() => (loadingMore.current = false));
  }, [repo.path, refName, showAll, search, searchMode, commits.length, hasMore]);

  const graph = useMemo(() => layoutGraph(commits), [commits]);
  const badges = useMemo(() => refsByHash(refs, status?.head ?? null, !status?.branch && !!status?.head), [refs, status?.head, status?.branch]);
  const index = useMemo(() => new Map(commits.map((c, i) => [c.hash, i])), [commits]);
  const selectedCommit = selected ? commits[index.get(selected) ?? -1] : undefined;

  const commitMenu = (e: React.MouseEvent, c: Commit) => {
    setSelected(c.hash);
    const isHead = c.hash === status?.head;
    const branch = status?.branch;
    const items: MenuItem[] = [
      { label: `Check Out ${shortHash(c.hash)}…`, onClick: () => actions.checkoutDetached(c.hash, `commit ${shortHash(c.hash)}`) },
      { label: 'Create Branch Here…', onClick: () => actions.createBranch(c.hash, shortHash(c.hash)) },
      { label: 'Create Tag Here…', onClick: () => actions.createTag(c.hash, shortHash(c.hash)) },
      'separator',
      { label: `Cherry-Pick onto ${branch ?? 'HEAD'}`, disabled: isHead, onClick: () => actions.cherryPick(c) },
      { label: 'Revert Commit…', onClick: () => actions.revert(c) },
      { label: `Reset ${branch ?? 'HEAD'} to Here…`, disabled: isHead, danger: true, onClick: () => actions.reset(c) },
    ];
    if (isHead && branch) items.push({ label: 'Undo Last Commit…', onClick: () => actions.undoLastCommit(c) });
    items.push('separator', { label: 'Copy SHA', onClick: () => copyText(c.hash) }, { label: 'Copy Subject', onClick: () => copyText(c.subject) });
    ui.menu(e, items);
  };

  const badgeMenu = (e: React.MouseEvent, b: BadgeRef) => {
    e.stopPropagation();
    if (!b.ref) return;
    const r = b.ref;
    const items: MenuItem[] = [];
    if (r.type !== 'tag' && !r.current) items.push({ label: `Check Out "${r.name}"`, onClick: () => actions.checkout(r) });
    if (status?.branch && !r.current) {
      items.push({ label: `Merge "${r.name}" into "${status.branch}"…`, onClick: () => actions.merge(r.name) });
      items.push({ label: `Rebase "${status.branch}" onto "${r.name}"…`, onClick: () => actions.rebase(r.name) });
    }
    items.push('separator', { label: 'Copy Name', onClick: () => copyText(r.name) });
    ui.menu(e, items);
  };

  const scopeLabel = refName ? label ?? refName : showAll ? 'All Branches' : status?.branch ?? 'HEAD';

  return (
    <div className="history">
      <div className="history-list-pane">
        <div className="pane-header history-header">
          <GitBranch size={14} className="muted" />
          <span className="pane-title">{scopeLabel}</span>
          {refName ? (
            <button className="icon-button" title="Back to current branch" onClick={() => setView({ kind: 'history' })}>
              <X size={14} />
            </button>
          ) : (
            <label className="toggle">
              <input
                type="checkbox"
                checked={all}
                onChange={(e) => {
                  setAll(e.target.checked);
                  localStorage.setItem('gitcolumn.historyAll', e.target.checked ? '1' : '0');
                }}
              />
              All branches
            </label>
          )}
          <span className="spacer" />
          <div className="search-box">
            <Search size={13} />
            <input
              placeholder={searchMode === 'author' ? 'Search authors' : searchMode === 'content' ? 'Search code changes' : 'Search messages'}
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setSearchInput('')}
              spellCheck={false}
            />
            <select value={searchMode} onChange={(e) => setSearchMode(e.target.value as SearchMode)} title="Search in">
              <option value="message">Message</option>
              <option value="author">Author</option>
              <option value="content">Content</option>
            </select>
          </div>
        </div>
        {error ? (
          <div className="empty-state">
            <div className="error-text">{error}</div>
          </div>
        ) : !loading && !commits.length ? (
          <div className="empty-state">
            <div className="empty-title">{search ? 'No matching commits' : 'No commits yet'}</div>
            {!search && <div className="muted">Make your first commit from the Working Copy.</div>}
          </div>
        ) : (
          <CommitList
            commits={commits}
            graph={graph.rows}
            maxLanes={graph.maxWidth}
            badges={badges}
            head={status?.head ?? null}
            selected={selected}
            onSelect={setSelected}
            onContextMenu={commitMenu}
            onBadgeMenu={badgeMenu}
            onEndReached={loadMore}
          />
        )}
      </div>
      <Splitter value={detailsWidth} onChange={setDetailsWidth} min={360} max={1200} invert />
      <div className="history-details-pane" style={{ width: detailsWidth }}>
        {selectedCommit ? (
          <CommitDetails
            key={selectedCommit.hash}
            hash={selectedCommit.hash}
            badges={badges.get(selectedCommit.hash)}
            onNavigate={(h) => index.has(h) && setSelected(h)}
          />
        ) : (
          <div className="empty-state muted">{loading ? 'Loading…' : 'Select a commit'}</div>
        )}
      </div>
    </div>
  );
}

interface CommitListProps {
  commits: Commit[];
  graph: GraphRow[];
  maxLanes: number;
  badges: Map<string, BadgeRef[]>;
  head: string | null;
  selected: string | null;
  onSelect: (hash: string) => void;
  onContextMenu: (e: React.MouseEvent, c: Commit) => void;
  onBadgeMenu: (e: React.MouseEvent, b: BadgeRef) => void;
  onEndReached: () => void;
}

function CommitList({ commits, graph, maxLanes, badges, head, selected, onSelect, onContextMenu, onBadgeMenu, onEndReached }: CommitListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const graphWidth = Math.min(maxLanes, 16) * LANE_W + 10;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const end = Math.min(commits.length, Math.ceil((scrollTop + height) / ROW_H) + 8);

  useEffect(() => {
    if (end >= commits.length - 50) onEndReached();
  }, [end, commits.length, onEndReached]);

  const selIndex = commits.findIndex((c) => c.hash === selected);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = Math.max(0, Math.min(commits.length - 1, selIndex + (e.key === 'ArrowDown' ? 1 : -1)));
    onSelect(commits[next].hash);
    const el = scrollRef.current;
    if (el) {
      const top = next * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    }
  };

  const rows = [];
  for (let i = start; i < end; i++) {
    const c = commits[i];
    rows.push(
      <CommitRow
        key={c.hash}
        commit={c}
        top={i * ROW_H}
        row={graph[i]}
        graphWidth={graphWidth}
        badges={badges.get(c.hash)}
        isHead={c.hash === head}
        selected={c.hash === selected}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
        onBadgeMenu={onBadgeMenu}
      />,
    );
  }

  return (
    <div className="commit-list">
      <div className="commit-list-head">
        <span className="col-subject" style={{ paddingLeft: graphWidth }}>
          Subject
        </span>
        <span className="col-author">Author</span>
        <span className="col-date">Date</span>
        <span className="col-sha">SHA</span>
      </div>
      <div className="commit-scroll" ref={scrollRef} tabIndex={0} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} onKeyDown={onKeyDown}>
        <div style={{ height: commits.length * ROW_H, position: 'relative' }}>{rows}</div>
      </div>
    </div>
  );
}

const CommitRow = memo(function CommitRow({
  commit: c,
  top,
  row,
  graphWidth,
  badges,
  isHead,
  selected,
  onSelect,
  onContextMenu,
  onBadgeMenu,
}: {
  commit: Commit;
  top: number;
  row: GraphRow;
  graphWidth: number;
  badges?: BadgeRef[];
  isHead: boolean;
  selected: boolean;
  onSelect: (hash: string) => void;
  onContextMenu: (e: React.MouseEvent, c: Commit) => void;
  onBadgeMenu: (e: React.MouseEvent, b: BadgeRef) => void;
}) {
  return (
    <div
      className={`commit-row ${selected ? 'selected' : ''} ${isHead ? 'is-head' : ''}`}
      style={{ top, height: ROW_H }}
      onMouseDown={(e) => e.button === 0 && onSelect(c.hash)}
      onContextMenu={(e) => onContextMenu(e, c)}
    >
      <span className="col-subject">
        <GraphCell row={row} width={graphWidth} isHead={isHead} />
        <RefBadges badges={badges} onContextMenu={onBadgeMenu} />
        <span className={`commit-subject ${row?.isMerge ? 'merge' : ''}`}>{c.subject}</span>
      </span>
      <span className="col-author" title={c.email}>
        {c.author}
      </span>
      <span className="col-date" title={new Date(c.date * 1000).toLocaleString()}>
        {relativeTime(c.date)}
      </span>
      <span className="col-sha mono">{shortHash(c.hash)}</span>
    </div>
  );
});

function GraphCell({ row, width, isHead }: { row?: GraphRow; width: number; isHead: boolean }) {
  if (!row) return <span style={{ width, flex: 'none' }} />;
  const x = (lane: number) => 8 + lane * LANE_W;
  const y = (v: number) => v * ROW_H;
  const cx = x(row.col);
  const cy = ROW_H / 2;
  return (
    <svg className="graph" width={width} height={ROW_H} viewBox={`0 0 ${width} ${ROW_H}`}>
      {row.segments.map((s, i) => {
        const cls = `lane lane-${s.color % LANE_COLORS}`;
        if (s.x1 === s.x2) return <line key={i} className={cls} x1={x(s.x1)} y1={y(s.y1)} x2={x(s.x2)} y2={y(s.y2)} />;
        const x1 = x(s.x1);
        const y1 = y(s.y1);
        const x2 = x(s.x2);
        const y2 = y(s.y2);
        const my = (y1 + y2) / 2;
        return <path key={i} className={cls} d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} />;
      })}
      {isHead && <circle className={`node-ring lane-${row.color % LANE_COLORS}`} cx={cx} cy={cy} r={6.5} />}
      <circle className={`node lane-${row.color % LANE_COLORS} ${row.isMerge ? 'node-merge' : ''}`} cx={cx} cy={cy} r={row.isMerge ? 3.5 : 4} />
    </svg>
  );
}
