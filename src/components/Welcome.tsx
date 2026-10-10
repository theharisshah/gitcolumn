import { CloudDownload, FolderOpen, FolderPlus, X } from 'lucide-react';
import iconUrl from '../../build/icon.svg';
import type { AppInfo } from '../../shared/types';
import { isElectron } from '../lib/api';
import { relativeTime, tildify } from '../lib/format';

export interface Recent {
  path: string;
  name: string;
  opened: number;
}

export function Logo({ size = 64 }: { size?: number }) {
  // The artwork has the macOS icon grid's ~10% margin built in. Scale it up so the tile itself is
  // `size` wide, and pull that margin back in so the layout box is exactly size × size.
  const drawn = size * 1.24;
  const inset = (drawn - size) / 2;
  return <img src={iconUrl} width={drawn} height={drawn} alt="" draggable={false} style={{ margin: -inset }} />;
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
