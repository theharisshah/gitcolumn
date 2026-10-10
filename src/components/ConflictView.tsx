import { useEffect, useMemo, useState } from 'react';
import type { FileStatus } from '../../shared/types';
import { api, type FileContent } from '../lib/api';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';

type Region = 'normal' | 'marker' | 'ours' | 'base' | 'theirs';

const CONFLICT_LABEL: Record<string, string> = {
  UU: 'Both modified',
  AA: 'Both added',
  DD: 'Both deleted',
  AU: 'Added by us',
  UA: 'Added by them',
  DU: 'Deleted by us',
  UD: 'Deleted by them',
};

export function ConflictView({ file }: { file: FileStatus }) {
  const { repo, run, status, version } = useRepo();
  const ui = useUI();
  const [content, setContent] = useState<FileContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rebasing = !!status?.state.rebasing;

  useEffect(() => {
    api
      .readFile(repo.path, file.path)
      .then((c) => {
        setContent(c);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [repo.path, file.path, version]);

  const lines = useMemo(() => {
    if (!content || content.binary) return [];
    let region: Region = 'normal';
    return content.content.split('\n').map((text) => {
      if (text.startsWith('<<<<<<<')) {
        region = 'ours';
        return { text, region: 'marker' as Region };
      }
      if (text.startsWith('|||||||') && region === 'ours') {
        region = 'base';
        return { text, region: 'marker' as Region };
      }
      if (text.startsWith('=======') && (region === 'ours' || region === 'base')) {
        region = 'theirs';
        return { text, region: 'marker' as Region };
      }
      if (text.startsWith('>>>>>>>') && region === 'theirs') {
        region = 'normal';
        return { text, region: 'marker' as Region };
      }
      return { text, region };
    });
  }, [content]);

  const conflictCount = lines.filter((l) => l.region === 'marker' && l.text.startsWith('<<<<<<<')).length;
  const resolve = (side: 'ours' | 'theirs') =>
    run('Resolving conflict…', () => api.resolveConflict(repo.path, file.path, side, file.conflictType), {
      success: `Resolved ${file.path} using ${side === 'ours' ? 'mine' : 'theirs'}`,
    });

  // During a rebase "ours" is the branch being rebased onto and "theirs" is your commit being replayed.
  const oursLabel = rebasing ? 'Use Upstream' : 'Keep Mine';
  const theirsLabel = rebasing ? 'Use My Commit' : 'Use Theirs';

  return (
    <div className="diff-pane">
      <div className="pane-header diff-pane-header conflict-header">
        <span className="status-badge status-conflicted">!</span>
        <span className="diff-pane-path">{file.path}</span>
        <span className="muted">{CONFLICT_LABEL[file.conflictType ?? ''] ?? 'Conflict'}</span>
        <span className="spacer" />
        <button className="button button-small" onClick={() => resolve('ours')} title={rebasing ? 'Take the version from the branch you are rebasing onto' : 'Take the version from your current branch (HEAD)'}>
          {oursLabel}
        </button>
        <button className="button button-small" onClick={() => resolve('theirs')} title={rebasing ? 'Take the version from the commit being applied' : 'Take the version from the branch being merged'}>
          {theirsLabel}
        </button>
        <button
          className="button button-small button-primary"
          onClick={async () => {
            if (conflictCount > 0) {
              const ok = await ui.confirm({
                title: 'File still contains conflict markers',
                message: `${conflictCount} conflict region(s) remain in ${file.path}. Mark it as resolved anyway?`,
                confirmLabel: 'Mark Resolved',
              });
              if (!ok) return;
            }
            run('Marking resolved…', () => api.stage(repo.path, [file.path]));
          }}
        >
          Mark as Resolved
        </button>
        <button className="button button-small" onClick={() => api.openPath(repo.path, file.path).catch((e) => ui.toast('error', 'Could not open file', String(e)))}>
          Open
        </button>
      </div>
      <div className="diff-scroll">
        {error && <div className="diff-note">{file.conflictType?.includes('D') ? 'This file was deleted on one side. Choose which version to keep.' : error}</div>}
        {content?.binary && <div className="diff-note">Binary file — choose which version to keep.</div>}
        {content && !content.binary && (
          <>
            <div className="diff-note conflict-note">
              {conflictCount ? `${conflictCount} conflict${conflictCount === 1 ? '' : 's'} in this file. Edit it in your editor, or pick a side for the whole file.` : 'No conflict markers left — mark the file as resolved.'}
            </div>
            <div className="diff conflict-content">
              {lines.map((l, i) => (
                <div key={i} className={`diff-line conflict-${l.region}`}>
                  <span className="diff-gutter">
                    <span className="ln">{i + 1}</span>
                  </span>
                  <span className="diff-content">{l.text || ' '}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
