// Bridge between the editor page and the desktop app (file dialogs, local files, autosave).
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const token = ipcRenderer.sendSync("cutline:token");

contextBridge.exposeInMainWorld("cutlineDesktop", {
  /** Absolute path of a File the user picked or dropped ("" for generated files). */
  pathFor: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  /** A URL the page can load a local media file from (supports seeking). */
  fileUrl: (path) => `/local-file?t=${token}&p=${encodeURIComponent(path)}`,
  exists: (path) => ipcRenderer.invoke("cutline:exists", path),
  saveProject: (json, path, name) => ipcRenderer.invoke("cutline:save", json, path, name),
  openProject: () => ipcRenderer.invoke("cutline:open"),
  autosave: (json) => ipcRenderer.invoke("cutline:autosave", json),
  recover: () => ipcRenderer.invoke("cutline:recover"),
  clearAutosave: () => ipcRenderer.invoke("cutline:clear-autosave"),
  loadPrefs: () => ipcRenderer.invoke("cutline:prefs-load"),
  savePrefs: (prefs) => ipcRenderer.invoke("cutline:prefs-save", prefs),
  setTitle: (name) => ipcRenderer.send("cutline:title", name),
  /** The project Cutline was started with (Open with / double-click), once. */
  pendingOpen: () => ipcRenderer.invoke("cutline:pending-open"),
  /** Projects opened from Explorer while Cutline is already running. */
  onOpenFile: (cb) => ipcRenderer.on("cutline:open-file", (_e, f) => cb(f)),
  /** Runs `cb` (may be async: it saves the project) before the window closes. */
  onBeforeClose: (cb) => ipcRenderer.on("cutline:before-close", async () => {
    try { await cb(); } catch { /* close anyway */ }
    ipcRenderer.send("cutline:close-ready");
  }),
  untitledPath: () => ipcRenderer.invoke("cutline:untitled-path"),
  pickFolder: (start) => ipcRenderer.invoke("cutline:pick-folder", start),
  onSavedFile: (cb) => ipcRenderer.on("cutline:saved-file", (_e, p) => cb(p)),
  /** Recent projects (newest first), with `exists` for each file. */
  recentList: () => ipcRenderer.invoke("cutline:recent-list"),
  recentAdd: (entry) => ipcRenderer.invoke("cutline:recent-add", entry),
  recentRemove: (path) => ipcRenderer.invoke("cutline:recent-remove", path),
  openPath: (path) => ipcRenderer.invoke("cutline:open-path", path),
  showInFolder: (path) => ipcRenderer.invoke("cutline:show-in-folder", path),
  /** Frame index + sound of a big MKV recording (scanned once, then cached): { index, audioPath }. */
  scan: (src) => ipcRenderer.invoke("cutline:scan", src),
  onScanProgress: (cb) => ipcRenderer.on("cutline:scan-progress", (_e, m) => cb(m)),
  proxyOpen: (src) => ipcRenderer.invoke("cutline:proxy-open", src),
  proxyWrite: (part, position, data) => ipcRenderer.invoke("cutline:proxy-write", part, position, data),
  proxyDone: (part, final, audio) => ipcRenderer.invoke("cutline:proxy-done", part, final, audio),
  proxyAbort: (part) => ipcRenderer.invoke("cutline:proxy-abort", part),
  proxyClear: () => ipcRenderer.invoke("cutline:proxy-clear"),
});
