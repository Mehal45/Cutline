// Home screen (desktop app): recent projects, new project, open. Shown when Cutline starts and from Menu › Home.
import { useEffect, useState } from "react";
import { useStore, setState } from "../store.js";
import { desktop, newProject, openProject, openRecent, isDirty } from "../project-io.js";
import { html, Icon } from "./kit.js";

const ago = (ms) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} day${s < 2 * 86400 ? "" : "s"} ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
const folder = (p) => p.replace(/[\\/][^\\/]*$/, "");

export function Home() {
  const [list, setList] = useState(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(null);
  const hasProject = useStore((s) => s.project.main.length + s.project.texts.length + (s.project.overlays?.length || 0) + (s.project.audio?.length || 0) > 0);
  const refresh = () => desktop.recentList().then(setList).catch(() => setList([]));
  useEffect(() => {
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  const open = async (r) => {
    if (!r.exists) return;
    setBusy(r.path);
    const ok = await openRecent(r.path);
    setBusy(null);
    if (!ok) refresh();
  };
  const remove = async (e, r) => { e.stopPropagation(); await desktop.recentRemove(r.path); refresh(); };
  const reveal = (e, r) => { e.stopPropagation(); desktop.showInFolder(r.path); };
  const q = query.trim().toLowerCase();
  const shown = (list || []).filter((r) => !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q));
  return html`<div class="home">
    <div class="home-side">
      <h2>Start</h2>
      <button class="primary home-big" onClick=${newProject}><${Icon} n="plus" /> New project</button>
      <button class="home-big" onClick=${() => openProject()}><${Icon} n="folder-open" /> Open project… <kbd>Ctrl+O</kbd></button>
      ${hasProject && html`<button class="home-big" onClick=${() => setState({ home: false })}>
        <${Icon} n="arrow-left" /> Back to the current project${isDirty() ? " (unsaved)" : ""}</button>`}
    </div>
    <div class="home-main">
      <div class="row between">
        <h2>Recent projects</h2>
        ${list?.length > 6 && html`<input class="home-search" placeholder="Search projects" value=${query} onInput=${(e) => setQuery(e.target.value)} />`}
      </div>
      ${list === null && html`<p class="muted">Loading…</p>`}
      ${list?.length === 0 && html`<p class="muted">No recent projects yet. Projects you open or save will appear here.</p>`}
      <div class="home-grid">
        ${shown.map((r) => html`<div key=${r.path} class=${"home-card" + (r.exists ? "" : " gone") + (busy === r.path ? " busy" : "")}
            onClick=${() => open(r)} title=${r.exists ? r.path : "This file was moved or deleted: " + r.path}>
          <div class="home-thumb">
            ${r.thumb ? html`<img src=${r.thumb} alt="" />` : html`<${Icon} n="clapperboard" />`}
            ${r.dur > 0 && html`<span class="home-dur">${clock(r.dur)}</span>`}
            ${busy === r.path && html`<span class="home-opening">Opening…</span>`}
          </div>
          <div class="home-info">
            <b class="ell">${r.name}</b>
            <span class="muted ell">${r.exists ? `Edited ${ago(r.modified || r.openedAt)}` : "File not found"}</span>
            <span class="muted ell home-path">${folder(r.path)}</span>
          </div>
          <div class="home-btns">
            ${r.exists && html`<button class="ibtn" title="Show in folder" onClick=${(e) => reveal(e, r)}><${Icon} n="folder" /></button>`}
            <button class="ibtn" title="Remove from this list (the file stays)" onClick=${(e) => remove(e, r)}><${Icon} n="x" /></button>
          </div>
        </div>`)}
      </div>
    </div>
  </div>`;
}
