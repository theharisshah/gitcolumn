import type { FileDiff, LineSelection } from '../shared/types.ts';

/**
 * Build a patch containing only the selected hunks / lines of a file diff.
 *
 * mode 'forward' — the patch is applied as-is (staging lines from the working tree
 *   into the index). The old side must match the target exactly, so unselected
 *   deletions become context and unselected additions are dropped.
 *
 * mode 'reverse' — the patch is applied with --reverse (unstaging lines from the index,
 *   or discarding lines from the working tree). The new side must match the target
 *   exactly, so unselected additions become context and unselected deletions are dropped.
 *
 * Returns null if the selection contains no changes.
 */
export function buildPatch(diff: FileDiff, selection: LineSelection, mode: 'forward' | 'reverse'): string | null {
  const out: string[] = [];
  let delta = 0; // cumulative (additions - deletions) of hunks already emitted

  diff.hunks.forEach((hunk, hi) => {
    const sel = selection[hi];
    if (!sel) return;
    const selected = sel === 'all' ? null : new Set(sel);
    type Out = { prefix: ' ' | '+' | '-'; content: string; noNewline: boolean };
    const emitted: Out[] = [];
    hunk.lines.forEach((line, li) => {
      const isSelected = selected === null || selected.has(li);
      let prefix: ' ' | '+' | '-' | null;
      if (line.type === 'context') prefix = ' ';
      else if (line.type === 'add') prefix = isSelected ? '+' : mode === 'forward' ? null : ' ';
      else prefix = isSelected ? '-' : mode === 'forward' ? ' ' : null;
      if (prefix !== null) emitted.push({ prefix, content: line.content, noNewline: !!line.noNewline });
    });

    // "\ No newline at end of file" is only true for the last line of a side. When a partial selection
    // puts other lines after such a line, that line gains a newline on that side (otherwise git apply
    // would join it with the next line).
    const final: Out[] = [];
    emitted.forEach((l, i) => {
      if (!l.noNewline) return final.push(l);
      const rest = emitted.slice(i + 1);
      const oldAfter = rest.some((r) => r.prefix !== '+');
      const newAfter = rest.some((r) => r.prefix !== '-');
      if (l.prefix === '+') final.push({ ...l, noNewline: l.noNewline && !newAfter });
      else if (l.prefix === '-') final.push({ ...l, noNewline: l.noNewline && !oldAfter });
      else if (newAfter && !oldAfter) final.push({ ...l, prefix: '-' }, { prefix: '+', content: l.content, noNewline: false });
      else if (oldAfter && !newAfter) final.push({ prefix: '-', content: l.content, noNewline: false }, { ...l, prefix: '+' });
      else final.push({ ...l, noNewline: !oldAfter && !newAfter });
    });

    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let changes = 0;
    for (const l of final) {
      body.push(l.prefix + l.content);
      if (l.noNewline) body.push('\\ No newline at end of file');
      if (l.prefix !== '+') oldCount++;
      if (l.prefix !== '-') newCount++;
      if (l.prefix !== ' ') changes++;
    }

    if (changes === 0) return;

    // Unified diff convention: a side's start is its first line, or for a zero-length side the line
    // *before* the hunk. Without context lines (-U0) git apply positions hunks by these numbers alone.
    // The side git matches against is kept whole (old side forward, new side reverse), so its start
    // comes from the hunk; the other side is derived from the number of lines before the hunk.
    const startFrom = (linesBefore: number, count: number) => (count > 0 ? linesBefore + 1 : linesBefore);
    let oldStart: number;
    let newStart: number;
    if (mode === 'forward') {
      oldStart = hunk.oldStart;
      const before = hunk.oldLines > 0 ? hunk.oldStart - 1 : hunk.oldStart;
      newStart = startFrom(before + delta, newCount);
    } else {
      newStart = hunk.newStart;
      const before = hunk.newLines > 0 ? hunk.newStart - 1 : hunk.newStart;
      oldStart = startFrom(before - delta, oldCount);
    }
    delta += newCount - oldCount;

    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${hunk.section ? ' ' + hunk.section : ''}`);
    out.push(...body);
  });

  if (out.length === 0) return null;
  return [...diff.header, ...out].join('\n') + '\n';
}
