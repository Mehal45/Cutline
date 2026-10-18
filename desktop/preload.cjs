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
});
