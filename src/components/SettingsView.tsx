import { HardDrive, Package, Settings as SettingsIcon, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { LfsFile, LfsStatus } from '../../shared/types';
import { useApp } from '../AppContext';
import { api } from '../lib/api';
import { getSetting, setSetting, type Settings } from '../lib/settings';
import { useActions } from '../repo/actions';
import { useRepo } from '../repo/RepoContext';
import { useUI } from '../ui/UIProvider';

function Section({ title, icon, children, description }: { title: string; icon?: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>
        {icon}
        {title}
      </h3>
      {description && <p className="settings-description">{description}</p>}
      {children}
    </section>
  );
}

export function SettingsView() {
  const { repo, setView } = useRepo();
  return (
    <div className="settings-view">
      <div className="pane-header">
        <SettingsIcon size={14} className="muted" />
        <span className="pane-title">Settings — {repo.name}</span>
        <span className="spacer" />
        <button className="icon-button" title="Close" onClick={() => setView({ kind: 'working' })}>
          <X size={14} />
        </button>
      </div>
      <div className="settings-scroll">
        <div className="settings-inner">
          <IdentitySection />
          <RemotesSection />
          <BehaviorSection />
          <LfsSection />
          <SubmodulesSection />
          <IgnoreSection />
        </div>
      </div>
    </div>
  );
}

function IdentitySection() {
  const { repo, run } = useRepo();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [local, setLocal] = useState(false);
  const [loaded, setLoaded] = useState<{ name: string; email: string } | null>(null);

  useEffect(() => {
    api.identity(repo.path).then((id) => {
      setName(id.name);
      setEmail(id.email);
      setLoaded(id);
    });
  }, [repo.path]);

  const dirty = loaded && (name !== loaded.name || email !== loaded.email || local);
  return (
    <Section title="Commit Author" description="Git records this name and email on every commit you make.">
      <div className="settings-grid">
        <label className="field">
          <span className="field-label">Name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ada Lovelace" />
        </label>
        <label className="field">
          <span className="field-label">Email</span>
          <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ada@example.com" />
        </label>
      </div>
      <div className="settings-row">
        <label className="toggle">
          <input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} />
          Only for this repository
        </label>
        <span className="spacer" />
        <button
          className="button button-primary button-small"
          disabled={!dirty || !name.trim() || !email.trim()}
          onClick={async () => {
            await run('Saving identity…', () => api.setIdentity(repo.path, name.trim(), email.trim(), !local), { success: 'Commit author saved' });
            setLoaded({ name: name.trim(), email: email.trim() });
            setLocal(false);
          }}
        >
          Save
        </button>
      </div>
    </Section>
  );
}

function RemotesSection() {
  const { repo, remotes, run } = useRepo();
  const actions = useActions();
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => setUrls(Object.fromEntries(remotes.map((r) => [r.name, r.fetchUrl]))), [remotes]);

  return (
    <Section title="Remotes" description="Servers this repository fetches from and pushes to.">
      {remotes.length ? (
        <div className="settings-list">
          {remotes.map((r) => (
            <div key={r.name} className="settings-list-row">
              <span className="remote-name">{r.name}</span>
              <input className="input mono" value={urls[r.name] ?? ''} onChange={(e) => setUrls((u) => ({ ...u, [r.name]: e.target.value }))} spellCheck={false} />
              <button
                className="button button-small"
                disabled={!urls[r.name]?.trim() || urls[r.name] === r.fetchUrl}
                onClick={() => run('Updating remote…', () => api.setRemoteUrl(repo.path, r.name, urls[r.name].trim()), { success: `Updated ${r.name}` })}
              >
                Save
              </button>
              <button className="button button-small button-danger-outline" onClick={() => actions.removeRemote(r.name)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted small">No remotes yet.</p>
      )}
      <div className="settings-row">
        <button className="button button-small" onClick={() => actions.addRemote()}>
          Add Remote…
        </button>
      </div>
    </Section>
  );
}

function BehaviorSection() {
  const [s, setS] = useState<Settings>(() => ({
    pullRebase: getSetting('pullRebase'),
    autoFetchMinutes: getSetting('autoFetchMinutes'),
    syntaxHighlighting: getSetting('syntaxHighlighting'),
  }));
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setSetting(k, v);
    setS((prev) => ({ ...prev, [k]: v }));
  };
  return (
    <Section title="Behavior" description="These preferences apply to all repositories.">
      <div className="settings-grid">
        <label className="field">
          <span className="field-label">When pulling</span>
          <select className="input" value={s.pullRebase ? 'rebase' : 'merge'} onChange={(e) => set('pullRebase', e.target.value === 'rebase')}>
            <option value="merge">Merge remote changes</option>
            <option value="rebase">Rebase onto remote changes</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Fetch automatically</span>
          <select className="input" value={s.autoFetchMinutes} onChange={(e) => set('autoFetchMinutes', Number(e.target.value))}>
            <option value={0}>Never</option>
            <option value={5}>Every 5 minutes</option>
            <option value={10}>Every 10 minutes</option>
            <option value={15}>Every 15 minutes</option>
            <option value={30}>Every 30 minutes</option>
          </select>
        </label>
      </div>
      <label className="toggle settings-row">
        <input type="checkbox" checked={s.syntaxHighlighting} onChange={(e) => set('syntaxHighlighting', e.target.checked)} />
        Syntax highlighting in diffs and blame
      </label>
    </Section>
  );
}

function LfsSection() {
  const { repo, run, version } = useRepo();
  const ui = useUI();
  const [status, setStatus] = useState<LfsStatus | null>(null);
  const [files, setFiles] = useState<LfsFile[] | null>(null);
  const [pattern, setPattern] = useState('');

  useEffect(() => {
    api.lfsStatus(repo.path).then((s) => {
      setStatus(s);
      if (s.installed) api.lfsFiles(repo.path).then(setFiles, () => setFiles(null));
    });
  }, [repo.path, version]);

  if (!status) return null;
  const downloaded = files?.filter((f) => f.downloaded).length ?? 0;
  return (
    <Section
      title="Git LFS"
      icon={<HardDrive size={14} />}
      description="Large File Storage keeps big binaries (designs, videos, datasets) outside the repository history."
    >
      {!status.installed ? (
        <div className="settings-callout">
          Git LFS isn’t installed on this computer. Install it with <code>brew install git-lfs</code> (macOS), then reopen this page.
          {status.patterns.length > 0 && (
            <div className="settings-callout-warn">
              This repository tracks {status.patterns.length} pattern{status.patterns.length === 1 ? '' : 's'} with LFS — those files will appear as small pointer files until LFS is installed.
            </div>
          )}
        </div>
      ) : (
        <p className="muted small">
          {status.version}
          {files && ` · ${files.length} LFS file${files.length === 1 ? '' : 's'}, ${downloaded} downloaded`}
        </p>
      )}
      {status.patterns.length > 0 && (
        <div className="settings-list">
          {status.patterns.map((p) => (
            <div key={p} className="settings-list-row">
              <code className="lfs-pattern">{p}</code>
              <span className="spacer" />
              {status.installed && (
                <button className="button button-small" onClick={() => run('Untracking…', () => api.lfsUntrack(repo.path, p), { success: `Stopped tracking ${p}` })}>
                  Untrack
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {status.installed && (
        <>
          <div className="settings-row">
            <input
              className="input mono"
              placeholder="*.psd"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && pattern.trim() && document.getElementById('lfs-track')?.click()}
            />
            <button
              id="lfs-track"
              className="button button-small"
              disabled={!pattern.trim()}
              onClick={async () => {
                await run('Tracking…', () => api.lfsTrack(repo.path, pattern.trim()), { success: `Tracking ${pattern.trim()} with LFS — commit .gitattributes` });
                setPattern('');
              }}
            >
              Track Pattern
            </button>
          </div>
          <div className="settings-row">
            <button className="button button-small" onClick={() => run('Installing LFS hooks…', () => api.lfsInstall(repo.path), { success: 'Git LFS set up for this repository' })}>
              Set Up for This Repository
            </button>
            <button
              className="button button-small"
              onClick={() => run('Downloading LFS files…', () => api.lfsPull(repo.path), { success: 'LFS files downloaded' }).catch((e) => ui.toast('error', 'LFS pull failed', String(e)))}
            >
              Download LFS Files
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

function SubmodulesSection() {
  const { repo, submodules } = useRepo();
  const actions = useActions();
  const app = useApp();
  return (
    <Section title="Submodules" icon={<Package size={14} />} description="Other repositories embedded in this one at a fixed commit.">
      {submodules.length ? (
        <div className="settings-list">
          {submodules.map((s) => (
            <div key={s.path} className="settings-list-row">
              <span className={`submodule-dot state-${s.state}`} title={s.state} />
              <span className="submodule-path">{s.path}</span>
              <span className="muted small submodule-url">{s.url}</span>
              <span className="spacer" />
              <button className="button button-small" onClick={() => actions.updateSubmodule(s.path)}>
                {s.state === 'uninitialized' ? 'Initialize' : 'Update'}
              </button>
              <button className="button button-small" disabled={s.state === 'uninitialized'} onClick={() => app.openRepo(`${repo.path}/${s.path}`)}>
                Open
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted small">This repository has no submodules.</p>
      )}
      <div className="settings-row">
        <button className="button button-small" onClick={() => actions.addSubmodule()}>
          Add Submodule…
        </button>
        {submodules.length > 0 && (
          <button className="button button-small" onClick={() => actions.updateSubmodule()}>
            Update All
          </button>
        )}
      </div>
    </Section>
  );
}

function IgnoreSection() {
  const { repo, run } = useRepo();
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  useEffect(() => {
    api
      .readFile(repo.path, '.gitignore')
      .then((f) => {
        setContent(f.content);
        setSaved(f.content);
      })
      .catch(() => {
        setContent('');
        setSaved('');
      });
  }, [repo.path]);
  if (content === null) return null;
  return (
    <Section title="Ignored Files" description={<>Patterns in <code>.gitignore</code> are never shown as changes.</>}>
      <textarea className="input mono gitignore-editor" rows={8} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} placeholder={'node_modules/\n.DS_Store\n*.log'} />
      <div className="settings-row">
        <span className="spacer" />
        <button
          className="button button-primary button-small"
          disabled={content === saved}
          onClick={async () => {
            await run('Saving .gitignore…', () => api.writeGitignore(repo.path, content), { success: '.gitignore saved' });
            setSaved(content);
          }}
        >
          Save .gitignore
        </button>
      </div>
    </Section>
  );
}
