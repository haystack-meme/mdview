import { app, BrowserWindow, dialog, ipcMain, Menu, shell, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

interface Doc {
  win: BrowserWindow;
  path: string | null;
  lastContent: string; // content as last read from / written to disk
  dirty: boolean;
  editing: boolean;
  watcher: fs.FSWatcher | null;
  watchTimer: NodeJS.Timeout | null;
  forceClose: boolean;
}

// AppImages can't ship a setuid chrome-sandbox, and Ubuntu 24.04+ blocks the
// user-namespace sandbox for unconfined apps, so Electron would abort at start.
if (process.env.APPIMAGE) app.commandLine.appendSwitch('no-sandbox');

const ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');

const docs = new Map<number, Doc>(); // keyed by webContents id

const MD_EXT = /\.(md|markdown|mdown|mkd|mkdn)$/i;

function docFor(e: IpcMainEvent | IpcMainInvokeEvent): Doc | undefined {
  return docs.get(e.sender.id);
}

function findByPath(p: string): Doc | undefined {
  for (const d of docs.values()) if (d.path === p) return d;
  return undefined;
}

function updateTitle(doc: Doc) {
  const name = doc.path ? path.basename(doc.path) : 'Untitled';
  doc.win.setTitle(`${doc.dirty ? '• ' : ''}${name} — mdview`);
}

function info(doc: Doc) {
  return {
    path: doc.path,
    content: doc.lastContent,
    baseUrl: doc.path ? pathToFileURL(path.dirname(doc.path)).href + '/' : null,
  };
}

function watch(doc: Doc) {
  doc.watcher?.close();
  doc.watcher = null;
  if (!doc.path) return;
  const file = doc.path;
  try {
    // Watch the folder, not the file: editors often save by replacing the file.
    doc.watcher = fs.watch(path.dirname(file), (_ev, name) => {
      if (name && name.toString() !== path.basename(file)) return;
      if (doc.watchTimer) clearTimeout(doc.watchTimer);
      doc.watchTimer = setTimeout(() => {
        let content: string;
        try {
          content = fs.readFileSync(file, 'utf8');
        } catch {
          return; // deleted or mid-write; ignore
        }
        if (content === doc.lastContent) return;
        doc.lastContent = content;
        if (!doc.win.isDestroyed()) doc.win.webContents.send('doc:external-change', content);
      }, 150);
    });
  } catch {
    /* folder not watchable */
  }
}

function openWindow(filePath: string | null) {
  if (filePath) {
    filePath = path.resolve(filePath);
    const existing = findByPath(filePath);
    if (existing) {
      if (existing.win.isMinimized()) existing.win.restore();
      existing.win.focus();
      return;
    }
  }

  let content = '';
  if (filePath) {
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        dialog.showErrorBox('mdview', `Could not open ${filePath}:\n${(err as Error).message}`);
        return;
      }
      // Non-existent path: open empty, it will be created on save.
    }
  }

  const win = new BrowserWindow({
    width: 900,
    height: 1000,
    show: false,
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  const doc: Doc = {
    win,
    path: filePath,
    lastContent: content,
    dirty: false,
    editing: false,
    watcher: null,
    watchTimer: null,
    forceClose: false,
  };
  const id = win.webContents.id;
  docs.set(id, doc);
  updateTitle(doc);
  watch(doc);

  // Keep the window on our page; links are handled via link:open.
  // Keep our own title instead of the page's <title>.
  win.on('page-title-updated', (e) => e.preventDefault());
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.on('close', (e) => {
    if (doc.forceClose || !doc.dirty) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `Save changes to ${doc.path ? path.basename(doc.path) : 'Untitled'}?`,
      detail: 'Your changes will be lost if you don\'t save them.',
    });
    if (choice === 1) return;
    e.preventDefault();
    if (choice === 0) {
      win.webContents.send('menu', 'save-and-close');
    }
  });
  win.on('closed', () => {
    doc.watcher?.close();
    if (doc.watchTimer) clearTimeout(doc.watchTimer);
    docs.delete(id);
  });
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

function writeDoc(doc: Doc, target: string, content: string) {
  try {
    fs.writeFileSync(target, content, 'utf8');
  } catch (err) {
    dialog.showErrorBox('mdview', `Could not save ${target}:\n${(err as Error).message}`);
    return null;
  }
  const changedPath = doc.path !== target;
  doc.path = target;
  doc.lastContent = content;
  doc.dirty = false;
  updateTitle(doc);
  if (changedPath) watch(doc);
  return info(doc);
}

async function saveAs(doc: Doc, content: string) {
  const res = await dialog.showSaveDialog(doc.win, {
    defaultPath: doc.path ?? path.join(app.getPath('documents'), 'Untitled.md'),
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
  });
  if (res.canceled || !res.filePath) return null;
  let target = res.filePath;
  if (!path.extname(target)) target += '.md';
  const other = findByPath(target);
  if (other && other !== doc) {
    dialog.showErrorBox('mdview', `${target} is already open in another window.`);
    return null;
  }
  return writeDoc(doc, target, content);
}

ipcMain.handle('doc:init', (e) => {
  const doc = docFor(e);
  return doc ? info(doc) : null;
});

ipcMain.handle('doc:save', async (e, content: string) => {
  const doc = docFor(e);
  if (!doc) return null;
  return doc.path ? writeDoc(doc, doc.path, content) : saveAs(doc, content);
});

ipcMain.handle('doc:save-as', async (e, content: string) => {
  const doc = docFor(e);
  return doc ? saveAs(doc, content) : null;
});

ipcMain.on('doc:closed-after-save', (e) => {
  const doc = docFor(e);
  if (doc) {
    doc.forceClose = true;
    doc.win.close();
  }
});

ipcMain.on('doc:dirty', (e, dirty: boolean) => {
  const doc = docFor(e);
  if (!doc) return;
  doc.dirty = dirty;
  updateTitle(doc);
});

ipcMain.on('doc:editing', (e, editing: boolean) => {
  const doc = docFor(e);
  if (doc) doc.editing = editing;
});

ipcMain.handle('doc:confirm-reload', (e) => {
  const doc = docFor(e);
  if (!doc) return false;
  const choice = dialog.showMessageBoxSync(doc.win, {
    type: 'question',
    buttons: ['Reload', 'Keep My Edits'],
    defaultId: 1,
    cancelId: 1,
    message: `${doc.path ? path.basename(doc.path) : 'This file'} was changed by another program.`,
    detail: 'Reload it and discard your edits?',
  });
  return choice === 0;
});

ipcMain.on('link:open', (e, href: string) => {
  const doc = docFor(e);
  if (!doc) return;
  let url: URL;
  try {
    const base = doc.path ? pathToFileURL(doc.path).href : pathToFileURL(app.getPath('home') + '/').href;
    url = new URL(href, base);
  } catch {
    return;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
    shell.openExternal(url.href);
  } else if (url.protocol === 'file:') {
    const target = fileURLToPath(url);
    if (MD_EXT.test(target)) openWindow(target);
    else shell.openPath(target);
  }
});

function send(cmd: string) {
  BrowserWindow.getFocusedWindow()?.webContents.send('menu', cmd);
}

async function openDialog() {
  const res = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mkdn'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  for (const f of res.filePaths) openWindow(f);
}

function buildMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => openWindow(null) },
          { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => openDialog() },
          { type: 'separator' },
          { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
          { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('save-as') },
          { type: 'separator' },
          { label: 'Close Window', accelerator: 'CmdOrCtrl+W', role: 'close' },
          { label: 'Quit', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
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
          { label: 'Toggle Edit Mode', accelerator: 'CmdOrCtrl+E', click: () => send('toggle-edit') },
          { label: 'Rich Text Editor', accelerator: 'CmdOrCtrl+1', click: () => send('rich') },
          { label: 'Plain Text Editor', accelerator: 'CmdOrCtrl+2', click: () => send('plain') },
          { type: 'separator' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { role: 'resetZoom' },
          { type: 'separator' },
          { role: 'toggleDevTools' },
        ],
      },
    ]),
  );
}

// File arguments: non-flag args, minus the app's own path (in dev, `electron .`).
// Chromium may reorder argv, so don't rely on positions.
function filesFromArgv(argv: string[], cwd: string) {
  const appPath = path.resolve(app.getAppPath());
  return argv
    .slice(1)
    .filter((a) => !a.startsWith('-'))
    .map((a) => path.resolve(cwd, a))
    .filter((p) => p !== appPath && p !== process.execPath)
    .filter((p) => {
      try {
        return !fs.statSync(p).isDirectory();
      } catch {
        return true; // doesn't exist yet: open empty, created on save
      }
    });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const files = filesFromArgv(argv, cwd);
    if (files.length === 0) openWindow(null);
    for (const f of files) openWindow(f);
  });

  app.whenReady().then(() => {
    buildMenu();
    const files = filesFromArgv(process.argv, process.cwd());
    if (files.length === 0) openWindow(null);
    for (const f of files) openWindow(f);
  });

  app.on('window-all-closed', () => app.quit());
}
