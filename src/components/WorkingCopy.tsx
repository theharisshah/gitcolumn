import { AlertTriangle, Check, FolderOpen, Minus, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileDiff, FileStatus, LineSelection, PatchAction } from '../../shared/types';
import { api } from '../lib/api';
import { basename, copyText, dirname, modKey, plural } from '../lib/format';
import { useActions } from '../repo/actions';
import { useRepo } from '../repo/RepoContext';
import { useUI, type MenuItem } from '../ui/UIProvider';
import { CommitComposer } from './CommitComposer';
import { ConflictView } from './ConflictView';
import { DiffView } from './DiffView';
import { Splitter, usePersistentSize } from './Splitter';
import { StatusBadge, primaryStatus } from './StatusBadge';

type StageState = 'full' | 'partial' | 'none' | 'conflict';

export function stageState(f: FileStatus): StageState {
  if (f.conflicted) return 'conflict';
  if (f.untracked) return 'none';
  const staged = f.index !== '.';
  const unstaged = f.worktree !== '.';
  if (staged && unstaged) return 'partial';
  return staged ? 'full' : 'none';
}

/** Unique row id: a path can appear twice (staged deletion + untracked file of the same name). */
const keyOf = (f: FileStatus) => (f.untracked ? `?${f.path}` : f.path);

const pathsOf = (files: FileStatus[]) => files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));

export function WorkingCopy() {
  const { repo, status, run, subscribeTick, version } = useRepo();
  const ui = useUI();
  const actions = useActions();
  const [width, setWidth] = usePersistentSize('wc.list', 380);
  const [selected, setSelected] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const files = useMemo(() => {
    const all = status?.files ?? [];
    const conflicts = all.filter((f) => f.conflicted).sort((a, b) => a.path.localeCompare(b.path));
    const rest = all.filter((f) => !f.conflicted).sort((a, b) => a.path.localeCompare(b.path));
    return [...conflicts, ...rest];
  }, [status]);

  // Keep the selection valid; select the first file by default.
  useEffect(() => {
    setSelected((sel) => {
      const valid = sel.filter((p) => files.some((f) => keyOf(f) === p));
      if (valid.length) return valid.length === sel.length ? sel : valid;
      return files.length ? [keyOf(files[0])] : [];
    });
  }, [files]);

  const selectedFiles = files.filter((f) => selected.includes(keyOf(f)));
  const current = selectedFiles.length === 1 ? selectedFiles[0] : null;

  const stagedCount = files.filter((f) => !f.conflicted && f.index !== '.').length;
  const allState: StageState = !files.length
    ? 'none'
    : files.every((f) => stageState(f) === 'full')
      ? 'full'
      : stagedCount
        ? 'partial'
        : 'none';

  const toggleStage = useCallback(
    (targets: FileStatus[]) => {
      const stageable = targets.filter((f) => !f.conflicted);
      if (!stageable.length) return;
      const allStaged = stageable.every((f) => stageState(f) === 'full');
      if (allStaged) actions.unstage(pathsOf(stageable));
      else actions.stage(pathsOf(stageable));
    },
    [actions],
  );

  const onRowClick = (e: React.MouseEvent, f: FileStatus) => {
    if (e.metaKey || e.ctrlKey) {
      setSelected((sel) => (sel.includes(keyOf(f)) ? sel.filter((p) => p !== keyOf(f)) : [...sel, keyOf(f)]));
      anchor.current = keyOf(f);
    } else if (e.shiftKey && anchor.current) {
      const a = files.findIndex((x) => keyOf(x) === anchor.current);
      const b = files.findIndex((x) => keyOf(x) === keyOf(f));
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSelected(files.slice(lo, hi + 1).map((x) => keyOf(x)));
    } else {
      setSelected([keyOf(f)]);
      anchor.current = keyOf(f);
    }
  };

  const fileMenu = (e: React.MouseEvent, f: FileStatus) => {
    const targets = selected.includes(keyOf(f)) ? selectedFiles : [f];
    if (!selected.includes(keyOf(f))) setSelected([keyOf(f)]);
    const single = targets.length === 1 ? targets[0] : null;
    const items: MenuItem[] = [];
    const canStage = targets.some((t) => !t.conflicted && stageState(t) !== 'full');
    const canUnstage = targets.some((t) => !t.conflicted && t.index !== '.');
    if (canStage) items.push({ label: targets.length > 1 ? `Stage ${targets.length} Files` : 'Stage', onClick: () => actions.stage(pathsOf(targets.filter((t) => !t.conflicted))) });
    if (canUnstage) items.push({ label: targets.length > 1 ? `Unstage ${targets.length} Files` : 'Unstage', onClick: () => actions.unstage(pathsOf(targets.filter((t) => t.index !== '.'))) });
    if (targets.some((t) => t.conflicted)) {
      items.push('separator', { header: 'Resolve Conflict' });
      items.push({ label: 'Mark as Resolved', onClick: () => run('Marking resolved…', () => api.stage(repo.path, targets.map((t) => t.path))) });
      items.push({ label: 'Resolve Using Mine (ours)', onClick: () => run('Resolving…', async () => { for (const t of targets) await api.resolveConflict(repo.path, t.path, 'ours', t.conflictType); }) });
      items.push({ label: 'Resolve Using Theirs', onClick: () => run('Resolving…', async () => { for (const t of targets) await api.resolveConflict(repo.path, t.path, 'theirs', t.conflictType); }) });
    }
    items.push('separator');
    items.push({ label: targets.length > 1 ? `Discard Changes in ${targets.length} Files…` : 'Discard Changes…', danger: true, icon: <Undo2 size={14} />, onClick: () => actions.discard(targets) });
    if (single) {
      items.push('separator');
      if (!single.untracked && !(single.index === 'A' && single.worktree === '.')) {
        items.push({ label: 'Show File History', onClick: () => actions.showFileHistory(single.path) });
        items.push({ label: 'Blame', onClick: () => actions.blame(single.path) });
      }
      items.push({ label: 'Reveal in Finder', icon: <FolderOpen size={14} />, onClick: () => api.reveal(repo.path, single.path).catch((err) => ui.toast('error', 'Could not reveal file', String(err))) });
      items.push({ label: 'Open with Default App', onClick: () => api.openPath(repo.path, single.path).catch((err) => ui.toast('error', 'Could not open file', String(err))) });
      items.push({ label: 'Copy Path', onClick: () => copyText(single.path) });
    }
    ui.menu(e, items);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!files.length) return;
    const idx = files.findIndex((f) => keyOf(f) === (anchor.current ?? selected[0]));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = files[Math.max(0, Math.min(files.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
      setSelected([keyOf(next)]);
      anchor.current = keyOf(next);
      listRef.current?.querySelector(`[data-key="${CSS.escape(keyOf(next))}"]`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === ' ') {
      e.preventDefault();
      toggleStage(selectedFiles);
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      actions.discard(selectedFiles);
    } else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setSelected(files.map((f) => keyOf(f)));
    }
  };

  return (
    <div className="working-copy">
      <div className="wc-list-pane" style={{ width }}>
        <div className="pane-header wc-list-header">
          <Checkbox
            state={allState}
            disabled={!files.length || files.every((f) => f.conflicted)}
            onClick={() => (allState === 'full' ? actions.unstageAll() : actions.stageAll())}
            title={allState === 'full' ? 'Unstage all' : 'Stage all'}
          />
          <span className="pane-title">
            {files.length ? plural(files.length, 'changed file') : 'No changes'}
            {stagedCount > 0 && <span className="muted"> · {stagedCount} staged</span>}
          </span>
        </div>
        <div className="file-list" tabIndex={0} ref={listRef} onKeyDown={onKeyDown}>
          {files.map((f) => {
            const st = stageState(f);
            const isSel = selected.includes(keyOf(f));
            return (
              <div
                key={keyOf(f)}
                data-key={keyOf(f)}
                className={`file-row ${isSel ? 'selected' : ''} ${f.conflicted ? 'conflicted' : ''}`}
                onMouseDown={(e) => {
                  if (e.button === 0) onRowClick(e, f);
                }}
                onContextMenu={(e) => fileMenu(e, f)}
                onDoubleClick={() => toggleStage([f])}
              >
                <Checkbox
                  state={st}
                  disabled={f.conflicted}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleStage(isSel ? selectedFiles : [f]);
                  }}
                />
                <StatusBadge status={primaryStatus(f)} />
                <span className="file-name" title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}>
                  {basename(f.path)}
                  <span className="file-dir">{dirname(f.path)}</span>
                </span>
              </div>
            );
          })}
          {!files.length && status && (
            <div className="empty-state small">
              <Check size={28} strokeWidth={1.5} />
              <div>Working copy is clean</div>
            </div>
          )}
        </div>
        <CommitComposer stagedCount={stagedCount} totalCount={files.length} />
      </div>
      <Splitter value={width} onChange={setWidth} min={260} max={700} />
      <div className="wc-diff-pane">
        {current ? (
          current.conflicted ? (
            <ConflictView key={keyOf(current)} file={current} />
          ) : (
            <WorkingFileDiff key={keyOf(current)} file={current} version={version} subscribeTick={subscribeTick} />
          )
        ) : selectedFiles.length > 1 ? (
          <div className="empty-state">
            <div className="empty-title">{selectedFiles.length} files selected</div>
            <div className="empty-actions">
              <button className="button" onClick={() => toggleStage(selectedFiles)}>
                {selectedFiles.every((f) => stageState(f) === 'full') ? 'Unstage' : 'Stage'} Selected
              </button>
              <button className="button button-danger-outline" onClick={() => actions.discard(selectedFiles)}>
                Discard Selected…
              </button>
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-title">{files.length ? 'Select a file to see its changes' : 'Nothing to commit'}</div>
            <div className="muted">
              {files.length ? `Use ↑ ↓ to move, Space to stage, ${modKey}⌫ to discard` : 'Edit files in this repository and they will appear here.'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Checkbox({
  state,
  onClick,
  disabled,
  title,
}: {
  state: StageState;
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`checkbox checkbox-${state}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
      disabled={disabled}
      title={title ?? (state === 'full' ? 'Unstage' : 'Stage')}
      aria-checked={state === 'full' ? true : state === 'partial' ? 'mixed' : false}
      role="checkbox"
    >
      {state === 'full' ? <Check size={11} strokeWidth={3} /> : state === 'partial' ? <Minus size={11} strokeWidth={3} /> : state === 'conflict' ? <AlertTriangle size={10} strokeWidth={2.5} /> : null}
    </button>
  );
}

function WorkingFileDiff({
  file,
  version,
  subscribeTick,
}: {
  file: FileStatus;
  version: number;
  subscribeTick: (cb: () => void) => () => void;
}) {
  const { repo } = useRepo();
  const ui = useUI();
  const actions = useActions();
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [diffs, setDiffs] = useState<{ unstaged: FileDiff | null; staged: FileDiff | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const last = useRef('');

  const hasStaged = !file.untracked && file.index !== '.';
  const hasUnstaged = file.untracked || file.worktree !== '.';

  const load = useCallback(async () => {
    try {
      const opts = { ignoreWhitespace: ignoreWs };
      const [unstaged, staged] = await Promise.all([
        hasUnstaged ? api.workingDiff(repo.path, file, false, opts) : null,
        hasStaged ? api.workingDiff(repo.path, file, true, opts) : null,
      ]);
      const key = JSON.stringify([unstaged, staged]);
      if (key === last.current) return;
      last.current = key;
      setDiffs({ unstaged, staged });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [repo.path, file, hasStaged, hasUnstaged, ignoreWs]);

  useEffect(() => {
    load();
  }, [load, version]);
  useEffect(() => subscribeTick(load), [subscribeTick, load]);

  const apply = (diff: FileDiff) => (selection: LineSelection, action: PatchAction) => {
    if (ignoreWs) {
      ui.toast('info', 'Turn off "Ignore whitespace" to stage or discard individual hunks');
      return;
    }
    actions.applyPatch(diff, selection, action);
  };

  const both = hasStaged && hasUnstaged;
  return (
    <div className="diff-pane">
      <div className="pane-header diff-pane-header">
        <StatusBadge status={primaryStatus(file)} />
        <span className="diff-pane-path" title={file.path}>
          {file.origPath && <span className="muted">{file.origPath} → </span>}
          {file.path}
        </span>
        <label className="toggle" title="Ignore whitespace changes">
          <input type="checkbox" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} />
          Ignore whitespace
        </label>
        {hasUnstaged && (
          <button className="button button-small" onClick={() => actions.stage(pathsOf([file]))}>
            Stage File
          </button>
        )}
        {hasStaged && (
          <button className="button button-small" onClick={() => actions.unstage(pathsOf([file]))}>
            Unstage File
          </button>
        )}
        {!file.untracked && (
          <button className="button button-small" onClick={() => actions.blame(file.path)} title="Show who changed each line">
            Blame
          </button>
        )}
        <button className="button button-small button-danger-outline" onClick={() => actions.discard([file])}>
          Discard
        </button>
      </div>
      <div className="diff-scroll">
        {error && <div className="diff-note error-text">{error}</div>}
        {diffs?.unstaged && (
          <>
            {both && <div className="diff-section-title">Unstaged changes</div>}
            <DiffView
              diff={diffs.unstaged}
              mode={file.untracked ? 'readonly' : 'unstaged'}
              onApply={apply(diffs.unstaged)}
              images={{ before: { revs: [':'], path: file.path }, after: { revs: [null], path: file.path } }}
            />
          </>
        )}
        {diffs?.staged && (
          <>
            {both && <div className="diff-section-title staged">Staged changes</div>}
            <DiffView
              diff={diffs.staged}
              mode="staged"
              onApply={apply(diffs.staged)}
              images={{ before: { revs: ['HEAD'], path: file.origPath ?? file.path }, after: { revs: [':'], path: file.path } }}
            />
          </>
        )}
        {diffs && !diffs.staged && !diffs.unstaged && !error && <div className="diff-note">No textual changes.</div>}
      </div>
    </div>
  );
}
