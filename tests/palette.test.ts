import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseQuery, rankEntries, type PaletteEntry } from '../src/lib/palette.ts';

const e = (group: PaletteEntry<null>['group'], title: string, extra: Partial<PaletteEntry<null>> = {}): PaletteEntry<null> => ({
  id: `${group}:${title}`,
  group,
  title,
  data: null,
  ...extra,
});

describe('palette', () => {
  test('prefixes select a source', () => {
    assert.deepEqual(parseQuery('> fetch'), { mode: 'Commands', text: 'fetch' });
    assert.deepEqual(parseQuery('@main'), { mode: 'Branches', text: 'main' });
    assert.deepEqual(parseQuery('/src/app'), { mode: 'Files', text: 'src/app' });
    assert.deepEqual(parseQuery('#fix'), { mode: 'Commits', text: 'fix' });
    assert.deepEqual(parseQuery('  plain  '), { mode: 'all', text: 'plain' });
  });

  const entries = [
    e('Commands', 'Fetch'),
    e('Commands', 'Push'),
    e('Branches', 'feature/fetch-retry'),
    e('Branches', 'main'),
    e('Files', 'src/lib/fetcher.ts', { path: true }),
    e('Files', 'docs/push.md', { path: true }),
    e('Commits', 'Fix fetch timeout', { exact: 'abc123def4567890' }),
    e('Commits', 'Unrelated', { exact: 'fedcba9876543210' }),
  ];

  test('mixed results stay grouped in a fixed order, best match first', () => {
    const r = rankEntries('all', 'fetch', entries);
    assert.deepEqual(r.map((x) => x.entry.title), ['Fetch', 'feature/fetch-retry', 'src/lib/fetcher.ts', 'Fix fetch timeout']);
    assert.ok(r[0].positions.length === 5);
  });

  test('empty query lists commands only, or the chosen source', () => {
    assert.deepEqual(rankEntries('all', '', entries).map((x) => x.entry.group), ['Commands', 'Commands']);
    assert.deepEqual(rankEntries('Branches', '', entries).map((x) => x.entry.title), ['feature/fetch-retry', 'main']);
  });

  test('hash prefixes find commits directly', () => {
    assert.deepEqual(rankEntries('Commits', 'fedcba98', entries).map((x) => x.entry.title), ['Unrelated']);
    assert.deepEqual(rankEntries('all', 'abc1', entries).map((x) => x.entry.title)[0], 'Fix fetch timeout');
  });

  test('keywords find commands without highlighting', () => {
    const r = rankEntries('Commands', 'log', [e('Commands', 'History', { keywords: ['log', 'commits'] }), e('Commands', 'Reflog')]);
    assert.deepEqual(r.map((x) => x.entry.title), ['Reflog', 'History']);
    assert.deepEqual(r[1].positions, []);
  });

  test('stays fast with a large repository', () => {
    const big: PaletteEntry<null>[] = [
      ...Array.from({ length: 30_000 }, (_, i) => e('Files', `packages/module-${i % 97}/src/components/Widget${i}.tsx`, { path: true })),
      ...Array.from({ length: 1000 }, (_, i) => e('Commits', `Commit message number ${i} touching widgets`, { exact: i.toString(16).padStart(40, '0') })),
    ];
    const t0 = performance.now();
    const r = rankEntries('all', 'widget123', big);
    const ms = performance.now() - t0;
    assert.ok(r.some((x) => x.entry.title.endsWith('Widget123.tsx')));
    assert.ok(ms < 400, `ranking took ${ms.toFixed(0)} ms`);
  });
});
