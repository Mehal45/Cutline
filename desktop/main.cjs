// Cutline desktop app (Electron). Serves the editor from inside the app on 127.0.0.1 and shows it in
// a window, so it runs on Electron's built-in Chromium (WebCodecs + WebGL2) without Node.js or Chrome.
const { app, BrowserWindow, shell } = require("electron");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function serve(req, res) {
  let urlPath;
  try { urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400).end(); return; }
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

let win = null;

async function createWindow() {
  const port = await startServer();
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    title: "Cutline", backgroundColor: "#111214", autoHideMenuBar: true, show: false,
    icon: path.join(root, "build", "icon.png"),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  // Links to other sites open in the normal browser, not inside the editor.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  win.on("closed", () => { win = null; });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

// One window only: opening Cutline again focuses the existing one.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(createWindow);
  app.on("activate", () => { if (!win && app.isReady()) createWindow(); }); // macOS dock click
  app.on("window-all-closed", () => app.quit());
}
