// History list items: commits with month section headers ("OCTOBER 2026").
import type { Commit } from '../../shared/types';

export type HistoryItem = { kind: 'header'; key: string; label: string; month: number } | { kind: 'commit'; index: number };

/** Months since year 0 in local time, so sections follow the calendar the user sees. */
export function monthOf(unix: number): number {
  const d = new Date(unix * 1000);
  return d.getFullYear() * 12 + d.getMonth();
}

export function monthLabel(month: number, locale?: string): string {
  return new Date(Math.floor(month / 12), month % 12, 1).toLocaleString(locale, { month: 'long', year: 'numeric' });
}

/**
 * Interleave month headers with a newest-first commit list. Topological order and clock skew mean
 * dates aren't monotonic, so sections only ever move back in time: a commit dated later than the
 * current section stays in it rather than starting a section for a later month.
 */
export function historyItems(commits: Commit[], opts: { headers: boolean; locale?: string }): HistoryItem[] {
  if (!opts.headers) return commits.map((_, index) => ({ kind: 'commit', index }));
  const items: HistoryItem[] = [];
  let current = Infinity;
  commits.forEach((c, index) => {
    const month = monthOf(c.committerDate ?? c.date);
    if (month < current) {
      current = month;
      items.push({ kind: 'header', key: `month:${month}:${index}`, label: monthLabel(month, opts.locale), month });
    }
    items.push({ kind: 'commit', index });
  });
  return items;
}

/** Top offset of every item (plus the total height as the last entry). */
export function itemOffsets(items: HistoryItem[], rowH: number, headerH: number): Float64Array {
  const out = new Float64Array(items.length + 1);
  for (let i = 0; i < items.length; i++) out[i + 1] = out[i] + (items[i].kind === 'header' ? headerH : rowH);
  return out;
}

/** Index of the item at a vertical position (binary search over offsets). */
export function itemAt(offsets: Float64Array, y: number): number {
  let lo = 0;
  let hi = offsets.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
