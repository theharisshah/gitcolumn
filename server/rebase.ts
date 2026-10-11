// Interactive rebase of ranges that contain merge commits (git rebase --rebase-merges).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RebaseMergeCheck, RebasePlan, RebaseStep } from '../shared/types.ts';
import { affectedMerges } from '../shared/rebase.ts';
import { git } from './git.ts';
import { shellQuote } from './util.ts';

/**
 * The sequence editor git runs on its --rebase-merges todo list. It only changes the verbs of
 * `pick` lines (and adds an `exec` after rewords); label/reset/merge/update-ref lines stay as git
 * wrote them, so the branch structure and merges are recreated. A squash/fixup must directly follow
 * a commit in the same branch; otherwise it writes an empty todo (git then aborts and restores the
 * autostash) and explains why in the error file.
 */
const TRANSFORM = String.raw`
const fs = require('fs');
const [specPath, todoPath] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const fail = (message) => {
  fs.writeFileSync(spec.errorFile, message);
  fs.writeFileSync(todoPath, '');
  process.exit(0);
};
const out = [];
const seen = new Set();
let afterCommit = false;
for (const line of fs.readFileSync(todoPath, 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) { out.push(line); continue; }
  // [\s\S]: a subject can contain a bare CR or U+2028, which '.' doesn't match.
  const m = /^(?:pick|p)\s+([0-9a-f]+)([\s\S]*)$/.exec(t);
  if (!m) {
    out.push(line);
    afterCommit = false; // label, reset, merge, update-ref…: a squash can't reach across these
    continue;
  }
  const matches = spec.steps.filter((s) => s.hash.startsWith(m[1]));
  if (matches.length !== 1) fail('The rebase list contained a commit that wasn\'t planned: ' + m[1]);
  const step = matches[0];
  seen.add(step.hash);
  if (step.action === 'drop') { out.push('drop ' + m[1] + m[2]); continue; }
  if (step.action === 'squash' || step.action === 'fixup') {
    if (!afterCommit) fail(step.hash.slice(0, 7) + ' can\'t be combined with the commit above it: in this history it starts a branch or follows a merge.');
    out.push(step.action + ' ' + m[1] + m[2]);
  } else {
    out.push((step.action === 'edit' ? 'edit ' : 'pick ') + m[1] + m[2]);
  }
  if (step.exec) out.push('exec ' + step.exec);
  afterCommit = true;
}
const missing = spec.steps.filter((s) => !s.merge && !seen.has(s.hash));
if (missing.length) fail('git left out ' + missing.length + ' of the planned commits; nothing was changed.');
fs.writeFileSync(todoPath, out.join('\n'));
`;

/** Identity for the scratch commits an octopus check creates (they're never referenced). */
const SCRATCH_IDENT = {
  GIT_AUTHOR_NAME: 'gitcolumn',
  GIT_AUTHOR_EMAIL: 'gitcolumn@localhost',
  GIT_COMMITTER_NAME: 'gitcolumn',
  GIT_COMMITTER_EMAIL: 'gitcolumn@localhost',
};

/** `git merge-tree` of two commits: the resulting tree (with conflict markers) and the conflicted paths. */
async function mergeTree(repo: string, a: string, b: string): Promise<{ tree: string; conflicted: string[] }> {
  // One line (the tree) when it merges cleanly; with conflicts, the conflicted paths follow (exit code 1).
  const out = await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '--allow-unrelated-histories', a, b], { okCodes: [1] });
  const [tree, ...paths] = out.trim().split('\n');
  return { tree, conflicted: paths.filter(Boolean) };
}

/**
 * Re-merge one merge's parents the way `git rebase --rebase-merges` will, and compare the result
 * with the merge as it is. An octopus is merged one parent at a time, like git's octopus strategy.
 */
async function checkMerge(repo: string, hash: string, parents: string[]): Promise<RebaseMergeCheck> {
  try {
    let head = parents[0];
    let result = { tree: '', conflicted: [] as string[] };
    const conflicted = new Set<string>();
    for (const [i, p] of parents.slice(1).entries()) {
      result = await mergeTree(repo, head, p);
      result.conflicted.forEach((f) => conflicted.add(f));
      if (i < parents.length - 2) {
        // A dangling scratch commit, so the next merge-tree finds the right merge base.
        const args = ['commit-tree', result.tree, ...parents.slice(0, i + 2).flatMap((x) => ['-p', x]), '-m', 'gitcolumn merge check'];
        head = (await git(repo, args, { env: SCRATCH_IDENT })).trim();
      }
    }
    // Paths that differ from the merge as committed. Conflicted ones were resolved by hand, and the
    // user resolves them again; anything else would silently change ("evil merge").
    const changed = (await git(repo, ['diff-tree', '-r', '--name-only', '--no-renames', '-z', result.tree, `${hash}^{tree}`]))
      .split('\0')
      .filter(Boolean);
    const lost = changed.filter((f) => !conflicted.has(f));
    return { hash, conflicts: conflicted.size > 0, evil: lost.length > 0, ...(lost.length ? { paths: lost.slice(0, 5) } : {}) };
  } catch (e) {
    const why = e instanceof Error ? e.message.split('\n')[0] : String(e);
    return { hash, conflicts: false, evil: false, unverifiable: why || 'git couldn’t re-merge its parents' };
  }
}

/** Check whether git can recreate each merge in the plan as it was (a few at a time). */
export async function checkMerges(repo: string, plan: RebasePlan, only?: Set<string>): Promise<RebaseMergeCheck[]> {
  const merges = plan.commits.filter((c) => c.parents.length > 1 && (!only || only.has(c.hash)));
  const out: RebaseMergeCheck[] = new Array(merges.length);
  let next = 0;
  const worker = async () => {
    while (next < merges.length) {
      const i = next++;
      out[i] = await checkMerge(repo, merges[i].hash, merges[i].parents);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, merges.length) }, worker));
  return out;
}

/** Why recreating these merges would lose something, or null when it's safe. */
export function mergeProblem(checks: RebaseMergeCheck[]): string | null {
  const evil = checks.find((c) => c.evil);
  if (evil) {
    const files = evil.paths?.length ? ` (${evil.paths.join(', ')})` : '';
    return `The merge ${evil.hash.slice(0, 7)} contains changes of its own${files}, beyond merging its parents. Recreating it would lose them, so this rebase isn’t possible.`;
  }
  const unknown = checks.find((c) => c.unverifiable);
  if (unknown) return `The merge ${unknown.hash.slice(0, 7)} can’t be checked (${unknown.unverifiable}), so it isn’t safe to recreate it.`;
  return null;
}

/**
 * Run an interactive rebase over a range with merges. Reordering and changing merge commits are
 * refused (the steps must list the plan's commits in order, merges as 'pick').
 */
export async function rebaseWithMerges(opts: {
  repo: string;
  base: string | null;
  steps: RebaseStep[];
  plan: RebasePlan;
  gitDir: string;
  withConflicts: (run: () => Promise<unknown>) => Promise<{ conflicts: boolean; message?: string }>;
  isRebasing: () => Promise<boolean>;
}): Promise<{ conflicts: boolean; paused: boolean; message?: string }> {
  const { repo, base, steps, plan } = opts;
  if (steps.some((s, i) => s.hash !== plan.commits[i]?.hash) || steps.length !== plan.commits.length) {
    throw new Error('Commits can’t be reordered in a range that contains merges.');
  }
  const merges = new Set(plan.commits.filter((c) => c.parents.length > 1).map((c) => c.hash));
  if (steps.some((s) => merges.has(s.hash) && s.action !== 'pick')) throw new Error('Merge commits can only be kept as they are.');
  const affected = affectedMerges(plan, steps);
  if (affected.size) {
    const problem = mergeProblem(await checkMerges(repo, plan, affected));
    if (problem) throw new Error(problem);
  }

  const dir = path.join(opts.gitDir, 'gitcolumn-rebase');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const specSteps = [];
  for (const [i, s] of steps.entries()) {
    let exec: string | undefined;
    if (s.action === 'reword' && s.message?.trim()) {
      const msgFile = path.join(dir, `message-${i}.txt`);
      await fs.writeFile(msgFile, s.message.trim() + '\n');
      exec = `git commit --amend --allow-empty --quiet --cleanup=whitespace -F ${shellQuote(msgFile)}`;
    }
    specSteps.push({ hash: s.hash, action: s.action === 'reword' ? 'pick' : s.action, exec, merge: merges.has(s.hash) });
  }
  const errorFile = path.join(dir, 'transform-error.txt');
  const specFile = path.join(dir, 'spec.json');
  const script = path.join(dir, 'transform.cjs');
  await fs.writeFile(specFile, JSON.stringify({ steps: specSteps, errorFile }));
  await fs.writeFile(script, TRANSFORM);
  // In Electron, execPath is the app; ELECTRON_RUN_AS_NODE makes it behave as plain node.
  const editor = `${shellQuote(process.execPath)} ${shellQuote(script)} ${shellQuote(specFile)}`;
  const result = await opts
    .withConflicts(() =>
      git(repo, ['rebase', '-i', '--rebase-merges', '--reapply-cherry-picks', '--no-autosquash', '--autostash', base ?? '--root'], {
        env: { GIT_SEQUENCE_EDITOR: editor, ELECTRON_RUN_AS_NODE: '1' },
      }),
    )
    .catch(async (e) => {
      const why = await fs.readFile(errorFile, 'utf8').catch(() => '');
      if (why) throw new Error(why);
      throw e;
    });
  const why = await fs.readFile(errorFile, 'utf8').catch(() => '');
  if (why) throw new Error(why);
  return { ...result, paused: !result.conflicts && (await opts.isRebasing()) };
}
