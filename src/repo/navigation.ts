// Views and per-tab back/forward navigation. Pure so it can be unit tested.

export type View =
  | { kind: 'working' }
  | { kind: 'history'; ref?: string; label?: string; select?: string; search?: string; scope?: 'all' }
  | { kind: 'stashes'; selected?: string }
  | { kind: 'file'; path: string; mode: 'history' | 'blame'; rev?: string | null; select?: string }
  | { kind: 'files'; rev?: string | null; label?: string; path?: string }
  | { kind: 'reflog'; ref?: string; select?: string }
  | { kind: 'branches'; base?: string }
  | { kind: 'pulls'; state?: 'open' | 'closed' | 'merged'; number?: number }
  | { kind: 'compare'; base: string; head: string; baseLabel?: string; headLabel?: string }
  | { kind: 'settings' };

export type ViewKind = View['kind'];

export interface NavState {
  stack: View[];
  index: number;
}

export const MAX_NAV = 50;

/** Stable identity for a view: same kind and same parameters (undefined fields ignored). */
export function viewKey(v: View): string {
  const entries = Object.entries(v)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(entries);
}

export function navInit(v: View): NavState {
  return { stack: [v], index: 0 };
}

/** Go to a view, dropping any forward history. Navigating to the current view is a no-op. */
export function navPush(s: NavState, v: View): NavState {
  if (viewKey(v) === viewKey(s.stack[s.index])) return s;
  let stack = [...s.stack.slice(0, s.index + 1), v];
  if (stack.length > MAX_NAV) stack = stack.slice(stack.length - MAX_NAV);
  return { stack, index: stack.length - 1 };
}

/** Change the current view in place (e.g. a search refinement) without adding history. */
export function navReplace(s: NavState, v: View): NavState {
  const stack = [...s.stack];
  stack[s.index] = v;
  return { stack, index: s.index };
}

export function navBack(s: NavState): NavState {
  return s.index > 0 ? { stack: s.stack, index: s.index - 1 } : s;
}

export function navForward(s: NavState): NavState {
  return s.index < s.stack.length - 1 ? { stack: s.stack, index: s.index + 1 } : s;
}
