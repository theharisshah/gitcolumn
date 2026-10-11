/** Folder tree for a flat list of changed files, with single-child folders compacted ("src/components"). */

export interface DirNode<T> {
  /** Full folder path without trailing slash ('' for the root) */
  path: string;
  /** Display name, possibly several compacted segments ("src/lib") */
  name: string;
  dirs: DirNode<T>[];
  files: T[];
}

export type TreeRow<T> =
  | { kind: 'dir'; path: string; name: string; depth: number; items: T[]; collapsed: boolean }
  | { kind: 'file'; item: T; depth: number };

export function buildPathTree<T>(items: T[], pathOf: (item: T) => string): DirNode<T> {
  const root: DirNode<T> = { path: '', name: '', dirs: [], files: [] };
  const index = new Map<string, DirNode<T>>([['', root]]);
  const dirFor = (dir: string): DirNode<T> => {
    let node = index.get(dir);
    if (node) return node;
    const slash = dir.lastIndexOf('/');
    const parent = dirFor(slash < 0 ? '' : dir.slice(0, slash));
    node = { path: dir, name: dir.slice(slash + 1), dirs: [], files: [] };
    parent.dirs.push(node);
    index.set(dir, node);
    return node;
  };
  for (const item of items) {
    // An untracked nested repository is reported as "dir/": it's an entry of its parent, not a folder to open.
    const p = pathOf(item).replace(/\/+$/, '');
    const slash = p.lastIndexOf('/');
    dirFor(slash < 0 ? '' : p.slice(0, slash)).files.push(item);
  }
  const compact = (node: DirNode<T>): DirNode<T> => {
    node.dirs = node.dirs.map((d) => {
      let c = d;
      while (!c.files.length && c.dirs.length === 1) {
        const only = c.dirs[0];
        c = { ...only, name: `${c.name}/${only.name}` };
      }
      return compact(c);
    });
    return node;
  };
  return compact(root);
}

/** Every file below a folder. */
export function descendants<T>(node: DirNode<T>): T[] {
  return [...node.files, ...node.dirs.flatMap(descendants)];
}

/** Visible rows, depth first: folders (sorted by name) before files (sorted by `compare`). */
export function flattenTree<T>(root: DirNode<T>, collapsed: ReadonlySet<string>, compare: (a: T, b: T) => number): TreeRow<T>[] {
  const rows: TreeRow<T>[] = [];
  const walk = (node: DirNode<T>, depth: number) => {
    for (const d of [...node.dirs].sort((a, b) => a.name.localeCompare(b.name))) {
      const isCollapsed = collapsed.has(d.path);
      rows.push({ kind: 'dir', path: d.path, name: d.name, depth, items: descendants(d), collapsed: isCollapsed });
      if (!isCollapsed) walk(d, depth + 1);
    }
    for (const f of [...node.files].sort(compare)) rows.push({ kind: 'file', item: f, depth });
  };
  walk(root, 0);
  return rows;
}
