import { Plus, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AppInfo, RepoInfo } from '../shared/types';
import { RepoWindow } from './components/RepoWindow';
import { Welcome, type Recent } from './components/Welcome';
import { api, isElectron } from './lib/api';
import { repoNameFromUrl, tildify } from './lib/format';
import { UIProvider, useUI, type MenuItem } from './ui/UIProvider';

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

export function App() {
  return (
    <UIProvider>
      <Shell />
    </UIProvider>
  );
}

function Shell() {
  const ui = useUI();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [tabs, setTabs] = useState<RepoInfo[]>(() => load('gitcolumn.tabs', []));
  const [active, setActive] = useState<string | null>(() => load('gitcolumn.active', null));
  const [recents, setRecents] = useState<Recent[]>(() => load('gitcolumn.recents', []));

  useEffect(() => {
    api.appInfo().then(setInfo).catch(() => undefined);
  }, []);
  useEffect(() => save('gitcolumn.tabs', tabs), [tabs]);
  useEffect(() => save('gitcolumn.active', active), [active]);
  useEffect(() => save('gitcolumn.recents', recents), [recents]);
  useEffect(() => {
    if (active && !tabs.some((t) => t.path === active)) setActive(tabs[0]?.path ?? null);
  }, [tabs, active]);

  const activeRepo = tabs.find((t) => t.path === active);
  useEffect(() => {
    document.title = activeRepo ? `${activeRepo.name} — GitColumn` : 'GitColumn';
  }, [activeRepo]);

  const addRepo = useCallback((repo: RepoInfo) => {
    setTabs((t) => (t.some((x) => x.path === repo.path) ? t : [...t, repo]));
    setActive(repo.path);
    setRecents((r) => [{ ...repo, opened: Date.now() }, ...r.filter((x) => x.path !== repo.path)].slice(0, 20));
  }, []);

  const openPath = useCallback(
    async (path: string) => {
      try {
        addRepo(await api.openRepo(path));
      } catch (e) {
        ui.toast('error', 'Could not open repository', e instanceof Error ? e.message : String(e));
      }
    },
    [addRepo, ui],
  );

  const defaultParent = () => {
    const last = recents[0]?.path;
    if (last) return last.slice(0, last.lastIndexOf('/')) || '/';
    return info?.home ?? '~';
  };

  const browse = (title: string) => async () => {
    const p = await api.pickDirectory(title);
    return p ? { parent: p } : undefined;
  };

  const openDialog = async () => {
    if (isElectron) {
      const p = await api.pickDirectory('Open Repository');
      if (p) openPath(p);
      return;
    }
    const v = await ui.form({
      title: 'Open Repository',
      message: 'Enter the path to a folder that contains a Git repository.',
      fields: [{ name: 'path', label: 'Folder', value: tildify(defaultParent(), info?.home) + '/', mono: true, required: true }],
      confirmLabel: 'Open',
    });
    if (v) openPath(String(v.path));
  };

  const cloneDialog = async () => {
    const v = await ui.form({
      title: 'Clone Repository',
      fields: [
        { name: 'url', label: 'Repository URL', placeholder: 'https://github.com/user/repo.git', mono: true, required: true },
        { name: 'parent', label: 'Save in folder', value: tildify(defaultParent(), info?.home), mono: true, required: true, action: isElectron ? { label: 'Browse…', run: browse('Clone Into') } : undefined },
        { name: 'name', label: 'Folder name', mono: true, required: true },
      ],
      onChange: (name, values) => (name === 'url' ? { name: repoNameFromUrl(String(values.url)) } : undefined),
      confirmLabel: 'Clone',
    });
    if (!v) return;
    const dest = `${String(v.parent).replace(/\/+$/, '')}/${String(v.name).trim()}`;
    const toastLabel = `Cloning ${String(v.name)}…`;
    ui.toast('info', toastLabel, 'This may take a while for large repositories.');
    try {
      addRepo(await api.cloneRepo(String(v.url).trim(), dest));
      ui.toast('success', `Cloned ${String(v.name)}`);
    } catch (e) {
      ui.toast('error', 'Clone failed', e instanceof Error ? e.message : String(e));
    }
  };

  const initDialog = async () => {
    const v = await ui.form({
      title: 'New Repository',
      fields: [
        { name: 'parent', label: 'Location', value: tildify(defaultParent(), info?.home), mono: true, required: true, action: isElectron ? { label: 'Browse…', run: browse('Create In') } : undefined },
        { name: 'name', label: 'Name', placeholder: 'my-project', mono: true, required: true },
      ],
      confirmLabel: 'Create',
    });
    if (!v) return;
    try {
      addRepo(await api.initRepo(`${String(v.parent).replace(/\/+$/, '')}/${String(v.name).trim()}`));
    } catch (e) {
      ui.toast('error', 'Could not create repository', e instanceof Error ? e.message : String(e));
    }
  };

  const closeTab = (path: string) => {
    const idx = tabs.findIndex((x) => x.path === path);
    const next = tabs.filter((x) => x.path !== path);
    setTabs(next);
    if (active === path) setActive(next[Math.min(idx, next.length - 1)]?.path ?? null);
  };

  const repoMenu = (e: React.MouseEvent) => {
    const others = recents.filter((r) => r.path !== active).slice(0, 8);
    const items: MenuItem[] = [];
    if (others.length) {
      items.push({ header: 'Recent' });
      for (const r of others) items.push({ label: r.name, onClick: () => openPath(r.path) });
      items.push('separator');
    }
    items.push(
      { label: 'Open Repository…', shortcut: '⌘O', onClick: openDialog },
      { label: 'Clone Repository…', onClick: cloneDialog },
      { label: 'New Repository…', onClick: initDialog },
      'separator',
      { label: 'Show Welcome Screen', onClick: () => setActive(null) },
    );
    if (active) items.push({ label: 'Close Repository', onClick: () => closeTab(active) });
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    ui.menu({ clientX: r.left, clientY: r.bottom + 4 }, items);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        openDialog();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const tabBar =
    tabs.length > 1 || (tabs.length && !active) ? (
      <div className="tab-bar">
        {tabs.map((t) => (
          <div key={t.path} className={`tab ${t.path === active ? 'active' : ''}`} onClick={() => setActive(t.path)} title={t.path}>
            <span className="tab-label">{t.name}</span>
            <button
              className="icon-button tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.path);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button className="icon-button tab-add" title="Open another repository" onClick={() => setActive(null)}>
          <Plus size={14} />
        </button>
      </div>
    ) : null;

  return (
    <div className="app">
      {tabs.map((t) => (
        <RepoWindow key={t.path} repo={t} active={t.path === active} tabs={tabBar} onRepoMenu={repoMenu} onClose={() => closeTab(t.path)} />
      ))}
      {!activeRepo && (
        <>
          {tabBar && <div className={`welcome-tabs ${isElectron ? 'electron' : ''}`}>{tabBar}</div>}
          <Welcome
            info={info}
            recents={recents}
            onOpen={openDialog}
            onOpenPath={openPath}
            onClone={cloneDialog}
            onInit={initDialog}
            onRemoveRecent={(p) => setRecents((r) => r.filter((x) => x.path !== p))}
          />
        </>
      )}
    </div>
  );
}
