// Left-panel catalogues: effects and filters (with live previews), audio (music + text-to-speech) and text presets.
import React, { useEffect, useRef, useState } from "react";
import { useStore, getState } from "../store.js";
import { EFFECTS, EFFECT_CATEGORIES, FILTERS, fxThumbnail } from "../fx.js";
import { applyEffect, applyFilter, addAdjustmentLayer, importFiles, addText, toast } from "../actions.js";
import { html, Field } from "./kit.js";
import { loadFont } from "./fonts.js";
import { TTS_VOICES, speak, ttsStatus } from "../tts.js";

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

export function EffectsTab() {
  const selCount = useStore((s) => s.selection.filter((x) => x.kind === "main" || x.kind === "overlay").length);
  const [source, refresh] = useSource([]);
  const [cat, setCat] = useState(0);
  return html`<div>
    <p class="muted">${selCount ? `Click to add to the ${selCount} selected clip${selCount > 1 ? "s" : ""}.` : "Click to add over the timeline at the playhead (or select a clip first)."}</p>
    <div class="row wrap">
      <select value=${cat} onChange=${(e) => setCat(+e.target.value)} style=${{ flex: 1 }}>
        ${EFFECT_CATEGORIES.map((c, i) => html`<option value=${i}>${c}</option>`)}
      </select>
      <button title="Preview on the current frame" onClick=${refresh}>↻</button>
    </div>
    <div class="cards">
      ${Object.entries(EFFECTS).filter(([, d]) => d.cat === cat).map(([k, d]) => html`<button key=${k} class="card" onClick=${(e) => applyEffect(k, { toTimeline: e.altKey })}
          title=${selCount ? "Add to the selected clips (Alt+click: add to the timeline instead)" : "Add to the timeline"}>
        <${Thumb} settings=${{ fx: [{ type: k, amount: 0.8 }] }} source=${source} />
        <span>${d.label}</span>
      </button>`)}
    </div>
    <button class="wide" onClick=${addAdjustmentLayer}>+ Adjustment layer</button>
    <p class="muted">An adjustment layer colours and filters everything under it on the timeline.</p>
  </div>`;
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

export function AudioTab() {
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
  return html`<div>
    <button class="primary wide" onClick=${() => input.current.click()}>+ Add music or sound</button>
    <input ref=${input} type="file" multiple accept="audio/*" hidden
      onChange=${(e) => { importFiles([...e.target.files]); e.target.value = ""; }} />
    <p class="muted">Audio goes on its own track at the playhead. Select it to change volume, fades, cleanup and voice effects.</p>
    <h3 style=${{ marginTop: "16px" }}>Text to speech</h3>
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

export function TextTab() {
  useEffect(() => { TEXT_PRESETS.forEach((p) => p.style.font && loadFont(p.style.font, p.style.weight, p.style.italic)); }, []);
  return html`<div>
    <button class="primary wide" onClick=${() => addText()}>+ Add text</button>
    <p class="muted">Presets</p>
    <div class="grid2">
      ${TEXT_PRESETS.map((p) => html`<button key=${p.label} class="preset" onClick=${() => addText({ ...p, text: p.label })}
        style=${{ fontFamily: p.style.font, color: p.style.color, fontWeight: p.style.weight, fontStyle: p.style.italic ? "italic" : undefined,
          textShadow: p.style.shadow ? `${p.style.shadow.x / 4}px ${p.style.shadow.y / 4}px ${p.style.shadow.blur / 4}px ${p.style.shadow.color}` : undefined,
          background: p.style.bg || undefined }}>${p.label}</button>`)}
    </div>
  </div>`;
}
