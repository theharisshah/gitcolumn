import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell } from 'electron';
import { createApi, dispatch } from '../server/api';
import { configureGit } from '../server/git';

// Apps launched from Finder get a minimal PATH; borrow the login shell's so git hooks find node, etc.
if (process.platform === 'darwin' && !process.env.TERM_PROGRAM) {
  try {
    const shellPath = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 3000,
    });
    if (shellPath) process.env.PATH = shellPath.trim();
  } catch {
    process.env.PATH = ['/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(':');
  }
}

const api = createApi({
  electron: true,
  trash: async (paths) => {
    for (const p of paths) await shell.trashItem(p);
  },
  saveFile: async ({ title, defaultName, filters }) => {
    const win = BrowserWindow.getFocusedWindow();
    const opts: Electron.SaveDialogOptions = { title, defaultPath: path.join(app.getPath('downloads'), defaultName), filters };
    const result = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    return result.canceled ? null : result.filePath ?? null;
  },
  pickDirectory: async (title) => {
    const win = BrowserWindow.getFocusedWindow();
    const opts: Electron.OpenDialogOptions = { title, properties: ['openDirectory', 'createDirectory'] };
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return result.canceled ? null : result.filePaths[0] ?? null;
  },
});

ipcMain.handle('api', async (_event, method: string, args: unknown) => {
  try {
    return { ok: true, data: (await dispatch(api, method, args)) ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ---------------------------------------------------------------------------
// Askpass: git (HTTPS credentials) and ssh (passphrases, host keys) run a small
// script that connects back to this process, which asks the user in the window.
// ---------------------------------------------------------------------------

const ASKPASS_JS = `
const net = require('net');
const prompt = process.argv.slice(2).join(' ');
const sock = net.connect(process.env.GITCOLUMN_ASKPASS_SOCK);
let buf = '';
sock.on('connect', () => sock.write(JSON.stringify({ token: process.env.GITCOLUMN_ASKPASS_TOKEN, prompt }) + '\\n'));
sock.on('data', (d) => { buf += d; });
sock.on('end', () => {
  try {
    const r = JSON.parse(buf || '{}');
    if (r.ok) { process.stdout.write(String(r.value) + '\\n'); process.exit(0); }
  } catch {}
  process.exit(1);
});
sock.on('error', () => process.exit(1));
`;

function setupAskpass() {
  const token = randomBytes(24).toString('hex');
  const sock =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\gitcolumn-askpass-${process.pid}`
      : path.join(os.tmpdir(), `gitcolumn-askpass-${process.pid}.sock`);
  if (process.platform !== 'win32') rmSync(sock, { force: true });

  const pending = new Map<number, (value: string | null) => void>();
  let nextId = 1;

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('error', () => undefined);
    conn.on('data', async (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      let req: { token?: string; prompt?: string };
      try {
        req = JSON.parse(buf.slice(0, nl));
      } catch {
        return conn.end('{}');
      }
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (req.token !== token || !win) return conn.end('{}');
      const id = nextId++;
      const value = await new Promise<string | null>((resolve) => {
        pending.set(id, resolve);
        win.webContents.send('askpass:request', { id, prompt: String(req.prompt ?? '') });
        if (win.isMinimized()) win.restore();
        win.focus();
        setTimeout(() => pending.delete(id) && resolve(null), 5 * 60_000);
      });
      conn.end(JSON.stringify(value === null ? { ok: false } : { ok: true, value }));
    });
  });
  server.listen(sock, () => {
    if (process.platform !== 'win32') chmodSync(sock, 0o600);
  });

  ipcMain.on('askpass:reply', (_e, id: number, value: unknown) => {
    const resolve = pending.get(id);
    if (!resolve) return;
    pending.delete(id);
    resolve(typeof value === 'string' ? value : null);
  });

  const dir = path.join(app.getPath('userData'), 'askpass');
  mkdirSync(dir, { recursive: true });
  const js = path.join(dir, 'askpass.js');
  const script = path.join(dir, 'askpass.sh');
  writeFileSync(js, ASKPASS_JS);
  writeFileSync(script, '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "$GITCOLUMN_ASKPASS_NODE" "$GITCOLUMN_ASKPASS_JS" "$@"\n');
  chmodSync(script, 0o755);

  configureGit({
    GIT_ASKPASS: script,
    SSH_ASKPASS: script,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || ':0',
    GITCOLUMN_ASKPASS_NODE: process.execPath,
    GITCOLUMN_ASKPASS_JS: js,
    GITCOLUMN_ASKPASS_SOCK: sock,
    GITCOLUMN_ASKPASS_TOKEN: token,
  });

  app.on('will-quit', () => {
    server.close();
    if (process.platform !== 'win32') rmSync(sock, { force: true });
  });
}

// ---------------------------------------------------------------------------
// Window & menu
// ---------------------------------------------------------------------------

const devIcon = path.join(__dirname, '../build/icons/512x512.png');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'GitColumn',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    icon: process.platform === 'linux' && existsSync(devIcon) ? devIcon : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());

  // Open external links in the default browser instead of a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) e.preventDefault();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '../dist/index.html'));
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  // Command ids match the renderer's command registry (src/repo/commands.tsx).
  const send = (command: string) => () => BrowserWindow.getFocusedWindow()?.webContents.send('menu', command);
  const item = (label: string, accelerator: string | undefined, command: string): Electron.MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: send(command),
  });
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              item('Settings…', 'CmdOrCtrl+,', 'view.settings'),
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        item('Open Repository…', 'CmdOrCtrl+O', 'open'),
        ...(isMac ? [] : [item('Settings…', 'CmdOrCtrl+,', 'view.settings')]),
        { type: 'separator' },
        item('Export Files…', undefined, 'files.export'),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // Routed through the renderer so ⌘Z undoes git operations outside text fields.
        item('Undo', 'CmdOrCtrl+Z', 'edit.undo'),
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        item('Back', 'CmdOrCtrl+[', 'nav.back'),
        item('Forward', 'CmdOrCtrl+]', 'nav.forward'),
        { type: 'separator' },
        item('Working Copy', 'CmdOrCtrl+1', 'view.working'),
        item('History', 'CmdOrCtrl+2', 'view.history'),
        item('Stashes', 'CmdOrCtrl+3', 'view.stashes'),
        item('Files', 'CmdOrCtrl+4', 'view.files'),
        item('Pull Requests', 'CmdOrCtrl+5', 'view.pulls'),
        item('Reflog', 'CmdOrCtrl+6', 'view.reflog'),
        item('Branches Review', 'CmdOrCtrl+7', 'view.branches'),
        { type: 'separator' },
        item('Quick Actions…', 'CmdOrCtrl+Shift+A', 'palette.open'),
        item('Refresh', 'CmdOrCtrl+R', 'repo.refresh'),
        { type: 'separator' },
        { role: 'reload', accelerator: 'CmdOrCtrl+Alt+R' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Repository',
      submenu: [
        item('Fetch', 'CmdOrCtrl+Shift+F', 'repo.fetch'),
        item('Pull', 'CmdOrCtrl+Shift+L', 'repo.pull'),
        item('Push', 'CmdOrCtrl+Shift+P', 'repo.push'),
        { type: 'separator' },
        item('New Branch…', 'CmdOrCtrl+Shift+B', 'branch.new'),
        item('Stash Changes…', 'CmdOrCtrl+Shift+S', 'stash.save'),
        { type: 'separator' },
        item('Create Pull Request…', undefined, 'pr.create'),
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName('GitColumn');
nativeTheme.themeSource = 'system';

// One process per profile: two backends would race on the same repositories' undo journals.
// (Development builds skip it so they can run next to an installed copy.)
const primaryInstance = !app.isPackaged || app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  if (!primaryInstance) return;
  if (process.platform === 'darwin' && !app.isPackaged && existsSync(devIcon)) {
    app.dock?.setIcon(nativeImage.createFromPath(devIcon));
  }
  app.setAboutPanelOptions({
    applicationName: 'GitColumn',
    applicationVersion: app.getVersion(),
    copyright: 'A Tower-style Git client',
  });
  setupAskpass();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
