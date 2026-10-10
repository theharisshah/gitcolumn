// The reflog: where HEAD and branches have pointed over time.
import type { ReflogEntry } from '../shared/types.ts';
import type { HandlerModule } from './ctx.ts';
import { git } from './git.ts';
import { FS } from './parse.ts';

const FORMAT = ['%gd', '%H', '%P', '%gs', '%gn', '%ge', '%at', '%s'].join('%x1f');

/** HEAD, refs/heads/<x> or a short branch name. Everything else is rejected. */
async function resolveRef(repo: string, ref: string): Promise<{ full: string; short: string }> {
  if (ref === 'HEAD') return { full: 'HEAD', short: 'HEAD' };
  if (!ref || ref.startsWith('-') || ref.includes('\0') || ref.includes('..')) throw new Error(`Invalid ref: ${ref}`);
  const full = ref.startsWith('refs/heads/') ? ref : `refs/heads/${ref}`;
  const ok = await git(repo, ['show-ref', '--verify', '-q', full]).then(() => true, () => false);
  if (!ok) throw new Error(`No such branch: ${ref}`);
  return { full, short: full.slice('refs/heads/'.length) };
}

export function parseReflog(raw: string, short: string, skip: number): ReflogEntry[] {
  const entries: ReflogEntry[] = [];
  raw
    .split('\0')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .forEach((rec, i) => {
      const [gd, hash, parents, gs, name, email, at, ...subject] = rec.split(FS);
      const time = Number(/\{(\d+)\}$/.exec(gd)?.[1] ?? 0);
      const sep = gs.indexOf(': ');
      entries.push({
        index: skip + i,
        selector: `${short}@{${skip + i}}`,
        hash,
        parents: parents ? parents.split(' ') : [],
        action: sep === -1 ? gs : gs.slice(0, sep),
        detail: sep === -1 ? '' : gs.slice(sep + 2),
        time,
        identity: { name, email },
        authorDate: Number(at),
        subject: subject.join(FS),
      });
    });
  for (let i = 0; i < entries.length - 1; i++) entries[i].previous = entries[i + 1].hash;
  return entries;
}

export const reflogApi: HandlerModule = () => ({
  async 'reflog.list'({
    repo,
    ref = 'HEAD',
    skip = 0,
    limit = 200,
  }: {
    repo: string;
    ref?: string;
    skip?: number;
    limit?: number;
  }): Promise<{ entries: ReflogEntry[]; hasMore: boolean }> {
    const { full, short } = await resolveRef(repo, ref);
    const exists = await git(repo, ['reflog', 'exists', full]).then(() => true, () => false);
    if (!exists) return { entries: [], hasMore: false };
    const n = Math.max(1, Math.min(limit, 2000));
    // --date=unix makes %gd carry the reflog timestamp (there is no %gt); one extra row gives the last entry's previous hash.
    const raw = await git(repo, ['log', '-g', '-z', '--date=unix', `--format=${FORMAT}`, `--skip=${Math.max(0, skip)}`, '-n', String(n + 1), full, '--']);
    const entries = parseReflog(raw, short, Math.max(0, skip));
    const hasMore = entries.length > n;
    return { entries: entries.slice(0, n), hasMore };
  },
});
