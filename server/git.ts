import { spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    public readonly code: number | null,
    public readonly stderr: string,
  ) {
    super(message);
  }
}

export interface GitOptions {
  /** Data written to stdin */
  input?: string | Buffer;
  /** Exit codes that should not be treated as failure (0 is always accepted) */
  okCodes?: number[];
  /** Milliseconds before the process is killed */
  timeout?: number;
  /** Stop reading (and kill git) once stdout exceeds this many bytes; the partial output is returned */
  maxBytes?: number;
  /** Extra environment variables for this invocation */
  env?: NodeJS.ProcessEnv;
}

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  // Never block waiting for credentials on a terminal we don't have.
  GIT_TERMINAL_PROMPT: '0',
  // Commands that would open an editor accept the default message instead.
  GIT_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
  // Background status polling shouldn't fight with other git processes over index.lock.
  GIT_OPTIONAL_LOCKS: '0',
  LC_ALL: 'C',
};

/** Merge extra environment into every git invocation (e.g. GIT_ASKPASS from the Electron host). */
export function configureGit(env: NodeJS.ProcessEnv) {
  Object.assign(ENV, env);
}

/** The environment git runs with (including askpass settings), for other tools such as gh. */
export function gitEnv(): NodeJS.ProcessEnv {
  return { ...ENV };
}

const BASE_ARGS = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '-c', 'core.pager=cat'];

/**
 * Run git and resolve with raw stdout. Rejects with GitError on a non-zero exit code.
 * The child runs in its own session (detached) so ssh can't grab the controlling
 * terminal for passphrase prompts and hang forever.
 */
export function gitRaw(cwd: string, args: string[], opts: GitOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...BASE_ARGS, ...args], {
      cwd,
      env: opts.env ? { ...ENV, ...opts.env } : ENV,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeout) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
      }, opts.timeout);
    }
    let bytes = 0;
    let capped = false;
    child.stdout.on('data', (d: Buffer) => {
      if (capped) return;
      out.push(d);
      bytes += d.length;
      if (opts.maxBytes && bytes > opts.maxBytes) {
        capped = true;
        child.kill('SIGTERM');
      }
    });
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      reject(new GitError(`Failed to run git: ${e.message}`, args, null, ''));
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(out);
      const stderr = Buffer.concat(err).toString('utf8');
      if (capped || code === 0 || (code !== null && opts.okCodes?.includes(code))) {
        resolve(stdout);
        return;
      }
      const reason = signal
        ? `git ${args[0]} was terminated (${signal})`
        : cleanError(stderr || stdout.toString('utf8')) || `git ${args[0]} failed with exit code ${code}`;
      reject(new GitError(reason, args, code, stderr));
    });
    child.stdin.on('error', () => {
      /* process may exit before reading stdin */
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** Run git and resolve with stdout decoded as UTF-8. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return (await gitRaw(cwd, args, opts)).toString('utf8');
}

function cleanError(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^(error|fatal): /, ''))
    .filter((l) => l.trim() && !l.startsWith('hint:'))
    .join('\n')
    .trim();
}

/** Another git process holds the index lock. */
export class IndexLockedError extends Error {}

/** git's message when a lock file is held by another process (as opposed to e.g. an unmerged "yarn.lock"). */
export const LOCK_HELD = /Unable to create '[^']*\.lock': File exists/i;

/**
 * `git write-tree`: the index as a tree object, or null when it has unmerged entries.
 * Waits briefly when another git process holds index.lock, then throws IndexLockedError.
 */
export async function writeTree(cwd: string, waitMs = 1500): Promise<string | null> {
  const started = Date.now();
  for (;;) {
    try {
      return (await git(cwd, ['write-tree'])).trim() || null;
    } catch (e) {
      if (!(e instanceof GitError) || !LOCK_HELD.test(`${e.message}\n${e.stderr}`)) return null;
      if (Date.now() - started > waitMs) throw new IndexLockedError('Another git process is using the staging area. Try again in a moment.');
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/**
 * Blob ids of working tree files, hashed without filters (as stored by snapshots).
 * Paths go as arguments (--stdin-paths would C-unquote a path that starts with a double quote),
 * in batches that stay well below command-line length limits (32K characters on Windows).
 */
export async function hashFiles(cwd: string, paths: string[], write = false): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < paths.length; ) {
    const chunk: string[] = [];
    let length = 0;
    while (i < paths.length && (chunk.length === 0 || (length + paths[i].length < 8000 && chunk.length < 200))) {
      length += paths[i].length + 3;
      chunk.push(paths[i++]);
    }
    const out = await git(cwd, ['hash-object', ...(write ? ['-w'] : []), '--no-filters', '--', ...chunk]);
    ids.push(...out.trim().split('\n'));
  }
  return ids;
}
