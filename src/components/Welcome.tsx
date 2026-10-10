import { CloudDownload, FolderOpen, FolderPlus, X } from 'lucide-react';
import type { AppInfo } from '../../shared/types';
import { isElectron } from '../lib/api';
import { relativeTime, tildify } from '../lib/format';

export interface Recent {
  path: string;
  name: string;
  opened: number;
}

export function Logo({ size = 64 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="gc-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4f8cff" />
          <stop offset="1" stopColor="#2457d6" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#gc-bg)" />
      <g stroke="#fff" strokeWidth="3.5" strokeLinecap="round" fill="none">
        <line x1="22" y1="14" x2="22" y2="50" />
        <path d="M22 40 C22 30, 42 32, 42 22" />
        <line x1="42" y1="14" x2="42" y2="22" />
      </g>
      <g fill="#fff">
        <circle cx="22" cy="18" r="5" />
        <circle cx="22" cy="46" r="5" />
        <circle cx="42" cy="22" r="5" />
      </g>
    </svg>
  );
}

export function Welcome({
  info,
  recents,
  onOpen,
  onOpenPath,
  onClone,
  onInit,
  onRemoveRecent,
}: {
  info: AppInfo | null;
  recents: Recent[];
  onOpen: () => void;
  onOpenPath: (path: string) => void;
  onClone: () => void;
  onInit: () => void;
  onRemoveRecent: (path: string) => void;
}) {
  return (
    <div className="welcome">
      <div className={`welcome-drag ${isElectron ? 'electron' : ''}`} />
      <div className="welcome-inner">
        <div className="welcome-hero">
          <Logo size={72} />
          <h1>GitColumn</h1>
          <p className="muted">A focused Git client{info?.gitVersion ? ` · git ${info.gitVersion}` : ''}</p>
        </div>
        <div className="welcome-actions">
          <button className="welcome-action" onClick={onOpen}>
            <FolderOpen size={22} />
            <span>Open Repository…</span>
            <small>Browse to a folder on disk</small>
          </button>
          <button className="welcome-action" onClick={onClone}>
            <CloudDownload size={22} />
            <span>Clone Repository…</span>
            <small>From GitHub, GitLab or any URL</small>
          </button>
          <button className="welcome-action" onClick={onInit}>
            <FolderPlus size={22} />
            <span>New Repository…</span>
            <small>Start a fresh project</small>
          </button>
        </div>
        <div className="recents">
          <div className="recents-title">Recent Repositories</div>
          {recents.length ? (
            recents.map((r) => (
              <div key={r.path} className="recent-row" onClick={() => onOpenPath(r.path)} title={r.path}>
                <span className="recent-avatar">{r.name.slice(0, 1).toUpperCase()}</span>
                <span className="recent-text">
                  <span className="recent-name">{r.name}</span>
                  <span className="recent-path">{tildify(r.path, info?.home)}</span>
                </span>
                <span className="muted small">{relativeTime(r.opened / 1000)}</span>
                <button
                  className="icon-button recent-remove"
                  title="Remove from list"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveRecent(r.path);
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            ))
          ) : (
            <div className="recents-empty muted">Repositories you open will show up here.</div>
          )}
        </div>
      </div>
    </div>
  );
}
