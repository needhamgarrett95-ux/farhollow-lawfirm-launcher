// ============================================================
//  Law Firm Launcher — main process
//  Manages the LawFirmServer.exe on the host machine.
// ============================================================
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage } = require('electron');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');

const REPO = 'needhamgarrett95-ux/farhollow-lawfirm';
const SERVER_PORT = 5000;
const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000; // every 6 hours
const LOG_KEEP = 200;  // ring buffer size
const LOG_SHOW = 50;   // lines shown in the log view

const DEFAULT_SERVER_PATHS = [
  'C:\\Program Files\\Law Firm Case Management\\LawFirmServer.exe',
  'C:\\Program Files (x86)\\Law Firm Case Management\\LawFirmServer.exe',
];

const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  const defaults = {
    serverPath: '',
    startServerOnBoot: false,
    lastKnownServerVersion: '',
  };
  try {
    if (fs.existsSync(configPath())) {
      return { ...defaults, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
    }
  } catch (e) { /* corrupt config -> defaults */ }
  // Auto-detect the server on first run
  for (const p of DEFAULT_SERVER_PATHS) {
    if (fs.existsSync(p)) { defaults.serverPath = p; break; }
  }
  return defaults;
}

function saveConfig(cfg) {
  try { fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2)); } catch (e) {}
}

let config = loadConfig();
let mainWindow = null;
let tray = null;
let serverProc = null;
let logLines = [];
let updateInfo = { available: false, version: '', url: '', notes: '', checking: false };
let updateTimer = null;
// Startup update gate: the server may not be started until the first update
// check has completed. If an update is pending, the user must install it or
// explicitly skip before Start Server is enabled. A failed check (offline)
// never blocks startup.
let updateGate = { startupCheckDone: false, skippedVersion: '', failed: false };

function pushLog(line) {
  const ts = new Date().toLocaleTimeString();
  logLines.push(`[${ts}] ${line}`);
  if (logLines.length > LOG_KEEP) logLines = logLines.slice(-LOG_KEEP);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('launcher:logs', logLines.slice(-LOG_SHOW));
  }
}

let cachedServerVersion = ''; // refreshed by refreshServerVersion()

function serverVersionFromFile() {
  // Read the VERSION file shipped next to the server exe
  try {
    if (config.serverPath) {
      const v = path.join(path.dirname(config.serverPath), 'VERSION');
      if (fs.existsSync(v)) return fs.readFileSync(v, 'utf8').trim();
    }
  } catch (e) {}
  return '';
}

function serverVersionFromApi() {
  // Ask the running server for its version. Resolves '' when the server
  // isn't running or is too old to have /api/version.
  return new Promise(resolve => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: SERVER_PORT,
      path: '/api/version',
      method: 'GET',
      timeout: 3000,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j && j.version) return resolve(String(j.version).trim());
        } catch (e) { /* fall through */ }
        resolve('');
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.end();
  });
}

async function refreshServerVersion() {
  // 1. Ask the running server (most reliable)
  const viaApi = await serverVersionFromApi();
  if (viaApi) {
    cachedServerVersion = viaApi;
  } else {
    // 2. VERSION file next to the exe, then last known good
    cachedServerVersion = serverVersionFromFile()
      || config.lastKnownServerVersion || 'unknown';
  }
  // Persist real versions so we remember across restarts
  if (cachedServerVersion && cachedServerVersion !== 'unknown') {
    config.lastKnownServerVersion = cachedServerVersion;
    saveConfig(config);
  }
  return cachedServerVersion;
}

function serverVersion() {
  return cachedServerVersion || config.lastKnownServerVersion || 'unknown';
}

function compareVersions(a, b) {
  // numeric semver-ish compare; returns 1 if a > b, -1 if a < b, 0 if equal
  const pa = String(a).replace(/^v/i, '').split('.').map(x => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function githubGet(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method: 'GET',
      headers: { 'User-Agent': 'law-firm-launcher', 'Accept': 'application/vnd.github+json' },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Bad JSON from GitHub')); }
        } else {
          reject(new Error(`GitHub API ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('GitHub request timed out')); });
    req.end();
  });
}

async function checkForUpdates(manual = false) {
  if (updateInfo.checking) return updateInfo;
  updateInfo.checking = true;
  broadcast('launcher:update', { ...updateInfo });
  try {
    const current = await refreshServerVersion();
    const rel = await githubGet(`/repos/${REPO}/releases/latest`);
    const latest = (rel.tag_name || '').trim();
    const asset = (rel.assets || []).find(a => a.name === 'LawFirmHostSetup.exe');
    let offer = false;
    if (latest && asset) {
      if (current === 'unknown') {
        // Can't determine the running version (old server without /api/version,
        // no VERSION file). Offer the update rather than hiding it — this is
        // how an old install gets onto a version that reports properly.
        offer = true;
      } else if (compareVersions(latest, current) > 0) {
        offer = true;
      }
    }
    if (offer) {
      updateInfo = {
        available: true, version: latest, url: asset.browser_download_url,
        notes: rel.body || '', checking: false,
      };
      pushLog(`Update available: server ${current} -> ${latest}`);
    } else {
      updateInfo = { available: false, version: latest, url: '', notes: '', checking: false };
      if (manual) pushLog(`Update check: server is current (${current}).`);
    }
    updateGate.failed = false;
  } catch (e) {
    updateInfo.checking = false;
    updateGate.failed = true;
    pushLog(`Update check failed: ${e.message} (offline? will retry later)`);
  }
  updateGate.startupCheckDone = true;
  broadcast('launcher:update', { ...updateInfo });
  broadcastStatus();
  return updateInfo;
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'law-firm-launcher' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlink(dest, () => {});
        downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(dest, () => {});
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let done = 0;
      res.on('data', c => { done += c.length; if (onProgress && total) onProgress(done / total); });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(dest); });
    });
    req.on('error', err => { file.close(); fs.unlink(dest, () => {}); reject(err); });
    req.setTimeout(120000, () => { req.destroy(new Error('Download timed out')); });
  });
}

async function installUpdate() {
  if (!updateInfo.available || !updateInfo.url) throw new Error('No update to install.');
  const wasRunning = !!serverProc;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawfirm-update-'));
  const installerPath = path.join(tmpDir, 'LawFirmHostSetup.exe');

  broadcast('launcher:update-progress', { phase: 'downloading', pct: 0 });
  pushLog(`Downloading ${updateInfo.version}...`);
  await downloadFile(updateInfo.url, installerPath, pct => {
    broadcast('launcher:update-progress', { phase: 'downloading', pct });
  });

  const stat = fs.statSync(installerPath);
  if (stat.size < 5 * 1024 * 1024) throw new Error('Downloaded installer looks corrupt (too small).');
  // MZ magic bytes sanity check
  const fd = fs.openSync(installerPath, 'r');
  const magic = Buffer.alloc(2);
  fs.readSync(fd, magic, 0, 2, 0);
  fs.closeSync(fd);
  if (magic.toString() !== 'MZ') throw new Error('Downloaded file is not a valid installer.');

  if (wasRunning) {
    pushLog('Stopping server for update...');
    stopServer();
    await new Promise(r => setTimeout(r, 2000));
  }

  broadcast('launcher:update-progress', { phase: 'installing', pct: 1 });
  pushLog('Running installer (Windows may ask for permission)...');
  // /VERYSILENT upgrades in place; the installer never touches instance\ (client data).
  await new Promise((resolve, reject) => {
    execFile(installerPath, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], err => {
      if (err) reject(new Error(`Installer failed: ${err.message}`));
      else resolve();
    });
  });

  fs.rmSync(tmpDir, { recursive: true, force: true });
  config.lastKnownServerVersion = updateInfo.version.replace(/^v/i, '');
  saveConfig(config);
  updateInfo = { available: false, version: '', url: '', notes: '', checking: false };
  updateGate.skippedVersion = '';
  updateGate.failed = false;
  broadcast('launcher:update', { ...updateInfo });
  broadcast('launcher:update-progress', { phase: 'done', pct: 1 });
  pushLog(`Updated to ${config.lastKnownServerVersion}.`);

  if (wasRunning) {
    await new Promise(r => setTimeout(r, 1500));
    startServer();
  }
  broadcastStatus();
}

function startServer() {
  if (serverProc) return { ok: false, error: 'Server is already running.' };
  if (!config.serverPath || !fs.existsSync(config.serverPath)) {
    return { ok: false, error: 'Server not found. Set the LawFirmServer.exe location in Settings.' };
  }
  if (!updateGate.startupCheckDone || updateInfo.checking) {
    return { ok: false, error: 'Still checking for updates — please wait a moment.' };
  }
  if (updateInfo.available && !updateGate.failed && updateGate.skippedVersion !== updateInfo.version) {
    return { ok: false, error: 'An update is available. Please install it, or click "Skip and start anyway".' };
  }
  try {
    serverProc = spawn(config.serverPath, [], {
      cwd: path.dirname(config.serverPath),
      windowsHide: true,
    });
    serverProc.stdout.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(pushLog));
    serverProc.stderr.on('data', d => String(d).split(/\r?\n/).filter(Boolean).forEach(l => pushLog(`ERR: ${l}`)));
    serverProc.on('error', err => {
      pushLog(`Failed to start server: ${err.message}`);
      serverProc = null;
      broadcastStatus();
    });
    serverProc.on('exit', (code, signal) => {
      pushLog(`Server stopped (code ${code}${signal ? `, ${signal}` : ''}).`);
      serverProc = null;
      broadcastStatus();
    });
    pushLog(`Server started (PID ${serverProc.pid}).`);
    broadcastStatus();
    // Give the server a moment to boot, then pick up its version
    setTimeout(() => refreshServerVersion().then(() => broadcastStatus()).catch(() => {}), 5000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function stopServer() {
  if (!serverProc) return { ok: false, error: 'Server is not running.' };
  try {
    // On Windows, kill() terminates the process tree for a spawned exe.
    serverProc.kill();
    pushLog('Stopping server...');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function statusPayload() {
  const updatePending = updateInfo.available
    && !updateGate.failed
    && updateGate.skippedVersion !== updateInfo.version;
  return {
    running: !!serverProc,
    pid: serverProc ? serverProc.pid : null,
    version: serverVersion(),
    serverPath: config.serverPath,
    serverFound: !!(config.serverPath && fs.existsSync(config.serverPath)),
    url: `http://localhost:${SERVER_PORT}`,
    startWithWindows: app.getLoginItemSettings().openAtLogin,
    startServerOnBoot: config.startServerOnBoot,
    update: { ...updateInfo },
    gate: {
      checking: !updateGate.startupCheckDone || updateInfo.checking,
      updatePending,
      checkFailed: updateGate.failed && updateGate.startupCheckDone,
    },
  };
}

function broadcastStatus() {
  const s = statusPayload();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('launcher:status', s);
  updateTrayMenu();
}

function broadcast(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 680,
    resizable: false,
    title: 'Law Firm Launcher',
    icon: path.join(__dirname, 'assets', 'dgm-icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Minimize-to-tray: hide instead of closing
  mainWindow.on('close', e => {
    if (!app.quitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const running = !!serverProc;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Launcher', click: () => { mainWindow.show(); mainWindow.focus(); } },
    { type: 'separator' },
    running
      ? { label: 'Stop Server', click: () => { stopServer(); } }
      : { label: 'Start Server', click: () => { const r = startServer(); if (!r.ok) dialog.showErrorBox('Law Firm Launcher', r.error); } },
    { label: 'Open in Browser', click: () => shell.openExternal(`http://localhost:${SERVER_PORT}`) },
    { type: 'separator' },
    { label: 'Quit Launcher', click: () => { app.quitting = true; app.quit(); } },
  ]));
  tray.setToolTip(`Law Firm Launcher — server ${running ? 'RUNNING' : 'stopped'}`);
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  const img = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(img.isEmpty() ? undefined : img);
  tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
  updateTrayMenu();
}

// ---------- IPC ----------
ipcMain.handle('launcher:get-status', () => statusPayload());
ipcMain.handle('launcher:get-logs', () => logLines.slice(-LOG_SHOW));
ipcMain.handle('launcher:start-server', () => { const r = startServer(); return r; });
ipcMain.handle('launcher:stop-server', () => stopServer());
ipcMain.handle('launcher:open-browser', async () => {
  await shell.openExternal(`http://localhost:${SERVER_PORT}`);
  return { ok: true };
});
ipcMain.handle('launcher:browse-server', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Locate LawFirmServer.exe',
    filters: [{ name: 'LawFirmServer', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (!r.canceled && r.filePaths[0]) {
    config.serverPath = r.filePaths[0];
    saveConfig(config);
    pushLog(`Server path set to: ${config.serverPath}`);
    broadcastStatus();
    return { ok: true, path: config.serverPath };
  }
  return { ok: false };
});
ipcMain.handle('launcher:check-updates', async () => checkForUpdates(true));
ipcMain.handle('launcher:skip-update', () => {
  if (updateInfo.available) {
    updateGate.skippedVersion = updateInfo.version;
    pushLog(`Update ${updateInfo.version} skipped by user — starting with current version.`);
  }
  broadcastStatus();
  return { ok: true };
});
ipcMain.handle('launcher:install-update', async () => {
  try {
    await installUpdate();
    return { ok: true };
  } catch (e) {
    pushLog(`Update failed: ${e.message}`);
    broadcast('launcher:update-progress', { phase: 'error', pct: 0, error: e.message });
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('launcher:set-start-with-windows', (e, enabled) => {
  app.setLoginItemSettings({ openAtLogin: !!enabled });
  broadcastStatus();
  return { ok: true };
});
ipcMain.handle('launcher:set-start-server-on-boot', (e, enabled) => {
  config.startServerOnBoot = !!enabled;
  saveConfig(config);
  broadcastStatus();
  return { ok: true };
});

// ---------- App lifecycle ----------
app.whenReady().then(() => {
  createWindow();
  createTray();
  pushLog('Launcher ready.');
  if (!config.serverPath) {
    pushLog('Server not found automatically — set its location in Settings.');
  }

  // Refresh the displayed server version early (async; falls back gracefully)
  refreshServerVersion().then(() => broadcastStatus()).catch(() => {});

  // Update check runs IMMEDIATELY on launch (gates the Start button),
  // then every 6 hours after that.
  checkForUpdates(false).catch(() => {});
  updateTimer = setInterval(() => checkForUpdates(false), UPDATE_CHECK_MS);

  // Auto-start server on boot if configured — waits for the update check
  // first. If an update is pending at boot, we still start (nobody is here
  // to click through the gate, and an office-down server is worse than a
  // stale one); the update banner will prompt when someone opens the UI.
  if (config.startServerOnBoot && config.serverPath && fs.existsSync(config.serverPath)) {
    pushLog('Auto-start will begin after the update check...');
    const waitForCheck = setInterval(() => {
      if (!updateGate.startupCheckDone) return;
      clearInterval(waitForCheck);
      if (updateInfo.available && !updateGate.failed) {
        updateGate.skippedVersion = updateInfo.version;
        pushLog(`Update ${updateInfo.version} pending — auto-starting current version (banner will prompt).`);
      }
      const r = startServer();
      if (!r.ok) pushLog(`Auto-start failed: ${r.error}`);
    }, 500);
    setTimeout(() => clearInterval(waitForCheck), 90000); // safety: never wait forever
  }
});

app.on('window-all-closed', () => {
  // Keep running in the tray; the tray menu quits explicitly.
});

app.on('before-quit', () => {
  if (updateTimer) clearInterval(updateTimer);
  // Leave the server running when the launcher quits — it's the office's
  // data host. Stopping it is an explicit button press.
});
