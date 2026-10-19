// Inspector for several selected clips at once: Audio, Adjust, Speed (and Text when texts are selected).
// Every control changes all the selected items in one undo step; presets apply to all of them too.
import { useState } from "react";
import { useStore, edit, editLive, findItem, getState } from "../store.js";
import { clipSpeed } from "../engine.js";
import { deleteSelection, pasteSettings, copySelection, duplicateSelection, mergeClips, setClipSpeed, SPEED_PRESETS } from "../actions.js";
import { ADJUST, FILTERS, EFFECTS, EFFECT_CATEGORIES } from "../fx.js";
import { VOICE_EFFECTS } from "../audiofx.js";
import { uid } from "../store.js";
import { applyAudioPreset, applyAdjustPreset, saveAudioPreset, saveClipLookPreset } from "../presets.js";
import { html, Field, Section, Slider, Icon, db } from "./kit.js";

const pct = (v) => `${Math.round(v * 100)}%`;
const deg = (v) => `${Math.round(v)}°`;
const signed = (v) => (v > 0 ? "+" : "") + (Math.abs(v) < 0.005 ? "0" : v.toFixed(2));
let lastTab = "audio"; // remembered between selections

/** Runs `fn(item)` on every target (one undo step; `live` = while dragging, after a checkpoint). */
const editAll = (targets, fn, live) => (live ? editLive : edit)((p) => {
  for (const t of targets) { const it = findItem(p, t.kind, t.id); if (it) fn(it); }
});

/** The value shared by all items, or the first one's; `mixed` when they differ. */
function shared(items, get) {
  const vals = items.map(get);
  return { value: vals[0], mixed: vals.some((v) => JSON.stringify(v) !== JSON.stringify(vals[0])) };
}

const Mixed = ({ on, what }) => on && html`<p class="muted">They have different ${what}; changing it sets all of them to the same value.</p>`;

export function SavePresetButton({ label, onSave }) {
  const [naming, setNaming] = useState(false);
  if (!naming) return html`<button class="wide save-preset" onClick=${() => setNaming(true)}><i class="ico icon-bookmark-plus" /> ${label}</button>`;
  const save = (name) => { onSave(name); setNaming(false); };
  return html`<div class="preset-name">
    <input autoFocus placeholder="Preset name" onKeyDown=${(e) => { if (e.key === "Enter") save(e.target.value); if (e.key === "Escape") setNaming(false); }} />
    <button class="primary" onClick=${(e) => save(e.target.previousElementSibling.value)}>Save</button>
    <button onClick=${() => setNaming(false)}>Cancel</button>
  </div>`;
}

/** Saved presets of one kind as one-click buttons that apply to every selected item. */
export function PresetButtons({ kind, onUse, empty }) {
  const list = (useStore((s) => s.textPresets) || []).filter((p) => p.kind === kind);
  if (!list.length) return html`<p class="muted">${empty}</p>`;
  return html`<div class="filter-grid">${list.map((p) => html`<button key=${p.id} class="chip" title="Apply to all selected" onClick=${() => onUse(p)}>${p.name}</button>`)}</div>`;
}

// ---------------- audio ----------------

function MultiAudio({ targets, items }) {
  const vol = (it) => it.audio?.volume ?? 1;
  const v = shared(items, vol);
  const au = (k) => shared(items, (it) => it.audio?.[k]);
  const setAu = (k, val, live) => editAll(targets, (it) => (it.audio = { ...(it.audio || {}), [k]: val }), live);
  const setVolume = (x, live) => editAll(targets, (it) => {
    it.audio = { ...(it.audio || {}), volume: x };
    if (it.keyframes?.volume) delete it.keyframes.volume;
  }, live);
  // Louder / quieter by the same amount: each keeps its own level relative to the others.
  const nudge = (dbs) => editAll(targets, (it) => {
    const f = Math.pow(10, dbs / 20);
    it.audio = { ...(it.audio || {}), volume: Math.max(0, Math.min(10, vol(it) * f)) };
    for (const k of it.keyframes?.volume || []) k.v = Math.max(0, Math.min(10, k.v * f));
  });
  const allMuted = items.every((it) => it.mute);
  const fadeMax = Math.min(10, Math.min(...items.map((it) => it.dur)) / 2);
  const setFade = (k, x, live) => editAll(targets, (it) => (it.audio = { ...(it.audio || {}), [k]: Math.min(x, it.dur / 2) }), live);
  const check = (k, label) => html`<label class="check"><input type="checkbox" checked=${items.every((it) => it.audio?.[k])}
    onChange=${(e) => setAu(k, e.target.checked || undefined)} /> ${label}</label>`;
  const voice = au("voice");
  return html`<div>
    <${Section} title=${`Volume — ${items.length} clips`}>
      <label class="check"><input type="checkbox" checked=${allMuted} onChange=${(e) => editAll(targets, (it) => (it.mute = e.target.checked || undefined))} /> Mute all</label>
      <${Slider} label="Volume" value=${v.value} min=${0} max=${10} format=${db} onChange=${setVolume} />
      <${Mixed} on=${v.mixed} what="volumes" />
      <div class="speed-chips" title="Each clip gets louder or quieter by the same amount, keeping their balance">
        ${[-20, -10, -6, -3, -1, 1, 3, 6, 10, 20].map((d) => html`<button key=${d} class="chip" onClick=${() => nudge(d)}>${d > 0 ? "+" : ""}${d} dB</button>`)}
      </div>
      <${Slider} label="Fade in" value=${au("fadeIn").value || 0} min=${0} max=${fadeMax} step=${0.05} format=${(x) => x.toFixed(2) + "s"} onChange=${(x, l) => setFade("fadeIn", x, l)} />
      <${Slider} label="Fade out" value=${au("fadeOut").value || 0} min=${0} max=${fadeMax} step=${0.05} format=${(x) => x.toFixed(2) + "s"} onChange=${(x, l) => setFade("fadeOut", x, l)} />
    <//>
    <${Section} title="Voice cleanup">
      ${check("denoise", "Reduce noise")}${check("enhance", "Enhance voice")}${check("normalize", "Level loudness")}
    <//>
    <${Section} title="Voice effect">
      <div class="filter-grid">
        ${Object.entries(VOICE_EFFECTS).map(([k, l]) => html`<button key=${k} class=${!voice.mixed && (voice.value || "none") === k ? "chip on" : "chip"}
          onClick=${() => setAu("voice", k === "none" ? undefined : k)}>${l}</button>`)}
      </div>
    <//>
    <${Section} title="Audio presets">
      <${PresetButtons} kind="audio" onUse=${applyAudioPreset} empty="No audio presets yet. Set the sound here, then save it as a preset." />
      <${SavePresetButton} label="Save audio preset" onSave=${(name) => saveAudioPreset(findItem(getState().project, targets[0].kind, targets[0].id), name)} />
    <//>
  </div>`;
}

// ---------------- adjust (filter, colour, effects) ----------------

function MultiAdjust({ targets, items }) {
  const f = shared(items, (it) => it.filter?.type || null);
  const setAdj = (k, x, live) => editAll(targets, (it) => {
    it.adjust = { ...(it.adjust || {}), [k]: x };
    if (it.keyframes) delete it.keyframes["adjust." + k];
  }, live);
  const anyAdjust = items.some((it) => it.adjust && Object.values(it.adjust).some((x) => x));
  const anyFx = items.some((it) => it.fx?.length);
  return html`<div>
    <${Section} title="Adjustment presets">
      <${PresetButtons} kind="adjust" onUse=${(p) => applyAdjustPreset(p, targets)}
        empty="No adjustment presets yet. Set a filter, colour or effects here (or on an adjustment layer) and save it as a preset." />
      <${SavePresetButton} label="Save as adjustment preset" onSave=${(name) => saveClipLookPreset(findItem(getState().project, targets[0].kind, targets[0].id), name)} />
    <//>
    <${Section} title="Filter">
      <div class="filter-grid">
        <button class=${!f.mixed && !f.value ? "chip on" : "chip"} onClick=${() => editAll(targets, (it) => (it.filter = null))}>None</button>
        ${Object.entries(FILTERS).map(([k, x]) => html`<button key=${k} class=${!f.mixed && f.value === k ? "chip on" : "chip"}
          onClick=${() => editAll(targets, (it) => (it.filter = { type: k, amount: it.filter?.amount ?? 1 }))}>${x.label}</button>`)}
      </div>
      ${f.value && html`<${Slider} label="Strength" value=${items[0].filter?.amount ?? 1} min=${0} max=${1} format=${pct}
        onChange=${(x, live) => editAll(targets, (it) => it.filter && (it.filter = { ...it.filter, amount: x }), live)} />`}
    <//>
    <${Section} title="Adjust" right=${anyAdjust && html`<button class="mini" onClick=${() => editAll(targets, (it) => {
        delete it.adjust;
        if (it.keyframes) for (const k of Object.keys(it.keyframes)) if (k.startsWith("adjust.")) delete it.keyframes[k];
      })}>Reset all</button>`}>
      ${Object.entries(ADJUST).map(([k, a]) => {
        const s = shared(items, (it) => it.adjust?.[k] || 0);
        return html`<div key=${k}><${Slider} label=${a.label + (s.mixed ? " *" : "")} value=${s.value} min=${a.min} max=${a.max} step=${a.step || 0.01}
          format=${k === "hue" ? deg : signed} onChange=${(x, live) => setAdj(k, x, live)} /></div>`;
      })}
      ${Object.keys(ADJUST).some((k) => shared(items, (it) => it.adjust?.[k] || 0).mixed) && html`<p class="muted">* differs between the clips; moving it sets all to the same value.</p>`}
    <//>
    <${Section} title="Effects">
      <${Field} label="Add an effect to all">
        <select value="" onChange=${(e) => { const type = e.target.value; if (type) editAll(targets, (it) => (it.fx = [...(it.fx || []), { id: uid(), type, amount: 0.7 }])); }}>
          <option value="">Choose…</option>
          ${EFFECT_CATEGORIES.map((cat, ci) => html`<optgroup label=${cat}>
            ${Object.entries(EFFECTS).filter(([, d]) => d.cat === ci).map(([k, d]) => html`<option value=${k}>${d.label}</option>`)}
          </optgroup>`)}
        </select>
      <//>
      ${anyFx && html`<button class="wide" onClick=${() => editAll(targets, (it) => {
        it.fx = [];
        if (it.keyframes) for (const k of Object.keys(it.keyframes)) if (k.startsWith("fx.")) delete it.keyframes[k];
      })}>Remove all effects from these clips</button>`}
    <//>
  </div>`;
}

// ---------------- speed ----------------

function MultiSpeed({ targets, items }) {
  const s = shared(items, clipSpeed);
  const ids = targets.map((t) => t.id);
  return html`<div class="speed">
    <${Field} label="Speed for all">
      <div class="speed-chips">
        ${SPEED_PRESETS.map((x) => html`<button key=${x} class=${!s.mixed && Math.abs(s.value - x) < 1e-3 ? "chip on" : "chip"} onClick=${() => setClipSpeed(x, ids)}>${x}×</button>`)}
      </div>
    <//>
    <${Slider} label="Speed" value=${s.value} min=${0.1} max=${10} step=${0.05} format=${(x) => `${+x.toFixed(2)}×`} onChange=${(x) => setClipSpeed(x, ids)} />
    <${Mixed} on=${s.mixed} what="speeds" />
    ${items.some((it) => it.speedCurve) && html`<p class="muted">Some have speed curves; picking a speed replaces them.</p>`}
  </div>`;
}

// ---------------- entry ----------------

export function MultiClipInspector({ selection, project, textPanel, Shell }) {
  const [tab, setTabState] = useState(lastTab);
  const setTab = (t) => { lastTab = t; setTabState(t); };
  const pick = (kinds) => selection.filter((s) => kinds.includes(s.kind)).map((s) => ({ ...s, item: findItem(project, s.kind, s.id) })).filter((s) => s.item);
  const clips = pick(["main", "overlay", "audio"]);
  const visual = clips.filter((c) => c.kind !== "audio");
  const sound = clips.filter((c) => c.kind === "audio" || ["video", "compound"].includes(project.media[c.item.mediaId]?.kind));
  const tabs = [
    ...(sound.length ? [["audio", "Audio"]] : []),
    ...(visual.length ? [["adjust", "Adjust"]] : []),
    ...(clips.length ? [["speed", "Speed"]] : []),
    ...(textPanel ? [["text", "Text"]] : []),
    ["edit", "Edit"],
  ];
  const t = tabs.some(([k]) => k === tab) ? tab : tabs[0][0];
  const strip = (list) => list.map(({ kind, id }) => ({ kind, id }));
  const key = (list) => list.map((c) => c.id).join();
  return html`<${Shell} tabs=${tabs} tab=${t} setTab=${setTab} note=${`${selection.length} selected`}>
    <div class="copybar"><button onClick=${pasteSettings} disabled=${!getState().settingsClip} title="Paste copied settings onto every selected clip (Ctrl+Alt+V)"><${Icon} n="clipboard-paste" /> Paste settings onto all selected</button></div>
    ${t === "audio" && html`<${MultiAudio} key=${key(sound)} targets=${strip(sound)} items=${sound.map((c) => c.item)} />`}
    ${t === "adjust" && html`<${MultiAdjust} key=${key(visual)} targets=${strip(visual)} items=${visual.map((c) => c.item)} />`}
    ${t === "speed" && html`<${MultiSpeed} targets=${strip(clips)} items=${clips.map((c) => c.item)} />`}
    ${t === "text" && textPanel}
    ${t === "edit" && html`
      <p class="muted">Drag in the preview to move them together. Ctrl+C copy · Ctrl+D duplicate · Del delete.</p>
      <button class="wide" onClick=${copySelection}><${Icon} n="copy" /> Copy</button>
      <button class="wide" onClick=${duplicateSelection}><${Icon} n="copy-plus" /> Duplicate</button>
      ${selection.filter((s) => s.kind === "main").length > 1 && html`<button class="wide" onClick=${mergeClips}><${Icon} n="combine" /> Merge clips</button>`}
      <button class="danger wide" onClick=${deleteSelection}><${Icon} n="trash-2" /> Delete all</button>`}
  <//>`;
}
