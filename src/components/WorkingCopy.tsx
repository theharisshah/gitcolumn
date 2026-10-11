import { FolderOpen, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileDiff, FileStatus, LineSelection, PatchAction } from '../../shared/types';
import { api } from '../lib/api';
import { copyText, modKey } from '../lib/format';
import { useSetting } from '../lib/settings';
import { useActions } from '../repo/actions';
import { useRepo } from '../repo/RepoContext';
import { useUI, type MenuItem } from '../ui/UIProvider';
import { CommitComposer } from './CommitComposer';
import { FileList, keyOf, stageState } from './FileList';
import { ConflictView } from './ConflictView';
import { DiffToolbar, type DiffSide } from './DiffToolbar';
import { DiffView } from './DiffView';
import { Splitter, usePersistentSize } from './Splitter';
import { StatusBadge, primaryStatus } from './StatusBadge';

const pathsOf = (files: FileStatus[]) => files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path]));

export function WorkingCopy() {
  const { repo, status, run, subscribeTick, version } = useRepo();
  const ui = useUI();
  const actions = useActions();
  const [width, setWidth] = usePersistentSize('wc.list', 380);
  const [selected, setSelected] = useState<string[]>([]);

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
      items.push({ label: 'Ignore…', onClick: () => actions.ignore(single.path) });
      items.push({ label: 'Reveal in Finder', icon: <FolderOpen size={14} />, onClick: () => api.reveal(repo.path, single.path).catch((err) => ui.toast('error', 'Could not reveal file', String(err))) });
      items.push({ label: 'Open with Default App', onClick: () => api.openPath(repo.path, single.path).catch((err) => ui.toast('error', 'Could not open file', String(err))) });
      items.push({ label: 'Copy Path', onClick: () => copyText(single.path) });
    }
    ui.menu(e, items);
  };

  return (
    <div className="working-copy">
      <div className="wc-list-pane" style={{ width }}>
        <CommitComposer stagedCount={stagedCount} totalCount={files.length} />
        <FileList
          files={files}
          selected={selected}
          onSelect={setSelected}
          onToggleStage={toggleStage}
          onStageAll={() => actions.stageAll()}
          onUnstageAll={() => actions.unstageAll()}
          onDiscard={(fs) => actions.discard(fs)}
          onContextMenu={fileMenu}
        />
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

/** Which side was shown last, so moving between files keeps the choice. */
let lastSide: DiffSide = 'unstaged';

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
  const [ignoreWs, setIgnoreWs] = useSetting('diffIgnoreWhitespace');
  const [context, setContext] = useSetting('diffContext');
  const [wrap, setWrap] = useSetting('diffWrap');
  const [diffs, setDiffs] = useState<{ unstaged: FileDiff | null; staged: FileDiff | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<DiffSide>(lastSide);
  const last = useRef('');

  const hasStaged = !file.untracked && file.index !== '.';
  const hasUnstaged = file.untracked || file.worktree !== '.';
  // Fall back to the side that has changes.
  const side: DiffSide = chosen === 'staged' ? (hasStaged ? 'staged' : 'unstaged') : hasUnstaged ? 'unstaged' : 'staged';
  const chooseSide = (s: DiffSide) => {
    lastSide = s;
    setChosen(s);
  };

  const load = useCallback(async () => {
    try {
      const opts = { ignoreWhitespace: ignoreWs, context };
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
  }, [repo.path, file, hasStaged, hasUnstaged, ignoreWs, context]);

  useEffect(() => {
    load();
  }, [load, version]);
  useEffect(() => subscribeTick(load), [subscribeTick, load]);

  const apply = (diff: FileDiff) => (selection: LineSelection, action: PatchAction) => {
    if (ignoreWs) {
      ui.toast('info', 'Turn off "Ignore whitespace" to stage or discard individual chunks');
      return;
    }
    actions.applyPatch(diff, selection, action, context === 0);
  };

  const diff = diffs ? (side === 'staged' ? diffs.staged : diffs.unstaged) : null;
  return (
    <div className="diff-pane">
      <div className="pane-header diff-pane-header">
        <StatusBadge status={primaryStatus(file)} />
        <span className="diff-pane-path" title={file.path}>
          {file.origPath && <span className="muted">{file.origPath} → </span>}
          {file.path}
        </span>
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
      <DiffToolbar
        side={side}
        onSide={chooseSide}
        hasStaged={hasStaged}
        hasUnstaged={hasUnstaged}
        diff={diffs ? diff : undefined}
        context={context}
        onContext={setContext}
        wrap={wrap}
        onWrap={setWrap}
        ignoreWhitespace={ignoreWs}
        onIgnoreWhitespace={setIgnoreWs}
      />
      <div className="diff-scroll">
        {error && <div className="diff-note error-text">{error}</div>}
        {diff && side === 'unstaged' && (
          <DiffView
            diff={diff}
            mode={file.untracked ? 'readonly' : 'unstaged'}
            onApply={apply(diff)}
            wrap={wrap}
            images={{ before: { revs: [':'], path: file.path }, after: { revs: [null], path: file.path } }}
          />
        )}
        {diff && side === 'staged' && (
          <DiffView
            diff={diff}
            mode="staged"
            onApply={apply(diff)}
            wrap={wrap}
            images={{ before: { revs: ['HEAD'], path: file.origPath ?? file.path }, after: { revs: [':'], path: file.path } }}
          />
        )}
        {diffs && !diff && !error && <div className="diff-note">No textual changes.</div>}
      </div>
    </div>
  );
}
