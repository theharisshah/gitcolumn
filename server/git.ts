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
