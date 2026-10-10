import { Archive, ChevronDown, ChevronRight, Cloud, Folder, GitBranch, History, Inbox, Plus, Search, Server, Tag, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { Ref } from '../../shared/types';
import { copyText } from '../lib/format';
import { useActions } from '../repo/actions';
import { useRepo, type View } from '../repo/RepoContext';
import { useUI, type MenuItem } from '../ui/UIProvider';

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
  const { status, refs, remotes, stashes, view, setView } = useRepo();
  const actions = useActions();
  const ui = useUI();
  const { collapsed, toggle } = useCollapsed();
  const [filter, setFilter] = useState('');

  const f = filter.trim().toLowerCase();
  const match = (r: Ref) => !f || r.name.toLowerCase().includes(f);
  const heads = useMemo(() => refs.filter((r) => r.type === 'head'), [refs]);
  const tags = useMemo(() => refs.filter((r) => r.type === 'tag').sort((a, b) => b.date - a.date), [refs]);
  const headTree = useMemo(() => buildTree(heads.filter(match), (r) => r.name), [heads, f]);
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
    return true;
  };

  const refMenu = (e: React.MouseEvent, r: Ref) => {
    const branch = status?.branch;
    const items: MenuItem[] = [];
    if (r.type === 'head') {
      if (!r.current) items.push({ label: `Check Out "${r.name}"`, onClick: () => actions.checkout(r) });
      if (branch && !r.current) {
        items.push({ label: `Merge "${r.name}" into "${branch}"…`, onClick: () => actions.merge(r.name) });
        items.push({ label: `Rebase "${branch}" onto "${r.name}"…`, onClick: () => actions.rebase(r.name) });
      }
      items.push('separator');
      items.push({ label: `Push "${r.name}"…`, onClick: () => actions.push(r.name) });
      if (r.upstream) items.push({ label: `Force Push "${r.name}"…`, onClick: () => actions.push(r.name, { force: true }) });
      items.push({ label: 'Track Remote Branch…', onClick: () => actions.setUpstream(r) });
      items.push('separator');
      items.push({ label: `New Branch from "${r.name}"…`, onClick: () => actions.createBranch(r.name) });
      items.push({ label: `New Tag on "${r.name}"…`, onClick: () => actions.createTag(r.name, r.name) });
      items.push({ label: 'Rename…', onClick: () => actions.renameBranch(r) });
      items.push({ label: `Delete "${r.name}"…`, danger: true, disabled: r.current, onClick: () => actions.deleteBranch(r) });
    } else if (r.type === 'remote') {
      items.push({ label: `Check Out "${r.name}"`, onClick: () => actions.checkout(r) });
      if (branch) {
        items.push({ label: `Merge "${r.name}" into "${branch}"…`, onClick: () => actions.merge(r.name) });
        items.push({ label: `Rebase "${branch}" onto "${r.name}"…`, onClick: () => actions.rebase(r.name) });
      }
      items.push('separator');
      items.push({ label: `New Branch from "${r.name}"…`, onClick: () => actions.createBranch(r.name) });
      items.push({ label: `Delete "${r.name}" on Remote…`, danger: true, onClick: () => actions.deleteRemoteBranch(r) });
    } else {
      items.push({ label: `Check Out "${r.name}"…`, onClick: () => actions.checkout(r) });
      items.push({ label: `New Branch from "${r.name}"…`, onClick: () => actions.createBranch(r.name) });
      if (remotes.length) items.push({ label: `Push Tag to ${remotes[0].name}`, onClick: () => actions.pushTag(r.name) });
      items.push('separator');
      items.push({ label: `Delete Tag "${r.name}"…`, danger: true, onClick: () => actions.deleteTag(r.name) });
    }
    items.push('separator', { label: 'Copy Name', onClick: () => copyText(r.name) });
    ui.menu(e, items);
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
      if (child.ref) {
        const r = child.ref;
        const v: View = { kind: 'history', ref: r.ref, label: r.name };
        out.push(
          <div
            key={key}
            className={`sidebar-item ${isActive(v) ? 'active' : ''} ${r.current ? 'current' : ''}`}
            style={{ paddingLeft: 12 + depth * 14 }}
            onClick={() => setView(v)}
            onDoubleClick={() => r.type !== 'tag' && actions.checkout(r)}
            onContextMenu={(e) => refMenu(e, r)}
            title={r.upstream ? `${r.name} → ${r.upstream}${r.upstreamGone ? ' (gone)' : ''}` : r.name}
          >
            {icon}
            <span className="sidebar-label">{child.name}</span>
            {r.current && <span className="current-dot" title="Checked out" />}
            {(!!r.ahead || !!r.behind) && (
              <span className="ahead-behind">
                {!!r.behind && <span title={`${r.behind} behind ${r.upstream}`}>↓{r.behind}</span>}
                {!!r.ahead && <span title={`${r.ahead} ahead of ${r.upstream}`}>↑{r.ahead}</span>}
              </span>
            )}
            {r.upstreamGone && <span className="gone-badge" title="Upstream branch was deleted">gone</span>}
          </div>,
        );
      }
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

  const section = (id: string, title: string, count: number, body: ReactNode, action?: ReactNode) => {
    const open = !collapsed.has(`section:${id}`) || !!f;
    return (
      <div className="sidebar-section">
        <div className="sidebar-section-header" onClick={() => toggle(`section:${id}`)}>
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
        </div>

        {section(
          'branches',
          'Branches',
          heads.length,
          heads.length ? renderTree(headTree, 0, 'head:', <GitBranch size={13} className="ref-icon" />) : <div className="sidebar-empty">No branches yet</div>,
          <button className="icon-button" title="New branch" onClick={() => actions.createBranch()}>
            <Plus size={13} />
          </button>,
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
