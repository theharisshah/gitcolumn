/** App-wide preferences, stored per user in localStorage. */
export interface Settings {
  pullRebase: boolean;
  autoFetchMinutes: number;
  syntaxHighlighting: boolean;
}

const DEFAULTS: Settings = {
  pullRebase: false,
  autoFetchMinutes: 0,
  syntaxHighlighting: true,
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
