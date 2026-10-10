import type { Hunk } from '../../shared/types';

export type Range = [number, number];

const TOKEN_RE = /\w+|\s+|[^\w\s]/g;

/** Character ranges that differ between two lines, via a token-level LCS. */
export function changedRanges(a: string, b: string): [Range[], Range[]] | null {
  if (a === b) return null;
  const ta = a.match(TOKEN_RE) ?? [];
  const tb = b.match(TOKEN_RE) ?? [];
  if (ta.length * tb.length > 40000) return null;

  const n = ta.length;
  const m = tb.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ta[i] === tb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keepA = new Array<boolean>(n).fill(false);
  const keepB = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) {
      keepA[i++] = true;
      keepB[j++] = true;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }

  const common = keepA.reduce((s, k, idx) => (k ? s + ta[idx].length : s), 0);
  // Mostly-rewritten lines: highlighting every token is just noise.
  if (common < Math.max(a.length, b.length) * 0.35) return null;

  return [toRanges(ta, keepA), toRanges(tb, keepB)];
}

function toRanges(tokens: string[], keep: boolean[]): Range[] {
  const ranges: Range[] = [];
  let pos = 0;
  tokens.forEach((t, idx) => {
    const end = pos + t.length;
    if (!keep[idx]) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === pos) last[1] = end;
      else ranges.push([pos, end]);
    }
    pos = end;
  });
  return ranges;
}

/** For a hunk, map line index -> highlighted ranges, pairing runs of deletions with following additions. */
export function hunkHighlights(hunk: Hunk): Map<number, Range[]> {
  const result = new Map<number, Range[]>();
  const lines = hunk.lines;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].type !== 'del') {
      i++;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i].type === 'del') i++;
    const addStart = i;
    while (i < lines.length && lines[i].type === 'add') i++;
    const dels = addStart - delStart;
    const adds = i - addStart;
    if (!adds) continue;
    for (let k = 0; k < Math.min(dels, adds); k++) {
      const r = changedRanges(lines[delStart + k].content, lines[addStart + k].content);
      if (r) {
        result.set(delStart + k, r[0]);
        result.set(addStart + k, r[1]);
      }
    }
  }
  return result;
}
