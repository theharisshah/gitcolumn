import { Archive } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { FileDiff, Stash } from '../../shared/types';
import { api } from '../lib/api';
import { fullDate, plural, relativeTime } from '../lib/format';
import { useActions } from '../repo/actions';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';
import { FileDiffSection } from './DiffView';
import { Splitter, usePersistentSize } from './Splitter';

export function Stashes({ initial }: { initial?: string }) {
  const { stashes, status } = useRepo();
  const actions = useActions();
  const ui = useUI();
  const [width, setWidth] = usePersistentSize('stash.list', 340);
  const [selected, setSelected] = useState<string | null>(initial ?? null);

  useEffect(() => {
    if (initial) setSelected(initial);
  }, [initial]);
  useEffect(() => {
    setSelected((s) => (s && stashes.some((x) => x.hash === s) ? s : stashes[0]?.hash ?? null));
  }, [stashes]);

  const current = stashes.find((s) => s.hash === selected);

  if (!stashes.length) {
    return (
      <div className="empty-state">
        <Archive size={32} strokeWidth={1.25} className="muted" />
        <div className="empty-title">No stashes</div>
        <div className="muted">Stashing saves your uncommitted changes and gives you a clean working copy.</div>
        {!!status?.files.length && (
          <div className="empty-actions">
            <button className="button button-primary" onClick={() => actions.stashSave()}>
              Stash {plural(status.files.length, 'Change')}…
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="stashes">
      <div className="stash-list-pane" style={{ width }}>
        <div className="pane-header">
          <span className="pane-title">{plural(stashes.length, 'stash', 'stashes')}</span>
        </div>
        <div className="stash-list">
          {stashes.map((s) => (
            <div
              key={s.hash}
              className={`stash-row ${s.hash === selected ? 'selected' : ''}`}
              onMouseDown={() => setSelected(s.hash)}
              onDoubleClick={() => actions.stashApply(s, false)}
              onContextMenu={(e) => {
                setSelected(s.hash);
                ui.menu(e, [
                  { label: 'Apply Stash', onClick: () => actions.stashApply(s, false) },
                  { label: 'Apply and Delete (Pop)', onClick: () => actions.stashApply(s, true) },
                  'separator',
                  { label: 'Delete Stash…', danger: true, onClick: () => actions.stashDrop(s) },
                ]);
              }}
            >
              <Archive size={14} className="muted" />
              <div className="stash-row-text">
                <div className="stash-message">{cleanMessage(s.message)}</div>
                <div className="muted small">
                  {s.ref} · {relativeTime(s.date)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <Splitter value={width} onChange={setWidth} min={240} max={600} />
      <div className="stash-detail-pane">{current && <StashDetail key={current.hash} stash={current} />}</div>
    </div>
  );
}

function cleanMessage(m: string) {
  return m.replace(/^(WIP on|On) [^:]+: /, '');
}

function StashDetail({ stash }: { stash: Stash }) {
  const { repo } = useRepo();
  const actions = useActions();
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .stashDiff(repo.path, stash.ref)
      .then((d) => !cancelled && setDiffs(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [repo.path, stash.ref, stash.hash]);

  const branch = /^(?:WIP on|On) ([^:]+):/.exec(stash.message)?.[1];
  return (
    <div className="commit-details">
      <div className="commit-meta">
        <h2 className="commit-title">{cleanMessage(stash.message)}</h2>
        <div className="muted small">
          {stash.ref}
          {branch && <> · created on {branch}</>} · {fullDate(stash.date)}
        </div>
        <div className="stash-actions">
          <button className="button button-primary" onClick={() => actions.stashApply(stash, false)}>
            Apply
          </button>
          <button className="button" onClick={() => actions.stashApply(stash, true)}>
            Pop
          </button>
          <button className="button button-danger-outline" onClick={() => actions.stashDrop(stash)}>
            Delete…
          </button>
        </div>
      </div>
      <div className="commit-diffs">
        {error && <div className="diff-note error-text">{error}</div>}
        {!diffs && !error && <div className="diff-note muted">Loading changes…</div>}
        {diffs?.map((d) => <FileDiffSection key={d.newPath || d.oldPath} diff={d} />)}
      </div>
    </div>
  );
}
