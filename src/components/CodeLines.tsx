import { memo, useMemo, type ReactNode } from 'react';
import { highlightLines, languageFor } from '../lib/highlight';
import { useSetting } from '../lib/settings';
import { CodeText } from './DiffView';

const MAX_LINES = 20000;

/** A read-only, syntax-highlighted view of a text file, with line numbers and an optional gutter. */
export const CodeLines = memo(function CodeLines({
  text,
  path,
  gutter,
  rowClass,
  onRowClick,
  onRowContextMenu,
  max = MAX_LINES,
}: {
  text: string | string[];
  path: string;
  /** Content for a column before the line number (blame uses it) */
  gutter?: (index: number) => ReactNode;
  rowClass?: (index: number) => string;
  onRowClick?: (index: number) => void;
  onRowContextMenu?: (e: React.MouseEvent, index: number) => void;
  max?: number;
}) {
  const [syntaxOn] = useSetting('syntaxHighlighting');
  const lines = useMemo(() => {
    const all = Array.isArray(text) ? text : text.replace(/\n$/, '').split('\n');
    return all.slice(0, max);
  }, [text, max]);
  const total = Array.isArray(text) ? text.length : text.replace(/\n$/, '').split('\n').length;
  const syntax = useMemo(() => {
    const lang = syntaxOn ? languageFor(path) : null;
    return lang && lines.length ? highlightLines(lines, lang) : null;
  }, [lines, path, syntaxOn]);

  return (
    <>
      <div className="diff code-lines">
        {lines.map((line, i) => (
          <div
            key={i}
            className={`code-line ${rowClass?.(i) ?? ''}`}
            onClick={onRowClick ? () => onRowClick(i) : undefined}
            onContextMenu={onRowContextMenu ? (e) => onRowContextMenu(e, i) : undefined}
          >
            {gutter?.(i)}
            <span className="ln">{i + 1}</span>
            <span className="diff-content">
              <CodeText text={line} segments={syntax?.[i]} />
            </span>
          </div>
        ))}
      </div>
      {total > lines.length && <div className="diff-note">Showing the first {lines.length.toLocaleString()} of {total.toLocaleString()} lines.</div>}
    </>
  );
});
