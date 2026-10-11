import type { ChangedFile } from '../shared/types.ts';
import { git } from './git.ts';
import { parseNameStatus, parseNumstat } from './parse.ts';

/** Files changed between two revisions (or introduced by a root commit when `from` is null), with line counts. */
export async function changedFiles(repo: string, from: string | null, to: string): Promise<ChangedFile[]> {
  const nameArgs = from
    ? ['diff', '-z', '--name-status', '-M', from, to, '--']
    : ['diff-tree', '-r', '-z', '--root', '--no-commit-id', '--name-status', '-M', to, '--'];
  // "--": a revision named like a file must not be taken for a path (or the other way round).
  const numArgs = from
    ? ['diff', '-z', '--numstat', '-M', from, to, '--']
    : ['diff-tree', '-r', '-z', '--root', '--no-commit-id', '--numstat', '-M', to, '--'];
  const [names, nums] = await Promise.all([git(repo, nameArgs), git(repo, numArgs)]);
  const stats = parseNumstat(nums);
  return parseNameStatus(names).map((f) => ({ ...f, ...stats.get(f.path) }));
}
