import { ExternalLink, RefreshCw, SquareTerminal } from 'lucide-react';
import type { ReactNode } from 'react';
import type { GhStatus } from '../../shared/types';
import { api } from '../lib/api';
import { copyText } from '../lib/format';
import { useRepo } from '../repo/RepoContext';

/** Explains what's missing before GitHub features work: the gh CLI, a login, or a GitHub remote. */
export function GhGate({ status, onRetry, children }: { status: GhStatus | null; onRetry: () => void; children: ReactNode }) {
  const { repo } = useRepo();
  if (!status) return <div className="empty-state muted">Checking GitHub…</div>;
  if (status.state === 'ready') return <>{children}</>;
  const retry = (
    <button className="button" onClick={onRetry}>
      <RefreshCw size={12} /> Retry
    </button>
  );
  if (status.state === 'not-installed') {
    return (
      <div className="empty-state gh-gate">
        <div className="empty-title">Install the GitHub CLI</div>
        <div className="muted">Pull requests use the GitHub CLI (gh) and your own GitHub login. Nothing is stored by GitColumn.</div>
        <div className="empty-actions">
          <button className="button button-primary" onClick={() => window.open('https://cli.github.com/', '_blank')}>
            <ExternalLink size={12} /> Get gh
          </button>
          {retry}
        </div>
      </div>
    );
  }
  if (status.state === 'not-authenticated') {
    const cmd = `gh auth login --hostname ${status.host}`;
    return (
      <div className="empty-state gh-gate">
        <div className="empty-title">Sign in to GitHub</div>
        {/can't see/.test(status.message) && <div className="muted gh-gate-message">{status.message}</div>}
        <div className="muted">
          Run <code className="mono">{cmd}</code> (or <code className="mono">gh auth switch</code>) in a terminal, then retry.
        </div>
        <div className="empty-actions">
          <button
            className="button button-primary"
            onClick={() => {
              void copyText(cmd);
              void api.openTerminal(repo.path).catch(() => undefined);
            }}
            title="Opens a terminal here and copies the command"
          >
            <SquareTerminal size={12} /> Open Terminal &amp; Copy Command
          </button>
          {retry}
        </div>
      </div>
    );
  }
  return (
    <div className="empty-state gh-gate">
      <div className="empty-title">{status.state === 'not-github' ? 'Not a GitHub repository' : 'GitHub isn’t available'}</div>
      <div className="muted gh-gate-message">{status.message}</div>
      <div className="empty-actions">{retry}</div>
    </div>
  );
}
