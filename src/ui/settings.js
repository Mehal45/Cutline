// Menu › Settings: a page of app-wide options, grouped like the settings of CapCut / Premiere.
import { useState } from "react";
import { useStore, setState, getState } from "../store.js";
import { settings, setSetting, DEFAULTS } from "../settings.js";
import { setToggle } from "./timeline.js";
import { html, Icon } from "./kit.js";
import { UpdatesSection } from "./updates.js";

const desktop = typeof window !== "undefined" ? window.cutlineDesktop : null;
const SECTIONS = [["projects", "Projects & saving", "folder"], ["export", "Export", "upload"], ["preview", "Preview & playback", "monitor-play"],
  ["timeline", "Timeline", "gallery-horizontal-end"], ["performance", "Performance", "cpu"], ["updates", "Updates", "download"]];

function Row({ label, hint, children }) {
  return html`<div class="set-row"><div class="set-label"><b>${label}</b>${hint && html`<span class="muted">${hint}</span>`}</div><div class="set-ctl">${children}</div></div>`;
}

function Select({ k, options, num }) {
  const v = settings()[k];
  return html`<select value=${String(v)} onChange=${(e) => setSetting(k, num && e.target.value !== "project" ? +e.target.value : e.target.value)}>
    ${options.map(([val, label]) => html`<option key=${val} value=${String(val)}>${label}</option>`)}
  </select>`;
}

function Folder({ k, empty }) {
  const v = settings()[k];
  const pick = async () => { const p = await desktop?.pickFolder?.(v || undefined); if (p) setSetting(k, p); };
  return html`<div class="set-folder">
    <span class="ell" title=${v || empty}>${v || empty}</span>
    ${desktop ? html`<button onClick=${pick}><${Icon} n="folder-open" /> Choose…</button>` : html`<span class="muted">Desktop app only</span>`}
    ${v && html`<button class="ibtn" title="Back to the default" onClick=${() => setSetting(k, "")}><${Icon} n="rotate-ccw" /></button>`}
  </div>`;
}

const Check = ({ k, label }) => html`<label class="check"><input type="checkbox" checked=${!!settings()[k]} onChange=${(e) => setSetting(k, e.target.checked)} /> ${label}</label>`;

export function SettingsDialog({ onClose }) {
  useStore((s) => s.settings);
  const st = {
    q: useStore((s) => s.previewQuality), fps: useStore((s) => s.previewFps), snap: useStore((s) => s.snap), mag: useStore((s) => s.mainMagnet),
    link: useStore((s) => s.linkage), axis: useStore((s) => s.previewAxis), rem: useStore((s) => s.rememberText),
  };
  const [sec, setSec] = useState("projects");
  const keep = (k, key, v) => { setState({ [k]: v }); try { localStorage.setItem(key, v === true ? "1" : v === false ? "" : v); } catch { /* ignore */ } };
  const gpuStart = useState(() => settings().gpu)[0];
  return html`<div class="modal-bg" onPointerDown=${onClose}>
    <div class="modal settings" onPointerDown=${(e) => e.stopPropagation()}>
      <div class="row between"><h3><${Icon} n="settings" /> Settings</h3><button onClick=${onClose}>✕</button></div>
      <div class="set-body">
        <nav class="set-nav">
          ${SECTIONS.map(([k, label, icon]) => html`<button key=${k} class=${sec === k ? "on" : ""} onClick=${() => setSec(k)}><${Icon} n=${icon} /> ${label}</button>`)}
        </nav>
        <div class="set-page">
          ${sec === "projects" && html`
            <${Row} label="Save new projects in" hint="Untitled projects are saved here when you close Cutline, and Save asks here first.">
              <${Folder} k="projectsDir" empty="Documents › Cutline Projects" /><//>
            <${Row} label="Autosave" hint="Projects that have a file are saved quietly this often (and always when you close Cutline).">
              <${Select} k="autosaveSec" num options=${[[10, "Every 10 seconds"], [20, "Every 20 seconds"], [60, "Every minute"], [300, "Every 5 minutes"], [0, "Only when closing"]]} /><//>
            <${Row} label="When Cutline opens">
              <${Select} k="startScreen" options=${[["home", "Show recent projects"], ["last", "Open the last project"]]} /><//>`}
          ${sec === "export" && html`
            <${Row} label="Default resolution"><${Select} k="exportRes" num options=${[["project", "Same as the project"], [2160, "4K (2160p)"], [1440, "1440p"], [1080, "1080p"], [720, "720p"], [480, "480p"]]} /><//>
            <${Row} label="Default frame rate"><${Select} k="exportFps" num options=${[["project", "Same as the project"], [24, "24 fps"], [25, "25 fps"], [30, "30 fps"], [50, "50 fps"], [60, "60 fps"]]} /><//>
            <${Row} label="Default format"><${Select} k="exportCodec" options=${[["avc", "H.264 (plays everywhere)"], ["hevc", "H.265 / HEVC (smaller)"], ["av1", "AV1 (smallest, slower)"], ["vp9", "VP9"]]} /><//>
            <${Row} label="Default quality"><${Select} k="exportQuality" options=${[["max", "Maximum"], ["high", "High"], ["standard", "Standard"], ["small", "Small file"], ["custom", "Custom bitrate"]]} /><//>
            <${Row} label="Encoder" hint="Hardware uses your graphics card (fast). Software uses the processor (slower, works everywhere). Auto tries hardware and falls back to software if it fails.">
              <${Select} k="encoder" options=${[["auto", "Auto (recommended)"], ["hardware", "Hardware (GPU)"], ["software", "Software (CPU)"]]} /><//>
            <${Row} label="Save exported videos in" hint="Where Save MP4 / PNG / WAV put the file.">
              <${Folder} k="exportDir" empty="Ask every time (starts in Downloads)" /><//>
            ${settings().exportDir && html`<${Row} label=""><${Check} k="askExportPath" label="Still ask for the name and place each time" /><//>`}`}
          ${sec === "preview" && html`
            <${Row} label="Preview quality" hint="Lower is smoother on slower computers. Export is always full quality.">
              <select value=${String(st.q ?? 1)} onChange=${(e) => keep("previewQuality", "cutline.previewQuality", +e.target.value)}>
                <option value="1">Full</option><option value="0.5">Half</option><option value="0.25">Quarter</option></select><//>
            <${Row} label="Preview frame rate" hint="How many frames a second the player draws while playing. Lower uses less CPU / GPU.">
              <select value=${String(st.fps || 60)} onChange=${(e) => keep("previewFps", "cutline.previewFps", +e.target.value)}>
                ${[60, 30, 24, 20, 15].map((v) => html`<option key=${v} value=${v}>${v} fps</option>`)}</select><//>`}
          ${sec === "timeline" && html`
            <${Row} label="Picture length" hint="How long a photo is when you add it."><${Select} k="imageDur" num options=${[[2, "2 seconds"], [3, "3 seconds"], [4, "4 seconds"], [5, "5 seconds"], [8, "8 seconds"], [10, "10 seconds"]]} /><//>
            <${Row} label="Text length" hint="How long a new text or shape is."><${Select} k="textDur" num options=${[[1, "1 second"], [2, "2 seconds"], [3, "3 seconds"], [5, "5 seconds"], [8, "8 seconds"]]} /><//>
            <${Row} label="Timeline"><div class="set-checks">
              <label class="check"><input type="checkbox" checked=${st.mag !== false} onChange=${(e) => setToggle("mainMagnet", e.target.checked)} /> Main track magnet</label>
              <label class="check"><input type="checkbox" checked=${!!st.snap} onChange=${(e) => setToggle("snap", e.target.checked)} /> Auto snapping</label>
              <label class="check"><input type="checkbox" checked=${st.link !== false} onChange=${(e) => setToggle("linkage", e.target.checked)} /> Linkage</label>
              <label class="check"><input type="checkbox" checked=${!!st.axis} onChange=${(e) => setToggle("previewAxis", e.target.checked)} /> Preview axis</label>
            </div><//>
            <${Row} label="Text"><label class="check"><input type="checkbox" checked=${!!st.rem} onChange=${(e) => keep("rememberText", "cutline.rememberText", e.target.checked)} /> New texts use the settings of the text you last styled</label><//>`}
          ${sec === "performance" && html`
            <${Row} label="Graphics acceleration" hint="Uses the graphics card to draw the app and decode video. Turn off only if the window flickers or crashes. Takes effect after restarting Cutline.">
              <${Check} k="gpu" label="Use hardware (GPU) acceleration" /><//>
            ${settings().gpu !== gpuStart && html`<p class="warn">Restart Cutline to apply this.</p>`}`}
          ${sec === "updates" && html`<${UpdatesSection} Row=${Row} />`}
          <div class="set-foot">
            <button onClick=${() => { for (const k of Object.keys(DEFAULTS)) if (k !== "projectsDir" && k !== "exportDir") setSetting(k, DEFAULTS[k]); }}>Reset to defaults</button>
            <button class="primary" onClick=${onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}
