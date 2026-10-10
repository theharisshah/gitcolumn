import { useEffect, useMemo, useState } from 'react';
import type { ChangedFile, FileDiff } from '../../shared/types';
import { plural } from '../lib/format';
import { FileDiffSection, type ImageSources } from './DiffView';

const AUTO_EXPAND_LINES = 4000;
const pathOf = (d: FileDiff) => d.newPath || d.oldPath;

/** The changed files of a commit (or comparison) as collapsible diffs, with a summary and Expand All. */
export function ChangesetView({
  files,
  diffs,
  idPrefix,
  imagesFor,
  fileMenu,
}: {
  files: ChangedFile[];
  diffs: FileDiff[] | null;
  idPrefix: string;
  imagesFor: (d: FileDiff) => ImageSources;
  fileMenu?: (e: React.MouseEvent, path: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  // Small changesets start expanded; big ones start collapsed so the list stays scannable.
  useEffect(() => {
    if (!diffs) return;
    const total = diffs.reduce((n, d) => n + d.additions + d.deletions, 0);
    setOpen(total <= AUTO_EXPAND_LINES && diffs.length <= 40 ? new Set(diffs.map(pathOf)) : new Set());
  }, [diffs]);

  const additions = useMemo(() => files.reduce((n, f) => n + (f.additions ?? 0), 0), [files]);
  const deletions = useMemo(() => files.reduce((n, f) => n + (f.deletions ?? 0), 0), [files]);
  const allOpen = !!diffs?.length && diffs.every((d) => open.has(pathOf(d)));

  return (
    <div className="changeset">
      <div className="changeset-bar">
        <button className="link-button" disabled={!diffs?.length} onClick={() => setOpen(allOpen ? new Set() : new Set(diffs!.map(pathOf)))}>
          {allOpen ? 'Collapse All' : 'Expand All'}
        </button>
        <span className="spacer" />
        <span className="muted small">
          Showing {plural(files.length, 'changed file')} with {plural(additions, 'addition')} and {plural(deletions, 'deletion')}
        </span>
      </div>
      {!diffs && <div className="diff-note muted">Loading changes…</div>}
      {diffs?.map((d) => {
        const p = pathOf(d);
        return (
          <FileDiffSection
            key={p}
            id={`${idPrefix}-${p}`}
            diff={d}
            open={open.has(p)}
            onToggle={(o) =>
              setOpen((s) => {
                const next = new Set(s);
                if (o) next.add(p);
                else next.delete(p);
                return next;
              })
            }
            images={imagesFor(d)}
            onContextMenu={fileMenu ? (e) => fileMenu(e, p) : undefined}
          />
        );
      })}
      {diffs && !diffs.length && <div className="diff-note muted">No file changes{files.length ? ' (merge with no differences from its first parent)' : ''}.</div>}
    </div>
  );
}
