import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { draftFromMessage, loadDraft, saveDraft } from '../lib/draft';
import { modKey, plural } from '../lib/format';
import { useActions } from '../repo/actions';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';

export function CommitComposer({ stagedCount, totalCount }: { stagedCount: number; totalCount: number }) {
  const { repo, status } = useRepo();
  const ui = useUI();
  const actions = useActions();
  const [subject, setSubject] = useState(() => loadDraft(repo.path).subject);
  const [body, setBody] = useState(() => loadDraft(repo.path).body);
  const [amend, setAmend] = useState(false);
  const saved = useRef<{ subject: string; body: string } | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);

  const state = status?.state;
  const inMerge = !!(state?.merging || state?.cherryPicking || state?.reverting);
  const conflicts = status?.files.filter((f) => f.conflicted).length ?? 0;

  useEffect(() => saveDraft(repo.path, { subject, body }), [repo.path, subject, body]);

  // Pre-fill the merge / cherry-pick message.
  // Once the operation ends (committed elsewhere or aborted), drop the pre-filled text if it's untouched.
  const mergeMessage = inMerge ? state?.message : undefined;
  const lastMerge = useRef<{ subject: string; body: string } | null>(null);
  useEffect(() => {
    if (mergeMessage) {
      const [first, ...rest] = mergeMessage.split('\n');
      const prefill = { subject: first, body: rest.join('\n').trim() };
      lastMerge.current = prefill;
      setSubject((s) => s || prefill.subject);
      setBody((b) => b || prefill.body);
    } else if (lastMerge.current) {
      const prefill = lastMerge.current;
      lastMerge.current = null;
      setSubject((s) => (s === prefill.subject ? '' : s));
      setBody((b) => (b === prefill.body ? '' : b));
    }
  }, [mergeMessage]);

  // "Undo Commit" puts the message back into the composer.
  useEffect(() => {
    const restore = (e: Event) => {
      const detail = (e as CustomEvent<{ repo: string; message: string }>).detail;
      if (detail.repo !== repo.path) return;
      const draft = draftFromMessage(detail.message);
      setSubject(draft.subject);
      setBody(draft.body);
    };
    window.addEventListener('gitcolumn:restore-message', restore);
    return () => window.removeEventListener('gitcolumn:restore-message', restore);
  }, [repo.path]);

  useEffect(() => {
    const focus = () => subjectRef.current?.focus();
    window.addEventListener('gitcolumn:focus-commit', focus);
    return () => window.removeEventListener('gitcolumn:focus-commit', focus);
  }, []);

  const toggleAmend = async (on: boolean) => {
    setAmend(on);
    if (on) {
      saved.current = { subject, body };
      const msg = await api.lastCommitMessage(repo.path).catch(() => '');
      const [first, ...rest] = msg.split('\n');
      setSubject(first ?? '');
      setBody(rest.join('\n').trim());
    } else if (saved.current) {
      setSubject(saved.current.subject);
      setBody(saved.current.body);
      saved.current = null;
    }
  };

  const canCommit = !!subject.trim() && conflicts === 0 && (stagedCount > 0 || amend || inMerge || totalCount > 0);

  const commit = async () => {
    if (!canCommit) return;
    const id = await api.identity(repo.path).catch(() => ({ name: 'x', email: 'x' }));
    if (!id.name || !id.email) {
      ui.toast('info', 'Set your name and email first', 'Git records them as the author of each commit.');
      if (!(await actions.editIdentity())) return;
    }
    let stageAll = false;
    if (!stagedCount && !amend && !inMerge) {
      const ok = await ui.confirm({
        title: 'No changes are staged',
        message: `Stage all ${plural(totalCount, 'changed file')} and commit them?`,
        confirmLabel: 'Stage All & Commit',
      });
      if (!ok) return;
      stageAll = true;
    }
    const message = body.trim() ? `${subject.trim()}\n\n${body.trim()}` : subject.trim();
    const done = await actions.commit(message, { amend, stageAll, undoable: !inMerge });
    if (done) {
      setSubject('');
      setBody('');
      setAmend(false);
      saved.current = null;
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      commit();
    }
  };

  const len = subject.length;
  let label = amend ? 'Amend Commit' : inMerge ? 'Commit Merge' : stagedCount ? `Commit ${plural(stagedCount, 'File')}` : 'Commit';
  if (state?.cherryPicking) label = 'Commit Cherry-Pick';
  return (
    <div className="composer" onKeyDown={onKey}>
      <div className="composer-subject">
        <input
          ref={subjectRef}
          className="input"
          placeholder="Commit subject"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              (e.currentTarget.parentElement?.nextElementSibling as HTMLTextAreaElement | null)?.focus();
            }
          }}
        />
        <span className={`char-count ${len > 72 ? 'over' : len > 50 ? 'warn' : ''}`} title="Keep the subject under ~50 characters">
          {len || ''}
        </span>
      </div>
      <textarea className="input composer-body" placeholder="Description (optional)" value={body} onChange={(e) => setBody(e.target.value)} rows={4} />
      <div className="composer-footer">
        <label className="toggle" title="Replace the last commit with a new one">
          <input type="checkbox" checked={amend} disabled={!status?.head || inMerge} onChange={(e) => toggleAmend(e.target.checked)} />
          Amend
        </label>
        <button className="button button-primary" disabled={!canCommit} onClick={commit} title={`${modKey}↩`}>
          {label}
        </button>
      </div>
      {conflicts > 0 && <div className="composer-hint">Resolve {plural(conflicts, 'conflict')} before committing.</div>}
    </div>
  );
}
