import { Check, CircleDot, Copy, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Plus, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChangedFile, FileDiff, GhCheck, GhChecks, GhMergeMethod, GhPullDetail, GhPullSummary, GhStatus } from '../../shared/types';
import { api } from '../lib/api';
import { copyText, plural, relativeTime, shortHash } from '../lib/format';
import { useActions } from '../repo/actions';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';
import { Avatar } from './Avatar';
import { ChangesetView } from './ChangesetView';
import { GhGate } from './GhGate';
import { Splitter, usePersistentSize } from './Splitter';

type PrState = 'open' | 'closed' | 'merged';
type Tab = 'conversation' | 'checks' | 'files' | 'commits';

/**
 * github.com avatars by login (an app such as "app/dependabot" is the "dependabot[bot]" account).
 * Enterprise logins are other accounts, so they get initials.
 */
const avatarFor = (login: string, host: string | undefined) => {
  if (host !== 'github.com') return undefined;
  const app = /^app\/([\w-]+)$/.exec(login);
  if (app) return `https://avatars.githubusercontent.com/${app[1]}%5Bbot%5D?s=64`;
  return /^[\w-]+(\[bot\])?$/.test(login) ? `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=64` : undefined;
};
/** gh's list sizes: the first page, then "Show more" up to the most gh pr list allows. */
const LIMITS = [50, 100, 200];

/** GitHub pull requests for this repository, through the user's gh login. */
export function PullRequests({ state = 'open', number }: { state?: PrState; number?: number }) {
  const { repo, setView } = useRepo();
  const actions = useActions();
  const [status, setStatus] = useState<GhStatus | null>(null);
  const [list, setList] = useState<GhPullSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [width, setWidth] = usePersistentSize('pulls.list', 420);
  const [reload, setReload] = useState(0);
  const [limit, setLimit] = useState(LIMITS[0]);
  /** The limit the list on screen was loaded with */
  const [loaded, setLoaded] = useState(LIMITS[0]);
  const ui = useUI();
  // A pull request created elsewhere in the app (Create Pull Request…) shows up in the list.
  useEffect(() => {
    const onChanged = (e: Event) => (e as CustomEvent<{ repo: string }>).detail?.repo === repo.path && setReload((n) => n + 1);
    window.addEventListener('gitcolumn:pulls-changed', onChanged);
    return () => window.removeEventListener('gitcolumn:pulls-changed', onChanged);
  }, [repo.path]);
  useEffect(() => setLimit(LIMITS[0]), [state, query]);
  // A new filter starts from an empty list; a reload keeps the current one on screen meanwhile.
  useEffect(() => {
    setList(null);
    setError(null);
  }, [state, query]);

  const loadStatus = useCallback(
    (refresh = false) => {
      setStatus(null);
      api.ghStatus(repo.path, refresh).then(setStatus, (e) => setStatus({ state: 'error', message: e instanceof Error ? e.message : String(e) }));
    },
    [repo.path],
  );
  useEffect(() => loadStatus(), [loadStatus]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  // Pull requests are GitHub's data: re-listed on filter changes, Reload and pull request
  // operations, not on every local change.
  useEffect(() => {
    if (status?.state !== 'ready') return;
    let cancelled = false;
    api.prList(repo.path, state, query || undefined, limit).then(
      (l) => {
        if (cancelled) return;
        setList(l);
        setLoaded(limit);
        setError(null);
      },
      (e) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        // A failed reload keeps the list that's already there.
        setList((prev) => {
          if (!prev) setError(message);
          else ui.toast('error', 'Couldn’t load pull requests', message);
          return prev;
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [status, repo.path, state, query, limit, reload]);
  // With nothing selected (opening the view, switching filters), select the first one. This reads
  // the current selection, so it never overrides one made meanwhile (say, by going Back).
  useEffect(() => {
    if (number === undefined && list?.[0]) setView({ kind: 'pulls', state, number: list[0].number }, { replace: true });
  }, [list, number, state, setView]);

  const select = (n: number) => setView({ kind: 'pulls', state, number: n }, { replace: true });
  const ready = status?.state === 'ready' ? status : null;

  return (
    <GhGate status={status} onRetry={() => loadStatus(true)}>
      <div className="pulls-view">
        <div className="pulls-list-pane" style={{ width }}>
          <div className="pane-header">
            <GitPullRequest size={14} className="muted" />
            <span className="pane-title" title={ready?.repo.url}>
              {ready?.repo.nameWithOwner}
            </span>
            <span className="spacer" />
            <button className="icon-button" title="Reload" onClick={() => setReload((n) => n + 1)}>
              <RefreshCw size={13} />
            </button>
            <button className="button button-small" onClick={() => actions.createPullRequest()} title="Create a pull request for the current branch">
              <Plus size={12} /> New
            </button>
          </div>
          <div className="pulls-filters">
            <div className="segmented">
              {(['open', 'closed', 'merged'] as PrState[]).map((s) => (
                <button key={s} className={state === s ? 'active' : ''} onClick={() => setView({ kind: 'pulls', state: s }, { replace: true })}>
                  {s[0].toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
            <div className="search-box pulls-search">
              <Search size={12} />
              <input placeholder="Search (GitHub syntax)" value={search} onChange={(e) => setSearch(e.target.value)} spellCheck={false} />
              {search && (
                <button className="icon-button" onClick={() => setSearch('')}>
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
          <div className="pulls-list">
            {error ? (
              <div className="empty-state error-text">{error}</div>
            ) : !list ? (
              <div className="empty-state muted">Loading pull requests…</div>
            ) : !list.length ? (
              <div className="empty-state muted">No {state} pull requests{query ? ' match' : ''}.</div>
            ) : (
              [...list.map((pr) => (
                <div key={pr.number} className={`pull-row ${pr.number === number ? 'selected' : ''}`} onMouseDown={() => select(pr.number)}>
                  <Avatar name={pr.author.login} email="" src={avatarFor(pr.author.login, ready?.host)} size={22} />
                  <div className="pull-row-text">
                    <div className="pull-row-title">
                      <PrIcon pr={pr} />
                      <span className="pull-title">{pr.title}</span>
                    </div>
                    <div className="pull-row-meta muted">
                      #{pr.number} · {pr.author.login} · <span className="mono">{pr.headRefName}</span> → <span className="mono">{pr.baseRefName}</span> · {relativeTime(Date.parse(pr.updatedAt) / 1000)}
                    </div>
                  </div>
                  <ReviewBadge decision={pr.reviewDecision} />
                  <ChecksBadge checks={pr.checks} />
                </div>
              )),
              // gh lists at most `limit`; say so instead of looking complete.
              list.length >= loaded && (
                <div key="more" className="pulls-more muted small">
                  Showing the first {list.length}.{' '}
                  {loaded < LIMITS[LIMITS.length - 1] ? (
                    <button
                      className="link-button small"
                      onClick={() => {
                        setLimit(LIMITS[LIMITS.indexOf(loaded) + 1]);
                        setReload((n) => n + 1);
                      }}
                    >
                      Show more
                    </button>
                  ) : (
                    'Search to find others.'
                  )}
                </div>
              )]
            )}
          </div>
        </div>
        <Splitter value={width} onChange={setWidth} min={300} max={800} />
        <div className="pulls-detail-pane">
          {number !== undefined ? (
            <PullDetail
              key={number}
              number={number}
              mergeMethods={ready?.repo.mergeMethods ?? ['merge']}
              canMerge={!!ready?.repo.canMerge}
              host={ready?.host}
              reload={reload}
              onChanged={() => setReload((n) => n + 1)}
            />
          ) : (
            <div className="empty-state muted">Select a pull request</div>
          )}
        </div>
      </div>
    </GhGate>
  );
}

function PullDetail({
  number,
  mergeMethods,
  canMerge,
  host,
  reload,
  onChanged,
}: {
  number: number;
  mergeMethods: GhMergeMethod[];
  canMerge: boolean;
  host: string | undefined;
  reload: number;
  onChanged: () => void;
}) {
  const { repo, run } = useRepo();
  const actions = useActions();
  const ui = useUI();
  const [pr, setPr] = useState<GhPullDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('conversation');
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.prView(repo.path, number).then(
      (p) => !cancelled && (setPr(p), setError(null)),
      // A failed reload keeps what's on screen.
      (e) => !cancelled && setPr((prev) => (prev ? prev : (setError(e instanceof Error ? e.message : String(e)), prev))),
    );
    return () => {
      cancelled = true;
    };
  }, [repo.path, number, reload]);

  const [diffAttempt, setDiffAttempt] = useState(0);
  useEffect(() => {
    if (tab !== 'files' || diffs) return;
    let cancelled = false;
    setDiffError(null);
    api.prDiff(repo.path, number).then(
      (d) => !cancelled && (setDiffs(d), setDiffError(null)),
      (e) => !cancelled && setDiffError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [tab, diffs, repo.path, number, diffAttempt]);

  const files: ChangedFile[] = useMemo(
    () => (pr?.files ?? []).map((f) => ({ path: f.path, status: 'M', additions: f.additions, deletions: f.deletions })),
    [pr],
  );

  if (error) return <div className="empty-state error-text">{error}</div>;
  if (!pr) return <div className="empty-state muted">Loading…</div>;

  const merge = async () => {
    const v = await ui.form({
      title: `Merge #${pr.number}?`,
      message: (
        <>
          <b>{pr.title}</b>
          <div className="muted small">
            <span className="mono">{pr.headRefName}</span> into <span className="mono">{pr.baseRefName}</span> on GitHub
          </div>
        </>
      ),
      fields: [
        {
          name: 'method',
          type: 'radio',
          value: mergeMethods.includes('squash') ? 'squash' : mergeMethods[0],
          options: mergeMethods.map((m) => ({
            value: m,
            label: m === 'merge' ? 'Create a merge commit' : m === 'squash' ? 'Squash and merge' : 'Rebase and merge',
          })),
        },
        // Only through a local remote that really has the head branch (not a fork's same-named one).
        ...(pr.headRemote ? [{ name: 'deleteBranch', type: 'checkbox' as const, label: `Delete ${pr.headRemote}/${pr.headRefName} once merged` }] : []),
      ],
      confirmLabel: 'Merge',
    });
    if (!v) return;
    const headRemote = pr.headRemote;
    const r = await run(
      `Merging #${pr.number}…`,
      async () => {
        const { state } = await api.prMerge(repo.path, pr.number, v.method as 'merge' | 'squash' | 'rebase', pr.headRefOid);
        let deleteError: string | null = null;
        // A queued or auto-merge pull request is still open: deleting its branch would close it.
        if (state === 'merged' && v.deleteBranch && headRemote) {
          await api.deleteRemoteBranch(repo.path, headRemote, pr.headRefName).catch((e) => {
            deleteError = e instanceof Error ? e.message : String(e);
          });
        }
        return { state, deleteError };
      },
      {
        success: ({ state }) =>
          state === 'merged'
            ? `Merged #${pr.number}`
            : state === 'queued'
              ? `Added #${pr.number} to the merge queue`
              : state === 'auto'
                ? `Auto-merge turned on for #${pr.number}: it merges once its checks pass`
                : `Merge requested for #${pr.number}`,
      },
    );
    if (!r) return;
    if (r.deleteError) ui.toast('warning', `Couldn’t delete ${headRemote}/${pr.headRefName}`, r.deleteError);
    onChanged();
  };

  const stateLabel = pr.state === 'merged' ? 'Merged' : pr.state === 'closed' ? 'Closed' : pr.isDraft ? 'Draft' : 'Open';
  return (
    <div className="pull-detail">
      <div className="pull-detail-head">
        <h2 className="pull-detail-title">
          {pr.title} <span className="muted">#{pr.number}</span>
        </h2>
        <div className="pull-detail-meta">
          <span className={`pull-state pull-state-${pr.state} ${pr.isDraft ? 'draft' : ''}`}>
            <PrIcon pr={pr} /> {stateLabel}
          </span>
          <Avatar name={pr.author.login} email="" src={avatarFor(pr.author.login, host)} size={18} />
          <span>
            <b>{pr.author.login}</b> wants to merge {pr.commits.length >= 100 ? '100+ commits' : plural(pr.commits.length, 'commit')} into <span className="mono">{pr.baseRefName}</span> from{' '}
            <span className="mono">{pr.headRefName}</span>
          </span>
        </div>
        <div className="pull-detail-actions">
          <button className="button button-small" onClick={() => actions.checkoutPullRequest(pr)} title="Check out this pull request's branch (gh pr checkout)">
            Check Out
          </button>
          <button className="button button-small" onClick={() => window.open(pr.url, '_blank')}>
            <ExternalLink size={12} /> Open on GitHub
          </button>
          <button className="icon-button" onClick={() => copyText(pr.url).then(() => ui.toast('info', 'Copied link'))} title="Copy link">
            <Copy size={13} />
          </button>
          <span className="spacer" />
          {pr.state === 'open' && canMerge && (
            <button
              className="button button-small button-primary"
              disabled={pr.isDraft || pr.mergeable === 'CONFLICTING'}
              onClick={merge}
              title={pr.isDraft ? 'Draft pull requests can’t be merged' : pr.mergeable === 'CONFLICTING' ? 'This pull request has conflicts' : 'Merge on GitHub'}
            >
              <GitMerge size={12} /> Merge…
            </button>
          )}
        </div>
      </div>
      <div className="pull-tabs segmented">
        <button className={tab === 'conversation' ? 'active' : ''} onClick={() => setTab('conversation')}>
          Conversation <span className="muted">{pr.conversation.length || ''}</span>
        </button>
        <button className={tab === 'checks' ? 'active' : ''} onClick={() => setTab('checks')}>
          Checks <span className="muted">{pr.checkRuns.length || ''}</span>
        </button>
        <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
          Files <span className="muted">{pr.changedFiles || ''}</span>
        </button>
        <button className={tab === 'commits' ? 'active' : ''} onClick={() => setTab('commits')}>
          Commits <span className="muted">{pr.commits.length >= 100 ? '100+' : pr.commits.length || ''}</span>
        </button>
      </div>
      <div className="pull-body">
        {tab === 'conversation' && (
          <div className="pull-conversation">
            <div className="pull-comment">
              <div className="pull-comment-head">
                <b>{pr.author.login}</b> <span className="muted">opened {relativeTime(Date.parse(pr.createdAt) / 1000)}</span>
              </div>
              <pre className="pull-comment-body">{pr.body || 'No description provided.'}</pre>
            </div>
            {pr.conversation.map((c, i) => (
              <div key={i} className={`pull-comment ${c.kind}`}>
                <div className="pull-comment-head">
                  <Avatar name={c.author} email="" src={avatarFor(c.author, host)} size={16} />
                  <b>{c.author}</b>
                  {c.kind === 'review' && <span className={`review-state review-${(c.reviewState ?? '').toLowerCase()}`}>{REVIEW_LABEL[c.reviewState ?? ''] ?? 'reviewed'}</span>}
                  <span className="muted">{relativeTime(Date.parse(c.createdAt) / 1000)}</span>
                </div>
                {c.body && <pre className="pull-comment-body">{c.body}</pre>}
              </div>
            ))}
          </div>
        )}
        {tab === 'checks' && (
          <div className="pull-checks">
            {!pr.checkRuns.length && <div className="empty-state muted">No checks reported.</div>}
            {pr.checkRuns.map((c, i) => (
              <div key={i} className="pull-check">
                <CheckIcon state={c.state} />
                <span className="pull-check-name">{c.name}</span>
                {c.workflow && <span className="muted small">{c.workflow}</span>}
                <span className="spacer" />
                {c.url && (
                  <button className="link-button small" onClick={() => window.open(c.url, '_blank')}>
                    Details
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {tab === 'files' &&
          (diffError ? (
            <div className="empty-state">
              <div className="error-text">{diffError}</div>
              <button className="button button-small" onClick={() => setDiffAttempt((n) => n + 1)}>
                Try Again
              </button>
            </div>
          ) : (
            <ChangesetView
              files={files}
              diffs={diffs}
              idPrefix={`pr-${number}`}
              imagesFor={() => ({})}
              totals={{ files: pr.changedFiles, additions: pr.additions, deletions: pr.deletions }}
            />
          ))}
        {tab === 'commits' && (
          <div className="pull-commits">
            {pr.commits.map((c) => (
              <div key={c.oid} className="compare-commit">
                <span className="compare-subject">{c.headline}</span>
                <span className="muted small">{c.authors.join(', ')}</span>
                <span className="muted small">{relativeTime(Date.parse(c.date) / 1000)}</span>
                <span className="muted small mono">{shortHash(c.oid)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const REVIEW_LABEL: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented', DISMISSED: 'dismissed' };

function PrIcon({ pr }: { pr: GhPullSummary }) {
  if (pr.state === 'merged') return <GitMerge size={13} className="pr-icon merged" />;
  if (pr.state === 'closed') return <GitPullRequestClosed size={13} className="pr-icon closed" />;
  if (pr.isDraft) return <GitPullRequestDraft size={13} className="pr-icon draft" />;
  return <GitPullRequest size={13} className="pr-icon open" />;
}

function ReviewBadge({ decision }: { decision: string | null }) {
  if (decision === 'APPROVED') return <span className="review-badge approved" title="Approved"><Check size={12} /></span>;
  if (decision === 'CHANGES_REQUESTED') return <span className="review-badge changes" title="Changes requested"><X size={12} /></span>;
  if (decision === 'REVIEW_REQUIRED') return <span className="review-badge required" title="Review required"><CircleDot size={11} /></span>;
  return null;
}

function ChecksBadge({ checks }: { checks: GhChecks }) {
  if (checks.state === 'none') return null;
  const title = `${checks.passed}/${checks.total} checks passed${checks.failed ? `, ${checks.failed} failed` : ''}${checks.pending ? `, ${checks.pending} running` : ''}`;
  return (
    <span className={`checks-badge ${checks.state}`} title={title}>
      <CheckIcon state={checks.state === 'failure' ? 'failure' : checks.state === 'pending' ? 'pending' : 'success'} />
    </span>
  );
}

function CheckIcon({ state }: { state: GhCheck['state'] }) {
  if (state === 'success') return <Check size={12} className="check-icon success" />;
  if (state === 'failure') return <X size={12} className="check-icon failure" />;
  if (state === 'pending') return <CircleDot size={11} className="check-icon pending" />;
  return <CircleDot size={11} className="check-icon neutral" />;
}
