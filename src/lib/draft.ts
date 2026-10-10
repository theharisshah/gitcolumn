/** The unsent commit message per repository, kept across restarts. */
export interface Draft {
  subject: string;
  body: string;
}

const draftKey = (repo: string) => `gitcolumn.draft:${repo}`;

export function loadDraft(repo: string): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey(repo)) ?? '') as Partial<Draft>;
    return { subject: String(d.subject ?? ''), body: String(d.body ?? '') };
  } catch {
    return { subject: '', body: '' };
  }
}

export function saveDraft(repo: string, draft: Draft) {
  try {
    if (draft.subject || draft.body) localStorage.setItem(draftKey(repo), JSON.stringify(draft));
    else localStorage.removeItem(draftKey(repo));
  } catch {
    /* storage unavailable */
  }
}

export function draftFromMessage(message: string): Draft {
  const [first, ...rest] = message.split('\n');
  return { subject: first, body: rest.join('\n').trim() };
}
