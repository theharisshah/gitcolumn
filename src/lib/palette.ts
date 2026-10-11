// Quick Actions: query prefixes and ranking across sources (commands, branches, files, commits).
import { fuzzyMatch } from './fuzzy';

export type PaletteGroup = 'Commands' | 'Branches' | 'Files' | 'Commits';
export type PaletteMode = 'all' | PaletteGroup;

export const PREFIXES: { char: string; group: PaletteGroup; hint: string }[] = [
  { char: '>', group: 'Commands', hint: 'commands' },
  { char: '@', group: 'Branches', hint: 'branches & tags' },
  { char: '/', group: 'Files', hint: 'files' },
  { char: '#', group: 'Commits', hint: 'commits' },
];

export function parseQuery(raw: string): { mode: PaletteMode; text: string } {
  const trimmed = raw.trimStart();
  const prefix = PREFIXES.find((p) => trimmed.startsWith(p.char));
  return prefix ? { mode: prefix.group, text: trimmed.slice(1).trim() } : { mode: 'all', text: raw.trim() };
}

export interface PaletteEntry<T> {
  id: string;
  group: PaletteGroup;
  /** Text the query is matched against (and shown, highlighted) */
  title: string;
  detail?: string;
  /** Rank as a path: file-name matches count more */
  path?: boolean;
  /** Extra exact-prefix key, e.g. a commit hash */
  exact?: string;
  /** Other words that find this entry (ranked below title matches, not highlighted) */
  keywords?: string[];
  data: T;
}

export interface RankedEntry<T> {
  entry: PaletteEntry<T>;
  positions: number[];
}

const GROUP_ORDER: PaletteGroup[] = ['Commands', 'Branches', 'Files', 'Commits'];
/** How many results each group contributes when no prefix narrows the search. */
const MIXED_LIMIT: Record<PaletteGroup, number> = { Commands: 6, Branches: 5, Files: 6, Commits: 5 };
const SINGLE_LIMIT = 80;

/** Rank entries for a query, grouped in a fixed order (commands first), best first within each group. */
export function rankEntries<T>(mode: PaletteMode, text: string, entries: PaletteEntry<T>[]): RankedEntry<T>[] {
  const groups = mode === 'all' ? GROUP_ORDER : [mode];
  const q = text.trim();
  const out: RankedEntry<T>[] = [];
  for (const group of groups) {
    const pool = entries.filter((e) => e.group === group);
    const limit = mode === 'all' ? MIXED_LIMIT[group] : SINGLE_LIMIT;
    if (!q) {
      // Without a query: commands (and, in a single-source mode, that source) in their natural order.
      if (mode === 'all' && group !== 'Commands') continue;
      out.push(...pool.slice(0, mode === 'all' ? 50 : SINGLE_LIMIT).map((entry) => ({ entry, positions: [] })));
      continue;
    }
    const lower = q.toLowerCase();
    const scored: { entry: PaletteEntry<T>; positions: number[]; score: number }[] = [];
    for (const entry of pool) {
      if (entry.exact && lower.length >= 4 && entry.exact.startsWith(lower)) {
        scored.push({ entry, positions: [], score: 1000 });
        continue;
      }
      const m = fuzzyMatch(q, entry.title, { path: entry.path });
      if (m) {
        scored.push({ entry, positions: m.positions, score: m.score });
        continue;
      }
      const k = entry.keywords?.map((w) => fuzzyMatch(q, w)).filter((x) => !!x).sort((a, b) => b!.score - a!.score)[0];
      // Always after every title match in the group.
      if (k) scored.push({ entry, positions: [], score: k.score - 10_000 });
    }
    scored.sort((a, b) => b.score - a.score);
    out.push(...scored.slice(0, limit).map(({ entry, positions }) => ({ entry, positions })));
  }
  return out;
}
