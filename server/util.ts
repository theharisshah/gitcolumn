// Helpers shared by the API handler modules.
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NETWORK_TIMEOUT = 10 * 60_000;
export const MAX_DIFF_BYTES = 30 * 1024 * 1024;

export function assertSafe(value: string) {
  if (typeof value !== 'string' || !value || value.startsWith('-') || value.includes('\0')) {
    throw new Error(`Invalid name: ${value}`);
  }
}

export function assertHash(value: string) {
  if (!/^[0-9a-f]{7,64}$/.test(value)) throw new Error(`Invalid object id: ${value}`);
}

export function assertRef(ref: string) {
  if (!/^refs\/(heads|tags)\/[^\0]+$/.test(ref) || ref.includes('..')) throw new Error(`Invalid ref: ${ref}`);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

export function mimeType(p: string): string {
  return MIME[p.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

export function assertStash(ref: string) {
  if (!/^stash@\{\d+\}$/.test(ref)) throw new Error(`Invalid stash: ${ref}`);
}

export function insideRepo(repo: string, rel: string): string {
  const abs = path.resolve(repo, rel);
  if (abs !== repo && !abs.startsWith(repo + path.sep)) throw new Error(`Path is outside the repository: ${rel}`);
  return abs;
}

/**
 * A working tree path that is safe to write: inside the repository, not inside .git, and with no
 * symbolic link anywhere below the repository root (a write would follow it to another place).
 */
export async function writablePath(repo: string, rel: string): Promise<string> {
  const abs = insideRepo(repo, rel);
  const segments = path.relative(repo, abs).split(path.sep).filter(Boolean);
  if (segments.some((s) => s.toLowerCase() === '.git')) throw new Error(`Refusing to write inside .git: ${rel}`);
  let current = repo;
  for (const segment of segments) {
    current = path.join(current, segment);
    const st = await fs.lstat(current).catch(() => null);
    if (!st) break; // the rest doesn't exist yet and will be created
    if (st.isSymbolicLink()) throw new Error(`Refusing to write through a symbolic link: ${path.relative(repo, current)}`);
  }
  return abs;
}

export function expandHome(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

export async function readText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function stripComments(msg: string): string {
  return msg
    .split('\n')
    .filter((l) => !l.startsWith('#'))
    .join('\n')
    .trim();
}

export function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
  });
}

/** Run a program and capture its output (used for non-git tools such as the GitHub CLI). */
export function execCapture(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: '', error: e as NodeJS.ErrnoException });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = opts.timeout ? setTimeout(() => child.kill('SIGTERM'), opts.timeout) : undefined;
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: '', error: e });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input ?? '');
  });
}
