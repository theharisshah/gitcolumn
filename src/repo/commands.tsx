import { useMemo } from 'react';
import { api } from '../lib/api';
import { useActions } from './actions';
import { useRepo } from './RepoContext';

export type CommandGroup = 'Navigate' | 'Repository' | 'Branch' | 'Working Copy' | 'History' | 'Stash' | 'GitHub' | 'Edit';

export interface Command {
  id: string;
  title: string;
  group: CommandGroup;
  /** e.g. "mod+shift+f" — see shortcutFromEvent */
  shortcut?: string;
  /** The Electron app menu owns this shortcut (as an accelerator), so the renderer ignores the key */
  menu?: boolean;
  keywords?: string[];
  enabled?: boolean;
  run(): void;
}

/** Normalize a keyboard event to "mod+alt+shift+<key>" (mod = ⌘ on macOS, Ctrl elsewhere). */
export function shortcutFromEvent(e: KeyboardEvent): string | null {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
  if (['meta', 'control', 'shift', 'alt'].includes(key)) return null;
  return ['mod', e.altKey && 'alt', e.shiftKey && 'shift', key].filter(Boolean).join('+');
}

/** Human-readable form of a shortcut for menus and the palette. */
export function formatShortcut(shortcut: string, mac = navigator.platform.toLowerCase().includes('mac')): string {
  const map: Record<string, string> = mac
    ? { mod: '⌘', alt: '⌥', shift: '⇧', enter: '↩', backspace: '⌫' }
    : { mod: 'Ctrl+', alt: 'Alt+', shift: 'Shift+', enter: 'Enter', backspace: 'Backspace' };
  return shortcut
    .split('+')
    .map((p) => map[p] ?? (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)))
    .join('');
}

/** Every command the app offers, for the palette, keyboard shortcuts and the native menu. */
export function useCommands(extra: { openPalette?: () => void } = {}): Command[] {
  const ctx = useRepo();
  const actions = useActions();
  const { setView, back, forward, canGoBack, canGoForward, refresh, status, stashes, repo, undo, undoLabel } = ctx;
  const { openPalette } = extra;

  return useMemo(() => {
    const go = (v: Parameters<typeof setView>[0]) => () => setView(v);
    const list: Command[] = [
      { id: 'nav.back', title: 'Back', group: 'Navigate', shortcut: 'mod+[', menu: true, enabled: canGoBack, run: back },
      { id: 'nav.forward', title: 'Forward', group: 'Navigate', shortcut: 'mod+]', menu: true, enabled: canGoForward, run: forward },
      { id: 'view.working', title: 'Working Copy', group: 'Navigate', shortcut: 'mod+1', menu: true, keywords: ['changes', 'status', 'commit'], run: go({ kind: 'working' }) },
      { id: 'view.history', title: 'History', group: 'Navigate', shortcut: 'mod+2', menu: true, keywords: ['log', 'commits', 'graph'], run: go({ kind: 'history' }) },
      { id: 'view.stashes', title: 'Stashes', group: 'Navigate', shortcut: 'mod+3', menu: true, run: go({ kind: 'stashes' }) },
      { id: 'view.files', title: 'Files', group: 'Navigate', shortcut: 'mod+4', menu: true, keywords: ['browse', 'tree', 'explorer'], run: go({ kind: 'files' }) },
      { id: 'view.pulls', title: 'Pull Requests', group: 'Navigate', shortcut: 'mod+5', menu: true, keywords: ['github', 'pr', 'review'], run: go({ kind: 'pulls' }) },
      { id: 'view.reflog', title: 'Reflog', group: 'Navigate', shortcut: 'mod+6', menu: true, keywords: ['recover', 'lost', 'undo'], run: go({ kind: 'reflog' }) },
      { id: 'view.branches', title: 'Branches Review', group: 'Navigate', shortcut: 'mod+7', menu: true, keywords: ['merged', 'stale', 'cleanup'], run: go({ kind: 'branches' }) },
      { id: 'view.settings', title: 'Settings', group: 'Navigate', shortcut: 'mod+,', menu: true, keywords: ['preferences', 'identity', 'remotes'], run: go({ kind: 'settings' }) },
      { id: 'repo.refresh', title: 'Refresh', group: 'Repository', shortcut: 'mod+r', menu: true, run: () => void refresh() },
      { id: 'repo.fetch', title: 'Fetch', group: 'Repository', shortcut: 'mod+shift+f', menu: true, run: () => void actions.fetch() },
      { id: 'repo.pull', title: 'Pull', group: 'Repository', shortcut: 'mod+shift+l', menu: true, enabled: !!status?.branch, run: () => void actions.pull() },
      { id: 'repo.push', title: 'Push', group: 'Repository', shortcut: 'mod+shift+p', menu: true, enabled: !!status?.branch, run: () => void actions.push() },
      { id: 'repo.reveal', title: 'Show in Finder', group: 'Repository', keywords: ['folder', 'explorer'], run: () => void api.reveal(repo.path).catch(() => undefined) },
      { id: 'repo.terminal', title: 'Open in Terminal', group: 'Repository', keywords: ['shell', 'console'], run: () => void api.openTerminal(repo.path).catch(() => undefined) },
      { id: 'remote.add', title: 'Add Remote…', group: 'Repository', run: () => void actions.addRemote() },
      { id: 'files.export', title: 'Export Files…', group: 'Repository', keywords: ['zip', 'archive'], enabled: !!status?.head, run: () => void actions.exportFiles('HEAD', status?.branch ?? 'HEAD') },
      { id: 'identity.edit', title: 'Set Commit Author…', group: 'Repository', keywords: ['name', 'email', 'identity'], run: () => void actions.editIdentity() },
      { id: 'branch.new', title: 'New Branch…', group: 'Branch', shortcut: 'mod+shift+b', menu: true, enabled: !!status?.head, run: () => void actions.createBranch() },
      { id: 'tag.new', title: 'New Tag…', group: 'Branch', enabled: !!status?.head, run: () => void actions.createTag() },
      { id: 'stash.save', title: 'Stash Changes…', group: 'Stash', shortcut: 'mod+shift+s', menu: true, enabled: !!status?.files.length, run: () => void actions.stashSave() },
      { id: 'stash.pop', title: 'Pop Latest Stash', group: 'Stash', enabled: stashes.length > 0, run: () => stashes[0] && void actions.stashApply(stashes[0], true) },
      { id: 'edit.undo', title: undoLabel ? `Undo ${undoLabel}` : 'Undo', group: 'Edit', shortcut: 'mod+z', menu: true, run: () => void undo() },
    ];
    if (openPalette) {
      list.push({ id: 'palette.open', title: 'Quick Actions…', group: 'Navigate', shortcut: 'mod+shift+a', menu: true, run: openPalette });
      list.push({ id: 'palette.open.k', title: 'Quick Actions…', group: 'Navigate', shortcut: 'mod+k', run: openPalette });
    }
    if (status?.state.merging || status?.state.rebasing || status?.state.cherryPicking || status?.state.reverting) {
      list.push({ id: 'op.continue', title: 'Continue Merge/Rebase', group: 'Repository', run: () => void actions.continueOp() });
      list.push({ id: 'op.abort', title: 'Abort Merge/Rebase…', group: 'Repository', run: () => void actions.abortOp() });
    }
    return list;
  }, [setView, back, forward, canGoBack, canGoForward, refresh, status, stashes, repo.path, undo, undoLabel, actions, openPalette]);
}
