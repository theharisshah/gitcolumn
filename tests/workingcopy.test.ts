import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  test('author identity comes from git var', async () => {
    assert.deepEqual(await call('identity.author', { repo }), { name: 'Test User', email: 'test@example.com' });
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
      else if (kind === 1) out.splice(at, 0, ...Array.from({ length: 1 + pick(3) }, (_, i) => `new ${e}.${i} ${pick(1000)}`));
      else if (out.length) out[Math.min(at, out.length - 1)] = `changed ${e} ${pick(1000)}`;
    }
    return out;
  }

  test('matches staging with context for random edits and selections', async () => {
    const abs = path.join(repo, file);
    const indexBlob = () => sh(repo, 'rev-parse', `:${file}`).trim();
    const results: string[] = [];
    for (let iter = 0; iter < (stressIters || 40); iter++) {
      const base = Array.from({ length: 12 + pick(20) }, (_, i) => `line ${i + 1}`);
      writeFileSync(abs, base.join('\n') + '\n');
      sh(repo, 'add', file);
      sh(repo, 'commit', '-q', '--allow-empty', '-m', `base ${iter}`);
      const edited = randomEdit(base);
      const modified = edited.join('\n') + (rand() < 0.15 ? '' : '\n');
      writeFileSync(abs, modified);

      for (const action of ['stage', 'unstage', 'discard'] as PatchAction[]) {
        const staged = action === 'unstage';
        const prepare = () => {
          sh(repo, 'reset', '-q');
          writeFileSync(abs, modified);
          if (staged) sh(repo, 'add', file);
        };
        prepare();
        const ref = await diffAt(3, staged);
        if (!ref) continue;
        const changes = ref.hunks.flatMap((h) => h.lines.filter((l) => l.type !== 'context').map(lineKey));
        const chosen = new Set(changes.filter(() => rand() < 0.5));
        if (!chosen.size) chosen.add(changes[pick(changes.length)]);
        const read = action === 'discard' ? () => readFileSync(abs, 'utf8') : indexBlob;

        const withContext = await outcome(() => call('patch.apply', { repo, diff: ref, selection: selectionFor(ref, chosen), action }), read);
        prepare();
        const zero = await diffAt(0, staged);
        const withoutContext = await outcome(
          () => call('patch.apply', { repo, diff: zero, selection: selectionFor(zero, chosen), action, unidiffZero: true }),
          read,
        );
        assert.ok(!withContext.startsWith('ERROR'), `reference failed: iter ${iter} ${action}: ${withContext}`);
        assert.equal(withoutContext, withContext, `iter ${iter} ${action} chosen=${[...chosen].join(',')}\n${modified}`);
        results.push(action);
      }
      sh(repo, 'reset', '-q', '--hard');
    }
    assert.ok(results.length >= (stressIters || 40) * 2.5, `ran ${results.length} comparisons`);
  });
});

describe('pathTree', () => {
  const files = ['README.md', 'src/components/A.tsx', 'src/components/B.tsx', 'src/lib/x.ts', 'docs/guide/intro.md', 'z.txt'];
  const tree = buildPathTree(files, (f) => f);

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
