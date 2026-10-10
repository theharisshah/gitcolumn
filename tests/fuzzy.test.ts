import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fuzzyFilter, fuzzyMatch } from '../src/lib/fuzzy.ts';

describe('fuzzy matching', () => {
  test('matches subsequences and rejects missing characters', () => {
    assert.ok(fuzzyMatch('wc', 'Working Copy'));
    assert.equal(fuzzyMatch('xyz', 'Working Copy'), null);
    assert.deepEqual(fuzzyMatch('', 'anything')?.positions, []);
  });

  test('boundary and camelCase matches score higher than mid-word ones', () => {
    const boundary = fuzzyMatch('nb', 'New Branch')!.score;
    const midWord = fuzzyMatch('nb', 'unbranded')!.score;
    assert.ok(boundary > midWord);
    assert.deepEqual(fuzzyMatch('cd', 'CommitDetails.tsx')!.positions, [0, 6]);
  });

  test('file names beat deep directories for paths', () => {
    const ranked = fuzzyFilter(
      ['src/components/history/item/list.ts', 'docs/history.md', 'src/components/History.tsx'],
      'history',
      (p) => p,
      { path: true },
    ).map((r) => r.item);
    assert.equal(ranked.length, 3, 'every path matches');
    assert.equal(ranked[2], 'src/components/history/item/list.ts', 'a directory-only match ranks last');
    // Regression: looking ahead for a boundary must not skip characters the rest of the query needs.
    assert.deepEqual(fuzzyMatch('history', 'src/components/History.tsx', { path: true })?.positions, [15, 16, 17, 18, 19, 20, 21]);
  });

  test('prefers contiguous runs and respects the limit', () => {
    const ranked = fuzzyFilter(['force push', 'fetch', 'refresh'], 'fetch', (s) => s).map((r) => r.item);
    assert.equal(ranked[0], 'fetch');
    assert.equal(fuzzyFilter(Array.from({ length: 100 }, (_, i) => `item ${i}`), 'item', (s) => s, { limit: 10 }).length, 10);
  });
});
