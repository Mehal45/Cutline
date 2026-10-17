import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import htm from "htm";
import {
  useStore, getState, setState, edit, editLive, checkpoint, undo, redo,
  layoutMain, projectDuration, isSelected, select,
} from "./store.js";
import {
  drawFrame, syncMedia, renderLock, activeClips, itemBounds, hitTest, clipTransform, clipSpeed,
  ANIMATIONS, TRANSITIONS,
} from "./engine.js";
import {
  clock, play, pause, togglePlay, seek, toast, importFiles, addMediaToTimeline, addText,
  splitAtPlayhead, deleteSelection, selectAll, copySelection, cutSelection, paste,
  duplicateSelection, applyTransition, setClipSpeed, SPEED_PRESETS,
} from "./actions.js";
import { exportMp4 } from "./export.js";
import { transcribe, wordsToCaptions, CAPTION_MODELS } from "./captions.js";

const html = htm.bind(React.createElement);
const fmt = (s) => {
  const m = Math.floor(s / 60), sec = s - m * 60;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
};
const additiveKey = (e) => e.shiftKey || e.ctrlKey || e.metaKey;

/** Pointer drag helper: calls onMove(ev, dx, dy) after a small threshold; one undo step per drag. */
function dragGesture(e, onMove, { onClick, undoable = true } = {}) {
  e.stopPropagation();
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY;
  let started = false;
  const move = (ev) => {
    if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
    if (!started) { if (undoable) checkpoint(); started = true; }
    onMove(ev, ev.clientX - x0, ev.clientY - y0);
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!started) onClick?.(ev);
    setState({ guides: null });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

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

// ---------------- header ----------------

function Header({ onCaptions, onExport, onShortcuts }) {
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  return html`<header>
    <div class="brand">✂︎ Cutline</div>
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

const TEXT_PRESETS = [
  { label: "Title", style: { size: 120, weight: 900 } },
  { label: "Subtitle", style: { size: 56, weight: 600, strokeWidth: 0, bg: "#000000aa" } },
  { label: "Neon", style: { size: 96, weight: 800, color: "#39ff14", stroke: "#003300", strokeWidth: 4 } },
  { label: "Bold yellow", style: { size: 88, weight: 900, color: "#ffd400", stroke: "#000000", strokeWidth: 10 } },
  { label: "Typewriter", style: { size: 64, weight: 600, font: "'Courier New', monospace", strokeWidth: 0 }, anim: { in: { type: "typewriter", dur: 1.2 } } },
  { label: "Pop", style: { size: 100, weight: 900 }, anim: { in: { type: "pop", dur: 0.35 }, out: { type: "zoom", dur: 0.3 } } },
];

function LeftPanel() {
  const [tab, setTab] = useState("media");
  return html`<aside class="panel left">
    <div class="tabs">
      ${[["media", "Media"], ["text", "Text"], ["transitions", "Transitions"]].map(([k, l]) => html`<button key=${k}
        class=${tab === k ? "tab on" : "tab"} onClick=${() => setTab(k)}>${l}</button>`)}
    </div>
    ${tab === "media" && html`<${MediaTab} />`}
    ${tab === "text" && html`<${TextTab} />`}
    ${tab === "transitions" && html`<${TransitionsTab} />`}
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
      ${Object.values(media).map((m) => html`<div class="media-item" key=${m.id} title="Click to add to the timeline"
          onClick=${() => addMediaToTimeline(m)}>
        ${m.kind === "image" ? html`<img src=${m.url} />` : html`<video src=${m.url + "#t=0.5"} muted preload="metadata" />`}
        <span>${m.name}</span><small>${fmt(m.duration)}</small>
      </div>`)}
    </div>
  </div>`;
}

function TextTab() {
  return html`<div>
    <button class="primary wide" onClick=${() => addText()}>+ Add text</button>
    <p class="muted">Presets</p>
    <div class="grid2">
      ${TEXT_PRESETS.map((p) => html`<button key=${p.label} class="preset" onClick=${() => addText({ ...p, text: p.label })}
        style=${{ fontFamily: p.style.font, color: p.style.color, fontWeight: p.style.weight }}>${p.label}</button>`)}
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

/** Items visible at time t, topmost first: texts (later = on top), then the main clip(s). */
function visibleItems(project, t) {
  const texts = project.texts.filter((x) => t >= x.start && t < x.start + x.dur).reverse().map((x) => ({ kind: "text", item: x }));
  const clips = activeClips(project, t).clips.map((c) => ({ kind: "main", item: project.main.find((s) => s.id === c.seg.id) }));
  return [...texts, ...clips].filter((v) => v.item);
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

  const toFrac = (ev) => {
    const r = ref.current.getBoundingClientRect();
    return { x: (ev.clientX - r.left) / r.width, y: (ev.clientY - r.top) / r.height };
  };
  const findItem = (p, kind, id) => (kind === "main" ? p.main : p.texts).find((x) => x.id === id);
  const getXY = (kind, it) => (kind === "main" ? clipTransform(it) : { x: it.x, y: it.y, scale: it.scale || 1, rotation: it.rotation || 0 });
  const setProps = (p, kind, id, props) => {
    const it = findItem(p, kind, id);
    if (!it) return;
    if (kind === "main") it.transform = { ...clipTransform(it), ...props };
    else Object.assign(it, props);
  };

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    if (getState().playing) pause();
    const pt = toFrac(e);
    const hit = visible.find((v) => hitTest(itemBounds(project, v.kind, v.item, W, H), pt.x, pt.y, W, H));
    if (!hit) {
      if (!additiveKey(e)) select([]);
      return;
    }
    const target = { kind: hit.kind, id: hit.item.id };
    if (additiveKey(e)) select([target], true);
    else if (!isSelected(target.kind, target.id)) select([target]);
    // Move every selected item that is on screen.
    const movers = visibleItems(getState().project, time)
      .filter((v) => isSelected(v.kind, v.item.id) && v.kind !== "transition")
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
      editLive((p) => movers.forEach((m) => setProps(p, m.kind, m.id, { x: m.start.x + fx, y: m.start.y + fy })));
      setState({ guides: g });
    });
  };

  const startScale = (e, kind, item) => {
    const b = itemBounds(project, kind, item, W, H);
    const r = ref.current.getBoundingClientRect();
    const cx = r.left + b.cx * r.width, cy = r.top + b.cy * r.height;
    const d0 = Math.hypot(e.clientX - cx, e.clientY - cy);
    const s0 = getXY(kind, item).scale;
    dragGesture(e, (ev) => {
      const d = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      const scale = Math.max(0.05, Math.min(10, (s0 * d) / Math.max(1, d0)));
      editLive((p) => setProps(p, kind, item.id, { scale }));
    });
  };

  const startRotate = (e, kind, item) => {
    const b = itemBounds(project, kind, item, W, H);
    const r = ref.current.getBoundingClientRect();
    const cx = r.left + b.cx * r.width, cy = r.top + b.cy * r.height;
    const a0 = (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
    const r0 = getXY(kind, item).rotation;
    dragGesture(e, (ev) => {
      let rot = r0 + (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI - a0;
      rot = ((rot % 360) + 540) % 360 - 180;
      if (ev.shiftKey) rot = Math.round(rot / 15) * 15;
      else for (const snap of [-180, -90, 0, 90, 180]) if (Math.abs(rot - snap) < 4) rot = snap;
      editLive((p) => setProps(p, kind, item.id, { rotation: rot }));
    });
  };

  return html`<div class="overlay" ref=${ref} onPointerDown=${onPointerDown}
      style=${{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}>
    ${guides?.v && html`<div class="guide v" />`}
    ${guides?.h && html`<div class="guide h" />`}
    ${selectedVisible.map(({ kind, item }) => {
      const b = itemBounds(project, kind, item, W, H);
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

// ---------------- inspector ----------------

const Field = ({ label, children }) => html`<label class="field"><span>${label}</span>${children}</label>`;

function AnimFields({ anim, onChange, textOnly }) {
  const opts = Object.entries(ANIMATIONS).filter(([, v]) => textOnly || !v.textOnly);
  const part = (key, label) => html`<div class="anim-row">
    <${Field} label=${label}>
      <select value=${anim[key].type} onChange=${(e) => onChange(key, { type: e.target.value })}>
        ${opts.map(([k, v]) => html`<option value=${k}>${v.label}</option>`)}
      </select>
    <//>
    <${Field} label="Duration">
      <input type="range" min="0.1" max="2" step="0.05" value=${anim[key].dur}
        onChange=${(e) => onChange(key, { dur: +e.target.value })} />
    <//>
  </div>`;
  return html`<div>${part("in", "In animation")}${part("out", "Out animation")}</div>`;
}

function TransformFields({ tf, onChange, onReset }) {
  return html`<div>
    <div class="grid2">
      <${Field} label=${`X ${Math.round(tf.x * 100)}%`}><input type="range" min="-0.5" max="1.5" step="0.005" value=${tf.x} onChange=${(e) => onChange({ x: +e.target.value })} /><//>
      <${Field} label=${`Y ${Math.round(tf.y * 100)}%`}><input type="range" min="-0.5" max="1.5" step="0.005" value=${tf.y} onChange=${(e) => onChange({ y: +e.target.value })} /><//>
      <${Field} label=${`Scale ${Math.round(tf.scale * 100)}%`}><input type="range" min="0.05" max="4" step="0.01" value=${tf.scale} onChange=${(e) => onChange({ scale: +e.target.value })} /><//>
      <${Field} label=${`Rotation ${Math.round(tf.rotation)}°`}><input type="range" min="-180" max="180" step="1" value=${tf.rotation} onChange=${(e) => onChange({ rotation: +e.target.value })} /><//>
    </div>
    <button class="wide" onClick=${onReset}>Reset position & size</button>
  </div>`;
}

function SpeedFields({ speed, ids }) {
  const label = (v) => `${v}×`;
  return html`<div class="speed">
    <${Field} label=${`Speed ${speed.toFixed(2).replace(/\.?0+$/, "")}×`}>
      <div class="speed-chips">
        ${SPEED_PRESETS.map((v) => html`<button key=${v} class=${Math.abs(speed - v) < 1e-3 ? "chip on" : "chip"}
          onClick=${() => setClipSpeed(v, ids)}>${label(v)}</button>`)}
      </div>
      <input type="range" min="0.1" max="10" step="0.05" value=${speed}
        onChange=${(e) => setClipSpeed(+e.target.value, ids)} />
    <//>
  </div>`;
}

function Inspector() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);

  if (selection.length > 1) {
    const clipIds = selection.filter((s) => s.kind === "main").map((s) => s.id);
    const first = project.main.find((s) => s.id === clipIds[0]);
    return html`<aside class="panel inspector">
      <h3>${selection.length} items selected</h3>
      <p class="muted">Drag in the preview to move them together. Ctrl+C copy · Ctrl+D duplicate · Del delete.</p>
      ${first && html`<${SpeedFields} speed=${clipSpeed(first)} ids=${clipIds} />`}
      <button class="wide" onClick=${copySelection}>Copy</button>
      <button class="wide" onClick=${duplicateSelection}>Duplicate</button>
      <button class="danger wide" onClick=${deleteSelection}>Delete all</button>
    </aside>`;
  }
  const sel = selection[0];

  if (sel?.kind === "main") {
    const seg = project.main.find((s) => s.id === sel.id);
    if (!seg) return html`<aside class="panel inspector"><h3>Inspector</h3></aside>`;
    const media = project.media[seg.mediaId];
    const maxSrc = media?.kind === "image" ? 1e9 : media.duration;
    const speed = clipSpeed(seg);
    const set = (fn) => edit((p) => fn(p.main.find((s) => s.id === seg.id)));
    return html`<aside class="panel inspector">
      <h3>Clip</h3>
      <p class="muted">${media?.name}</p>
      <${SpeedFields} speed=${speed} ids=${[seg.id]} />
      <${TransformFields} tf=${clipTransform(seg)}
        onChange=${(v) => set((s) => (s.transform = { ...clipTransform(s), ...v }))}
        onReset=${() => set((s) => (s.transform = { x: 0.5, y: 0.5, scale: 1, rotation: 0 }))} />
      <${Field} label=${`Starts at ${seg.in.toFixed(2)}s of source`}>
        <input type="range" min="0" max=${Math.max(0, (media?.kind === "image" ? 60 : media.duration) - 0.1)} step="0.01" value=${seg.in}
          onChange=${(e) => set((s) => { s.in = +e.target.value; s.dur = Math.min(s.dur, (maxSrc - s.in) / speed); })} />
      <//>
      <${Field} label=${`Duration ${seg.dur.toFixed(2)}s on timeline`}>
        <input type="range" min="0.2" max=${media?.kind === "image" ? 30 : (media.duration - seg.in) / speed} step="0.01" value=${seg.dur}
          onChange=${(e) => set((s) => (s.dur = +e.target.value))} />
      <//>
      <${AnimFields} anim=${seg.anim} onChange=${(k, v) => set((s) => Object.assign(s.anim[k], v))} />
      <button class="danger wide" onClick=${deleteSelection}>Delete clip</button>
    </aside>`;
  }

  if (sel?.kind === "transition") {
    const seg = project.main.find((s) => s.id === sel.id);
    if (!seg?.transition) return html`<aside class="panel inspector"><h3>Transition</h3></aside>`;
    const set = (fn) => edit((p) => fn(p.main.find((s) => s.id === seg.id).transition));
    return html`<aside class="panel inspector">
      <h3>Transition</h3>
      <div class="grid2">
        ${Object.entries(TRANSITIONS).map(([k, label]) => html`<button key=${k}
          class=${seg.transition.type === k ? "chip on" : "chip"} onClick=${() => set((t) => (t.type = k))}>${label}</button>`)}
      </div>
      <${Field} label=${`Duration ${seg.transition.dur.toFixed(2)}s`}>
        <input type="range" min="0.2" max="2" step="0.05" value=${seg.transition.dur}
          onChange=${(e) => set((t) => (t.dur = +e.target.value))} />
      <//>
      <button class="danger wide" onClick=${deleteSelection}>Remove transition</button>
    </aside>`;
  }

  if (sel?.kind === "text") {
    const t = project.texts.find((x) => x.id === sel.id);
    if (!t) return html`<aside class="panel inspector"><h3>Inspector</h3></aside>`;
    const set = (fn) => edit((p) => fn(p.texts.find((x) => x.id === t.id)));
    const st = t.style;
    const applyAll = () => edit((p) => p.texts.forEach((x) => {
      if (x.caption) Object.assign(x, { style: structuredClone(st), x: t.x, y: t.y, scale: t.scale, rotation: t.rotation, anim: structuredClone(t.anim) });
    }));
    return html`<aside class="panel inspector">
      <h3>${t.caption ? "Caption" : "Text"}</h3>
      <textarea rows="3" value=${t.text} onChange=${(e) => set((x) => { x.text = e.target.value; delete x.words; })} />
      ${t.caption && t.words && html`<p class="muted">Editing the text removes word-by-word highlighting for this caption.</p>`}
      <div class="grid2">
        <${Field} label="Size"><input type="number" min="12" max="300" value=${st.size} onChange=${(e) => set((x) => (x.style.size = +e.target.value))} /><//>
        <${Field} label="Weight">
          <select value=${st.weight} onChange=${(e) => set((x) => (x.style.weight = +e.target.value))}>
            ${[400, 600, 800, 900].map((w) => html`<option value=${w}>${w}</option>`)}
          </select>
        <//>
        <${Field} label="Color"><input type="color" value=${st.color} onChange=${(e) => set((x) => (x.style.color = e.target.value))} /><//>
        <${Field} label="Highlight"><input type="color" value=${st.highlight} onChange=${(e) => set((x) => (x.style.highlight = e.target.value))} /><//>
        <${Field} label="Outline"><input type="color" value=${st.stroke} onChange=${(e) => set((x) => (x.style.stroke = e.target.value))} /><//>
        <${Field} label="Outline width"><input type="number" min="0" max="20" value=${st.strokeWidth} onChange=${(e) => set((x) => (x.style.strokeWidth = +e.target.value))} /><//>
      </div>
      <${Field} label="Background box">
        <div class="row">
          <input type="checkbox" checked=${!!st.bg} onChange=${(e) => set((x) => (x.style.bg = e.target.checked ? "#000000aa" : ""))} />
          ${st.bg && html`<input type="color" value=${st.bg.slice(0, 7)} onChange=${(e) => set((x) => (x.style.bg = e.target.value + "aa"))} />`}
        </div>
      <//>
      <${Field} label="Font">
        <select value=${st.font} onChange=${(e) => set((x) => (x.style.font = e.target.value))}>
          ${["Inter, Arial, sans-serif", "Georgia, serif", "Impact, sans-serif", "'Comic Sans MS', cursive", "'Courier New', monospace"].map((f) => html`<option value=${f}>${f.split(",")[0].replace(/'/g, "")}</option>`)}
        </select>
      <//>
      <${TransformFields} tf=${{ x: t.x, y: t.y, scale: t.scale || 1, rotation: t.rotation || 0 }}
        onChange=${(v) => set((x) => Object.assign(x, v))}
        onReset=${() => set((x) => Object.assign(x, { x: 0.5, y: t.caption ? 0.82 : 0.5, scale: 1, rotation: 0 }))} />
      <${AnimFields} textOnly anim=${t.anim} onChange=${(k, v) => set((x) => Object.assign(x.anim[k], v))} />
      ${t.caption && html`<button class="wide" onClick=${applyAll}>Apply this style to all captions</button>`}
      <button class="danger wide" onClick=${deleteSelection}>Delete</button>
    </aside>`;
  }

  const ratio = (w, h) => edit((p) => Object.assign(p, { width: w, height: h }));
  return html`<aside class="panel inspector">
    <h3>Project</h3>
    <${Field} label="Canvas">
      <div class="grid2">
        ${[["16:9", 1920, 1080], ["9:16", 1080, 1920], ["1:1", 1080, 1080], ["4:5", 1080, 1350]].map(([l, w, h]) => html`<button key=${l}
          class=${project.width === w && project.height === h ? "chip on" : "chip"} onClick=${() => ratio(w, h)}>${l}</button>`)}
      </div>
    <//>
    <${Field} label="Frame rate">
      <select value=${project.fps} onChange=${(e) => edit((p) => (p.fps = +e.target.value))}>
        ${[24, 25, 30, 60].map((f) => html`<option value=${f}>${f} fps</option>`)}
      </select>
    <//>
    <p class="muted">Click something in the preview or timeline to edit it. Drag across empty timeline space to select several items.</p>
  </aside>`;
}

// ---------------- timeline ----------------

function Timeline() {
  const project = useStore((s) => s.project);
  const time = useStore((s) => s.time);
  const zoom = useStore((s) => s.zoom);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  useStore((s) => s.selection); // re-render on selection change
  const scroller = useRef();
  const inner = useRef();
  const [marquee, setMarquee] = useState(null);
  const segs = layoutMain(project);
  const total = Math.max(projectDuration(project) + 5, 20);
  const LABEL = 70;

  const timeAt = (clientX) => {
    const r = scroller.current.getBoundingClientRect();
    return (clientX - r.left + scroller.current.scrollLeft - LABEL) / zoom;
  };

  const scrub = (e) => {
    if (getState().playing) pause();
    seek(timeAt(e.clientX));
    const move = (ev) => seek(timeAt(ev.clientX));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Rubber-band selection on empty track space; a plain click seeks instead.
  const onTracksPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest(".seg, .diamond")) return;
    const additive = additiveKey(e);
    const base = additive ? getState().selection : [];
    const ir = inner.current.getBoundingClientRect();
    const x0 = e.clientX - ir.left, y0 = e.clientY - ir.top;
    dragGesture(e, (ev) => {
      const r = inner.current.getBoundingClientRect();
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
      const box = { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
      setMarquee(box);
      const hits = [...inner.current.querySelectorAll("[data-kind]")].filter((el) => {
        const b = el.getBoundingClientRect();
        const bl = b.left - r.left, bt = b.top - r.top;
        return bl < box.left + box.width && bl + b.width > box.left && bt < box.top + box.height && bt + b.height > box.top;
      }).map((el) => ({ kind: el.dataset.kind, id: el.dataset.id }));
      const merged = [...base];
      for (const h of hits) if (!merged.some((m) => m.kind === h.kind && m.id === h.id)) merged.push(h);
      setState({ selection: merged });
    }, {
      undoable: false,
      onClick: (ev) => { if (!additive) select([]); if (getState().playing) pause(); seek(timeAt(ev.clientX)); },
    });
    const clear = () => { setMarquee(null); window.removeEventListener("pointerup", clear); };
    window.addEventListener("pointerup", clear);
  };

  const pick = (e, kind, id) => {
    if (additiveKey(e)) select([{ kind, id }], true);
    else if (!isSelected(kind, id)) select([{ kind, id }]);
  };

  const ticks = [];
  const step = zoom > 60 ? 1 : zoom > 20 ? 5 : 10;
  for (let s = 0; s <= total; s += step) ticks.push(s);

  return html`<section class="timeline">
    <div class="tl-toolbar">
      <button onClick=${undo} disabled=${!canUndo} title="Undo (Ctrl+Z)">↶</button>
      <button onClick=${redo} disabled=${!canRedo} title="Redo (Ctrl+Y)">↷</button>
      <span class="sep"></span>
      <button onClick=${splitAtPlayhead} title="Split (S or Ctrl+B)">✂ Split</button>
      <button onClick=${deleteSelection} title="Delete (Del)">🗑 Delete</button>
      <button onClick=${duplicateSelection} title="Duplicate (Ctrl+D)">⧉ Duplicate</button>
      <button onClick=${() => addText()}>T Add text</button>
      <span class="spacer"></span>
      <span class="muted">Zoom</span>
      <input type="range" min="10" max="300" value=${zoom} onChange=${(e) => setState({ zoom: +e.target.value })} />
    </div>
    <div class="tl-scroll" ref=${scroller}>
      <div class="tl-inner" ref=${inner} style=${{ width: LABEL + total * zoom }} onPointerDown=${onTracksPointerDown}>
        <div class="ruler" onPointerDown=${(e) => { e.stopPropagation(); scrub(e); }}>
          ${ticks.map((s) => html`<div class="tick" key=${s} style=${{ left: LABEL + s * zoom }}>${fmt(s).slice(0, 5)}</div>`)}
        </div>

        <div class="track text-track">
          <div class="track-label">Text</div>
          ${project.texts.map((t) => html`<div key=${t.id} data-kind="text" data-id=${t.id}
              class=${"seg text" + (t.caption ? " caption" : "") + (isSelected("text", t.id) ? " selected" : "")}
              style=${{ left: LABEL + t.start * zoom, width: Math.max(4, t.dur * zoom) }}
              onPointerDown=${(e) => {
                pick(e, "text", t.id);
                // Drag moves every selected text together.
                const movers = getState().project.texts.filter((x) => isSelected("text", x.id)).map((x) => structuredClone(x));
                dragGesture(e, (ev, dx) => editLive((p) => {
                  const dt = Math.max(-Math.min(...movers.map((m) => m.start)), dx / zoom);
                  for (const m of movers) {
                    const x = p.texts.find((y) => y.id === m.id);
                    x.start = m.start + dt;
                    if (m.words) x.words = m.words.map((w) => ({ ...w, t0: w.t0 + dt, t1: w.t1 + dt }));
                  }
                }));
              }}>
            <div class="handle l" onPointerDown=${(e) => dragGesture(e, (ev, dx) => editLive((p) => {
              const x = p.texts.find((y) => y.id === t.id);
              const ns = Math.max(0, Math.min(t.start + t.dur - 0.2, t.start + dx / zoom));
              x.dur = t.dur - (ns - t.start); x.start = ns; }))} />
            <span>${t.text}</span>
            <div class="handle r" onPointerDown=${(e) => dragGesture(e, (ev, dx) => editLive((p) => {
              p.texts.find((y) => y.id === t.id).dur = Math.max(0.2, t.dur + dx / zoom); }))} />
          </div>`)}
        </div>

        <div class="track main-track">
          <div class="track-label">Video</div>
          ${segs.map((s, i) => {
            const media = project.media[s.mediaId];
            const maxSrc = media?.kind === "image" ? 1e9 : (media?.duration ?? s.dur);
            const sp = clipSpeed(s);
            return html`<${React.Fragment} key=${s.id}>
              <div data-kind="main" data-id=${s.id}
                  class=${"seg clip" + (isSelected("main", s.id) ? " selected" : "")}
                  style=${{ left: LABEL + s.start * zoom, width: Math.max(4, s.dur * zoom) }}
                  onPointerDown=${(e) => { e.stopPropagation(); pick(e, "main", s.id); }}>
                <div class="handle l" onPointerDown=${(e) => dragGesture(e, (ev, dx) => editLive((p) => {
                  // Timeline seconds trimmed × speed = source seconds trimmed.
                  const x = p.main.find((y) => y.id === s.id);
                  const cut = Math.max(-s.in / sp, Math.min(s.dur - 0.2, dx / zoom));
                  x.in = s.in + cut * sp; x.dur = s.dur - cut; }))} />
                <span>${media?.name}</span>
                ${sp !== 1 && html`<b class="speed-badge">${+sp.toFixed(2)}×</b>`}
                <div class="handle r" onPointerDown=${(e) => dragGesture(e, (ev, dx) => editLive((p) => {
                  p.main.find((y) => y.id === s.id).dur = Math.max(0.2, Math.min((maxSrc - s.in) / sp, s.dur + dx / zoom)); }))} />
              </div>
              ${i < segs.length - 1 && html`<div data-kind=${s.transition ? "transition" : undefined} data-id=${s.id}
                  class=${"diamond" + (s.transition ? " has" : "") + (isSelected("transition", s.id) ? " selected" : "")}
                  style=${{ left: LABEL + (s.start + s.dur) * zoom }}
                  title=${s.transition ? TRANSITIONS[s.transition.type] : "Add transition"}
                  onPointerDown=${(e) => {
                    e.stopPropagation();
                    if (!s.transition) edit((p) => (p.main.find((y) => y.id === s.id).transition = { type: "crossfade", dur: 0.6 }));
                    pick(e, "transition", s.id);
                  }}>◆</div>`}
            <//>`;
          })}
          ${segs.length === 0 && html`<div class="empty">Import media and click it to add clips here</div>`}
        </div>

        ${marquee && html`<div class="marquee" style=${marquee} />`}
        <div class="playhead" style=${{ left: LABEL + time * zoom }} />
      </div>
    </div>
  </section>`;
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
  ["Esc", "Clear selection"],
  ["← / →", "Step one frame (Shift: 1 second)"],
  ["Home / End", "Go to start / end"],
  ["+ / −", "Zoom timeline"],
  ["Shift/Ctrl + click", "Add to selection"],
  ["Drag empty timeline", "Box-select"],
  ["Drag in preview", "Move · corners resize · top handle rotates"],
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
    if (!project.main.length) { setStatus("Add a video with speech first."); return; }
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
    <p class="muted">Speech recognition runs in your browser (Whisper). Nothing is uploaded; the model downloads once.</p>
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

function ExportDialog({ onClose }) {
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState("idle");
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);
  const abort = useRef(null);
  const run = async () => {
    pause();
    setPhase("running");
    setError(null);
    abort.current = new AbortController();
    const started = performance.now();
    try {
      const blob = await exportMp4(getState().project, setProgress, abort.current.signal);
      setUrl(URL.createObjectURL(blob));
      setPhase(`in ${((performance.now() - started) / 1000).toFixed(1)}s · ${(blob.size / 1e6).toFixed(1)} MB`);
    } catch (err) {
      setError(err.name === "AbortError" ? "Cancelled." : err.message);
      setPhase("idle");
    }
  };
  const p = getState().project;
  return html`<${Modal} title="Export video" onClose=${() => { abort.current?.abort(); onClose(); }}>
    <p class="muted">${p.width}×${p.height} · ${p.fps} fps · H.264 MP4 · ${fmt(projectDuration(p))}</p>
    ${phase === "idle" && html`<button class="primary wide" onClick=${run}>Start export</button>`}
    ${phase === "running" && html`<div class="bar"><div style=${{ width: `${progress * 100}%` }} /></div>
      <p class="status">${Math.round(progress * 100)}%</p>
      <button class="wide" onClick=${() => abort.current.abort()}>Cancel</button>`}
    ${url && html`<p class="status">Finished ${phase}</p>
      <video src=${url} controls class="result" />
      <a class="button primary wide" href=${url} download="cutline-export.mp4">Download MP4</a>`}
    ${error && html`<p class="error">${error}</p>`}
  <//>`;
}

function Toast() {
  const msg = useStore((s) => s.toast);
  return msg ? html`<div class="toast">${msg}</div>` : null;
}

// ---------------- app + keyboard ----------------

function useShortcuts(openShortcuts) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest?.("input, textarea, select")) {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
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
        return;
      }
      if (e.code === "Space") return run(togglePlay);
      if (key === "s") return run(splitAtPlayhead);
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
  useShortcuts(() => setDialog("shortcuts"));
  return html`<div class="app">
    <${Header} onCaptions=${() => setDialog("captions")} onExport=${() => setDialog("export")} onShortcuts=${() => setDialog("shortcuts")} />
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
