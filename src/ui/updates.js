// In-app updates (desktop app): a bar at the top when a newer Cutline is out, and Settings › Updates.
// "Update now" downloads the new installer in the background; "Restart & update" closes Cutline (saving
// the project as usual), installs it and opens the new version. On a Mac it opens the new download instead.
import { useEffect, useState } from "react";
import { useStore, getState, setState } from "../store.js";
import { settings, setSetting } from "../settings.js";
import { html, Icon } from "./kit.js";

const updates = typeof window !== "undefined" ? window.cutlineDesktop?.updates : null;
export const canUpdate = !!updates;

const status = () => getState().update || { phase: "idle" };
const put = (patch) => setState({ update: { ...status(), ...patch } });

/** Asks GitHub for the newest release. `manual`: also say so when you already have the newest version. */
export async function checkForUpdates(manual = false) {
  if (!updates || ["checking", "downloading", "installing"].includes(status().phase)) return;
  put({ phase: "checking", manual, error: null });
  try {
    const info = await updates.check();
    if (!info.available) return put({ phase: "latest", info });
    put({ phase: getState().update?.ready === info.version ? "ready" : "available", info, hidden: !manual && skipped() === info.version });
  } catch (e) {
    put({ phase: manual ? "error" : "idle", error: String(e?.message || e) });
  }
}

export async function downloadUpdate() {
  const { info } = status();
  if (!info) return;
  if (!info.canInstall) { updates.install(); return; } // Mac / running from source: open the download
  put({ phase: "downloading", progress: 0, hidden: false, error: null });
  try {
    await updates.download();
    put({ phase: "ready", ready: info.version });
  } catch (e) {
    put({ phase: "error", error: String(e?.message || e) });
  }
}

export async function installUpdate() {
  put({ phase: "installing" });
  try { await updates.install(); } catch (e) { put({ phase: "error", error: String(e?.message || e) }); }
}

const SKIP = "cutline.skipUpdate";
const skipped = () => { try { return localStorage.getItem(SKIP); } catch { return null; } };
const later = () => { const v = status().info?.version; try { if (v) localStorage.setItem(SKIP, v); } catch { /* ignore */ } put({ hidden: true }); };

/** Checks a few seconds after Cutline opens and then every 6 hours (Settings › Updates can turn it off). */
export function startUpdateChecks() {
  if (!updates) return;
  updates.onProgress((p) => put({ progress: p }));
  const auto = () => settings().autoUpdate !== false && checkForUpdates(false);
  setTimeout(auto, 8000);
  setInterval(auto, 6 * 3600 * 1000);
}

/** Release notes without the download table GitHub shows on the release page. */
const notesOf = (info) => (info?.notes || "").split(/^## Download/m)[0].replace(/\r/g, "").trim();

function Notes({ info }) {
  const text = notesOf(info);
  return text ? html`<pre class="upd-notes">${text}</pre>` : html`<p class="muted">See what's new on the <a href="#" onClick=${(e) => { e.preventDefault(); updates.openPage(); }}>release page</a>.</p>`;
}

/** The bar above the editor while there's something to say about an update. */
export function UpdateBar() {
  const u = useStore((s) => s.update);
  const [notes, setNotes] = useState(false);
  if (!u || u.hidden || !["available", "downloading", "ready", "installing", "error"].includes(u.phase) || (u.phase === "error" && !u.info)) return null;
  const v = u.info?.version;
  return html`<div class="update-bar">
    <${Icon} n="download" />
    ${u.phase === "available" && html`<span><b>Cutline ${v}</b> is available (you have ${u.info.current}).</span>
      <button class="link" onClick=${() => setNotes(!notes)}>What's new</button>
      <span class="spacer" />
      <button class="primary" onClick=${downloadUpdate}>${u.info.canInstall ? "Update now" : "Download"}</button>
      <button onClick=${later}>Later</button>`}
    ${u.phase === "downloading" && html`<span>Downloading Cutline ${v}… ${Math.round((u.progress || 0) * 100)}%</span>
      <span class="upd-progress"><i style=${{ width: `${Math.round((u.progress || 0) * 100)}%` }} /></span>
      <span class="spacer" />`}
    ${u.phase === "ready" && html`<span><b>Cutline ${v}</b> is ready. Cutline will save your project, close, update and open again.</span>
      <span class="spacer" />
      <button class="primary" onClick=${installUpdate}>Restart & update</button>
      <button onClick=${() => put({ hidden: true })}>Later</button>`}
    ${u.phase === "installing" && html`<span>Installing Cutline ${v} — it will open again in a moment…</span><span class="spacer" />`}
    ${u.phase === "error" && html`<span class="warn">Update failed: ${u.error}</span><span class="spacer" />
      <button onClick=${downloadUpdate}>Try again</button><button onClick=${() => put({ hidden: true })}>✕</button>`}
    ${notes && u.phase === "available" && html`<div class="upd-pop"><${Notes} info=${u.info} /></div>`}
  </div>`;
}

/** Settings › Updates. */
export function UpdatesSection({ Row }) {
  const u = useStore((s) => s.update) || { phase: "idle" };
  useStore((s) => s.settings);
  const [version, setVersion] = useState(null);
  useEffect(() => { updates?.check().then((i) => setVersion(i.current)).catch(() => {}); }, []);
  if (!updates) return html`<p class="muted">Updates are part of the desktop app. In the browser you always get the latest version.</p>`;
  const busy = ["checking", "downloading", "installing"].includes(u.phase);
  return html`
    <${Row} label="Version" hint=${version ? `You have Cutline ${version}.` : ""}>
      <button disabled=${busy} onClick=${() => checkForUpdates(true)}><${Icon} n="refresh-cw" /> ${u.phase === "checking" ? "Checking…" : "Check for updates"}</button><//>
    ${u.phase === "latest" && html`<p class="ok-text">You have the newest version (${u.info.current}).</p>`}
    ${u.phase === "error" && html`<p class="warn">${u.error}</p>`}
    ${["available", "downloading", "ready", "installing"].includes(u.phase) && html`<div class="upd-box">
      <p><b>Cutline ${u.info.version}</b> is available.</p>
      <${Notes} info=${u.info} />
      ${u.phase === "available" && html`<button class="primary" onClick=${downloadUpdate}>${u.info.canInstall ? "Update now" : "Download"}</button>`}
      ${u.phase === "downloading" && html`<p>Downloading… ${Math.round((u.progress || 0) * 100)}%</p>`}
      ${u.phase === "ready" && html`<button class="primary" onClick=${installUpdate}>Restart & update</button>`}
      ${u.phase === "installing" && html`<p>Installing — Cutline will open again in a moment…</p>`}
    </div>`}
    <${Row} label="Automatic checks" hint="Look for a new version when Cutline opens (nothing is installed without your click).">
      <label class="check"><input type="checkbox" checked=${settings().autoUpdate !== false} onChange=${(e) => setSetting("autoUpdate", e.target.checked)} /> Check for updates automatically</label><//>`;
}
