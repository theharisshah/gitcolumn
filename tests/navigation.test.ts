import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_NAV, navBack, navForward, navInit, navPush, navReplace, viewKey } from '../src/repo/navigation.ts';

describe('view navigation', () => {
  test('push, back and forward', () => {
    let s = navInit({ kind: 'working' });
    s = navPush(s, { kind: 'history' });
    s = navPush(s, { kind: 'files', rev: 'main' });
    assert.equal(s.stack[s.index].kind, 'files');
    s = navBack(s);
    assert.equal(s.stack[s.index].kind, 'history');
    s = navBack(s);
    s = navBack(s);
    assert.equal(s.index, 0, 'back stops at the start');
    s = navForward(s);
    s = navForward(s);
    s = navForward(s);
    assert.equal(s.stack[s.index].kind, 'files', 'forward stops at the end');
  });

  test('navigating after going back drops the forward history', () => {
    let s = navInit({ kind: 'working' });
    s = navPush(s, { kind: 'history' });
    s = navPush(s, { kind: 'stashes' });
    s = navBack(navBack(s));
    s = navPush(s, { kind: 'reflog' });
    assert.deepEqual(s.stack.map((v) => v.kind), ['working', 'reflog']);
    assert.equal(navForward(s), s);
  });

  test('pushing the current view is a no-op; undefined fields are ignored', () => {
    const s = navPush(navInit({ kind: 'working' }), { kind: 'history', ref: undefined });
    assert.equal(navPush(s, { kind: 'history' }), s);
    assert.equal(viewKey({ kind: 'history', select: undefined }), viewKey({ kind: 'history' }));
    assert.notEqual(viewKey({ kind: 'history', ref: 'a' }), viewKey({ kind: 'history', ref: 'b' }));
  });

  test('replace edits in place and history is capped', () => {
    let s = navPush(navInit({ kind: 'working' }), { kind: 'history', search: 'a' });
    s = navReplace(s, { kind: 'history', search: 'ab' });
    assert.equal(s.stack.length, 2);
    assert.deepEqual(s.stack[1], { kind: 'history', search: 'ab' });
    for (let i = 0; i < MAX_NAV + 20; i++) s = navPush(s, { kind: 'files', path: `p${i}` });
    assert.equal(s.stack.length, MAX_NAV);
    assert.equal(s.index, MAX_NAV - 1);
  });
});
