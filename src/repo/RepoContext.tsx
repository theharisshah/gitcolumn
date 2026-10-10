import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Ref, Remote, RepoInfo, Stash, Status, Submodule } from '../../shared/types';
import { api, type ConflictResult } from '../lib/api';
import { getSetting, onSettingsChange } from '../lib/settings';
import { useUI } from '../ui/UIProvider';

export type View =
  | { kind: 'working' }
  | { kind: 'history'; ref?: string; label?: string; select?: string }
  | { kind: 'stashes'; selected?: string }
  | { kind: 'file'; path: string; mode: 'history' | 'blame'; rev?: string | null; select?: string }
  | { kind: 'settings' };

export interface UndoEntry {
  label: string;
  run: () => Promise<unknown>;
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
  setView(v: View): void;
  currentBranch: Ref | undefined;
  refresh(): Promise<void>;
  /** Called on every background poll, even when nothing changed (for views showing file contents) */
  subscribeTick(cb: () => void): () => void;
  run<T>(label: string, fn: () => Promise<T>, opts?: RunOptions<T>): Promise<T | undefined>;
  undo(): Promise<void>;
  canUndo: boolean;
}

const Ctx = createContext<RepoCtx | null>(null);

export function useRepo(): RepoCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useRepo outside RepoProvider');
  return c;
}

const POLL_MS = 3000;
const MAX_UNDO = 30;

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
  const [view, setView] = useState<View>({ kind: 'working' });
  const [undoCount, setUndoCount] = useState(0);
  const fingerprint = useRef('');
  const busyRef = useRef(false);
  const undoStack = useRef<UndoEntry[]>([]);
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

  const pushUndo = useCallback((entry: UndoEntry) => {
    undoStack.current = [...undoStack.current.slice(-(MAX_UNDO - 1)), entry];
    setUndoCount(undoStack.current.length);
  }, []);

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
          if (entry) pushUndo(entry);
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
    [load, ui, pushUndo],
  );

  const undo = useCallback(async () => {
    const entry = undoStack.current.pop();
    setUndoCount(undoStack.current.length);
    if (!entry) {
      ui.toast('info', 'Nothing to undo');
      return;
    }
    await run(`Undoing ${entry.label}…`, entry.run, { success: `Undid ${entry.label}` });
  }, [run, ui]);
  undoRef.current = undo;

  const currentBranch = useMemo(() => refs.find((r) => r.type === 'head' && r.current), [refs]);
  const canUndo = undoCount > 0;

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
      currentBranch,
      refresh,
      subscribeTick,
      run,
      undo,
      canUndo,
    }),
    [repo, status, refs, remotes, stashes, submodules, version, loading, error, busy, view, currentBranch, refresh, subscribeTick, run, undo, canUndo],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
