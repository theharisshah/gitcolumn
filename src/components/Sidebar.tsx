import { Archive, ChevronDown, ChevronRight, Cloud, Folder, FolderGit2, FolderTree, GitBranch, GitPullRequest, History, Inbox, Layers, ListChecks, Package, Pin, Plus, RotateCcw, Search, Server, Settings, Tag, X } from 'lucide-react';
import { useApp } from '../AppContext';
import { api } from '../lib/api';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Ref, Worktree } from '../../shared/types';
import { copyText } from '../lib/format';
import { useActions } from '../repo/actions';
import { useRefMenu } from '../repo/refMenu';
import { useRepo, type View } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  ref?: Ref;
}

function buildTree(refs: Ref[], strip: (r: Ref) => string): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() };
  for (const r of refs) {
    const parts = strip(r).split('/');
    let node = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    });
    node.ref = r;
  }
  return root;
}

function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('gitcolumn.sidebarCollapsed') ?? '["section:tags"]'));
    } catch {
      return new Set(['section:tags']);
    }
  });
  const toggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem('gitcolumn.sidebarCollapsed', JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  return { collapsed, toggle };
}

export function Sidebar() {
  const { repo, status, refs, remotes, stashes, submodules, view, setView, version } = useRepo();
  const app = useApp();
  const actions = useActions();
  const ui = useUI();
  const { collapsed, toggle } = useCollapsed();
  const [filter, setFilter] = useState('');

  const refMenu = useRefMenu();
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  useEffect(() => {
    let cancelled = false;
    api.worktrees(repo.path).then((w) => !cancelled && setWorktrees(w), () => undefined);
    return () => {
      cancelled = true;
    };
  }, [repo.path, version]);

  const f = filter.trim().toLowerCase();
  const match = (r: Ref) => !f || r.name.toLowerCase().includes(f);
  const allHeads = useMemo(() => refs.filter((r) => r.type === 'head'), [refs]);
  const localNames = useMemo(() => new Set(allHeads.filter((r) => !r.archived).map((r) => r.name)), [allHeads]);
  // Stacked branches are listed under their parent; pinned ones on top; archived ones separately.
  const stackChildren = useMemo(() => {
    const m = new Map<string, Ref[]>();
    for (const r of allHeads) if (r.parent && !r.archived && localNames.has(r.parent) && r.parent !== r.name) m.set(r.parent, [...(m.get(r.parent) ?? []), r]);
    for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [allHeads, localNames]);
  // Branches reachable from a root of the stack forest; members of a parent cycle (hand-edited
  // config) aren't, and are listed normally instead of disappearing.
  const nested = useMemo(() => {
    const out = new Set<string>();
    const visit = (name: string) => {
      for (const c of stackChildren.get(name) ?? []) {
        if (out.has(c.name)) continue;
        out.add(c.name);
        visit(c.name);
      }
    };
    for (const r of allHeads) if (!r.archived && !(r.parent && localNames.has(r.parent) && r.parent !== r.name)) visit(r.name);
    return out;
  }, [allHeads, stackChildren, localNames]);
  const isStacked = (r: Ref) => nested.has(r.name);
  // The checked-out branch is never tucked away in Archived.
  const isArchived = (r: Ref) => !!r.archived && !r.current;
  const pinned = useMemo(() => allHeads.filter((r) => r.pinned && !isArchived(r)).sort((a, b) => a.name.localeCompare(b.name)), [allHeads]);
  const archived = useMemo(() => allHeads.filter(isArchived), [allHeads]);
  const heads = useMemo(() => allHeads.filter((r) => !isArchived(r) && !r.pinned && (f ? true : !isStacked(r))), [allHeads, f, nested]);
  const tags = useMemo(() => refs.filter((r) => r.type === 'tag').sort((a, b) => b.date - a.date), [refs]);
  const headTree = useMemo(() => buildTree(heads.filter(match), (r) => r.name), [heads, f]);
  const archivedTree = useMemo(() => buildTree(archived.filter(match), (r) => r.name), [archived, f]);
  const tagTree = useMemo(() => buildTree(tags.filter(match), (r) => r.name), [tags, f]);
  const remoteTrees = useMemo(
    () =>
      remotes.map((rm) => ({
        remote: rm,
        tree: buildTree(
          refs.filter((r) => r.type === 'remote' && r.remote === rm.name && match(r)),
          (r) => r.name.slice(rm.name.length + 1),
        ),
      })),
    [remotes, refs, f],
  );

  const changes = status?.files.length ?? 0;
  const isActive = (v: View) => {
    if (v.kind !== view.kind) return false;
    if (v.kind === 'history' && view.kind === 'history') return (v.ref ?? '') === (view.ref ?? '');
    if (v.kind === 'reflog' && view.kind === 'reflog') return (v.ref ?? '') === (view.ref ?? '');
    return true;
  };

  const renderTree = (node: TreeNode, depth: number, keyPrefix: string, icon: ReactNode): ReactNode[] => {
    const entries = [...node.children.values()].sort((a, b) => {
      const af = a.children.size > 0 && !a.ref;
      const bf = b.children.size > 0 && !b.ref;
      if (af !== bf) return af ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    if (keyPrefix.startsWith('tag:')) entries.sort((a, b) => (b.ref?.date ?? 0) - (a.ref?.date ?? 0));
    return entries.flatMap((child) => {
      const key = `${keyPrefix}${child.path}`;
      const out: ReactNode[] = [];
      if (child.ref) out.push(...renderRef(child.ref, child.name, depth, key, icon));
      if (child.children.size) {
        const open = !collapsed.has(key) || !!f;
        out.push(
          <div key={key + '/'} className="sidebar-item folder" style={{ paddingLeft: 12 + depth * 14 }} onClick={() => toggle(key)}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Folder size={13} className="muted" />
            <span className="sidebar-label">{child.name}</span>
          </div>,
        );
        if (open) out.push(...renderTree(child, depth + 1, keyPrefix, icon));
      }
      return out;
    });
  };

  /** One branch/tag row, followed by the branches stacked on it (indented, newest stack first). */
  const renderRef = (r: Ref, label: string, depth: number, key: string, icon: ReactNode, seen = new Set<string>()): ReactNode[] => {
    const v: View = { kind: 'history', ref: r.ref, label: r.name };
    const out: ReactNode[] = [
      <div
        key={key}
        className={`sidebar-item ${isActive(v) ? 'active' : ''} ${r.current ? 'current' : ''}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => setView(v)}
        onDoubleClick={() => r.type !== 'tag' && !r.worktree && actions.checkout(r)}
        onContextMenu={(e) => refMenu(e, r)}
        title={[r.upstream ? `${r.name} → ${r.upstream}${r.upstreamGone ? ' (gone)' : ''}` : r.name, r.parent ? `stacked on ${r.parent}` : '', r.worktree ? `checked out in ${r.worktree}` : '']
          .filter(Boolean)
          .join('\n')}
      >
        {icon}
        <span className="sidebar-label">{label}</span>
        {r.current && <span className="current-dot" title="Checked out" />}
        {r.worktree && <FolderGit2 size={11} className="muted" />}
        {(!!r.ahead || !!r.behind) && (
          <span className="ahead-behind">
            {!!r.behind && <span title={`${r.behind} behind ${r.upstream}`}>↓{r.behind}</span>}
            {!!r.ahead && <span title={`${r.ahead} ahead of ${r.upstream}`}>↑{r.ahead}</span>}
          </span>
        )}
        {r.upstreamGone && <span className="gone-badge" title="Upstream branch was deleted">gone</span>}
      </div>,
    ];
    if (r.type === 'head' && !f && !seen.has(r.name)) {
      seen.add(r.name);
      // Members of a parent cycle are listed at the top level only.
      for (const c of (stackChildren.get(r.name) ?? []).filter(isStacked)) {
        out.push(...renderRef(c, c.name, depth + 1, `${key}>${c.name}`, <Layers size={13} className="ref-icon stack" />, seen));
      }
    }
    return out;
  };

  const section = (id: string, title: string, count: number, body: ReactNode, action?: ReactNode, closedByDefault = false) => {
    const open = (closedByDefault ? collapsed.has(`section-open:${id}`) : !collapsed.has(`section:${id}`)) || !!f;
    return (
      <div className="sidebar-section">
        <div className="sidebar-section-header" onClick={() => toggle(closedByDefault ? `section-open:${id}` : `section:${id}`)}>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <span>{title}</span>
          <span className="sidebar-count">{count || ''}</span>
          {action && (
            <span className="sidebar-section-action" onClick={(e) => e.stopPropagation()}>
              {action}
            </span>
          )}
        </div>
        {open && body}
      </div>
    );
  };

  return (
    <nav className="sidebar">
      <div className="sidebar-scroll">
        <div className="sidebar-section">
          <div className="sidebar-section-header static">Workspace</div>
          <SidebarItem icon={<Inbox size={14} />} label="Working Copy" active={isActive({ kind: 'working' })} badge={changes || undefined} onClick={() => setView({ kind: 'working' })} />
          <SidebarItem icon={<History size={14} />} label="History" active={isActive({ kind: 'history' })} onClick={() => setView({ kind: 'history' })} />
          <SidebarItem icon={<Archive size={14} />} label="Stashes" active={isActive({ kind: 'stashes' })} badge={stashes.length || undefined} muted onClick={() => setView({ kind: 'stashes' })} />
          <SidebarItem icon={<FolderTree size={14} />} label="Files" active={isActive({ kind: 'files' })} onClick={() => setView({ kind: 'files' })} />
          <SidebarItem icon={<GitPullRequest size={14} />} label="Pull Requests" active={isActive({ kind: 'pulls' })} onClick={() => setView({ kind: 'pulls' })} />
          <SidebarItem icon={<ListChecks size={14} />} label="Branches Review" active={isActive({ kind: 'branches' })} onClick={() => setView({ kind: 'branches' })} />
          <SidebarItem icon={<RotateCcw size={14} />} label="Reflog" active={isActive({ kind: 'reflog' })} onClick={() => setView({ kind: 'reflog' })} />
          <SidebarItem icon={<Settings size={14} />} label="Settings" active={isActive({ kind: 'settings' })} onClick={() => setView({ kind: 'settings' })} />
        </div>

        {section(
          'branches',
          'Branches',
          allHeads.length - archived.length,
          allHeads.length - archived.length ? (
            <>
              {pinned.filter(match).flatMap((r) => renderRef(r, r.name, 0, `pin:${r.name}`, <Pin size={13} className="ref-icon pinned" />))}
              {renderTree(headTree, 0, 'head:', <GitBranch size={13} className="ref-icon" />)}
            </>
          ) : (
            <div className="sidebar-empty">No branches yet</div>
          ),
          <button className="icon-button" title="New branch" onClick={() => actions.createBranch()}>
            <Plus size={13} />
          </button>,
        )}

        {archived.length > 0 &&
          section(
            'archived',
            'Archived',
            archived.length,
            renderTree(archivedTree, 0, 'archived:', <Archive size={13} className="ref-icon archived" />),
            undefined,
            true,
          )}

        {worktrees.length > 1 &&
          section(
            'worktrees',
            'Worktrees',
            worktrees.length,
            worktrees.map((wt) => (
              <div
                key={wt.path}
                className={`sidebar-item ${wt.current ? 'current' : ''}`}
                style={{ paddingLeft: 12 }}
                title={`${wt.path}${wt.branch ? `\n${wt.branch}` : wt.detached ? '\ndetached HEAD' : ''}${wt.prunable ? `\nmissing: ${wt.prunable}` : ''}`}
                onDoubleClick={() => !wt.current && !wt.prunable && app.openRepo(wt.path)}
                onContextMenu={(e) =>
                  ui.menu(e, [
                    { label: 'Open in New Tab', disabled: wt.current || !!wt.prunable, onClick: () => app.openRepo(wt.path) },
                    { label: 'Reveal in Finder', disabled: !!wt.prunable, onClick: () => api.reveal(wt.path).catch(() => undefined) },
                    { label: 'Copy Path', onClick: () => copyText(wt.path) },
                    'separator',
                    {
                      label: 'Remove Worktree…',
                      danger: true,
                      // The main worktree (listed first) can't be removed; the others can, locked ones with force.
                      disabled: wt.current || wt.bare || wt.path === worktrees[0]?.path,
                      onClick: () => actions.removeWorktree(wt),
                    },
                    { label: 'Prune Missing Worktrees', onClick: () => actions.pruneWorktrees() },
                  ])
                }
              >
                <FolderGit2 size={13} className="ref-icon" />
                <span className="sidebar-label">{wt.path.slice(wt.path.lastIndexOf('/') + 1)}</span>
                <span className="muted small sidebar-detail">{wt.branch ?? (wt.detached ? 'detached' : '')}</span>
                {wt.current && <span className="current-dot" title="This tab" />}
                {wt.prunable && <span className="gone-badge">missing</span>}
              </div>
            )),
          )}

        {section(
          'remotes',
          'Remotes',
          remotes.length,
          remotes.length ? (
            remoteTrees.map(({ remote, tree }) => {
              const key = `remote:${remote.name}`;
              const open = !collapsed.has(key) || !!f;
              return (
                <div key={remote.name}>
                  <div
                    className="sidebar-item folder"
                    style={{ paddingLeft: 12 }}
                    onClick={() => toggle(key)}
                    title={remote.fetchUrl}
                    onContextMenu={(e) =>
                      ui.menu(e, [
                        { label: `Fetch "${remote.name}"`, onClick: () => actions.fetch(remote.name) },
                        { label: 'Copy URL', onClick: () => copyText(remote.fetchUrl) },
                        'separator',
                        { label: `Remove "${remote.name}"…`, danger: true, onClick: () => actions.removeRemote(remote.name) },
                      ])
                    }
                  >
                    {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <Server size={13} className="muted" />
                    <span className="sidebar-label">{remote.name}</span>
                  </div>
                  {open && renderTree(tree, 1, `${key}/`, <Cloud size={13} className="ref-icon remote" />)}
                </div>
              );
            })
          ) : (
            <div className="sidebar-empty">
              No remotes —{' '}
              <button className="link-button" onClick={() => actions.addRemote()}>
                add one
              </button>
            </div>
          ),
          <button className="icon-button" title="Add remote" onClick={() => actions.addRemote()}>
            <Plus size={13} />
          </button>,
        )}

        {section(
          'tags',
          'Tags',
          tags.length,
          tags.length ? renderTree(tagTree, 0, 'tag:', <Tag size={13} className="ref-icon tag" />) : <div className="sidebar-empty">No tags</div>,
          <button className="icon-button" title="New tag" onClick={() => actions.createTag()}>
            <Plus size={13} />
          </button>,
        )}

        {submodules.length > 0 &&
          section(
            'submodules',
            'Submodules',
            submodules.length,
            submodules
              .filter((sm) => !f || sm.path.toLowerCase().includes(f))
              .map((sm) => (
                <div
                  key={sm.path}
                  className="sidebar-item"
                  style={{ paddingLeft: 12 }}
                  title={`${sm.path}\n${sm.url}\n${sm.state === 'ok' ? 'Up to date' : sm.state === 'modified' ? 'Checked-out commit differs from the recorded one' : sm.state === 'uninitialized' ? 'Not initialized — double-click to initialize' : 'Conflict'}`}
                  onDoubleClick={() => (sm.state === 'uninitialized' ? actions.updateSubmodule(sm.path) : app.openRepo(`${repo.path}/${sm.path}`))}
                  onContextMenu={(e) =>
                    ui.menu(e, [
                      { label: 'Open in New Tab', disabled: sm.state === 'uninitialized', onClick: () => app.openRepo(`${repo.path}/${sm.path}`) },
                      { label: sm.state === 'uninitialized' ? 'Initialize' : 'Update to Recorded Commit', onClick: () => actions.updateSubmodule(sm.path) },
                      'separator',
                      { label: 'Reveal in Finder', onClick: () => api.reveal(repo.path, sm.path).catch(() => undefined) },
                      { label: 'Copy URL', onClick: () => copyText(sm.url) },
                    ])
                  }
                >
                  <Package size={13} className="ref-icon" />
                  <span className="sidebar-label">{sm.path}</span>
                  <span className={`submodule-dot state-${sm.state}`} />
                </div>
              )),
            <button className="icon-button" title="Add submodule" onClick={() => actions.addSubmodule()}>
              <Plus size={13} />
            </button>,
          )}
      </div>
      <div className="sidebar-filter">
        <Search size={12} />
        <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setFilter('')} spellCheck={false} />
        {filter && (
          <button className="icon-button" onClick={() => setFilter('')}>
            <X size={12} />
          </button>
        )}
      </div>
    </nav>
  );
}

function SidebarItem({
  icon,
  label,
  active,
  badge,
  muted,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  badge?: number;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <div className={`sidebar-item ${active ? 'active' : ''}`} style={{ paddingLeft: 12 }} onClick={onClick}>
      <span className="sidebar-icon">{icon}</span>
      <span className="sidebar-label">{label}</span>
      {badge !== undefined && <span className={`sidebar-badge ${muted ? 'muted-badge' : ''}`}>{badge}</span>}
    </div>
  );
}
