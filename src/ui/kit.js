// Small shared UI pieces: html tag, fields, sections, keyframable sliders and the curve editor.
import React, { useState } from "react";
import htm from "htm";
import { useStore, getState, checkpoint, edit, editLive, findItem, layoutMain } from "../store.js";
import { keyAt, keysOf, hasKeys, propAt, EASINGS, easeCurve } from "../keyframes.js";
import { setAnimatable, toggleKeyframe, clearKeyframes, seek, localTime } from "../actions.js";

export const html = htm.bind(React.createElement);

export const fmt = (s) => {
  const m = Math.floor(s / 60), sec = s - m * 60;
  return `${String(m).padStart(2, "0")}:${sec.toFixed(2).padStart(5, "0")}`;
};

export const Field = ({ label, children }) => html`<label class="field"><span>${label}</span>${children}</label>`;

/** A collapsible group in the inspector. */
export function Section({ title, children, open: initial = true, right }) {
  const [open, setOpen] = useState(initial);
  return html`<div class=${"section" + (open ? " open" : "")}>
    <div class="section-head" onClick=${() => setOpen(!open)}>
      <span>${title} <i class=${"ico caret icon-chevron-" + (open ? "up" : "down")} /></span>${right && html`<span onClick=${(e) => e.stopPropagation()}>${right}</span>`}
    </div>
    ${open && html`<div class="section-body">${children}</div>`}
  </div>`;
}

/** Item start on the timeline (main clips are laid out back to back). */
export function itemStart(project, kind, item) {
  return kind === "main" ? layoutMain(project).find((s) => s.id === item.id)?.start ?? 0 : item.start;
}

/** A Lucide icon from the bundled icon font, e.g. <${Icon} n="scissors" />. */
export const Icon = ({ n, size }) => html`<i class=${"ico icon-" + n} style=${size ? { fontSize: size + "px" } : undefined} aria-hidden="true" />`;

/** Volume gain shown in decibels: 1 = 0 dB, 0.5 = -6 dB, 2 = +6 dB, silence = -∞. */
export const db = (v) => (v < 0.001 ? "-∞ dB" : `${(20 * Math.log10(v)).toFixed(1)} dB`);
/** Seconds, e.g. "0.40s". */
export const secs = (v) => `${v.toFixed(2)}s`;

/** How a value is shown in the number box, worked out from the label formatter ("50%", "12°", "-6 dB", "0.4s", "2×"). */
export function numberMode(format) {
  const sample = String(format(0.5));
  if (sample.endsWith("dB")) return {
    show: (v) => (v < 0.001 ? -60 : Math.round(20 * Math.log10(v) * 10) / 10),
    read: (n) => (n <= -60 ? 0 : Math.pow(10, n / 20)), unit: "dB", step: 0.5,
  };
  if (sample.endsWith("s")) return { show: (v) => Math.round(v * 100) / 100, read: (n) => n, unit: "s", step: 0.05 };
  if (sample.endsWith("×")) return { show: (v) => Math.round(v * 100) / 100, read: (n) => n, unit: "×", step: 0.05 };
  if (sample.endsWith("%")) return { show: (v) => Math.round(v * 100), read: (n) => n / 100, unit: "%", step: 1 };
  if (sample.endsWith("°")) return { show: (v) => Math.round(v * 10) / 10, read: (n) => n, unit: "°", step: 1 };
  return { show: (v) => Math.round(v * 100) / 100, read: (n) => n, unit: "", step: 0.01 };
}

/**
 * Volume sliders move in decibels (−60 dB … +20 dB) so quiet and loud settings get the same room on the
 * slider; everything else is linear.
 */
const isDb = (format) => numberMode(format).unit === "dB";
function rangeProps(format, min, max, step, v) {
  if (!isDb(format)) return { min, max, step, value: v };
  return { min: -60, max: Math.round(20 * Math.log10(max) * 10) / 10, step: 0.5, value: v < 0.001 ? -60 : 20 * Math.log10(v) };
}
const fromRange = (format, x) => (isDb(format) ? (x <= -60 ? 0 : Math.pow(10, x / 20)) : x);

/**
 * A slider row for an animatable property, laid out label · slider · number · ‹ ◇ ›. The diamond adds or removes a
 * keyframe at the playhead; once a property has keyframes, changing the value edits the keyframe at the playhead.
 */
export function KSlider({ kind, id, path, label, min, max, step = 0.01, fallback = 0, format = (v) => v.toFixed(2) }) {
  const project = useStore((s) => s.project);
  const time = useStore((s) => s.time);
  const item = findItem(project, kind, id);
  if (!item) return null;
  const lt = localTime(project, kind, item, time);
  const v = propAt(item, path, lt, fallback);
  const animated = hasKeys(item, path);
  const here = animated && keyAt(item, path, lt);
  const start = itemStart(project, kind, item);
  const ks = keysOf(item, path);
  const prev = [...ks].reverse().find((k) => k.t < lt - 1e-3);
  const next = ks.find((k) => k.t > lt + 1e-3);
  return html`<div class="krow">
    <span class="klabel" title=${label}>${label}</span>
    <input class="kslider" type="range" ...${rangeProps(format, min, max, step, v)}
      onPointerDown=${() => checkpoint()} onKeyDown=${() => checkpoint()}
      onChange=${(e) => setAnimatable(kind, id, path, fromRange(format, +e.target.value), true)} />
    <${NumBox} value=${v} min=${min} max=${max} format=${format}
      onCommit=${(x) => { checkpoint(); setAnimatable(kind, id, path, x, true); }} />
    <span class="kkf">
      <button class="kn" title="Previous keyframe" disabled=${!prev} onClick=${() => prev && seek(start + prev.t)}>‹</button>
      <button class=${"kf" + (here ? " on" : animated ? " has" : "")} title=${here ? "Remove keyframe" : "Add keyframe at the playhead"}
        onClick=${() => toggleKeyframe(kind, id, path, fallback)}
        onContextMenu=${(e) => { if (animated) { e.preventDefault(); clearKeyframes(kind, id, path, fallback); } }}>◇</button>
      <button class="kn" title="Next keyframe" disabled=${!next} onClick=${() => next && seek(start + next.t)}>›</button>
    </span>
  </div>`;
}

/**
 * Number box for a slider value, in the slider's units (%, dB, s, ×, °). Type a value and press Enter or
 * click away; arrow keys step it. Values outside min..max are clamped.
 */
export function NumBox({ value, min, max, format, onCommit }) {
  const mode = numberMode(format);
  const lo = mode.unit === "dB" ? -60 : mode.show(min), hi = mode.show(max);
  return html`<span class="knum"><${NumInput} step=${mode.step} min=${lo} max=${hi} value=${mode.show(value)}
    onCommit=${(n) => onCommit(Math.max(min, Math.min(max, mode.read(n))))} />${mode.unit && html`<em>${mode.unit}</em>`}</span>`;
}

/**
 * A number box you can type into freely: clear it, type 35000, and nothing jumps back while you type.
 * Values are used as you type once they are in range; Enter or clicking away applies the rest (clamped to
 * min..max); Escape or an empty box goes back to the current value.
 */
export function NumInput({ value, min = -Infinity, max = Infinity, step, onCommit, ...rest }) {
  const [draft, setDraft] = useState(null);
  const ok = (n) => n !== "" && !isNaN(+n);
  const finish = (e) => {
    if (draft !== null && ok(draft)) onCommit(Math.max(min, Math.min(max, +draft)));
    setDraft(null);
    e?.target?.blur?.();
  };
  return html`<input type="number" step=${step} min=${isFinite(min) ? min : undefined} max=${isFinite(max) ? max : undefined} ...${rest}
    value=${draft ?? value}
    onFocus=${(e) => e.target.select()}
    onChange=${(e) => {
      const v = e.target.value;
      setDraft(v);
      if (ok(v) && +v >= min && +v <= max) onCommit(+v);
    }}
    onBlur=${() => { if (draft !== null && ok(draft)) onCommit(Math.max(min, Math.min(max, +draft))); setDraft(null); }}
    onKeyDown=${(e) => {
      if (e.key === "Enter") finish(e);
      else if (e.key === "Escape") { setDraft(null); e.target.blur(); }
      e.stopPropagation();
    }} />`;
}

/** A plain slider for a non-animated numeric setting, with an editable number. One undo step per drag. */
export function Slider({ label, value, min, max, step = 0.01, onChange, format = (v) => v.toFixed(2) }) {
  return html`<div class="krow plain">
    <span class="klabel" title=${label}>${label}</span>
    <input class="kslider" type="range" ...${rangeProps(format, min, max, step, value)}
      onPointerDown=${() => checkpoint()} onKeyDown=${() => checkpoint()} onChange=${(e) => onChange(fromRange(format, +e.target.value), true)} />
    <${NumBox} value=${value} min=${min} max=${max} format=${format} onCommit=${(v) => { checkpoint(); onChange(v, true); }} />
  </div>`;
}

/**
 * Curve editor for the keyframe at or before the playhead: the easing of the move to the next keyframe.
 * Presets, or drag the two Bézier handles.
 */
export function CurveEditor({ kind, id }) {
  const project = useStore((s) => s.project);
  const time = useStore((s) => s.time);
  const item = findItem(project, kind, id);
  const [prop, setProp] = useState(null);
  if (!item?.keyframes) return null;
  const props = Object.keys(item.keyframes).filter((p) => item.keyframes[p].length > 1);
  if (!props.length) return html`<p class="muted">Add two or more keyframes to a property to shape the motion between them.</p>`;
  const p = props.includes(prop) ? prop : props[0];
  const lt = localTime(project, kind, item, time);
  const ks = item.keyframes[p];
  let i = ks.length - 2;
  while (i > 0 && ks[i].t > lt + 1e-3) i--;
  const key = ks[i];
  const curve = easeCurve(key.ease);
  const setEase = (ease, live) => {
    const fn = (draft) => { findItem(draft, kind, id).keyframes[p][i].ease = ease; };
    if (live) editLive(fn); else edit(fn);
  };
  const W = 200, H = 140, pad = 20;
  const X = (x) => pad + x * (W - 2 * pad), Y = (y) => H - pad - y * (H - 2 * pad);
  const drag = (handle) => (e) => {
    e.preventDefault();
    const svg = e.currentTarget.ownerSVGElement;
    checkpoint();
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, ((ev.clientX - r.left) * (W / r.width) - pad) / (W - 2 * pad)));
      const y = Math.max(-0.5, Math.min(1.5, (H - pad - (ev.clientY - r.top) * (H / r.height)) / (H - 2 * pad)));
      const c = [...(curve || [0, 0, 1, 1])];
      if (handle === 1) { c[0] = x; c[1] = y; } else { c[2] = x; c[3] = y; }
      setEase(c.map((n) => Math.round(n * 1000) / 1000), true);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const path = curve
    ? `M${X(0)},${Y(0)} C${X(curve[0])},${Y(curve[1])} ${X(curve[2])},${Y(curve[3])} ${X(1)},${Y(1)}`
    : `M${X(0)},${Y(0)} H${X(1)} V${Y(1)}`;
  const label = (k) => ({ x: "Position X", y: "Position Y", scale: "Scale", rotation: "Rotation", opacity: "Opacity", volume: "Volume" }[k]
    || k.replace(/^adjust\./, "").replace(/^fx\.[^.]+\.amount$/, "Effect amount").replace("filter.amount", "Filter amount"));
  return html`<div class="curve">
    <${Field} label="Property">
      <select value=${p} onChange=${(e) => setProp(e.target.value)}>${props.map((k) => html`<option value=${k}>${label(k)}</option>`)}</select>
    <//>
    <p class="muted">Motion from keyframe ${i + 1} (${key.t.toFixed(2)}s) to ${i + 2} (${ks[i + 1].t.toFixed(2)}s)</p>
    <svg viewBox=${`0 0 ${W} ${H}`} class="curve-svg">
      <rect x=${pad} y=${pad} width=${W - 2 * pad} height=${H - 2 * pad} class="curve-box" />
      <path d=${path} class="curve-line" />
      ${curve && html`<line x1=${X(0)} y1=${Y(0)} x2=${X(curve[0])} y2=${Y(curve[1])} class="curve-arm" />
        <line x1=${X(1)} y1=${Y(1)} x2=${X(curve[2])} y2=${Y(curve[3])} class="curve-arm" />
        <circle cx=${X(curve[0])} cy=${Y(curve[1])} r="6" class="curve-knob" onPointerDown=${drag(1)} />
        <circle cx=${X(curve[2])} cy=${Y(curve[3])} r="6" class="curve-knob" onPointerDown=${drag(2)} />`}
    </svg>
    <div class="chips">
      ${Object.entries(EASINGS).map(([k, v]) => html`<button key=${k} class=${key.ease === k ? "chip on" : "chip"}
        onClick=${() => setEase(k, false)}>${v.label}</button>`)}
    </div>
  </div>`;
}

/** Current timeline time (for components that only need it occasionally). */
export const now = () => getState().time;
