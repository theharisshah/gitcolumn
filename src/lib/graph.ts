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
  /** The commit this lane is heading towards */
  hash: string;
  color: number;
}

export interface LayoutOptions {
  /**
   * Drop segments that lie entirely at or beyond this lane index. The renderer never shows
   * them, and in repositories with hundreds of open lines they dominate memory.
   */
  maxLanes?: number;
}

/**
 * Incremental commit graph layout. Feed commits newest-first in topological order with
 * `append`; each call lays out only the new commits, continuing from the lane state left by
 * the previous call, so paging through history costs O(new commits).
 *
 * Lanes are kept packed: when a line of history ends, the lanes to its right slide left
 * (drawn as diagonals in the bottom half of the row), so the graph is only as wide as the
 * number of lines that are actually open. A commit's first parent always continues in the
 * commit's own lane, which keeps the mainline in place; new lanes (branch tips, merged
 * branches) are added on the right so existing lanes don't shift whenever something is merged.
 */
export class GraphLayout {
  private lanes: Lane[] = [];
  private nextColor = 0;
  private cap: number;
  maxWidth = 1;

  constructor(opts: LayoutOptions = {}) {
    this.cap = opts.maxLanes ?? Infinity;
  }

  append(commits: Commit[]): GraphRow[] {
    const rows: GraphRow[] = [];
    const cap = this.cap;
    for (const c of commits) {
      const before = this.lanes;
      const segments: Segment[] = [];
      const add = (x1: number, y1: number, x2: number, y2: number, color: number) => {
        if (x1 < cap || x2 < cap) segments.push({ x1, y1, x2, y2, color });
      };

      // Every lane heading for this commit converges into its node; the node sits in the first one.
      let col = before.findIndex((l) => l.hash === c.hash);
      const isTip = col === -1;
      if (isTip) col = before.length;
      const color = isTip ? this.nextColor++ : before[col].color;

      before.forEach((l, i) => add(i, 0, l.hash === c.hash ? col : i, 0.5, l.color));

      // Lanes for the next row. `from` is the lane's x at the node line, or 'node' if it starts here.
      const next: { lane: Lane; from: number | 'node' }[] = [];
      const joins: string[] = [];
      const [first, ...others] = c.parents;
      // A lane to the right that already heads for the first parent is folded into this commit's
      // lane, so the first-parent chain keeps its column. One to the left absorbs this lane instead.
      const firstAt = first === undefined ? -1 : before.findIndex((l) => l.hash === first);
      const firstJoinsLeft = firstAt !== -1 && firstAt < col;
      for (let i = 0; i <= before.length; i++) {
        if (i === col && first !== undefined) {
          if (firstJoinsLeft) joins.push(first);
          else next.push({ lane: { hash: first, color }, from: 'node' });
        }
        const l = before[i];
        if (!l || l.hash === c.hash) continue;
        if (i === firstAt && !firstJoinsLeft) {
          // Folded into the first parent's lane: draw it sliding over to where that lane continues.
          const target = next.findIndex((n) => n.lane.hash === first);
          add(i, 0.5, target, 1, l.color);
          continue;
        }
        next.push({ lane: l, from: i });
      }
      for (const p of others) {
        if (next.some((n) => n.lane.hash === p)) joins.push(p);
        else next.push({ lane: { hash: p, color: this.nextColor++ }, from: 'node' });
      }

      next.forEach((n, j) => add(n.from === 'node' ? col : n.from, 0.5, j, 1, n.lane.color));
      for (const p of joins) {
        const j = next.findIndex((n) => n.lane.hash === p);
        add(col, 0.5, j, 1, next[j].lane.color);
      }

      this.lanes = next.map((n) => n.lane);
      const width = Math.max(before.length, this.lanes.length, col + 1);
      this.maxWidth = Math.max(this.maxWidth, width);
      rows.push({ col, color, segments, width, isMerge: c.parents.length > 1 });
    }
    return rows;
  }
}

/** Lay out a complete list of commits (newest first, topological order). */
export function layoutGraph(commits: Commit[], opts?: LayoutOptions): { rows: GraphRow[]; maxWidth: number } {
  const layout = new GraphLayout(opts);
  const rows = layout.append(commits);
  return { rows, maxWidth: layout.maxWidth };
}

export const LANE_COLORS = 8;
