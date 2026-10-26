// Cutline desktop app (Electron). Serves the editor from inside the app on 127.0.0.1 and shows it in
// a window, so it runs on Electron's built-in Chromium (WebCodecs + WebGL2) without Node.js or Chrome.
const { app, BrowserWindow, shell, ipcMain, dialog, Menu, protocol } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { setupUpdates } = require("./updater.cjs");

setupUpdates({ repo: "Mehal45/Cutline", assets: { win32: /^Cutline-Setup-.*\.exe$/i, darwin: /\.dmg$/i } });

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
    res.writeHead(206, { "Content-Type": type, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  }
}

/**
 * Local media for the editor: cutline-file://media/?t=<token>&p=<path>. Served by the app itself rather than
 * the 127.0.0.1 server, because the browser only keeps 6 connections open to one server: with more videos
 * than that open (one long recording cut into many clips), the next one waited — sometimes a minute — for a
 * free connection before it could show anything. This has no such limit.
 */
protocol.registerSchemesAsPrivileged([{
  scheme: "cutline-file",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, bypassCSP: true },
}]);
async function serveMedia(req) {
  const url = new URL(req.url);
  const p = url.searchParams.get("p");
  const stat = url.searchParams.get("t") === token && p && path.isAbsolute(p) ? await fs.promises.stat(p).catch(() => null) : null;
  if (!stat || stat.isDirectory()) return new Response(null, { status: 404 });
  const headers = {
    "Content-Type": types[path.extname(p).toLowerCase()] || "application/octet-stream",
    "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store",
  };
  let start = 0, end = stat.size - 1, status = 200;
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
  if (range) {
    start = range[1] ? +range[1] : Math.max(0, stat.size - +range[2]);
    if (range[1] && range[2]) end = Math.min(+range[2], stat.size - 1);
    if (start >= stat.size || start > end) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${stat.size}` } });
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers["Content-Length"] = String(Math.max(0, end - start + 1));
  if (req.method === "HEAD" || stat.size === 0) return new Response(null, { status, headers });
  const body = Readable.toWeb(fs.createReadStream(p, { start, end, highWaterMark: 1 << 20 }));
  return new Response(body, { status, headers });
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
      title: "Save project", defaultPath: path.join(await projectsDir(), `${name || "Untitled"}.cutline`), filters,
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  await writeAtomic(target, json);
  return target;
});
ipcMain.handle("cutline:open", async (e) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: "Open project", filters, properties: ["openFile"] });
  if (r.canceled || !r.filePaths[0]) return null;
  return { path: r.filePaths[0], text: await fs.promises.readFile(r.filePaths[0], "utf8") };
});
// Projects opened from Explorer ("Open with Cutline", double-click) arrive as a command-line argument.
const projectArg = (argv) => argv.slice(1).find((a) => /\.cutline$/i.test(a) && fs.existsSync(a)) || null;
let pendingOpen = projectArg(process.argv);
const readProject = async (p) => ({ path: p, text: await fs.promises.readFile(p, "utf8") });
ipcMain.handle("cutline:pending-open", async () => {
  const p = pendingOpen;
  pendingOpen = null;
  return p ? readProject(p) : null;
});
async function sendOpen(p) {
  if (!p || !win) { pendingOpen = p || pendingOpen; return; }
  try { win.webContents.send("cutline:open-file", await readProject(p)); } catch { /* unreadable file */ }
}
app.on("open-file", (e, p) => { e.preventDefault(); sendOpen(p); }); // macOS

// Untitled projects are saved on close to Documents > Cutline Projects > "Untitled project N.cutline".
ipcMain.handle("cutline:untitled-path", async () => {
  const dir = await projectsDir();
  await fs.promises.mkdir(dir, { recursive: true });
  for (let n = 1; ; n++) {
    const p = path.join(dir, `Untitled project ${n}.cutline`);
    if (!fs.existsSync(p)) return p;
  }
});

// Recent projects: <userData>/recent.json, newest first: [{ path, name, dur, thumb, openedAt }].
const recentPath = () => path.join(app.getPath("userData"), "recent.json");
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
/** The list, or null if the file is unreadable (then it's never overwritten with an empty list). */
async function readRecent() {
  for (let i = 0; i < 5; i++) {
    try { return JSON.parse(await fs.promises.readFile(recentPath(), "utf8")); } catch (e) {
      if (e.code === "ENOENT") return [];
      await new Promise((r) => setTimeout(r, 150)); // another Cutline (one closing) may be writing it
    }
  }
  return null;
}
/** Writes whole-or-nothing: a new file, then renamed over the old one. */
async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, text, "utf8");
  await fs.promises.rename(tmp, file);
}
let recentQueue = Promise.resolve();
/** Changes the list one at a time (an "opened" and a later "thumbnail" update never overwrite each other). */
const changeRecent = (fn) => (recentQueue = recentQueue.then(async () => {
  const list = await readRecent();
  if (!list) return;
  await writeAtomic(recentPath(), JSON.stringify(fn(list)));
}).catch(() => {}));
ipcMain.handle("cutline:recent-list", async () => {
  await recentQueue;
  return Promise.all(((await readRecent()) || []).map(async (r) => {
    try { const st = await fs.promises.stat(r.path); return { ...r, exists: true, modified: st.mtimeMs }; } catch { return { ...r, exists: false }; }
  }));
});
ipcMain.handle("cutline:recent-add", (_e, entry) => {
  if (typeof entry?.path !== "string" || !path.isAbsolute(entry.path)) return;
  return changeRecent((list) => {
    const old = list.find((r) => samePath(r.path, entry.path));
    const next = { ...old, ...entry };
    if (!entry.keepOrder) next.openedAt = Date.now();
    delete next.keepOrder;
    return entry.keepOrder && old ? list.map((r) => (r === old ? next : r)) : [next, ...list.filter((r) => r !== old)].slice(0, 40);
  });
});
ipcMain.handle("cutline:recent-remove", (_e, p) => changeRecent((list) => list.filter((r) => !samePath(r.path, String(p)))));
ipcMain.handle("cutline:open-path", async (_e, p) => {
  if (typeof p !== "string" || !/\.cutline$/i.test(p)) return null;
  try { return await readProject(p); } catch { return null; }
});
ipcMain.handle("cutline:show-in-folder", (_e, p) => { if (typeof p === "string" && fs.existsSync(p)) shell.showItemInFolder(p); });

// Big recordings are scanned once (frame index + sound) on a worker thread; see scan.cjs.
const { getScan } = require("./scan.cjs");
ipcMain.handle("cutline:scan", async (e, src) => {
  if (typeof src !== "string" || !path.isAbsolute(src) || !fs.existsSync(src)) return null;
  const send = (p) => { try { e.sender.send("cutline:scan-progress", { path: src, progress: p }); } catch { /* window gone */ } };
  const r = await getScan(app.getPath("userData"), src, send);
  send(1);
  return r;
});

ipcMain.handle("cutline:autosave", (_e, json) => writeAtomic(autosavePath(), json));
ipcMain.handle("cutline:recover", async () => {
  try { return await fs.promises.readFile(autosavePath(), "utf8"); } catch { return null; }
});
ipcMain.handle("cutline:clear-autosave", () => fs.promises.rm(autosavePath(), { force: true }));
// Small settings file (text presets …) that survives app updates.
const prefsPath = () => path.join(app.getPath("userData"), "prefs.json");
ipcMain.handle("cutline:prefs-load", async () => {
  try { return JSON.parse(await fs.promises.readFile(prefsPath(), "utf8")); } catch { return {}; }
});
ipcMain.handle("cutline:prefs-save", (_e, prefs) => writeAtomic(prefsPath(), JSON.stringify(prefs ?? {}, null, 1)));
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
  handleDownloads(win);
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
  // Closing saves the project first (no questions): the page saves, says it's ready, then the window closes.
  let closing = false;
  win.on("close", (e) => {
    if (closing) return;
    e.preventDefault();
    closing = true;
    const w = win;
    const done = () => { if (!w.isDestroyed()) w.destroy(); };
    ipcMain.once("cutline:close-ready", done);
    w.webContents.send("cutline:before-close");
    setTimeout(done, 15000); // never hang on close
  });
  win.on("closed", () => { win = null; });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

// Settings › Performance: graphics acceleration can be turned off (read before the app starts).
try { if (JSON.parse(fs.readFileSync(prefsPath(), "utf8"))?.settings?.gpu === false) app.disableHardwareAcceleration(); } catch { /* no prefs yet */ }

/** The user's settings from prefs.json (Menu › Settings). */
async function userSettings() {
  try { return JSON.parse(await fs.promises.readFile(prefsPath(), "utf8"))?.settings || {}; } catch { return {}; }
}
const projectsDir = async () => {
  const d = (await userSettings()).projectsDir;
  if (d && fs.existsSync(d)) return d;
  const def = path.join(app.getPath("documents"), "Cutline Projects");
  await fs.promises.mkdir(def, { recursive: true }).catch(() => {});
  return def;
};

ipcMain.handle("cutline:pick-folder", async (e, start) => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: "Choose a folder", defaultPath: start || app.getPath("documents"), properties: ["openDirectory", "createDirectory"],
  });
  return r.canceled ? null : r.filePaths[0] || null;
});

// Video export straight to disk: pick the file (or use Settings › export folder), then the renderer streams
// the MP4 into it piece by piece (positional writes), so big exports never have to fit in memory.
const openExports = new Map(); // id -> { fh, path }
ipcMain.handle("cutline:export-begin", async (e, name) => {
  const s = await userSettings();
  const dir = s.exportDir && fs.existsSync(s.exportDir) ? s.exportDir : app.getPath("downloads");
  let target;
  if (s.exportDir && s.askExportPath === false) {
    const ext = path.extname(name), base = path.basename(name, ext);
    target = path.join(dir, name);
    for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base} (${n})${ext}`);
  } else {
    const r = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
      title: "Export video", defaultPath: path.join(dir, name), filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    });
    if (r.canceled || !r.filePath) return null;
    target = r.filePath;
  }
  const id = crypto.randomUUID();
  openExports.set(id, { fh: await fs.promises.open(target, "w"), path: target });
  return { id, path: target };
});
ipcMain.handle("cutline:export-write", async (_e, id, data, position) => {
  const x = openExports.get(id);
  if (!x) throw new Error("Export file is closed");
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  await x.fh.write(buf, 0, buf.length, position);
});
ipcMain.handle("cutline:export-end", async (_e, id, abort) => {
  const x = openExports.get(id);
  if (!x) return;
  openExports.delete(id);
  await x.fh.close().catch(() => {});
  if (abort) await fs.promises.unlink(x.path).catch(() => {});
});

/** Saved files (exported MP4 / PNG / WAV): straight into Settings › Export folder, or a Save dialog starting there. */
function handleDownloads(w) {
  w.webContents.session.on("will-download", async (_e, item) => {
    const s = await userSettings().catch(() => ({}));
    const dir = s.exportDir && fs.existsSync(s.exportDir) ? s.exportDir : app.getPath("downloads");
    const name = item.getFilename();
    if (s.exportDir && s.askExportPath === false) {
      const ext = path.extname(name), base = path.basename(name, ext);
      let target = path.join(dir, name);
      for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, `${base} (${n})${ext}`);
      item.setSavePath(target);
      item.once("done", (_ev, state) => { if (state === "completed") w.webContents.send("cutline:saved-file", target); });
    } else item.setSaveDialogOptions({ defaultPath: path.join(dir, name) });
  });
}

// One window only: opening Cutline again focuses the existing one.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_e, argv) => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    sendOpen(projectArg(argv));
  });
  app.whenReady().then(() => {
    protocol.handle("cutline-file", serveMedia);
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
