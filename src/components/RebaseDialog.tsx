import { ArrowDown, ArrowUp, GitMerge, GripVertical } from 'lucide-react';
import { useMemo, useState } from 'react';
import { affectedMerges } from '../../shared/rebase';
import type { RebaseAction, RebasePlan, RebaseStep } from '../../shared/types';
import { shortHash } from '../lib/format';

const ACTIONS: { value: RebaseAction; label: string; hint: string }[] = [
  { value: 'pick', label: 'Pick', hint: 'Keep the commit as is' },
  { value: 'reword', label: 'Reword', hint: 'Keep the changes, edit the message' },
  { value: 'edit', label: 'Edit', hint: 'Stop after this commit so you can amend it' },
  { value: 'squash', label: 'Squash', hint: 'Combine into the commit above, keeping both messages' },
  { value: 'fixup', label: 'Fixup', hint: 'Combine into the commit above, discarding this message' },
  { value: 'drop', label: 'Drop', hint: 'Remove the commit and its changes' },
];

interface Row extends RebaseStep {
  subject: string;
  body: string;
  pushed: boolean;
  merge: boolean;
  mainline: boolean;
}

export function RebaseDialog({
  branch,
  plan,
  initial,
  onClose,
}: {
  branch: string;
  plan: RebasePlan;
  initial: RebaseStep[];
  onClose: (steps: RebaseStep[] | null) => void;
}) {
  const byHash = useMemo(() => new Map(plan.commits.map((c) => [c.hash, c])), [plan]);
  const [rows, setRows] = useState<Row[]>(() =>
    initial.map((s) => {
      const c = byHash.get(s.hash)!;
      return {
        ...s,
        subject: c.subject,
        body: c.body,
        pushed: c.pushed,
        merge: c.parents.length > 1,
        mainline: c.mainline !== false,
        message: s.message ?? (c.body ? `${c.subject}\n\n${c.body}` : c.subject),
      };
    }),
  );
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // With merges, git recreates them (--rebase-merges): the order is fixed and merges are kept.
  const mergesMode = plan.hasMerges;
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const update = (i: number, patch: Partial<Row>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const move = (from: number, to: number) =>
    setRows((r) => {
      if (to < 0 || to >= r.length || from === to) return r;
      const next = [...r];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });

  const firstKept = rows.find((r) => r.action !== 'drop');
  let error: string | null = null;
  if (!firstKept) error = 'Keep at least one commit.';
  else if (firstKept.action === 'squash' || firstKept.action === 'fixup') error = 'The first kept commit can’t be squashed — there is nothing above it to combine with.';
  else if (rows.some((r) => r.action === 'reword' && !r.message?.trim())) error = 'Reworded commits need a message.';
  const recreated = mergesMode ? affectedMerges(plan, rows) : new Set<string>();
  const checks = new Map((plan.merges ?? []).map((m) => [m.hash, m]));
  const evil = [...recreated].filter((h) => checks.get(h)?.evil);
  const unverifiable = [...recreated].filter((h) => checks.get(h)?.unverifiable);
  const conflicting = [...recreated].filter((h) => checks.get(h)?.conflicts);
  if (!error && evil.length) {
    const paths = checks.get(evil[0])?.paths;
    error = `The merge ${shortHash(evil[0])} contains changes of its own${paths?.length ? ` (${paths.join(', ')})` : ''}, which recreating it would lose. Only change commits after it (below it in this list).`;
  } else if (!error && unverifiable.length) {
    error = `The merge ${shortHash(unverifiable[0])} can’t be checked (${checks.get(unverifiable[0])?.unverifiable}), so it can’t be recreated safely. Only change commits after it (below it in this list).`;
  }

  const changed = rows.some((r, i) => r.action !== 'pick' || r.hash !== plan.commits[i].hash);
  const pushed = rows.some((r) => r.pushed && (r.action !== 'pick' || rows.indexOf(r) !== plan.commits.findIndex((c) => c.hash === r.hash)));
  const dropped = rows.filter((r) => r.action === 'drop').length;
  const squashed = rows.filter((r) => r.action === 'squash' || r.action === 'fixup').length;

  const submit = () => {
    if (error || !changed) return;
    onClose(rows.map(({ action, hash, message }) => (action === 'reword' ? { action, hash, message } : { action, hash })));
  };

  return (
    <div
      className="modal rebase-modal"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose(null);
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
      }}
    >
      <h2 className="modal-title">Interactive Rebase</h2>
      <div className="modal-message">
        Rewrite {rows.length === 1 ? 'the last commit' : `the last ${rows.length} commits`} on <b>{branch}</b>
        {plan.base && (
          <>
            {' '}
            on top of <span className="mono">{shortHash(plan.base)}</span>
          </>
        )}
        .{' '}
        {mergesMode
          ? 'This range contains merges: they are recreated as they are, so commits keep their order here.'
          : 'Commits are applied top to bottom — drag to reorder.'}
      </div>
      <div className="rebase-list">
        {rows.map((row, i) => (
          <div
            key={row.hash}
            className={`rebase-row action-${row.action} ${row.merge ? 'rebase-merge' : ''} ${!row.mainline ? 'rebase-side' : ''} ${dragIndex === i ? 'dragging' : ''} ${overIndex === i && dragIndex !== i ? 'drop-target' : ''}`}
            draggable={!mergesMode}
            onDragStart={(e) => {
              setDragIndex(i);
              e.dataTransfer.effectAllowed = 'move';
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setOverIndex(i);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex !== null) move(dragIndex, i);
              setDragIndex(null);
              setOverIndex(null);
            }}
          >
            {!mergesMode && (
              <span className="rebase-grip" title="Drag to reorder">
                <GripVertical size={14} />
              </span>
            )}
            {row.merge ? (
              <span className="rebase-action rebase-keep" title={recreated.has(row.hash) ? 'Recreated on top of the rewritten commits' : 'Kept as it is'}>
                <GitMerge size={12} /> {recreated.has(row.hash) ? 'Remerge' : 'Keep'}
              </span>
            ) : (
              <select
                className="input rebase-action"
                value={row.action}
                title={ACTIONS.find((a) => a.value === row.action)?.hint}
                onChange={(e) => update(i, { action: e.target.value as RebaseAction })}
              >
                {ACTIONS.map((a) => (
                  <option key={a.value} value={a.value} title={a.hint}>
                    {a.label}
                  </option>
                ))}
              </select>
            )}
            <span className="mono rebase-hash">{shortHash(row.hash)}</span>
            <div className="rebase-text">
              {row.action === 'reword' ? (
                <textarea
                  className="input rebase-message"
                  rows={Math.min(5, (row.message ?? '').split('\n').length + 1)}
                  value={row.message}
                  onChange={(e) => update(i, { message: e.target.value })}
                  onMouseDown={(e) => e.stopPropagation()}
                  draggable={false}
                  onDragStart={(e) => e.preventDefault()}
                />
              ) : (
                <span className="rebase-subject">
                  {row.subject}
                  {(row.action === 'squash' || row.action === 'fixup') && (
                    <span className="muted small"> → {mergesMode ? 'into its parent (when it is the previous commit on the same branch)' : 'into the commit above'}</span>
                  )}
                  {row.action === 'edit' && <span className="muted small"> → pause here to amend</span>}
                </span>
              )}
            </div>
            {row.pushed && (
              <span className="rebase-pushed" title="This commit already exists on a remote">
                pushed
              </span>
            )}
            {!mergesMode && (
              <span className="rebase-move">
                <button className="icon-button" disabled={i === 0} onClick={() => move(i, i - 1)} title="Move up">
                  <ArrowUp size={12} />
                </button>
                <button className="icon-button" disabled={i === rows.length - 1} onClick={() => move(i, i + 1)} title="Move down">
                  <ArrowDown size={12} />
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="rebase-summary muted small">
        {changed
          ? [
              squashed && `${squashed} combined`,
              dropped && `${dropped} dropped`,
              rows.filter((r) => r.action === 'reword').length && `${rows.filter((r) => r.action === 'reword').length} reworded`,
              rows.some((r, idx) => r.hash !== plan.commits[idx].hash) && 'reordered',
            ]
              .filter(Boolean)
              .join(' · ') || 'Ready'
          : 'No changes yet'}
      </div>
      {conflicting.length > 0 && !evil.length && (
        <div className="rebase-warning">
          {conflicting.length === 1 ? `The merge ${shortHash(conflicting[0])} needed` : `${conflicting.length} merges needed`} conflicts resolved by hand. The rebase will stop there so you can resolve them again.
        </div>
      )}
      {pushed && (
        <div className="rebase-warning">
          Some of these commits are already on a remote. After rewriting them you’ll need to force push, which affects anyone who pulled them.
        </div>
      )}
      {error && changed && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="button" onClick={() => onClose(null)}>
          Cancel
        </button>
        <button type="button" className="button button-primary" disabled={!!error || !changed} onClick={submit}>
          Start Rebase
        </button>
      </div>
    </div>
  );
}
