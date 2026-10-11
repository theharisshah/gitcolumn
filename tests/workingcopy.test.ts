import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApi, dispatch } from '../server/api.ts';
import type { FileDiff, FileStatus, LineSelection, PatchAction } from '../shared/types.ts';
import { buildPathTree, descendants, flattenTree } from '../src/lib/pathTree.ts';

const api = createApi({ electron: false });
const call = <T>(method: string, args: object = {}) => dispatch(api, method, args) as Promise<T>;
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });

function newRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gitcolumn-wc-'));
  sh(dir, 'init', '-q', '-b', 'main');
  sh(dir, 'config', 'user.name', 'Test User');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

describe('commit composer backend', () => {
  let repo: string;
  before(() => {
    repo = newRepo();
    writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    sh(repo, 'add', '-A');
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  test('sign off adds a trailer', async () => {
    await call('commit', { repo, message: 'Signed', signoff: true });
    assert.match(sh(repo, 'log', '-1', '--format=%B'), /\n\nSigned-off-by: Test User <test@example.com>\n/);
  });

  test('commit template: comments stripped, relative to the worktree, honours core.commentChar', async () => {
    assert.equal(await call('commit.template', { repo }), null);
    writeFileSync(path.join(repo, '.gitmessage'), '# Explain why\nfeat: \n\n# body below\nRefs: #\n');
    sh(repo, 'config', 'commit.template', '.gitmessage');
    assert.equal(await call('commit.template', { repo }), 'feat: \n\nRefs: #');
    sh(repo, 'config', 'core.commentChar', ';');
    writeFileSync(path.join(repo, '.gitmessage'), '; hint\n# kept\n');
    assert.equal(await call('commit.template', { repo }), '# kept');
    writeFileSync(path.join(repo, '.gitmessage'), '; only comments\n');
    assert.equal(await call('commit.template', { repo }), null);
    sh(repo, 'config', 'commit.template', 'missing-file');
    assert.equal(await call('commit.template', { repo }), null);
  });

  test('author identity comes from git var, and says whether it is configured', async () => {
    assert.deepEqual(await call('identity.author', { repo }), { name: 'Test User', email: 'test@example.com', configured: true });
  });

  test('template comments honour core.commentString and CRLF templates', async () => {
    sh(repo, 'config', '--unset', 'core.commentChar');
    sh(repo, 'config', 'core.commentString', '//');
    writeFileSync(path.join(repo, '.gitmessage'), '// guide\r\nfix: \r\n# not a comment\r\n');
    sh(repo, 'config', 'commit.template', '.gitmessage');
    assert.equal(await call('commit.template', { repo }), 'fix: \n# not a comment');
    sh(repo, 'config', '--unset', 'core.commentString');
    sh(repo, 'config', '--unset', 'commit.template');
  });
});

describe('diffs that can be staged ignore diff settings', () => {
  let repo: string;
  before(() => {
    repo = newRepo();
    writeFileSync(path.join(repo, 'top.txt'), 'a\nb\nc\n');
    mkdirSync(path.join(repo, 'src'));
    writeFileSync(path.join(repo, 'src', 'x.cfg'), '# h1\n# h2\nalpha\nbeta\n');
    writeFileSync(path.join(repo, '.gitattributes'), '*.cfg diff=nohash\n');
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'init');
  });
  after(() => rmSync(repo, { recursive: true, force: true }));
  const stageFirstHunk = async (p: string) => {
    const file: FileStatus = { path: p, index: '.', worktree: 'M' };
    const diff = await call<FileDiff>('diff.working', { repo, file, staged: false, context: 0 });
    await call('patch.apply', { repo, diff, selection: { 0: 'all' }, action: 'stage', unidiffZero: true });
    return execFileSync('git', ['cat-file', 'blob', `:${p}`], { cwd: repo, encoding: 'utf8' });
  };

  test('noprefix, mnemonic prefixes and forced colour', async () => {
    sh(repo, 'config', 'diff.noprefix', 'true');
    sh(repo, 'config', 'diff.mnemonicPrefix', 'true');
    sh(repo, 'config', 'color.ui', 'always');
    writeFileSync(path.join(repo, 'top.txt'), 'a\nB\nc\n');
    assert.equal(await stageFirstHunk('top.txt'), 'a\nB\nc\n');
    for (const k of ['diff.noprefix', 'diff.mnemonicPrefix', 'color.ui']) sh(repo, 'config', '--unset', k);
  });

  test('textconv drivers are not applied to stageable diffs', async () => {
    sh(repo, 'config', 'diff.nohash.textconv', "grep -v '^#'");
    writeFileSync(path.join(repo, 'src', 'x.cfg'), '# h1\n# h2\nalpha\nbeta\nNEW\n');
    assert.equal(await stageFirstHunk('src/x.cfg'), '# h1\n# h2\nalpha\nbeta\nNEW\n');
  });
});

describe('unstage all during a merge', () => {
  test('keeps the merge (and its conflicts) going', async () => {
    const repo = newRepo();
    try {
      writeFileSync(path.join(repo, 'c.txt'), 'base\n');
      writeFileSync(path.join(repo, 'r.txt'), 'base\n');
      sh(repo, 'add', '-A');
      sh(repo, 'commit', '-q', '-m', 'base');
      sh(repo, 'switch', '-q', '-c', 'other');
      writeFileSync(path.join(repo, 'c.txt'), 'theirs\n');
      writeFileSync(path.join(repo, 'r.txt'), 'theirs\n');
      sh(repo, 'commit', '-qam', 'theirs');
      sh(repo, 'switch', '-q', 'main');
      writeFileSync(path.join(repo, 'c.txt'), 'ours\n');
      sh(repo, 'commit', '-qam', 'ours');
      try {
        sh(repo, 'merge', '-q', 'other');
      } catch {
        /* conflict expected */
      }
      await call('unstageAll', { repo });
      assert.ok(existsSync(path.join(repo, '.git', 'MERGE_HEAD')), 'still merging');
      assert.match(sh(repo, 'status', '--porcelain'), /^UU c\.txt$/m);
      assert.match(sh(repo, 'status', '--porcelain'), /^ M r\.txt$/m, 'the resolved file was unstaged');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('line staging without context (-U0)', () => {
  let repo: string;
  before(() => {
    repo = newRepo();
  });
  after(() => rmSync(repo, { recursive: true, force: true }));

  // Deterministic PRNG so failures are reproducible.
  // GITCOLUMN_STRESS=<iterations>[:seed] runs a longer randomized check.
  const [stressIters, stressSeed] = (process.env.GITCOLUMN_STRESS ?? '').split(':').map(Number);
  let seed = stressSeed || 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (n: number) => Math.floor(rand() * n);

  const file = 'f.txt';
  const fileStatus = (staged: boolean): FileStatus => ({ path: file, index: staged ? 'M' : '.', worktree: staged ? '.' : 'M' });
  const diffAt = (context: number, staged: boolean) => call<FileDiff>('diff.working', { repo, file: fileStatus(staged), staged, context });
  const lineKey = (l: { type: string; oldNo?: number; newNo?: number }) => `${l.type}:${l.type === 'add' ? l.newNo : l.oldNo}`;

  /** Translate a set of chosen change lines into a selection for this diff's hunk layout. */
  function selectionFor(diff: FileDiff, chosen: Set<string>): LineSelection {
    const sel: LineSelection = {};
    diff.hunks.forEach((h, hi) => {
      const idx = h.lines.flatMap((l, li) => (l.type !== 'context' && chosen.has(lineKey(l)) ? [li] : []));
      if (idx.length) sel[hi] = idx;
    });
    return sel;
  }

  async function outcome(fn: () => Promise<unknown>, read: () => string) {
    try {
      await fn();
      return read();
    } catch (e) {
      return `ERROR ${(e as Error).message.split('\n')[0]}`;
    }
  }

  function randomEdit(base: string[]): string[] {
    const out = [...base];
    const edits = 1 + pick(4);
    for (let e = 0; e < edits; e++) {
      const at = pick(out.length + 1);
      const kind = pick(3);
      if (kind === 0 && out.length > 1) out.splice(Math.min(at, out.length - 1), 1 + pick(2));
      // Copies of neighbouring lines and trailing spaces make hunk placement ambiguous; that's the point.
      else if (kind === 1)
        out.splice(at, 0, ...Array.from({ length: 1 + pick(3) }, (_, i) => (rand() < 0.35 && out.length ? out[Math.min(at, out.length - 1)] + (rand() < 0.3 ? ' ' : '') : `new ${e}.${i} ${pick(1000)}`)));
      else if (out.length) out[Math.min(at, out.length - 1)] = `changed ${e} ${pick(1000)}`;
    }
    return out;
  }

  /** What staging (forward) or unstaging/discarding (reverse) the chosen lines must produce, from a whole-file diff. */
  function expected(whole: FileDiff, chosen: Set<string>, forward: boolean): string {
    const lines = whole.hunks.flatMap((h) => h.lines);
    const kept = lines.filter((l) =>
      l.type === 'context' ? true : l.type === 'del' ? chosen.has(lineKey(l)) !== forward : chosen.has(lineKey(l)) === forward,
    );
    if (!kept.length) return '';
    return kept.map((l) => l.content).join('\n') + (kept[kept.length - 1].noNewline ? '' : '\n');
  }

  test('random edits and selections give exactly the expected result, with and without context', async () => {
    const abs = path.join(repo, file);
    const indexText = () => execFileSync('git', ['cat-file', 'blob', `:${file}`], { cwd: repo, encoding: 'utf8' });
    let checks = 0;
    for (let iter = 0; iter < (stressIters || 60); iter++) {
      const base = Array.from({ length: 6 + pick(20) }, (_, i) => `line ${i + 1}`);
      // Files with and without a final newline on either side.
      writeFileSync(abs, base.join('\n') + (rand() < 0.25 ? '' : '\n'));
      sh(repo, 'add', file);
      sh(repo, 'commit', '-q', '--allow-empty', '-m', `base ${iter}`);
      const modified = randomEdit(base).join('\n') + (rand() < 0.25 ? '' : '\n');
      writeFileSync(abs, modified);

      for (const action of ['stage', 'unstage', 'discard'] as PatchAction[]) {
        const staged = action === 'unstage';
        const prepare = () => {
          sh(repo, 'reset', '-q');
          writeFileSync(abs, modified);
          if (staged) sh(repo, 'add', file);
        };
        prepare();
        const whole = await diffAt(1_000_000, staged);
        if (!whole || whole.hunks.length !== 1) continue;
        const changes = whole.hunks[0].lines.filter((l) => l.type !== 'context').map(lineKey);
        const chosen = new Set(changes.filter(() => rand() < 0.5));
        if (!chosen.size) chosen.add(changes[pick(changes.length)]);
        const want = expected(whole, chosen, action === 'stage');
        const read = action === 'discard' ? () => readFileSync(abs, 'utf8') : indexText;
        for (const context of [3, 1, 0]) {
          prepare();
          const diff = await diffAt(context, staged);
          const got = await outcome(
            () => call('patch.apply', { repo, diff, selection: selectionFor(diff, chosen), action, unidiffZero: context === 0 }),
            read,
          );
          assert.equal(got, want, `iter ${iter} ${action} -U${context} chosen=${[...chosen].join(',')}\nmodified=${JSON.stringify(modified)}`);
          checks++;
        }
      }
      sh(repo, 'reset', '-q', '--hard');
    }
    assert.ok(checks >= (stressIters || 60) * 6, `ran ${checks} checks`);
  });

  test('zero-context discard next to an identical incomplete last line changes the right line', async () => {
    const abs = path.join(repo, file);
    writeFileSync(abs, 'l0\nl1\n');
    sh(repo, 'add', file);
    sh(repo, 'commit', '-q', '-m', 'dup');
    writeFileSync(abs, 'l0\nl0\nl1\nl1');
    const diff = await diffAt(0, false);
    const h = diff.hunks.findIndex((x) => x.lines.some((l) => l.type === 'add' && l.newNo === 4));
    const li = diff.hunks[h].lines.findIndex((l) => l.type === 'add' && l.newNo === 4);
    await call('patch.apply', { repo, diff, selection: { [h]: [li] }, action: 'discard', unidiffZero: true });
    assert.equal(readFileSync(abs, 'utf8'), 'l0\nl0\nl1\n');
    sh(repo, 'reset', '-q', '--hard');
  });

  test('a zero-context selection made on a stale diff is refused', async () => {
    const abs = path.join(repo, file);
    writeFileSync(abs, 'a\nb\n');
    sh(repo, 'add', file);
    sh(repo, 'commit', '-q', '-m', 'stale');
    writeFileSync(abs, 'a\nB\n');
    const diff = await diffAt(0, false);
    writeFileSync(abs, 'a\nC\n');
    await assert.rejects(call('patch.apply', { repo, diff, selection: { 0: 'all' }, action: 'stage', unidiffZero: true }), /changed since/);
    sh(repo, 'reset', '-q', '--hard');
  });

  test('staging only lines added after a last line without a newline keeps the lines apart', async () => {
    const abs = path.join(repo, file);
    writeFileSync(abs, 'one\ntwo\nlast');
    sh(repo, 'add', file);
    sh(repo, 'commit', '-q', '-m', 'no newline');
    writeFileSync(abs, 'one\ntwo\nlast\nnew 1\nnew 2\n');
    for (const context of [3, 0]) {
      sh(repo, 'reset', '-q');
      const diff = await diffAt(context, false);
      const h = diff.hunks.findIndex((x) => x.lines.some((l) => l.content === 'new 1'));
      const li = diff.hunks[h].lines.findIndex((l) => l.content === 'new 1');
      await call('patch.apply', { repo, diff, selection: { [h]: [li] }, action: 'stage', unidiffZero: context === 0 });
      assert.equal(execFileSync('git', ['cat-file', 'blob', `:${file}`], { cwd: repo, encoding: 'utf8' }), 'one\ntwo\nlast\nnew 1\n');
    }
    sh(repo, 'reset', '-q', '--hard');
  });
});

describe('pathTree', () => {
  const files = ['README.md', 'src/components/A.tsx', 'src/components/B.tsx', 'src/lib/x.ts', 'docs/guide/intro.md', 'z.txt'];
  const tree = buildPathTree(files, (f) => f);

  test('an untracked nested repository ("dir/") is an entry, not a folder', () => {
    const t = buildPathTree(['nested/', 'a/b.txt'], (f) => f);
    assert.deepEqual(t.files, ['nested/']);
    assert.deepEqual(t.dirs.map((d) => d.name), ['a']);
  });

  test('compacts single-child folders and keeps root files', () => {
    assert.deepEqual(tree.files, ['README.md', 'z.txt']);
    assert.deepEqual(
      tree.dirs.map((d) => [d.path, d.name]),
      [
        ['src', 'src'],
        ['docs/guide', 'docs/guide'],
      ],
    );
    const src = tree.dirs[0];
    assert.deepEqual(src.dirs.map((d) => d.name), ['components', 'lib']);
    assert.deepEqual(descendants(src).sort(), ['src/components/A.tsx', 'src/components/B.tsx', 'src/lib/x.ts']);
  });

  test('flattens folders first, honours collapsed folders and the file order', () => {
    const rows = flattenTree(tree, new Set(['src/components']), (a, b) => b.localeCompare(a));
    assert.deepEqual(
      rows.map((r) => (r.kind === 'dir' ? `${'  '.repeat(r.depth)}[${r.name}${r.collapsed ? '+' : ''}] ${r.items.length}` : `${'  '.repeat(r.depth)}${r.item}`)),
      ['[docs/guide] 1', '  docs/guide/intro.md', '[src] 3', '  [components+] 2', '  [lib] 1', '    src/lib/x.ts', 'z.txt', 'README.md'],
    );
  });
});
