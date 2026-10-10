import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createApi, dispatch } from '../server/api.ts';
import { configureGit } from '../server/git.ts';
import type { ChangedFile, CommitDetail, FileContentResult, TreeEntry } from '../shared/types.ts';

const tmp: string[] = [];
const mk = (prefix: string) => {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmp.push(d);
  return d;
};
const exportDir = mk('gitcolumn-export-');
let exportName = 'out.zip';
const api = createApi({ electron: false, saveFile: async () => path.join(exportDir, exportName) });
const call = <T>(method: string, args: object = {}) => dispatch(api, method, args) as Promise<T>;
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

after(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('files', () => {
  let repo: string;
  before(() => {
    configureGit({ GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' });
    const lib = mk('gitcolumn-lib-');
    sh(lib, 'init', '-q', '-b', 'main');
    sh(lib, 'config', 'user.name', 'T');
    sh(lib, 'config', 'user.email', 't@example.com');
    writeFileSync(path.join(lib, 'lib.txt'), 'lib\n');
    sh(lib, 'add', '-A');
    sh(lib, 'commit', '-q', '-m', 'lib');

    repo = mk('gitcolumn-files-');
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.name', 'Test User');
    sh(repo, 'config', 'user.email', 'test@example.com');
    mkdirSync(path.join(repo, 'src/deep/er'), { recursive: true });
    writeFileSync(path.join(repo, 'README.md'), '# Hello\n');
    writeFileSync(path.join(repo, 'src/app.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(repo, 'src/deep/er/ünï cødé.txt'), 'unicode\n');
    writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
    writeFileSync(path.join(repo, 'pixel.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 10));
    writeFileSync(path.join(repo, 'model.psd'), 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 10\n');
    writeFileSync(path.join(repo, '.gitignore'), 'dist/\n*.log\n');
    symlinkSync('src/app.ts', path.join(repo, 'link'));
    sh(repo, 'add', '-A');
    sh(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib');
    sh(repo, 'commit', '-q', '-m', 'Initial');
    sh(repo, 'tag', 'v1');
    // Working copy only: an untracked file, ignored files, an ignored-but-tracked file.
    writeFileSync(path.join(repo, 'new.txt'), 'untracked\n');
    mkdirSync(path.join(repo, 'dist'));
    writeFileSync(path.join(repo, 'dist/out.js'), 'built\n');
    writeFileSync(path.join(repo, 'debug.log'), 'log\n');
  });

  test('tree at a revision: directories first, symlink and submodule types', async () => {
    const root = await call<TreeEntry[]>('tree.list', { repo, rev: 'v1' });
    assert.deepEqual(root.map((e) => `${e.type}:${e.name}`), [
      'tree:src',
      'tree:vendor',
      'blob:.gitignore',
      'blob:.gitmodules',
      'blob:big.txt',
      'blob:bin.dat',
      'symlink:link',
      'blob:model.psd',
      'blob:pixel.png',
      'blob:README.md',
    ]);
    assert.equal(root.find((e) => e.name === 'README.md')?.size, 8);
    const vendor = await call<TreeEntry[]>('tree.list', { repo, rev: 'HEAD', dir: 'vendor' });
    assert.deepEqual(vendor.map((e) => [e.type, e.path]), [['commit', 'vendor/lib']]);
    const deep = await call<TreeEntry[]>('tree.list', { repo, rev: 'main', dir: 'src/deep/er/' });
    assert.equal(deep[0].path, 'src/deep/er/ünï cødé.txt');
    await assert.rejects(call('tree.list', { repo, rev: 'main', dir: '../etc' }), /Invalid directory/);
  });

  test('working copy tree hides ignored files and shows untracked ones', async () => {
    const root = await call<TreeEntry[]>('tree.list', { repo, rev: null });
    const names = root.map((e) => e.name);
    assert.ok(names.includes('new.txt'));
    assert.ok(!names.includes('dist') && !names.includes('debug.log') && !names.includes('.git'));
    assert.equal(root.find((e) => e.name === 'vendor')?.type, 'tree');
    const vendor = await call<TreeEntry[]>('tree.list', { repo, rev: null, dir: 'vendor' });
    assert.equal(vendor[0].type, 'commit');
  });

  test('file contents by kind', async () => {
    const at = (p: string, rev: string | null = 'HEAD') => call<FileContentResult>('file.content', { repo, rev, path: p });
    assert.equal((await at('README.md')).content, '# Hello\n');
    assert.equal((await at('bin.dat')).kind, 'binary');
    assert.equal((await at('pixel.png')).kind, 'image');
    assert.equal((await at('model.psd')).kind, 'lfs');
    const big = await at('big.txt');
    assert.equal(big.truncated, true);
    assert.equal(big.size, 2 * 1024 * 1024 + 10);
    const link = await at('link');
    assert.deepEqual([link.kind, link.content], ['symlink', 'src/app.ts']);
    const sub = await at('vendor/lib');
    assert.equal(sub.kind, 'submodule');
    assert.match(sub.submodule?.url ?? '', /gitcolumn-lib-/);
    assert.equal((await at('nope.txt')).kind, 'missing');
    assert.equal((await at('new.txt', null)).content, 'untracked\n');
    assert.equal((await at('link', null)).kind, 'symlink');
    assert.equal((await at('vendor/lib', null)).kind, 'submodule');
    await assert.rejects(at('../outside', null), /Invalid directory/);
  });

  test('search lists every path', async () => {
    const atRev = await call<string[]>('files.search', { repo, rev: 'v1' });
    assert.ok(atRev.includes('src/deep/er/ünï cødé.txt') && !atRev.includes('new.txt'));
    const wc = await call<string[]>('files.search', { repo, rev: null });
    assert.ok(wc.includes('new.txt') && !wc.includes('debug.log') && !wc.includes('dist/out.js'));
  });

  test('export writes a zip archive', async () => {
    exportName = 'all.zip';
    const dest = await call<string>('archive.export', { repo, rev: 'v1', name: 'project v1' });
    assert.equal(dest, path.join(exportDir, 'all.zip'));
    assert.equal(readFileSync(dest).subarray(0, 2).toString(), 'PK');
    exportName = 'src.zip';
    const only = await call<string>('archive.export', { repo, rev: 'HEAD', path: 'src', name: 'src' });
    const listing = execFileSync('unzip', ['-l', only], { encoding: 'utf8' });
    assert.match(listing, /src\/app\.ts/);
    assert.doesNotMatch(listing, /README/);
  });

  test('changed files between revisions and commit tree hash', async () => {
    writeFileSync(path.join(repo, 'README.md'), '# Hello\nworld\n');
    sh(repo, 'commit', '-qam', 'Second');
    const files = await call<ChangedFile[]>('diff.files', { repo, from: 'v1', to: 'HEAD' });
    assert.deepEqual(files.map((f) => [f.status, f.path, f.additions]), [['M', 'README.md', 1]]);
    const root = await call<ChangedFile[]>('diff.files', { repo, from: null, to: 'v1' });
    assert.ok(root.length >= 9);
    const detail = await call<CommitDetail>('commit.detail', { repo, hash: 'HEAD' });
    assert.equal(detail.tree, sh(repo, 'rev-parse', 'HEAD^{tree}').trim());
  });
});
