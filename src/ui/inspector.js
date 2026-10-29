// Right-hand inspector: properties of whatever is selected.
import React, { useState, useRef, useEffect } from "react";
import { useStore, usePanelTime, edit, editLive, checkpoint, findItem, getState, setState } from "../store.js";
import { clipSpeed, clipTransform, BLEND_MODES, ANIMATIONS, TRANSITIONS, itemBounds } from "../engine.js";
import {
  deleteSelection, rippleDelete, copySelection, duplicateSelection, setClipSpeed, SPEED_PRESETS, freezeFrame,
  mergeClips, detachAudio, applyFilter, toast, setAnimatable, toggleKeyframe, localTime, mirrorSelection,
  setTextSound, soundToAll, toggleAllKeyframes, allKeyedHere,
} from "../actions.js";
import { ADJUST, FILTERS, EFFECTS, EFFECT_CATEGORIES } from "../fx.js";
import { VOICE_EFFECTS } from "../audiofx.js";
import { cutoutStatus, loadCutout } from "../segment.js";
import { uid } from "../store.js";
import { embedded, reportChatSlot } from "../embed.js";
import { saveElement } from "../elements.js";
import { html, Field, Section, KSlider, Slider, CurveEditor, Icon, db, secs, NumInput } from "./kit.js";
import { FONTS, loadFont, familyCss, canListSystemFonts, loadSystemFonts, rememberFont, fontName } from "./fonts.js";
import { SpeedCurveEditor } from "./speedcurve.js";
import { hasCurve } from "../speed.js";
import { setDefaultEase, defaultEase, propAt, hasKeys, keyAt } from "../keyframes.js";
import { saveTextPreset, saveAdjustPreset, saveAudioPreset, presetsOf, applyAudioPreset, applyAdjustPreset, saveClipLookPreset } from "../presets.js";
import { MultiClipInspector, PresetButtons, SavePresetButton } from "./multiclip.js";
import { MaskSection, startCrop } from "./mask.js";
import { lastDur, rememberDur } from "../settings.js";
import { copySettings, pasteSettings } from "../actions.js";
import { ShapeFields, shapeName } from "./shapes.js";

/** "Save as preset": keeps this text's whole look for one-click reuse (Text tab › My presets). */
function SavePreset({ t, save: saveFn, label = "Save as preset", hint = "Save font, size, colour, shadow, position, animation and length" }) {
  const [naming, setNaming] = useState(false);
  const nameRef = useRef();
  const presets = useStore((s) => s.textPresets) || [];
  if (!naming) return html`<button class="wide save-preset" onClick=${() => setNaming(true)} title=${hint}>
    <i class="ico icon-bookmark-plus" /> ${label}</button>`;
  const save = (name) => { (saveFn ? saveFn(name) : saveTextPreset(getState().project.texts.find((x) => x.id === t.id) || t, name)); setNaming(false); };
  return html`<div class="preset-name">
    <input ref=${nameRef} autoFocus placeholder="Preset name" list="preset-names"
      onKeyDown=${(e) => { if (e.key === "Enter") save(e.target.value); if (e.key === "Escape") setNaming(false); }} />
    <datalist id="preset-names">${presets.map((p) => html`<option value=${p.name} />`)}</datalist>
    <button class="primary" onClick=${() => save(nameRef.current.value)}>Save</button>
    <button onClick=${() => setNaming(false)}>Cancel</button>
  </div>`;
}

const pct = (v) => `${Math.round(v * 100)}%`;
const deg = (v) => `${Math.round(v)}°`;
const signed = (v) => (v > 0 ? "+" : "") + (Math.abs(v) < 0.005 ? "0" : v.toFixed(2));

function Tabs({ tabs, tab, setTab }) {
  return html`<div class="itabs">${tabs.map(([k, l]) => html`<button key=${k} class=${tab === k ? "tab on" : "tab"} onClick=${() => setTab(k)}>${l}</button>`)}</div>`;
}

/**
 * The inspector frame: text tabs along the top (Video · Audio · Speed …) and a scrolling body. Inside Flodit
 * the first tab is always Chat, open by default and glowing (founder, Oct 29); Flodit draws its chat over
 * the body while it's open (embed.js reports where).
 */
function Shell({ tabs, tab, setTab, children, note }) {
  const chat = useStore((s) => s.floditChat) && embedded;
  const slot = useRef(null);
  useEffect(() => {
    if (!chat || !slot.current) return reportChatSlot(null);
    return reportChatSlot(slot.current);
  }, [chat]);
  return html`<aside class="panel inspector">
    <nav class="itop">
      ${embedded && html`<button key="chat" class=${chat ? "chat-tab on" : "chat-tab"} onClick=${() => setState({ floditChat: true })}>Chat</button>`}
      ${tabs.map(([k, l]) => html`<button key=${k} class=${!chat && tab === k ? "on" : ""} onClick=${() => { setState({ floditChat: false }); setTab?.(k); }}>${l}</button>`)}
      ${note && !chat && html`<span class="itop-note ell">${note}</span>`}
    </nav>
    ${chat ? html`<div class="ibody chat-slot" ref=${slot}></div>` : html`<div class="ibody">${children}</div>`}
  </aside>`;
}

/** Segmented sub-tabs (Basic | Remove BG | Effects). */
function Seg({ items, value, onChange }) {
  return html`<div class="seg-ctl">${items.map(([k, l]) => html`<button key=${k} class=${value === k ? "on" : ""} onClick=${() => onChange(k)}>${l}</button>`)}</div>`;
}

function AnimFields({ anim, onChange, textOnly }) {
  const opts = Object.entries(ANIMATIONS).filter(([, v]) => textOnly || !v.textOnly);
  // New animations start with the length you used last (texts and clips remembered separately).
  const memo = (key) => `${textOnly ? "textAnim" : "clipAnim"}.${key}`;
  const part = (key, label) => html`<div class="anim-row">
    <${Field} label=${label}>
      <select value=${anim[key].type} onChange=${(e) => onChange(key, { type: e.target.value, ...(anim[key].type === "none" ? { dur: lastDur(memo(key), anim[key].dur) } : {}) })}>
        ${opts.map(([k, v]) => html`<option value=${k}>${v.label}</option>`)}
      </select>
    <//>
    <${Slider} label="Duration" value=${anim[key].dur} min=${0.05} max=${3} step=${0.05} format=${secs}
      onChange=${(v) => { onChange(key, { dur: v }); rememberDur(memo(key), v); }} />
  </div>`;
  return html`<div>${part("in", "In animation")}${part("out", "Out animation")}</div>`;
}

function SpeedFields({ speed, ids, kind, id }) {
  const item = useStore((s) => (kind ? findItem(s.project, kind, id) : null));
  const [mode, setMode] = useState(item && hasCurve(item) ? "curve" : "normal");
  const curveTab = kind && html`<div class="itabs two">
    <button class=${mode === "normal" ? "tab on" : "tab"} onClick=${() => setMode("normal")}>Normal speed</button>
    <button class=${mode === "curve" ? "tab on" : "tab"} onClick=${() => setMode("curve")}>〰 Speed curve</button>
  </div>`;
  if (kind && mode === "curve") return html`<div class="speed">${curveTab}<${SpeedCurveEditor} kind=${kind} id=${id} /></div>`;
  return html`<div class="speed">
    ${curveTab}
    ${item && hasCurve(item) && html`<p class="muted">This clip has a speed curve; picking a speed below replaces it.</p>`}
    <${Field} label="Speed">
      <div class="speed-chips">
        ${SPEED_PRESETS.map((v) => html`<button key=${v} class=${Math.abs(speed - v) < 1e-3 ? "chip on" : "chip"}
          onClick=${() => setClipSpeed(v, ids)}>${v}×</button>`)}
      </div>
    <//>
    <${Slider} label="Speed" value=${speed} min=${0.1} max=${10} step=${0.05} format=${(v) => `${+v.toFixed(2)}×`}
      onChange=${(v) => setClipSpeed(v, ids)} />
  </div>`;
}

/** Live-edit helper: one undo step per drag (checkpoint on pointerdown, editLive while moving). */
const liveSet = (kind, id) => (fn, live) => (live ? editLive : edit)((p) => fn(findItem(p, kind, id)));

// ---------------- visual items (main clips + overlay layers) ----------------

/** Position X/Y in pixels from the centre, both keyframed together. */
function PosRow({ kind, id }) {
  const project = useStore((st) => st.project);
  const time = useStore((st) => st.time);
  const item = findItem(project, kind, id);
  const lt = localTime(project, kind, item, time);
  const W = project.width, H = project.height;
  const x = propAt(item, "x", lt, 0.5), y = propAt(item, "y", lt, 0.5);
  const animated = hasKeys(item, "x") || hasKeys(item, "y");
  const here = keyAt(item, "x", lt) || keyAt(item, "y", lt);
  const setPx = (path, px, dim) => { checkpoint(); setAnimatable(kind, id, path, 0.5 + px / dim, true); };
  const toggle = () => {
    for (const k of ["x", "y"]) if (!!keyAt(item, k, lt) === !!here) toggleKeyframe(kind, id, k, 0.5);
  };
  return html`<div class="krow pos">
    <span class="klabel">Position</span>
    <span class="xy"><b>X</b><${NumInput} step=${1} value=${Math.round((x - 0.5) * W)} onCommit=${(v) => setPx("x", v, W)} /></span>
    <span class="xy"><b>Y</b><${NumInput} step=${1} value=${Math.round((y - 0.5) * H)} onCommit=${(v) => setPx("y", v, H)} /></span>
    <span class="kkf"><span class="kn"></span>
      <button class=${"kf" + (here ? " on" : animated ? " has" : "")} title=${here ? "Remove position keyframe" : "Add position keyframe at the playhead"} onClick=${toggle}>◇</button>
      <span class="kn"></span></span>
  </div>`;
}

/** Aligns the item's visible box to the left/centre/right or top/middle/bottom edge of the frame. */
function AlignRow({ kind, id }) {
  const align = (axis, where) => {
    const { project, time } = getState();
    const item = findItem(project, kind, id);
    const b = itemBounds(project, kind, item, project.width, project.height, time);
    if (!b) return;
    const lt = localTime(project, kind, item, time);
    const half = axis === "x" ? b.w / 2 : b.h / 2;
    const c = axis === "x" ? b.cx : b.cy;
    const target = where === 0 ? half : where === 1 ? 0.5 : 1 - half;
    const cur = propAt(item, axis, lt, 0.5);
    checkpoint();
    setAnimatable(kind, id, axis, cur + (target - c), true);
  };
  const btn = (icon, title, axis, where) => html`<button class="ibtn" title=${title} onClick=${() => align(axis, where)}><${Icon} n=${icon} /></button>`;
  return html`<div class="align-row">
    ${btn("align-horizontal-justify-start", "Align left", "x", 0)}
    ${btn("align-horizontal-justify-center", "Centre horizontally", "x", 1)}
    ${btn("align-horizontal-justify-end", "Align right", "x", 2)}
    ${btn("align-vertical-justify-start", "Align top", "y", 0)}
    ${btn("align-vertical-justify-center", "Centre vertically", "y", 1)}
    ${btn("align-vertical-justify-end", "Align bottom", "y", 2)}
  </div>`;
}

/** CapCut-style keyframe button: position, scale, rotation and opacity together, at the playhead. */
function KeyAllButton({ kind, id }) {
  const project = useStore((s) => s.project);
  usePanelTime();
  const item = findItem(project, kind, id);
  if (!item) return null;
  const on = allKeyedHere(project, kind, item);
  return html`<button class=${"keyall" + (on ? " on" : "")} onClick=${() => toggleAllKeyframes(kind, id)}
    title=${on ? "Remove the position, scale, rotation and opacity keyframes at the playhead" : "Add keyframes for position, scale, rotation and opacity at the playhead"}>
    ◆ ${on ? "Keyframed" : "Keyframe all"}</button>`;
}

function TransformSection({ kind, id }) {
  const set = liveSet(kind, id);
  const isText = kind === "text";
  const reset = () => set((s) => {
    if (isText) Object.assign(s, { x: 0.5, y: s.caption ? 0.82 : 0.5, scale: 1, rotation: 0 });
    else s.transform = { x: 0.5, y: 0.5, scale: kind === "overlay" ? 0.45 : 1, rotation: 0 };
    if (s.keyframes) for (const k of ["x", "y", "scale", "rotation"]) delete s.keyframes[k];
  });
  return html`<${Section} title="Transform" right=${html`<span class="row"><${KeyAllButton} kind=${kind} id=${id} />
      <button class="ibtn" title="Reset position, size and rotation" onClick=${reset}><${Icon} n="rotate-ccw" /></button></span>`}>
    <${KSlider} kind=${kind} id=${id} path="scale" label="Scale" min=${0.05} max=${4} fallback=${1} format=${pct} />
    <${PosRow} kind=${kind} id=${id} />
    <${KSlider} kind=${kind} id=${id} path="rotation" label="Rotate" min=${-180} max=${180} step=${1} fallback=${0} format=${deg} />
    <${AlignRow} kind=${kind} id=${id} />
  <//>`;
}

function BlendSection({ kind, item }) {
  const set = liveSet(kind, item.id);
  return html`<${Section} title="Blend">
    <${KSlider} kind=${kind} id=${item.id} path="opacity" label="Opacity" min=${0} max=${1} fallback=${1} format=${pct} />
    <div class="krow">
      <span class="klabel">Mode</span>
      <select class="kwide" value=${item.blend || "normal"} onChange=${(e) => set((s) => (s.blend = e.target.value === "normal" ? undefined : e.target.value))}>
        ${Object.entries(BLEND_MODES).map(([k, [l]]) => html`<option value=${k}>${l}</option>`)}
      </select>
    </div>
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
  return html`<${Section} title="Crop & flip" open=${!!(item.flipH || item.flipV || item.crop)}>
    <div class="grid2">
      <button class=${item.flipH ? "chip on" : "chip"} onClick=${() => set((s) => (s.flipH = !s.flipH))}><${Icon} n="flip-horizontal-2" /> Flip horizontal</button>
      <button class=${item.flipV ? "chip on" : "chip"} onClick=${() => set((s) => (s.flipV = !s.flipV))}><${Icon} n="flip-vertical-2" /> Flip vertical</button>
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
    <${Slider} label="Source start" value=${item.in || 0} min=${0} max=${Math.max(0, (media?.kind === "image" ? 60 : media.duration) - 0.1)}
      format=${secs} onChange=${(v, live) => set((s) => { s.in = v; s.dur = Math.min(s.dur, (maxSrc - s.in) / speed); }, live)} />
    <${Slider} label="Duration" value=${item.dur} min=${0.2} max=${media?.kind === "image" ? 30 : (media.duration - (item.in || 0)) / speed}
      format=${secs} onChange=${(v, live) => set((s) => (s.dur = v), live)} />
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
      <${KSlider} kind=${kind} id=${item.id} path="volume" label="Volume" min=${0} max=${10} fallback=${au.volume ?? 1} format=${db} />
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
    <${Section} title="Audio presets">
      <${AudioPresetPicker} />
      <${SavePreset} label="Save audio preset" hint="Save volume, fades, cleanup and voice effect"
        save=${(name) => saveAudioPreset(findItem(getState().project, kind, item.id), name)} />
    <//>
  </div>`;
}

function AudioPresetPicker() {
  const list = (useStore((s) => s.textPresets) || []).filter((p) => p.kind === "audio");
  if (!list.length) return null;
  return html`<select class="wide-select" value="" onChange=${(e) => { const p = list.find((x) => x.id === e.target.value); if (p) applyAudioPreset(p); }}>
    <option value="">Apply a saved audio preset…</option>
    ${list.map((p) => html`<option value=${p.id}>${p.name}</option>`)}
  </select>`;
}

/** One-click smoothing: every keyframe eases in and out, and new keyframes do so by default. */
function SmoothControls({ kind, item }) {
  const smoothNew = useStore((s) => s.keySmooth) ?? defaultEase() !== "linear";
  const count = Object.values(item.keyframes || {}).reduce((a, ks) => a + ks.length, 0);
  const allSmooth = count > 0 && Object.values(item.keyframes).every((ks) => ks.every((k) => k.ease === "easeInOut"));
  return html`<div class="smoothbox">
    <button class=${allSmooth ? "wide chip on" : "wide primary"} disabled=${count < 2}
      title="Every move starts and ends gently, like real motion"
      onClick=${() => edit((p) => { const it = findItem(p, kind, item.id); for (const ks of Object.values(it.keyframes || {})) ks.forEach((k) => (k.ease = "easeInOut")); })}>
      ${allSmooth ? "✓ All motion is smooth" : "〰 Make all motion smooth (ease in & out)"}
    </button>
    <label class="check"><input type="checkbox" checked=${smoothNew}
      onChange=${(e) => { setDefaultEase(e.target.checked ? "easeInOut" : "linear"); setState({ keySmooth: e.target.checked }); }} />
      New keyframes start and end smoothly</label>
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
      <${SmoothControls} kind=${kind} item=${item} />
      <${CurveEditor} kind=${kind} id=${item.id} />
    <//>
  </div>`;
}

function VisualInspector({ kind, item, project }) {
  const [tab, setTab] = useState("video");
  const [sub, setSub] = useState("basic");
  const media = project.media[item.mediaId];
  const hasSound = media?.kind === "video";
  const tabs = [["video", "Video"], ...(hasSound ? [["audio", "Audio"]] : []), ["speed", "Speed"], ["animation", "Animation"], ["adjust", "Adjust"]];
  const t = tabs.some(([k]) => k === tab) ? tab : "video";
  return html`<${Shell} tabs=${tabs} tab=${t} setTab=${setTab} note=${media?.name}>
    ${t === "video" && html`
      <${Seg} items=${[["basic", "Basic"], ["removebg", "Remove BG"], ["mask", "Mask"], ["effects", "Effects"]]} value=${sub} onChange=${setSub} />
      ${sub === "basic" && html`
        <${TransformSection} kind=${kind} id=${item.id} />
        <${BlendSection} kind=${kind} item=${item} />
        <${LookSection} kind=${kind} item=${item} />
        <${SourceSection} kind=${kind} item=${item} media=${media} />
        <div class="action-row">
          ${media?.kind === "video" && html`<button onClick=${() => freezeFrame()} title="Hold the frame under the playhead for 3 seconds (F)"><${Icon} n="snowflake" /> Freeze</button>`}
          ${kind === "main" && html`<button onClick=${mergeClips} title="Select neighbouring pieces of one clip, then merge"><${Icon} n="combine" /> Merge</button>`}
          <button onClick=${mirrorSelection} title="Mirror left-right"><${Icon} n="flip-horizontal-2" /> Mirror</button>
          <button onClick=${startCrop} title="Crop: drag the box in the player (Enter when done)"><${Icon} n="crop" /> Crop</button>
          <button onClick=${copySettings} title="Copy this clip's settings (Ctrl+Alt+C)"><${Icon} n="clipboard-copy" /> Copy settings</button>
          <button onClick=${pasteSettings} title="Paste copied settings onto the selected clips (Ctrl+Alt+V)"><${Icon} n="clipboard-paste" /> Paste settings</button>
          ${media?.kind !== "compound" && html`<button onClick=${() => saveElement(kind, item.id)} title="Save this clip with all its settings (key, cutout, effects, size…) to the Elements tab"><${Icon} n="bookmark-plus" /> Save as element</button>`}
          ${kind === "overlay" && html`<button onClick=${rippleDelete} title="Delete and close the gap (Shift+Delete)"><${Icon} n="between-horizontal-start" /> Ripple delete</button>`}
          <button class="danger" onClick=${deleteSelection}><${Icon} n="trash-2" /> Delete</button>
        </div>`}
      ${sub === "removebg" && html`<${CutoutSection} kind=${kind} item=${item} />`}
      ${sub === "mask" && html`<${MaskSection} kind=${kind} item=${item} />`}
      ${sub === "effects" && html`<${EffectsSection} kind=${kind} item=${item} />`}`}
    ${t === "audio" && html`<${AudioSection} kind=${kind} item=${item} media=${media} />`}
    ${t === "speed" && html`<${SpeedFields} speed=${clipSpeed(item)} ids=${[item.id]} kind=${kind} id=${item.id} />`}
    ${t === "animation" && html`<${AnimateSection} kind=${kind} item=${item} />`}
    ${t === "adjust" && html`
      <${Section} title="Adjustment presets">
        <${PresetButtons} kind="adjust" onUse=${(p) => applyAdjustPreset(p, [{ kind, id: item.id }])}
          empty="No adjustment presets yet. Set a filter, colour or effects and save them here." />
        <${SavePresetButton} label="Save as adjustment preset" onSave=${(name) => saveClipLookPreset(findItem(getState().project, kind, item.id), name)} />
      <//>
      <${FilterSection} kind=${kind} item=${item} /><${AdjustSection} kind=${kind} item=${item} />`}
  <//>`;
}

// ---------------- text ----------------

/** Media in the library that can be a text's sound (audio files, and videos for their sound). */
const soundChoices = (media) => Object.values(media).filter((m) => !m.missing && (m.kind === "audio" || m.kind === "video"))
  .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "audio" ? -1 : 1));

/** A sound that plays with the text: picked from the library, timed to the text's animation. */
function TextSoundSection({ t }) {
  const media = useStore((s) => s.project.media);
  const set = liveSet("text", t.id);
  const snd = t.sound;
  const choices = soundChoices(media);
  const setSnd = (k, v, live) => set((x) => (x.sound = { ...x.sound, [k]: v }), live);
  const preview = () => {
    const m = media[snd?.mediaId];
    if (!m) return;
    const a = new Audio(m.url); a.volume = Math.min(1, snd.volume ?? 1); a.currentTime = snd.in || 0; a.play().catch(() => {});
    setTimeout(() => a.pause(), 4000);
  };
  return html`<${Section} title=${snd ? "Sound 🔊" : "Sound"} open=${!!snd}>
    <div class="row">
      <select class="kwide-sel" value=${snd?.mediaId || ""} onChange=${(e) => setTextSound(e.target.value || null, [t.id])}>
        <option value="">${choices.length ? "No sound" : "Import a sound into the library first"}</option>
        ${choices.map((m) => html`<option value=${m.id}>${m.kind === "audio" ? "♪" : "🎞"} ${m.name}</option>`)}
      </select>
      ${snd && html`<button class="ibtn" title="Listen" onClick=${preview}><${Icon} n="play" /></button>`}
    </div>
    ${!snd && html`<p class="muted">Tip: you can also drag a sound from the library onto a text on the timeline, or right-click a text › Add sound.</p>`}
    ${snd && html`
      <div class="seg-ctl">
        ${[["anim", "After animation"], ["start", "When it appears"], ["custom", "Custom delay"]].map(([k, l]) => html`<button key=${k}
          class=${(snd.when || "anim") === k ? "on" : ""} onClick=${() => setSnd("when", k)}>${l}</button>`)}
      </div>
      ${(snd.when || "anim") === "anim" && html`<p class="muted">Plays as the text's in-animation finishes (${((t.anim?.in?.type !== "none" ? t.anim?.in?.dur || 0 : 0) * 0.85).toFixed(2)}s after it appears).</p>`}
      ${snd.when === "custom" && html`<${Slider} label="Delay after the text appears" value=${snd.delay || 0} min=${0} max=${Math.max(1, t.dur)} step=${0.01}
        format=${(v) => v.toFixed(2) + "s"} onChange=${(v, live) => setSnd("delay", v, live)} />`}
      <${Slider} label="Volume" value=${snd.volume ?? 1} min=${0} max=${10} format=${db} onChange=${(v, live) => setSnd("volume", v, live)} />
      <div class="grid2">
        <button onClick=${() => soundToAll(t.id, false)} title="Same sound, timing and volume on every text">Use on all texts</button>
        ${t.caption ? html`<button onClick=${() => soundToAll(t.id, true)}>Use on all captions</button>`
          : html`<button class="danger" onClick=${() => setTextSound(null, [t.id])}>Remove sound</button>`}
      </div>`}
  <//>`;
}

/** One line vs wrapping inside the text box (whose width the side handles in the preview change). */
function LineBreaks({ t }) {
  const set = (fn) => edit((p) => { const x = p.texts.find((y) => y.id === t.id); if (x) fn(x); });
  const mode = t.oneLine ? "one" : "wrap";
  return html`<div class="linebreaks">
    <div class="seg-ctl">
      <button class=${mode === "one" ? "on" : ""} title="Keep the text on one straight line (Enter still starts a new line)"
        onClick=${() => set((x) => { x.oneLine = true; delete x.boxW; })}>One line</button>
      <button class=${mode === "wrap" ? "on" : ""} title="Break into lines to fit the text box"
        onClick=${() => set((x) => { delete x.oneLine; })}>Wrap to box</button>
    </div>
    <p class="muted">${mode === "one" ? "Stays on one line. Drag a corner in the preview to resize it." : "Drag the side handles in the preview to make the box wider (fewer lines) or narrower."}</p>
  </div>`;
}

/** Font, size, weight, case, alignment and spacing. `setSt(key, value, live)` decides which texts change. */
function TextFontFields({ st, setSt }) {
  const installed = useStore((s) => s.systemFonts);
  const recent = useStore((s) => s.recentFonts) || [];
  const known = FONTS.some((f) => f.css === st.font) || (installed || []).some((f) => familyCss(f) === st.font);
  return html`<div>
    <div class="bius">
      <button class=${(st.weight ?? 400) >= 700 ? "chip on" : "chip"} title="Bold"
        onClick=${() => { const w = (st.weight ?? 400) >= 700 ? 400 : 800; loadFont(st.font, w); setSt("weight", w); }}><b>B</b></button>
      <button class=${st.italic ? "chip on" : "chip"} title="Italic" onClick=${() => setSt("italic", !st.italic || undefined)}><i>I</i></button>
      <button class=${st.underline ? "chip on" : "chip"} title="Underline" onClick=${() => setSt("underline", !st.underline || undefined)}><u>U</u></button>
      <button class=${st.uppercase ? "chip on" : "chip"} title="All capitals" onClick=${() => setSt("uppercase", !st.uppercase || undefined)}>AA</button>
    </div>
    <div class="grid2">
      <${Field} label="Size"><${NumInput} min=${4} max=${1000} step=${1} value=${st.size} onCommit=${(v) => setSt("size", v)} /><//>
      <${Field} label="Weight">
        <select value=${st.weight} onChange=${(e) => setSt("weight", +e.target.value)}>
          ${[300, 400, 500, 600, 700, 800, 900].map((w) => html`<option value=${w}>${w}</option>`)}
        </select>
      <//>
    </div>
    <${Field} label="Font">
      <select value=${st.font} onChange=${(e) => { loadFont(e.target.value, st.weight); rememberFont(e.target.value); setSt("font", e.target.value); }}>
        ${!known && html`<option value=${st.font}>${st.font.split(",")[0].replace(/'/g, "")} (not on this computer)</option>`}
        ${recent.length > 0 && html`<optgroup label="Recently used">
          ${recent.map((css) => html`<option key=${"r" + css} value=${css} style=${{ fontFamily: css }}>${fontName(css)}</option>`)}
        </optgroup>`}
        <optgroup label="Cutline fonts">
          ${FONTS.map((f) => html`<option value=${f.css} style=${{ fontFamily: f.css }}>${f.name}</option>`)}
        </optgroup>
        ${installed?.length > 0 && html`<optgroup label=${`Installed on this computer (${installed.length})`}>
          ${installed.map((f) => html`<option value=${familyCss(f)} style=${{ fontFamily: familyCss(f) }}>${f}</option>`)}
        </optgroup>`}
      </select>
    <//>
    ${!installed && canListSystemFonts() && html`<button class="mini" style=${{ marginBottom: "6px" }} onClick=${loadSystemFonts}
      title="Adds every font installed on this computer to the list">＋ Show fonts installed on this computer</button>`}
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
const alphaOf = (c) => parseInt((c || "").slice(7) || "ff", 16) / 255;
const withAlpha = (c, a) => c.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");

function TextLookFields({ st, setSt }) {
  const shadow = st.shadow;
  return html`<div>
    <div class="grid2">
      <${Field} label="Colour"><input type="color" value=${st.color} onChange=${(e) => setSt("color", e.target.value)} /><//>
      <${Field} label="Highlight"><input type="color" value=${st.highlight} onChange=${(e) => setSt("highlight", e.target.value)} /><//>
      <${Field} label="Outline"><input type="color" value=${(st.stroke || "#000000").slice(0, 7)} onChange=${(e) => setSt("stroke", e.target.value + (st.stroke || "").slice(7))} /><//>
      <${Field} label="Outline width"><${NumInput} min=${0} max=${60} step=${1} value=${st.strokeWidth} onCommit=${(v) => setSt("strokeWidth", v)} /><//>
    </div>
    ${st.strokeWidth > 0 && html`<${Slider} label="Outline opacity" value=${alphaOf(st.stroke)} min=${0} max=${1} format=${pct}
      onChange=${(v, live) => setSt("stroke", withAlpha(st.stroke || "#000000", v), live)} />`}
    <${Section} title="Shadow" open=${!!shadow}>
      <label class="check"><input type="checkbox" checked=${!!shadow}
        onChange=${(e) => setSt("shadow", e.target.checked ? { color: "#000000aa", blur: 10, x: 4, y: 6 } : undefined)} /> Drop shadow</label>
      ${shadow && html`
        <${Field} label="Colour"><input type="color" value=${(shadow.color || "#000000").slice(0, 7)} onChange=${(e) => setSt("shadow", { ...shadow, color: e.target.value + (shadow.color?.slice(7) || "aa") })} /><//>
        <${Slider} label="Shadow opacity" value=${alphaOf(shadow.color || "#000000aa")} min=${0} max=${1} format=${pct}
          onChange=${(v, live) => setSt("shadow", { ...shadow, color: withAlpha(shadow.color || "#000000", v) }, live)} />
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

function ShapeInspector({ t }) {
  const [tab, setTab] = useState("shape");
  return html`<${Shell} tabs=${[["shape", shapeName(t.shape.type)], ["animate", "Animation"]]} tab=${tab} setTab=${setTab}>
    ${tab === "shape" && html`<${ShapeFields} t=${t} /><${TransformSection} kind="text" id=${t.id} />`}
    ${tab === "animate" && html`<${AnimateSection} kind="text" item=${t} />`}
    <${SettingsCopyBar} />
    <button class="danger wide" onClick=${deleteSelection}><${Icon} n="trash-2" /> Delete</button>
  <//>`;
}

/** Copy this item's settings / paste copied settings onto the selection. */
export function SettingsCopyBar() {
  const has = useStore((s) => !!s.settingsClip);
  return html`<div class="copybar">
    <button onClick=${copySettings} title="Copy all settings (style, font, animation, position, effects…) — Ctrl+Alt+C"><${Icon} n="clipboard-copy" /> Copy settings</button>
    <button onClick=${pasteSettings} disabled=${!has} title="Paste the copied settings onto every selected item — Ctrl+Alt+V"><${Icon} n="clipboard-paste" /> Paste settings</button>
  </div>`;
}

/** "Remember text settings": new texts start with the look of the text you last styled. */
function RememberText({ t }) {
  const on = useStore((s) => s.rememberText);
  useEffect(() => {
    if (!on || t.caption) return;
    try { localStorage.setItem("cutline.lastTextLook", JSON.stringify({ style: t.style, anim: t.anim, scale: t.scale, oneLine: t.oneLine, boxW: t.boxW })); } catch { /* ignore */ }
  }, [on, t.style, t.anim, t.scale, t.oneLine, t.boxW]);
  return html`<label class="check remember" title="New texts start with this text's font, size, colours, outline, shadow, background and animation">
    <input type="checkbox" checked=${!!on} onChange=${(e) => { setState({ rememberText: e.target.checked }); try { localStorage.setItem("cutline.rememberText", e.target.checked ? "1" : ""); } catch {} }} />
    Remember these settings for new texts</label>`;
}

function TextInspector({ t }) {
  if (t.shape) return html`<${ShapeInspector} t=${t} />`;
  return html`<${TextInspectorBody} t=${t} />`;
}

function TextInspectorBody({ t }) {
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
  return html`<${Shell} tabs=${[["text", t.caption ? "Caption" : "Text"], ["style", "Style"], ["animate", "Animation"]]} tab=${tab} setTab=${setTab}>
    ${linkBox}
    <${SettingsCopyBar} />
    <${SavePreset} t=${t} />
    <${RememberText} t=${t} />
    ${tab === "text" && html`
      <textarea rows="3" value=${t.text} onChange=${(e) => set((x) => { x.text = e.target.value; delete x.words; })} />
      ${t.caption && t.words && html`<p class="muted">Editing the text removes word-by-word highlighting for this caption.</p>`}
      <${LineBreaks} t=${t} />
      <${TextFontFields} st=${st} setSt=${setSt} />
      <${TextSoundSection} t=${t} />
      <${TransformSection} kind="text" id=${t.id} />
      <${Section} title="Opacity">
        <${KSlider} kind="text" id=${t.id} path="opacity" label="Opacity" min=${0} max=${1} fallback=${1} format=${pct} />
      <//>`}
    ${tab === "style" && html`
      <${TextLookFields} st=${st} setSt=${setSt} />
      ${t.caption && html`<button class="wide" onClick=${applyAll} title="Copies this caption's whole style, position and animation to every caption">Copy this whole look to all captions</button>`}`}
    ${tab === "animate" && html`<${AnimateSection} kind="text" item=${t} textOnly
      onAnim=${allCaptions ? setAnimOn(new Set(getState().project.texts.filter((x) => x.caption).map((x) => x.id))) : undefined}
      note=${allCaptions && html`<p class="muted">Changes apply to all ${captionCount} captions.</p>`} />`}
    <button class="danger wide" onClick=${deleteSelection}><${Icon} n="trash-2" /> Delete</button>
  <//>`;
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
  const [tab, setTab] = useState("audio");
  return html`<${Shell} tabs=${[["audio", "Audio"], ["speed", "Speed"]]} tab=${tab} setTab=${setTab} note=${media?.name}>
    ${tab === "audio" && html`
      <${AudioSection} kind="audio" item=${item} media=${media} />
      <${Section} title="Volume keyframe curves" open=${false}><${CurveEditor} kind="audio" id=${item.id} /><//>`}
    ${tab === "speed" && html`<${SpeedFields} speed=${clipSpeed(item)} ids=${[item.id]} kind="audio" id=${item.id} />`}
    <div class="action-row">
      <button onClick=${rippleDelete} title="Delete and close the gap (Shift+Delete)"><${Icon} n="between-horizontal-start" /> Ripple delete</button>
      <button class="danger" onClick=${deleteSelection}><${Icon} n="trash-2" /> Delete</button>
    </div>
  <//>`;
}

function EffectInspector({ item }) {
  const [tab, setTab] = useState("effects");
  const set = liveSet("effect", item.id);
  return html`<${Shell} tabs=${[["effects", "Effects"], ["color", "Adjust"], ["animate", "Curves"]]} tab=${tab} setTab=${setTab}>
    <${Field} label="Name"><input value=${item.name || ""} onChange=${(e) => set((x) => (x.name = e.target.value))} /><//>
    <p class="muted">Applies to every clip and layer under it, for as long as it lasts on the timeline.</p>
    <${KSlider} kind="effect" id=${item.id} path="opacity" label="Mix" min=${0} max=${1} fallback=${1} format=${pct} />
    <${SavePreset} label="Save as preset" hint="Save this layer's effects, filter, colour, mix and length (Adjustment tab › My adjustment presets)"
      save=${(name) => saveAdjustPreset(findItem(getState().project, "effect", item.id), name)} />
    ${tab === "effects" && html`<${EffectsSection} kind="effect" item=${item} />`}
    ${tab === "color" && html`<${FilterSection} kind="effect" item=${item} /><${AdjustSection} kind="effect" item=${item} />`}
    ${tab === "animate" && html`<${CurveEditor} kind="effect" id=${item.id} />`}
    <button class="danger wide" onClick=${deleteSelection}><${Icon} n="trash-2" /> Delete</button>
  <//>`;
}

// ---------------- entry ----------------

export function Inspector() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);

  if (selection.length > 1) {
    const textSel = selection.filter((s) => s.kind === "text").map((s) => project.texts.find((x) => x.id === s.id)).filter(Boolean);
    if (selection.some((s) => ["main", "overlay", "audio"].includes(s.kind))) {
      const textPanel = textSel.length > 0 && html`<${MultiTextFields} key=${textSel.map((x) => x.id).join()} texts=${textSel} />`;
      return html`<${MultiClipInspector} selection=${selection} project=${project} textPanel=${textPanel} Shell=${Shell} />`;
    }
    const clipIds = selection.filter((s) => s.kind === "main" || s.kind === "overlay").map((s) => s.id);
    const first = clipIds.map((id) => project.main.find((s) => s.id === id) || project.overlays.find((s) => s.id === id)).find(Boolean);
    const texts = selection.filter((s) => s.kind === "text").map((s) => project.texts.find((x) => x.id === s.id)).filter(Boolean);
    return html`<${Shell} tabs=${[["sel", `${selection.length} selected`]]} tab="sel">
      <${SettingsCopyBar} />
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
    <//>`;
  }
  const sel = selection[0];
  const item = sel && findItem(project, sel.kind, sel.id);

  if ((sel?.kind === "main" || sel?.kind === "overlay") && item) return html`<${VisualInspector} key=${item.id} kind=${sel.kind} item=${item} project=${project} />`;

  if (sel?.kind === "transition") {
    const seg = project.main.find((s) => s.id === sel.id);
    if (!seg?.transition) return html`<${Shell} tabs=${[["t", "Transition"]]} tab="t" />`;
    const set = (fn) => edit((p) => fn(p.main.find((s) => s.id === seg.id).transition));
    return html`<${Shell} tabs=${[["t", "Transition"]]} tab="t">
      <div class="grid2">
        ${Object.entries(TRANSITIONS).map(([k, label]) => html`<button key=${k}
          class=${seg.transition.type === k ? "chip on" : "chip"} onClick=${() => set((t) => (t.type = k))}>${label}</button>`)}
      </div>
      <${Slider} label="Duration" value=${seg.transition.dur} min=${0.1} max=${3} step=${0.05} format=${secs}
        onChange=${(v) => { set((t) => (t.dur = v)); rememberDur("transition", v); }} />
      <button class="danger wide" onClick=${deleteSelection}>Remove transition</button>
    <//>`;
  }

  if (sel?.kind === "text" && item) return html`<${TextInspector} key=${item.id} t=${item} />`;
  if (sel?.kind === "audio" && item) return html`<${AudioInspector} key=${item.id} item=${item} project=${project} />`;
  if (sel?.kind === "effect" && item) return html`<${EffectInspector} key=${item.id} item=${item} />`;

  const ratio = (w, h) => edit((p) => Object.assign(p, { width: w, height: h }));
  return html`<${Shell} tabs=${[["p", "Project"]]} tab="p">
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
  <//>`;
}
