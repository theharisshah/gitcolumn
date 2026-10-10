// Fuzzy matching for the palette and file filters: subsequence matching with bonuses for
// matches at word / path-segment boundaries, camelCase humps, consecutive runs and (for paths)
// the file name.

export interface FuzzyMatch {
  score: number;
  /** Indexes of matched characters in the text */
  positions: number[];
}

const isBoundary = (text: string, i: number) => {
  if (i === 0) return true;
  const prev = text[i - 1];
  const cur = text[i];
  if ('/\\_-. :'.includes(prev)) return true;
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase(); // camelCase hump
};

function matchPositions(q: string, text: string, lower: string, preferBoundary: boolean): number[] | null {
  const positions: number[] = [];
  let ti = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    let found = -1;
    for (let j = ti; j < lower.length; j++) {
      if (lower[j] !== ch) continue;
      if (found === -1) found = j;
      // Keep consecutive runs; otherwise look a little further for a boundary occurrence.
      if (!preferBoundary || (positions.length && found === positions[positions.length - 1] + 1)) break;
      if (isBoundary(text, j)) {
        found = j;
        break;
      }
      if (j - found > 24) break;
    }
    if (found === -1) return null;
    positions.push(found);
    ti = found + 1;
  }
  return positions;
}

function scorePositions(q: string, text: string, lower: string, positions: number[], baseStart: number, isPath: boolean): number {
  let score = 0;
  positions.forEach((p, k) => {
    score += 1;
    if (isBoundary(text, p)) score += 6;
    if (k > 0 && positions[k - 1] === p - 1) score += 4;
    if (isPath && p >= baseStart) score += 3;
  });
  // Prefer contiguous substrings, shorter texts, and matches near the start / in the file name.
  const at = isPath ? lower.lastIndexOf(q) : lower.indexOf(q);
  if (at !== -1) score += isBoundary(text, at) ? 10 : 2;
  if (isPath && lower.slice(baseStart).startsWith(q)) score += 12;
  else if (lower.startsWith(q)) score += 8;
  score -= (positions[positions.length - 1] - positions[0]) * 0.15;
  score -= text.length * 0.02;
  return score;
}

export function fuzzyMatch(query: string, text: string, opts: { path?: boolean } = {}): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, positions: [] };
  const lower = text.toLowerCase();
  const baseStart = opts.path ? text.lastIndexOf('/') + 1 : 0;
  let best: FuzzyMatch | null = null;
  for (const preferBoundary of [true, false]) {
    const positions = matchPositions(q, text, lower, preferBoundary);
    if (!positions) continue;
    const score = scorePositions(q, text, lower, positions, baseStart, !!opts.path);
    if (!best || score > best.score) best = { score, positions };
  }
  return best;
}

/** Filter and rank items, best first, keeping at most `limit`. */
export function fuzzyFilter<T>(items: T[], query: string, key: (item: T) => string, opts: { path?: boolean; limit?: number } = {}) {
  const q = query.trim();
  const limit = opts.limit ?? 50;
  if (!q) return items.slice(0, limit).map((item) => ({ item, match: { score: 0, positions: [] } as FuzzyMatch }));
  const out: { item: T; match: FuzzyMatch }[] = [];
  for (const item of items) {
    const match = fuzzyMatch(q, key(item), opts);
    if (match) out.push({ item, match });
  }
  out.sort((a, b) => b.match.score - a.match.score);
  return out.slice(0, limit);
}
