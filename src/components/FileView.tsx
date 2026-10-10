import { FileText, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Blame, BlameCommit, FileCommit, FileDiff } from '../../shared/types';
import { api } from '../lib/api';
import { copyText, fullDate, hashColor, relativeTime, shortHash } from '../lib/format';
import { highlightLines, languageFor } from '../lib/highlight';
import { getSetting } from '../lib/settings';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';
import { CodeText, DiffView } from './DiffView';
import { Splitter, usePersistentSize } from './Splitter';
import { StatusBadge } from './StatusBadge';

export function FileView({ path, mode, rev, select }: { path: string; mode: 'history' | 'blame'; rev?: string | null; select?: string }) {
  const { setView, closeView } = useRepo();
  return (
    <div className="file-view">
      <div className="pane-header">
        <FileText size={14} className="muted" />
        <span className="pane-title file-view-path" title={path}>
          {path}
        </span>
        <div className="segmented">
          <button className={mode === 'history' ? 'active' : ''} onClick={() => setView({ kind: 'file', path, mode: 'history' })}>
            History
          </button>
          <button className={mode === 'blame' ? 'active' : ''} onClick={() => setView({ kind: 'file', path, mode: 'blame', rev })}>
            Blame
          </button>
        </div>
        <span className="spacer" />
        <button className="icon-button" title="Close" onClick={closeView}>
          <X size={14} />
        </button>
      </div>
      {mode === 'history' ? <FileHistory key={path} path={path} select={select} /> : <BlameView key={`${path}@${rev ?? ''}`} path={path} rev={rev ?? null} />}
    </div>
  );
}

// ------------------------------------------------------------------ history

function FileHistory({ path, select }: { path: string; select?: string }) {
  const { repo, version, setView } = useRepo();
  const [listWidth, setListWidth] = usePersistentSize('file.history', 380);
  const [commits, setCommits] = useState<FileCommit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(select ?? null);
  const [diff, setDiff] = useState<FileDiff | null | undefined>(undefined);

  useEffect(() => {
    api
      .fileHistory(repo.path, path)
      .then((list) => {
        setCommits(list);
        setSelected((s) => (s && list.some((c) => c.hash === s) ? s : list[0]?.hash ?? null));
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [repo.path, path, version]);

  const current = commits?.find((c) => c.hash === selected);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    setDiff(undefined);
    const paths = current.oldPath ? [current.oldPath, current.path] : [current.path];
    api
      .commitDiff(repo.path, current.hash, current.parents[0], paths)
      .then((d) => !cancelled && setDiff(d.find((x) => x.newPath === current.path) ?? d[0] ?? null))
      .catch(() => !cancelled && setDiff(null));
    return () => {
      cancelled = true;
    };
  }, [repo.path, current]);

  if (error) return <div className="empty-state error-text">{error}</div>;
  if (!commits) return <div className="empty-state muted">Loading history…</div>;
  if (!commits.length) return <div className="empty-state muted">This file has no committed history yet.</div>;

  return (
    <div className="file-history">
      <div className="file-history-list" style={{ width: listWidth }}>
        {commits.map((c) => (
          <div key={c.hash} className={`file-commit-row ${c.hash === selected ? 'selected' : ''}`} onMouseDown={() => setSelected(c.hash)}>
            <StatusBadge status={c.status} />
            <div className="file-commit-text">
              <div className="file-commit-subject">{c.subject}</div>
              <div className="muted small">
                {c.author} · {relativeTime(c.date)} · <span className="mono">{shortHash(c.hash)}</span>
                {c.oldPath && <> · renamed from {c.oldPath}</>}
              </div>
            </div>
          </div>
        ))}
      </div>
      <Splitter value={listWidth} onChange={setListWidth} min={260} max={700} />
      <div className="file-history-diff">
        {current && (
          <div className="file-history-head">
            <div className="file-history-title">{current.subject}</div>
            <div className="muted small">
              {current.author} · {fullDate(current.date)} · <span className="mono">{shortHash(current.hash)}</span>
            </div>
            <div className="file-history-actions">
              <button className="button button-small" onClick={() => setView({ kind: 'history', select: current.hash })}>
                Show Commit
              </button>
              <button className="button button-small" onClick={() => setView({ kind: 'file', path: current.path, mode: 'blame', rev: current.hash })}>
                Blame at This Commit
              </button>
            </div>
          </div>
        )}
        <div className="diff-scroll">
          {diff === undefined ? (
            <div className="diff-note muted">Loading…</div>
          ) : diff ? (
            <DiffView
              diff={diff}
              images={{
                before: current?.parents[0] ? { revs: [current.parents[0]], path: diff.oldPath } : undefined,
                after: current ? { revs: [current.hash], path: diff.newPath } : undefined,
              }}
            />
          ) : (
            <div className="diff-note muted">No changes to this file in this commit (it may be a merge).</div>
          )}
        </div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- blame

const MAX_BLAME_LINES = 20000;

function BlameView({ path, rev }: { path: string; rev: string | null }) {
  const { repo, version, setView } = useRepo();
  const ui = useUI();
  const [blame, setBlame] = useState<Blame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBlame(null);
    api
      .blame(repo.path, path, rev)
      .then((b) => {
        if (cancelled) return;
        setBlame(b);
        setError(null);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [repo.path, path, rev, rev ? 0 : version]);

  const lines = useMemo(() => blame?.lines.slice(0, MAX_BLAME_LINES) ?? [], [blame]);
  const syntax = useMemo(() => {
    const lang = getSetting('syntaxHighlighting') ? languageFor(path) : null;
    return lang && lines.length ? highlightLines(lines.map((l) => l.content), lang) : null;
  }, [lines, path]);
  const [minTime, maxTime] = useMemo(() => {
    const times = Object.values(blame?.commits ?? {})
      .filter((c) => !c.uncommitted)
      .map((c) => c.time);
    return times.length ? [Math.min(...times), Math.max(...times)] : [0, 0];
  }, [blame]);

  if (error) return <div className="empty-state error-text">{error}</div>;
  if (!blame) return <div className="empty-state muted">Running blame…</div>;

  const age = (c: BlameCommit) => (c.uncommitted || maxTime === minTime ? 1 : (c.time - minTime) / (maxTime - minTime));

  const menu = (e: React.MouseEvent, c: BlameCommit) => {
    setActive(c.hash);
    if (c.uncommitted) return;
    ui.menu(e, [
      { label: 'Show Commit in History', onClick: () => setView({ kind: 'history', select: c.hash }) },
      { label: 'Show File History', onClick: () => setView({ kind: 'file', path, mode: 'history', select: c.hash }) },
      {
        label: 'Blame Previous Revision',
        disabled: !c.previous,
        onClick: () => c.previous && setView({ kind: 'file', path: c.previous.path, mode: 'blame', rev: c.previous.hash }),
      },
      'separator',
      { label: 'Copy SHA', onClick: () => copyText(c.hash) },
    ]);
  };

  return (
    <div className="blame">
      <div className="blame-bar muted small">
        {rev ? (
          <>
            Blame at <span className="mono">{shortHash(rev)}</span> ·{' '}
            <button className="link-button" onClick={() => setView({ kind: 'file', path, mode: 'blame' })}>
              Back to working copy
            </button>
          </>
        ) : (
          'Blame of the working copy — right-click a line for more'
        )}
        <span className="spacer" />
        {Object.keys(blame.commits).length} commits · {blame.lines.length.toLocaleString()} lines
      </div>
      <div className="diff-scroll">
        <div className="diff blame-lines">
          {lines.map((line, i) => {
            const c = blame.commits[line.hash];
            const first = i === 0 || lines[i - 1].hash !== line.hash;
            return (
              <div
                key={i}
                className={`blame-line ${first ? 'blame-first' : ''} ${active === line.hash ? 'active' : ''}`}
                onClick={() => setActive(line.hash === active ? null : line.hash)}
                onContextMenu={(e) => menu(e, c)}
              >
                <span className="blame-info" style={{ '--age': age(c) } as React.CSSProperties} title={c.uncommitted ? 'Not committed yet' : `${c.summary}\n${c.author} · ${fullDate(c.time)}\n${c.hash}`}>
                  {first &&
                    (c.uncommitted ? (
                      <span className="blame-uncommitted">Not committed yet</span>
                    ) : (
                      <>
                        <span className="blame-avatar" style={{ background: hashColor(c.email || c.author) }} />
                        <span className="blame-summary">{c.summary}</span>
                        <span className="blame-meta">
                          {c.author.split(' ')[0]} · {relativeTime(c.time)}
                        </span>
                      </>
                    ))}
                </span>
                <span className="ln">{line.line}</span>
                <span className="diff-content">
                  <CodeText text={line.content} segments={syntax?.[i]} />
                </span>
              </div>
            );
          })}
        </div>
        {blame.lines.length > MAX_BLAME_LINES && <div className="diff-note">Showing the first {MAX_BLAME_LINES.toLocaleString()} lines.</div>}
      </div>
    </div>
  );
}
