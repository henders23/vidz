/**
 * vidz desktop shell (Electron). It serves the same web app from `dist/` and adds
 * what a browser tab cannot do: its own screen/window picker, and a record of
 * where the mouse cursor was during a recording.
 */
const { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, screen, session, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const DIST = path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://vidz';

// A proper origin (rather than file://) so storage, workers and fetch behave as on the web.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

let win = null;
/** Resolves the pending getDisplayMedia request once the user picks a source in the app. */
let pendingCapture = null;
/** The display being recorded (null when a single window is captured), for cursor logging. */
let capturedDisplay = null;
let cursorLog = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0d0e12',
    title: 'vidz',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.loadURL(`${ORIGIN}/index.html`);
  // Links open in the user's browser, never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(ORIGIN)) event.preventDefault();
  });
  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname === '/' ? '/index.html' : pathname)));
    if (file !== DIST && !file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  // Camera and microphone prompts come from the operating system; the app itself may always ask.
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(contents === win?.webContents && ['media', 'display-capture'].includes(permission));
  });

  // Screen recording: show vidz's own picker with every screen and window.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      // Some systems cannot produce preview pictures, or cannot list windows; fall back
      // step by step rather than offering nothing.
      let sources = [];
      for (const options of [
        { types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 } },
        { types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } },
        { types: ['screen'], thumbnailSize: { width: 0, height: 0 } },
      ]) {
        sources = await desktopCapturer.getSources(options).catch(() => []);
        if (sources.length) break;
      }
      if (!sources.length) return callback(null);
      const choice = await new Promise((resolve) => {
        pendingCapture?.(null);
        pendingCapture = resolve;
        win?.webContents.send('capture:pick', sources.map((s) => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen') ? 'screen' : 'window', thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL() })));
      });
      pendingCapture = null;
      const source = sources.find((s) => s.id === choice);
      if (!source) return callback(null);
      const displays = screen.getAllDisplays();
      capturedDisplay = source.id.startsWith('screen') ? displays.find((d) => String(d.id) === source.display_id) ?? (displays.length === 1 ? displays[0] : null) : null;
      // System audio capture is only available on Windows.
      callback({ video: source, ...(process.platform === 'win32' ? { audio: 'loopback' } : {}) });
    } catch (err) {
      console.error('Screen capture failed', err);
      callback(null);
    }
  });

  ipcMain.handle('capture:choose', (_event, id) => pendingCapture?.(id ?? null));

  // Cursor log: where the pointer was on the recorded screen, as fractions of its width and height.
  ipcMain.handle('cursor:start', () => {
    if (cursorLog) clearInterval(cursorLog.timer);
    cursorLog = null;
    if (!capturedDisplay) return false;
    const { bounds } = capturedDisplay;
    const started = performance.now();
    const points = [];
    const timer = setInterval(() => {
      const pt = screen.getCursorScreenPoint();
      points.push({ time: (performance.now() - started) / 1000, x: (pt.x - bounds.x) / bounds.width, y: (pt.y - bounds.y) / bounds.height });
    }, 33);
    cursorLog = { timer, points };
    return true;
  });
  ipcMain.handle('cursor:stop', () => {
    if (!cursorLog) return [];
    clearInterval(cursorLog.timer);
    const { points } = cursorLog;
    cursorLog = null;
    capturedDisplay = null;
    return points;
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
