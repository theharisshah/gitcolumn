// Browsing repository files: trees at any revision or in the working copy, file contents and export.
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChangedFile, FileContentResult, TreeEntry } from '../shared/types.ts';
import { changedFiles } from './changes.ts';
import type { HandlerModule } from './ctx.ts';
import { git, gitRaw } from './git.ts';
import { assertSafe, insideRepo, run } from './util.ts';

const MAX_CONTENT = 2 * 1024 * 1024;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';
const TREE_LINE = /^(\d{6}) (\w+) ([0-9a-f]+) +(\S+)\t([\s\S]*)$/;

/** A repository-relative directory: no absolute paths, no `..` segments. */
function normalizeDir(dir: string | undefined): string {
  let d = (dir ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  while (d.startsWith('./')) d = d.slice(2);
  if (d === '.') d = '';
  if (d.startsWith('/') || d.split('/').includes('..')) throw new Error(`Invalid directory: ${dir}`);
  return d;
}

function normalizeFile(p: string): string {
  const f = normalizeDir(p);
  if (!f) throw new Error('A file path is required');
  return f;
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  const rank = (e: TreeEntry) => (e.type === 'tree' ? 0 : e.type === 'commit' ? 1 : 2);
  return entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

function parseTreeLine(line: string): TreeEntry | null {
  const m = TREE_LINE.exec(line);
  if (!m) return null;
  const [, mode, objType, oid, size, p] = m;
  const type: TreeEntry['type'] = mode === '160000' ? 'commit' : mode === '120000' ? 'symlink' : objType === 'tree' ? 'tree' : 'blob';
  return { name: baseName(p), path: p, type, mode, oid, size: size === '-' ? undefined : Number(size) };
}

function classify(data: Buffer, filePath: string, size: number): Pick<FileContentResult, 'kind' | 'content' | 'truncated'> {
  const truncated = size > MAX_CONTENT;
  if (IMAGE_EXT.test(filePath)) return { kind: 'image', content: '', truncated };
  const head = data.subarray(0, 8000);
  if (head.includes(0)) return { kind: 'binary', content: '', truncated };
  const text = data.toString('utf8');
  if (text.startsWith(LFS_POINTER)) return { kind: 'lfs', content: text, truncated: false };
  return { kind: 'text', content: text, truncated };
}

/** Pick a file name in `dir` that doesn't exist yet: name.zip, name 2.zip, … */
function uniquePath(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let i = 2; existsSync(candidate); i++) candidate = path.join(dir, `${stem} ${i}${ext}`);
  return candidate;
}

export const filesApi: HandlerModule = (ctx) => {
  const exported = new Set<string>();

  return {
    /** One directory level of the repository, at a revision or in the working copy (rev null). */
    async 'tree.list'({ repo, rev, dir }: { repo: string; rev?: string | null; dir?: string }): Promise<TreeEntry[]> {
      const d = normalizeDir(dir);
      if (rev) {
        assertSafe(rev);
        const args = ['ls-tree', '-z', '--long', '--full-tree', rev];
        if (d) args.push('--', `${d}/`);
        const raw = await git(repo, args);
        return sortEntries(raw.split('\0').filter(Boolean).map(parseTreeLine).filter((e): e is TreeEntry => !!e));
      }
      const abs = d ? insideRepo(repo, d) : repo;
      const dirents = await fs.readdir(abs, { withFileTypes: true });
      const entries: TreeEntry[] = [];
      for (const ent of dirents) {
        if (ent.name === '.git') continue;
        const rel = d ? `${d}/${ent.name}` : ent.name;
        let type: TreeEntry['type'] = 'blob';
        let size: number | undefined;
        if (ent.isSymbolicLink()) type = 'symlink';
        else if (ent.isDirectory()) type = existsSync(path.join(abs, ent.name, '.git')) ? 'commit' : 'tree';
        else if (ent.isFile()) size = (await fs.lstat(path.join(abs, ent.name)).catch(() => null))?.size;
        else continue;
        entries.push({ name: ent.name, path: rel, type, size });
      }
      // Hide ignored files (tracked files are never reported as ignored, which is what we want).
      if (entries.length) {
        const out = await git(repo, ['check-ignore', '-z', '--stdin'], {
          input: entries.map((e) => e.path).join('\0') + '\0',
          okCodes: [1],
        });
        const ignored = new Set(out.split('\0').filter(Boolean));
        return sortEntries(entries.filter((e) => !ignored.has(e.path)));
      }
      return entries;
    },

    /** Every file path, for fuzzy search. */
    async 'files.search'({ repo, rev }: { repo: string; rev?: string | null }): Promise<string[]> {
      if (rev) {
        assertSafe(rev);
        return (await git(repo, ['ls-tree', '-r', '-z', '--name-only', '--full-tree', rev])).split('\0').filter(Boolean);
      }
      const raw = await git(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate']);
      return raw.split('\0').filter(Boolean);
    },

    /** A file's contents at a revision, or in the working copy (rev null). */
    async 'file.content'({ repo, rev, path: p }: { repo: string; rev?: string | null; path: string }): Promise<FileContentResult> {
      const file = normalizeFile(p);
      if (rev) {
        assertSafe(rev);
        const listing = await git(repo, ['ls-tree', '-z', '--long', '--full-tree', rev, '--', file]);
        const entry = listing.split('\0').map(parseTreeLine).find((e) => e?.path === file);
        if (!entry) return { kind: 'missing', content: '', size: 0, truncated: false };
        if (entry.type === 'commit') {
          const config = await git(repo, ['config', '--blob', `${rev}:.gitmodules`, '--get-regexp', '^submodule\\..*\\.(path|url)$'], {
            okCodes: [1],
          }).catch(() => '');
          return { kind: 'submodule', content: '', size: 0, truncated: false, oid: entry.oid, submodule: { commit: entry.oid!, url: submoduleUrl(config, file) } };
        }
        if (entry.type === 'tree') throw new Error(`${file} is a directory`);
        const size = entry.size ?? 0;
        const data = await gitRaw(repo, ['cat-file', 'blob', entry.oid!], { maxBytes: MAX_CONTENT });
        if (entry.type === 'symlink') return { kind: 'symlink', content: data.toString('utf8'), size, truncated: false, oid: entry.oid };
        return { ...classify(data, file, size), size, oid: entry.oid };
      }
      const abs = insideRepo(repo, file);
      const st = await fs.lstat(abs).catch(() => null);
      if (!st) return { kind: 'missing', content: '', size: 0, truncated: false };
      if (st.isSymbolicLink()) return { kind: 'symlink', content: await fs.readlink(abs), size: st.size, truncated: false };
      if (st.isDirectory()) {
        if (!existsSync(path.join(abs, '.git'))) throw new Error(`${file} is a directory`);
        const head = (await git(abs, ['rev-parse', 'HEAD']).catch(() => '')).trim();
        const config = await git(repo, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$'], { okCodes: [1] }).catch(() => '');
        return { kind: 'submodule', content: '', size: 0, truncated: false, submodule: { commit: head, url: submoduleUrl(config, file) } };
      }
      const fh = await fs.open(abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, MAX_CONTENT));
        await fh.read(buf, 0, buf.length, 0);
        return { ...classify(buf, file, st.size), size: st.size };
      } finally {
        await fh.close();
      }
    },

    /** Export a revision (optionally one directory) as a zip archive. Resolves to the saved path, or null if cancelled. */
    async 'archive.export'({ repo, rev, path: sub, name }: { repo: string; rev: string; path?: string; name: string }): Promise<string | null> {
      assertSafe(rev);
      const dir = normalizeDir(sub);
      if (dir) assertSafe(dir);
      const defaultName = `${name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'export'}.zip`;
      const dest = ctx.host.saveFile
        ? await ctx.host.saveFile({ title: 'Export Files', defaultName, filters: [{ name: 'Zip archive', extensions: ['zip'] }] })
        : uniquePath(path.join(os.homedir(), 'Downloads'), defaultName);
      if (!dest) return null;
      const args = ['archive', '--format=zip', '-o', dest, rev];
      if (dir) args.push(dir);
      await git(repo, args);
      exported.add(dest);
      return dest;
    },

    /** Reveal an exported archive (only paths this session created). */
    async 'archive.reveal'({ path: p }: { path: string }) {
      if (!exported.has(p)) throw new Error('Unknown export');
      if (process.platform === 'darwin') await run('open', ['-R', p]);
      else if (process.platform === 'win32') await run('explorer', [`/select,${p}`]);
      else await run('xdg-open', [path.dirname(p)]);
    },

    /** Files changed between two revisions (`from` null = introduced by the root commit `to`). */
    async 'diff.files'({ repo, from, to }: { repo: string; from: string | null; to: string }): Promise<ChangedFile[]> {
      assertSafe(to);
      if (from) assertSafe(from);
      return changedFiles(repo, from, to);
    },
  };
};

function submoduleUrl(config: string, file: string): string | undefined {
  const lines = config.split('\n');
  const pathLine = lines.find((l) => l.endsWith(` ${file}`) && /\.path /.test(l));
  if (!pathLine) return undefined;
  const name = pathLine.slice('submodule.'.length, pathLine.indexOf('.path '));
  return lines.find((l) => l.startsWith(`submodule.${name}.url `))?.split(' ').slice(1).join(' ');
}
