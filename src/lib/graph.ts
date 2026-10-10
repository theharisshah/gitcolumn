import type { Commit } from '../../shared/types';

/** A line segment in lane coordinates: x = lane index, y = 0 (row top) .. 1 (row bottom). */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: number;
}

export interface GraphRow {
  col: number;
  color: number;
  segments: Segment[];
  width: number;
  isMerge: boolean;
}

interface Lane {
  hash: string;
  color: number;
}

/**
 * Assign each commit (in topological order, newest first) a lane and compute the
 * line segments connecting it to its children (top half) and parents (bottom half).
 */
export function layoutGraph(commits: Commit[]): { rows: GraphRow[]; maxWidth: number } {
  const lanes: (Lane | null)[] = [];
  const rows: GraphRow[] = [];
  let nextColor = 0;
  let maxWidth = 1;

  const firstFree = (from = 0) => {
    for (let i = from; i < lanes.length; i++) if (!lanes[i]) return i;
    return lanes.length;
  };

  for (const c of commits) {
    const before = lanes.slice();
    const segments: Segment[] = [];

    let col = -1;
    for (let i = 0; i < before.length; i++) {
      if (before[i]?.hash === c.hash) {
        if (col === -1) col = i;
        lanes[i] = null;
      }
    }
    let color: number;
    if (col === -1) {
      // Branch tip: no child seen yet.
      col = firstFree();
      color = nextColor++;
    } else {
      color = before[col]!.color;
    }

    const parentLanes: number[] = [];
    c.parents.forEach((p, pi) => {
      const existing = lanes.findIndex((l) => l?.hash === p);
      if (existing !== -1) {
        parentLanes.push(existing);
      } else if (pi === 0) {
        lanes[col] = { hash: p, color };
        parentLanes.push(col);
      } else {
        const k = firstFree(col + 1);
        lanes[k] = { hash: p, color: nextColor++ };
        parentLanes.push(k);
      }
    });

    // Top half: lines coming in from the row above.
    before.forEach((l, i) => {
      if (!l) return;
      if (l.hash === c.hash) segments.push({ x1: i, y1: 0, x2: col, y2: 0.5, color: l.color });
      else segments.push({ x1: i, y1: 0, x2: i, y2: 0.5, color: l.color });
    });
    // Bottom half: pass-through lanes, then edges from this commit to its parents.
    lanes.forEach((l, i) => {
      if (l && before[i] && before[i]!.hash === l.hash && before[i]!.hash !== c.hash) {
        segments.push({ x1: i, y1: 0.5, x2: i, y2: 1, color: l.color });
      }
    });
    for (const k of parentLanes) {
      segments.push({ x1: col, y1: 0.5, x2: k, y2: 1, color: k === col ? color : lanes[k]!.color });
    }

    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    const width = Math.max(before.length, lanes.length, col + 1);
    maxWidth = Math.max(maxWidth, width);
    rows.push({ col, color, segments, width, isMerge: c.parents.length > 1 });
  }
  return { rows, maxWidth };
}

export const LANE_COLORS = 8;
