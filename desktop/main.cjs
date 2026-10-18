// Cutline desktop app (Electron). Serves the editor from inside the app on 127.0.0.1 and shows it in
// a window, so it runs on Electron's built-in Chromium (WebCodecs + WebGL2) without Node.js or Chrome.
const { app, BrowserWindow, shell, ipcMain, dialog, Menu } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.join(__dirname, "..");
const token = crypto.randomBytes(16).toString("hex"); // guards /local-file against other pages on this PC
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac", ".opus": "audio/ogg",
};

/** Streams a file, honouring Range requests so <video> can seek. */
function sendFile(req, res, file) {
  const stat = fs.statSync(file);
  const type = types[path.extname(file).toLowerCase()] || "application/octet-stream";
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || "");
  if (range) {
    const start = range[1] ? +range[1] : stat.size - +range[2];
    const end = range[1] && range[2] ? Math.min(+range[2], stat.size - 1) : stat.size - 1;
    if (start >= stat.size || start > end) { res.writeHead(416, { "Content-Range": `bytes */${stat.size}` }).end(); return; }
    res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes" });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  }
}

function serve(req, res) {
  let url;
  try { url = new URL(req.url, "http://x"); } catch { res.writeHead(400).end(); return; }
  if (url.pathname === "/local-file") {
    const p = url.searchParams.get("p");
    if (url.searchParams.get("t") !== token || !p || !path.isAbsolute(p) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404).end(); return; }
    sendFile(req, res, p);
    return;
  }
  const urlPath = decodeURIComponent(url.pathname);
  const file = path.join(root, urlPath === "/" ? "index.html" : urlPath);
  const inside = file.startsWith(path.join(root, "src") + path.sep) || file === path.join(root, "index.html");
  if (!inside || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end("not found"); return; }
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

/** Listens on a fixed port when free (so the page keeps the same origin between runs), else any port. */
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(serve);
    server.once("error", (e) => {
      if (e.code !== "EADDRINUSE") return reject(e);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    server.listen(51730, "127.0.0.1", () => resolve(server.address().port));
  });
}

// ---------------- projects ----------------

const autosavePath = () => path.join(app.getPath("userData"), "autosave.cutline");
const filters = [{ name: "Cutline project", extensions: ["cutline"] }];

ipcMain.on("cutline:token", (e) => { e.returnValue = token; });
ipcMain.handle("cutline:exists", (_e, p) => typeof p === "string" && path.isAbsolute(p) && fs.existsSync(p));
ipcMain.handle("cutline:save", async (e, json, current, name) => {
  let target = current;
  if (!target) {
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      title: "Save project", defaultPath: path.join(app.getPath("documents"), `${name || "Untitled"}.cutline`), filters,
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  await fs.promises.writeFile(target, json, "utf8");
  return target;
});
ipcMain.handle("cutline:open", async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: "Open project", filters, properties: ["openFile"] });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], text: await fs.promises.readFile(r.filePaths[0], "utf8") };
});
ipcMain.handle("cutline:autosave", (_e, json) => fs.promises.writeFile(autosavePath(), json, "utf8"));
ipcMain.handle("cutline:recover", async () => {
  try { return await fs.promises.readFile(autosavePath(), "utf8"); } catch { return null; }
});
ipcMain.handle("cutline:clear-autosave", () => fs.promises.rm(autosavePath(), { force: true }));
// Small settings file (text presets …) that survives app updates.
const prefsPath = () => path.join(app.getPath("userData"), "prefs.json");
ipcMain.handle("cutline:prefs-load", async () => {
  try { return JSON.parse(await fs.promises.readFile(prefsPath(), "utf8")); } catch { return {}; }
});
ipcMain.handle("cutline:prefs-save", (_e, prefs) => fs.promises.writeFile(prefsPath(), JSON.stringify(prefs ?? {}, null, 1), "utf8"));
// Smooth-preview proxies: <userData>/proxies/<hash of path+size+date>.mp4 ("-silent" when it has no sound).
const proxyDir = () => path.join(app.getPath("userData"), "proxies");
const inProxyDir = (p) => typeof p === "string" && path.resolve(p).startsWith(proxyDir() + path.sep);
const proxyHandles = new Map(); // part path -> FileHandle
ipcMain.handle("cutline:proxy-open", async (_e, src) => {
  if (typeof src !== "string" || !path.isAbsolute(src) || !fs.existsSync(src)) return null;
  const st = fs.statSync(src);
  const key = crypto.createHash("sha1").update(`${src}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 20);
  await fs.promises.mkdir(proxyDir(), { recursive: true });
  const full = path.join(proxyDir(), key + ".mp4"), silent = path.join(proxyDir(), key + "-silent.mp4");
  if (fs.existsSync(full)) return { exists: true, path: full, audio: true };
  if (fs.existsSync(silent)) return { exists: true, path: silent, audio: false };
  const part = path.join(proxyDir(), key + ".part");
  await fs.promises.rm(part, { force: true });
  return { exists: false, path: full, part };
});
ipcMain.handle("cutline:proxy-write", async (_e, part, position, data) => {
  if (!inProxyDir(part)) return;
  let fh = proxyHandles.get(part);
  if (!fh) { fh = await fs.promises.open(part, "w"); proxyHandles.set(part, fh); }
  const buf = Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength);
  await fh.write(buf, 0, buf.length, position);
});
const closeProxy = async (part) => { const fh = proxyHandles.get(part); proxyHandles.delete(part); await fh?.close(); };
ipcMain.handle("cutline:proxy-done", async (_e, part, final, audio) => {
  if (!inProxyDir(part) || !inProxyDir(final)) return null;
  await closeProxy(part);
  const dest = audio === false ? final.replace(/\.mp4$/, "-silent.mp4") : final;
  await fs.promises.rename(part, dest);
  return dest;
});
ipcMain.handle("cutline:proxy-abort", async (_e, part) => {
  if (!inProxyDir(part)) return;
  await closeProxy(part);
  await fs.promises.rm(part, { force: true });
});
ipcMain.handle("cutline:proxy-clear", async () => fs.promises.rm(proxyDir(), { recursive: true, force: true }));
ipcMain.on("cutline:title", (e, name) => BrowserWindow.fromWebContents(e.sender)?.setTitle(`${name} — Cutline`));

// ---------------- window ----------------

let win = null;

async function createWindow() {
  const port = await startServer();
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    title: "Cutline", backgroundColor: "#111214", autoHideMenuBar: true, show: false,
    icon: path.join(root, "build", "icon.png"),
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, "preload.cjs") },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.setVisualZoomLevelLimits(1, 1); // no pinch-zoom of the whole window
  // With no menu on Windows/Linux, keep the developer tools reachable with Ctrl+Shift+I / F12.
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i"))) win.webContents.toggleDevTools();
  });
  // Links to other sites open in the normal browser, not inside the editor.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url) && !url.startsWith(`http://127.0.0.1:${port}/`)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  // The page blocks closing while there are unsaved changes; ask the user here.
  win.webContents.on("will-prevent-unload", (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question", buttons: ["Close without saving", "Cancel"], defaultId: 1, cancelId: 1,
      title: "Unsaved changes", message: "Close Cutline without saving?", detail: "Your project has changes that haven't been saved.",
    });
    if (choice === 0) e.preventDefault();
  });
  win.on("closed", () => { win = null; });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

// One window only: opening Cutline again focuses the existing one.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    // The editor has its own shortcuts (Ctrl+= zooms the timeline, not the page). macOS keeps a minimal
    // menu so Cmd+C/V/X/A/Q still work in text boxes.
    Menu.setApplicationMenu(process.platform === "darwin"
      ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
      : null);
    createWindow();
  });
  app.on("activate", () => { if (!win && app.isReady()) createWindow(); }); // macOS dock click
  app.on("window-all-closed", () => app.quit());
}
