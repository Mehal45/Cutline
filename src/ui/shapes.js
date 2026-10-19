// Shape layers: rectangles, circles, triangles, stars, arrows… on the text tracks. Each one can be moved,
// resized, rotated and animated like a text, with its own fill / outline colours.
import { useEffect, useRef } from "react";
import { getState, setState, edit, editLive, uid, findItem, defaultTextStyle } from "../store.js";
import { SHAPES, LINE_SHAPES, EQUAL_SIDES, shapeOutline } from "../engine.js";
import { html, Icon, Field, Section, Slider, KSlider } from "./kit.js";
import { setting } from "../settings.js";

const pct = (v) => `${Math.round(v * 100)}%`;
export const shapeName = (type) => SHAPES.find((s) => s[0] === type)?.[1] || "Shape";

/** Default size (px on a 1920-wide frame) for a new shape. */
function defaultSize(type) {
  if (LINE_SHAPES.has(type)) return type === "carrow" ? [460, 260] : [520, 90];
  if (["arrow", "arrow2", "chevron"].includes(type)) return [520, 240];
  if (["rect", "rounded", "ellipse", "bubble"].includes(type)) return [520, 320];
  return [380, 380];
}

/** Adds a shape at the playhead (selected, ready to edit). `rot` turns it (arrows pointing left / up / down). */
export function addShape(type, rot = 0) {
  const { time } = getState();
  const id = uid();
  const [w, h] = defaultSize(type);
  const last = (() => { try { return JSON.parse(localStorage.getItem("cutline.lastShapeLook") || "null"); } catch { return null; } })();
  edit((p) => p.texts.push({
    id, start: time, dur: setting("textDur"), text: "", x: 0.5, y: 0.5, scale: 1, rotation: rot, opacity: 1,
    shape: {
      type, w, h, fill: last?.fill || "#ffffff", stroke: last?.stroke || "#ffd400", strokeW: last?.strokeW ?? 10,
      mode: LINE_SHAPES.has(type) ? "fill" : last?.mode || "fill", radius: type === "rounded" ? 0.35 : 0,
    },
    style: defaultTextStyle(),
    anim: { in: { type: "none", dur: 0.4 }, out: { type: "none", dur: 0.4 } },
  }));
  setState({ selection: [{ kind: "text", id }] });
}

/** A small drawing of a shape for buttons. */
function ShapeIcon({ type, rot = 0 }) {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current.getContext("2d");
    const S = 44;
    c.clearRect(0, 0, S, S);
    c.save();
    c.translate(S / 2, S / 2);
    c.rotate((rot * Math.PI) / 180);
    const [w, h] = defaultSize(type);
    const k = 32 / Math.max(w, EQUAL_SIDES.has(type) ? w : h);
    c.beginPath();
    shapeOutline(c, type, w * k, (EQUAL_SIDES.has(type) ? w : h) * k, type === "rounded" ? 0.35 : 0);
    c.lineWidth = 2.5; c.lineJoin = "round"; c.lineCap = "round";
    if (LINE_SHAPES.has(type)) { c.strokeStyle = "#e8e9ec"; c.stroke(); } else { c.fillStyle = "#e8e9ec"; c.fill(); }
    c.restore();
  }, [type, rot]);
  return html`<canvas ref=${ref} width="44" height="44" class="shape-ico" />`;
}

const ARROW_TURNS = [["arrow", 0, "Arrow →"], ["arrow", 180, "Arrow ←"], ["arrow", -90, "Arrow ↑"], ["arrow", 90, "Arrow ↓"],
  ["larrow", 0, "Line arrow →"], ["larrow", 180, "Line arrow ←"], ["larrow", -90, "Line arrow ↑"], ["larrow", 90, "Line arrow ↓"],
  ["arrow2", 0, "Double arrow"], ["larrow2", 0, "Double line arrow"], ["chevron", 0, "Chevron"], ["chevron", 180, "Chevron ←"],
  ["carrow", 0, "Curved arrow"], ["uarrow", 0, "U-turn arrow"], ["larrow", -45, "Diagonal arrow ↗"], ["larrow", 45, "Diagonal arrow ↘"]];

/** Library › Shapes: click a shape to add it at the playhead. */
export function ShapesTab({ part }) {
  const list = part === "arrows" ? ARROW_TURNS : SHAPES.filter((s) => s[2] === "basic").map(([k, label]) => [k, 0, label]);
  return html`<div>
    <p class="muted small">Click a shape to add it at the playhead. Change its colours, fill or outline in the panel on the right; drag it in the player to move and resize it.</p>
    <div class="shape-grid">
      ${list.map(([k, rot, label]) => html`<button key=${k + rot} class="shape-btn" title=${label} onClick=${() => addShape(k, rot)}>
        <${ShapeIcon} type=${k} rot=${rot} /><span>${label}</span></button>`)}
    </div>
  </div>`;
}

/** Inspector for a shape layer. */
export function ShapeFields({ t }) {
  const s = t.shape;
  const set = (fn, live) => (live ? editLive : edit)((p) => { const x = findItem(p, "text", t.id); if (x) { x.shape = { ...x.shape }; fn(x.shape); } });
  const remember = (k, v) => { try { const o = JSON.parse(localStorage.getItem("cutline.lastShapeLook") || "{}"); o[k] = v; localStorage.setItem("cutline.lastShapeLook", JSON.stringify(o)); } catch { /* ignore */ } };
  const setK = (k) => (v, live) => { set((sh) => (sh[k] = v), live); if (["fill", "stroke", "strokeW", "mode"].includes(k)) remember(k, v); };
  const line = LINE_SHAPES.has(s.type);
  const sq = EQUAL_SIDES.has(s.type);
  const alpha = (c) => parseInt((c || "").slice(7) || "ff", 16) / 255;
  const withAlpha = (c, a) => (c || "#ffffff").slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");
  return html`<div>
    <${Section} title="Shape">
      <div class="shape-grid small">
        ${SHAPES.map(([k, label]) => html`<button key=${k} class=${"shape-btn" + (s.type === k ? " on" : "")} title=${label}
          onClick=${() => set((sh) => { sh.type = k; if (k === "rounded" && !sh.radius) sh.radius = 0.35; })}><${ShapeIcon} type=${k} /></button>`)}
      </div>
    <//>
    <${Section} title="Colour">
      ${!line && html`<div class="seg-ctl">
        ${[["fill", "Fill"], ["outline", "Outline only"], ["both", "Fill + outline"]].map(([k, l]) => html`<button key=${k} class=${(s.mode || "fill") === k ? "on" : ""}
          onClick=${() => setK("mode")(k)}>${l}</button>`)}
      </div>`}
      <div class="grid2">
        ${(line || s.mode !== "outline") && html`<${Field} label=${line ? "Colour" : "Fill colour"}>
          <input type="color" value=${(s.fill || "#ffffff").slice(0, 7)} onChange=${(e) => setK("fill")(e.target.value + (s.fill || "").slice(7))} /><//>`}
        ${(line || s.mode !== "outline") && html`<${Slider} label=${line ? "Opacity" : "Fill opacity"} value=${alpha(s.fill)} min=${0} max=${1} format=${pct}
          onChange=${(v, live) => setK("fill")(withAlpha(s.fill, v), live)} />`}
        ${!line && s.mode !== "fill" && html`<${Field} label="Outline colour">
          <input type="color" value=${(s.stroke || "#ffd400").slice(0, 7)} onChange=${(e) => setK("stroke")(e.target.value + (s.stroke || "").slice(7))} /><//>`}
        ${!line && s.mode !== "fill" && html`<${Slider} label="Outline opacity" value=${alpha(s.stroke)} min=${0} max=${1} format=${pct}
          onChange=${(v, live) => setK("stroke")(withAlpha(s.stroke, v), live)} />`}
      </div>
      ${(line || s.mode !== "fill") && html`<${Slider} label=${line ? "Thickness" : "Outline width"} value=${s.strokeW ?? 10} min=${1} max=${80} step=${1}
        format=${(v) => v.toFixed(0)} onChange=${setK("strokeW")} />`}
    <//>
    <${Section} title="Size">
      <div class="grid2">
        <${Slider} label=${sq ? "Size" : "Width"} value=${s.w} min=${10} max=${2400} step=${1} format=${(v) => `${Math.round(v)} px`} onChange=${setK("w")} />
        ${!sq && html`<${Slider} label="Height" value=${s.h} min=${line ? 4 : 10} max=${2400} step=${1} format=${(v) => `${Math.round(v)} px`} onChange=${setK("h")} />`}
      </div>
      ${(s.type === "rect" || s.type === "rounded" || s.type === "square") && html`<${Slider} label="Corner radius" value=${s.radius || 0} min=${0} max=${1}
        format=${pct} onChange=${setK("radius")} />`}
    <//>
    <${Section} title="Opacity">
      <${KSlider} kind="text" id=${t.id} path="opacity" label="Opacity" min=${0} max=${1} fallback=${1} format=${pct} />
    <//>
  </div>`;
}
