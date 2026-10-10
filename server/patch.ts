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
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let changes = 0;

    hunk.lines.forEach((line, li) => {
      const isSelected = selected === null || selected.has(li);
      let prefix: ' ' | '+' | '-' | null;
      if (line.type === 'context') prefix = ' ';
      else if (line.type === 'add') prefix = isSelected ? '+' : mode === 'forward' ? null : ' ';
      else prefix = isSelected ? '-' : mode === 'forward' ? ' ' : null;
      if (prefix === null) return;

      body.push(prefix + line.content);
      if (line.noNewline) body.push('\\ No newline at end of file');
      if (prefix !== '+') oldCount++;
      if (prefix !== '-') newCount++;
      if (prefix !== ' ') changes++;
    });

    if (changes === 0) return;

    let oldStart: number;
    let newStart: number;
    if (mode === 'forward') {
      oldStart = hunk.oldStart;
      newStart = hunk.oldStart + delta;
    } else {
      newStart = hunk.newStart;
      oldStart = hunk.newStart - delta;
    }
    // A zero-length side points at the line *before* the hunk.
    if (oldCount === 0 && oldStart > 0 && hunk.oldLines !== 0) oldStart--;
    if (newCount === 0 && newStart > 0 && hunk.newLines !== 0) newStart--;
    delta += newCount - oldCount;

    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${hunk.section ? ' ' + hunk.section : ''}`);
    out.push(...body);
  });

  if (out.length === 0) return null;
  return [...diff.header, ...out].join('\n') + '\n';
}
