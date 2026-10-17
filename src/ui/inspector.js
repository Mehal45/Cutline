// Right-hand inspector: properties of whatever is selected.
import React, { useState } from "react";
import { useStore, edit, editLive, checkpoint, findItem, getState, setState } from "../store.js";
import { clipSpeed, clipTransform, BLEND_MODES, ANIMATIONS, TRANSITIONS } from "../engine.js";
import {
  deleteSelection, rippleDelete, copySelection, duplicateSelection, setClipSpeed, SPEED_PRESETS, freezeFrame,
  mergeClips, detachAudio, applyFilter, toast,
} from "../actions.js";
import { ADJUST, FILTERS, EFFECTS, EFFECT_CATEGORIES } from "../fx.js";
import { VOICE_EFFECTS } from "../audiofx.js";
import { cutoutStatus, loadCutout } from "../segment.js";
import { uid } from "../store.js";
import { html, Field, Section, KSlider, Slider, CurveEditor } from "./kit.js";
import { FONTS, loadFont } from "./fonts.js";

const pct = (v) => `${Math.round(v * 100)}%`;
const deg = (v) => `${Math.round(v)}°`;
const signed = (v) => (v > 0 ? "+" : "") + (Math.abs(v) < 0.005 ? "0" : v.toFixed(2));

function Tabs({ tabs, tab, setTab }) {
  return html`<div class="itabs">${tabs.map(([k, l]) => html`<button key=${k} class=${tab === k ? "tab on" : "tab"} onClick=${() => setTab(k)}>${l}</button>`)}</div>`;
}

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

function SpeedFields({ speed, ids }) {
  return html`<div class="speed">
    <${Field} label=${`Speed ${speed.toFixed(2).replace(/\.?0+$/, "")}×`}>
      <div class="speed-chips">
        ${SPEED_PRESETS.map((v) => html`<button key=${v} class=${Math.abs(speed - v) < 1e-3 ? "chip on" : "chip"}
          onClick=${() => setClipSpeed(v, ids)}>${v}×</button>`)}
      </div>
      <input type="range" min="0.1" max="10" step="0.05" value=${speed}
        onChange=${(e) => setClipSpeed(+e.target.value, ids)} />
    <//>
  </div>`;
}

/** Live-edit helper: one undo step per drag (checkpoint on pointerdown, editLive while moving). */
const liveSet = (kind, id) => (fn, live) => (live ? editLive : edit)((p) => fn(findItem(p, kind, id)));

// ---------------- visual items (main clips + overlay layers) ----------------

function TransformSection({ kind, id }) {
  const set = liveSet(kind, id);
  return html`<${Section} title="Position & size">
    <${KSlider} kind=${kind} id=${id} path="x" label="X" min=${-0.5} max=${1.5} step=${0.005} fallback=${0.5} format=${pct} />
    <${KSlider} kind=${kind} id=${id} path="y" label="Y" min=${-0.5} max=${1.5} step=${0.005} fallback=${0.5} format=${pct} />
    <${KSlider} kind=${kind} id=${id} path="scale" label="Scale" min=${0.05} max=${4} fallback=${1} format=${pct} />
    <${KSlider} kind=${kind} id=${id} path="rotation" label="Rotation" min=${-180} max=${180} step=${1} fallback=${0} format=${deg} />
    <${KSlider} kind=${kind} id=${id} path="opacity" label="Opacity" min=${0} max=${1} fallback=${1} format=${pct} />
    <button class="wide" onClick=${() => set((s) => {
      s.transform = { x: 0.5, y: 0.5, scale: kind === "overlay" ? 0.45 : 1, rotation: 0 };
      if (s.keyframes) for (const k of ["x", "y", "scale", "rotation"]) delete s.keyframes[k];
    })}>Reset position & size</button>
  <//>`;
}

function LookSection({ kind, item }) {
  const set = liveSet(kind, item.id);
  const crop = item.crop || { l: 0, t: 0, r: 0, b: 0 };
  const setCrop = (k, v, live) => set((s) => {
    const c = { ...(s.crop || { l: 0, t: 0, r: 0, b: 0 }), [k]: v };
    // Keep at least 5% visible on each axis.
    if (c.l + c.r > 0.95) c[k] = 0.95 - (k === "l" ? c.r : c.l);
    if (c.t + c.b > 0.95) c[k] = 0.95 - (k === "t" ? c.b : c.t);
    s.crop = c;
  }, live);
  return html`<${Section} title="Blend, flip & crop" open=${!!(item.blend || item.flipH || item.flipV || item.crop)}>
    <${Field} label="Blend mode">
      <select value=${item.blend || "normal"} onChange=${(e) => set((s) => (s.blend = e.target.value === "normal" ? undefined : e.target.value))}>
        ${Object.entries(BLEND_MODES).map(([k, [l]]) => html`<option value=${k}>${l}</option>`)}
      </select>
    <//>
    <div class="grid2">
      <button class=${item.flipH ? "chip on" : "chip"} onClick=${() => set((s) => (s.flipH = !s.flipH))}>⇋ Flip horizontal</button>
      <button class=${item.flipV ? "chip on" : "chip"} onClick=${() => set((s) => (s.flipV = !s.flipV))}>⇵ Flip vertical</button>
    </div>
    <div class="grid2">
      ${[["l", "Crop left"], ["r", "Crop right"], ["t", "Crop top"], ["b", "Crop bottom"]].map(([k, l]) => html`<${Slider} key=${k}
        label=${l} value=${crop[k]} min=${0} max=${0.9} step=${0.005} format=${pct} onChange=${(v, live) => setCrop(k, v, live)} />`)}
    </div>
    ${item.crop && html`<button class="wide" onClick=${() => set((s) => delete s.crop)}>Reset crop</button>`}
  <//>`;
}

function SourceSection({ kind, item, media }) {
  const set = liveSet(kind, item.id);
  const speed = clipSpeed(item);
  const maxSrc = media?.kind === "image" ? 1e9 : media.duration;
  return html`<${Section} title="Timing" open=${kind === "main"}>
    <${SpeedFields} speed=${speed} ids=${[item.id]} />
    <${Field} label=${`Starts at ${(item.in || 0).toFixed(2)}s of source`}>
      <input type="range" min="0" max=${Math.max(0, (media?.kind === "image" ? 60 : media.duration) - 0.1)} step="0.01" value=${item.in || 0}
        onChange=${(e) => set((s) => { s.in = +e.target.value; s.dur = Math.min(s.dur, (maxSrc - s.in) / speed); })} />
    <//>
    <${Field} label=${`Duration ${item.dur.toFixed(2)}s on timeline`}>
      <input type="range" min="0.2" max=${media?.kind === "image" ? 30 : (media.duration - (item.in || 0)) / speed} step="0.01" value=${item.dur}
        onChange=${(e) => set((s) => (s.dur = +e.target.value))} />
    <//>
  <//>`;
}

export function FilterSection({ kind, item }) {
  return html`<${Section} title="Filter">
    <div class="filter-grid">
      <button class=${!item.filter?.type ? "chip on" : "chip"} onClick=${() => edit((p) => (findItem(p, kind, item.id).filter = null))}>None</button>
      ${Object.entries(FILTERS).map(([k, f]) => html`<button key=${k} class=${item.filter?.type === k ? "chip on" : "chip"}
        onClick=${() => edit((p) => { const it = findItem(p, kind, item.id); it.filter = { type: k, amount: it.filter?.amount ?? 1 }; })}>${f.label}</button>`)}
    </div>
    ${item.filter?.type && html`<${KSlider} kind=${kind} id=${item.id} path="filter.amount" label="Strength" min=${0} max=${1} fallback=${1} format=${pct} />`}
  <//>`;
}

export function AdjustSection({ kind, item }) {
  const any = item.adjust && Object.values(item.adjust).some((v) => v);
  return html`<${Section} title="Adjust" right=${any && html`<button class="mini" onClick=${() => edit((p) => {
      const it = findItem(p, kind, item.id);
      delete it.adjust;
      if (it.keyframes) for (const k of Object.keys(it.keyframes)) if (k.startsWith("adjust.")) delete it.keyframes[k];
    })}>Reset</button>`}>
    ${Object.entries(ADJUST).map(([k, a]) => html`<${KSlider} key=${k} kind=${kind} id=${item.id} path=${"adjust." + k} label=${a.label}
      min=${a.min} max=${a.max} step=${a.step || 0.01} fallback=${0} format=${k === "hue" ? deg : signed} />`)}
  <//>`;
}

export function EffectsSection({ kind, item }) {
  const fx = item.fx || [];
  const set = (fn) => edit((p) => fn(findItem(p, kind, item.id)));
  const move = (i, d) => set((it) => { const [x] = it.fx.splice(i, 1); it.fx.splice(i + d, 0, x); });
  return html`<${Section} title=${`Effects${fx.length ? ` (${fx.length})` : ""}`}>
    ${!fx.length && html`<p class="muted">No effects yet. Pick one below, or browse them with previews in the Effects tab on the left.</p>`}
    ${fx.map((f, i) => html`<div class="fx-row" key=${f.id}>
      <div class="row between">
        <b>${EFFECTS[f.type]?.label || f.type}</b>
        <span class="kbtns">
          <button class="mini" disabled=${i === 0} title="Earlier in the chain" onClick=${() => move(i, -1)}>↑</button>
          <button class="mini" disabled=${i === fx.length - 1} title="Later in the chain" onClick=${() => move(i, 1)}>↓</button>
          <button class="mini" title="Remove effect" onClick=${() => set((it) => {
            it.fx = it.fx.filter((x) => x.id !== f.id);
            if (it.keyframes) delete it.keyframes[`fx.${f.id}.amount`];
          })}>✕</button>
        </span>
      </div>
      <${KSlider} kind=${kind} id=${item.id} path=${`fx.${f.id}.amount`} label="Amount" min=${0} max=${1} fallback=${f.amount ?? 1} format=${pct} />
    </div>`)}
    <${Field} label="Add effect">
      <select value="" onChange=${(e) => { const type = e.target.value; if (type) set((it) => (it.fx = [...(it.fx || []), { id: uid(), type, amount: 0.7 }])); }}>
        <option value="">Choose…</option>
        ${EFFECT_CATEGORIES.map((cat, ci) => html`<optgroup label=${cat}>
          ${Object.entries(EFFECTS).filter(([, d]) => d.cat === ci).map(([k, d]) => html`<option value=${k}>${d.label}</option>`)}
        </optgroup>`)}
      </select>
    <//>
  <//>`;
}

function CutoutSection({ kind, item }) {
  const set = liveSet(kind, item.id);
  const status = useStore((s) => s.cutoutStatus) || cutoutStatus();
  const ck = item.chroma || {};
  const pickColor = async () => {
    if (!window.EyeDropper) return toast("Colour picking from the screen isn't supported here; use the colour box");
    try {
      const { sRGBHex } = await new window.EyeDropper().open();
      set((s) => (s.chroma = { ...(s.chroma || {}), on: true, color: sRGBHex }));
    } catch { /* cancelled */ }
  };
  return html`<div>
    <${Section} title="Remove background (people)">
      <p class="muted">Finds people in each frame and removes everything else. Runs on your computer; the model (~250 KB) downloads once.</p>
      <label class="check"><input type="checkbox" checked=${item.cutout?.mode === "person"}
        onChange=${(e) => { set((s) => (s.cutout = e.target.checked ? { mode: "person", feather: 2 } : undefined)); if (e.target.checked) loadCutout(); }} /> Remove background</label>
      ${item.cutout?.mode && html`
        ${status === "loading" && html`<p class="status">Loading the model…</p>`}
        ${status === "failed" && html`<p class="error">Couldn't load the model. Check your connection and toggle it again.</p>`}
        <label class="check"><input type="checkbox" checked=${!!item.cutout.invert}
          onChange=${(e) => set((s) => (s.cutout = { ...s.cutout, invert: e.target.checked }))} /> Invert (remove the person, keep the background)</label>
        <${Slider} label="Edge softness" value=${item.cutout.feather ?? 2} min=${0} max=${10} step=${0.5} format=${(v) => v.toFixed(1)}
          onChange=${(v, live) => set((s) => (s.cutout = { ...s.cutout, feather: v }), live)} />`}
    <//>
    <${Section} title="Chroma key (green screen)" open=${!!ck.on}>
      <label class="check"><input type="checkbox" checked=${!!ck.on}
        onChange=${(e) => set((s) => (s.chroma = { color: "#00ff00", similarity: 0.12, smoothness: 0.08, spill: 0.5, ...(s.chroma || {}), on: e.target.checked }))} /> Remove a colour</label>
      ${ck.on && html`
        <div class="row">
          <input type="color" value=${ck.color || "#00ff00"} onChange=${(e) => set((s) => (s.chroma = { ...s.chroma, color: e.target.value }))} />
          <button onClick=${pickColor} title="Pick the colour from the screen">⌖ Pick</button>
        </div>
        <${Slider} label="Similarity" value=${ck.similarity ?? 0.12} min=${0.01} max=${0.5} format=${pct} onChange=${(v, live) => set((s) => (s.chroma = { ...s.chroma, similarity: v }), live)} />
        <${Slider} label="Smoothness" value=${ck.smoothness ?? 0.08} min=${0} max=${0.3} format=${pct} onChange=${(v, live) => set((s) => (s.chroma = { ...s.chroma, smoothness: v }), live)} />
        <${Slider} label="Spill reduction" value=${ck.spill ?? 0.5} min=${0} max=${1} format=${pct} onChange=${(v, live) => set((s) => (s.chroma = { ...s.chroma, spill: v }), live)} />`}
    <//>
  </div>`;
}

export function AudioSection({ kind, item, media }) {
  const set = liveSet(kind, item.id);
  const au = item.audio || {};
  const setAu = (k, v, live) => set((s) => (s.audio = { ...(s.audio || {}), [k]: v }), live);
  if (media && media.kind === "image") return html`<p class="muted">Pictures have no sound.</p>`;
  return html`<div>
    <${Section} title="Volume">
      <label class="check"><input type="checkbox" checked=${!!item.mute} onChange=${(e) => set((s) => (s.mute = e.target.checked || undefined))} /> Mute</label>
      <${KSlider} kind=${kind} id=${item.id} path="volume" label="Volume" min=${0} max=${2} fallback=${au.volume ?? 1} format=${pct} />
      <${Slider} label="Fade in" value=${au.fadeIn || 0} min=${0} max=${Math.min(10, item.dur / 2)} step=${0.05} format=${(v) => v.toFixed(2) + "s"} onChange=${(v, live) => setAu("fadeIn", v, live)} />
      <${Slider} label="Fade out" value=${au.fadeOut || 0} min=${0} max=${Math.min(10, item.dur / 2)} step=${0.05} format=${(v) => v.toFixed(2) + "s"} onChange=${(v, live) => setAu("fadeOut", v, live)} />
      <p class="muted">Above 100% plays louder in the preview and the export.</p>
    <//>
    <${Section} title="Voice cleanup">
      <label class="check"><input type="checkbox" checked=${!!au.denoise} onChange=${(e) => setAu("denoise", e.target.checked || undefined)} /> Reduce noise</label>
      <label class="check"><input type="checkbox" checked=${!!au.enhance} onChange=${(e) => setAu("enhance", e.target.checked || undefined)} /> Enhance voice</label>
      <label class="check"><input type="checkbox" checked=${!!au.normalize} onChange=${(e) => setAu("normalize", e.target.checked || undefined)} /> Level loudness</label>
    <//>
    <${Section} title="Voice effect">
      <div class="filter-grid">
        ${Object.entries(VOICE_EFFECTS).map(([k, l]) => html`<button key=${k} class=${(au.voice || "none") === k ? "chip on" : "chip"}
          onClick=${() => setAu("voice", k === "none" ? undefined : k)}>${l}</button>`)}
      </div>
    <//>
    ${kind !== "audio" && media?.kind === "video" && !item.mute && html`<button class="wide" onClick=${detachAudio}>Detach audio to its own track</button>`}
  </div>`;
}

function AnimateSection({ kind, item, textOnly, onAnim, note }) {
  const set = liveSet(kind, item.id);
  return html`<div>
    <${Section} title="In & out animation">
      ${note}
      <${AnimFields} textOnly=${textOnly} anim=${item.anim} onChange=${onAnim || ((k, v) => set((s) => Object.assign(s.anim[k], v)))} />
    <//>
    <${Section} title="Keyframe curves">
      <p class="muted">Press ◆ next to any slider to add a keyframe at the playhead. Move the playhead, change the value, and it animates between them.</p>
      <${CurveEditor} kind=${kind} id=${item.id} />
    <//>
  </div>`;
}

function VisualInspector({ kind, item, project }) {
  const [tab, setTab] = useState("basic");
  const media = project.media[item.mediaId];
  const hasSound = media?.kind === "video";
  const tabs = [["basic", "Basic"], ["color", "Colour"], ["effects", "Effects"], ["cutout", "Cutout"], ...(hasSound ? [["audio", "Audio"]] : []), ["animate", "Animate"]];
  const t = tabs.some(([k]) => k === tab) ? tab : "basic";
  return html`<aside class="panel inspector">
    <h3>${kind === "overlay" ? "Layer" : "Clip"}</h3>
    <p class="muted ell">${media?.name}</p>
    <${Tabs} tabs=${tabs} tab=${t} setTab=${setTab} />
    ${t === "basic" && html`
      <${TransformSection} kind=${kind} id=${item.id} />
      <${SourceSection} kind=${kind} item=${item} media=${media} />
      <${LookSection} kind=${kind} item=${item} />
      <div class="grid2">
        ${media?.kind === "video" && html`<button onClick=${() => freezeFrame()} title="Hold the frame under the playhead for 3 seconds">❄ Freeze frame</button>`}
        ${kind === "main" && html`<button onClick=${mergeClips} title="Select neighbouring pieces of one clip, then merge">⊕ Merge</button>`}
      </div>`}
    ${t === "color" && html`<${FilterSection} kind=${kind} item=${item} /><${AdjustSection} kind=${kind} item=${item} />`}
    ${t === "effects" && html`<${EffectsSection} kind=${kind} item=${item} />`}
    ${t === "cutout" && html`<${CutoutSection} kind=${kind} item=${item} />`}
    ${t === "audio" && html`<${AudioSection} kind=${kind} item=${item} media=${media} />`}
    ${t === "animate" && html`<${AnimateSection} kind=${kind} item=${item} />`}
    <button class="danger wide" onClick=${deleteSelection}>Delete ${kind === "overlay" ? "layer" : "clip"}</button>
    ${kind === "overlay" && html`<button class="wide" onClick=${rippleDelete} title="Delete and close the gap (Shift+Delete)">Ripple delete</button>`}
  </aside>`;
}

// ---------------- text ----------------

/** Font, size, weight, case, alignment and spacing. `setSt(key, value, live)` decides which texts change. */
function TextFontFields({ st, setSt }) {
  return html`<div>
    <div class="grid2">
      <${Field} label="Size"><input type="number" min="12" max="400" value=${st.size} onChange=${(e) => setSt("size", +e.target.value)} /><//>
      <${Field} label="Weight">
        <select value=${st.weight} onChange=${(e) => setSt("weight", +e.target.value)}>
          ${[300, 400, 500, 600, 700, 800, 900].map((w) => html`<option value=${w}>${w}</option>`)}
        </select>
      <//>
    </div>
    <${Field} label="Font">
      <select value=${st.font} onChange=${(e) => { loadFont(e.target.value, st.weight); setSt("font", e.target.value); }}>
        ${FONTS.map((f) => html`<option value=${f.css} style=${{ fontFamily: f.css }}>${f.name}</option>`)}
      </select>
    <//>
    <div class="grid3">
      <button class=${st.italic ? "chip on" : "chip"} onClick=${() => setSt("italic", !st.italic || undefined)}><i>I</i> Italic</button>
      <button class=${st.uppercase ? "chip on" : "chip"} onClick=${() => setSt("uppercase", !st.uppercase || undefined)}>AA Caps</button>
      <select value=${st.align || "center"} onChange=${(e) => setSt("align", e.target.value === "center" ? undefined : e.target.value)}>
        <option value="left">Left</option><option value="center">Centre</option><option value="right">Right</option>
      </select>
    </div>
    <${Slider} label="Letter spacing" value=${st.letterSpacing || 0} min=${-0.1} max=${0.5} step=${0.01} format=${(v) => v.toFixed(2)} onChange=${(v, live) => setSt("letterSpacing", v || undefined, live)} />
    <${Slider} label="Line height" value=${st.lineHeight || 1.2} min=${0.8} max=${2} step=${0.05} format=${(v) => v.toFixed(2)} onChange=${(v, live) => setSt("lineHeight", v, live)} />
  </div>`;
}

/** Colours, outline, shadow and background plate. */
function TextLookFields({ st, setSt }) {
  const shadow = st.shadow;
  return html`<div>
    <div class="grid2">
      <${Field} label="Colour"><input type="color" value=${st.color} onChange=${(e) => setSt("color", e.target.value)} /><//>
      <${Field} label="Highlight"><input type="color" value=${st.highlight} onChange=${(e) => setSt("highlight", e.target.value)} /><//>
      <${Field} label="Outline"><input type="color" value=${st.stroke} onChange=${(e) => setSt("stroke", e.target.value)} /><//>
      <${Field} label="Outline width"><input type="number" min="0" max="30" value=${st.strokeWidth} onChange=${(e) => setSt("strokeWidth", +e.target.value)} /><//>
    </div>
    <${Section} title="Shadow" open=${!!shadow}>
      <label class="check"><input type="checkbox" checked=${!!shadow}
        onChange=${(e) => setSt("shadow", e.target.checked ? { color: "#000000aa", blur: 10, x: 4, y: 6 } : undefined)} /> Drop shadow</label>
      ${shadow && html`
        <${Field} label="Colour"><input type="color" value=${(shadow.color || "#000000").slice(0, 7)} onChange=${(e) => setSt("shadow", { ...shadow, color: e.target.value + (shadow.color?.slice(7) || "aa") })} /><//>
        <${Slider} label="Blur" value=${shadow.blur ?? 10} min=${0} max=${60} step=${1} format=${(v) => v.toFixed(0)} onChange=${(v, live) => setSt("shadow", { ...shadow, blur: v }, live)} />
        <div class="grid2">
          <${Slider} label="Offset X" value=${shadow.x ?? 4} min=${-40} max=${40} step=${1} format=${(v) => v.toFixed(0)} onChange=${(v, live) => setSt("shadow", { ...shadow, x: v }, live)} />
          <${Slider} label="Offset Y" value=${shadow.y ?? 6} min=${-40} max=${40} step=${1} format=${(v) => v.toFixed(0)} onChange=${(v, live) => setSt("shadow", { ...shadow, y: v }, live)} />
        </div>`}
    <//>
    <${Section} title="Background plate" open=${!!st.bg}>
      <label class="check"><input type="checkbox" checked=${!!st.bg} onChange=${(e) => setSt("bg", e.target.checked ? "#000000aa" : "")} /> Background box</label>
      ${st.bg && html`
        <div class="grid2">
          <${Field} label="Colour"><input type="color" value=${st.bg.slice(0, 7)} onChange=${(e) => setSt("bg", e.target.value + (st.bg.slice(7) || "aa"))} /><//>
          <${Slider} label="Opacity" value=${parseInt(st.bg.slice(7) || "ff", 16) / 255} min=${0} max=${1} format=${pct}
            onChange=${(v, live) => setSt("bg", st.bg.slice(0, 7) + Math.round(v * 255).toString(16).padStart(2, "0"), live)} />
        </div>
        <div class="grid2">
          <${Slider} label="Padding" value=${st.bgPad ?? 0.6} min=${0.1} max=${2} format=${(v) => v.toFixed(2)} onChange=${(v, live) => setSt("bgPad", v, live)} />
          <${Slider} label="Corner radius" value=${st.bgRadius ?? 0.25} min=${0} max=${1} format=${(v) => v.toFixed(2)} onChange=${(v, live) => setSt("bgRadius", v, live)} />
        </div>`}
    <//>
  </div>`;
}

/** Sets one style key on every text whose id is in `ids` (one undo step per drag). */
const setStyleOn = (ids) => (k, v, live) => (live ? editLive : edit)((p) => {
  for (const x of p.texts) if (ids.has(x.id)) x.style[k] = v;
});

/** Changes the in or out animation (`key`) on every text whose id is in `ids`. */
const setAnimOn = (ids) => (key, v) => edit((p) => {
  for (const x of p.texts) if (ids.has(x.id)) x.anim = { ...x.anim, [key]: { ...(x.anim?.[key] || { type: "none", dur: 0.4 }), ...v } };
});

const selectAllCaptions = () => {
  const ids = getState().project.texts.filter((x) => x.caption).map((x) => ({ kind: "text", id: x.id }));
  setState({ selection: ids });
  toast(`Selected ${ids.length} caption${ids.length === 1 ? "" : "s"}`);
};

function TextInspector({ t }) {
  const [tab, setTab] = useState("text");
  const linked = useStore((s) => s.captionLink);
  const captionCount = useStore((s) => s.project.texts.filter((x) => x.caption).length);
  const set = liveSet("text", t.id);
  const st = t.style;
  // With "Apply to all captions" on, a style change on a caption changes that setting on every caption.
  const allCaptions = t.caption && linked;
  const setSt = (k, v, live) => (allCaptions
    ? setStyleOn(new Set(getState().project.texts.filter((x) => x.caption).map((x) => x.id)))(k, v, live)
    : set((x) => (x.style[k] = v), live));
  const applyAll = () => edit((p) => p.texts.forEach((x) => {
    if (x.caption) Object.assign(x, { style: structuredClone(st), x: t.x, y: t.y, scale: t.scale, rotation: t.rotation, anim: structuredClone(t.anim) });
  }));
  const linkBox = t.caption && captionCount > 1 && html`<div class="linkbar">
    <label class="check"><input type="checkbox" checked=${!!linked} onChange=${(e) => setState({ captionLink: e.target.checked })} />
      Apply changes to all ${captionCount} captions</label>
    <button class="mini" onClick=${selectAllCaptions} title="Select every caption on the timeline">Select all</button>
  </div>`;
  return html`<aside class="panel inspector">
    <h3>${t.caption ? "Caption" : "Text"}</h3>
    ${linkBox}
    <${Tabs} tabs=${[["text", "Text"], ["style", "Style"], ["animate", "Animate"]]} tab=${tab} setTab=${setTab} />
    ${tab === "text" && html`
      <textarea rows="3" value=${t.text} onChange=${(e) => set((x) => { x.text = e.target.value; delete x.words; })} />
      ${t.caption && t.words && html`<p class="muted">Editing the text removes word-by-word highlighting for this caption.</p>`}
      <${TextFontFields} st=${st} setSt=${setSt} />
      <${Section} title="Position & size">
        <${KSlider} kind="text" id=${t.id} path="x" label="X" min=${-0.5} max=${1.5} step=${0.005} fallback=${0.5} format=${pct} />
        <${KSlider} kind="text" id=${t.id} path="y" label="Y" min=${-0.5} max=${1.5} step=${0.005} fallback=${0.5} format=${pct} />
        <${KSlider} kind="text" id=${t.id} path="scale" label="Scale" min=${0.05} max=${4} fallback=${1} format=${pct} />
        <${KSlider} kind="text" id=${t.id} path="rotation" label="Rotation" min=${-180} max=${180} step=${1} fallback=${0} format=${deg} />
        <${KSlider} kind="text" id=${t.id} path="opacity" label="Opacity" min=${0} max=${1} fallback=${1} format=${pct} />
        <button class="wide" onClick=${() => set((x) => {
          Object.assign(x, { x: 0.5, y: t.caption ? 0.82 : 0.5, scale: 1, rotation: 0 });
          if (x.keyframes) for (const k of ["x", "y", "scale", "rotation"]) delete x.keyframes[k];
        })}>Reset position & size</button>
      <//>`}
    ${tab === "style" && html`
      <${TextLookFields} st=${st} setSt=${setSt} />
      ${t.caption && html`<button class="wide" onClick=${applyAll} title="Copies this caption's whole style, position and animation to every caption">Copy this whole look to all captions</button>`}`}
    ${tab === "animate" && html`<${AnimateSection} kind="text" item=${t} textOnly
      onAnim=${allCaptions ? setAnimOn(new Set(getState().project.texts.filter((x) => x.caption).map((x) => x.id))) : undefined}
      note=${allCaptions && html`<p class="muted">Changes apply to all ${captionCount} captions.</p>`} />`}
    <button class="danger wide" onClick=${deleteSelection}>Delete</button>
  </aside>`;
}

/** Shown when several texts/captions are selected: one set of controls changes all of them. */
function MultiTextFields({ texts }) {
  const [tab, setTab] = useState("font");
  const ids = new Set(texts.map((x) => x.id));
  const st = texts[0].style;
  const setSt = setStyleOn(ids);
  const label = texts.every((x) => x.caption) ? "captions" : "texts";
  const same = (k) => texts.every((x) => JSON.stringify(x.style[k]) === JSON.stringify(st[k]));
  const differ = ["font", "size", "weight", "color"].filter((k) => !same(k));
  return html`<div class="multitext">
    <h3>Style for ${texts.length} ${label}</h3>
    ${differ.length > 0 && html`<p class="muted">They don't all share the same ${differ.join(", ")}; showing the first one's. Any change applies to all ${texts.length}.</p>`}
    <${Tabs} tabs=${[["font", "Font & size"], ["look", "Colour & box"], ["anim", "Animation"], ["place", "Position"]]} tab=${tab} setTab=${setTab} />
    ${tab === "anim" && html`<${AnimFields} textOnly anim=${texts[0].anim} onChange=${setAnimOn(ids)} />`}
    ${tab === "font" && html`<${TextFontFields} st=${st} setSt=${setSt} />`}
    ${tab === "look" && html`<${TextLookFields} st=${st} setSt=${setSt} />`}
    ${tab === "place" && html`
      <${Slider} label="Vertical position" value=${texts[0].y} min=${0} max=${1} step=${0.005} format=${pct}
        onChange=${(v, live) => (live ? editLive : edit)((p) => { for (const x of p.texts) if (ids.has(x.id)) x.y = v; })} />
      <${Slider} label="Horizontal position" value=${texts[0].x} min=${0} max=${1} step=${0.005} format=${pct}
        onChange=${(v, live) => (live ? editLive : edit)((p) => { for (const x of p.texts) if (ids.has(x.id)) x.x = v; })} />
      <${Slider} label="Scale" value=${texts[0].scale || 1} min=${0.2} max=${3} format=${pct}
        onChange=${(v, live) => (live ? editLive : edit)((p) => { for (const x of p.texts) if (ids.has(x.id)) x.scale = v; })} />`}
  </div>`;
}

// ---------------- audio items & timeline effects ----------------

function AudioInspector({ item, project }) {
  const media = project.media[item.mediaId];
  return html`<aside class="panel inspector">
    <h3>Audio</h3>
    <p class="muted ell">${media?.name}</p>
    <${SpeedFields} speed=${clipSpeed(item)} ids=${[item.id]} />
    <${AudioSection} kind="audio" item=${item} media=${media} />
    <${Section} title="Volume keyframe curves" open=${false}><${CurveEditor} kind="audio" id=${item.id} /><//>
    <button class="danger wide" onClick=${deleteSelection}>Delete</button>
    <button class="wide" onClick=${rippleDelete} title="Delete and close the gap (Shift+Delete)">Ripple delete</button>
  </aside>`;
}

function EffectInspector({ item }) {
  const [tab, setTab] = useState("effects");
  const set = liveSet("effect", item.id);
  return html`<aside class="panel inspector">
    <h3>Timeline effect</h3>
    <${Field} label="Name"><input value=${item.name || ""} onChange=${(e) => set((x) => (x.name = e.target.value))} /><//>
    <p class="muted">Applies to every clip and layer under it, for as long as it lasts on the timeline.</p>
    <${KSlider} kind="effect" id=${item.id} path="opacity" label="Mix" min=${0} max=${1} fallback=${1} format=${pct} />
    <${Tabs} tabs=${[["effects", "Effects"], ["color", "Colour"], ["animate", "Curves"]]} tab=${tab} setTab=${setTab} />
    ${tab === "effects" && html`<${EffectsSection} kind="effect" item=${item} />`}
    ${tab === "color" && html`<${FilterSection} kind="effect" item=${item} /><${AdjustSection} kind="effect" item=${item} />`}
    ${tab === "animate" && html`<${CurveEditor} kind="effect" id=${item.id} />`}
    <button class="danger wide" onClick=${deleteSelection}>Delete</button>
  </aside>`;
}

// ---------------- entry ----------------

export function Inspector() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);

  if (selection.length > 1) {
    const clipIds = selection.filter((s) => s.kind === "main" || s.kind === "overlay").map((s) => s.id);
    const first = clipIds.map((id) => project.main.find((s) => s.id === id) || project.overlays.find((s) => s.id === id)).find(Boolean);
    const texts = selection.filter((s) => s.kind === "text").map((s) => project.texts.find((x) => x.id === s.id)).filter(Boolean);
    return html`<aside class="panel inspector">
      <h3>${selection.length} items selected</h3>
      ${texts.length > 0 && html`<${MultiTextFields} key=${texts.map((x) => x.id).join()} texts=${texts} />`}
      <p class="muted">Drag in the preview to move them together. Ctrl+C copy · Ctrl+D duplicate · Del delete.</p>
      ${first && html`<${SpeedFields} speed=${clipSpeed(first)} ids=${clipIds} />`}
      ${clipIds.length > 0 && html`<${Field} label="Filter for all selected">
        <select value="" onChange=${(e) => applyFilter(e.target.value === "none" ? null : e.target.value)}>
          <option value="">Choose…</option><option value="none">None</option>
          ${Object.entries(FILTERS).map(([k, f]) => html`<option value=${k}>${f.label}</option>`)}
        </select>
      <//>`}
      <button class="wide" onClick=${copySelection}>Copy</button>
      <button class="wide" onClick=${duplicateSelection}>Duplicate</button>
      ${selection.filter((s) => s.kind === "main").length > 1 && html`<button class="wide" onClick=${mergeClips}>Merge clips</button>`}
      <button class="danger wide" onClick=${deleteSelection}>Delete all</button>
    </aside>`;
  }
  const sel = selection[0];
  const item = sel && findItem(project, sel.kind, sel.id);

  if ((sel?.kind === "main" || sel?.kind === "overlay") && item) return html`<${VisualInspector} key=${item.id} kind=${sel.kind} item=${item} project=${project} />`;

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

  if (sel?.kind === "text" && item) return html`<${TextInspector} key=${item.id} t=${item} />`;
  if (sel?.kind === "audio" && item) return html`<${AudioInspector} key=${item.id} item=${item} project=${project} />`;
  if (sel?.kind === "effect" && item) return html`<${EffectInspector} key=${item.id} item=${item} />`;

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
        ${[24, 25, 30, 50, 60].map((f) => html`<option value=${f}>${f} fps</option>`)}
      </select>
    <//>
    <p class="muted">Click something in the preview or timeline to edit it. Drag across empty timeline space to select several items.</p>
  </aside>`;
}
