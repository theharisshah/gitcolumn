import { ChevronDown, ChevronRight, HardDrive } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BlobSpec, DiffLine, FileDiff, Hunk, LineSelection, PatchAction, StatusCode } from '../../shared/types';
import { highlightHunk, languageFor, type Segment } from '../lib/highlight';
import { getSetting } from '../lib/settings';
import { hunkHighlights, type Range } from '../lib/worddiff';
import { ImageDiff, isImagePath } from './ImageDiff';
import { StatusBadge } from './StatusBadge';

export type DiffMode = 'unstaged' | 'staged' | 'readonly';

/** Where to load the before/after versions of a binary image from. */
export interface ImageSources {
  before?: BlobSpec;
  after?: BlobSpec;
}

interface DiffViewProps {
  diff: FileDiff;
  mode?: DiffMode;
  onApply?: (selection: LineSelection, action: PatchAction) => void;
  images?: ImageSources;
  /** Wrap long lines (default) or scroll them horizontally with a sticky gutter */
  wrap?: boolean;
}

const LARGE_DIFF = 5000;
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';

/** Hunks of a single file diff, with optional hunk / line staging controls. */
export const DiffView = memo(function DiffView({ diff, mode = 'readonly', onApply, images, wrap = true }: DiffViewProps) {
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
  const path = diff.newPath || diff.oldPath;
  const lang = useMemo(() => (getSetting('syntaxHighlighting') ? languageFor(path) : null), [path]);
  const isLfs = useMemo(() => diff.hunks.some((h) => h.lines.some((l) => l.content === LFS_POINTER)), [diff]);
  const canPartial = mode !== 'readonly' && !!onApply && !diff.isBinary && !diff.isNew && !diff.isDeleted && !diff.isRename;

  if (diff.isBinary) {
    if (images && isImagePath(path)) return <ImageDiff before={diff.isNew ? undefined : images.before} after={diff.isDeleted ? undefined : images.after} />;
    return <div className="diff-note">Binary file — no textual diff available.</div>;
  }
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
    <div className={`diff ${canPartial ? 'diff-selectable' : ''} ${wrap ? '' : 'nowrap'}`}>
      {isLfs && (
        <div className="diff-note lfs-note">
          <HardDrive size={13} /> Git LFS pointer — the file's content is stored in Git LFS. The pointer change is shown below.
        </div>
      )}
      {diff.hunks.map((hunk, hi) => (
        <HunkView
          key={hi}
          hunk={hunk}
          lang={lineCount <= LARGE_DIFF ? lang : null}
          selected={selection.get(hi)}
          canPartial={canPartial}
          actions={canPartial ? <HunkActions mode={mode} count={selection.get(hi)?.size ?? 0} onAction={(a) => apply(hi, a)} /> : null}
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
  const what = count ? (count === 1 ? 'Line' : `${count} Lines`) : 'Chunk';
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
  lang,
  selected,
  canPartial,
  actions,
  onGutterDown,
  onGutterEnter,
}: {
  hunk: Hunk;
  lang: string | null;
  selected?: Set<number>;
  canPartial: boolean;
  actions: ReactNode;
  onGutterDown: (line: number, isSelected: boolean) => void;
  onGutterEnter: (line: number) => void;
}) {
  const highlights = useMemo(() => hunkHighlights(hunk), [hunk]);
  const syntax = useMemo(() => (lang ? highlightHunk(hunk, lang) : null), [hunk, lang]);
  return (
    <div className="hunk">
      <div className="hunk-header">
        <span className="hunk-range">
          @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
        </span>
        <span className="hunk-section">{hunk.section}</span>
        <span className="hunk-actions">{actions}</span>
      </div>
      <div className="hunk-lines">
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
            <LineContent line={line} ranges={highlights.get(li)} segments={syntax?.[li]} />
          </div>
        );
      })}
      </div>
    </div>
  );
});

/** Render a line from syntax segments, marking word-level changes on top. */
export function CodeText({ text, segments, ranges }: { text: string; segments?: Segment[]; ranges?: Range[] }) {
  const segs = segments ?? [{ text }];
  if (!text) return <> </>;
  if (!ranges?.length && !segments) return <>{text}</>;
  const parts: ReactNode[] = [];
  let pos = 0;
  let r = 0;
  segs.forEach((seg, si) => {
    let start = pos;
    const end = pos + seg.text.length;
    while (start < end) {
      while (ranges && r < ranges.length && ranges[r][1] <= start) r++;
      const range = ranges?.[r];
      let stop = end;
      let marked = false;
      if (range && range[0] <= start) {
        marked = true;
        stop = Math.min(end, range[1]);
      } else if (range && range[0] < end) {
        stop = range[0];
      }
      const piece = seg.text.slice(start - pos, stop - pos);
      const cls = [seg.cls, marked ? 'diff-word' : ''].filter(Boolean).join(' ');
      parts.push(cls ? <span key={`${si}-${start}`} className={cls}>{piece}</span> : piece);
      start = stop;
    }
    pos = end;
  });
  return <>{parts}</>;
}

function LineContent({ line, ranges, segments }: { line: DiffLine; ranges?: Range[]; segments?: Segment[] }) {
  return (
    <span className="diff-content">
      <CodeText text={line.content} segments={segments} ranges={ranges} />
      {line.noNewline && (
        <span className="diff-nonl" title="No newline at end of file">
          ⏎̸
        </span>
      )}
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
  open: openProp,
  onToggle,
  images,
  onContextMenu,
}: {
  diff: FileDiff;
  id?: string;
  defaultOpen?: boolean;
  /** Controlled open state (with onToggle) */
  open?: boolean;
  onToggle?: (open: boolean) => void;
  images?: ImageSources;
  onContextMenu?: (e: React.MouseEvent) => void;
}) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const toggle = () => {
    if (onToggle) onToggle(!open);
    else setOpenState(!open);
  };
  const status = diffStatus(diff);
  return (
    <section className="file-diff" id={id}>
      <header className="file-diff-header" onClick={toggle} onContextMenu={onContextMenu}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className={`file-diff-kind kind-${status}`}>{STATUS_WORD[status]}</span>
        <StatusBadge status={status} />
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
      {open && <DiffView diff={diff} images={images} />}
    </section>
  );
});

const STATUS_WORD: Partial<Record<StatusCode, string>> = { A: 'added', D: 'deleted', R: 'renamed', M: 'modified' };

export function DiffStat({ additions, deletions }: { additions?: number; deletions?: number }) {
  if (additions === undefined && deletions === undefined) return null;
  return (
    <span className="diff-stat">
      {!!additions && <span className="stat-add">+{additions}</span>}
      {!!deletions && <span className="stat-del">−{deletions}</span>}
    </span>
  );
}
