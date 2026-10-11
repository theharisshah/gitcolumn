import { ArrowLeftRight, GitCompare, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ChangedFile, Commit, FileDiff } from '../../shared/types';
import { api } from '../lib/api';
import { plural, relativeTime, shortHash } from '../lib/format';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';
import { Avatar } from './Avatar';
import { ChangesetView } from './ChangesetView';
import { CommitDetails } from './CommitDetails';
import { refsByHash } from './RefBadges';
import { Splitter, usePersistentSize } from './Splitter';

type Tab = 'commits' | 'files';

/**
 * Two revisions side by side: the commits one has that the other doesn't, and the file changes —
 * either since the point where they diverged (three-dot, what a pull request shows) or directly
 * between the two (two-dot).
 */
export function CompareView({ base, head, baseLabel, headLabel }: { base: string; head: string; baseLabel?: string; headLabel?: string }) {
  const { repo, refs, status, version, setView, closeView } = useRepo();
  const ui = useUI();
  const [tab, setTab] = useState<Tab>('commits');
  const [threeDot, setThreeDot] = useState(true);
  const [ahead, setAhead] = useState<Commit[] | null>(null);
  const [behind, setBehind] = useState<Commit[] | null>(null);
  const [mergeBase, setMergeBase] = useState<string | null | undefined>(undefined);
  const [files, setFiles] = useState<ChangedFile[] | null>(null);
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = usePersistentSize('compare.list', 420);

  useEffect(() => {
    let cancelled = false;
    setAhead(null);
    setBehind(null);
    setError(null);
    Promise.all([api.logRange(repo.path, base, head), api.logRange(repo.path, head, base), api.mergeBase(repo.path, base, head)]).then(
      ([a, b, mb]) => {
        if (cancelled) return;
        setAhead(a);
        setBehind(b);
        setMergeBase(mb);
        setSelected((s) => (s && a.some((c) => c.hash === s) ? s : a[0]?.hash ?? null));
      },
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [repo.path, base, head, version]);

  const from = threeDot ? mergeBase : base;
  useEffect(() => {
    if (tab !== 'files' || from === undefined) return;
    if (from === null) {
      setFiles([]);
      setDiffs([]);
      return;
    }
    let cancelled = false;
    setFiles(null);
    setDiffs(null);
    Promise.all([api.diffFiles(repo.path, from, head), api.diffRange(repo.path, from, head)]).then(
      ([f, d]) => {
        if (cancelled) return;
        setFiles(f);
        setDiffs(d);
      },
      (e) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [repo.path, from, head, tab, version]);

  const badges = useMemo(() => refsByHash(refs, status?.head ?? null, !status?.branch && !!status?.head), [refs, status?.head, status?.branch]);
  const swap = () => setView({ kind: 'compare', base: head, head: base, baseLabel: headLabel, headLabel: baseLabel }, { replace: true });
  const b = baseLabel ?? base;
  const h = headLabel ?? head;

  return (
    <div className="compare-view">
      <div className="pane-header compare-header">
        <GitCompare size={14} className="muted" />
        <span className="compare-rev mono" title={base}>
          {b}
        </span>
        <button className="icon-button" onClick={swap} title="Swap">
          <ArrowLeftRight size={13} />
        </button>
        <span className="compare-rev mono" title={head}>
          {h}
        </span>
        <span className="muted small">
          {ahead && behind ? `${plural(ahead.length, 'commit')} ahead, ${behind.length} behind` : ''}
        </span>
        <span className="spacer" />
        <div className="segmented">
          <button className={tab === 'commits' ? 'active' : ''} onClick={() => setTab('commits')}>
            Commits
          </button>
          <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
            Files
          </button>
        </div>
        {tab === 'files' && (
          <div className="segmented" title="Three dots: changes on the right since the two diverged (like a pull request). Two dots: every difference between them.">
            <button className={threeDot ? 'active' : ''} onClick={() => setThreeDot(true)}>
              {b}...{h}
            </button>
            <button className={!threeDot ? 'active' : ''} onClick={() => setThreeDot(false)}>
              {b}..{h}
            </button>
          </div>
        )}
        <button className="icon-button" onClick={closeView} title="Close">
          <X size={14} />
        </button>
      </div>
      {error ? (
        <div className="empty-state error-text">{error}</div>
      ) : tab === 'commits' ? (
        <div className="compare-body">
          <div className="compare-list" style={{ width }}>
            <CommitGroup title={`Only in ${h}`} commits={ahead} selected={selected} onSelect={setSelected} />
            <CommitGroup title={`Only in ${b}`} commits={behind} selected={selected} onSelect={setSelected} muted />
          </div>
          <Splitter value={width} onChange={setWidth} min={280} max={800} />
          <div className="compare-details">
            {selected ? (
              <CommitDetails key={selected} hash={selected} badges={badges.get(selected)} onNavigate={(hash) => setView({ kind: 'history', ref: hash, label: shortHash(hash), select: hash })} />
            ) : (
              <div className="empty-state muted">{ahead && !ahead.length && behind && !behind.length ? 'The two are the same.' : 'Select a commit'}</div>
            )}
          </div>
        </div>
      ) : (
        <div className="compare-files">
          {from === null ? (
            <div className="empty-state muted">These revisions have no common history; use two dots.</div>
          ) : (
            <ChangesetView
              files={files ?? []}
              diffs={diffs}
              idPrefix={`compare-${base}-${head}`}
              imagesFor={(d) => ({ before: from ? { revs: [from], path: d.oldPath } : undefined, after: { revs: [head], path: d.newPath } })}
              fileMenu={(e, p) =>
                ui.menu(e, [
                  { label: 'Show File History', onClick: () => setView({ kind: 'file', path: p, mode: 'history', rev: head }) },
                  { label: `Show in Files at ${h}`, onClick: () => setView({ kind: 'files', rev: head, label: h, path: p }) },
                ])
              }
            />
          )}
        </div>
      )}
    </div>
  );
}

function CommitGroup({ title, commits, selected, onSelect, muted }: { title: string; commits: Commit[] | null; selected: string | null; onSelect: (h: string) => void; muted?: boolean }) {
  return (
    <div className={`compare-group ${muted ? 'muted-group' : ''}`}>
      <div className="compare-group-title">
        {title} <span className="muted">{commits ? commits.length : '…'}</span>
      </div>
      {commits?.map((c) => (
        <div key={c.hash} className={`compare-commit ${selected === c.hash ? 'selected' : ''}`} onMouseDown={() => onSelect(c.hash)}>
          <Avatar name={c.author} email={c.email} size={18} />
          <span className="compare-subject">{c.subject}</span>
          <span className="muted small">{relativeTime(c.date)}</span>
          <span className="muted small mono">{shortHash(c.hash)}</span>
        </div>
      ))}
      {commits && !commits.length && <div className="compare-none muted small">None</div>}
    </div>
  );
}
