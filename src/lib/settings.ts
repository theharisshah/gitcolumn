import { useEffect, useState } from 'react';

/** App-wide preferences, stored per user in localStorage. */
export interface Settings {
  pullRebase: boolean;
  autoFetchMinutes: number;
  syntaxHighlighting: boolean;
  /** Lines of context around changes in diffs (1_000_000 = whole file) */
  diffContext: number;
  /** Wrap long lines in diffs (otherwise scroll horizontally) */
  diffWrap: boolean;
  diffIgnoreWhitespace: boolean;
  historyRowStyle: 'auto' | 'columns' | 'compact';
  historyMonthHeaders: boolean;
  /** Show GitHub avatars (looked up through the gh CLI) instead of initials */
  githubAvatars: boolean;
  /** Branches without commits for this many days count as stale in Branches Review */
  staleBranchDays: number;
}

const DEFAULTS: Settings = {
  pullRebase: false,
  autoFetchMinutes: 0,
  syntaxHighlighting: true,
  diffContext: 3,
  diffWrap: true,
  diffIgnoreWhitespace: false,
  historyRowStyle: 'auto',
  historyMonthHeaders: true,
  githubAvatars: true,
  staleBranchDays: 90,
};

const KEY = 'gitcolumn.settings';
const EVENT = 'gitcolumn:settings';

function read(): Settings {
  try {
    const legacyRebase = localStorage.getItem('gitcolumn.pullRebase');
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    return { ...DEFAULTS, ...(legacyRebase !== null ? { pullRebase: legacyRebase === '1' } : {}), ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getSetting<K extends keyof Settings>(key: K): Settings[K] {
  return read()[key];
}

export function setSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...read(), [key]: value }));
    localStorage.removeItem('gitcolumn.pullRebase');
  } catch {
    /* storage unavailable */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function onSettingsChange(cb: () => void): () => void {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

/** A setting as React state that follows changes made anywhere in the app. */
export function useSetting<K extends keyof Settings>(key: K): [Settings[K], (value: Settings[K]) => void] {
  const [value, setValue] = useState(() => getSetting(key));
  useEffect(() => onSettingsChange(() => setValue(getSetting(key))), [key]);
  return [value, (v: Settings[K]) => setSetting(key, v)];
}
