import { Copy } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { CommitDetail, FileDiff } from '../../shared/types';
import { api } from '../lib/api';
import { copyText, fullDate, shortHash } from '../lib/format';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';
import { Avatar } from './Avatar';
import { ChangesetView } from './ChangesetView';
import { FilesBrowser } from './FilesView';
import { RefBadges, type BadgeRef } from './RefBadges';

type Mode = 'changeset' | 'tree';
const MODE_KEY = 'gitcolumn.commitDetailsMode';

function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'tree' ? 'tree' : 'changeset';
  } catch {
    return 'changeset';
  }
}

export function CommitDetails({ hash, badges, onNavigate }: { hash: string; badges?: BadgeRef[]; onNavigate: (hash: string) => void }) {
  const { repo, setView } = useRepo();
  const ui = useUI();
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode>(loadMode);

  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    let cancelled = false;
    setDiffs(null);
    api
      .commitDetail(repo.path, hash)
      .then(async (d) => {
        if (cancelled) return;
        setDetail(d);
        const fd = await api.commitDiff(repo.path, hash, d.parents[0]);
        if (!cancelled) setDiffs(fd);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [repo.path, hash]);

  if (error) return <div className="empty-state error-text">{error}</div>;
  if (!detail) return <div className="empty-state muted">Loading…</div>;

  const copy = (text: string, what: string) => copyText(text).then(() => ui.toast('info', `Copied ${what}`));
  const hashRow = (label: string, value: ReactNode, raw?: string) => (
    <>
      <dt>{label}</dt>
      <dd>
        {value}
        {raw && (
          <button className="icon-button" title={`Copy ${label.toLowerCase()}`} onClick={() => copy(raw, label.toLowerCase())}>
            <Copy size={11} />
          </button>
        )}
      </dd>
    </>
  );
  const parent = detail.parents[0];

  return (
    <div className={`commit-details ${mode === 'tree' ? 'tree-mode' : ''}`}>
      <div className="commit-details-bar">
        <span className="mono">{shortHash(detail.hash)}</span>
        <span className="spacer" />
        <div className="segmented">
          <button className={mode === 'changeset' ? 'active' : ''} onClick={() => setMode('changeset')}>
            Changeset
          </button>
          <button className={mode === 'tree' ? 'active' : ''} onClick={() => setMode('tree')}>
            Tree
          </button>
        </div>
      </div>
      <div className="commit-meta">
        <div className="commit-meta-top">
          <dl className="commit-meta-table">
            <dt>Author</dt>
            <dd>
              {detail.author} <span className="muted">&lt;{detail.email}&gt;</span>
            </dd>
            <dt>Author Date</dt>
            <dd>{fullDate(detail.date)}</dd>
            <dt>Committer</dt>
            <dd>
              {detail.committer} <span className="muted">&lt;{detail.committerEmail}&gt;</span>
            </dd>
            <dt>Committer Date</dt>
            <dd>{fullDate(detail.committerDate)}</dd>
            {badges?.length ? (
              <>
                <dt>Refs</dt>
                <dd>
                  <RefBadges badges={badges} />
                </dd>
              </>
            ) : null}
            {hashRow('Commit Hash', <span className="mono">{detail.hash}</span>, detail.hash)}
            {detail.parents.length > 0 &&
              hashRow(
                detail.parents.length > 1 ? 'Parent Hashes' : 'Parent Hash',
                <span className="commit-parents">
                  {detail.parents.map((p) => (
                    <button key={p} className="link-button mono" onClick={() => onNavigate(p)} title="Show this commit">
                      {detail.parents.length > 1 ? shortHash(p) : p}
                    </button>
                  ))}
                  {detail.parents.length > 1 && <span className="muted small">changes shown against the first parent</span>}
                </span>,
              )}
            {hashRow(
              'Tree Hash',
              <button className="link-button mono" onClick={() => setMode('tree')} title="Browse the files of this commit">
                {detail.tree}
              </button>,
              detail.tree,
            )}
          </dl>
          <Avatar name={detail.author} email={detail.email} size={56} className="commit-avatar" />
        </div>
        <h2 className="commit-title">{detail.subject}</h2>
        {detail.body && <pre className="commit-body">{detail.body}</pre>}
      </div>
      {mode === 'changeset' ? (
        <ChangesetView
          files={detail.files}
          diffs={diffs}
          idPrefix={`diff-${hash}`}
          imagesFor={(d) => ({ before: parent ? { revs: [parent], path: d.oldPath } : undefined, after: { revs: [hash], path: d.newPath } })}
          fileMenu={(e, p) =>
            ui.menu(e, [
              { label: 'Show File History', onClick: () => setView({ kind: 'file', path: p, mode: 'history', select: hash }) },
              { label: 'Blame at This Commit', onClick: () => setView({ kind: 'file', path: p, mode: 'blame', rev: hash }) },
              { label: 'Show in Files', onClick: () => setView({ kind: 'files', rev: hash, label: shortHash(hash), path: p }) },
              'separator',
              { label: 'Copy Path', onClick: () => copyText(p) },
            ])
          }
        />
      ) : (
        <div className="commit-tree">
          <FilesBrowser rev={hash} compact />
        </div>
      )}
    </div>
  );
}
