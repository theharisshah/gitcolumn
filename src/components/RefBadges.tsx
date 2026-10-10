import { Check, Cloud, GitBranch, Tag } from 'lucide-react';
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

export function RefBadges({ badges, onContextMenu }: { badges?: BadgeRef[]; onContextMenu?: (e: React.MouseEvent, b: BadgeRef) => void }) {
  if (!badges?.length) return null;
  return (
    <span className="ref-badges">
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
