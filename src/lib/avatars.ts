import { useEffect, useState } from 'react';
import { getSetting, onSettingsChange } from './settings';

// Avatar URLs by lower-cased email. Filled from GitHub noreply addresses and, once the gh layer
// is available, from the repository's GitHub history (see setAvatarMap).
const known = new Map<string, string>();
const listeners = new Set<() => void>();

/** GitHub noreply addresses encode the account id: 12345+name@users.noreply.github.com */
function fromNoreply(email: string): string | undefined {
  const m = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(email);
  return m ? `https://avatars.githubusercontent.com/u/${m[1]}?s=64&v=4` : undefined;
}

export function setAvatarMap(map: Record<string, string>) {
  let changed = false;
  for (const [email, url] of Object.entries(map)) {
    const key = email.toLowerCase();
    if (known.get(key) !== url) {
      known.set(key, url);
      changed = true;
    }
  }
  if (changed) listeners.forEach((l) => l());
}

export function avatarUrl(email: string): string | undefined {
  if (!getSetting('githubAvatars') || !email) return undefined;
  return known.get(email.toLowerCase()) ?? fromNoreply(email);
}

export function useAvatarUrl(email: string): string | undefined {
  const [, force] = useState(0);
  useEffect(() => {
    const update = () => force((n) => n + 1);
    listeners.add(update);
    const off = onSettingsChange(update);
    return () => {
      listeners.delete(update);
      off();
    };
  }, []);
  return avatarUrl(email);
}
