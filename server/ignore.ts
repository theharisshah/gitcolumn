// "Ignore…": add patterns to .gitignore or .git/info/exclude, optionally untracking matching files.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HandlerModule } from './ctx.ts';
import { git } from './git.ts';
import { insideRepo } from './util.ts';

export type IgnoreTarget = 'gitignore' | 'exclude';

/** Escape a literal path for a gitignore pattern (special characters and leading #/!, trailing spaces). */
export function escapeIgnore(p: string): string {
  let out = p.replace(/[\\*?[\]]/g, '\\$&');
  if (/^[#!]/.test(out)) out = '\\' + out;
  return out.replace(/ +$/, (m) => m.replace(/ /g, '\\ '));
}

/** Suggested patterns for a path: the exact file or folder (anchored), all files with its extension, its parent folder. */
export function ignoreSuggestions(p: string, isDir: boolean): { pattern: string; label: string }[] {
  const out: { pattern: string; label: string }[] = [];
  const clean = p.replace(/\/+$/, '');
  out.push({ pattern: `/${escapeIgnore(clean)}${isDir ? '/' : ''}`, label: isDir ? `This folder (${clean}/)` : `This file (${clean})` });
  const base = clean.slice(clean.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (!isDir && dot > 0 && dot < base.length - 1) {
    const ext = base.slice(dot + 1);
    out.push({ pattern: `*.${escapeIgnore(ext)}`, label: `All .${ext} files` });
  }
  const slash = clean.lastIndexOf('/');
  if (slash > 0) out.push({ pattern: `/${escapeIgnore(clean.slice(0, slash))}/`, label: `The folder ${clean.slice(0, slash)}/` });
  return out;
}

/** Append patterns that aren't already present, keeping the file's trailing newline convention. */
export function appendPatterns(text: string, patterns: string[]): string {
  const existing = new Set(text.split(/\r?\n/).map((l) => l.trim()));
  const add = patterns.map((p) => p.trim()).filter((p) => p && !existing.has(p));
  if (!add.length) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const sep = text && !text.endsWith('\n') ? eol : '';
  return text + sep + add.join(eol) + eol;
}

/** Where the patterns go: the shared .gitignore at the root, or this clone's info/exclude (common to all worktrees). */
export async function ignoreFile(repo: string, target: IgnoreTarget): Promise<string> {
  if (target === 'gitignore') return path.join(repo, '.gitignore');
  if (target !== 'exclude') throw new Error(`Unknown ignore file: ${target}`);
  return path.resolve(repo, (await git(repo, ['rev-parse', '--git-path', 'info/exclude'])).trim());
}

const MAX_IGNORE_FILE = 1024 * 1024;

export const ignoreApi: HandlerModule = () => {
  const targetFile = ignoreFile;

  return {
    /** What the Ignore dialog needs to know about a path. */
    async 'ignore.info'({ repo, path: rel }: { repo: string; path: string }) {
      const abs = insideRepo(repo, rel);
      const st = await fs.lstat(abs).catch(() => null);
      const tracked = (await git(repo, ['ls-files', '-z', '--', `:(literal)${rel}`])).length > 0;
      const isDir = !!st?.isDirectory();
      return { isDir, tracked, suggestions: ignoreSuggestions(rel, isDir) };
    },

    /** Content of the ignore file before and after, so the change can be undone exactly. */
    async 'ignore.add'({
      repo,
      patterns,
      target,
      untrack,
    }: {
      repo: string;
      patterns: string[];
      target: IgnoreTarget;
      /** Paths to stop tracking (kept on disk) */
      untrack?: string[];
    }): Promise<{ file: IgnoreTarget; before: string | null; after: string }> {
      if (!Array.isArray(patterns) || !patterns.length || patterns.some((p) => typeof p !== 'string' || /[\r\n]/.test(p))) {
        throw new Error('Invalid ignore pattern');
      }
      const file = await targetFile(repo, target);
      if (target === 'gitignore' && (await fs.lstat(file).catch(() => null))?.isSymbolicLink()) {
        throw new Error('.gitignore is a symbolic link; edit it directly.');
      }
      const before = await fs.readFile(file, 'utf8').catch(() => null);
      if (before && before.length > MAX_IGNORE_FILE) throw new Error('The ignore file is too large to edit here.');
      const after = appendPatterns(before ?? '', patterns);
      if (after !== (before ?? '')) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, after);
      }
      if (untrack?.length) {
        untrack.forEach((p) => insideRepo(repo, p));
        await git(repo, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          input: untrack.map((p) => `:(literal)${p}`).join('\0') + '\0',
        });
      }
      return { file: target, before, after };
    },
  };
};
