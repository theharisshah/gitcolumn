import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Ref, Remote, RepoInfo, Stash, Status, Submodule, UndoSpec, UndoState } from '../../shared/types';
import { api, type ConflictResult } from '../lib/api';
import { draftFromMessage, saveDraft } from '../lib/draft';
import { getSetting, onSettingsChange } from '../lib/settings';
import { useUI } from '../ui/UIProvider';
import { navBack, navForward, navInit, navPush, navReplace, type NavState, type View } from './navigation';

export type { View } from './navigation';

export interface ViewMemo {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

/** How to undo an operation; persisted per repository so it survives restarts. */
export interface UndoEntry {
  label: string;
  spec: UndoSpec;
}

export interface RunOptions<T> {
  /** Toast shown on success */
  success?: string | ((result: T) => string | undefined);
  /** Skip the refresh afterwards */
  noRefresh?: boolean;
  /** Build an undo entry once the operation succeeded */
  undo?: (result: T) => Promise<UndoEntry | null | undefined> | UndoEntry | null | undefined;
}

export interface RepoCtx {
  repo: RepoInfo;
  status: Status | null;
  refs: Ref[];
  remotes: Remote[];
  stashes: Stash[];
  submodules: Submodule[];
  /** Bumped whenever repository data changes; views use it to reload derived data */
  version: number;
  loading: boolean;
  error: string | null;
  busy: string | null;
  view: View;
  /** Navigate to a view (adds a back-history entry unless `replace`). Stable identity. */
  setView(v: View, opts?: { replace?: boolean }): void;
  back(): void;
  forward(): void;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Leave the current view: back if possible, otherwise to the Working Copy. */
  closeView(): void;
  /** Per-tab scratch memory for views (selection, expanded folders) that survives unmounting. */
  viewMemo: ViewMemo;
  currentBranch: Ref | undefined;
  refresh(): Promise<void>;
  /** Called on every background poll, even when nothing changed (for views showing file contents) */
  subscribeTick(cb: () => void): () => void;
  run<T>(label: string, fn: () => Promise<T>, opts?: RunOptions<T>): Promise<T | undefined>;
  undo(): Promise<void>;
  canUndo: boolean;
  /** Label of the operation ⌘Z would undo */
  undoLabel: string | null;
}

const Ctx = createContext<RepoCtx | null>(null);

export function useRepo(): RepoCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useRepo outside RepoProvider');
  return c;
}

const POLL_MS = 3000;

export function RepoProvider({ repo, active = true, children }: { repo: RepoInfo; active?: boolean; children: ReactNode }) {
  const ui = useUI();
  const [status, setStatus] = useState<Status | null>(null);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [remotes, setRemotes] = useState<Remote[]>([]);
  const [stashes, setStashes] = useState<Stash[]>([]);
  const [submodules, setSubmodules] = useState<Submodule[]>([]);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [nav, setNav] = useState<NavState>(() => navInit({ kind: 'working' }));
  const view = nav.stack[nav.index];
  const setView = useCallback(
    (v: View, opts?: { replace?: boolean }) => setNav((s) => (opts?.replace ? navReplace(s, v) : navPush(s, v))),
    [],
  );
  const back = useCallback(() => setNav(navBack), []);
  const forward = useCallback(() => setNav(navForward), []);
  const closeView = useCallback(() => setNav((s) => (s.index > 0 ? navBack(s) : navPush(s, { kind: 'working' }))), []);
  const viewMemo = useMemo<ViewMemo>(() => {
    const store = new Map<string, unknown>();
    return { get: <T,>(key: string) => store.get(key) as T | undefined, set: (key, value) => void store.set(key, value) };
  }, []);
  const canGoBack = nav.index > 0;
  const canGoForward = nav.index < nav.stack.length - 1;
  const [undoState, setUndoState] = useState<UndoState>({ count: 0, top: null });
  const fingerprint = useRef('');
  const busyRef = useRef(false);
  const tickListeners = useRef(new Set<() => void>());
  const subscribeTick = useCallback((cb: () => void) => {
    tickListeners.current.add(cb);
    return () => {
      tickListeners.current.delete(cb);
    };
  }, []);

  const load = useCallback(
    async (force: boolean) => {
      try {
        const [s, r, rm, st] = await Promise.all([api.status(repo.path), api.refs(repo.path), api.remotes(repo.path), api.stashes(repo.path)]);
        const fp = JSON.stringify([s, r, rm, st]);
        setError(null);
        if (!force && fp === fingerprint.current) return;
        fingerprint.current = fp;
        setStatus(s);
        setRefs(r);
        setRemotes(rm);
        setStashes(st);
        setVersion((v) => v + 1);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [repo.path],
  );

  const refresh = useCallback(() => load(true), [load]);

  useEffect(() => {
    if (!active) return;
    load(true);
    const poll = () => {
      if (document.visibilityState === 'visible' && !busyRef.current) {
        load(false);
        tickListeners.current.forEach((cb) => cb());
      }
    };
    const timer = setInterval(poll, POLL_MS);
    window.addEventListener('focus', poll);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', poll);
    };
  }, [load, active]);

  // Submodule status is comparatively expensive, so only refresh it when the repository changed.
  useEffect(() => {
    if (!active || !version) return;
    let cancelled = false;
    api
      .submodules(repo.path)
      .then((s) => !cancelled && setSubmodules((prev) => (JSON.stringify(prev) === JSON.stringify(s) ? prev : s)))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repo.path, version, active]);

  // Background fetch on an interval chosen in Settings.
  const [autoFetch, setAutoFetch] = useState(() => getSetting('autoFetchMinutes'));
  useEffect(() => onSettingsChange(() => setAutoFetch(getSetting('autoFetchMinutes'))), []);
  const hasRemotes = remotes.length > 0;
  useEffect(() => {
    if (!active || !autoFetch || !hasRemotes) return;
    const timer = setInterval(async () => {
      if (busyRef.current || document.visibilityState !== 'visible') return;
      try {
        await api.fetch(repo.path, undefined, true);
        await load(false);
      } catch {
        /* background fetch failures are not worth interrupting for */
      }
    }, autoFetch * 60_000);
    return () => clearInterval(timer);
  }, [active, autoFetch, hasRemotes, repo.path, load]);

  const loadUndo = useCallback(() => api.undoState(repo.path).then(setUndoState, () => undefined), [repo.path]);
  useEffect(() => void loadUndo(), [loadUndo]);

  const undoRef = useRef<() => Promise<void>>(async () => undefined);

  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>, opts: RunOptions<T> = {}): Promise<T | undefined> => {
      busyRef.current = true;
      setBusy(label);
      try {
        const result = await fn();
        const cr = result as unknown as ConflictResult | undefined;
        let entry: UndoEntry | null | undefined = null;
        if (opts.undo) {
          try {
            entry = await opts.undo(result);
          } catch {
            entry = null;
          }
          if (entry) {
            try {
              setUndoState(await api.undoPush(repo.path, entry.label, entry.spec));
            } catch {
              entry = null;
            }
          }
        }
        if (cr && typeof cr === 'object' && 'conflicts' in cr && cr.conflicts) {
          ui.toast('warning', 'Conflicts need to be resolved', 'Resolve the conflicted files in the Working Copy, then continue.');
          setView({ kind: 'working' });
        } else if (opts.success) {
          const msg = typeof opts.success === 'function' ? opts.success(result) : opts.success;
          if (msg) ui.toast('success', msg, undefined, entry ? { label: 'Undo', onClick: () => undoRef.current() } : undefined);
        }
        return result;
      } catch (e) {
        ui.toast('error', `${label.replace(/…$/, '')} failed`, e instanceof Error ? e.message : String(e));
        return undefined;
      } finally {
        busyRef.current = false;
        setBusy(null);
        if (!opts.noRefresh) await load(true);
      }
    },
    [load, ui, repo.path, setView],
  );

  const undo = useCallback(async () => {
    const state = await api.undoState(repo.path).catch(() => null);
    if (state) setUndoState(state);
    if (!state?.top) {
      ui.toast('info', 'Nothing to undo');
      return;
    }
    const result = await run(`Undoing ${state.top.label}…`, () => api.undoRun(repo.path), { success: (r) => `Undid ${r.label}` });
    if (result?.restoreMessage) {
      // Saved first so the composer picks it up even if it isn't mounted right now.
      saveDraft(repo.path, draftFromMessage(result.restoreMessage));
      window.dispatchEvent(new CustomEvent('gitcolumn:restore-message', { detail: { repo: repo.path, message: result.restoreMessage } }));
    }
    await loadUndo();
  }, [run, ui, repo.path, loadUndo]);
  undoRef.current = undo;

  const currentBranch = useMemo(() => refs.find((r) => r.type === 'head' && r.current), [refs]);
  const canUndo = undoState.count > 0;
  const undoLabel = undoState.top?.label ?? null;

  const value = useMemo<RepoCtx>(
    () => ({
      repo,
      status,
      refs,
      remotes,
      stashes,
      submodules,
      version,
      loading,
      error,
      busy,
      view,
      setView,
      back,
      forward,
      canGoBack,
      canGoForward,
      closeView,
      viewMemo,
      currentBranch,
      refresh,
      subscribeTick,
      run,
      undo,
      canUndo,
      undoLabel,
    }),
    [
      repo,
      status,
      refs,
      remotes,
      stashes,
      submodules,
      version,
      loading,
      error,
      busy,
      view,
      setView,
      back,
      forward,
      canGoBack,
      canGoForward,
      closeView,
      viewMemo,
      currentBranch,
      refresh,
      subscribeTick,
      run,
      undo,
      canUndo,
      undoLabel,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
