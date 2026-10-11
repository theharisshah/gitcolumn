import { ChevronLeft, ChevronRight } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Commit } from '../../shared/types';
import { relativeTime, shortHash } from '../lib/format';
import { GRAPH_LAYOUT_LANES, LANE_COLORS, type GraphRow } from '../lib/graph';
import { historyItems, itemAt, itemOffsets, type HistoryItem } from '../lib/historyItems';
import { useSetting } from '../lib/settings';
import { Avatar } from './Avatar';
import { RefBadges, type BadgeRef } from './RefBadges';

const ROW_H = 28;
const COMPACT_ROW_H = 44;
const HEADER_H = 26;
/** Without a width chosen by the user, at most this many lanes are shown. */
const AUTO_VISIBLE_LANES = 16;
/** Below this list width, "auto" row style switches to two-line rows. */
const COMPACT_BELOW = 640;
const GRAPH_WIDTH_KEY = 'gitcolumn.history.graphWidth';

export interface GraphGeometry {
  laneW: number;
  /** x of the first visible lane */
  x0: number;
  /** Number of lanes shown */
  visible: number;
  /** First lane shown (lanes scroll sideways when there are more than fit) */
  offset: number;
  width: number;
  rowH: number;
}

function graphGeometry(maxLanes: number, listWidth: number, preferred: number | null, offset: number, rowH: number): GraphGeometry {
  // Roomy lanes for simple histories, tighter ones once there are many parallel lines.
  const laneW = maxLanes <= 6 ? 14 : 11;
  const x0 = laneW / 2 + 2;
  const lanes = Math.min(maxLanes, GRAPH_LAYOUT_LANES);
  let visible: number;
  if (preferred) {
    // A width saved in a wider window never takes more than 60% of the list.
    visible = Math.floor((Math.min(preferred, Math.max(60, listWidth * 0.6)) - x0 - 2) / laneW) + 1;
  } else {
    // The graph may use up to about a quarter of the list so the subject always has room.
    visible = Math.min(AUTO_VISIBLE_LANES, Math.max(4, Math.floor((listWidth * 0.25 - 12) / laneW)));
  }
  visible = Math.max(1, Math.min(lanes, visible));
  // Room after the last lane for a node pinned at the edge (and its HEAD ring) when lanes are hidden.
  const tail = maxLanes > visible ? 10 : 2;
  const clamped = Math.max(0, Math.min(offset, lanes - visible));
  return { laneW, x0, visible, offset: clamped, width: Math.ceil(x0 + (visible - 1) * laneW + laneW / 2 + tail), rowH };
}

function loadGraphWidth(): number | null {
  try {
    const n = Number(localStorage.getItem(GRAPH_WIDTH_KEY));
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}

export interface CommitListProps {
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

/** Virtualized commit list with the graph, month sections and either column or compact two-line rows. */
export function CommitList({ commits, graph, maxLanes, badges, head, selected, onSelect, onContextMenu, onBadgeMenu, onEndReached }: CommitListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);
  const [listWidth, setListWidth] = useState(800);
  const [rowStyle] = useSetting('historyRowStyle');
  const [monthHeaders] = useSetting('historyMonthHeaders');
  const [preferredWidth, setPreferredWidth] = useState<number | null>(loadGraphWidth);
  const [laneOffset, setLaneOffset] = useState(0);
  const wheel = useRef(0);

  const compact = rowStyle === 'compact' || (rowStyle === 'auto' && listWidth < COMPACT_BELOW);
  const rowH = compact ? COMPACT_ROW_H : ROW_H;
  // Round so the geometry (and the memoized rows) only change when a lane's worth of space does.
  const roundedWidth = Math.round(listWidth / 40) * 40;
  const geometry = useMemo(
    () => (maxLanes ? graphGeometry(maxLanes, roundedWidth, preferredWidth, laneOffset, rowH) : null),
    [maxLanes, roundedWidth, preferredWidth, laneOffset, rowH],
  );
  const graphWidth = geometry?.width ?? 10;
  // Keep the stored offset within range (the geometry clamps it), so ← and ◀ respond right away.
  useEffect(() => {
    if (geometry && geometry.offset !== laneOffset) setLaneOffset(geometry.offset);
  }, [geometry, laneOffset]);
  const lanesHidden = !!geometry && maxLanes > geometry.visible;

  const items = useMemo(() => historyItems(commits, { headers: monthHeaders }), [commits, monthHeaders]);
  const offsets = useMemo(() => itemOffsets(items, rowH, HEADER_H), [items, rowH]);
  const itemOfCommit = useMemo(() => {
    const out = new Int32Array(commits.length);
    items.forEach((it, i) => it.kind === 'commit' && (out[it.index] = i));
    return out;
  }, [items, commits.length]);

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

  // When row heights change (compact <-> columns, month headers on/off), keep the same commit at the top.
  const topCommit = useRef(0);
  const lastLayout = useRef({ rowH, headers: monthHeaders });
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const changed = lastLayout.current.rowH !== rowH || lastLayout.current.headers !== monthHeaders;
    lastLayout.current = { rowH, headers: monthHeaders };
    if (!el || !changed || topCommit.current >= commits.length) return;
    el.scrollTop = offsets[itemOfCommit[topCommit.current]];
    setScrollTop(el.scrollTop);
  }, [rowH, monthHeaders, offsets, itemOfCommit, commits.length]);
  // Remember the top commit only while the layout is the one it was measured in.
  if (lastLayout.current.rowH === rowH && lastLayout.current.headers === monthHeaders) {
    const first = items[itemAt(offsets, scrollTop)];
    if (first?.kind === 'commit') topCommit.current = first.index;
  }

  const start = Math.max(0, itemAt(offsets, scrollTop) - 8);
  const end = Math.min(items.length, itemAt(offsets, scrollTop + height) + 9);

  const lastCommit = useMemo(() => {
    for (let i = end - 1; i >= 0; i--) if (items[i]?.kind === 'commit') return (items[i] as { index: number }).index;
    return 0;
  }, [items, end]);
  useEffect(() => {
    if (lastCommit >= commits.length - 50) onEndReached();
  }, [lastCommit, commits.length, onEndReached]);

  const selIndex = commits.findIndex((c) => c.hash === selected);

  const scrollToCommit = (index: number, align: 'nearest' | 'third') => {
    const el = scrollRef.current;
    if (!el || index < 0) return;
    const top = offsets[itemOfCommit[index]];
    if (align === 'third') {
      if (top < el.scrollTop || top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
    } else if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
  };

  // Keep the selected commit visible when it is chosen from elsewhere (blame, parent links…), and
  // scroll the lanes sideways so its node is shown.
  useEffect(() => {
    scrollToCommit(selIndex, 'third');
    const row = graph[selIndex];
    if (row && geometry) {
      if (row.col < geometry.offset) setLaneOffset(row.col);
      else if (row.col >= geometry.offset + geometry.visible) setLaneOffset(row.col - geometry.visible + 1);
    }
    // Only when the selection (or its position) changes, not on every scroll.
  }, [selected, selIndex]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (!lanesHidden) return;
      e.preventDefault();
      setLaneOffset((o) => Math.max(0, o + (e.key === 'ArrowRight' ? 1 : -1)));
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = Math.max(0, Math.min(commits.length - 1, selIndex + (e.key === 'ArrowDown' ? 1 : -1)));
    onSelect(commits[next].hash);
    scrollToCommit(next, 'nearest');
  };

  // Shift+wheel (or a sideways trackpad swipe) scrolls the lanes.
  const onWheel = (e: React.WheelEvent) => {
    if (!lanesHidden || !geometry) return;
    const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
    if (!dx || (!e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY))) return;
    wheel.current += dx;
    const steps = Math.trunc(wheel.current / geometry.laneW);
    if (!steps) return;
    wheel.current -= steps * geometry.laneW;
    setLaneOffset((o) => Math.max(0, Math.min(o + steps, Math.min(maxLanes, GRAPH_LAYOUT_LANES) - geometry.visible)));
  };

  // Drag the edge of the graph column in the header to give the graph more or less room.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = graphWidth;
    const max = Math.max(60, listWidth * 0.6);
    let moved = false;
    const move = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - x0) < 3 && !moved) return;
      moved = true;
      setPreferredWidth(Math.round(Math.max(24, Math.min(max, w0 + ev.clientX - x0))));
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (!moved) return; // a click (or the first click of a double-click) doesn't fix the width
      const w = Math.round(Math.max(24, Math.min(max, w0 + ev.clientX - x0)));
      try {
        localStorage.setItem(GRAPH_WIDTH_KEY, String(w));
      } catch {
        /* storage unavailable */
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const resetWidth = () => {
    setPreferredWidth(null);
    try {
      localStorage.removeItem(GRAPH_WIDTH_KEY);
    } catch {
      /* storage unavailable */
    }
  };

  const rows = [];
  for (let i = start; i < end; i++) {
    const item = items[i];
    if (item.kind === 'header') {
      // Lanes leaving the previous commit pass straight through the section header.
      const prev = items[i - 1];
      const above = prev?.kind === 'commit' ? graph[prev.index] : undefined;
      rows.push(<MonthHeader key={item.key} item={item} top={offsets[i]} above={above} geometry={geometry} />);
      continue;
    }
    const c = commits[item.index];
    rows.push(
      <CommitRow
        key={c.hash}
        commit={c}
        top={offsets[i]}
        row={graph[item.index]}
        geometry={geometry}
        compact={compact}
        badges={badges.get(c.hash)}
        isHead={c.hash === head}
        selected={c.hash === selected}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
        onBadgeMenu={onBadgeMenu}
      />,
    );
  }

  const lanes = Math.min(maxLanes, GRAPH_LAYOUT_LANES);
  return (
    <div className={`commit-list ${compact ? 'compact' : ''}`}>
      <div className="commit-list-head">
        {geometry && (
          <div className="graph-head" style={{ width: graphWidth }}>
            {lanesHidden && (
              <span className="lane-scroll" title="Shift+scroll or ←/→ to see other lanes">
                <button className="icon-button" disabled={geometry.offset === 0} onClick={() => setLaneOffset((o) => Math.max(0, o - geometry.visible))}>
                  <ChevronLeft size={11} />
                </button>
                {graphWidth >= 84 && (
                  <span>
                    {geometry.offset + 1}–{geometry.offset + geometry.visible}
                    <span className="muted">/{maxLanes > GRAPH_LAYOUT_LANES ? `${lanes}+` : lanes}</span>
                  </span>
                )}
                <button
                  className="icon-button"
                  disabled={geometry.offset + geometry.visible >= lanes}
                  onClick={() => setLaneOffset((o) => Math.min(lanes - geometry.visible, o + geometry.visible))}
                >
                  <ChevronRight size={11} />
                </button>
              </span>
            )}
            <span className="graph-resize" onMouseDown={startResize} onDoubleClick={resetWidth} title="Drag to resize the graph; double-click for automatic width" />
          </div>
        )}
        <span className="col-subject" style={geometry ? undefined : { paddingLeft: graphWidth }}>
          {compact ? 'Commits' : 'Subject'}
        </span>
        {!compact && (
          <>
            <span className="col-author">Author</span>
            <span className="col-date">Date</span>
            <span className="col-sha">SHA</span>
          </>
        )}
      </div>
      <div
        className="commit-scroll"
        ref={scrollRef}
        tabIndex={0}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        onWheel={onWheel}
      >
        <div style={{ height: offsets[items.length], position: 'relative' }}>{rows}</div>
      </div>
    </div>
  );
}

const MonthHeader = memo(function MonthHeader({
  item,
  top,
  above,
  geometry,
}: {
  item: Extract<HistoryItem, { kind: 'header' }>;
  top: number;
  above?: GraphRow;
  geometry: GraphGeometry | null;
}) {
  let lanes: React.ReactNode = null;
  if (geometry) {
    const { laneW, x0, visible, offset, width } = geometry;
    const through = (above?.segments ?? []).filter((s) => s.y2 === 1 && s.x2 >= offset && s.x2 < offset + visible);
    lanes = (
      <svg className="graph" width={width} height={HEADER_H} viewBox={`0 0 ${width} ${HEADER_H}`}>
        {through.map((s, i) => {
          const x = x0 + (s.x2 - offset) * laneW;
          return <line key={i} className={`lane lane-${s.color % LANE_COLORS}`} x1={x} y1={0} x2={x} y2={HEADER_H} />;
        })}
      </svg>
    );
  }
  return (
    <div className="history-month" style={{ top, height: HEADER_H }}>
      {lanes}
      <span className="history-month-label">{item.label}</span>
    </div>
  );
});

const CommitRow = memo(function CommitRow({
  commit: c,
  top,
  row,
  geometry,
  compact,
  badges,
  isHead,
  selected,
  onSelect,
  onContextMenu,
  onBadgeMenu,
}: {
  commit: Commit;
  top: number;
  row?: GraphRow;
  geometry: GraphGeometry | null;
  compact: boolean;
  badges?: BadgeRef[];
  isHead: boolean;
  selected: boolean;
  onSelect: (hash: string) => void;
  onContextMenu: (e: React.MouseEvent, c: Commit) => void;
  onBadgeMenu: (e: React.MouseEvent, b: BadgeRef) => void;
}) {
  const graphCell = geometry ? <GraphCell row={row} geometry={geometry} isHead={isHead} /> : <span className="graph-none" />;
  const subject = <span className={`commit-subject ${c.parents.length > 1 ? 'merge' : ''}`}>{c.subject}</span>;
  return (
    <div
      className={`commit-row ${selected ? 'selected' : ''} ${isHead ? 'is-head' : ''}`}
      style={{ top, height: geometry?.rowH ?? (compact ? COMPACT_ROW_H : ROW_H) }}
      onMouseDown={(e) => e.button === 0 && onSelect(c.hash)}
      onContextMenu={(e) => onContextMenu(e, c)}
    >
      {compact ? (
        <span className="col-subject">
          {graphCell}
          <span className="commit-lines">
            <span className="commit-line">
              <RefBadges badges={badges} onContextMenu={onBadgeMenu} fit={geometry?.width ?? 0} />
              {subject}
            </span>
            <span className="commit-line commit-meta-line" title={`${c.email} · ${new Date(c.date * 1000).toLocaleString()}`}>
              <Avatar name={c.author} email={c.email} size={14} />
              <span className="commit-meta-author">{c.author}</span>
              <span>· {relativeTime(c.date)}</span>
              <span className="mono">· {shortHash(c.hash)}</span>
            </span>
          </span>
        </span>
      ) : (
        <>
          <span className="col-subject">
            {graphCell}
            <RefBadges badges={badges} onContextMenu={onBadgeMenu} fit={geometry?.width ?? 0} />
            {subject}
          </span>
          <span className="col-author" title={c.email}>
            <Avatar name={c.author} email={c.email} size={16} />
            <span className="col-author-name">{c.author}</span>
          </span>
          <span className="col-date" title={new Date(c.date * 1000).toLocaleString()}>
            {relativeTime(c.date)}
          </span>
          <span className="col-sha mono">{shortHash(c.hash)}</span>
        </>
      )}
    </div>
  );
});

function GraphCell({ row, geometry, isHead }: { row?: GraphRow; geometry: GraphGeometry; isHead: boolean }) {
  const { laneW, x0, visible, offset, width, rowH } = geometry;
  if (!row) return <span style={{ width, flex: 'none' }} />;
  const x = (lane: number) => x0 + (lane - offset) * laneW;
  const y = (v: number) => v * rowH;
  // A commit on a lane outside the visible window is pinned to that edge, drawn hollow.
  const left = row.col < offset;
  const right = row.col >= offset + visible;
  const cx = left ? 3.5 : right ? width - 7.5 : x(row.col);
  const cy = rowH / 2;
  const laneCls = `lane-${row.color % LANE_COLORS}`;
  return (
    <svg className="graph" width={width} height={rowH} viewBox={`0 0 ${width} ${rowH}`}>
      {row.segments.map((s, i) => {
        // Skip segments entirely outside the window; partly visible ones are clipped by the SVG.
        if (Math.max(s.x1, s.x2) < offset || Math.min(s.x1, s.x2) >= offset + visible) return null;
        const cls = `lane lane-${s.color % LANE_COLORS}`;
        const x1 = x(s.x1);
        const y1 = y(s.y1);
        const x2 = x(s.x2);
        const y2 = y(s.y2);
        if (s.x1 === s.x2) return <line key={i} className={cls} x1={x1} y1={y1} x2={x2} y2={y2} />;
        const my = (y1 + y2) / 2;
        return <path key={i} className={cls} d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} />;
      })}
      {isHead && <circle className={`node-ring ${laneCls}`} cx={cx} cy={cy} r={6.5} />}
      {left || right ? (
        <circle className={`node-ring node-overflow ${laneCls}`} cx={cx} cy={cy} r={3.5}>
          <title>
            {row.col >= GRAPH_LAYOUT_LANES
              ? `On lane ${row.col + 1}, beyond the ${GRAPH_LAYOUT_LANES} lanes the graph shows`
              : `On lane ${row.col + 1} — scroll the graph sideways to see it`}
          </title>
        </circle>
      ) : (
        <circle className={`node ${laneCls} ${row.isMerge ? 'node-merge' : ''}`} cx={cx} cy={cy} r={row.isMerge ? 3.5 : 4} />
      )}
    </svg>
  );
}
