// Interactive rebase of ranges that contain merge commits (git rebase --rebase-merges).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RebasePlan, RebaseStep } from '../shared/types.ts';
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
  const m = /^(?:pick|p)\s+([0-9a-f]+)(.*)$/.exec(t);
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

export interface MergeCheck {
  hash: string;
  /** Recreating it automatically gives conflicts (they were resolved by hand originally) */
  conflicts: boolean;
  /** The merge commit contains changes beyond the automatic merge ("evil merge"); recreating it would lose them */
  evil: boolean;
}

/** Re-merge each merge's parents with `git merge-tree` to see whether git can recreate it as it was. */
export async function checkMerges(repo: string, plan: RebasePlan): Promise<MergeCheck[]> {
  const out: MergeCheck[] = [];
  for (const c of plan.commits) {
    if (c.parents.length !== 2) {
      if (c.parents.length > 2) out.push({ hash: c.hash, conflicts: true, evil: false });
      continue;
    }
    // One line (the tree) when it merges cleanly; with conflicts, the conflicted paths follow (exit code 1).
    const [merged, tree] = await Promise.all([
      git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', c.parents[0], c.parents[1]], { okCodes: [1] }),
      git(repo, ['rev-parse', `${c.hash}^{tree}`]).then((s) => s.trim()),
    ]);
    const lines = merged.trim().split('\n');
    const conflicted = lines.length > 1;
    out.push({ hash: c.hash, conflicts: conflicted, evil: !conflicted && lines[0] !== tree });
  }
  return out;
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
    const checks = await checkMerges(repo, { ...plan, commits: plan.commits.filter((c) => affected.has(c.hash)) });
    const evil = checks.filter((c) => c.evil);
    if (evil.length) {
      throw new Error(
        `The merge ${evil[0].hash.slice(0, 7)} contains changes of its own (beyond merging its parents). Recreating it would lose them, so this rebase isn’t possible.`,
      );
    }
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
