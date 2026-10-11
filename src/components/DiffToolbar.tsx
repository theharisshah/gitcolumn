import { WrapText } from 'lucide-react';
import type { FileDiff } from '../../shared/types';
import { plural } from '../lib/format';

export type DiffSide = 'unstaged' | 'staged';

export const CONTEXT_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'No context' },
  { value: 1, label: '1 line' },
  { value: 3, label: '3 lines' },
  { value: 5, label: '5 lines' },
  { value: 10, label: '10 lines' },
  { value: 25, label: '25 lines' },
  { value: 1_000_000, label: 'Whole file' },
];

/** "3 chunks, 15 insertions, 1 deletion" (undefined: still loading) */
export function diffSummary(diff: FileDiff | null | undefined): string {
  if (diff === undefined) return '';
  if (!diff) return 'No changes';
  if (diff.isBinary) return 'Binary file';
  let add = 0;
  let del = 0;
  for (const h of diff.hunks) for (const l of h.lines) l.type === 'add' ? add++ : l.type === 'del' ? del++ : 0;
  return [plural(diff.hunks.length, 'chunk'), plural(add, 'insertion'), plural(del, 'deletion')].join(', ');
}

/** Above a working copy diff: which side is shown, a summary, and the view options. */
export function DiffToolbar({
  side,
  onSide,
  hasStaged,
  hasUnstaged,
  diff,
  context,
  onContext,
  wrap,
  onWrap,
  ignoreWhitespace,
  onIgnoreWhitespace,
}: {
  side?: DiffSide;
  onSide?: (side: DiffSide) => void;
  hasStaged?: boolean;
  hasUnstaged?: boolean;
  diff: FileDiff | null | undefined;
  context: number;
  onContext: (n: number) => void;
  wrap: boolean;
  onWrap: (on: boolean) => void;
  ignoreWhitespace: boolean;
  onIgnoreWhitespace: (on: boolean) => void;
}) {
  const known = CONTEXT_OPTIONS.some((o) => o.value === context);
  return (
    <div className="diff-toolbar">
      {side && onSide && (
        <div className="segmented" role="tablist">
          <button className={side === 'unstaged' ? 'active' : ''} disabled={!hasUnstaged} onClick={() => onSide('unstaged')} title="Changes not yet staged">
            Unstaged
          </button>
          <button className={side === 'staged' ? 'active' : ''} disabled={!hasStaged} onClick={() => onSide('staged')} title="Changes that will be committed">
            Staged
          </button>
        </div>
      )}
      <span className="diff-summary muted">{diffSummary(diff)}</span>
      <span className="spacer" />
      <select className="input diff-context" value={context} onChange={(e) => onContext(Number(e.target.value))} title="Lines of context around each change">
        {!known && <option value={context}>{plural(context, 'line')}</option>}
        {CONTEXT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button className={`icon-toggle ${wrap ? 'active' : ''}`} onClick={() => onWrap(!wrap)} title={wrap ? 'Long lines wrap (click to scroll instead)' : 'Long lines scroll (click to wrap)'} aria-pressed={wrap}>
        <WrapText size={14} />
      </button>
      <label className="toggle" title="Ignore whitespace changes">
        <input type="checkbox" checked={ignoreWhitespace} onChange={(e) => onIgnoreWhitespace(e.target.checked)} />
        Ignore whitespace
      </label>
    </div>
  );
}
