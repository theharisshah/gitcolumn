import { GitBranch, Search, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Commit } from '../../shared/types';
import { api, type SearchMode } from '../lib/api';
import { copyText, shortHash } from '../lib/format';
import { GRAPH_LAYOUT_LANES, GraphLayout, type GraphRow } from '../lib/graph';
import { useActions } from '../repo/actions';
import { useRepo } from '../repo/RepoContext';
import { useUI, type MenuItem } from '../ui/UIProvider';
import { CommitDetails } from './CommitDetails';
import { CommitList } from './CommitList';
import { refsByHash, type BadgeRef } from './RefBadges';
import { Splitter, usePersistentSize } from './Splitter';

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
          const layout = new GraphLayout({ maxLanes: GRAPH_LAYOUT_LANES });
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
