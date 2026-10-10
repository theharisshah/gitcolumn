import { ChevronDown, ChevronRight } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { DiffLine, FileDiff, Hunk, LineSelection, PatchAction, StatusCode } from '../../shared/types';
import { hunkHighlights, type Range } from '../lib/worddiff';
import { StatusBadge } from './StatusBadge';

export type DiffMode = 'unstaged' | 'staged' | 'readonly';

interface DiffViewProps {
  diff: FileDiff;
  mode?: DiffMode;
  onApply?: (selection: LineSelection, action: PatchAction) => void;
}

const LARGE_DIFF = 5000;

/** Hunks of a single file diff, with optional hunk / line staging controls. */
export const DiffView = memo(function DiffView({ diff, mode = 'readonly', onApply }: DiffViewProps) {
  const [selection, setSelection] = useState<Map<number, Set<number>>>(new Map());
  const [showLarge, setShowLarge] = useState(false);
  const drag = useRef<{ hunk: number; select: boolean } | null>(null);

  useEffect(() => setSelection(new Map()), [diff]);
  useEffect(() => {
    const up = () => (drag.current = null);
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const lineCount = useMemo(() => diff.hunks.reduce((n, h) => n + h.lines.length, 0), [diff]);
  const canPartial = mode !== 'readonly' && !!onApply && !diff.isBinary && !diff.isNew && !diff.isDeleted && !diff.isRename;

  if (diff.isBinary) return <div className="diff-note">Binary file — no textual diff available.</div>;
  if (!diff.hunks.length) {
    let note = 'No content changes.';
    if (diff.isNew) note = 'Empty file added.';
    else if (diff.isDeleted) note = 'Empty file deleted.';
    else if (diff.isRename) note = `Renamed from ${diff.oldPath} without content changes.`;
    else if (diff.oldMode && diff.newMode) note = `File mode changed from ${diff.oldMode} to ${diff.newMode}.`;
    return <div className="diff-note">{note}</div>;
  }
  if (lineCount > LARGE_DIFF && !showLarge) {
    return (
      <div className="diff-note">
        This diff is large ({lineCount.toLocaleString()} lines).{' '}
        <button className="link-button" onClick={() => setShowLarge(true)}>
          Show anyway
        </button>
      </div>
    );
  }

  const toggle = (hunk: number, line: number, select: boolean) => {
    setSelection((prev) => {
      const next = new Map(prev);
      const set = new Set(next.get(hunk) ?? []);
      if (select) set.add(line);
      else set.delete(line);
      if (set.size) next.set(hunk, set);
      else next.delete(hunk);
      return next;
    });
  };

  const apply = (hunkIndex: number, action: PatchAction) => {
    const sel = selection.get(hunkIndex);
    onApply?.({ [hunkIndex]: sel?.size ? [...sel] : 'all' }, action);
    setSelection(new Map());
  };

  return (
    <div className={`diff ${canPartial ? 'diff-selectable' : ''}`}>
      {diff.hunks.map((hunk, hi) => (
        <HunkView
          key={hi}
          hunk={hunk}
          index={hi}
          selected={selection.get(hi)}
          canPartial={canPartial}
          actions={
            canPartial ? (
              <HunkActions mode={mode} count={selection.get(hi)?.size ?? 0} onAction={(a) => apply(hi, a)} />
            ) : null
          }
          onGutterDown={(li, isSelected) => {
            drag.current = { hunk: hi, select: !isSelected };
            toggle(hi, li, !isSelected);
          }}
          onGutterEnter={(li) => {
            if (drag.current && drag.current.hunk === hi) toggle(hi, li, drag.current.select);
          }}
        />
      ))}
      {diff.truncated && <div className="diff-note">Diff truncated — too many lines to display.</div>}
    </div>
  );
});

function HunkActions({ mode, count, onAction }: { mode: DiffMode; count: number; onAction: (a: PatchAction) => void }) {
  const what = count ? (count === 1 ? 'Line' : `${count} Lines`) : 'Hunk';
  if (mode === 'staged') {
    return (
      <button className="hunk-button" onClick={() => onAction('unstage')}>
        Unstage {what}
      </button>
    );
  }
  return (
    <>
      <button className="hunk-button hunk-button-danger" onClick={() => onAction('discard')}>
        Discard {what}
      </button>
      <button className="hunk-button hunk-button-primary" onClick={() => onAction('stage')}>
        Stage {what}
      </button>
    </>
  );
}

const HunkView = memo(function HunkView({
  hunk,
  selected,
  canPartial,
  actions,
  onGutterDown,
  onGutterEnter,
}: {
  hunk: Hunk;
  index: number;
  selected?: Set<number>;
  canPartial: boolean;
  actions: ReactNode;
  onGutterDown: (line: number, isSelected: boolean) => void;
  onGutterEnter: (line: number) => void;
}) {
  const highlights = useMemo(() => hunkHighlights(hunk), [hunk]);
  return (
    <div className="hunk">
      <div className="hunk-header">
        <span className="hunk-range">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </span>
        <span className="hunk-section">{hunk.section}</span>
        <span className="hunk-actions">{actions}</span>
      </div>
      {hunk.lines.map((line, li) => {
        const isChange = line.type !== 'context';
        const isSelected = !!selected?.has(li);
        return (
          <div key={li} className={`diff-line diff-${line.type} ${isSelected ? 'selected' : ''}`}>
            <span
              className="diff-gutter"
              onMouseDown={
                canPartial && isChange
                  ? (e) => {
                      e.preventDefault();
                      onGutterDown(li, isSelected);
                    }
                  : undefined
              }
              onMouseEnter={canPartial && isChange ? () => onGutterEnter(li) : undefined}
              title={canPartial && isChange ? 'Click or drag to select lines' : undefined}
            >
              <span className="ln">{line.oldNo ?? ''}</span>
              <span className="ln">{line.newNo ?? ''}</span>
            </span>
            <span className="diff-sign">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
            <LineContent line={line} ranges={highlights.get(li)} />
          </div>
        );
      })}
    </div>
  );
});

function LineContent({ line, ranges }: { line: DiffLine; ranges?: Range[] }) {
  const eol = line.noNewline ? <span className="diff-nonl" title="No newline at end of file">⏎̸</span> : null;
  if (!ranges?.length) {
    return (
      <span className="diff-content">
        {line.content || ' '}
        {eol}
      </span>
    );
  }
  const parts: ReactNode[] = [];
  let pos = 0;
  ranges.forEach(([s, e], i) => {
    if (s > pos) parts.push(line.content.slice(pos, s));
    parts.push(
      <mark key={i} className="diff-word">
        {line.content.slice(s, e)}
      </mark>,
    );
    pos = e;
  });
  if (pos < line.content.length) parts.push(line.content.slice(pos));
  return (
    <span className="diff-content">
      {parts}
      {eol}
    </span>
  );
}

export function diffStatus(d: FileDiff): StatusCode {
  if (d.isNew) return 'A';
  if (d.isDeleted) return 'D';
  if (d.isRename) return 'R';
  return 'M';
}

/** A collapsible file section used for stacked diffs (commit and stash details). */
export const FileDiffSection = memo(function FileDiffSection({
  diff,
  id,
  defaultOpen = true,
  onContextMenu,
}: {
  diff: FileDiff;
  id?: string;
  defaultOpen?: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="file-diff" id={id}>
      <header className="file-diff-header" onClick={() => setOpen(!open)} onContextMenu={onContextMenu}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <StatusBadge status={diffStatus(diff)} />
        <span className="file-diff-path">
          {diff.isRename && diff.oldPath !== diff.newPath ? (
            <>
              <span className="muted">{diff.oldPath} → </span>
              {diff.newPath}
            </>
          ) : (
            diff.newPath || diff.oldPath
          )}
        </span>
        <DiffStat additions={diff.additions} deletions={diff.deletions} />
      </header>
      {open && <DiffView diff={diff} />}
    </section>
  );
});

export function DiffStat({ additions, deletions }: { additions?: number; deletions?: number }) {
  if (additions === undefined && deletions === undefined) return null;
  return (
    <span className="diff-stat">
      {!!additions && <span className="stat-add">+{additions}</span>}
      {!!deletions && <span className="stat-del">−{deletions}</span>}
    </span>
  );
}
