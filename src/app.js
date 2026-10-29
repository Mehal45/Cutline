import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  useStore, getState, setState, edit, editLive, undo, redo, projectDuration, isSelected, select, findItem,
} from "./store.js";
import {
  drawFrame, frameStatus, syncMedia, framesReady, renderLock, activeClips, activeOverlays, itemBounds, hitTest, transformAt, TRANSITIONS,
} from "./engine.js";
import {
  clock, play, pause, togglePlay, seek, toast, importFiles, addMediaToTimeline, splitAtPlayhead, deleteSelection,
  rippleDelete, selectAll, copySettings, pasteSettings, copySelection, cutSelection, paste, duplicateSelection, applyTransition, freezeFrame,
  localTime, splitAllAtPlayhead, toggleMute, zoomTimeline, openPreview, closePreview, zoomToFit, trimToPlayhead,
} from "./actions.js";
import { SourceViewer, toggleSource, stepSource, markSource, addFromSource } from "./ui/source.js";
import { hasKeys, setKey, setStatic } from "./keyframes.js";
import { exportMp4, exportWav, exportFrame, supportedCodecs, VIDEO_CODECS, QUALITY, bitrateFor } from "./export.js";
import { transcribe, wordsToCaptions, CAPTION_MODELS } from "./captions.js";
import { html, fmt, Field, Icon, Slider, secs, NumInput } from "./ui/kit.js";
import { startProxies, setProxyMode } from "./proxy.js";
import { rootProject, createCompound } from "./compound.js";
import { Inspector } from "./ui/inspector.js";
import { Home } from "./ui/home.js";
import { Timeline, dragGesture, setToggle } from "./ui/timeline.js";
import { MaskHandles, CropBox } from "./ui/mask.js";
import { ShapesTab } from "./ui/shapes.js";
import { SettingsDialog } from "./ui/settings.js";
import { UpdateBar, startUpdateChecks } from "./ui/updates.js";
import { cacheGet, cacheSet, mediaKey } from "./cache.js";
import { loadSettings, settings as appSettings, setSetting, lastDur, rememberDur } from "./settings.js";
import {
  EffectsTab, FiltersTab, AudioTab, TextTab, AdjustmentTab, AudioPresetsTab, MediaKitsTab, ElementsTab,
} from "./ui/library.js";
import { EFFECT_CATEGORIES } from "./fx.js";
import { linkWebFonts, loadProjectFonts, loadSystemFonts, loadRecentFonts } from "./ui/fonts.js";
import { loadTextPresets, addDefaultText } from "./presets.js";
import {
  saveProject, openProject, newProject, relink, startAutosave, checkRecovery, restoreRecovery, loadProject, desktop, projectName, openFromDisk, openLastProject,
} from "./project-io.js";
import { announceReady, sendExport } from "./embed.js";

const additiveKey = (e) => e.shiftKey || e.ctrlKey || e.metaKey;
setState({ snap: true, ...(() => { try { return JSON.parse(localStorage.getItem("cutline.timelineToggles") || "{}"); } catch { return {}; } })(), timelineH: Math.max(260, Math.min(460, Math.round(window.innerHeight * 0.38))), previewQuality: (() => { try { return +localStorage.getItem("cutline.previewQuality") || 1; } catch { return 1; } })(),
  rememberText: (() => { try { return !!localStorage.getItem("cutline.rememberText"); } catch { return false; } })(),
  previewFps: (() => { try { return +localStorage.getItem("cutline.previewFps") || 60; } catch { return 60; } })() });

startProxies();
loadSettings();
startUpdateChecks();
import("./decode.js").then((d) => d.startScans(getState, setState));

/** Smooth-preview toggle with the background progress. */
function ProxyButton() {
  const mode = useStore((s) => s.proxyMode);
  const proxies = useStore((s) => s.proxies) || {};
  const media = useStore((s) => s.project.media);
  const building = Object.entries(proxies).find(([id, p]) => p.state === "building" && media[id]);
  const on = mode !== "off";
  const tip = on
    ? (building ? `Preparing smooth preview of ${media[building[0]].name}: ${Math.round((building[1].progress || 0) * 100)}% (pauses while you play)` : "Smooth preview is on: videos play and scrub from light copies made in the background. Export always uses the originals. Click to turn off.")
    : "Smooth preview is off. Click to make light preview copies of your videos in the background (smoother scrubbing and fast-forward).";
  return html`<button class=${"ibtn proxybtn" + (on ? " on" : "")} title=${tip} onClick=${() => setProxyMode(on ? "off" : "on")}>
    <${Icon} n="zap" />${on && building && html`<em>${Math.round((building[1].progress || 0) * 100)}%</em>`}
  </button>`;
}

// ---------------- render loop ----------------

function startRenderLoop(canvas) {
  const ctx = canvas.getContext("2d");
  let raf, held = 0, lastDraw = 0;
  const tick = (now) => {
    raf = requestAnimationFrame(tick);
    if (renderLock.exporting) return;
    const s = getState();
    // Preview frame rate (while playing): skip screen refreshes to draw at most previewFps frames a second.
    const fps = s.previewFps || 60;
    if (s.playing && fps < 60 && now - lastDraw < 1000 / fps - 4) return;
    lastDraw = now;
    let t = s.time;
    if (s.playing) {
      t = clock.startT + (performance.now() - clock.startNow) / 1000;
      const dur = projectDuration(s.project);
      if (t >= dur) { t = dur; pause(); }
      setState({ time: t });
    } else if (s.hoverTime != null) t = s.hoverTime; // preview axis: show the moment under the mouse
    syncMedia(s.project, t, s.playing);
    // At a cut the next clip's player may still be seeking: keep the last frame on screen for a moment
    // (never more than ~0.4 s) rather than flash a wrong frame.
    if (s.playing && !framesReady(s.project, t)) {
      held ||= performance.now();
      if (performance.now() - held < 400) return;
    }
    held = 0;
    drawFrame(ctx, s.project, t);
    if (frameStatus.loading !== !!s.clipLoading) setState({ clipLoading: frameStatus.loading });
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

const download = (blob, name) => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

// ---------------- resizable panels ----------------

/** Widths of the library (left) and inspector (right) columns: dragged by the user, remembered. */
const defaultCols = () => ({ left: Math.max(260, Math.round(window.innerWidth * 0.27)), right: Math.max(300, Math.round(window.innerWidth * 0.28)) });
function useColumns() {
  const saved = useStore((s) => s.panelCols);
  const [, force] = useState(0);
  useEffect(() => { const r = () => force((n) => n + 1); window.addEventListener("resize", r); return () => window.removeEventListener("resize", r); }, []);
  const c = { ...defaultCols(), ...(saved || {}) };
  // Always leave the player at least 360 px.
  const room = window.innerWidth - 12 - 360;
  if (c.left + c.right > room) { const k = room / (c.left + c.right); c.left = Math.round(c.left * k); c.right = Math.round(c.right * k); }
  return c;
}
try { const c = JSON.parse(localStorage.getItem("cutline.panelCols") || "null"); if (c) setState({ panelCols: c }); } catch { /* ignore */ }

/** The bar between two columns: drag to resize, double-click to reset. */
function ColResize({ side }) {
  const start = (e) => {
    if (e.button !== 0) return;
    const c0 = { ...defaultCols(), ...(getState().panelCols || {}) }, x0 = e.clientX;
    dragGesture(e, (ev) => {
      const d = ev.clientX - x0;
      const max = window.innerWidth - 12 - 360 - (side === "left" ? c0.right : c0.left);
      const w = Math.max(200, Math.min(max, side === "left" ? c0.left + d : c0.right - d));
      setState({ panelCols: { ...c0, [side]: Math.round(w) } });
    }, { undoable: false, onEnd: () => { try { localStorage.setItem("cutline.panelCols", JSON.stringify(getState().panelCols)); } catch {} } });
  };
  const reset = () => { const c = { ...(getState().panelCols || {}) }; delete c[side]; setState({ panelCols: c }); try { localStorage.setItem("cutline.panelCols", JSON.stringify(c)); } catch {} };
  return html`<div class="col-resize" title="Drag to resize · double-click to reset" onPointerDown=${start} onDoubleClick=${reset} />`;
}

// ---------------- top bar ----------------

function MainMenu({ onShortcuts, onExport }) {
  const [open, setOpen] = useState(false);
  const input = useRef();
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!e.target.closest(".menu")) setOpen(false); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  const run = (fn) => () => { setOpen(false); fn(); };
  const exportAudio = async () => {
    try { toast("Mixing audio…"); download(await exportWav(rootProject()), projectName() + ".wav"); }
    catch (err) { toast(err.message); }
  };
  const snapshot = async () => {
    try { download(await exportFrame(getState().project, getState().time), `${projectName()} ${getState().time.toFixed(2)}s.png`); }
    catch (err) { toast(err.message); }
  };
  return html`<div class="menu">
    <button class="menu-btn" onClick=${() => setOpen(!open)}>Menu <${Icon} n="chevron-down" /></button>
    <input ref=${input} type="file" accept=".cutline,application/json" hidden onChange=${(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openProject(f); }} />
    ${open && html`<div class="menu-list">
      ${desktop && html`<button onClick=${run(() => setState({ home: true }))}>Home (recent projects)</button>`}
      <button onClick=${run(newProject)}>New project <kbd>Ctrl+W</kbd></button>
      <button onClick=${run(() => (desktop ? openProject() : input.current.click()))}>Open… <kbd>Ctrl+O</kbd></button>
      <button onClick=${run(() => saveProject())}>Save <kbd>Ctrl+S</kbd></button>
      <button onClick=${run(() => saveProject({ saveAs: true }))}>Save as… <kbd>Ctrl+Shift+S</kbd></button>
      <hr />
      <button onClick=${run(() => document.getElementById("import-any")?.click())}>Import media… <kbd>Ctrl+I</kbd></button>
      <button onClick=${run(onExport)}>Export video… <kbd>Ctrl+E</kbd></button>
      <button onClick=${run(snapshot)}>Export this frame (PNG)</button>
      <button onClick=${run(exportAudio)}>Export audio (WAV)</button>
      <hr />
      <button onClick=${run(undo)}>Undo <kbd>Ctrl+Z</kbd></button>
      <button onClick=${run(redo)}>Redo <kbd>Ctrl+Y</kbd></button>
      <button onClick=${run(onShortcuts)}>Keyboard shortcuts <kbd>?</kbd></button>
      <button onClick=${run(() => setState({ settingsOpen: true }))}>Settings… <kbd>Ctrl+,</kbd></button>
    </div>`}
  </div>`;
}

function SaveStatus() {
  const at = useStore((s) => s.autoSavedAt);
  useStore((s) => s.project); // re-check "unsaved" when the project changes
  if (at) return html`<span class="savestat"><${Icon} n="circle-check" /> ${desktop ? "Auto saved" : "Saved"}: ${new Date(at).toLocaleTimeString()}</span>`;
  return html`<span class="savestat dim">${desktop ? "Not saved yet" : "Not saved yet — Menu › Save"}</span>`;
}

function Header({ onExport, onShortcuts }) {
  useStore((s) => s.projectPath); // re-render when another project is opened or saved under a new name
  const name = projectName();
  return html`<header class="topbar">
    <div class="row">
      <div class="brand"><${Icon} n="scissors" /> Cutline</div>
      <${MainMenu} onShortcuts=${onShortcuts} onExport=${onExport} />
      <${SaveStatus} />
    </div>
    <div class="title ell">${name}</div>
    <div class="row">
      <button class="ibtn" onClick=${onShortcuts} title="Keyboard shortcuts (?)"><${Icon} n="keyboard" /></button>
      <button class="ibtn" onClick=${() => setState({ settingsOpen: true })} title="Settings (Ctrl+,)"><${Icon} n="settings" /></button>
      <button class="export-btn" onClick=${onExport} title="Export (Ctrl+E)"><${Icon} n="upload" /> Export</button>
    </div>
  </header>`;
}

// ---------------- left panel: icon tabs + sub-menu + content ----------------

const LIB_TABS = [
  ["media", "Media", "film"],
  ["elements", "Elements", "shapes"],
  ["shapes", "Shapes", "triangle"],
  ["audio", "Audio", "music"],
  ["text", "Text", "type"],
  ["effects", "Effects", "sparkles"],
  ["transitions", "Transitions", "arrow-left-right"],
  ["captions", "Captions", "captions"],
  ["filters", "Filters", "aperture"],
  ["adjust", "Adjustment", "sliders-horizontal"],
];

const SUB_NAV = {
  media: [["library", "Library"], ["kits", "My kits"]],
  elements: [["mine", "My elements"]],
  shapes: [["basic", "Shapes"], ["arrows", "Arrows"]],
  audio: [["music", "Music & sounds"], ["tts", "Text to speech"], ["mine", "My presets"]],
  text: [["mine", "My presets"], ["add", "Add text"], ["presets", "Text presets"], ["captions", "Auto captions"]],
  effects: EFFECT_CATEGORIES.map((c, i) => [String(i), c]),
  transitions: [["all", "Transitions"]],
  captions: [["auto", "Auto captions"]],
  filters: [["all", "Filters"]],
  adjust: [["layer", "Adjustment layer"]],
};

function LeftPanel() {
  const [tab, setTab] = useState("media");
  const [subs, setSubs] = useState({});
  const sub = subs[tab] ?? SUB_NAV[tab][0][0];
  const strip = useRef();
  return html`<aside class="panel left">
    <nav class="libtabs" ref=${strip}>
      ${LIB_TABS.map(([k, l, icon]) => html`<button key=${k} class=${tab === k ? "on" : ""} onClick=${() => setTab(k)} title=${l}>
        <${Icon} n=${icon} size=${18} /><span>${l}</span>
      </button>`)}
      <button class="libmore" title="More" onClick=${() => strip.current && (strip.current.scrollLeft += 160)}><${Icon} n="chevron-right" /></button>
    </nav>
    <div class="libbody">
      <div class="subnav">
        ${SUB_NAV[tab].map(([k, l]) => html`<button key=${k} class=${sub === k ? "on" : ""} onClick=${() => setSubs({ ...subs, [tab]: k })}>${l}</button>`)}
      </div>
      <div class="libcontent">
        ${tab === "media" && (sub === "kits" ? html`<${MediaKitsTab} />` : html`<${MediaTab} />`)}
        ${tab === "elements" && html`<${ElementsTab} />`}
        ${tab === "shapes" && html`<${ShapesTab} part=${sub} />`}
        ${tab === "audio" && (sub === "mine" ? html`<${AudioPresetsTab} />` : html`<${AudioTab} part=${sub} />`)}
        ${tab === "text" && (sub === "captions" ? html`<${CaptionsForm} />` : html`<${TextTab} part=${sub} />`)}
        ${tab === "effects" && html`<${EffectsTab} cat=${+sub} />`}
        ${tab === "transitions" && html`<${TransitionsTab} />`}
        ${tab === "captions" && html`<${CaptionsForm} />`}
        ${tab === "filters" && html`<${FiltersTab} />`}
        ${tab === "adjust" && html`<${AdjustmentTab} />`}
      </div>
    </div>
  </aside>`;
}

/**
 * A video's picture in the library. Taken from the video once, then kept on disk, so the library doesn't open
 * every recording again each time the app starts.
 */
function MediaPoster({ m }) {
  const key = "poster|" + mediaKey(m);
  const [img, setImg] = useState(() => posters.get(key));
  useEffect(() => {
    if (img) return;
    let alive = true;
    cacheGet(key).then((v) => alive && setImg(v || false));
    return () => { alive = false; };
  }, [key]);
  if (img) return html`<img src=${img} draggable="false" />`;
  if (img === undefined || !m.url) return html`<div class="poster-wait" />`;
  const grab = (e) => {
    const v = e.currentTarget;
    try {
      const c = document.createElement("canvas");
      c.width = 192; c.height = Math.max(1, Math.round((192 * v.videoHeight) / Math.max(1, v.videoWidth)));
      c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", 0.75);
      posters.set(key, url);
      cacheSet(key, url);
      setImg(url);
    } catch { /* keep the video */ }
  };
  return html`<video src=${m.url + "#t=0.5"} crossOrigin="anonymous" muted preload="metadata" onSeeked=${grab} onLoadedData=${(e) => e.currentTarget.currentTime >= 0.4 && grab(e)} />`;
}
const posters = new Map(); // key -> data URL (this session)

function MediaTab() {
  const media = useStore((s) => s.project.media);
  const previewing = useStore((s) => s.preview?.mediaId);
  const proxies = useStore((s) => s.proxies);
  const scans = useStore((s) => s.scans);
  const input = useRef();
  const [drag, setDrag] = useState(false);
  const items = Object.values(media);
  return html`<div class=${"media-drop" + (drag ? " on" : "")}
      onDragOver=${(e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); setDrag(true); } }}
      onDragLeave=${() => setDrag(false)}
      onDrop=${(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setDrag(false); importFiles([...e.dataTransfer.files]); }}>
    <button class="import-btn" onClick=${() => input.current.click()}><${Icon} n="plus" /> Import</button>
    <input ref=${input} type="file" multiple accept="video/*,image/*,audio/*" hidden
      onChange=${(e) => { importFiles([...e.target.files]); e.target.value = ""; }} />
    ${!items.length && html`<div class="drop-hint"><${Icon} n="upload" size=${28} /><span>Drag and drop videos, photos and audio here</span></div>`}
    <div class="media-grid">
      ${items.map((m) => html`<div class=${"mcard" + (m.missing ? " missing" : "") + (previewing === m.id ? " active" : "")} key=${m.id}
          title=${m.missing ? "File not found — use Menu › Open again or relink" : `${m.name}\nClick to preview · double-click to add · drag onto the timeline`}
          draggable=${!m.missing}
          onDragStart=${(e) => { e.dataTransfer.setData("text/x-cutline-media", m.id); e.dataTransfer.effectAllowed = "copy"; }}
          onClick=${() => !m.missing && m.kind !== "compound" && openPreview(m.id)}
          onDoubleClick=${() => !m.missing && addMediaToTimeline(m)}>
        <div class="mthumb">
          ${m.kind === "image" ? html`<img src=${m.url} draggable="false" />`
            : m.kind === "audio" ? html`<div class="audio-thumb"><${Icon} n="audio-lines" size=${26} /></div>`
            : m.kind === "compound" ? html`<div class="audio-thumb compound-thumb"><${Icon} n="layers" size=${26} /></div>`
            : html`<${MediaPoster} m=${m} />`}
          <span class="mdur">${m.missing ? "missing" : m.kind === "image" ? "" : fmt(m.duration).replace(/\.\d+$/, "")}</span>
          ${m.path && scans?.[m.path] != null && scans[m.path] < 1 && html`<span class="mproxy busy" title="Reading this recording once so exports are fast">⏳ ${Math.round(scans[m.path] * 100)}%</span>`}
          ${proxies?.[m.id]?.state === "ready" && html`<span class="mproxy" title="Smooth preview ready">⚡</span>`}
          ${proxies?.[m.id]?.state === "building" && html`<span class="mproxy busy" title="Preparing smooth preview…">${Math.round((proxies[m.id].progress || 0) * 100)}%</span>`}
          ${m.noPicture && html`<span class="mwarn" title="This video's format can't be shown. Convert it to MP4 (H.264).">⚠</span>`}
          ${!m.missing && html`<button class="madd" title=${m.kind === "audio" ? "Add to an audio track at the playhead" : "Add to the end of the main track"}
            onClick=${(e) => { e.stopPropagation(); addMediaToTimeline(m); }}><${Icon} n="plus" /></button>`}
          ${!m.missing && m.kind !== "audio" && html`<button class="mlayer" title="Add as a picture-in-picture layer at the playhead"
            onClick=${(e) => { e.stopPropagation(); addMediaToTimeline(m, "overlay"); }}><${Icon} n="layers" /></button>`}
        </div>
        <span class="mname ell">${m.name}</span>
      </div>`)}
    </div>
  </div>`;
}

function TransitionsTab() {
  const [dur, setDur] = useState(() => lastDur("transition", 0.6));
  return html`<div>
    <p class="muted">Select a ◆ cut or a clip, then pick a transition. With nothing selected it goes on the cut nearest the playhead.</p>
    <div class="grid2">
      ${Object.entries(TRANSITIONS).map(([k, label]) => html`<button key=${k} class="tr-tile" onClick=${() => applyTransition(k, dur)}>
        <span class=${"tr-icon tr-" + k}></span>${label}
      </button>`)}
    </div>
    <${Slider} label="Duration" value=${dur} min=${0.1} max=${3} step=${0.05} format=${secs} onChange=${(v) => { setDur(v); rememberDur("transition", v); }} />
    <button class="wide" onClick=${() => applyTransition("crossfade", dur, true)}>Cross fade every cut</button>
  </div>`;
}

// ---------------- player + on-screen transform controls ----------------

/** The playhead time under the player (its own component, so the player doesn't redraw every frame). */
function TimeReadout() {
  return fmt(useStore((s) => s.time));
}

function Player() {
  const canvas = useRef();
  const stage = useRef();
  const { width, height } = useStore((s) => s.project);
  const playing = useStore((s) => s.playing);
  const duration = useStore((s) => projectDuration(s.project));
  const previewW = width >= height ? 960 : Math.round(960 * (width / height));
  const previewH = Math.round(previewW * (height / width));
  const quality = useStore((s) => s.previewQuality) ?? 1;
  const [rect, setRect] = useState(null);

  useEffect(() => startRenderLoop(canvas.current), []);
  useLayoutEffect(() => {
    const update = () => {
      const c = canvas.current, st = stage.current;
      // Fit the whole frame inside the stage (letterboxed), whatever the window and aspect ratio.
      const pad = 24;
      const aw = Math.max(10, st.clientWidth - pad), ah = Math.max(10, st.clientHeight - pad);
      const k = Math.min(aw / previewW, ah / previewH);
      const w = Math.floor(previewW * k), h = Math.floor(previewH * k);
      if (c.style.width !== w + "px") c.style.width = w + "px";
      if (c.style.height !== h + "px") c.style.height = h + "px";
      // Render resolution: the on-screen size (sharp on high-DPI screens) × the chosen preview quality,
      // never above the project's own resolution. Lower = smoother playback on slower computers.
      const bw = Math.max(64, Math.round(Math.min(width, w * (window.devicePixelRatio || 1) * quality)));
      const bh = Math.max(36, Math.round((bw * previewH) / previewW));
      if (c.width !== bw) c.width = bw;
      if (c.height !== bh) c.height = bh;
      setRect({ left: c.offsetLeft, top: c.offsetTop, width: c.offsetWidth, height: c.offsetHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas.current);
    ro.observe(stage.current);
    return () => ro.disconnect();
  }, [previewW, previewH, quality, width]);

  const previewing = useStore((s) => !!s.preview);
  const ratio = (w, h) => edit((p) => Object.assign(p, { width: w, height: h }));
  return html`<section class=${"panel player" + (previewing ? " previewing" : "")}>
    ${previewing && html`<${SourceViewer} />`}
    <div class="phead"><span>Player</span><span class="muted">${width}×${height} · ${useStore((s) => s.project.fps)} fps</span></div>
    <div class="stage" ref=${stage}>
      <canvas ref=${canvas} width=${previewW} height=${previewH} />
      ${useStore((s) => s.clipLoading) && html`<div class="clip-loading"><span class="spin" /> Loading video…</div>`}
      ${rect && html`<${TransformOverlay} rect=${rect} />`}
      ${duration <= 0 && html`<div class="stage-hint">
        <b>The timeline is empty</b>
        <span>This screen shows your timeline. Click a video in the library on the left to watch it here,
          then press <b>Add to timeline</b> (or double-click it, or drag it onto the timeline).</span>
      </div>`}
    </div>
    <div class="transport">
      <span class="tc"><b><${TimeReadout} /></b> <span>${fmt(duration)}</span></span>
      <span class="tcenter">
        <button class="ibtn" onClick=${() => seek(0)} title="Go to start (Home)"><${Icon} n="skip-back" /></button>
        <button class="ibtn play" onClick=${togglePlay} title="Play/pause (Space)"><${Icon} n=${playing ? "pause" : "play"} size=${18} /></button>
        <button class="ibtn" onClick=${() => seek(duration)} title="Go to end (End)"><${Icon} n="skip-forward" /></button>
      </span>
      <span class="tright">
        <select class="pq" value=${quality} title="Preview quality: lower is smoother on slower computers (export is always full quality)"
          onChange=${(e) => { const q = +e.target.value; setState({ previewQuality: q }); try { localStorage.setItem("cutline.previewQuality", q); } catch {} }}>
          <option value="1">Full</option>
          <option value="0.5">½</option>
          <option value="0.25">¼</option>
        </select>
        <select class="pq" value=${useStore((s) => s.previewFps) || 60} title="Preview frame rate while playing: lower uses less CPU / GPU (export always uses the project's fps)"
          onChange=${(e) => { const v = +e.target.value; setState({ previewFps: v }); try { localStorage.setItem("cutline.previewFps", v); } catch {} }}>
          ${[60, 30, 24, 20, 15].map((v) => html`<option value=${v}>${v} fps</option>`)}
        </select>
        <${ProxyButton} />
        <button class=${"ibtn" + (useStore((s) => s.axis) ? " on" : "")} onClick=${() => setState({ axis: !getState().axis })} title="Guides and safe area (G)"><${Icon} n="scan" /></button>
        <select class="pq" title="Canvas ratio" value=${`${width}x${height}`} onChange=${(e) => { const [w, h] = e.target.value.split("x").map(Number); ratio(w, h); }}>
          ${[["16:9", 1920, 1080], ["9:16", 1080, 1920], ["1:1", 1080, 1080], ["4:5", 1080, 1350], ["4:3", 1440, 1080], ["21:9", 2560, 1080]].map(([l, w, h]) => html`<option value=${`${w}x${h}`}>${l}</option>`)}
          ${![[1920, 1080], [1080, 1920], [1080, 1080], [1080, 1350], [1440, 1080], [2560, 1080]].some(([w, h]) => w === width && h === height) && html`<option value=${`${width}x${height}`}>Ratio</option>`}
        </select>
        <button class="ibtn" title="Full screen" onClick=${() => (document.fullscreenElement ? document.exitFullscreen() : stage.current.requestFullscreen?.())}><${Icon} n="maximize" /></button>
      </span>
    </div>
  </section>`;
}

/** Items visible at time t, topmost first: texts (later = on top), overlay layers (top track first), then the main clip(s). */
function visibleItems(project, t) {
  const texts = project.texts.filter((x) => t >= x.start && t < x.start + x.dur).reverse().map((x) => ({ kind: "text", item: x }));
  const layers = activeOverlays(project, t).reverse().map((o) => ({ kind: "overlay", item: o.item }));
  const clips = activeClips(project, t).clips.map((c) => ({ kind: "main", item: project.main.find((s) => s.id === c.seg.id) }));
  const ts = project.trackState || {};
  const key = (v) => (v.kind === "main" ? "main" : v.kind === "text" ? "text" : `overlay:${v.item.track ?? 0}`);
  return [...texts, ...layers, ...clips].filter((v) => v.item && (v.kind === "text" || project.media[v.item.mediaId]?.kind !== "audio")
    && !ts[key(v)]?.hidden && !ts[key(v)]?.locked);
}

/**
 * Writes position/scale/rotation from a drag. Keyframed properties get a keyframe at the playhead;
 * others change their static value (texts keep x/y at the top level, clips/layers in `transform`).
 */
function setProps(p, kind, id, props, time) {
  const it = findItem(p, kind, id);
  if (!it) return;
  const lt = Math.max(0, Math.min(it.dur, localTime(p, kind, it, time)));
  for (const [k, v] of Object.entries(props)) {
    if (hasKeys(it, k)) setKey(it, k, lt, v);
    else if (kind === "text") it[k] = v;
    else setStatic(it, k, v);
  }
}

function TransformOverlay({ rect }) {
  const project = useStore((s) => s.project);
  const time = useStore((s) => (s.playing && !s.selection.length ? Math.floor(s.time * 4) / 4 : s.time));
  const selection = useStore((s) => s.selection);
  const guides = useStore((s) => s.guides);
  const axis = useStore((s) => s.axis);
  const maskEditing = useStore((s) => s.maskEditing);
  const cropping = useStore((s) => s.cropping);
  const ref = useRef();
  const W = project.width, H = project.height;
  const visible = visibleItems(project, time);
  const selectedVisible = visible.filter((v) => isSelected(v.kind, v.item.id));
  const bounds = (kind, item) => itemBounds(project, kind, item, W, H, time);

  const toFrac = (ev) => {
    const r = ref.current.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
  };
  const getXY = (kind, it) => transformAt(it, localTime(getState().project, kind, it, time), kind === "text");

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    if (getState().playing) pause();
    const pt = toFrac(e);
    const hit = visible.find((v) => hitTest(bounds(v.kind, v.item), pt.x, pt.y, W, H));
    if (!hit) {
      if (!additiveKey(e)) select([]);
      return;
    }
    const target = { kind: hit.kind, id: hit.item.id };
    if (additiveKey(e)) select([target], true);
    else if (!isSelected(target.kind, target.id)) select([target]);
    // Move every selected item that is on screen.
    const movers = visibleItems(getState().project, time)
      .filter((v) => isSelected(v.kind, v.item.id))
      .map((v) => ({ kind: v.kind, id: v.item.id, start: getXY(v.kind, v.item) }));
    const r = ref.current.getBoundingClientRect();
    dragGesture(e, (ev, dx, dy) => {
      let fx = dx / r.width, fy = dy / r.height;
      let g = null;
      if (movers.length === 1) {
        // Snap the item's center to the canvas center lines.
        const m = movers[0];
        if (Math.abs(m.start.x + fx - 0.5) < 0.012) { fx = 0.5 - m.start.x; g = { ...g, v: true }; }
        if (Math.abs(m.start.y + fy - 0.5) < 0.012) { fy = 0.5 - m.start.y; g = { ...g, h: true }; }
      }
      editLive((p) => movers.forEach((m) => setProps(p, m.kind, m.id, { x: m.start.x + fx, y: m.start.y + fy }, time)));
      setState({ guides: g });
    });
  };

  const startScale = (e, kind, item) => {
    const b = bounds(kind, item);
    const r = ref.current.getBoundingClientRect();
    const cx = r.left + b.cx * r.width, cy = r.top + b.cy * r.height;
    const d0 = Math.hypot(e.clientX - cx, e.clientY - cy);
    const s0 = getXY(kind, item).scale;
    dragGesture(e, (ev) => {
      const d = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      const scale = Math.max(0.05, Math.min(10, (s0 * d) / Math.max(1, d0)));
      editLive((p) => setProps(p, kind, item.id, { scale }, time));
    });
  };

  // Text box width (side handles): wider = fewer line breaks; wide enough and it's one line.
  const startBoxWidth = (e, item) => {
    const b = bounds("text", item);
    const r = ref.current.getBoundingClientRect();
    const cx = r.left + b.cx * r.width, cy = r.top + b.cy * r.height;
    const rad = (b.rotation * Math.PI) / 180;
    const scale = getXY("text", item).scale || 1;
    dragGesture(e, (ev) => {
      // Distance from the centre along the text's own horizontal axis, in frame pixels.
      const dx = ev.clientX - cx, dy = ev.clientY - cy;
      const half = Math.abs(dx * Math.cos(rad) + dy * Math.sin(rad)) * (W / r.width);
      const boxW = Math.max(0.03, Math.min(5, (2 * half) / scale / W));
      editLive((p) => { const t = p.texts.find((x) => x.id === item.id); if (t) { t.boxW = boxW; delete t.oneLine; } });
    });
  };

  /**
   * Shapes: stretch from an edge (n / s / e / w) — the opposite edge stays put. Squares and circles become
   * rectangles and ellipses when pulled out of shape.
   */
  const startStretch = (e, item, side) => {
    const b = bounds("text", item);
    const r = ref.current.getBoundingClientRect();
    const k = W / r.width; // frame px per screen px
    const scale = getXY("text", item).scale || 1;
    const rad = (b.rotation * Math.PI) / 180;
    const ux = Math.cos(rad), uy = Math.sin(rad); // the shape's own width axis on screen
    const vx = -Math.sin(rad), vy = Math.cos(rad); // its height axis
    const horiz = side === "e" || side === "w", sign = side === "e" || side === "s" ? 1 : -1;
    const s0 = item.shape, eq = s0.type === "square" || s0.type === "circle";
    const w0 = s0.w, h0 = eq ? s0.w : s0.h; // px on a 1920-wide frame
    const toScreen = (v) => (v * (W / 1920) * scale) / k;
    const half = toScreen(horiz ? w0 : h0) / 2;
    const cx = r.left + b.cx * r.width, cy = r.top + b.cy * r.height;
    // The edge that stays put.
    const ox = cx - sign * (horiz ? ux : vx) * half, oy = cy - sign * (horiz ? uy : vy) * half;
    dragGesture(e, (ev) => {
      const d = Math.max(4, sign * ((ev.clientX - ox) * (horiz ? ux : vx) + (ev.clientY - oy) * (horiz ? uy : vy)));
      const size = (d * k) / scale / (W / 1920);
      const ncx = ox + sign * (horiz ? ux : vx) * (d / 2), ncy = oy + sign * (horiz ? uy : vy) * (d / 2);
      editLive((p) => {
        const t = p.texts.find((x) => x.id === item.id);
        if (!t) return;
        t.shape = { ...t.shape, ...(eq ? { type: s0.type === "square" ? "rect" : "ellipse", w: w0, h: h0 } : {}) };
        if (horiz) t.shape.w = size; else t.shape.h = size;
        setProps(p, "text", item.id, { x: (ncx - r.left) / r.width, y: (ncy - r.top) / r.height }, time);
      });
    });
  };

  const startRotate = (e, kind, item) => {
    const b = bounds(kind, item);
    const r = ref.current.getBoundingClientRect();
    const cx = r.left + b.cx * r.width, cy = r.top + b.cy * r.height;
    const a0 = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
    const r0 = getXY(kind, item).rotation;
    dragGesture(e, (ev) => {
      let rot = r0 + (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI - a0;
      rot = ((rot % 360) + 540) % 360 - 180;
      if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
      else for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(rot - snap) < 4) rot = snap;
      editLive((p) => setProps(p, kind, item.id, { rotation: rot }, time));
    });
  };

  return html`<div class="overlay" ref=${ref} onPointerDown=${onPointerDown}
      style=${{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
    ${guides?.v && html`<div class="guide v" />`}
    ${guides?.h && html`<div class="guide h" />`}
    ${axis && html`<div class="axis"><i class="v" style=${{ left: "33.33%" }} /><i class="v" style=${{ left: "66.66%" }} />
      <i class="h" style=${{ top: "33.33%" }} /><i class="h" style=${{ top: "66.66%" }} />
      <i class="v c" style=${{ left: "50%" }} /><i class="h c" style=${{ top: "50%" }} /><b /></div>`}
    ${selectedVisible.map(({ kind, item }) => {
      if (cropping?.id === item.id) return null;
      if (maskEditing === item.id && item.mask?.shape) return html`<${MaskHandles} key=${item.id} kind=${kind} item=${item} rect=${rect} overlay=${ref} />`;
      const b = bounds(kind, item);
      if (!b) return null;
      const single = selectedVisible.length === 1;
      return html`<div key=${item.id} class=${"tbox " + kind}
          style=${{
            left: (b.cx - b.w / 2) * rect.width, top: (b.cy - b.h / 2) * rect.height,
            width: b.w * rect.width, height: b.h * rect.height, transform: `rotate(${b.rotation}deg)`,
          }}>
        ${single && ["nw", "ne", "sw", "se"].map((c) => html`<div key=${c} class=${"knob " + c}
          onPointerDown=${(e) => startScale(e, kind, item)} />`)}
        ${single && item.shape && ["n", "s", "e", "w"].map((c) => html`<div key=${c} class=${"knob " + c} title=${`Drag to stretch the ${c === "n" || c === "s" ? "height" : "width"}`}
          onPointerDown=${(e) => startStretch(e, item, c)} />`)}
        ${single && kind === "text" && !item.shape && ["w", "e"].map((c) => html`<div key=${c} class=${"knob " + c} title="Drag to make the text box wider or narrower (wider = fewer lines)"
          onPointerDown=${(e) => startBoxWidth(e, item)} />`)}
        ${single && html`<div class="rot" title="Rotate (Shift snaps to 15°)" onPointerDown=${(e) => startRotate(e, kind, item)} />`}
      </div>`;
    })}
    <${CropBox} rect=${rect} overlay=${ref} />
  </div>`;
}

// ---------------- dialogs ----------------

function Modal({ title, onClose, children }) {
  return html`<div class="modal-bg" onPointerDown=${onClose}>
    <div class="modal" onPointerDown=${(e) => e.stopPropagation()}>
      <div class="row between"><h3>${title}</h3><button onClick=${onClose}>✕</button></div>
      ${children}
    </div>
  </div>`;
}

const SHORTCUTS = [
  ["Space", "Play / pause"],
  ["Ctrl+Z", "Undo"],
  ["Ctrl+Y / Ctrl+Shift+Z", "Redo"],
  ["Ctrl+C / Ctrl+X / Ctrl+V", "Copy / cut / paste at playhead"],
  ["Ctrl+D", "Duplicate selection"],
  ["Ctrl+Alt+C / Ctrl+Alt+V", "Copy settings / paste them onto the selected items"],
  ["Ctrl+A", "Select all"],
  ["S", "Split the selection (or the main clip) at the playhead"],
  ["S / Ctrl+B", "Split the selected items at the playhead (nothing selected: the main clip)"],
  ["Ctrl+Shift+B", "Split everything under the playhead"],
  ["B", "Razor tool: click a clip to cut it there"],
  ["H / middle mouse drag", "Hand tool: drag to pan the timeline"],
  ["M", "Mute / unmute the selection"],
  ["G", "Show / hide the preview axis and safe-area guides"],
  ["Delete / Backspace", "Delete selection"],
  ["Shift+Delete", "Ripple delete (close the gap)"],
  ["F", "Freeze frame"],
  ["N", "Magnetic snapping on/off"],
  ["Ctrl+S / Ctrl+Shift+S", "Save / save as"],
  ["Ctrl+O", "Open project"],
  ["Ctrl+E", "Export"],
  ["Esc", "Clear selection"],
  ["← / →", "Step one frame (Shift: 1 second)"],
  ["Home / End", "Go to start / end"],
  ["Ctrl + mouse wheel", "Zoom the timeline around the pointer (trackpad pinch too)"],
  ["Shift + mouse wheel", "Scroll the timeline sideways"],
  ["+ / − · Ctrl+= / Ctrl+− · Ctrl+0", "Zoom timeline in / out · reset zoom"],
  ["Shift+Z", "Fit the whole project in the timeline"],
  ["Alt+G", "Make a compound clip from the selection (double-click it to edit inside)"],
  ["Ctrl+I", "Import media (to the library)"],
  ["Click a library item", "Preview it in the viewer (Space play · I / O mark in/out · Enter add · Esc back)"],
  ["Double-click / drag a library item", "Add it to the timeline / drop it where you want it"],
  ["Ctrl+W", "Close project (start a new one)"],
  ["Ctrl+Q", "Quit (desktop app)"],
  ["Q / W", "Delete the part of the clip before / after the playhead"],
  ["T", "Add text (uses your ★ default text preset, if you set one)"],
  ["Right-click ◇", "Remove all keyframes of that property"],
  ["Shift/Ctrl + click", "Add to selection"],
  ["Drag empty timeline", "Box-select"],
  ["Drag in preview", "Move · corners resize · top handle rotates"],
  ["◆ next to a slider", "Add / remove a keyframe at the playhead"],
  ["?", "Show this list"],
];

function ShortcutsDialog({ onClose }) {
  return html`<${Modal} title="Keyboard shortcuts" onClose=${onClose}>
    <table class="keys">
      ${SHORTCUTS.map(([k, d]) => html`<tr key=${k}><td><kbd>${k}</kbd></td><td>${d}</td></tr>`)}
    </table>
  <//>`;
}

/** Auto-captions form, shown in the Captions tab (and the Text › Auto captions sub-menu). */
function CaptionsForm() {
  return html`<div class="captions-form"><b class="lib-title">Auto captions</b><${CaptionsBody} inline /></div>`;
}

function CaptionsDialog({ onClose }) {
  return html`<${Modal} title="Auto captions" onClose=${onClose}><${CaptionsBody} onDone=${onClose} /><//>`;
}

function CaptionsBody({ onDone, inline }) {
  const [model, setModel] = useState(Object.keys(CAPTION_MODELS)[0]);
  const [language, setLanguage] = useState("english");
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const project = getState().project;
    if (!project.main.length && !project.audio.length && !project.overlays.length) { setStatus("Add a video with speech first."); return; }
    setBusy(true);
    try {
      const chunks = await transcribe(project, { model, language }, (p) => setStatus(
        p.stage === "audio" ? "Extracting audio…"
          : p.stage === "download" ? `Downloading model (first time only)… ${Math.round(p.progress || 0)}%`
          : "Transcribing… this can take a while for long videos",
      ));
      const caps = wordsToCaptions(chunks);
      if (!caps.length) { setStatus("No speech found."); setBusy(false); return; }
      edit((p) => { p.texts = p.texts.filter((t) => !t.caption).concat(caps); });
      setBusy(false);
      setStatus(`Added ${caps.length} captions.`);
      onDone?.();
    } catch (err) {
      setStatus("Failed: " + err.message);
      setBusy(false);
    }
  };
  return html`<div>
    <p class="muted">Speech recognition runs on your computer (Whisper). Nothing is uploaded; the model downloads once.</p>
    <${Field} label="Model">
      <select value=${model} onChange=${(e) => setModel(e.target.value)} disabled=${busy}>
        ${Object.entries(CAPTION_MODELS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}
      </select>
    <//>
    ${!model.endsWith(".en") && html`<${Field} label="Language">
      <select value=${language} onChange=${(e) => setLanguage(e.target.value)} disabled=${busy}>
        ${["english", "hindi", "spanish", "french", "german", "portuguese", "japanese", "korean", "chinese", "arabic", "russian", "italian"].map((l) => html`<option value=${l}>${l[0].toUpperCase() + l.slice(1)}</option>`)}
      </select>
    <//>`}
    ${status && html`<p class="status">${status}</p>`}
    <button class="primary wide" disabled=${busy} onClick=${run}>${busy ? "Working…" : "Generate captions"}</button>
    <p class="muted">Replaces any existing auto captions. Select a caption to style them all at once.</p>
  </div>`;
}

const RESOLUTIONS = [["720p", 720], ["1080p", 1080], ["1440p (2K)", 1440], ["2160p (4K)", 2160]];

/** Output size for a target "p" value, keeping the project's aspect ratio (even numbers for the encoder). */
function sizeFor(project, p) {
  const short = Math.min(project.width, project.height);
  const k = p / short;
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(project.width * k), height: even(project.height * k) };
}

function ExportDialog({ onClose }) {
  const p = getState().project;
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("idle");
  const [url, setUrl] = useState(null);
  const [saved, setSaved] = useState(null); // desktop: where the video was written
  const [error, setError] = useState(null);
  const def = appSettings();
  const [res, setRes] = useState(def.exportRes === "project" ? Math.min(p.width, p.height) : def.exportRes);
  const [fps, setFps] = useState(def.exportFps === "project" ? p.fps : def.exportFps);
  const [codec, setCodec] = useState(def.exportCodec || "avc");
  const [quality, setQuality] = useState(def.exportQuality || "high");
  const [encoder, setEncoder] = useState(def.encoder || "auto");
  const [customKbps, setCustomKbps] = useState(def.exportKbps || 40000);
  const [smooth, setSmooth] = useState(() => { try { return localStorage.getItem("cutline.smoothMotion") || "off"; } catch { return "off"; } });
  const [blur, setBlur] = useState(() => { try { return +(localStorage.getItem("cutline.motionBlur") ?? 0); } catch { return 0; } });
  const [support, setSupport] = useState(null);
  const abort = useRef(null);
  const size = sizeFor(p, res);
  useEffect(() => { setSupport(null); supportedCodecs(size.width, size.height, fps).then(setSupport); }, [res, fps]);
  // What you pick here is remembered: the next export opens with the same settings (also Settings › Export).
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const now = { exportRes: res, exportFps: fps, exportCodec: codec, exportQuality: quality, encoder, exportKbps: customKbps };
    const t = setTimeout(() => { for (const [k, v] of Object.entries(now)) if (appSettings()[k] !== v) setSetting(k, v); }, 400);
    return () => clearTimeout(t);
  }, [res, fps, codec, quality, encoder, customKbps]);
  const run = async () => {
    pause();
    setPhase("running");
    setError(null);
    abort.current = new AbortController();
    const started = performance.now();
    try {
      await loadProjectFonts(getState().project);
      const o = { ...size, fps, codec, quality, customKbps, encoder, software: encoder === "software", smooth: { method: smooth, blur } };
      if (desktop?.exportBegin) {
        // Desktop: choose where to save first, then the video is written straight into that file.
        const file = await desktop.exportBegin(projectName() + ".mp4");
        if (!file) { setPhase("idle"); return; }
        o.sink = { write: (d, p) => desktop.exportWrite(file.id, d, p), close: () => desktop.exportEnd(file.id) };
        try { await exportMp4(rootProject(), setProgress, abort.current.signal, o); }
        catch (err) { await desktop.exportEnd(file.id, true); throw err; }
        setSaved(file.path);
        // A fresh address each time: an earlier export saved over the same file must never be shown instead.
        setUrl(desktop.fileUrl(file.path) + "&v=" + Date.now());
        setPhase(`in ${((performance.now() - started) / 1000).toFixed(1)}s`);
        return;
      }
      const blob = await exportMp4(rootProject(), setProgress, abort.current.signal, o);
      sendExport(blob); // inside Flodit: the video goes back to it
      setUrl(URL.createObjectURL(blob));
      setPhase(`in ${((performance.now() - started) / 1000).toFixed(1)}s · ${(blob.size / 1e6).toFixed(1)} MB`);
    } catch (err) {
      setError(err.name === "AbortError" ? "Cancelled." : err.message);
      setPhase("idle");
    }
  };
  const busy = phase === "running";
  return html`<${Modal} title="Export video" onClose=${() => { abort.current?.abort(); onClose(); }}>
    <div class="grid2">
      <${Field} label="Resolution">
        <select value=${res} disabled=${busy} onChange=${(e) => setRes(+e.target.value)}>
          ${[...new Set([...RESOLUTIONS.map(([, v]) => v), Math.min(p.width, p.height)])].sort((a, b) => a - b).map((v) => {
            const s = sizeFor(p, v);
            const name = RESOLUTIONS.find(([, x]) => x === v)?.[0] || `${v}p`;
            return html`<option value=${v}>${name} · ${s.width}×${s.height}</option>`;
          })}
        </select>
      <//>
      <${Field} label="Frame rate">
        <select value=${fps} disabled=${busy} onChange=${(e) => setFps(+e.target.value)}>
          ${[24, 25, 30, 50, 60, 90, 120].map((f) => html`<option value=${f}>${f} fps${f > 60 ? " (smooth motion)" : ""}</option>`)}
        </select>
      <//>
      <${Field} label="Encoder">
        <select value=${encoder} disabled=${busy} title="Hardware = graphics card (fast). Software = processor (slower, always works). Default in Settings."
          onChange=${(e) => setEncoder(e.target.value)}>
          <option value="auto">Auto</option><option value="hardware">Hardware (GPU)</option><option value="software">Software (CPU)</option>
        </select>
      <//>
      <${Field} label="Smooth motion">
        <select value=${smooth} disabled=${busy} title="Makes in-between frames when the export has more frames than your clips (e.g. 60 fps recordings at 90 or 120 fps) and for slow motion"
          onChange=${(e) => { setSmooth(e.target.value); try { localStorage.setItem("cutline.smoothMotion", e.target.value); } catch {} }}>
          <option value="flow">Motion interpolation (best)</option>
          <option value="blend">Frame blending (fast)</option>
          <option value="off">Off (repeat frames)</option>
        </select>
      <//>
      <${Field} label="Motion blur">
        <select value=${blur} disabled=${busy || smooth === "off"} title="A little blur along the motion, like a real camera shutter"
          onChange=${(e) => { setBlur(+e.target.value); try { localStorage.setItem("cutline.motionBlur", e.target.value); } catch {} }}>
          <option value="0">None</option>
          <option value="0.25">Light (minimal)</option>
          <option value="0.5">Medium (film look)</option>
        </select>
      <//>
      <${Field} label="Format">
        <select value=${codec} disabled=${busy} onChange=${(e) => setCodec(e.target.value)}>
          ${Object.entries(VIDEO_CODECS).map(([k, c]) => html`<option value=${k} disabled=${support && !support[k]}>${c.label}${support && !support[k] ? " — not available" : ""}</option>`)}
        </select>
      <//>
      <${Field} label="Quality">
        <select value=${quality} disabled=${busy} onChange=${(e) => setQuality(e.target.value)}>
          ${Object.entries(QUALITY).map(([k, q]) => html`<option value=${k}>${q.label}</option>`)}
        </select>
      <//>
    </div>
    ${quality === "custom" && html`<${Field} label="Video bitrate (kbps)">
      <div class="row">
        <${NumInput} min=${500} max=${500000} step=${500} value=${customKbps} disabled=${busy} style=${{ flex: 1 }} onCommit=${setCustomKbps} />
        ${[8000, 20000, 40000, 80000].map((k) => html`<button key=${k} class=${customKbps === k ? "chip on" : "chip"} disabled=${busy}
          onClick=${() => setCustomKbps(k)}>${k / 1000}M</button>`)}
      </div>
    <//>`}
    <p class="muted">${size.width}×${size.height} · ${fps} fps · ${quality === "custom" ? "" : "~"}${(bitrateFor(size.width, size.height, fps, quality, customKbps) / 1e6).toFixed(1)} Mbps (${Math.round(bitrateFor(size.width, size.height, fps, quality, customKbps) / 1000).toLocaleString()} kbps) · MP4 · ${fmt(projectDuration(p))}</p>
    ${phase === "idle" && html`<button class="primary wide" onClick=${run}>Start export</button>`}
    ${busy && html`<div class="bar"><div style=${{ width: `${progress * 100}%` }} /></div>
      <p class="status">${Math.round(progress * 100)}%</p>
      <button class="wide" onClick=${() => abort.current.abort()}>Cancel</button>`}
    ${url && html`<p class="status">Finished ${phase}</p>
      <video src=${url} controls class="result" />
      ${saved
        ? html`<p class="muted ell" title=${saved}>Saved to ${saved}</p>
          <button class="primary wide" onClick=${() => desktop.showInFolder(saved)}><${Icon} n="folder-open" /> Show in folder</button>`
        : html`<a class="button primary wide" href=${url} download=${projectName() + ".mp4"}>Save MP4</a>`}`}
    ${error && html`<p class="error">${error}</p>`}
  <//>`;
}

function RelinkBar() {
  const missing = useStore((s) => s.relink);
  const input = useRef();
  if (!missing?.length) return null;
  return html`<div class="relink">
    <span>${missing.length} media file${missing.length > 1 ? "s" : ""} not found: ${missing.slice(0, 3).map((m) => m.name).join(", ")}${missing.length > 3 ? "…" : ""}</span>
    <button class="primary" onClick=${() => input.current.click()}>Locate files…</button>
    <button onClick=${() => setState({ relink: null })}>Dismiss</button>
    <input ref=${input} type="file" multiple hidden onChange=${(e) => {
      const n = relink([...e.target.files]);
      e.target.value = "";
      toast(n ? `Relinked ${n} file${n > 1 ? "s" : ""}` : "None of those files match the missing names");
    }} />
  </div>`;
}

function RecoveryBar() {
  const [text, setText] = useState(null);
  useEffect(() => {
    // A project opened from Explorer wins over offering to restore the last session.
    (async () => {
      const f = await desktop?.pendingOpen?.();
      if (f) return openFromDisk(f);
      // Unsaved work from a crash comes back by itself.
      const t = await checkRecovery();
      if (t) {
        try { await restoreRecovery(t); toast("Restored your unsaved work from last time"); }
        catch { desktop?.clearAutosave(); }
        return;
      }
      await openLastProject(); // Settings › When Cutline opens
    })();
    desktop?.onOpenFile?.((f) => openFromDisk(f));
    desktop?.onSavedFile?.((p) => toast(`Saved to ${p}`, 5000));
  }, []);
  if (!text) return null;
  const dismiss = () => { desktop?.clearAutosave(); setText(null); };
  return html`<div class="relink">
    <span>Cutline closed with unsaved changes last time.</span>
    <button class="primary" onClick=${async () => { await loadProject(text); setText(null); toast("Recovered your last session"); }}>Restore</button>
    <button onClick=${dismiss}>Discard</button>
  </div>`;
}

function Toast() {
  const msg = useStore((s) => s.toast);
  return msg ? html`<div class="toast">${msg}</div>` : null;
}

// ---------------- app + keyboard ----------------

function useShortcuts(openShortcuts, openExport) {
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      // Save/open work even while typing.
      if (mod && key === "s") { e.preventDefault(); saveProject({ saveAs: e.shiftKey }); return; }
      if (mod && key === "o") { e.preventDefault(); if (desktop) openProject(); else document.querySelector(".menu input[type=file]")?.click(); return; }
      // Typing in a box keeps its keys. A slider, checkbox or colour well that still has focus (you just
      // changed a volume, say) doesn't block the editor's shortcuts — Ctrl+C / V / D used to do nothing then.
      const t = e.target;
      const typing = t.closest?.("textarea, select, [contenteditable='true']")
        || (t.tagName === "INPUT" && !/^(range|checkbox|radio|color|button)$/.test(t.type));
      if (typing) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (t.tagName === "INPUT" && !mod && /^(arrow|home$|end$|page)/.test(key)) return; // the slider's own keys
      const fps = getState().project.fps;
      const run = (fn) => { e.preventDefault(); fn(); };
      // While a library item is previewing, playback keys drive the preview.
      if (getState().preview && !mod) {
        // (Space is handled by onSpace below.)
        if (key === "arrowleft") return run(() => stepSource(e.shiftKey ? -1 : -1 / fps));
        if (key === "arrowright") return run(() => stepSource(e.shiftKey ? 1 : 1 / fps));
        if (key === "i") return run(() => markSource("in"));
        if (key === "o") return run(() => markSource("out"));
        if (key === "enter") return run(() => addFromSource());
        if (key === "escape") return run(closePreview);
      }
      if (mod) {
        if (key === ",") return run(() => setState({ settingsOpen: true }));
        if (key === "z") return run(e.shiftKey ? redo : undo);
        if (key === "y") return run(redo);
        if (key === "c" && e.altKey) return run(copySettings);
        if (key === "v" && e.altKey) return run(pasteSettings);
        if (key === "c") return run(copySelection);
        if (key === "x") return run(cutSelection);
        if (key === "v") return run(paste);
        if (key === "d") return run(duplicateSelection);
        if (key === "a") return run(selectAll);
        if (key === "b") return run(e.shiftKey ? splitAllAtPlayhead : splitAtPlayhead); // like CapCut: Ctrl+B cuts the selection
        if (key === "e") return run(openExport);
        if (key === "i" && !e.shiftKey) return run(() => document.getElementById("import-any")?.click());
        if (key === "w") return run(newProject);
        if (key === "q") return run(() => (desktop ? window.close() : toast("Close the browser tab to quit")));
        if (key === "=" || key === "+") return run(() => zoomTimeline(1.25));
        if (key === "-" || key === "_") return run(() => zoomTimeline(1 / 1.25));
        if (key === "0") return run(() => setState({ zoom: 80 }));
        return;
      }
      if (e.altKey && key === "g") return run(createCompound);
      if (e.altKey) return;
      if (e.code === "Space") return;
      if (key === "s") return run(splitAtPlayhead);
      if (key === "b") return run(() => { const on = getState().tool !== "razor"; setState({ tool: on ? "razor" : null }); toast(on ? "Razor: click a clip to cut it (B to exit)" : "Razor off"); });
      if (key === "h") return run(() => { const on = getState().tool !== "hand"; setState({ tool: on ? "hand" : null }); toast(on ? "Hand: drag the timeline to pan (H to exit)" : "Hand off"); });
      if (key === "m") return run(toggleMute);
      if (key === "t") return run(addDefaultText);
      if (key === "g") return run(() => setState({ axis: !getState().axis }));
      if (key === "f") return run(() => freezeFrame());
      if (key === "q") return run(() => trimToPlayhead("left"));
      if (key === "w") return run(() => trimToPlayhead("right"));
      if (key === "v" || key === "a") return run(() => setState({ tool: null }));
      if (key === "n") return run(() => { setToggle("snap", !getState().snap); toast(getState().snap ? "Snapping on" : "Snapping off"); });
      if ((key === "delete" || key === "backspace") && e.shiftKey) return run(rippleDelete);
      if (key === "delete" || key === "backspace") return run(deleteSelection);
      if (key === "escape") return run(() => { if (getState().tool) setState({ tool: null }); else select([]); });
      if (key === "arrowleft") return run(() => seek(getState().time - (e.shiftKey ? 1 : 1 / fps)));
      if (key === "arrowright") return run(() => seek(getState().time + (e.shiftKey ? 1 : 1 / fps)));
      if (key === "home") return run(() => seek(0));
      if (key === "end") return run(() => seek(projectDuration(getState().project)));
      if (key === "+" || key === "=") return run(() => zoomTimeline(1.25));
      if (key === "-" || key === "_") return run(() => zoomTimeline(1 / 1.25));
      if (key === "z" && e.shiftKey) return run(zoomToFit);
      if (key === "?") return run(openShortcuts);
    };
    window.addEventListener("keydown", onKey);
    // Clicking the timeline, player or anywhere outside a box takes the focus out of the box, so the
    // keyboard shortcuts work on what you just clicked.
    const onDown = (e) => {
      const a = document.activeElement;
      if (a && a !== document.body && a.matches?.("input, textarea, select") && !e.target.closest?.("input, textarea, select, label")) a.blur();
    };
    window.addEventListener("pointerdown", onDown, true);
    // Space only ever plays / pauses (or the library preview), except while typing. It must not press a
    // focused button, tick a checkbox or open a dropdown, so it's caught first and its default is stopped.
    const typing = (el) => !!el?.closest?.("textarea, [contenteditable]:not([contenteditable=false])")
      || (el?.tagName === "INPUT" && !/^(range|checkbox|radio|color|button|submit|reset|file)$/i.test(el.type));
    const onSpace = (e) => {
      if (e.code !== "Space" || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "keydown" && !e.repeat) (getState().preview ? toggleSource : togglePlay)();
    };
    window.addEventListener("keydown", onSpace, true);
    window.addEventListener("keyup", onSpace, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onSpace, true);
      window.removeEventListener("keyup", onSpace, true);
    };
  }, []);
}

function App() {
  const [dialog, setDialog] = useState(null);
  const timelineH = useStore((s) => s.timelineH);
  const home = useStore((s) => s.home);
  useShortcuts(() => setDialog("shortcuts"), () => setDialog("export"));
  useEffect(() => {
    linkWebFonts();
    loadRecentFonts();
    loadTextPresets();
    startAutosave();
    announceReady(); // inside Flodit: ready for the clips
    if (desktop) loadSystemFonts(); // the desktop app can list installed fonts without asking
    // Ctrl + wheel belongs to the timeline; never zoom the whole page.
    const noPageZoom = (e) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); };
    window.addEventListener("wheel", noPageZoom, { passive: false });
    return () => window.removeEventListener("wheel", noPageZoom);
  }, []);
  const cols = useColumns();
  return html`<div class="app" style=${{ gridTemplateRows: home ? "38px auto minmax(0, 1fr)" : `38px auto minmax(0, 1fr) ${timelineH}px` }}>
    <${Header} onExport=${() => setDialog("export")} onShortcuts=${() => setDialog("shortcuts")} />
    <div><${RecoveryBar} />${!home && html`<${RelinkBar} />`}</div>
    ${home ? html`<${Home} />` : html`
    <main style=${{ gridTemplateColumns: `${cols.left}px 6px minmax(0, 1fr) 6px ${cols.right}px`, gap: 0 }}>
      <${LeftPanel} />
      <${ColResize} side="left" />
      <${Player} />
      <${ColResize} side="right" />
      <${Inspector} />
    </main>
    <${Timeline} />`}
    <${UpdateBar} />
    <${Toast} />
    <input id="import-any" type="file" multiple accept="video/*,image/*,audio/*" hidden
      onChange=${(e) => { importFiles([...e.target.files]); e.target.value = ""; }} />
    ${dialog === "captions" && html`<${CaptionsDialog} onClose=${() => setDialog(null)} />`}
    ${dialog === "export" && html`<${ExportDialog} onClose=${() => setDialog(null)} />`}
    ${dialog === "shortcuts" && html`<${ShortcutsDialog} onClose=${() => setDialog(null)} />`}
    ${useStore((s) => s.settingsOpen) && html`<${SettingsDialog} onClose=${() => setState({ settingsOpen: false })} />`}
  </div>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
