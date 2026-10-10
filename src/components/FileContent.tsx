import { Copy, ExternalLink, FolderOpen, GitCommitHorizontal, History as HistoryIcon, Package, ScanText } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FileContentResult } from '../../shared/types';
import { useApp } from '../AppContext';
import { api } from '../lib/api';
import { FileIcon } from '../lib/fileIcons';
import { copyText, shortHash } from '../lib/format';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';
import { CodeLines } from './CodeLines';
import { ImagePreview } from './ImageDiff';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A file's contents at a revision (or in the working copy), with blame/history/open actions. */
export function FileContent({ rev, path }: { rev: string | null; path: string }) {
  const { repo, version, setView } = useRepo();
  const ui = useUI();
  const app = useApp();
  const [content, setContent] = useState<FileContentResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .fileContent(repo.path, rev, path)
      .then((c) => !cancelled && setContent(c))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
    // The working copy changes on disk; a revision never does.
  }, [repo.path, rev, path, rev === null ? version : 0]);

  const reveal = () => api.reveal(repo.path, path).catch((e) => ui.toast('error', 'Could not reveal file', String(e)));
  const open = () => api.openPath(repo.path, path).catch((e) => ui.toast('error', 'Could not open file', String(e)));
  const name = path.slice(path.lastIndexOf('/') + 1);

  let body;
  if (error) body = <div className="diff-note error-text">{error}</div>;
  else if (!content) body = <div className="diff-note muted">Loading…</div>;
  else if (content.kind === 'missing') body = <div className="diff-note">This file doesn’t exist {rev ? 'at this revision' : 'in the working copy'}.</div>;
  else if (content.kind === 'image') body = <ImagePreview spec={{ revs: [rev], path }} />;
  else if (content.kind === 'binary') {
    body = (
      <div className="diff-note">
        Binary file ({formatBytes(content.size)}).{' '}
        {rev === null && (
          <button className="link-button" onClick={open}>
            Open with default app
          </button>
        )}
      </div>
    );
  } else if (content.kind === 'lfs') {
    body = (
      <>
        <div className="diff-note lfs-note">This file is stored in Git LFS; the repository only contains this pointer.</div>
        <CodeLines text={content.content} path="pointer.txt" />
      </>
    );
  } else if (content.kind === 'symlink') {
    body = (
      <div className="diff-note">
        Symbolic link → <span className="mono">{content.content}</span>
      </div>
    );
  } else if (content.kind === 'submodule') {
    const sub = content.submodule!;
    body = (
      <div className="diff-note submodule-note">
        <Package size={16} /> Submodule at commit <span className="mono">{shortHash(sub.commit)}</span>
        {sub.url && (
          <>
            {' '}
            from <span className="mono">{sub.url}</span>
          </>
        )}
        <div className="empty-actions">
          <button className="button button-small" onClick={() => app.openRepo(`${repo.path}/${path}`)}>
            Open in New Tab
          </button>
        </div>
      </div>
    );
  } else {
    body = (
      <>
        {content.truncated && <div className="diff-note">Showing the first 2 MB of {formatBytes(content.size)}.</div>}
        <CodeLines text={content.content} path={path} />
      </>
    );
  }

  const isFile = content && content.kind !== 'submodule' && content.kind !== 'missing';
  return (
    <div className="file-content">
      <div className="pane-header file-content-header">
        <FileIcon path={path} type={content?.kind === 'submodule' ? 'commit' : content?.kind === 'symlink' ? 'symlink' : 'blob'} />
        <span className="file-content-name" title={path}>
          {name}
        </span>
        {content && content.size > 0 && <span className="muted small">{formatBytes(content.size)}</span>}
        <span className="spacer" />
        {isFile && (
          <>
            <button className="icon-button" title="Blame" onClick={() => setView({ kind: 'file', path, mode: 'blame', rev })}>
              <ScanText size={14} />
            </button>
            <button className="icon-button" title="File history" onClick={() => setView({ kind: 'file', path, mode: 'history', rev })}>
              <HistoryIcon size={14} />
            </button>
          </>
        )}
        {rev === null && (
          <>
            <button className="icon-button" title="Reveal in Finder" onClick={reveal}>
              <FolderOpen size={14} />
            </button>
            <button className="icon-button" title="Open with default app" onClick={open}>
              <ExternalLink size={14} />
            </button>
          </>
        )}
        {rev !== null && content?.oid && (
          <span className="muted small mono" title="Blob id">
            <GitCommitHorizontal size={11} /> {shortHash(content.oid)}
          </span>
        )}
        <button className="icon-button" title="Copy path" onClick={() => copyText(path).then(() => ui.toast('info', 'Copied path'))}>
          <Copy size={13} />
        </button>
      </div>
      <div className="diff-scroll">{body}</div>
    </div>
  );
}
