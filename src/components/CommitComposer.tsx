import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { draftFromMessage, loadDraft, saveDraft, type Draft } from '../lib/draft';
import { modKey, plural } from '../lib/format';
import { useActions } from '../repo/actions';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';
import { Avatar } from './Avatar';

const SIGNOFF_KEY = 'gitcolumn.signoff';
const loadSignoff = () => {
  try {
    return localStorage.getItem(SIGNOFF_KEY) === '1';
  } catch {
    return false;
  }
};

export function CommitComposer({ stagedCount, totalCount }: { stagedCount: number; totalCount: number }) {
  const { repo, status } = useRepo();
  const ui = useUI();
  const actions = useActions();
  const [subject, setSubject] = useState(() => loadDraft(repo.path).subject);
  const [body, setBody] = useState(() => loadDraft(repo.path).body);
  const [amend, setAmend] = useState(false);
  const [signoff, setSignoffState] = useState(loadSignoff);
  const [author, setAuthor] = useState<{ name: string; email: string } | null | undefined>(undefined);
  /** The commit.template text currently pre-filled (an untouched template is never committed) */
  const [template, setTemplate] = useState<Draft | null>(null);
  const saved = useRef<{ subject: string; body: string } | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);

  const setSignoff = (on: boolean) => {
    setSignoffState(on);
    try {
      localStorage.setItem(SIGNOFF_KEY, on ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  };

  const loadAuthor = useCallback(() => {
    api.author(repo.path).then(setAuthor, () => setAuthor(null));
  }, [repo.path]);
  useEffect(loadAuthor, [loadAuthor]);

  /** Fill in commit.template when the composer is empty (git itself ignores templates for messages passed with -F). */
  const prefillTemplate = useCallback(async () => {
    const text = await api.commitTemplate(repo.path).catch(() => null);
    if (!text) return setTemplate(null);
    const draft = draftFromMessage(text);
    setTemplate(draft);
    setSubject((s) => s || draft.subject);
    setBody((b) => b || draft.body);
  }, [repo.path]);
  useEffect(() => {
    const d = loadDraft(repo.path);
    if (!d.subject && !d.body) void prefillTemplate();
    else void api.commitTemplate(repo.path).then((t) => setTemplate(t ? draftFromMessage(t) : null), () => undefined);
  }, [repo.path, prefillTemplate]);

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

  const untouchedTemplate = !!template && subject.trim() === template.subject.trim() && body.trim() === template.body.trim();
  const canCommit = !!subject.trim() && !untouchedTemplate && conflicts === 0 && (stagedCount > 0 || amend || inMerge || totalCount > 0);

  const commit = async () => {
    if (!canCommit) return;
    const id = await api.identity(repo.path).catch(() => ({ name: 'x', email: 'x' }));
    if (!id.name || !id.email) {
      ui.toast('info', 'Set your name and email first', 'Git records them as the author of each commit.');
      if (!(await actions.editIdentity())) return;
      loadAuthor();
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
    const done = await actions.commit(message, { amend, stageAll, undoable: !inMerge, signoff });
    if (done) {
      setSubject('');
      setBody('');
      setAmend(false);
      saved.current = null;
      void prefillTemplate();
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
      <div className="composer-author">
        {author ? (
          <button
            className="composer-identity"
            onClick={async () => (await actions.editIdentity()) && loadAuthor()}
            title="Commits are recorded with this name and email. Click to change."
          >
            <Avatar name={author.name} email={author.email} size={20} />
            <span className="composer-identity-name">{author.name}</span>
            <span className="muted composer-identity-email">{author.email}</span>
          </button>
        ) : (
          author === null && (
            <button className="link-button" onClick={async () => (await actions.editIdentity()) && loadAuthor()}>
              Set your name and email…
            </button>
          )
        )}
        <span className="spacer" />
        <label className="toggle" title="Add a Signed-off-by trailer (git commit --signoff)">
          <input type="checkbox" checked={signoff} onChange={(e) => setSignoff(e.target.checked)} />
          Sign Off
        </label>
      </div>
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
        <span className="spacer" />
        {stagedCount > 0 && (
          <button className="button" onClick={() => actions.unstageAll()} title="Move all staged changes back to unstaged">
            Unstage All
          </button>
        )}
        <button className="button button-primary" disabled={!canCommit} onClick={commit} title={`${modKey}↩`}>
          {label}
        </button>
      </div>
      {conflicts > 0 && <div className="composer-hint">Resolve {plural(conflicts, 'conflict')} before committing.</div>}
      {untouchedTemplate && conflicts === 0 && <div className="composer-hint muted">Fill in the commit template before committing.</div>}
    </div>
  );
}
