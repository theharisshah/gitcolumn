import { Cloud, CornerDownLeft, GitBranch, GitCommitHorizontal, Search, Tag, Zap } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Commit, Ref } from '../../shared/types';
import { api } from '../lib/api';
import { FileIcon } from '../lib/fileIcons';
import { copyText, dirname, modKey, relativeTime, shortHash } from '../lib/format';
import { PREFIXES, parseQuery, rankEntries, type PaletteEntry } from '../lib/palette';
import { useActions } from '../repo/actions';
import { formatShortcut, type Command } from '../repo/commands';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';
import { Highlighted } from './Highlighted';

type Item =
  | { kind: 'command'; command: Command }
  | { kind: 'ref'; ref: Ref }
  | { kind: 'file'; path: string }
  | { kind: 'commit'; commit: Commit; index: number };

const COMMIT_LIMIT = 1000;
const HISTORY_PAGE = 300;

/** ⌘⇧A / ⌘K: jump to any command, branch, file or recent commit. */
export function QuickActions({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const { repo, refs, setView } = useRepo();
  const actions = useActions();
  const ui = useUI();
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query);
  const [files, setFiles] = useState<string[] | null>(null);
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [lookup, setLookup] = useState<Commit | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Load the slower sources in the background; commands and branches are there immediately.
  useEffect(() => {
    let cancelled = false;
    api.filesSearch(repo.path, null).then((f) => !cancelled && setFiles(f), () => !cancelled && setFiles([]));
    api.log(repo.path, { limit: COMMIT_LIMIT }).then((c) => !cancelled && setCommits(c), () => !cancelled && setCommits([]));
    return () => {
      cancelled = true;
    };
  }, [repo.path]);

  const { mode, text } = parseQuery(deferred);

  // A full or abbreviated hash that isn't among the recent commits: look it up.
  useEffect(() => {
    setLookup(null);
    if ((mode !== 'all' && mode !== 'Commits') || !/^[0-9a-f]{4,64}$/i.test(text)) return;
    if (commits?.some((c) => c.hash.startsWith(text.toLowerCase()))) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const hash = await api.revParse(repo.path, `${text}^{commit}`).catch(() => null);
      if (!hash || cancelled) return;
      const [c] = await api.log(repo.path, { ref: hash, limit: 1 }).catch(() => []);
      if (c && !cancelled) setLookup(c);
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [mode, text, commits, repo.path]);

  const entries = useMemo(() => {
    const list: PaletteEntry<Item>[] = [];
    for (const c of commands) {
      if (c.enabled === false || c.id.startsWith('palette.')) continue;
      list.push({
        id: `cmd:${c.id}`,
        group: 'Commands',
        title: c.title,
        keywords: c.keywords,
        detail: c.shortcut ? formatShortcut(c.shortcut) : c.group,
        data: { kind: 'command', command: c },
      });
    }
    const sortedRefs = [...refs].sort((a, b) => Number(!!b.current) - Number(!!a.current) || b.date - a.date);
    for (const r of sortedRefs) {
      if (r.type === 'remote' && r.name.endsWith('/HEAD')) continue;
      const detail = r.current ? 'current branch' : r.type === 'remote' ? 'remote branch' : r.type === 'tag' ? 'tag' : r.subject;
      list.push({ id: `ref:${r.ref}`, group: 'Branches', title: r.name, detail, data: { kind: 'ref', ref: r } });
    }
    for (const p of files ?? []) list.push({ id: `file:${p}`, group: 'Files', title: p, path: true, detail: undefined, data: { kind: 'file', path: p } });
    const all = lookup && !commits?.some((c) => c.hash === lookup.hash) ? [lookup, ...(commits ?? [])] : commits ?? [];
    all.forEach((c, index) =>
      list.push({
        id: `commit:${c.hash}`,
        group: 'Commits',
        title: c.subject,
        exact: c.hash,
        detail: `${shortHash(c.hash)} · ${c.author} · ${relativeTime(c.date)}`,
        data: { kind: 'commit', commit: c, index: c === lookup ? Infinity : index },
      }),
    );
    return list;
  }, [commands, refs, files, commits, lookup]);

  const results = useMemo(() => rankEntries(mode, text, entries), [mode, text, entries]);
  useEffect(() => setActive(0), [deferred]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (item: Item, alt: boolean) => {
    onClose();
    switch (item.kind) {
      case 'command':
        item.command.run();
        return;
      case 'ref': {
        const r = item.ref;
        if (alt || r.current) return setView({ kind: 'history', ref: r.name, label: r.name });
        if (r.type === 'tag') return void actions.checkoutDetached(r.name, `tag ${r.name}`);
        return void actions.checkout(r);
      }
      case 'file':
        if (alt) return actions.showFileHistory(item.path);
        return setView({ kind: 'files', path: item.path });
      case 'commit': {
        const c = item.commit;
        if (alt) return void copyText(c.hash).then(() => ui.toast('info', 'Copied commit hash'));
        // Recent commits are on the first History page; older ones open History at that commit.
        if (item.index < HISTORY_PAGE) return setView({ kind: 'history', select: c.hash });
        return setView({ kind: 'history', ref: c.hash, label: shortHash(c.hash), select: c.hash });
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const r = results[active];
      if (r) run(r.entry.data, e.metaKey || e.ctrlKey);
    }
  };

  const actionLabel = (item: Item, alt = false): string => {
    switch (item.kind) {
      case 'command':
        return alt ? '' : 'Run';
      case 'ref':
        return alt || item.ref.current ? 'Show in History' : 'Check Out';
      case 'file':
        return alt ? 'File History' : 'Show in Files';
      case 'commit':
        return alt ? 'Copy Hash' : 'Show in History';
    }
  };

  const loading = (mode === 'Files' && !files) || (mode === 'Commits' && !commits);
  const current = results[active]?.entry.data;
  let lastGroup: string | null = null;

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Quick Actions" onKeyDown={onKeyDown}>
        <div className="palette-input">
          <Search size={15} className="muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands, branches, files and commits…"
            spellCheck={false}
            aria-activedescendant={results[active] ? `palette-${active}` : undefined}
          />
        </div>
        <div className="palette-results" ref={listRef} role="listbox">
          {results.map((r, i) => {
            const header = r.entry.group !== lastGroup ? r.entry.group : null;
            lastGroup = r.entry.group;
            const item = r.entry.data;
            return (
              <div key={r.entry.id}>
                {header && <div className="palette-group">{header}</div>}
                <div
                  id={`palette-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={`palette-row ${i === active ? 'active' : ''}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={(e) => run(item, e.metaKey || e.ctrlKey)}
                >
                  <span className="palette-icon">{iconFor(item)}</span>
                  <span className="palette-title">
                    {item.kind === 'file' ? (
                      <>
                        <Highlighted text={r.entry.title.slice(r.entry.title.lastIndexOf('/') + 1)} positions={shift(r.positions, r.entry.title.lastIndexOf('/') + 1)} />
                        <span className="palette-detail">{dirname(r.entry.title)}</span>
                      </>
                    ) : (
                      <>
                        <Highlighted text={r.entry.title} positions={r.positions} />
                        {r.entry.detail && <span className="palette-detail">{r.entry.detail}</span>}
                      </>
                    )}
                  </span>
                  {i === active && (
                    <span className="palette-hint">
                      {actionLabel(item)} <CornerDownLeft size={11} />
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {!results.length && <div className="palette-empty muted">{loading ? 'Loading…' : 'No matches'}</div>}
        </div>
        <div className="palette-footer muted">
          {PREFIXES.map((p) => (
            <button key={p.char} className={`palette-prefix ${mode === p.group ? 'active' : ''}`} onClick={() => setQuery(mode === p.group ? text : `${p.char}${text}`)} title={`Only ${p.hint}`}>
              <kbd>{p.char}</kbd> {p.hint}
            </button>
          ))}
          <span className="spacer" />
          {current && actionLabel(current, true) && (
            <span>
              <kbd>{modKey}↩</kbd> {actionLabel(current, true)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** Positions relative to a suffix of the text (for file names shown without their folder). */
function shift(positions: number[], offset: number): number[] {
  return positions.filter((p) => p >= offset).map((p) => p - offset);
}

function iconFor(item: Item) {
  switch (item.kind) {
    case 'command':
      return <Zap size={14} />;
    case 'ref':
      return item.ref.type === 'tag' ? <Tag size={14} /> : item.ref.type === 'remote' ? <Cloud size={14} /> : <GitBranch size={14} />;
    case 'file':
      return <FileIcon path={item.path} />;
    case 'commit':
      return <GitCommitHorizontal size={14} />;
  }
}
