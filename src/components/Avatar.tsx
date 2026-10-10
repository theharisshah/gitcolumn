import { useState } from 'react';
import { useAvatarUrl } from '../lib/avatars';
import { hashColor, initials } from '../lib/format';

/** A round author avatar: a GitHub picture when available, coloured initials otherwise. */
export function Avatar({ name, email, size = 28, className = '' }: { name: string; email: string; size?: number; className?: string }) {
  const url = useAvatarUrl(email);
  const [failed, setFailed] = useState<string | null>(null);
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.38)) };
  if (url && failed !== url) {
    return (
      <img
        className={`avatar avatar-img ${className}`}
        style={style}
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        draggable={false}
        onError={() => setFailed(url)}
      />
    );
  }
  return (
    <span className={`avatar ${className}`} style={{ ...style, background: hashColor(email || name) }} aria-hidden>
      {initials(name)}
    </span>
  );
}
