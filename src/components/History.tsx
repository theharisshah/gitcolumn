import { GitBranch, Search, X } from 'lucide-react';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Commit } from '../../shared/types';
import { api, type SearchMode } from '../lib/api';
import { copyText, relativeTime, shortHash } from '../lib/format';
import { GraphLayout, LANE_COLORS, type GraphRow } from '../lib/graph';
import { useActions } from '../repo/actions';
import { useRepo } from '../repo/RepoContext';
import { useUI, type MenuItem } from '../ui/UIProvider';
import { CommitDetails } from './CommitDetails';
import { RefBadges, refsByHash, type BadgeRef } from './RefBadges';
import { Splitter, usePersistentSize } from './Splitter';

const ROW_H = 28;
/** Lanes beyond this are clipped; a commit whose lane is further right is pinned to the edge. */
const MAX_VISIBLE_LANES = 16;

interface GraphGeometry {
  laneW: number;
  /** x of lane 0 */
  x0: number;
  visible: number;
  width: number;
}

function graphGeometry(maxLanes: number, listWidth: number): GraphGeometry {
  // Roomy lanes for simple histories, tighter ones once there are many parallel lines.
  const laneW = maxLanes <= 6 ? 14 : 11;
  const x0 = laneW / 2 + 2;
  // The graph may use up to about a quarter of the list so the subject always has room.
  const fit = Math.max(4, Math.floor((listWidth * 0.25 - 12) / laneW));
  const visible = Math.max(1, Math.min(maxLanes, MAX_VISIBLE_LANES, fit));
  // When lanes are hidden, leave room after the last one for the pinned node and its HEAD ring.
  const tail = maxLanes > visible ? 10 : 2;
  return { laneW, x0, visible, width: Math.ceil(x0 + (visible - 1) * laneW + laneW / 2 + tail) };
}
const PAGE = 500;
const NO_GRAPH = { rows: [] as GraphRow[], maxWidth: 0 };

export function History({
  refName,
  label,
  select,
  search: searchProp,
  scope,
}: {
  refName?: string;
  label?: string;
  select?: string;
  search?: string;
  scope?: 'all';
}) {
  const { repo, refs, status, setView } = useRepo();
  const ui = useUI();
  const actions = useActions();
  const [detailsWidth, setDetailsWidth] = usePersistentSize('history.details', 560);
  const [all, setAll] = useState(() => localStorage.getItem('gitcolumn.historyAll') === '1');
  const [searchInput, setSearchInput] = useState(searchProp ?? '');
  const [search, setSearch] = useState(searchProp?.trim() ?? '');
  const [searchMode, setSearchMode] = useState<SearchMode>('message');
  const [commits, setCommits] = useState<Commit[]>([]);
  // Laid out when each page arrives, so the graph always matches the commits it was built from.
  const [graph, setGraph] = useState(NO_GRAPH);
  const layoutRef = useRef<GraphLayout | null>(null);
  const reloading = useRef(false);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(select ?? null);
  const loadingMore = useRef(false);
  const requestId = useRef(0);

  const showAll = (all || scope === 'all') && !refName;

  // Searches started elsewhere (toolbar search field, Quick Actions) arrive as a prop.
  useEffect(() => {
    if (searchProp !== undefined) setSearchInput(searchProp);
  }, [searchProp]);

  // Reload when refs move (commit, fetch, checkout...), not on every working copy change.
  const refsKey = useMemo(() => JSON.stringify([status?.head, refs.map((r) => r.ref + r.hash)]), [status?.head, refs]);

  useEffect(() => {
    if (select) setSelected(select);
  }, [select]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const id = ++requestId.current;
    reloading.current = true;
    setLoading(true);
    api
      .log(repo.path, { ref: refName, all: showAll, limit: PAGE, search: search || undefined, searchMode })
      .then((list) => {
        if (id !== requestId.current) return;
        if (search) {
          // Search results are a filtered subset whose parents are mostly missing: no graph.
          layoutRef.current = null;
          setGraph(NO_GRAPH);
        } else {
          const layout = new GraphLayout({ maxLanes: MAX_VISIBLE_LANES });
          layoutRef.current = layout;
          setGraph({ rows: layout.append(list), maxWidth: layout.maxWidth });
        }
        setCommits(list);
        setHasMore(list.length === PAGE);
        setError(null);
        setSelected((sel) => (sel && list.some((c) => c.hash === sel) ? sel : list[0]?.hash ?? null));
      })
      .catch((e) => id === requestId.current && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        if (id !== requestId.current) return;
        reloading.current = false;
        setLoading(false);
      });
  }, [repo.path, refName, showAll, search, searchMode, refsKey]);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore.current || reloading.current) return;
    loadingMore.current = true;
    const id = requestId.current;
    api
      .log(repo.path, { ref: refName, all: showAll, limit: PAGE, skip: commits.length, search: search || undefined, searchMode })
      .then((list) => {
        if (id !== requestId.current) return;
        const layout = layoutRef.current;
        if (layout) {
          const rows = layout.append(list);
          setGraph((g) => ({ rows: g.rows.concat(rows), maxWidth: layout.maxWidth }));
        }
        setCommits((prev) => [...prev, ...list]);
        setHasMore(list.length === PAGE);
      })
      .finally(() => (loadingMore.current = false));
  }, [repo.path, refName, showAll, search, searchMode, commits.length, hasMore]);

  const badges = useMemo(() => refsByHash(refs, status?.head ?? null, !status?.branch && !!status?.head), [refs, status?.head, status?.branch]);

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
    if (branch && !refName) {
      const isMerge = c.parents.length > 1;
      items.push(
        'separator',
        { header: 'Rewrite History' },
        { label: 'Edit Commit Message…', disabled: isMerge, onClick: () => actions.rewordCommit(c) },
        { label: 'Squash into Parent…', disabled: isMerge || !c.parents.length, onClick: () => actions.squashIntoParent(c, 'squash') },
        { label: 'Fixup into Parent…', disabled: isMerge || !c.parents.length, onClick: () => actions.squashIntoParent(c, 'fixup') },
        { label: 'Drop Commit…', disabled: isMerge, danger: true, onClick: () => actions.dropCommit(c) },
        { label: 'Interactive Rebase After This Commit…', disabled: isHead, onClick: () => actions.interactiveRebase(c.hash) },
      );
    }
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

  // Stable handlers so memoized rows don't re-render on every keystroke or status poll.
  const menus = useRef({ commitMenu, badgeMenu });
  menus.current = { commitMenu, badgeMenu };
  const onCommitMenu = useCallback((e: React.MouseEvent, c: Commit) => menus.current.commitMenu(e, c), []);
  const onBadgeMenu = useCallback((e: React.MouseEvent, b: BadgeRef) => menus.current.badgeMenu(e, b), []);

  // The commit list keeps at least half the width (and its 300px minimum); the splitter works on
  // the width actually shown, so there's no dead zone after a window gets narrower.
  const historyRef = useRef<HTMLDivElement>(null);
  const [historyWidth, setHistoryWidth] = useState(0);
  useLayoutEffect(() => {
    const el = historyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHistoryWidth(el.clientWidth));
    ro.observe(el);
    setHistoryWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const maxDetails = historyWidth ? Math.max(200, Math.min(historyWidth * 0.5, historyWidth - 301)) : 1200;
  const shownDetails = Math.min(detailsWidth, maxDetails);

  const scopeLabel = refName ? label ?? refName : showAll ? 'All Branches' : status?.branch ?? 'HEAD';

  return (
    <div className="history" ref={historyRef}>
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
            onContextMenu={onCommitMenu}
            onBadgeMenu={onBadgeMenu}
            onEndReached={loadMore}
          />
        )}
      </div>
      <Splitter value={shownDetails} onChange={setDetailsWidth} min={Math.min(360, maxDetails)} max={maxDetails} invert />
      <div className="history-details-pane" style={{ width: shownDetails }}>
        {selected && (commits.length || !loading) ? (
          <CommitDetails key={selected} hash={selected} badges={badges.get(selected)} onNavigate={(h) => setSelected(h)} />
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
  const [listWidth, setListWidth] = useState(800);
  // Round so the geometry (and the memoized rows) only change when a lane's worth of space does.
  const roundedWidth = Math.round(listWidth / 40) * 40;
  const geometry = useMemo(() => (maxLanes ? graphGeometry(maxLanes, roundedWidth) : null), [maxLanes, roundedWidth]);
  const graphWidth = geometry?.width ?? 10;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setHeight(el.clientHeight);
      setListWidth(el.clientWidth);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 8);
  const end = Math.min(commits.length, Math.ceil((scrollTop + height) / ROW_H) + 8);

  useEffect(() => {
    if (end >= commits.length - 50) onEndReached();
  }, [end, commits.length, onEndReached]);

  const selIndex = commits.findIndex((c) => c.hash === selected);

  // Keep the selected commit visible when it is chosen from elsewhere (blame, parent links…).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || selIndex < 0) return;
    const top = selIndex * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    // Also re-run once the selected commit's row is known (after loading) or moves (after a reload).
  }, [selected, selIndex]);

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
        geometry={geometry}
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
  geometry,
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
  geometry: GraphGeometry | null;
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
        {geometry ? <GraphCell row={row} geometry={geometry} isHead={isHead} /> : <span className="graph-none" />}
        <RefBadges badges={badges} onContextMenu={onBadgeMenu} />
        <span className={`commit-subject ${c.parents.length > 1 ? 'merge' : ''}`}>{c.subject}</span>
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

function GraphCell({ row, geometry, isHead }: { row?: GraphRow; geometry: GraphGeometry; isHead: boolean }) {
  const { laneW, x0, visible, width } = geometry;
  if (!row) return <span style={{ width, flex: 'none' }} />;
  const x = (lane: number) => x0 + lane * laneW;
  const y = (v: number) => v * ROW_H;
  // Lanes past the visible area aren't drawn; a commit on one is pinned to the edge, hollow.
  const overflow = row.col >= visible;
  const cx = overflow ? width - 7.5 : x(row.col);
  const cy = ROW_H / 2;
  const laneCls = `lane-${row.color % LANE_COLORS}`;
  return (
    <svg className="graph" width={width} height={ROW_H} viewBox={`0 0 ${width} ${ROW_H}`}>
      {row.segments.map((s, i) => {
        if (Math.min(s.x1, s.x2) >= visible) return null;
        const cls = `lane lane-${s.color % LANE_COLORS}`;
        if (s.x1 === s.x2) return <line key={i} className={cls} x1={x(s.x1)} y1={y(s.y1)} x2={x(s.x2)} y2={y(s.y2)} />;
        const x1 = x(s.x1);
        const y1 = y(s.y1);
        const x2 = x(s.x2);
        const y2 = y(s.y2);
        const my = (y1 + y2) / 2;
        return <path key={i} className={cls} d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} />;
      })}
      {isHead && <circle className={`node-ring ${laneCls}`} cx={cx} cy={cy} r={6.5} />}
      {overflow ? (
        <circle className={`node-ring node-overflow ${laneCls}`} cx={cx} cy={cy} r={3.5}>
          <title>On lane {row.col + 1} — too many parallel lines to show</title>
        </circle>
      ) : (
        <circle className={`node ${laneCls} ${row.isMerge ? 'node-merge' : ''}`} cx={cx} cy={cy} r={row.isMerge ? 3.5 : 4} />
      )}
    </svg>
  );
}
