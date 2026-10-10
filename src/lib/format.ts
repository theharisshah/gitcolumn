export function relativeTime(unix: number, now = Date.now() / 1000): string {
  const diff = Math.max(0, now - unix);
  if (diff < 45) return 'just now';
  if (diff < 90) return '1 minute ago';
  const mins = Math.round(diff / 60);
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const d = new Date(unix * 1000);
  const sameYear = d.getFullYear() === new Date(now * 1000).getFullYear();
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function fullDate(unix: number): string {
  return new Date(unix * 1000).toLocaleString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const shortHash = (h: string) => h.slice(0, 7);

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function hashColor(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(h) % 360} 55% 52%)`;
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

export function tildify(p: string, home?: string): string {
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

export function plural(n: number, word: string, pluralWord = word + 's'): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

export function copyText(text: string) {
  return navigator.clipboard.writeText(text);
}

/** Derive a folder name from a clone URL: git@github.com:foo/bar.git -> bar */
export function repoNameFromUrl(url: string): string {
  const m = /([^/:]+?)(\.git)?\/?$/.exec(url.trim());
  return m ? m[1] : '';
}

export const isMac = (window.gitcolumn?.platform ?? navigator.platform).toLowerCase().startsWith('mac') ||
  window.gitcolumn?.platform === 'darwin';

export const modKey = isMac ? '⌘' : 'Ctrl+';
