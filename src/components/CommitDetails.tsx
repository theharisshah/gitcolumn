import { Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CommitDetail, FileDiff } from '../../shared/types';
import { api } from '../lib/api';
import { basename, copyText, dirname, fullDate, hashColor, initials, plural, shortHash } from '../lib/format';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';
import { DiffStat, FileDiffSection } from './DiffView';
import { RefBadges, type BadgeRef } from './RefBadges';
import { StatusBadge } from './StatusBadge';

const AUTO_EXPAND_LINES = 4000;

export function CommitDetails({ hash, badges, onNavigate }: { hash: string; badges?: BadgeRef[]; onNavigate: (hash: string) => void }) {
  const { repo } = useRepo();
  const ui = useUI();
  const [detail, setDetail] = useState<CommitDetail | null>(null);
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
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

  let budget = AUTO_EXPAND_LINES;
  const differentCommitter = detail.committer !== detail.author || detail.committerEmail !== detail.email;

  return (
    <div className="commit-details">
      <div className="commit-meta">
        <h2 className="commit-title">{detail.subject}</h2>
        {badges && (
          <div className="commit-refs">
            <RefBadges badges={badges} />
          </div>
        )}
        {detail.body && <pre className="commit-body">{detail.body}</pre>}
        <div className="commit-people">
          <Person name={detail.author} email={detail.email} date={detail.date} role="Author" />
          {differentCommitter && <Person name={detail.committer} email={detail.committerEmail} date={detail.committerDate} role="Committer" />}
        </div>
        <dl className="commit-facts">
          <dt>SHA</dt>
          <dd>
            <span className="mono">{detail.hash}</span>
            <button
              className="icon-button"
              title="Copy SHA"
              onClick={() => copyText(detail.hash).then(() => ui.toast('info', 'Copied SHA'))}
            >
              <Copy size={12} />
            </button>
          </dd>
          {detail.parents.length > 0 && (
            <>
              <dt>{detail.parents.length > 1 ? 'Parents' : 'Parent'}</dt>
              <dd>
                {detail.parents.map((p) => (
                  <button key={p} className="link-button mono" onClick={() => onNavigate(p)}>
                    {shortHash(p)}
                  </button>
                ))}
                {detail.parents.length > 1 && <span className="muted"> · changes shown against first parent</span>}
              </dd>
            </>
          )}
        </dl>
      </div>
      <div className="commit-files">
        <div className="commit-files-title">
          {plural(detail.files.length, 'changed file')}
          <DiffStat
            additions={detail.files.reduce((n, f) => n + (f.additions ?? 0), 0)}
            deletions={detail.files.reduce((n, f) => n + (f.deletions ?? 0), 0)}
          />
        </div>
        {detail.files.map((f) => (
          <button
            key={f.path}
            className="commit-file-row"
            onClick={() => document.getElementById(`diff-${hash}-${f.path}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            onContextMenu={(e) =>
              ui.menu(e, [
                { label: 'Copy Path', onClick: () => copyText(f.path) },
                { label: 'Reveal in Finder', onClick: () => api.reveal(repo.path, f.path).catch((err) => ui.toast('error', 'Could not reveal file', String(err))) },
              ])
            }
          >
            <StatusBadge status={f.status} />
            <span className="file-name" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
              {basename(f.path)}
              <span className="file-dir">{dirname(f.path)}</span>
            </span>
            {f.binary ? <span className="muted small">binary</span> : <DiffStat additions={f.additions} deletions={f.deletions} />}
          </button>
        ))}
      </div>
      <div className="commit-diffs">
        {!diffs && <div className="diff-note muted">Loading changes…</div>}
        {diffs?.map((d) => {
          const lines = d.additions + d.deletions;
          const open = lines <= budget;
          budget -= lines;
          const p = d.newPath || d.oldPath;
          return <FileDiffSection key={p} id={`diff-${hash}-${p}`} diff={d} defaultOpen={open} />;
        })}
      </div>
    </div>
  );
}

function Person({ name, email, date, role }: { name: string; email: string; date: number; role: string }) {
  return (
    <div className="person">
      <span className="avatar" style={{ background: hashColor(email || name) }}>
        {initials(name)}
      </span>
      <div>
        <div>
          <b>{name}</b> <span className="muted">&lt;{email}&gt;</span>
        </div>
        <div className="muted small">
          {role} · {fullDate(date)}
        </div>
      </div>
    </div>
  );
}
