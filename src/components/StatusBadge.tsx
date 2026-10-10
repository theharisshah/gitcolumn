import type { FileStatus, StatusCode } from '../../shared/types';

const LABELS: Record<string, { letter: string; cls: string; title: string }> = {
  M: { letter: 'M', cls: 'modified', title: 'Modified' },
  T: { letter: 'T', cls: 'modified', title: 'Type changed' },
  A: { letter: 'A', cls: 'added', title: 'Added' },
  '?': { letter: '+', cls: 'added', title: 'Untracked' },
  D: { letter: 'D', cls: 'deleted', title: 'Deleted' },
  R: { letter: 'R', cls: 'renamed', title: 'Renamed' },
  C: { letter: 'C', cls: 'renamed', title: 'Copied' },
  U: { letter: '!', cls: 'conflicted', title: 'Conflicted' },
};

export function StatusBadge({ status }: { status: StatusCode }) {
  const l = LABELS[status] ?? LABELS.M;
  return (
    <span className={`status-badge status-${l.cls}`} title={l.title}>
      {l.letter}
    </span>
  );
}

/** The most relevant status letter for a working copy file. */
export function primaryStatus(f: FileStatus): StatusCode {
  if (f.conflicted) return 'U';
  if (f.untracked) return '?';
  if (f.index !== '.' && f.index !== 'M') return f.index;
  if (f.worktree !== '.') return f.worktree;
  return f.index;
}
