import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GraphLayout, layoutGraph, type GraphRow, type Segment } from '../src/lib/graph.ts';
import type { Commit } from '../shared/types.ts';

// ------------------------------------------------------------- generators

/** Deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const commit = (hash: string, parents: string[]): Commit => ({ hash, parents, author: '', email: '', date: 0, subject: hash });

/**
 * Simulate a repository: commits on branches, new branches, merges (incl. octopus) and orphan
 * roots, then return the commits newest-first in a valid topological order.
 */
function randomHistory(seed: number, size: number): Commit[] {
  const rand = rng(seed);
  const parentsOf = new Map<string, string[]>();
  let heads: string[] = [];
  let n = 0;
  const make = (parents: string[]) => {
    const h = `c${n++}`;
    parentsOf.set(h, parents);
    return h;
  };
  heads.push(make([]));
  while (n < size) {
    const r = rand();
    const pick = () => Math.floor(rand() * heads.length);
    if (r < 0.5) {
      const i = pick();
      heads[i] = make([heads[i]]);
    } else if (r < 0.7) {
      heads.push(make([heads[pick()]]));
    } else if (r < 0.9 && heads.length > 1) {
      const i = pick();
      let j = pick();
      if (j === i) j = (i + 1) % heads.length;
      heads[i] = make([heads[i], heads[j]]);
      if (rand() < 0.7) heads = heads.filter((_, k) => k !== j);
    } else if (r < 0.95 && heads.length > 2) {
      const i = pick();
      const extra = [...new Set([pick(), pick()])].filter((k) => k !== i);
      heads[i] = make([heads[i], ...extra.map((k) => heads[k])]);
    } else {
      heads.push(make([]));
    }
  }
  // Newest-first topological order: a commit appears only after all its children.
  const childCount = new Map<string, number>();
  for (const ps of parentsOf.values()) for (const p of ps) childCount.set(p, (childCount.get(p) ?? 0) + 1);
  const ready = [...parentsOf.keys()].filter((h) => !childCount.get(h));
  const order: Commit[] = [];
  while (ready.length) {
    const h = ready.splice(Math.floor(rand() * ready.length), 1)[0];
    order.push(commit(h, parentsOf.get(h)!));
    for (const p of parentsOf.get(h)!) {
      const left = childCount.get(p)! - 1;
      childCount.set(p, left);
      if (!left) ready.push(p);
    }
  }
  return order;
}

// ------------------------------------------------------------- invariants

/** Follow the line leaving row `r` by `start` down to the commit whose node it reaches (null: off the page). */
function followEdge(commits: Commit[], rows: GraphRow[], r: number, start: Segment): string | null {
  let x = start.x2;
  for (let at = r + 1; at < rows.length; at++) {
    const enter = rows[at].segments.find((s) => s.y1 === 0 && s.x1 === x)!;
    assert.ok(enter, `row ${at}: lane at x=${x} continues`);
    // Pass-through lanes never occupy the node's column, so reaching it means arriving.
    if (enter.x2 === rows[at].col) return commits[at].hash;
    const cont = rows[at].segments.find((s) => s.y1 === 0.5 && s.x1 === x)!;
    assert.ok(cont, `row ${at}: pass-through lane at x=${x} continues downwards`);
    x = cont.x2;
  }
  return null;
}

function checkInvariants(commits: Commit[], rows: GraphRow[]) {
  assert.equal(rows.length, commits.length);
  const indexOf = new Map(commits.map((c, i) => [c.hash, i]));

  rows.forEach((row, r) => {
    assert.ok(row.col >= 0 && row.col < row.width, `row ${r}: node column inside the row width`);
    for (const s of row.segments) {
      assert.ok(s.x1 >= 0 && s.x1 < row.width && s.x2 >= 0 && s.x2 < row.width, `row ${r}: segment inside the row width`);
      assert.ok(
        (s.y1 === 0 && s.y2 === 0.5) || (s.y1 === 0.5 && s.y2 === 1),
        `row ${r}: segments span the top or bottom half`,
      );
    }
    const tops = row.segments.filter((s) => s.y1 === 0).map((s) => s.x1);
    assert.equal(new Set(tops).size, tops.length, `row ${r}: no two lanes enter at the same x`);
    const passStarts = row.segments.filter((s) => s.y1 === 0.5 && s.x1 !== row.col).map((s) => s.x1);
    assert.equal(new Set(passStarts).size, passStarts.length, `row ${r}: one continuation per pass-through lane`);
    assert.ok(!row.segments.some((s) => s.y1 === 0 && s.x1 !== s.x2 && s.x2 !== row.col), `row ${r}: only converging lanes bend in the top half`);
  });

  // Every lane leaving the bottom of a row continues at the top of the next one, and vice versa.
  for (let r = 0; r + 1 < rows.length; r++) {
    const bottoms = new Set(rows[r].segments.filter((s) => s.y2 === 1).map((s) => s.x2));
    const tops = new Set(rows[r + 1].segments.filter((s) => s.y1 === 0).map((s) => s.x1));
    assert.deepEqual([...bottoms].sort((a, b) => a - b), [...tops].sort((a, b) => a - b), `rows ${r}/${r + 1}: lanes line up`);
  }
  assert.equal(rows[0]?.segments.filter((s) => s.y1 === 0).length ?? 0, 0, 'nothing enters the first row');

  // Follow each edge leaving a commit's node; it must arrive at exactly that commit's parents.
  rows.forEach((row, r) => {
    const reached: string[] = [];
    for (const start of row.segments.filter((s) => s.y1 === 0.5 && s.x1 === row.col)) {
      const arrived = followEdge(commits, rows, r, start);
      if (arrived) reached.push(arrived);
    }
    const loadedParents = commits[r].parents.filter((p) => indexOf.has(p));
    assert.deepEqual(new Set(reached), new Set(loadedParents), `commit ${commits[r].hash}: edges reach its parents`);
    assert.equal(reached.length, new Set(reached).size, `commit ${commits[r].hash}: one edge per parent`);
  });
}

// ------------------------------------------------------------------ tests

describe('commit graph layout', () => {
  test('linear history uses a single lane', () => {
    const commits = [commit('c', ['b']), commit('b', ['a']), commit('a', [])];
    const { rows, maxWidth } = layoutGraph(commits);
    assert.equal(maxWidth, 1);
    assert.deepEqual(rows.map((r) => r.col), [0, 0, 0]);
    checkInvariants(commits, rows);
  });

  test('merged feature branch gets its own lane, which closes again', () => {
    // m merges f2 into main; f2 -> f1 -> base; main: m -> a -> base
    const commits = [commit('m', ['a', 'f2']), commit('f2', ['f1']), commit('f1', ['base']), commit('a', ['base']), commit('base', [])];
    const { rows, maxWidth } = layoutGraph(commits);
    assert.equal(maxWidth, 2);
    assert.deepEqual(rows.map((r) => r.col), [0, 1, 1, 0, 0]);
    assert.ok(rows[0].isMerge);
    // a's first parent (base) is already tracked by the feature lane, so the lines join below a.
    assert.equal(rows[3].width, 2);
    assert.equal(rows[4].width, 1);
    checkInvariants(commits, rows);
  });

  test('lanes slide left when a line of history ends', () => {
    // Three open lines; the middle one reaches its root first, so the right lane moves left.
    const commits = [commit('x', ['x0']), commit('y', ['y0']), commit('z', ['z0']), commit('y0', []), commit('x0', []), commit('z0', [])];
    const { rows } = layoutGraph(commits);
    assert.deepEqual(rows.map((r) => r.col), [0, 1, 2, 1, 0, 0]);
    const slide = rows[3].segments.find((s) => s.y1 === 0.5 && s.x1 === 2);
    assert.equal(slide?.x2, 1, 'z0 lane at x=2 moves into the freed slot');
    assert.equal(rows[3].width, 3);
    assert.equal(rows[5].width, 1);
    checkInvariants(commits, rows);
  });

  test('random histories keep all invariants', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const commits = randomHistory(seed, 20 + (seed % 120));
      checkInvariants(commits, layoutGraph(commits).rows);
    }
  });

  test('a truncated page (parents not loaded) still lines up', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const all = randomHistory(seed * 7, 150);
      const page = all.slice(0, 60);
      checkInvariants(page, layoutGraph(page).rows);
    }
  });

  test("the first parent keeps the commit's lane when another lane already heads there", () => {
    // git log --topo-order lists second parents first. M1's first parent B is already tracked by
    // G's lane on the right; M1's lane must continue to B rather than being closed.
    const commits = [
      commit('H', ['M2', 'F']),
      commit('F', ['A']),
      commit('M2', ['M1', 'G']),
      commit('G', ['B']),
      commit('M1', ['B']),
      commit('B', ['A']),
      commit('A', []),
    ];
    const { rows } = layoutGraph(commits);
    const col = (h: string) => rows[commits.findIndex((c) => c.hash === h)].col;
    assert.deepEqual(['H', 'M2', 'M1', 'B', 'A'].map(col), [0, 0, 0, 0, 0]);
    assert.equal(rows[5].color, rows[0].color, 'the mainline keeps its colour');
    checkInvariants(commits, rows);
  });

  test("the newest commit's first-parent chain stays in column 0", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const commits = randomHistory(seed * 13, 40 + (seed % 150));
      const { rows } = layoutGraph(commits);
      const at = new Map(commits.map((c, i) => [c.hash, i]));
      let h: string | undefined = commits[0].hash;
      while (h !== undefined && at.has(h)) {
        assert.equal(rows[at.get(h)!].col, 0, `seed ${seed}: ${h} is on the mainline`);
        h = commits[at.get(h)!].parents[0];
      }
    }
  });

  test('laying out page by page matches a single pass', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const commits = randomHistory(seed * 31, 400);
      const whole = layoutGraph(commits);
      const paged = new GraphLayout();
      const rows: GraphRow[] = [];
      for (let i = 0; i < commits.length; i += 37) rows.push(...paged.append(commits.slice(i, i + 37)));
      assert.deepEqual(rows, whole.rows);
      assert.equal(paged.maxWidth, whole.maxWidth);
    }
  });

  test('a lane cap drops only segments that can never be visible', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const commits = randomHistory(seed * 17, 300);
      const full = layoutGraph(commits).rows;
      const capped = layoutGraph(commits, { maxLanes: 3 }).rows;
      capped.forEach((row, r) => {
        assert.equal(row.col, full[r].col);
        assert.equal(row.width, full[r].width);
        assert.ok(row.segments.every((s) => Math.min(s.x1, s.x2) < 3));
        const visible = full[r].segments.filter((s) => Math.min(s.x1, s.x2) < 3);
        assert.deepEqual(row.segments, visible);
      });
    }
  });

  test('a line straight down from a merge always leads to its first parent', () => {
    let merges = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const commits = randomHistory(seed * 101, 40 + (seed % 160));
      const { rows } = layoutGraph(commits);
      const loaded = new Set(commits.map((c) => c.hash));
      rows.forEach((row, r) => {
        if (!row.isMerge) return;
        merges++;
        const straight = row.segments.find((s) => s.y1 === 0.5 && s.x1 === row.col && s.x2 === row.col);
        if (!straight) return;
        const reached = followEdge(commits, rows, r, straight);
        const first = commits[r].parents[0];
        if (reached !== null || loaded.has(first)) assert.equal(reached, first, `seed ${seed}: straight line below merge ${commits[r].hash}`);
      });
    }
    assert.ok(merges > 500, `checked ${merges} merges`);
  });

  test('a merge whose first parent is tracked on the left keeps a straight first-parent line', () => {
    // M is a tip to the right of main; its first parent A is main's commit. Without the extra lane, the
    // second parent F would be drawn straight below M and look like M's first parent.
    const commits = [commit('X', ['A']), commit('M', ['A', 'F']), commit('F', ['A']), commit('A', [])];
    const { rows } = layoutGraph(commits);
    const m = rows[1];
    assert.equal(m.col, 1);
    const straight = m.segments.find((s) => s.y1 === 0.5 && s.x1 === 1 && s.x2 === 1);
    assert.ok(straight, 'a line continues straight down from M');
    assert.equal(followEdge(commits, rows, 1, straight!), 'A');
    checkInvariants(commits, rows);
  });

  test('width tracks open lines rather than history length', () => {
    // 200 commits on main, each merging a 1-commit feature branch: never more than 2 lanes.
    const commits: Commit[] = [];
    for (let i = 200; i > 0; i--) {
      commits.push(commit(`m${i}`, [`m${i - 1}`, `f${i}`]));
      commits.push(commit(`f${i}`, [`m${i - 1}`]));
    }
    commits.push(commit('m0', []));
    const { maxWidth, rows } = layoutGraph(commits);
    assert.equal(maxWidth, 2);
    assert.ok(rows.every((r) => r.col <= 1));
    checkInvariants(commits, rows);
  });
});
