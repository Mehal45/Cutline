// Speed curve editor (speed ramping): presets plus a graph of speed across the clip with draggable points.
import React from "react";
import { useStore, usePanelTime, edit, editLive, checkpoint, findItem } from "../store.js";
import { SPEED_CURVES, presetCurve, hasCurve, setSpeedCurve, curveSpeedAt, sourceSpan, MIN_SPEED, MAX_SPEED } from "../speed.js";
import { localTime } from "../actions.js";
import { html } from "./kit.js";

const W = 260, H = 140, PX = 30, PY = 12;
const LMIN = Math.log2(MIN_SPEED), LMAX = Math.log2(MAX_SPEED);
const X = (p) => PX + p * (W - PX - 8);
const Y = (v) => PY + (1 - (Math.log2(v) - LMIN) / (LMAX - LMIN)) * (H - 2 * PY);
const toP = (x) => Math.max(0, Math.min(1, (x - PX) / (W - PX - 8)));
const toV = (y) => Math.max(MIN_SPEED, Math.min(MAX_SPEED, 2 ** (LMIN + (1 - (y - PY) / (H - 2 * PY)) * (LMAX - LMIN))));
const fmtV = (v) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2)).replace(/\.0+$/, "") + "×";

export function SpeedCurveEditor({ kind, id }) {
  const project = useStore((s) => s.project);
  const time = usePanelTime();
  const item = findItem(project, kind, id);
  if (!item) return null;
  const curve = hasCurve(item) ? item.speedCurve : null;
  const apply = (c, live) => (live ? editLive : edit)((p) => setSpeedCurve(findItem(p, kind, id), c));

  const svgPoint = (e) => {
    const r = e.currentTarget.ownerSVGElement?.getBoundingClientRect() || e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * W) / r.width, y: ((e.clientY - r.top) * H) / r.height, r };
  };
  const dragPoint = (i) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    const svg = e.currentTarget.ownerSVGElement;
    checkpoint();
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const x = ((ev.clientX - r.left) * W) / r.width, y = ((ev.clientY - r.top) * H) / r.height;
      const pts = curve.points.map((q) => ({ ...q }));
      pts[i].v = Math.round(toV(y) * 100) / 100;
      if (i > 0 && i < pts.length - 1) pts[i].p = Math.max(pts[i - 1].p + 0.02, Math.min(pts[i + 1].p - 0.02, toP(x)));
      apply({ ...curve, points: pts, preset: undefined }, true);
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const addPoint = (e) => {
    if (!curve) return;
    const { x, y } = svgPoint(e);
    const p = toP(x);
    if (p <= 0.01 || p >= 0.99) return;
    const pts = [...curve.points, { p, v: Math.round(toV(y) * 100) / 100 }].sort((a, b) => a.p - b.p);
    apply({ ...curve, points: pts, preset: undefined });
  };
  const removePoint = (i) => (e) => {
    e.stopPropagation();
    if (i === 0 || i === curve.points.length - 1 || curve.points.length <= 2) return;
    apply({ ...curve, points: curve.points.filter((_, j) => j !== i), preset: undefined });
  };

  let path = "";
  if (curve) for (let k = 0; k <= 120; k++) { const p = k / 120; path += `${k ? "L" : "M"}${X(p).toFixed(1)},${Y(curveSpeedAt(curve, p)).toFixed(1)}`; }
  const lt = localTime(project, kind, item, time);
  const playP = lt >= 0 && lt <= item.dur ? lt / item.dur : null;

  return html`<div class="speedcurve">
    <div class="chips">
      <button class=${!curve ? "chip on" : "chip"} onClick=${() => apply(null)}>None</button>
      ${Object.entries(SPEED_CURVES).map(([k, c]) => html`<button key=${k} class=${curve?.preset === k ? "chip on" : "chip"}
        onClick=${() => apply({ ...presetCurve(k), smooth: curve ? curve.smooth !== false : true })}>${c.label}</button>`)}
      ${!curve && html`<button class="chip" onClick=${() => apply({ points: [{ p: 0, v: 1 }, { p: 0.5, v: 1 }, { p: 1, v: 1 }], smooth: true })}>Custom</button>`}
    </div>
    ${curve && html`
      <svg viewBox=${`0 0 ${W} ${H}`} class="curve-svg" onDoubleClick=${addPoint}>
        ${[0.25, 0.5, 1, 2, 4, 8].map((v) => html`<g key=${v}>
          <line x1=${PX} x2=${W - 8} y1=${Y(v)} y2=${Y(v)} class=${v === 1 ? "sc-one" : "sc-grid"} />
          <text x=${PX - 4} y=${Y(v) + 3} class="sc-label">${v}×</text>
        </g>`)}
        ${playP != null && html`<line x1=${X(playP)} x2=${X(playP)} y1=${PY} y2=${H - PY} class="sc-play" />`}
        <path d=${path} class="curve-line" />
        ${curve.points.map((q, i) => html`<g key=${i}>
          <circle cx=${X(q.p)} cy=${Y(q.v)} r="6" class="curve-knob" onPointerDown=${dragPoint(i)} onDoubleClick=${removePoint(i)} />
          <title>${fmtV(q.v)}</title>
        </g>`)}
      </svg>
      <label class="check"><input type="checkbox" checked=${curve.smooth !== false}
        onChange=${(e) => apply({ ...curve, smooth: e.target.checked })} /> Smooth (ease in & out — no sudden speed jumps)</label>
      <p class="muted">Drag the dots up for faster, down for slower. Double-click to add a dot; double-click a dot to remove it.
        Now ${item.dur.toFixed(2)}s on the timeline, using ${sourceSpan(item).toFixed(2)}s of footage.</p>`}
  </div>`;
}
