import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { historyItems, itemAt, itemOffsets, monthLabel, monthOf } from '../src/lib/historyItems.ts';
import type { Commit } from '../shared/types.ts';

const at = (y: number, m: number, d = 15) => Math.floor(new Date(y, m, d, 12).getTime() / 1000);
const c = (hash: string, committerDate: number, date = committerDate): Commit => ({ hash, parents: [], author: '', email: '', date, subject: hash, committerDate });

describe('history items', () => {
  test('a header starts each month, newest first', () => {
    const commits = [c('a', at(2026, 9)), c('b', at(2026, 9, 2)), c('c', at(2026, 8)), c('d', at(2025, 11))];
    const items = historyItems(commits, { headers: true, locale: 'en-US' });
    assert.deepEqual(
      items.map((i) => (i.kind === 'header' ? i.label : i.index)),
      ['October 2026', 0, 1, 'September 2026', 2, 'December 2025', 3],
    );
  });

  test('an older commit listed above newer ones joins their section (topological order)', () => {
    // A merged branch's March commit comes before October mainline commits: it must not drag them into March.
    const commits = [c('merge', at(2026, 9, 20)), c('old-branch', at(2026, 2)), c('main-1', at(2026, 9, 10)), c('main-2', at(2026, 9, 1)), c('sept', at(2026, 8))];
    const items = historyItems(commits, { headers: true, locale: 'en-US' });
    assert.deepEqual(items.map((i) => (i.kind === 'header' ? i.label : i.index)), ['October 2026', 0, 1, 2, 3, 'September 2026', 4]);
  });

  test('sections only move back in time; future dates count as now', () => {
    const now = at(2026, 9, 10);
    const commits = [c('a', at(2026, 8)), c('b', at(2026, 9)), c('skewed', at(2031, 0)), c('c', at(2026, 7))];
    const items = historyItems(commits, { headers: true, locale: 'en-US', now });
    assert.deepEqual(items.map((i) => (i.kind === 'header' ? i.label : i.index)), ['October 2026', 0, 1, 2, 'August 2026', 3]);
  });

  test('labels use Gregorian months in every locale', () => {
    assert.match(monthLabel(monthOf(at(2026, 9)), 'fa-IR'), /۲۰۲۶|2026/);
  });

  test('uses the committer date, falling back to the author date', () => {
    const rebased = c('r', at(2026, 9), at(2024, 0));
    assert.equal(monthOf(rebased.committerDate!), monthOf(at(2026, 9)));
    const items = historyItems([{ ...rebased, committerDate: undefined }], { headers: true, locale: 'en-US' });
    assert.equal(items[0].kind === 'header' && items[0].label, 'January 2024');
    assert.equal(monthLabel(monthOf(at(2026, 0)), 'en-US'), 'January 2026');
  });

  test('without headers it is just the commits', () => {
    assert.deepEqual(historyItems([c('a', at(2026, 1)), c('b', at(2025, 1))], { headers: false }), [
      { kind: 'commit', index: 0 },
      { kind: 'commit', index: 1 },
    ]);
  });

  test('offsets and lookup with mixed row heights', () => {
    const items = historyItems([c('a', at(2026, 9)), c('b', at(2026, 8)), c('c', at(2026, 8))], { headers: true });
    const offsets = itemOffsets(items, 28, 24);
    assert.deepEqual([...offsets], [0, 24, 52, 76, 104, 132]);
    assert.equal(itemAt(offsets, 0), 0);
    assert.equal(itemAt(offsets, 23.9), 0);
    assert.equal(itemAt(offsets, 24), 1);
    assert.equal(itemAt(offsets, 131), 4);
    assert.equal(itemAt(offsets, 10_000), 4);
  });
});
