import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  useStore, getState, setState, edit, editLive, undo, redo, projectDuration, isSelected, select, findItem,
} from "./store.js";
import {
  drawFrame, syncMedia, renderLock, activeClips, activeOverlays, itemBounds, hitTest, transformAt, TRANSITIONS,
} from "./engine.js";
import {
  clock, play, pause, togglePlay, seek, toast, importFiles, addMediaToTimeline, splitAtPlayhead, deleteSelection,
  rippleDelete, selectAll, copySelection, cutSelection, paste, duplicateSelection, applyTransition, freezeFrame,
  localTime,
} from "./actions.js";
import { hasKeys, setKey, setStatic } from "./keyframes.js";
import { exportMp4, exportWav, exportFrame, supportedCodecs, VIDEO_CODECS, QUALITY, bitrateFor } from "./export.js";
import { transcribe, wordsToCaptions, CAPTION_MODELS } from "./captions.js";
import { html, fmt, Field } from "./ui/kit.js";
import { Inspector } from "./ui/inspector.js";
import { Timeline, dragGesture } from "./ui/timeline.js";
import { EffectsTab, FiltersTab, AudioTab, TextTab } from "./ui/library.js";
import { linkWebFonts, loadProjectFonts } from "./ui/fonts.js";
import {
  saveProject, openProject, newProject, relink, startAutosave, checkRecovery, loadProject, desktop, projectName,
} from "./project-io.js";

const additiveKey = (e) => e.shiftKey || e.ctrlKey || e.metaKey;
setState({ snap: true, timelineH: 300 });

// ---------------- render loop ----------------

function startRenderLoop(canvas) {
  const ctx = canvas.getContext("2d");
  let raf;
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (renderLock.exporting) return;
    const s = getState();
    let t = s.time;
    if (s.playing) {
      t = clock.startT + (performance.now() - clock.startNow) / 1000;
      const dur = projectDuration(s.project);
      if (t >= dur) { t = dur; pause(); }
      setState({ time: t });
    }
    syncMedia(s.project, t, s.playing);
    drawFrame(ctx, s.project, t);
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

// ---------------- header ----------------

function FileMenu() {
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
    try { toast("Mixing audio…"); download(await exportWav(getState().project), projectName() + ".wav"); }
    catch (err) { toast(err.message); }
  };
  const snapshot = async () => {
    try { download(await exportFrame(getState().project, getState().time), `${projectName()} ${getState().time.toFixed(2)}s.png`); }
    catch (err) { toast(err.message); }
  };
  return html`<div class="menu">
    <button onClick=${() => setOpen(!open)}>☰ File</button>
    <input ref=${input} type="file" accept=".cutline,application/json" hidden onChange=${(e) => { const f = e.target.files[0]; e.target.value = ""; if (f) openProject(f); }} />
    ${open && html`<div class="menu-list">
      <button onClick=${run(newProject)}>New project</button>
      <button onClick=${run(() => (desktop ? openProject() : input.current.click()))}>Open… <kbd>Ctrl+O</kbd></button>
      <button onClick=${run(() => saveProject())}>Save <kbd>Ctrl+S</kbd></button>
      <button onClick=${run(() => saveProject({ saveAs: true }))}>Save as…</button>
      <hr />
      <button onClick=${run(snapshot)}>Export this frame (PNG)</button>
      <button onClick=${run(exportAudio)}>Export audio (WAV)</button>
    </div>`}
  </div>`;
}

function Header({ onCaptions, onExport, onShortcuts }) {
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  return html`<header>
    <div class="row"><div class="brand">✂︎ Cutline</div><${FileMenu} /></div>
    <div class="row">
      <button onClick=${undo} disabled=${!canUndo} title="Undo (Ctrl+Z)">↶ Undo</button>
      <button onClick=${redo} disabled=${!canRedo} title="Redo (Ctrl+Y)">↷ Redo</button>
      <button onClick=${onShortcuts} title="Keyboard shortcuts (?)">⌨ Shortcuts</button>
    </div>
    <div class="row">
      <button onClick=${onCaptions}>Auto captions</button>
      <button class="primary" onClick=${onExport}>Export</button>
    </div>
  </header>`;
}

// ---------------- left panel ----------------

function LeftPanel() {
  const [tab, setTab] = useState("media");
  return html`<aside class="panel left">
    <div class="tabs">
      ${[["media", "Media"], ["text", "Text"], ["transitions", "Transitions"], ["effects", "Effects"], ["filters", "Filters"], ["audio", "Audio"]].map(([k, l]) => html`<button key=${k}
        class=${tab === k ? "tab on" : "tab"} onClick=${() => setTab(k)}>${l}</button>`)}
    </div>
    ${tab === "media" && html`<${MediaTab} />`}
    ${tab === "text" && html`<${TextTab} />`}
    ${tab === "transitions" && html`<${TransitionsTab} />`}
    ${tab === "effects" && html`<${EffectsTab} />`}
    ${tab === "filters" && html`<${FiltersTab} />`}
    ${tab === "audio" && html`<${AudioTab} />`}
  </aside>`;
}

function MediaTab() {
  const media = useStore((s) => s.project.media);
  const input = useRef();
  const [drag, setDrag] = useState(false);
  return html`<div
      onDragOver=${(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave=${() => setDrag(false)}
      onDrop=${(e) => { e.preventDefault(); setDrag(false); importFiles([...e.dataTransfer.files]); }}>
    <button class="primary wide" onClick=${() => input.current.click()}>+ Import</button>
    <input ref=${input} type="file" multiple accept="video/*,image/*,audio/*" hidden
      onChange=${(e) => { importFiles([...e.target.files]); e.target.value = ""; }} />
    <div class=${"drop" + (drag ? " on" : "")}>or drop files here</div>
    <div class="media-list">
      ${Object.values(media).map((m) => html`<div class=${"media-item" + (m.missing ? " missing" : "")} key=${m.id}
          title=${m.missing ? "File not found — use File › Open again or relink" : m.kind === "audio" ? "Click to add to an audio track" : "Click to add to the main track"}
          onClick=${() => !m.missing && addMediaToTimeline(m)}>
        ${m.kind === "image" ? html`<img src=${m.url} />`
          : m.kind === "audio" ? html`<div class="audio-thumb">♪</div>`
          : html`<video src=${m.url ? m.url + "#t=0.5" : ""} muted preload="metadata" />`}
        <span>${m.name}</span>
        <small>${m.missing ? "missing" : fmt(m.duration)}
          ${!m.missing && m.kind !== "audio" && html`<button class="mini add" title="Add as a picture-in-picture layer at the playhead"
            onClick=${(e) => { e.stopPropagation(); addMediaToTimeline(m, "overlay"); }}>+ Layer</button>`}
        </small>
      </div>`)}
    </div>
  </div>`;
}

function TransitionsTab() {
  const [dur, setDur] = useState(0.6);
  return html`<div>
    <p class="muted">Select a ◆ cut or a clip, then pick a transition. With nothing selected it goes on the cut nearest the playhead.</p>
    <div class="grid2">
      ${Object.entries(TRANSITIONS).map(([k, label]) => html`<button key=${k} class="tr-tile" onClick=${() => applyTransition(k, dur)}>
        <span class=${"tr-icon tr-" + k}></span>${label}
      </button>`)}
    </div>
    <label class="field"><span>Default duration ${dur.toFixed(2)}s</span>
      <input type="range" min="0.2" max="2" step="0.05" value=${dur} onChange=${(e) => setDur(+e.target.value)} />
    </label>
    <button class="wide" onClick=${() => applyTransition("crossfade", dur, true)}>Cross fade every cut</button>
  </div>`;
}

// ---------------- player + on-screen transform controls ----------------

function Player() {
  const canvas = useRef();
  const stage = useRef();
  const { width, height } = useStore((s) => s.project);
  const time = useStore((s) => s.time);
  const playing = useStore((s) => s.playing);
  const duration = useStore((s) => projectDuration(s.project));
  const previewW = width >= height ? 960 : Math.round(960 * (width / height));
  const previewH = Math.round(previewW * (height / width));
  const [rect, setRect] = useState(null);

  useEffect(() => startRenderLoop(canvas.current), []);
  useLayoutEffect(() => {
    const update = () => {
      const c = canvas.current;
      setRect({ left: c.offsetLeft, top: c.offsetTop, width: c.offsetWidth, height: c.offsetHeight });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas.current);
    ro.observe(stage.current);
    return () => ro.disconnect();
  }, [previewW, previewH]);

  return html`<section class="player">
    <div class="stage" ref=${stage}>
      <canvas ref=${canvas} width=${previewW} height=${previewH} />
      ${rect && html`<${TransformOverlay} rect=${rect} />`}
    </div>
    <div class="transport">
      <button onClick=${() => seek(0)} title="Go to start (Home)">⏮</button>
      <button class="play" onClick=${togglePlay} title="Play/pause (Space)">${playing ? "❚❚" : "▶"}</button>
      <button onClick=${() => seek(duration)} title="Go to end (End)">⏭</button>
      <span class="tc">${fmt(time)} / ${fmt(duration)}</span>
      <span class="hint">Click the video to select · drag to move · corners resize · top handle rotates</span>
    </div>
  </section>`;
}

/** Items visible at time t, topmost first: texts (later = on top), overlay layers (top track first), then the main clip(s). */
function visibleItems(project, t) {
  const texts = project.texts.filter((x) => t >= x.start && t < x.start + x.dur).reverse().map((x) => ({ kind: "text", item: x }));
  const layers = activeOverlays(project, t).reverse().map((o) => ({ kind: "overlay", item: o.item }));
  const clips = activeClips(project, t).clips.map((c) => ({ kind: "main", item: project.main.find((s) => s.id === c.seg.id) }));
  return [...texts, ...layers, ...clips].filter((v) => v.item && (v.kind === "text" || project.media[v.item.mediaId]?.kind !== "audio"));
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
  const time = useStore((s) => s.time);
  const selection = useStore((s) => s.selection);
  const guides = useStore((s) => s.guides);
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
    ${selectedVisible.map(({ kind, item }) => {
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
        ${single && html`<div class="rot" title="Rotate (Shift snaps to 15°)" onPointerDown=${(e) => startRotate(e, kind, item)} />`}
      </div>`;
    })}
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
  ["Ctrl+A", "Select all"],
  ["S / Ctrl+B", "Split at playhead"],
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
  ["+ / −", "Zoom timeline"],
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

function CaptionsDialog({ onClose }) {
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
      onClose();
    } catch (err) {
      setStatus("Failed: " + err.message);
      setBusy(false);
    }
  };
  return html`<${Modal} title="Auto captions" onClose=${busy ? () => {} : onClose}>
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
    <p class="muted">Replaces any existing auto captions.</p>
  <//>`;
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
  const [error, setError] = useState(null);
  const [res, setRes] = useState(Math.min(p.width, p.height));
  const [fps, setFps] = useState(p.fps);
  const [codec, setCodec] = useState("avc");
  const [quality, setQuality] = useState("high");
  const [support, setSupport] = useState(null);
  const abort = useRef(null);
  const size = sizeFor(p, res);
  useEffect(() => { setSupport(null); supportedCodecs(size.width, size.height, fps).then(setSupport); }, [res, fps]);
  const run = async () => {
    pause();
    setPhase("running");
    setError(null);
    abort.current = new AbortController();
    const started = performance.now();
    try {
      await loadProjectFonts(getState().project);
      const blob = await exportMp4(getState().project, setProgress, abort.current.signal, { ...size, fps, codec, quality });
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
          ${[24, 25, 30, 50, 60].map((f) => html`<option value=${f}>${f} fps</option>`)}
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
    <p class="muted">${size.width}×${size.height} · ${fps} fps · ~${(bitrateFor(size.width, size.height, fps, quality) / 1e6).toFixed(1)} Mbps · MP4 · ${fmt(projectDuration(p))}</p>
    ${phase === "idle" && html`<button class="primary wide" onClick=${run}>Start export</button>`}
    ${busy && html`<div class="bar"><div style=${{ width: `${progress * 100}%` }} /></div>
      <p class="status">${Math.round(progress * 100)}%</p>
      <button class="wide" onClick=${() => abort.current.abort()}>Cancel</button>`}
    ${url && html`<p class="status">Finished ${phase}</p>
      <video src=${url} controls class="result" />
      <a class="button primary wide" href=${url} download=${projectName() + ".mp4"}>Save MP4</a>`}
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
  useEffect(() => { checkRecovery().then((t) => t && setText(t)); }, []);
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
      if (e.target.closest?.("input, textarea, select")) {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      const fps = getState().project.fps;
      const run = (fn) => { e.preventDefault(); fn(); };
      if (mod) {
        if (key === "z") return run(e.shiftKey ? redo : undo);
        if (key === "y") return run(redo);
        if (key === "c") return run(copySelection);
        if (key === "x") return run(cutSelection);
        if (key === "v") return run(paste);
        if (key === "d") return run(duplicateSelection);
        if (key === "a") return run(selectAll);
        if (key === "b") return run(splitAtPlayhead);
        if (key === "e") return run(openExport);
        return;
      }
      if (e.code === "Space") return run(togglePlay);
      if (key === "s") return run(splitAtPlayhead);
      if (key === "f") return run(() => freezeFrame());
      if (key === "n") return run(() => { setState({ snap: !getState().snap }); toast(getState().snap ? "Snapping on" : "Snapping off"); });
      if ((key === "delete" || key === "backspace") && e.shiftKey) return run(rippleDelete);
      if (key === "delete" || key === "backspace") return run(deleteSelection);
      if (key === "escape") return run(() => select([]));
      if (key === "arrowleft") return run(() => seek(getState().time - (e.shiftKey ? 1 : 1 / fps)));
      if (key === "arrowright") return run(() => seek(getState().time + (e.shiftKey ? 1 : 1 / fps)));
      if (key === "home") return run(() => seek(0));
      if (key === "end") return run(() => seek(projectDuration(getState().project)));
      if (key === "+" || key === "=") return run(() => setState({ zoom: Math.min(300, getState().zoom * 1.25) }));
      if (key === "-" || key === "_") return run(() => setState({ zoom: Math.max(10, getState().zoom / 1.25) }));
      if (key === "?") return run(openShortcuts);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function App() {
  const [dialog, setDialog] = useState(null);
  const timelineH = useStore((s) => s.timelineH);
  useShortcuts(() => setDialog("shortcuts"), () => setDialog("export"));
  useEffect(() => { linkWebFonts(); startAutosave(); }, []);
  return html`<div class="app" style=${{ gridTemplateRows: `48px auto 1fr ${timelineH}px` }}>
    <${Header} onCaptions=${() => setDialog("captions")} onExport=${() => setDialog("export")} onShortcuts=${() => setDialog("shortcuts")} />
    <div><${RecoveryBar} /><${RelinkBar} /></div>
    <main>
      <${LeftPanel} />
      <${Player} />
      <${Inspector} />
    </main>
    <${Timeline} />
    <${Toast} />
    ${dialog === "captions" && html`<${CaptionsDialog} onClose=${() => setDialog(null)} />`}
    ${dialog === "export" && html`<${ExportDialog} onClose=${() => setDialog(null)} />`}
    ${dialog === "shortcuts" && html`<${ShortcutsDialog} onClose=${() => setDialog(null)} />`}
  </div>`;
}

createRoot(document.getElementById("root")).render(html`<${App} />`);
