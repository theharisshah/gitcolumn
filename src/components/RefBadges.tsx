import { Check, Cloud, GitBranch, Tag } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import type { Ref } from '../../shared/types';

export interface BadgeRef {
  key: string;
  kind: 'head' | 'remote' | 'tag' | 'detached';
  label: string;
  current?: boolean;
  /** Local branch whose upstream points at the same commit */
  synced?: boolean;
  ref?: Ref;
}

/** Group refs by commit hash, folding "origin/x" into local "x" when both point at the same commit. */
export function refsByHash(refs: Ref[], head: string | null, detached: boolean): Map<string, BadgeRef[]> {
  const map = new Map<string, BadgeRef[]>();
  const push = (hash: string, b: BadgeRef) => {
    const list = map.get(hash);
    if (list) list.push(b);
    else map.set(hash, [b]);
  };
  const folded = new Set<string>();
  for (const r of refs) {
    if (r.type !== 'head') continue;
    const syncedRemote = r.upstream && refs.find((x) => x.type === 'remote' && x.name === r.upstream && x.hash === r.hash);
    if (syncedRemote) folded.add(syncedRemote.ref);
    push(r.hash, { key: r.ref, kind: 'head', label: r.name, current: r.current, synced: !!syncedRemote, ref: r });
  }
  if (detached && head) push(head, { key: 'HEAD', kind: 'detached', label: 'HEAD' });
  for (const r of refs) {
    if (r.type === 'remote' && !folded.has(r.ref)) push(r.hash, { key: r.ref, kind: 'remote', label: r.name, ref: r });
  }
  for (const r of refs) {
    if (r.type === 'tag') push(r.hash, { key: r.ref, kind: 'tag', label: r.name, ref: r });
  }
  for (const list of map.values()) list.sort((a, b) => Number(!!b.current) - Number(!!a.current));
  return map;
}

/** Approximate rendered width of a badge: border + padding + icon + gap + label (+ synced icon). */
function badgeWidth(b: BadgeRef): number {
  return 2 + 12 + 10 + 3 + Math.ceil(b.label.length * 6.4) + (b.synced ? 13 : 0);
}

export function RefBadges({
  badges,
  onContextMenu,
  fit,
}: {
  badges?: BadgeRef[];
  onContextMenu?: (e: React.MouseEvent, b: BadgeRef) => void;
  /** In single-line rows: shrink to the badges that fit. The value re-runs the fit when the space around changes (e.g. graph width). */
  fit?: number;
}) {
  const strip = useRef<HTMLSpanElement>(null);
  // Badges that don't fit wrap onto a hidden second line, but a wrapped flex box keeps its unwrapped
  // width. Shrink the strip to the badges actually shown, so the subject follows right after them.
  useLayoutEffect(() => {
    const el = strip.current;
    if (fit === undefined || !el || !el.parentElement) return;
    const fitNow = () => {
      el.style.maxWidth = '';
      const box = el.getBoundingClientRect();
      const kids = [...el.children].map((c) => c.getBoundingClientRect());
      if (!kids.length) return;
      const right = Math.max(...kids.filter((k) => Math.abs(k.top - kids[0].top) < 2).map((k) => k.right));
      if (right < box.right - 1) el.style.maxWidth = `${Math.ceil(right - box.left)}px`;
    };
    fitNow();
    const ro = new ResizeObserver(fitNow);
    ro.observe(el.parentElement);
    return () => ro.disconnect();
  }, [badges, fit]);
  if (!badges?.length) return null;
  // When the row is tight the strip shrinks, but never below the first badge (up to 64px).
  const minWidth = Math.min(64, badgeWidth(badges[0]));
  return (
    <span className="ref-badges" style={{ minWidth }} ref={strip}>
      {badges.map((b) => (
        <span
          key={b.key}
          className={`ref-badge ref-${b.kind} ${b.current ? 'ref-current' : ''}`}
          title={b.synced ? `${b.label} (in sync with its upstream)` : b.label}
          onContextMenu={onContextMenu ? (e) => onContextMenu(e, b) : undefined}
        >
          {b.kind === 'tag' ? <Tag size={10} /> : b.kind === 'remote' ? <Cloud size={10} /> : b.current ? <Check size={10} strokeWidth={3} /> : <GitBranch size={10} />}
          <span>{b.label}</span>
          {b.synced && <Cloud size={10} className="ref-synced" />}
        </span>
      ))}
    </span>
  );
}
