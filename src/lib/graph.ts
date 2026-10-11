import type { Commit } from '../../shared/types';

/** A line segment in lane coordinates: x = lane index, y = 0 (row top) .. 1 (row bottom). */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: number;
}

/**
 * One commit's slice of the graph. Segments are stored packed (4 int16 per segment: x1, x2, half,
 * colour), since a large history can have millions of them; `segments` decodes on demand.
 */
export class GraphRow {
  constructor(
    readonly col: number,
    readonly color: number,
    readonly width: number,
    readonly isMerge: boolean,
    readonly packed: Int16Array,
  ) {}

  get segments(): Segment[] {
    const out: Segment[] = [];
    const p = this.packed;
    for (let i = 0; i < p.length; i += 4) {
      const bottom = p[i + 2] === 1;
      out.push({ x1: p[i], y1: bottom ? 0.5 : 0, x2: p[i + 1], y2: bottom ? 1 : 0.5, color: p[i + 3] });
    }
    return out;
  }
}

/** Colours are only told apart modulo the palette size, so a wrapped counter keeps them in int16. */
const COLOR_RANGE = 1 << 14;

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
      const segments: number[] = [];
      const add = (x1: number, y1: number, x2: number, _y2: number, color: number) => {
        // Lanes past int16 range can never be shown; clamp so packing can't wrap them around.
        if (x1 < cap || x2 < cap) segments.push(Math.min(x1, 32767), Math.min(x2, 32767), y1 === 0 ? 0 : 1, color % COLOR_RANGE);
      };

      // Every lane heading for this commit converges into its node; the node sits in the first one.
      let col = before.findIndex((l) => l.hash === c.hash);
      const isTip = col === -1;
      if (isTip) col = before.length;
      const color = isTip ? this.nextColor++ : before[col].color;

      before.forEach((l, i) => add(i, 0, l.hash === c.hash ? col : i, 0.5, l.color));

      // Lanes for the next row. `from` is the lane's x at the node line, or 'node' if it starts here.
      const [first, ...others] = c.parents;
      const firstAt = first === undefined ? -1 : before.findIndex((l) => l.hash === first);
      // Plan the next row without side effects. A lane to the right that already heads for the first
      // parent is folded into this commit's lane, so the first-parent chain keeps its column; one to
      // the left absorbs the first-parent edge instead (unless `keepFirst`).
      type Planned = { lane: Lane; from: number | 'node'; isNew?: boolean };
      const plan = (keepFirst: boolean) => {
        const next: Planned[] = [];
        const joins: string[] = [];
        let fold: { from: number; color: number } | null = null;
        for (let i = 0; i <= before.length; i++) {
          if (i === col && first !== undefined) {
            if (keepFirst) next.push({ lane: { hash: first, color }, from: 'node' });
            else joins.push(first);
          }
          const l = before[i];
          if (!l || l.hash === c.hash) continue;
          if (i === firstAt && firstAt > col) {
            fold = { from: i, color: l.color };
            continue;
          }
          next.push({ lane: l, from: i });
        }
        for (const p of others) {
          if (next.some((n) => n.lane.hash === p)) joins.push(p);
          else next.push({ lane: { hash: p, color: -1 }, from: 'node', isNew: true });
        }
        return { next, joins, fold };
      };
      let planned = plan(!(firstAt !== -1 && firstAt < col));
      // A line straight down from a node reads as its first parent. If joining the first parent to the
      // left would leave another parent directly below the merge, keep the first parent in this
      // column too; the extra lane converges where that parent is drawn.
      const below = planned.next[col];
      if (firstAt !== -1 && firstAt < col && below && below.lane.hash !== first && others.includes(below.lane.hash)) {
        planned = plan(true);
      }
      const { next, joins, fold } = planned;
      for (const n of next) if (n.isNew) n.lane = { hash: n.lane.hash, color: this.nextColor++ };
      if (fold) add(fold.from, 0.5, next.findIndex((n) => n.lane.hash === first), 1, fold.color);

      next.forEach((n, j) => add(n.from === 'node' ? col : n.from, 0.5, j, 1, n.lane.color));
      for (const p of joins) {
        const j = next.findIndex((n) => n.lane.hash === p);
        add(col, 0.5, j, 1, next[j].lane.color);
      }

      this.lanes = next.map((n) => n.lane);
      const width = Math.max(before.length, this.lanes.length, col + 1);
      this.maxWidth = Math.max(this.maxWidth, width);
      rows.push(new GraphRow(col, color % COLOR_RANGE, width, c.parents.length > 1, Int16Array.from(segments)));
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

/** Lanes the History graph lays out; the list can show (and scroll sideways through) up to this many. */
export const GRAPH_LAYOUT_LANES = 48;
