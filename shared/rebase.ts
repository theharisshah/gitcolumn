import type { RebasePlan, RebaseStep } from './types.ts';

/**
 * Merges a rebase recreates: those above (descendants of) a commit the steps change. Merges whose
 * parents stay the same are kept exactly as they are (git fast-forwards over them).
 */
export function affectedMerges(plan: RebasePlan, steps: RebaseStep[]): Set<string> {
  const changed = new Set(steps.filter((s) => s.action !== 'pick').map((s) => s.hash));
  const affected = new Set<string>();
  // plan.commits lists parents before children.
  for (const c of plan.commits) {
    if (changed.has(c.hash) || c.parents.some((p) => affected.has(p))) affected.add(c.hash);
  }
  return new Set(plan.commits.filter((c) => c.parents.length > 1 && affected.has(c.hash) && !changed.has(c.hash)).map((c) => c.hash));
}
