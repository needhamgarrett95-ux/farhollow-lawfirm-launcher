// Preload bridge — exposes a safe, minimal API to the renderer.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getStatus: () => ipcRenderer.invoke('launcher:get-status'),
  getLogs: () => ipcRenderer.invoke('launcher:get-logs'),
  startServer: () => ipcRenderer.invoke('launcher:start-server'),
  stopServer: () => ipcRenderer.invoke('launcher:stop-server'),
  openBrowser: () => ipcRenderer.invoke('launcher:open-browser'),
  browseServer: () => ipcRenderer.invoke('launcher:browse-server'),
  checkUpdates: () => ipcRenderer.invoke('launcher:check-updates'),
  skipUpdate: () => ipcRenderer.invoke('launcher:skip-update'),
  installUpdate: () => ipcRenderer.invoke('launcher:install-update'),
  setStartWithWindows: (v) => ipcRenderer.invoke('launcher:set-start-with-windows', v),
  setStartServerOnBoot: (v) => ipcRenderer.invoke('launcher:set-start-server-on-boot', v),
  onStatus: (cb) => ipcRenderer.on('launcher:status', (_e, s) => cb(s)),
  onLogs: (cb) => ipcRenderer.on('launcher:logs', (_e, lines) => cb(lines)),
  onUpdate: (cb) => ipcRenderer.on('launcher:update', (_e, u) => cb(u)),
  onUpdateProgress: (cb) => ipcRenderer.on('launcher:update-progress', (_e, p) => cb(p)),
});
