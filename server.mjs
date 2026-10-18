// Cutline's local server: serves the editor to your own browser only (127.0.0.1).
// Usage: node server.mjs [port] [--open]   (--open launches Chrome/Edge once it's running)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) || 5173);
const openBrowser = process.argv.includes("--open");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".webm": "video/webm",
};

/** Opens the editor, preferring Chrome or Edge (they support WebCodecs video export). */
function launchBrowser(url) {
  const chrome = process.platform === "win32" && [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter(Boolean).map((d) => path.join(d, "Google", "Chrome", "Application", "chrome.exe")).find((f) => fs.existsSync(f));
  const tries = process.platform === "win32"
    ? [...(chrome ? [`start "" "${chrome}" "${url}"`] : []), `start "" msedge "${url}"`, `start "" "${url}"`]
    : process.platform === "darwin"
      ? [`open -a "Google Chrome" "${url}"`, `open -a "Microsoft Edge" "${url}"`, `open -a "Brave Browser" "${url}"`, `open "${url}"`]
      : [`google-chrome "${url}"`, `chromium "${url}"`, `xdg-open "${url}"`];
  const next = (i) => i < tries.length && exec(tries[i], (err) => err && next(i + 1));
  next(0);
}

http
  .createServer((req, res) => {
    let urlPath;
    try { urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400).end(); return; }
    const file = path.join(root, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": types[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  })
  .on("error", (e) => {
    if (e.code !== "EADDRINUSE") throw e;
    console.log(`Port ${port} is already in use. If Cutline is already running, open http://localhost:${port}`);
    if (openBrowser) launchBrowser(`http://localhost:${port}`);
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`Cutline running at http://localhost:${port}`);
    console.log("Keep this window open while you edit. Close it (or press Ctrl+C) to stop.");
    if (openBrowser) launchBrowser(`http://localhost:${port}`);
  });
