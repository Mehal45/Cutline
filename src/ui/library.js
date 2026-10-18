// Left-panel catalogues: effects and filters (with live previews), audio (music + text-to-speech) and text presets.
import React, { useEffect, useRef, useState } from "react";
import { useStore, getState } from "../store.js";
import { EFFECTS, EFFECT_CATEGORIES, FILTERS, fxThumbnail } from "../fx.js";
import { applyEffect, applyFilter, addAdjustmentLayer, importFiles, addText, toast } from "../actions.js";
import { html, Field, db } from "./kit.js";
import { loadFont } from "./fonts.js";
import { TTS_VOICES, speak, ttsStatus } from "../tts.js";
import {
  addTextFromPreset, addDefaultText, deleteTextPreset, renameTextPreset, toggleDefaultPreset, applyPresetToSelection,
  addAdjustFromPreset, applyAudioPreset, saveMediaKit, setKitFiles, importKit,
} from "../presets.js";
import { VOICE_EFFECTS } from "../audiofx.js";

// ---------------- previews ----------------

/** A still to preview effects on: the current preview frame, or a colourful test card when the timeline is empty. */
function previewSource() {
  const c = new OffscreenCanvas(320, 180);
  const x = c.getContext("2d");
  const live = document.querySelector(".stage canvas");
  const empty = !getState().project.main.length && !getState().project.overlays.length;
  if (live && !empty) {
    x.fillStyle = "#000";
    x.fillRect(0, 0, 320, 180);
    const r = Math.min(320 / live.width, 180 / live.height);
    x.drawImage(live, (320 - live.width * r) / 2, (180 - live.height * r) / 2, live.width * r, live.height * r);
    return c;
  }
  const g = x.createLinearGradient(0, 0, 320, 180);
  g.addColorStop(0, "#1e3a8a"); g.addColorStop(0.5, "#be185d"); g.addColorStop(1, "#f59e0b");
  x.fillStyle = g; x.fillRect(0, 0, 320, 180);
  x.fillStyle = "#fde68a"; x.beginPath(); x.arc(230, 70, 34, 0, Math.PI * 2); x.fill();
  x.fillStyle = "#0f172a"; x.beginPath(); x.moveTo(0, 180); x.lineTo(90, 90); x.lineTo(170, 150); x.lineTo(240, 110); x.lineTo(320, 180); x.fill();
  x.fillStyle = "#fff"; x.font = "900 34px Inter, sans-serif"; x.fillText("Aa", 24, 52);
  return c;
}

function Thumb({ settings, source }) {
  const ref = useRef();
  useEffect(() => {
    if (!source || !ref.current) return;
    try {
      const out = fxThumbnail(source, settings, 1.3, 160, 90);
      ref.current.getContext("2d").drawImage(out, 0, 0);
    } catch (err) { console.warn(err); }
  }, [source]);
  return html`<canvas ref=${ref} width="160" height="90" class="thumb" />`;
}

function useSource(deps) {
  const [src, setSrc] = useState(null);
  useEffect(() => { setSrc(previewSource()); }, deps);
  return [src, () => setSrc(previewSource())];
}

// ---------------- effects ----------------

export function EffectsTab({ cat: fixedCat }) {
  const selCount = useStore((s) => s.selection.filter((x) => x.kind === "main" || x.kind === "overlay").length);
  const [source, refresh] = useSource([]);
  const [ownCat, setCat] = useState(0);
  const cat = fixedCat ?? ownCat;
  return html`<div>
    <div class="row between"><b class="lib-title">${EFFECT_CATEGORIES[cat]}</b><button class="mini" title="Preview on the current frame" onClick=${refresh}>↻ Refresh</button></div>
    <p class="muted">${selCount ? `Click to add to the ${selCount} selected clip${selCount > 1 ? "s" : ""}.` : "Click to add over the timeline at the playhead (or select a clip first)."}</p>
    ${fixedCat == null && html`<select value=${cat} onChange=${(e) => setCat(+e.target.value)} style=${{ width: "100%" }}>
      ${EFFECT_CATEGORIES.map((c, i) => html`<option value=${i}>${c}</option>`)}
    </select>`}
    <div class="cards">
      ${Object.entries(EFFECTS).filter(([, d]) => d.cat === cat).map(([k, d]) => html`<button key=${k} class="card" onClick=${(e) => applyEffect(k, { toTimeline: e.altKey })}
          title=${selCount ? "Add to the selected clips (Alt+click: add to the timeline instead)" : "Add to the timeline"}>
        <${Thumb} settings=${{ fx: [{ type: k, amount: 0.8 }] }} source=${source} />
        <span>${d.label}</span>
      </button>`)}
    </div>
  </div>`;
}

export function AdjustmentTab() {
  return html`<div>
    <b class="lib-title">Adjustment layer</b>
    <p class="muted">An adjustment layer colours, filters and adds effects to everything under it on the timeline, for as long as it lasts.</p>
    <button class="card-big" onClick=${addAdjustmentLayer}><i class="ico icon-sliders-horizontal" /> Add adjustment layer</button>
    <${KindPresets} kind="adjust" title="My adjustment presets"
      empty="Select an adjustment layer on the timeline and press “Save as preset” to keep its effects, filter and colour settings here."
      describe=${(p) => [p.look.filter?.type && "filter", (p.look.fx || []).length && `${p.look.fx.length} effect${p.look.fx.length > 1 ? "s" : ""}`,
        p.look.adjust && Object.values(p.look.adjust).some((v) => v) && "colour"].filter(Boolean).join(" · ") || "adjustment"}
      onUse=${addAdjustFromPreset} useTitle="Add at the playhead" />
  </div>`;
}

/** A list of saved presets of one kind (adjustment layers, audio settings) with use / rename / delete. */
function KindPresets({ kind, title, empty, describe, onUse, useTitle }) {
  const presets = (useStore((s) => s.textPresets) || []).filter((p) => p.kind === kind);
  const [renaming, setRenaming] = useState(null);
  return html`<div class="kpresets">
    <b class="lib-title">${title}</b>
    ${!presets.length && html`<p class="muted">${empty}</p>`}
    ${presets.map((p) => html`<div key=${p.id} class="kpreset">
      <button class="kpreset-main" onClick=${() => onUse(p)} title=${useTitle}>
        ${renaming === p.id
          ? html`<input autoFocus defaultValue=${p.name} onClick=${(e) => e.stopPropagation()}
              onBlur=${(e) => { renameTextPreset(p.id, e.target.value); setRenaming(null); }}
              onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setRenaming(null); }} />`
          : html`<b>${p.name}</b>`}
        <small>${describe(p)}</small>
      </button>
      <span class="ptile-btns">
        <button title="Rename" onClick=${() => setRenaming(p.id)}><i class="ico icon-pencil" /></button>
        <button title="Delete preset" onClick=${() => { if (confirm(`Delete the preset “${p.name}”?`)) deleteTextPreset(p.id); }}><i class="ico icon-trash-2" /></button>
      </span>
    </div>`)}
  </div>`;
}

const audioSummary = (p) => {
  const a = p.look.audio || {};
  return [db(a.volume ?? 1), a.fadeIn && `fade in ${a.fadeIn}s`, a.fadeOut && `fade out ${a.fadeOut}s`,
    a.denoise && "noise reduced", a.enhance && "voice enhanced", a.normalize && "levelled", a.voice && VOICE_EFFECTS[a.voice]].filter(Boolean).join(" · ");
};

const fileIcon = (kind) => (kind === "audio" ? "music" : kind === "image" ? "image" : "film");
const kindOfName = (name) => (/\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(name) ? "audio" : /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name) ? "image" : "video");

/** Media › My kits: sets of files you use in every video, added to the library in one click. */
export function MediaKitsTab() {
  const kits = (useStore((s) => s.textPresets) || []).filter((p) => p.kind === "media");
  const library = useStore((s) => s.project.media);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const picker = useRef();
  const pickFor = useRef(null);
  const desktop = window.cutlineDesktop;
  const onDisk = Object.values(library).filter((m) => m.path);
  const [chosen, setChosen] = useState(null);
  const sel = chosen ?? new Set(onDisk.map((m) => m.id));
  const filesFromPicker = (list) => [...list].map((f) => ({ path: desktop?.pathFor(f), name: f.name, kind: kindOfName(f.name) })).filter((f) => f.path);
  const addToKit = async (kit, files) => {
    const have = new Set(kit.look.files.map((f) => f.path));
    await setKitFiles(kit.id, [...kit.look.files, ...files.filter((f) => !have.has(f.path))]);
  };
  if (!desktop) return html`<div><b class="lib-title">My kits</b>
    <p class="muted">Media kits remember where your files are on this computer, so they need the Cutline desktop app.</p></div>`;
  return html`<div>
    <b class="lib-title">My kits</b>
    <p class="muted">A kit is the set of music, sound effects and clips you use in every video. One click adds them all to the library.</p>
    <input ref=${picker} type="file" multiple accept="video/*,image/*,audio/*" hidden onChange=${async (e) => {
      const files = filesFromPicker(e.target.files); e.target.value = "";
      if (pickFor.current === "new") {
        if (!files.length) return;
        let name = "My video kit", n = 2;
        while (kits.some((k) => k.name === name)) name = `My video kit ${n++}`;
        await saveMediaKit(name, files);
        const made = (getState().textPresets || []).find((k) => k.kind === "media" && k.name === name);
        if (made) { setOpen(made.id); setRenaming(made.id); }
      }
      else { const kit = kits.find((k) => k.id === pickFor.current); if (kit) await addToKit(kit, files); }
    }} />
    ${!creating && html`<div class="row" style=${{ marginBottom: "8px" }}>
      <button class="primary" disabled=${!onDisk.length} title=${onDisk.length ? "Make a kit from files in the library" : "Import some files first"} onClick=${() => { setChosen(null); setCreating(true); }}>
        <i class="ico icon-package-plus" /> Kit from library</button>
      <button onClick=${() => { pickFor.current = "new"; picker.current.click(); }}><i class="ico icon-folder-open" /> Kit from files…</button>
    </div>`}
    ${creating && html`<div class="kit-create">
      <p class="muted">Tick the files to keep in the kit:</p>
      <div class="kit-files">
        ${onDisk.map((m) => html`<label key=${m.id} class="check"><input type="checkbox" checked=${sel.has(m.id)}
          onChange=${(e) => { const n = new Set(sel); if (e.target.checked) n.add(m.id); else n.delete(m.id); setChosen(n); }} />
          <i class=${"ico icon-" + fileIcon(m.kind)} /> <span class="ell">${m.name}</span></label>`)}
      </div>
      <div class="preset-name">
        <input id="kit-name" autoFocus placeholder="Kit name, e.g. Minecraft essentials" onKeyDown=${(e) => e.key === "Enter" && e.target.nextElementSibling.click()} />
        <button class="primary" disabled=${!sel.size} onClick=${async () => {
          const files = onDisk.filter((m) => sel.has(m.id)).map((m) => ({ path: m.path, name: m.name, kind: m.kind }));
          await saveMediaKit(document.getElementById("kit-name").value, files); setCreating(false);
        }}>Save kit</button>
        <button onClick=${() => setCreating(false)}>Cancel</button>
      </div>
    </div>`}
    ${!kits.length && !creating && html`<p class="muted">No kits yet. Import your usual files, then press <b>Kit from library</b> — or pick them directly with <b>Kit from files…</b>.</p>`}
    ${kits.map((k) => html`<div key=${k.id} class="kit">
      <div class="kit-head">
        ${renaming === k.id
          ? html`<input autoFocus defaultValue=${k.name} onBlur=${(e) => { renameTextPreset(k.id, e.target.value); setRenaming(null); }}
              onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setRenaming(null); }} />`
          : html`<button class="kit-title" onClick=${() => setOpen(open === k.id ? null : k.id)} title="Show the files">
              <i class=${"ico icon-chevron-" + (open === k.id ? "down" : "right")} /> <b>${k.name}</b> <small>${k.look.files.length} file${k.look.files.length === 1 ? "" : "s"}</small></button>`}
        <button class="primary kit-add" onClick=${() => importKit(k)} title="Add every file of this kit to the library"><i class="ico icon-plus" /> Add all</button>
      </div>
      ${open === k.id && html`<div class="kit-files">
        ${k.look.files.map((f, i) => html`<div key=${f.path} class="kit-file" title=${f.path}>
          <i class=${"ico icon-" + fileIcon(f.kind)} /> <span class="ell">${f.name}</span>
          <button class="mini" title="Remove from kit" onClick=${() => setKitFiles(k.id, k.look.files.filter((_, j) => j !== i))}>✕</button>
        </div>`)}
        <div class="ptile-btns">
          <button title="Add files to this kit" onClick=${() => { pickFor.current = k.id; picker.current.click(); }}><i class="ico icon-plus" /> files</button>
          <button title="Add the library's files to this kit" onClick=${() => addToKit(k, onDisk.map((m) => ({ path: m.path, name: m.name, kind: m.kind })))}><i class="ico icon-package-plus" /> library</button>
          <button title="Rename" onClick=${() => setRenaming(k.id)}><i class="ico icon-pencil" /></button>
          <button title="Delete kit" onClick=${() => { if (confirm(`Delete the kit “${k.name}”? (Your files stay where they are.)`)) deleteTextPreset(k.id); }}><i class="ico icon-trash-2" /></button>
        </div>
      </div>`}
    </div>`)}
  </div>`;
}

export function AudioPresetsTab() {
  return html`<${KindPresets} kind="audio" title="My audio presets"
    empty="Select a video clip or audio layer, set its volume, fades and cleanup in the Audio tab on the right, then press “Save audio preset”."
    describe=${audioSummary} onUse=${applyAudioPreset} useTitle="Apply to the selected clips and audio layers" />`;
}

export function FiltersTab() {
  const [source, refresh] = useSource([]);
  return html`<div>
    <p class="muted">Click to apply to the selected clips (or the clip under the playhead).</p>
    <div class="row"><button class="wide" style=${{ marginTop: 0 }} onClick=${() => applyFilter(null)}>Remove filter</button><button title="Preview on the current frame" onClick=${refresh}>↻</button></div>
    <div class="cards">
      ${Object.entries(FILTERS).map(([k, f]) => html`<button key=${k} class="card" onClick=${() => applyFilter(k)}>
        <${Thumb} settings=${{ filter: { type: k, amount: 1 } }} source=${source} />
        <span>${f.label}</span>
      </button>`)}
    </div>
  </div>`;
}

// ---------------- audio ----------------

export function AudioTab({ part }) {
  const input = useRef();
  const [text, setText] = useState("");
  const [voice, setVoice] = useState(TTS_VOICES[0].id);
  const [speed, setSpeed] = useState(1);
  const [busy, setBusy] = useState(false);
  const status = useStore((s) => s.ttsStatus);
  const selectedText = useStore((s) => {
    const t = s.selection.find((x) => x.kind === "text");
    return t ? s.project.texts.find((x) => x.id === t.id)?.text : null;
  });
  const run = async () => {
    const say = text.trim() || selectedText || "";
    if (!say) return toast("Type something to say first");
    setBusy(true);
    try { await speak(say, { voice, speed }); }
    catch (err) { toast("Text to speech failed: " + err.message); }
    setBusy(false);
  };
  const music = html`<div>
    <b class="lib-title">Music & sounds</b>
    <button class="primary wide" onClick=${() => input.current.click()}>+ Import music or sound</button>
    <input ref=${input} type="file" multiple accept="audio/*" hidden
      onChange=${(e) => { importFiles([...e.target.files]); e.target.value = ""; }} />
    <p class="muted">Sounds go to the library (Media tab): click one to listen, then add it to an audio track. Select it on the timeline to change volume, fades, cleanup and voice effects.</p>
  </div>`;
  if (part === "music") return music;
  return html`<div>
    ${!part && music}
    <b class="lib-title">Text to speech</b>
    <p class="muted">Natural voices generated on your computer (Kokoro). The voice model (~90 MB) downloads once.</p>
    <textarea rows="4" placeholder=${selectedText ? `Leave empty to read the selected text: "${selectedText.slice(0, 40)}"` : "What should the voice say?"}
      value=${text} onChange=${(e) => setText(e.target.value)} />
    <${Field} label="Voice">
      <select value=${voice} onChange=${(e) => setVoice(e.target.value)}>
        ${TTS_VOICES.map((v) => html`<option value=${v.id}>${v.label}</option>`)}
      </select>
    <//>
    <${Field} label=${`Speed ${speed.toFixed(2)}×`}>
      <input type="range" min="0.6" max="1.6" step="0.05" value=${speed} onChange=${(e) => setSpeed(+e.target.value)} />
    <//>
    ${status && busy && html`<p class="status">${status}</p>`}
    <button class="primary wide" disabled=${busy} onClick=${run}>${busy ? "Generating…" : "Generate voice-over"}</button>
    ${ttsStatus() === "failed" && html`<p class="error">The voice model couldn't load. Check your connection and try again.</p>`}
  </div>`;
}

// ---------------- text presets ----------------

export const TEXT_PRESETS = [
  { label: "Title", style: { size: 120, weight: 900 } },
  { label: "Subtitle", style: { size: 56, weight: 600, strokeWidth: 0, bg: "#000000aa" } },
  { label: "Neon", style: { size: 96, weight: 800, color: "#39ff14", stroke: "#003300", strokeWidth: 4, shadow: { color: "#39ff14cc", blur: 30, x: 0, y: 0 } } },
  { label: "Bold yellow", style: { size: 88, weight: 900, color: "#ffd400", stroke: "#000000", strokeWidth: 10 } },
  { label: "Typewriter", style: { size: 64, weight: 600, font: "'Courier New', monospace", strokeWidth: 0 }, anim: { in: { type: "typewriter", dur: 1.2 } } },
  { label: "Pop", style: { size: 100, weight: 900 }, anim: { in: { type: "pop", dur: 0.35 }, out: { type: "zoom", dur: 0.3 } } },
  { label: "HEADLINE", style: { size: 150, weight: 400, font: "'Bebas Neue', sans-serif", strokeWidth: 0, letterSpacing: 0.04, shadow: { color: "#000000aa", blur: 16, x: 0, y: 8 } } },
  { label: "Impact meme", style: { size: 110, weight: 400, font: "'Anton', sans-serif", uppercase: true, strokeWidth: 9 } },
  { label: "Script", style: { size: 110, weight: 400, font: "'Pacifico', cursive", strokeWidth: 0, shadow: { color: "#00000088", blur: 12, x: 3, y: 5 } } },
  { label: "Elegant", style: { size: 96, weight: 400, font: "'Playfair Display', serif", italic: true, strokeWidth: 0, letterSpacing: 0.02 } },
  { label: "Marker", style: { size: 96, weight: 400, font: "'Permanent Marker', cursive", color: "#ffffff", strokeWidth: 0, shadow: { color: "#000000cc", blur: 0, x: 5, y: 5 } } },
  { label: "Comic!", style: { size: 120, weight: 400, font: "'Bangers', cursive", color: "#ffde00", stroke: "#d0021b", strokeWidth: 8, letterSpacing: 0.05 } },
  { label: "Retro pixel", style: { size: 56, weight: 400, font: "'Press Start 2P', monospace", color: "#ff5ec4", stroke: "#2b0a3d", strokeWidth: 6 } },
  { label: "Lower third", style: { size: 52, weight: 700, font: "'Montserrat', sans-serif", strokeWidth: 0, bg: "#e11d48ee", bgPad: 0.9, bgRadius: 0.1, align: "left" } },
  { label: "Clean caption", style: { size: 60, weight: 700, font: "'Poppins', sans-serif", strokeWidth: 0, bg: "#000000b3", bgRadius: 0.4 } },
  { label: "Glow", style: { size: 104, weight: 700, font: "'Righteous', sans-serif", color: "#ffffff", strokeWidth: 0, shadow: { color: "#22d3eeff", blur: 40, x: 0, y: 0 } } },
  { label: "Stamp", style: { size: 96, weight: 400, font: "'Black Ops One', cursive", color: "#e11d48", strokeWidth: 0, uppercase: true } },
  { label: "हिंदी शीर्षक", style: { size: 100, weight: 800, font: "'Noto Sans', 'Noto Sans Devanagari', sans-serif", strokeWidth: 8 } },
];

/** Saved text presets: click to add a ready-styled text at the playhead. */
function MyPresets() {
  const presets = (useStore((s) => s.textPresets) || []).filter((p) => (p.kind || "text") === "text");
  const textSelected = useStore((s) => s.selection.some((x) => x.kind === "text"));
  const [renaming, setRenaming] = useState(null);
  useEffect(() => { presets.forEach((p) => p.look.style?.font && loadFont(p.look.style.font, p.look.style.weight, p.look.style.italic)); }, [presets.length]);
  if (!presets.length) return html`<div>
    <b class="lib-title">My presets</b>
    <p class="muted">Style a text the way you always use it (font, size, colour, shadow, position, animation and length),
      then select it and press <b>Save as preset</b> on the right. It will appear here: one click adds a new text exactly like it at the playhead.</p>
  </div>`;
  const css = (st) => ({ fontFamily: st.font, color: st.color, fontWeight: st.weight, fontStyle: st.italic ? "italic" : undefined,
    textTransform: st.uppercase ? "uppercase" : undefined, background: st.bg || undefined,
    WebkitTextStroke: st.strokeWidth > 0 ? `${Math.min(2, st.strokeWidth / 4)}px ${st.stroke}` : undefined,
    textShadow: st.shadow ? `${(st.shadow.x ?? 4) / 4}px ${(st.shadow.y ?? 4) / 4}px ${(st.shadow.blur ?? 8) / 4}px ${st.shadow.color}` : undefined });
  return html`<div>
    <b class="lib-title">My presets</b>
    <p class="muted">Click to add at the playhead. ★ = used by “Add text” and the T key.</p>
    <div class="ptiles">
      ${presets.map((p) => html`<div key=${p.id} class=${"ptile" + (p.isDefault ? " def" : "")}>
        <button class="ptile-main" onClick=${() => addTextFromPreset(p)} title=${`Add “${p.name}” at the playhead`}>
          <span class="ptile-sample" style=${css(p.look.style || {})}>${p.sample || "Your text"}</span>
        </button>
        ${renaming === p.id
          ? html`<input class="ptile-name" autoFocus defaultValue=${p.name} onBlur=${(e) => { renameTextPreset(p.id, e.target.value); setRenaming(null); }}
              onKeyDown=${(e) => { if (e.key === "Enter") e.target.blur(); if (e.key === "Escape") setRenaming(null); }} />`
          : html`<span class="ptile-name ell" onDoubleClick=${() => setRenaming(p.id)} title="Double-click to rename">${p.name}</span>`}
        <span class="ptile-btns">
          <button class=${p.isDefault ? "on" : ""} title=${p.isDefault ? "Stop using for Add text" : "Use for Add text and the T key"} onClick=${() => toggleDefaultPreset(p.id)}><i class=${"ico icon-star"} /></button>
          ${textSelected && html`<button title="Give the selected texts this look" onClick=${() => applyPresetToSelection(p)}><i class="ico icon-paintbrush" /></button>`}
          <button title="Rename" onClick=${() => setRenaming(p.id)}><i class="ico icon-pencil" /></button>
          <button title="Delete preset" onClick=${() => { if (confirm(`Delete the preset “${p.name}”?`)) deleteTextPreset(p.id); }}><i class="ico icon-trash-2" /></button>
        </span>
      </div>`)}
    </div>
  </div>`;
}

export function TextTab({ part }) {
  useEffect(() => { TEXT_PRESETS.forEach((p) => p.style.font && loadFont(p.style.font, p.style.weight, p.style.italic)); }, []);
  if (part === "mine") return html`<${MyPresets} />`;
  if (part === "add") return html`<div class="tiles">
    <button class="tile" onClick=${() => addText()} title="Add text at the playhead">Default text</button>
  </div>`;
  return html`<div>
    ${!part && html`<button class="primary wide" onClick=${() => addDefaultText()}>+ Add text</button>`}
    <b class="lib-title">Text presets</b>
    <div class="grid2">
      ${TEXT_PRESETS.map((p) => html`<button key=${p.label} class="preset" onClick=${() => addText({ ...p, text: p.label })}
        style=${{ fontFamily: p.style.font, color: p.style.color, fontWeight: p.style.weight, fontStyle: p.style.italic ? "italic" : undefined,
          textShadow: p.style.shadow ? `${p.style.shadow.x / 4}px ${p.style.shadow.y / 4}px ${p.style.shadow.blur / 4}px ${p.style.shadow.color}` : undefined,
          background: p.style.bg || undefined }}>${p.label}</button>`)}
    </div>
  </div>`;
}
