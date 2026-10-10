import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReflogEntry } from '../../shared/types';
import { api } from '../lib/api';
import { copyText, fullDate, relativeTime, shortHash } from '../lib/format';
import { useVirtualList } from '../lib/useVirtualList';
import { useActions } from '../repo/actions';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';
import { CommitDetails } from './CommitDetails';
import { refsByHash } from './RefBadges';
import { Splitter, usePersistentSize } from './Splitter';

const ROW_H = 44;
const PAGE = 200;

function actionKind(action: string): string {
  const a = action.toLowerCase();
  if (a.startsWith('commit (amend)')) return 'amend';
  if (a.startsWith('commit (merge)') || a.startsWith('merge')) return 'merge';
  if (a.startsWith('commit')) return 'commit';
  if (a.startsWith('checkout')) return 'checkout';
  if (a.startsWith('reset')) return 'reset';
  if (a.startsWith('rebase') || a.startsWith('pull --rebase')) return 'rebase';
  if (a.startsWith('pull')) return 'pull';
  if (a.startsWith('cherry-pick') || a.startsWith('revert')) return 'pick';
  return 'other';
}

/** Where HEAD (or a branch) has pointed over time, with ways to get back to any of those states. */
export function ReflogView({ refName = 'HEAD', select }: { refName?: string; select?: string }) {
  const { repo, refs, status, version, setView } = useRepo();
  const ui = useUI();
  const actions = useActions();
  const [width, setWidth] = usePersistentSize('reflog.list', 460);
  const [entries, setEntries] = useState<ReflogEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(select ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadingMore = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .reflog(repo.path, refName, 0, PAGE)
      .then((r) => {
        if (cancelled) return;
        setEntries(r.entries);
        setHasMore(r.hasMore);
        setError(null);
        setSelected((s) => (s && r.entries.some((e) => e.selector === s) ? s : r.entries[0]?.selector ?? null));
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [repo.path, refName, version]);

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore.current) return;
    loadingMore.current = true;
    api
      .reflog(repo.path, refName, entries.length, PAGE)
      .then((r) => {
        setEntries((prev) => [...prev, ...r.entries]);
        setHasMore(r.hasMore);
      })
      .finally(() => (loadingMore.current = false));
  }, [repo.path, refName, entries.length, hasMore]);

  const { start, end, totalHeight, scrollToIndex } = useVirtualList(scrollRef, entries.length, ROW_H);
  useEffect(() => {
    if (end >= entries.length - 20) loadMore();
  }, [end, entries.length, loadMore]);

  const selIndex = entries.findIndex((e) => e.selector === selected);
  const current = entries[selIndex];
  const badges = refsByHash(refs, status?.head ?? null, !status?.branch && !!status?.head);

  const menu = (e: React.MouseEvent, entry: ReflogEntry) => {
    setSelected(entry.selector);
    ui.menu(e, [
      { label: `Check Out ${entry.selector}…`, onClick: () => actions.checkoutDetached(entry.hash, entry.selector) },
      { label: 'Create Branch Here…', onClick: () => actions.createBranch(entry.hash, entry.selector) },
      {
        label: `Reset ${status?.branch ?? 'HEAD'} to Here…`,
        danger: true,
        disabled: entry.hash === status?.head,
        onClick: () => actions.reset({ hash: entry.hash, subject: entry.subject }),
      },
      'separator',
      { label: 'Show in History', onClick: () => setView({ kind: 'history', ref: entry.hash, label: entry.selector, select: entry.hash }) },
      { label: 'Copy SHA', onClick: () => copyText(entry.hash) },
    ]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = Math.max(0, Math.min(entries.length - 1, selIndex + (e.key === 'ArrowDown' ? 1 : -1)));
    if (entries[next]) {
      setSelected(entries[next].selector);
      scrollToIndex(next);
    }
  };

  const heads = refs.filter((r) => r.type === 'head');
  const rows = [];
  for (let i = start; i < end; i++) {
    const entry = entries[i];
    const kind = actionKind(entry.action);
    rows.push(
      <div
        key={entry.selector}
        className={`reflog-row ${entry.selector === selected ? 'selected' : ''}`}
        style={{ top: i * ROW_H, height: ROW_H }}
        onMouseDown={(e) => e.button === 0 && setSelected(entry.selector)}
        onContextMenu={(e) => menu(e, entry)}
        title={`${entry.selector} · ${fullDate(entry.time)}`}
      >
        <div className="reflog-line">
          <span className={`reflog-action action-${kind}`}>{entry.action}</span>
          <span className="reflog-detail">{entry.detail}</span>
        </div>
        <div className="reflog-line muted small">
          <span className="mono">{entry.selector}</span>
          <span className="mono">{shortHash(entry.hash)}</span>
          <span className="reflog-subject">{entry.subject}</span>
          <span className="reflog-time">{relativeTime(entry.time)}</span>
        </div>
      </div>,
    );
  }

  return (
    <div className="reflog-view">
      <div className="reflog-list-pane" style={{ width }}>
        <div className="pane-header">
          <RotateCcw size={14} className="muted" />
          <span className="pane-title">Reflog</span>
          <select className="input reflog-ref" value={refName} onChange={(e) => setView({ kind: 'reflog', ref: e.target.value === 'HEAD' ? undefined : e.target.value }, { replace: true })}>
            <option value="HEAD">HEAD</option>
            {heads.map((h) => (
              <option key={h.ref} value={h.name}>
                {h.name}
              </option>
            ))}
          </select>
          <span className="spacer" />
          <span className="muted small">{entries.length ? `${entries.length}${hasMore ? '+' : ''} entries` : ''}</span>
        </div>
        <div className="reflog-hint muted small">Every position HEAD has been at. Right-click an entry to check it out, branch from it, or reset to it.</div>
        <div className="reflog-scroll" ref={scrollRef} tabIndex={0} onKeyDown={onKeyDown}>
          {error ? (
            <div className="tree-note error-text">{error}</div>
          ) : loading && !entries.length ? (
            <div className="tree-note muted">Loading…</div>
          ) : !entries.length ? (
            <div className="tree-note muted">No reflog entries.</div>
          ) : (
            <div style={{ height: totalHeight, position: 'relative' }}>{rows}</div>
          )}
        </div>
      </div>
      <Splitter value={width} onChange={setWidth} min={320} max={800} />
      <div className="reflog-detail-pane">
        {current ? (
          <>
            <div className="reflog-banner">
              <span className={`reflog-action action-${actionKind(current.action)}`}>{current.action}</span>
              <span>{current.detail}</span>
              <span className="spacer" />
              <span className="muted small">
                {current.selector} · {fullDate(current.time)}
              </span>
            </div>
            <CommitDetails key={current.hash} hash={current.hash} badges={badges.get(current.hash)} onNavigate={(h) => setView({ kind: 'history', ref: h, label: shortHash(h), select: h })} />
          </>
        ) : (
          <div className="empty-state muted">Select an entry</div>
        )}
      </div>
    </div>
  );
}
