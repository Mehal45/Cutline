// Masks (shapes that cut out part of a clip) and the crop tool: inspector controls plus the handles drawn
// over the player to move / resize / rotate a mask and to drag a crop box.
import { useEffect } from "react";
import { useStore, getState, setState, edit, editLive, checkpoint, findItem } from "../store.js";
import { MASK_SHAPES, maskBox, transformAt } from "../engine.js";
import { localTime, toast } from "../actions.js";
import { html, Icon, Section, Slider } from "./kit.js";

const pct = (v) => `${Math.round(v * 100)}%`;
const set = (kind, id) => (fn, live) => (live ? editLive : edit)((p) => { const it = findItem(p, kind, id); if (it) fn(it); });
const NEW_MASK = { x: 0.5, y: 0.5, w: 0.5, h: 0.5, rot: 0, radius: 0, feather: 0, invert: false };

// ---------------- inspector: Mask tab ----------------

export function MaskSection({ kind, item }) {
  const s = set(kind, item.id);
  const m = item.mask?.shape ? item.mask : null;
  // While this tab is open the player shows the mask's handles.
  useEffect(() => { setState({ maskEditing: item.id }); return () => setState({ maskEditing: null }); }, [item.id]);
  const pick = (shape) => s((it) => {
    if (shape === "none") { delete it.mask; return; }
    it.mask = { ...NEW_MASK, ...(it.mask || {}), shape };
    if (shape === "split" || shape === "band") it.mask.h = it.mask.shape === "band" ? 0.3 : it.mask.h;
  });
  const field = (k) => (v, live) => s((it) => (it.mask = { ...it.mask, [k]: v }), live);
  const sq = m && (m.shape === "square" || m.shape === "circle");
  const lineish = m && (m.shape === "split" || m.shape === "band");
  return html`<div>
    <${Section} title="Mask shape">
      <div class="mask-grid">
        <button class=${"mask-btn" + (!m ? " on" : "")} onClick=${() => pick("none")}><${Icon} n="ban" /><span>None</span></button>
        ${MASK_SHAPES.map(([k, label, icon]) => html`<button key=${k} class=${"mask-btn" + (m?.shape === k ? " on" : "")} onClick=${() => pick(k)}>
          <${Icon} n=${icon} /><span>${label}</span></button>`)}
      </div>
      ${m && html`<p class="muted small">Drag the shape in the player to move it, the white corner to resize, the round knob above it to rotate${m.shape === "rect" || m.shape === "square" ? " and the yellow knob to round the corners" : ""}.</p>`}
    <//>
    ${m && html`<${Section} title="Mask settings">
      <div class="grid2">
        <${Slider} label="Position X" value=${m.x} min=${-0.5} max=${1.5} step=${0.005} format=${pct} onChange=${field("x")} />
        <${Slider} label="Position Y" value=${m.y} min=${-0.5} max=${1.5} step=${0.005} format=${pct} onChange=${field("y")} />
        ${m.shape !== "split" && html`<${Slider} label=${sq ? "Size" : "Width"} value=${m.w} min=${0.02} max=${2} step=${0.005} format=${pct} onChange=${field("w")} />`}
        ${!sq && m.shape !== "split" && html`<${Slider} label="Height" value=${m.h} min=${0.02} max=${2} step=${0.005} format=${pct} onChange=${field("h")} />`}
      </div>
      <${Slider} label="Rotation" value=${m.rot || 0} min=${-180} max=${180} step=${1} format=${(v) => `${Math.round(v)}°`} onChange=${field("rot")} />
      ${(m.shape === "rect" || m.shape === "square") && html`<${Slider} label="Corner radius" value=${m.radius || 0} min=${0} max=${1} step=${0.01} format=${pct} onChange=${field("radius")} />`}
      <${Slider} label="Feather (soft edge)" value=${m.feather || 0} min=${0} max=${30} step=${0.5} format=${(v) => v.toFixed(1)} onChange=${field("feather")} />
      <label class="check"><input type="checkbox" checked=${!!m.invert} onChange=${(e) => s((it) => (it.mask = { ...it.mask, invert: e.target.checked }))} /> Invert (keep what's outside the shape)</label>
      ${!lineish && html`<button class="wide" onClick=${() => s((it) => (it.mask = { ...it.mask, x: 0.5, y: 0.5, rot: 0 }))}><${Icon} n="locate-fixed" /> Centre the shape</button>`}
      <button class="wide" onClick=${() => pick("none")}><${Icon} n="trash-2" /> Remove mask</button>
    <//>`}
  </div>`;
}

// ---------------- geometry shared by the on-player tools ----------------

/** How a clip's full frame sits on the overlay (display pixels): centre, size, rotation and flips. */
function frameOnScreen(project, kind, item, rect) {
  const media = project.media[item.mediaId];
  if (!media?.w || !media?.h) return null;
  const W = project.width, H = project.height;
  const tr = transformAt(item, localTime(project, kind, item, getState().time));
  const fit = Math.min(W / media.w, H / media.h);
  const k = rect.width / W;
  return {
    cx: tr.x * rect.width, cy: tr.y * rect.height, rot: tr.rotation,
    fw: media.w * fit * tr.scale * k, fh: media.h * fit * tr.scale * k,
    sx: item.flipH ? -1 : 1, sy: item.flipV ? -1 : 1,
  };
}

/** Screen point → frame-centred coordinates (undoing the clip's position, rotation and flips). */
function toFrame(f, el, ev) {
  const r = el.getBoundingClientRect();
  const x = ev.clientX - r.left - f.cx, y = ev.clientY - r.top - f.cy;
  const a = (-f.rot * Math.PI) / 180;
  return { x: (x * Math.cos(a) - y * Math.sin(a)) * f.sx, y: (x * Math.sin(a) + y * Math.cos(a)) * f.sy };
}

const rotate = (p, deg) => { const a = (deg * Math.PI) / 180; return { x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) }; };

/** A drag on one of the tools: an undo point at the start, live edits while moving. */
function drag(e, onMove) {
  e.preventDefault();
  e.stopPropagation();
  checkpoint();
  const move = (ev) => onMove(ev);
  const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---------------- mask handles on the player ----------------

export function MaskHandles({ kind, item, rect, overlay }) {
  const project = useStore((s) => s.project);
  useStore((s) => s.time);
  const f = frameOnScreen(project, kind, item, rect);
  const m = item.mask;
  if (!f || !m?.shape) return null;
  const b = maskBox(m, f.fw, f.fh);
  const sq = m.shape === "square" || m.shape === "circle";
  const update = (fn) => editLive((p) => { const it = findItem(p, kind, item.id); it.mask = { ...it.mask }; fn(it.mask); });
  const el = () => overlay.current;

  const startMove = (e) => {
    const p0 = toFrame(f, el(), e), x0 = m.x, y0 = m.y;
    drag(e, (ev) => { const p = toFrame(f, el(), ev); update((mm) => { mm.x = x0 + (p.x - p0.x) / f.fw; mm.y = y0 + (p.y - p0.y) / f.fh; }); });
  };
  const local = (ev) => rotate({ x: toFrame(f, el(), ev).x - b.cx, y: toFrame(f, el(), ev).y - b.cy }, -(m.rot || 0));
  const startSize = (e) => drag(e, (ev) => {
    const q = local(ev);
    update((mm) => {
      mm.w = Math.max(8, 2 * Math.abs(q.x)) / f.fw;
      if (!sq) mm.h = Math.max(8, 2 * Math.abs(q.y)) / f.fh;
    });
  });
  const startRot = (e) => drag(e, (ev) => {
    const p = toFrame(f, el(), ev);
    let deg = (Math.atan2(p.y - b.cy, p.x - b.cx) * 180) / Math.PI + 90;
    if (deg > 180) deg -= 360;
    if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
    update((mm) => { mm.rot = Math.round(deg * 10) / 10; });
  });
  const startRadius = (e) => drag(e, (ev) => {
    const q = local(ev), half = Math.min(b.w, b.h) / 2;
    update((mm) => { mm.radius = Math.max(0, Math.min(1, (q.x + b.w / 2) / half)); });
  });

  const line = m.shape === "split" || m.shape === "band";
  const L = (rect.width + rect.height) * 2;
  const rpx = (m.radius || 0) * Math.min(b.w, b.h) / 2;
  const outline = m.shape === "rect" || m.shape === "square"
    ? html`<rect x=${-b.w / 2} y=${-b.h / 2} width=${b.w} height=${b.h} rx=${rpx} ry=${rpx} />`
    : m.shape === "circle" || m.shape === "ellipse" ? html`<ellipse rx=${b.w / 2} ry=${b.h / 2} />`
      : m.shape === "split" ? html`<line x1=${-L} x2=${L} y1="0" y2="0" />`
        : m.shape === "band" ? html`<g><line x1=${-L} x2=${L} y1=${-b.h / 2} y2=${-b.h / 2} /><line x1=${-L} x2=${L} y1=${b.h / 2} y2=${b.h / 2} /></g>`
          : html`<rect x=${-b.w / 2} y=${-b.h / 2} width=${b.w} height=${b.h} class="faint" />`;
  const top = line ? -(m.shape === "band" ? b.h / 2 : 0) : -b.h / 2;
  return html`<svg class="mask-ui" width=${rect.width} height=${rect.height}>
    <g transform=${`translate(${f.cx} ${f.cy}) rotate(${f.rot}) scale(${f.sx} ${f.sy}) translate(${b.cx} ${b.cy}) rotate(${m.rot || 0})`}>
      <g class="mask-outline">${outline}</g>
      <rect class="mask-body" x=${line ? -Math.min(L, 4000) : -b.w / 2} y=${line ? top - 10 : -b.h / 2} width=${line ? 2 * Math.min(L, 4000) : b.w}
        height=${line ? (m.shape === "band" ? b.h + 20 : 20) : b.h} onPointerDown=${startMove}><title>Drag to move the mask</title></rect>
      ${!line && html`<circle class="mask-knob" cx=${b.w / 2} cy=${b.h / 2} r="7" onPointerDown=${startSize}><title>Drag to resize</title></circle>`}
      ${m.shape === "band" && html`<circle class="mask-knob" cx="0" cy=${b.h / 2} r="7" onPointerDown=${startSize}><title>Drag to change the band's height</title></circle>`}
      <line class="mask-stem" x1="0" x2="0" y1=${top} y2=${top - 26} />
      <circle class="mask-knob rot" cx="0" cy=${top - 30} r="7" onPointerDown=${startRot}><title>Drag to rotate (Shift snaps to 15°)</title></circle>
      ${(m.shape === "rect" || m.shape === "square") && html`<circle class="mask-knob radius" cx=${-b.w / 2 + Math.max(10, rpx)} cy=${-b.h / 2} r="6"
        onPointerDown=${startRadius}><title>Drag right to round the corners</title></circle>`}
    </g>
  </svg>`;
}

// ---------------- crop tool ----------------

const RATIOS = [["free", "Free", null], ["orig", "Original", "orig"], ["16:9", "16:9", 16 / 9], ["9:16", "9:16", 9 / 16], ["1:1", "1:1", 1], ["4:3", "4:3", 4 / 3], ["3:4", "3:4", 3 / 4]];

/** Opens the crop tool on the selected clip (or the main clip under the playhead). */
export function startCrop() {
  const { selection, project, time } = getState();
  let t = selection.find((s) => s.kind === "main" || s.kind === "overlay");
  if (!t) {
    let start = 0;
    for (const s of project.main) { start += s.gap || 0; if (time >= start && time < start + s.dur) { t = { kind: "main", id: s.id }; break; } start += s.dur; }
  }
  if (!t) return toast("Select a video clip or picture to crop");
  const it = findItem(project, t.kind, t.id);
  if (!project.media[it?.mediaId]?.w) return toast("This clip can't be cropped");
  setState({ selection: [t], cropping: { kind: t.kind, id: t.id, ratio: "free" }, maskEditing: null });
}

export function CropBox({ rect, overlay }) {
  const job = useStore((s) => s.cropping);
  const project = useStore((s) => s.project);
  useStore((s) => s.time);
  useEffect(() => {
    if (!job) return;
    const key = (e) => { if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setState({ cropping: null }); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [!!job]);
  if (!job) return null;
  const item = findItem(project, job.kind, job.id);
  const f = item && frameOnScreen(project, job.kind, item, rect);
  if (!f) return null;
  const c = item.crop || { l: 0, t: 0, r: 0, b: 0 };
  const media = project.media[item.mediaId];
  const el = () => overlay.current;
  // Crop box in frame-centred display pixels.
  const x0 = -f.fw / 2 + c.l * f.fw, x1 = f.fw / 2 - c.r * f.fw, y0 = -f.fh / 2 + c.t * f.fh, y1 = f.fh / 2 - c.b * f.fh;
  const ratioOf = (key) => { const r = RATIOS.find((x) => x[0] === key)?.[2]; return r === "orig" ? media.w / media.h : r; };
  const ratio = ratioOf(job.ratio);
  const save = (n, live = true) => (live ? editLive : edit)((p) => {
    const it = findItem(p, job.kind, job.id);
    if (n.l + n.r < 0.001 && n.t + n.b < 0.001) delete it.crop; else it.crop = n;
  });
  const clampCrop = (n) => {
    const min = 0.05;
    for (const k of ["l", "r", "t", "b"]) n[k] = Math.max(0, Math.min(1, n[k]));
    if (n.l + n.r > 1 - min) n[n.l > n.r ? "l" : "r"] = 1 - min - n[n.l > n.r ? "r" : "l"];
    if (n.t + n.b > 1 - min) n[n.t > n.b ? "t" : "b"] = 1 - min - n[n.t > n.b ? "b" : "t"];
    return n;
  };
  /** The largest box of `r` (w/h in pixels) centred on the current one, inside the frame. */
  const fitRatio = (r, cur = c) => {
    const cx = (cur.l + (1 - cur.r)) / 2, cy = (cur.t + (1 - cur.b)) / 2;
    let w = 1 - cur.l - cur.r, h = (w * f.fw) / r / f.fh;
    if (h > 1 - cur.t - cur.b) { h = 1 - cur.t - cur.b; w = (h * f.fh * r) / f.fw; }
    const l = Math.max(0, Math.min(1 - w, cx - w / 2)), t = Math.max(0, Math.min(1 - h, cy - h / 2));
    return { l, r: 1 - l - w, t, b: 1 - t - h };
  };
  const setRatio = (key) => {
    setState({ cropping: { ...job, ratio: key } });
    const r = ratioOf(key);
    if (r) save(fitRatio(r), false);
  };

  const startEdge = (e, edges) => {
    const start = { ...c };
    const p0 = toFrame(f, el(), e);
    drag(e, (ev) => {
      const p = toFrame(f, el(), ev);
      const dx = (p.x - p0.x) / f.fw, dy = (p.y - p0.y) / f.fh;
      let n = { ...start };
      if (edges === "move") {
        const w = 1 - start.l - start.r, h = 1 - start.t - start.b;
        n.l = Math.max(0, Math.min(1 - w, start.l + dx)); n.r = 1 - w - n.l;
        n.t = Math.max(0, Math.min(1 - h, start.t + dy)); n.b = 1 - h - n.t;
        return save(n);
      }
      if (edges.includes("w")) n.l = start.l + dx;
      if (edges.includes("e")) n.r = start.r - dx;
      if (edges.includes("n")) n.t = start.t + dy;
      if (edges.includes("s")) n.b = start.b - dy;
      n = clampCrop(n);
      if (ratio) {
        // Keep the shape: the height follows the width, growing away from the fixed corner.
        const w = 1 - n.l - n.r;
        let h = (w * f.fw) / ratio / f.fh;
        if (edges.includes("n")) { n.t = Math.max(0, 1 - start.b - h); h = 1 - n.t - start.b; n.b = start.b; }
        else { n.b = Math.max(0, 1 - start.t - h); h = 1 - start.t - n.b; n.t = start.t; }
        const w2 = (h * f.fh * ratio) / f.fw; // the frame edge may have limited the height
        if (edges.includes("w")) n.l = 1 - n.r - w2; else n.r = 1 - n.l - w2;
      }
      save(n);
    });
  };

  const handles = ratio ? ["nw", "ne", "sw", "se"] : ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const pos = { n: [(x0 + x1) / 2, y0], s: [(x0 + x1) / 2, y1], e: [x1, (y0 + y1) / 2], w: [x0, (y0 + y1) / 2], nw: [x0, y0], ne: [x1, y0], sw: [x0, y1], se: [x1, y1] };
  const fr = [-f.fw / 2, -f.fh / 2, f.fw, f.fh];
  return html`<div class="crop-ui" onPointerDown=${(e) => e.stopPropagation()}>
    <svg width=${rect.width} height=${rect.height}>
      <g transform=${`translate(${f.cx} ${f.cy}) rotate(${f.rot}) scale(${f.sx} ${f.sy})`}>
        <path class="crop-shade" fill-rule="evenodd"
          d=${`M${fr[0]},${fr[1]}h${fr[2]}v${fr[3]}h${-fr[2]}Z M${x0},${y0}H${x1}V${y1}H${x0}Z`} />
        <rect class="crop-box" x=${x0} y=${y0} width=${x1 - x0} height=${y1 - y0} onPointerDown=${(e) => startEdge(e, "move")}><title>Drag to move the crop</title></rect>
        ${[1, 2].map((i) => html`<line key=${"v" + i} class="crop-grid" x1=${x0 + ((x1 - x0) * i) / 3} x2=${x0 + ((x1 - x0) * i) / 3} y1=${y0} y2=${y1} />
          <line key=${"h" + i} class="crop-grid" y1=${y0 + ((y1 - y0) * i) / 3} y2=${y0 + ((y1 - y0) * i) / 3} x1=${x0} x2=${x1} />`)}
        ${handles.map((h) => html`<rect key=${h} class=${"crop-knob " + h} x=${pos[h][0] - 7} y=${pos[h][1] - 7} width="14" height="14"
          onPointerDown=${(e) => startEdge(e, h)} />`)}
      </g>
    </svg>
    <div class="crop-bar">
      ${RATIOS.map(([k, label]) => html`<button key=${k} class=${job.ratio === k ? "on" : ""} onClick=${() => setRatio(k)}>${label}</button>`)}
      <span class="sep" />
      <button onClick=${() => { setState({ cropping: { ...job, ratio: "free" } }); save({ l: 0, t: 0, r: 0, b: 0 }, false); }}><${Icon} n="rotate-ccw" /> Reset</button>
      <button class="primary" onClick=${() => setState({ cropping: null })}><${Icon} n="check" /> Done</button>
    </div>
  </div>`;
}
