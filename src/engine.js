// Rendering engine: decides what is visible at time t and draws it.
// Clips use Canvas 2D; transitions blend two clip frames in a WebGL shader; colour, filters and
// effects run in fx.js. Layer order, bottom to top: main track → overlay tracks → timeline effects → texts.
import { layoutMain, getState } from "./store.js";
import { proxySrc } from "./proxy.js";
import { valueAt, propAt } from "./keyframes.js";
import { applyFx, hasFx, ADJUST } from "./fx.js";
import { cutoutFrame } from "./segment.js";
import { needsLiveRoute, routeLive, isRouted } from "./audiofx.js";
import { levelFor } from "./media-audio.js";
import { meanSpeed, sourceAt, rateAt } from "./speed.js";

// ---------- easing + animation presets (pure functions of time) ----------

const ease = {
  linear: (x) => x,
  out: (x) => 1 - Math.pow(1 - x, 3),
  in: (x) => x * x * x,
  back: (x) => 1 + 2.70158 * Math.pow(x - 1, 3) + 1.70158 * Math.pow(x - 1, 2),
};

export const ANIMATIONS = {
  none: { label: "None" },
  fade: { label: "Fade" },
  slideUp: { label: "Slide up" },
  slideDown: { label: "Slide down" },
  zoom: { label: "Zoom" },
  rise: { label: "Rise (from bottom)" },
  softZoom: { label: "Soft zoom" },
  pop: { label: "Pop" },
  typewriter: { label: "Typewriter", textOnly: true },
};

/**
 * Returns {alpha, dx, dy, scale, reveal} for an element at local time `lt` of total `dur`.
 * `anim` = { in: {type, dur}, out: {type, dur} }. dx/dy are in canvas fractions.
 */
export function animState(anim, lt, dur) {
  const s = { alpha: 1, dx: 0, dy: 0, scale: 1, reveal: 1 };
  const apply = (a, p, entering) => {
    if (!a || a.type === "none") return;
    const e = ease.out(p);
    const k = 1 - e; // 1 at the far end of the animation, 0 when settled
    switch (a.type) {
      case "fade": s.alpha *= e; break;
      case "slideUp": s.dy += (entering ? 0.08 : -0.08) * k; s.alpha *= e; break;
      case "slideDown": s.dy += (entering ? -0.08 : 0.08) * k; s.alpha *= e; break;
      case "zoom": s.scale *= 0.6 + 0.4 * e; s.alpha *= e; break;
      // Rises from the bottom of the screen with a strong ease-out (titles); a.dist overrides the distance.
      case "rise": { const q = 1 - Math.pow(1 - p, 3); s.dy += (entering ? 1 : -1) * (a.dist ?? 0.5) * (1 - q); s.alpha *= Math.min(1, p * 2.5); break; }
      // Grows slightly into place while fading in (captions).
      case "softZoom": s.scale *= 0.88 + 0.12 * e; s.alpha *= e; break;
      case "pop": s.scale *= entering ? ease.back(p) : e; break;
      case "typewriter": if (entering) s.reveal = p; else s.alpha *= e; break;
    }
  };
  if (anim?.in && anim.in.type !== "none" && lt < anim.in.dur) apply(anim.in, clamp01(lt / anim.in.dur), true);
  if (anim?.out && anim.out.type !== "none" && lt > dur - anim.out.dur) apply(anim.out, clamp01((dur - lt) / anim.out.dur), false);
  return s;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// ---------- media pool: one element per main-track segment ----------

const elements = new Map(); // segId -> HTMLVideoElement | HTMLImageElement

// While exporting, the export owns the media elements; the live preview must not seek them.
export const renderLock = { exporting: false };

/** segId -> VideoFrame supplied by the exporter's decoders (used instead of <video>). */
export const exportFrames = new Map();

/** Seeks one clip's <video> element exactly (export fallback for files WebCodecs can't decode). */
export function seekClipElement(seg, media, time) {
  const el = elementFor(seg, media);
  if (!(el instanceof HTMLVideoElement)) return el.complete ? Promise.resolve() : new Promise((r) => (el.onload = r));
  if (!el.paused) el.pause();
  if (Math.abs(el.currentTime - time) <= 1 / 240 && el.readyState >= 2) return Promise.resolve();
  return seekTo(el, time);
}

/**
 * Which file the preview plays for an item: its smooth-preview proxy when there is one (never while
 * exporting), else the original. A proxy without sound is only used while paused/scrubbing or when muted.
 */
function previewSrc(item, media) {
  if (renderLock.exporting || media.kind !== "video") return media.url;
  const needSound = getState().playing && !item.mute;
  return proxySrc(media, needSound) || media.url;
}

export function elementFor(seg, media) {
  let el = elements.get(seg.id);
  const src = previewSrc(seg, media);
  if (el && el.dataset.src === src) { swaps.delete(seg.id); return el; }
  if (el instanceof HTMLMediaElement) {
    // Switching between the original and its proxy (a proxy finished building, or play needs the sound):
    // the new file loads in the background while the old one stays on screen, so the clip never goes black.
    let next = swaps.get(seg.id);
    if (!next || next.dataset.src !== src) {
      if (next) dispose(next);
      next = makeElement(media, src);
      const at = el.currentTime;
      next.addEventListener("loadedmetadata", () => { if (next.currentTime < 0.01) next.currentTime = at; }, { once: true });
      swaps.set(seg.id, next);
    }
    const ready = next.readyState >= 2 && !next.seeking;
    if (!ready && !renderLock.exporting && el.readyState >= 2) return el;
    swaps.delete(seg.id);
    if (!ready) next.currentTime = el.currentTime;
    dispose(el);
    elements.set(seg.id, next);
    return next;
  }
  el = makeElement(media, src);
  elements.set(seg.id, el);
  return el;
}

const swaps = new Map(); // segId -> element loading the new source (shown once it has a frame)

function makeElement(media, src) {
  let el;
  if (media.kind === "image") {
    el = new Image();
    el.src = media.url;
  } else if (media.kind === "audio") {
    el = new Audio();
    el.src = media.url;
    el.preload = "auto";
  } else {
    el = document.createElement("video");
    el.src = src;
    el.preload = "auto";
    el.playsInline = true;
    el.crossOrigin = "anonymous";
  }
  el.dataset.src = el instanceof HTMLVideoElement ? src : media.url;
  return el;
}

function dispose(el) {
  if (!(el instanceof HTMLMediaElement)) return;
  el.pause();
  el.removeAttribute("src");
  el.load();
}

export function allVideoElements() {
  return [...elements.values()].filter((e) => e instanceof HTMLMediaElement);
}

/** The media element already created for an item, if any. */
export const existingElement = (id) => elements.get(id);

// ---------- compound clips ----------
// A compound clip's media ({ kind: "compound", sequence: { main, texts, overlays, audio, effects } }) is a
// timeline of its own. Each use of it on the timeline gets a "view": that timeline with item ids prefixed by
// the clip's id, so two copies of one compound clip keep separate players.

const MAX_DEPTH = 6;
const views = new Map(); // instance id -> { seq, view }

export function compoundView(project, media, instanceId) {
  const seq = media.sequence;
  let c = views.get(instanceId);
  if (!c || c.seq !== seq) {
    const pre = (x) => ({ ...x, id: `${instanceId}>${x.id}` });
    c = { seq, view: {
      main: (seq.main || []).map(pre), texts: (seq.texts || []).map(pre), overlays: (seq.overlays || []).map(pre),
      audio: (seq.audio || []).map(pre), effects: (seq.effects || []).map(pre), ...(seq.trackState ? { trackState: seq.trackState } : {}),
    } };
    views.set(instanceId, c);
  }
  Object.assign(c.view, { media: project.media, width: project.width, height: project.height, fps: project.fps });
  return c.view;
}

const compoundCanvases = new Map(); // instance id -> 2d context
let depth = 0;

/** Draws a compound clip's own timeline at its source time; the result is used like a video frame. */
function renderCompound(project, item, media, sourceTime, W, H) {
  if (depth >= MAX_DEPTH || !media.sequence) return null;
  let c = compoundCanvases.get(item.id);
  if (!c) { c = new OffscreenCanvas(W, H).getContext("2d"); compoundCanvases.set(item.id, c); }
  if (c.canvas.width !== W || c.canvas.height !== H) { c.canvas.width = W; c.canvas.height = H; }
  depth++;
  try { drawFrame(c, compoundView(project, media, item.id), sourceTime, { nested: true }); } finally { depth--; }
  return c.canvas;
}

/** Every picture source visible at t, compound clips opened up (for the exporter's decoders). */
export function visibleSources(project, t, level = 0) {
  const out = [];
  const add = (item, sourceTime) => {
    const media = project.media[item.mediaId];
    if (!media) return;
    if (media.kind === "compound") {
      if (level < MAX_DEPTH && media.sequence) out.push(...visibleSources(compoundView(project, media, item.id), sourceTime, level + 1));
    } else out.push({ item, sourceTime, media });
  };
  for (const c of activeClips(project, t).clips) add(c.seg, c.sourceTime);
  for (const o of activeOverlays(project, t)) add(o.item, o.sourceTime);
  return out;
}

/** Which main segments are visible at t, and what source time each should show. */
export function activeClips(project, t) {
  const segs = layoutMain(project);
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const end = seg.start + seg.dur;
    // A transition straddles the cut between seg and the next one: [cut - d/2, cut + d/2].
    // No transition across empty space (main track magnet off); never longer than either clip.
    const half = trHalf(segs, i);
    const prevTr = i > 0 ? trHalf(segs, i - 1) : 0;
    if (t >= seg.start - prevTr && t < end + half) {
      const local = Math.max(0, Math.min(seg.dur - 1e-3, t - seg.start));
      out.push({ seg, index: i, local, sourceTime: sourceAt(seg, local) });
    }
  }
  // Transition progress if two neighbouring clips overlap in this window. Anything else (very short clips
  // next to transitions) falls back to the one clip under the playhead, so drawing never breaks.
  let transition = null;
  if (out.length >= 2) {
    const pair = out.findIndex((a, k) => out[k + 1] && out[k + 1].index === a.index + 1 && trHalf(segs, a.index) > 0
      && t >= out[k + 1].seg.start - trHalf(segs, a.index) && t < out[k + 1].seg.start + trHalf(segs, a.index));
    if (pair >= 0) {
      const a = out[pair], b = out[pair + 1];
      const d = 2 * trHalf(segs, a.index);
      transition = { type: a.seg.transition.type, p: clamp01((t - (b.seg.start - d / 2)) / d), a, b };
      return { clips: [a, b], transition };
    }
    const here = out.find((c) => t >= c.seg.start && t < c.seg.start + c.seg.dur) || out[0];
    return { clips: [here], transition: null };
  }
  return { clips: out, transition };
}

/** Half the length of the transition after main clip i (0 if none), capped so it fits both clips. */
function trHalf(segs, i) {
  const seg = segs[i], next = segs[i + 1];
  if (!seg?.transition || !next || next.gap) return 0;
  return Math.max(0, Math.min(seg.transition.dur, seg.dur, next.dur)) / 2;
}

// ---------- drawing ----------

function drawClip(ctx, project, clip, W, H) {
  drawVisual(ctx, project, clip.seg, clip.local, W, H);
}

/** Canvas blend modes offered for clips and layers. */
export const BLEND_MODES = {
  normal: ["Normal", "source-over"], multiply: ["Multiply", "multiply"], screen: ["Screen", "screen"],
  overlay: ["Overlay", "overlay"], darken: ["Darken", "darken"], lighten: ["Lighten", "lighten"],
  add: ["Add", "lighter"], colorDodge: ["Colour dodge", "color-dodge"], colorBurn: ["Colour burn", "color-burn"],
  hardLight: ["Hard light", "hard-light"], softLight: ["Soft light", "soft-light"], difference: ["Difference", "difference"],
  exclusion: ["Exclusion", "exclusion"], hue: ["Hue", "hue"], saturation: ["Saturation", "saturation"],
  color: ["Colour", "color"], luminosity: ["Luminosity", "luminosity"],
};

const NO_CROP = { l: 0, t: 0, r: 0, b: 0 };

/** Position, scale, rotation and opacity of an item at local time `lt`, keyframes included. */
export function transformAt(item, lt, isText = false) {
  const b = isText ? { x: item.x, y: item.y, scale: item.scale || 1, rotation: item.rotation || 0 } : clipTransform(item);
  return {
    x: valueAt(item, "x", lt, b.x),
    y: valueAt(item, "y", lt, b.y),
    scale: valueAt(item, "scale", lt, b.scale),
    rotation: valueAt(item, "rotation", lt, b.rotation),
    opacity: valueAt(item, "opacity", lt, item.opacity ?? 1),
  };
}

/** Effect settings of an item at local time (keyframed amounts resolved). Null when it has none. */
export function fxSettingsAt(item, lt) {
  if (!item.adjust && !item.filter?.type && !item.fx?.length && !item.chroma?.on) return null;
  const adjust = {};
  if (item.adjust || item.keyframes) for (const k of Object.keys(ADJUST)) adjust[k] = propAt(item, "adjust." + k, lt, 0);
  const s = {
    adjust,
    filter: item.filter?.type ? { type: item.filter.type, amount: propAt(item, "filter.amount", lt, 1) } : null,
    fx: (item.fx || []).map((f) => ({ type: f.type, amount: propAt(item, `fx.${f.id}.amount`, lt, 1) })),
    chroma: item.chroma,
  };
  return hasFx(s) ? s : null;
}

/** Source frame size of a drawable. */
const sizeOf = (el, media) => el.getContext ? [el.width, el.height] : [el.displayWidth || el.videoWidth || el.naturalWidth || media.w, el.displayHeight || el.videoHeight || el.naturalHeight || media.h];

/**
 * Draws a main-track clip or an overlay layer at its local time `lt`: keyframed transform and opacity,
 * crop, flips, cutout, colour/filters/effects and blend mode. Items without any of those take the
 * original direct path, so older projects render exactly as before.
 */
function drawVisual(ctx, project, item, lt, W, H) {
  const media = project.media[item.mediaId];
  if (!media || media.kind === "audio") return;
  // During export a decoded VideoFrame may stand in for the <video> element.
  const el = media.kind === "compound" ? renderCompound(project, item, media, sourceAt(item, lt), W, H)
    : exportFrames.get(item.id) || elementFor(item, media);
  if (!el) return;
  if (el instanceof HTMLVideoElement && el.readyState < 2) frameStatus.loading = true; // still opening the file
  const [sw, sh] = sizeOf(el, media);
  if (!sw || !sh) return;
  const a = animState(item.anim, lt, item.dur);
  const tr = transformAt(item, lt);
  // While the crop tool is open the whole frame shows (the crop box is drawn over it).
  const crop = (!renderLock.exporting && getState().cropping?.id === item.id ? null : item.crop) || NO_CROP;
  const fit = Math.min(W / sw, H / sh);
  const fx = fxSettingsAt(item, lt);
  const src = (item.cutout?.mode && cutoutFrame(item, el, sw, sh)) || el;
  const target = fx ? layer(W, H) : ctx;
  const place = (c) => {
    c.translate(tr.x * W + a.dx * W, tr.y * H + a.dy * H);
    c.rotate((tr.rotation * Math.PI) / 180);
    c.scale(a.scale * tr.scale * (item.flipH ? -1 : 1), a.scale * tr.scale * (item.flipV ? -1 : 1));
  };
  const sx = crop.l * sw, sy = crop.t * sh;
  const cw = sw * (1 - crop.l - crop.r), ch = sh * (1 - crop.t - crop.b);
  const draw = (c) => { if (cw > 0.5 && ch > 0.5) c.drawImage(src, sx, sy, cw, ch, (-sw * fit) / 2 + sx * fit, (-sh * fit) / 2 + sy * fit, cw * fit, ch * fit); };
  // Mask: the clip is drawn on its own layer and cut to the shape (soft edge = blurred shape).
  const mask = item.mask?.shape && item.mask.shape !== "none" ? item.mask : null;
  let masked = null;
  if (mask) {
    masked = scratch(40, W, H);
    masked.setTransform(1, 0, 0, 1, 0, 0);
    masked.globalAlpha = 1; masked.globalCompositeOperation = "source-over"; masked.filter = "none";
    masked.clearRect(0, 0, W, H);
    masked.save(); place(masked); draw(masked); masked.restore();
    masked.save(); place(masked);
    masked.globalCompositeOperation = mask.invert ? "destination-out" : "destination-in";
    const soft = ((mask.feather || 0) / 100) * Math.min(sw, sh) * fit * tr.scale * a.scale;
    if (soft > 0.3) masked.filter = `blur(${soft.toFixed(1)}px)`;
    masked.fillStyle = "#000";
    maskPath(masked, mask, sw * fit, sh * fit);
    masked.fill();
    masked.restore();
    masked.filter = "none"; masked.globalCompositeOperation = "source-over";
  }
  target.save();
  if (!fx) {
    target.globalAlpha = a.alpha * tr.opacity;
    if (item.blend && item.blend !== "normal") target.globalCompositeOperation = BLEND_MODES[item.blend]?.[1] || "source-over";
  }
  if (masked) target.drawImage(masked.canvas, 0, 0);
  else { place(target); draw(target); }
  target.restore();
  if (fx) {
    const out = applyFx(target.canvas, fx, lt, W, H);
    ctx.save();
    ctx.globalAlpha = a.alpha * tr.opacity;
    if (item.blend && item.blend !== "normal") ctx.globalCompositeOperation = BLEND_MODES[item.blend]?.[1] || "source-over";
    ctx.drawImage(out, 0, 0, W, H);
    ctx.restore();
  }
}

// ---------- masks ----------

export const MASK_SHAPES = [["rect", "Rectangle", "rectangle-horizontal"], ["square", "Square", "square"], ["circle", "Circle", "circle"],
  ["ellipse", "Ellipse", "egg"], ["heart", "Heart", "heart"], ["star", "Star", "star"], ["split", "Split", "square-split-vertical"], ["band", "Band", "rows-3"]];

/**
 * A mask's centre and size in the clip's frame (frame-centred pixels; the frame is fw × fh).
 * mask = { shape, x, y (centre, 0–1 of the frame), w, h (0–1 of the frame), rot (deg), radius (0–1), feather (%), invert }
 * Squares and circles keep equal sides (their height follows the width).
 */
export function maskBox(m, fw, fh) {
  const w = Math.max(1, m.w * fw);
  const h = m.shape === "square" || m.shape === "circle" ? w : Math.max(1, m.h * fh);
  return { cx: (m.x - 0.5) * fw, cy: (m.y - 0.5) * fh, w, h };
}

/** Adds a mask's outline to the current path, in frame-centred coordinates (uses the context's transform). */
export function maskPath(c, m, fw, fh) {
  const { cx, cy, w, h } = maskBox(m, fw, fh);
  const L = (fw + fh) * 4; // "infinite" for split / band
  c.save();
  c.translate(cx, cy);
  c.rotate(((m.rot || 0) * Math.PI) / 180);
  c.beginPath();
  if (m.shape === "split") c.rect(-L, 0, 2 * L, L); // keeps the part below the line
  else if (m.shape === "band") c.rect(-L, -h / 2, 2 * L, h);
  else shapeOutline(c, m.shape, w, h, m.radius);
  c.restore();
}

// ---------- shapes (shape layers and mask outlines) ----------

/** Shape layers: [type, label, group]. Lines and line arrows are drawn as strokes only. */
export const SHAPES = [
  ["rect", "Rectangle", "basic"], ["rounded", "Rounded rectangle", "basic"], ["square", "Square", "basic"], ["circle", "Circle", "basic"],
  ["ellipse", "Ellipse", "basic"], ["triangle", "Triangle", "basic"], ["rtriangle", "Right triangle", "basic"], ["diamond", "Diamond", "basic"],
  ["pentagon", "Pentagon", "basic"], ["hexagon", "Hexagon", "basic"], ["octagon", "Octagon", "basic"], ["star", "Star", "basic"],
  ["star6", "6-point star", "basic"], ["heart", "Heart", "basic"], ["plus", "Plus", "basic"], ["cross", "Cross", "basic"],
  ["bubble", "Speech bubble", "basic"], ["line", "Line", "basic"],
  ["arrow", "Arrow", "arrows"], ["arrow2", "Double arrow", "arrows"], ["chevron", "Chevron", "arrows"], ["larrow", "Line arrow", "arrows"],
  ["larrow2", "Double line arrow", "arrows"], ["carrow", "Curved arrow", "arrows"], ["uarrow", "U-turn arrow", "arrows"],
];
export const LINE_SHAPES = new Set(["line", "larrow", "larrow2", "carrow"]);
export const EQUAL_SIDES = new Set(["square", "circle"]);

const poly = (c, pts) => { pts.forEach(([x, y], i) => c[i ? "lineTo" : "moveTo"](x, y)); c.closePath(); };
const regular = (c, n, w, h, inner = 0, rot = -Math.PI / 2) => {
  const pts = [];
  const k = inner ? 2 * n : n;
  for (let i = 0; i < k; i++) {
    const r = inner && i % 2 ? inner : 1, a = rot + (i * 2 * Math.PI) / k;
    pts.push([(Math.cos(a) * r * w) / 2, (Math.sin(a) * r * h) / 2]);
  }
  poly(c, pts);
};

/** Adds a shape's outline (centred on 0,0, w × h) to the current path. radius: 0–1 corner rounding. */
export function shapeOutline(c, type, w, h, radius = 0) {
  const x = (u) => (u * w) / 2, y = (v) => (v * h) / 2;
  switch (type) {
    case "rect": case "square": case "rounded":
      c.roundRect(-w / 2, -h / 2, w, h, Math.max(0, Math.min(1, radius ?? 0)) * Math.min(w, h) / 2); break;
    case "circle": case "ellipse": c.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case "triangle": poly(c, [[0, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]); break;
    case "rtriangle": poly(c, [[-w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]); break;
    case "diamond": poly(c, [[0, -h / 2], [w / 2, 0], [0, h / 2], [-w / 2, 0]]); break;
    case "pentagon": regular(c, 5, w, h); break;
    case "hexagon": regular(c, 6, w, h, 0, 0); break;
    case "octagon": regular(c, 8, w, h, 0, Math.PI / 8); break;
    case "star": c.save(); c.translate(0, h * 0.06); regular(c, 5, w, h, 0.42); c.restore(); break;
    case "star6": regular(c, 6, w, h, 0.55); break;
    case "heart":
      c.moveTo(x(0), y(1));
      c.bezierCurveTo(x(-0.35), y(0.62), x(-1), y(0.25), x(-1), y(-0.3));
      c.bezierCurveTo(x(-1), y(-0.85), x(-0.4), y(-1.12), x(0), y(-0.55));
      c.bezierCurveTo(x(0.4), y(-1.12), x(1), y(-0.85), x(1), y(-0.3));
      c.bezierCurveTo(x(1), y(0.25), x(0.35), y(0.62), x(0), y(1));
      c.closePath(); break;
    case "plus": case "cross": {
      const t = Math.min(w, h) * 0.17;
      if (type === "cross") { c.save(); c.rotate(Math.PI / 4); }
      poly(c, [[-t, -h / 2], [t, -h / 2], [t, -t], [w / 2, -t], [w / 2, t], [t, t], [t, h / 2], [-t, h / 2], [-t, t], [-w / 2, t], [-w / 2, -t], [-t, -t]]);
      if (type === "cross") c.restore();
      break;
    }
    case "bubble": {
      const bh = h * 0.78, r = Math.min(w, bh) * 0.25;
      c.moveTo(-w / 2 + r, -h / 2);
      c.arcTo(w / 2, -h / 2, w / 2, -h / 2 + bh, r);
      c.arcTo(w / 2, -h / 2 + bh, -w / 2, -h / 2 + bh, r);
      c.lineTo(-w * 0.1, -h / 2 + bh); c.lineTo(-w * 0.28, h / 2); c.lineTo(-w * 0.26, -h / 2 + bh);
      c.arcTo(-w / 2, -h / 2 + bh, -w / 2, -h / 2, r);
      c.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r);
      c.closePath(); break;
    }
    case "line": c.moveTo(-w / 2, 0); c.lineTo(w / 2, 0); break;
    case "larrow": case "larrow2": {
      const hs = Math.min(h / 2, w * 0.25);
      c.moveTo(-w / 2, 0); c.lineTo(w / 2, 0);
      c.moveTo(w / 2 - hs, -hs); c.lineTo(w / 2, 0); c.lineTo(w / 2 - hs, hs);
      if (type === "larrow2") { c.moveTo(-w / 2 + hs, -hs); c.lineTo(-w / 2, 0); c.lineTo(-w / 2 + hs, hs); }
      break;
    }
    case "carrow": {
      // An arc from bottom-left over to bottom-right, with an arrow head at the end.
      const ex = w / 2, ey = h / 2 - h * 0.1, hs = Math.min(w, h) * 0.22;
      c.moveTo(-w / 2, h / 2 - h * 0.1);
      c.quadraticCurveTo(0, -h / 2 - h * 0.45, ex, ey);
      c.moveTo(ex - hs, ey - hs * 0.15); c.lineTo(ex, ey); c.lineTo(ex + hs * 0.1, ey - hs);
      break;
    }
    case "arrow": {
      const sh = h * 0.45, hl = Math.min(w * 0.45, h * 0.9);
      poly(c, [[-w / 2, -sh / 2], [w / 2 - hl, -sh / 2], [w / 2 - hl, -h / 2], [w / 2, 0], [w / 2 - hl, h / 2], [w / 2 - hl, sh / 2], [-w / 2, sh / 2]]);
      break;
    }
    case "arrow2": {
      const sh = h * 0.45, hl = Math.min(w * 0.3, h * 0.9);
      poly(c, [[-w / 2, 0], [-w / 2 + hl, -h / 2], [-w / 2 + hl, -sh / 2], [w / 2 - hl, -sh / 2], [w / 2 - hl, -h / 2], [w / 2, 0],
        [w / 2 - hl, h / 2], [w / 2 - hl, sh / 2], [-w / 2 + hl, sh / 2], [-w / 2 + hl, h / 2]]);
      break;
    }
    case "chevron": {
      const t = Math.min(w * 0.45, h / 2);
      poly(c, [[-w / 2, -h / 2], [w / 2 - t, -h / 2], [w / 2, 0], [w / 2 - t, h / 2], [-w / 2, h / 2], [-w / 2 + t, 0]]);
      break;
    }
    case "uarrow": {
      // A thick U: the right arm, round the bottom, up the left arm to an arrow head pointing up.
      const t = Math.min(w, h) * 0.2, head = t * 0.7, hl = Math.min(h * 0.3, w * 0.35);
      const cx = 0, cy = h / 2 - w / 2, ro = w / 2 - head, ri = ro - t;
      c.moveTo(cx + ro, -h / 2);
      c.lineTo(cx + ro, cy);
      c.arc(cx, cy, ro, 0, Math.PI);
      c.lineTo(cx - ro, -h / 2 + hl);
      c.lineTo(cx - ro - head, -h / 2 + hl);
      c.lineTo(cx - ro + t / 2, -h / 2);
      c.lineTo(cx - ri + head, -h / 2 + hl);
      c.lineTo(cx - ri, -h / 2 + hl);
      c.lineTo(cx - ri, cy);
      c.arc(cx, cy, ri, Math.PI, 0, true);
      c.lineTo(cx + ri, -h / 2);
      c.closePath();
      break;
    }
    default: c.rect(-w / 2, -h / 2, w, h);
  }
}

/** Shape size in canvas pixels (k = canvas width / 1920). */
export const shapeSize = (s, k) => ({ w: s.w * k, h: (EQUAL_SIDES.has(s.type) ? s.w : s.h) * k });

/** Draws a shape layer's shape at the origin (the caller has applied position, rotation and scale). */
function drawShape(c, s, k) {
  const { w, h } = shapeSize(s, k);
  const lw = Math.max(1, (s.strokeW ?? 8) * k);
  c.beginPath();
  shapeOutline(c, s.type, w, h, s.type === "rounded" ? s.radius ?? 0.35 : s.radius);
  c.lineJoin = "round"; c.lineCap = "round"; c.lineWidth = lw;
  if (LINE_SHAPES.has(s.type)) { c.strokeStyle = s.mode === "outline" ? s.stroke || "#fff" : s.fill || "#fff"; c.stroke(); return; }
  if (s.mode !== "outline") { c.fillStyle = s.fill || "#fff"; c.fill(); }
  if (s.mode === "outline" || s.mode === "both") { c.strokeStyle = s.stroke || "#fff"; c.stroke(); }
}

/** A cleared, transparent full-frame canvas for drawing one layer before its effects. */
function layer(W, H) {
  const c = scratch(2, W, H);
  c.clearRect(0, 0, W, H);
  return c;
}

/** Average playback speed of a clip (its constant speed, or the mean of its speed curve). Timeline duration = source span / speed. */
export const clipSpeed = (seg) => meanSpeed(seg);

export const clipTransform = (seg) => seg.transform ?? { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

/**
 * On-screen bounds of a clip or text in canvas fractions: {cx, cy, w, h, rotation}.
 * w is a fraction of the canvas width, h of its height. Ignores in/out animation offsets.
 */
export function itemBounds(project, kind, item, W, H, t) {
  const lt = t == null ? 0 : t - (kind === "main" ? (layoutMain(project).find((s) => s.id === item.id)?.start ?? 0) : item.start);
  if (kind === "main" || kind === "overlay") {
    const media = project.media[item.mediaId];
    if (!media?.w || !media?.h) return null;
    const tr = t == null ? { ...clipTransform(item) } : transformAt(item, lt);
    const fit = Math.min(W / media.w, H / media.h);
    const c = item.crop || NO_CROP;
    const fw = media.w * fit * tr.scale, fh = media.h * fit * tr.scale;
    // The visible (cropped) rectangle's centre, offset from the transform origin, rotated with the item.
    const ox = ((c.l - c.r) / 2) * fw * (item.flipH ? -1 : 1), oy = ((c.t - c.b) / 2) * fh * (item.flipV ? -1 : 1);
    const r = (tr.rotation * Math.PI) / 180;
    const dx = ox * Math.cos(r) - oy * Math.sin(r), dy = ox * Math.sin(r) + oy * Math.cos(r);
    return { cx: tr.x + dx / W, cy: tr.y + dy / H, w: (fw * (1 - c.l - c.r)) / W, h: (fh * (1 - c.t - c.b)) / H, rotation: tr.rotation };
  }
  if (item.shape) {
    const { w, h } = shapeSize(item.shape, W / 1920);
    const sw = item.shape.mode === "fill" && !LINE_SHAPES.has(item.shape.type) ? 0 : (item.shape.strokeW ?? 8) * (W / 1920);
    const tr = t == null ? { x: item.x, y: item.y, scale: item.scale || 1, rotation: item.rotation || 0 } : transformAt(item, lt, true);
    return { cx: tr.x, cy: tr.y, w: ((w + sw) * tr.scale) / W, h: ((h + sw) * tr.scale) / H, rotation: tr.rotation };
  }
  const st = item.style;
  const size = st.size * (W / 1920);
  const m = measureCtx();
  m.font = textFont(st, size);
  const lines = wrap(m, applyCase(item.text, st), wrapWidth(item, W));
  const pad = st.bg ? size * (st.bgPad ?? 0.6) : size * 0.2;
  const spacing = (st.letterSpacing || 0) * size;
  const tw = Math.max(...lines.map((l) => m.measureText(l).width + Math.max(0, l.length - 1) * spacing)) + pad;
  const th = lines.length * size * (st.lineHeight || 1.2) + size * 0.2;
  const tr = t == null ? { x: item.x, y: item.y, scale: item.scale || 1, rotation: item.rotation || 0 } : transformAt(item, lt, true);
  return { cx: tr.x, cy: tr.y, w: (tw * tr.scale) / W, h: (th * tr.scale) / H, rotation: tr.rotation };
}

let _measure;
const measureCtx = () => (_measure ??= new OffscreenCanvas(1, 1).getContext("2d"));

/** True if canvas-fraction point (px, py) falls inside bounds b (rotation-aware). */
export function hitTest(b, px, py, W, H) {
  if (!b) return false;
  const r = (-b.rotation * Math.PI) / 180;
  const dx = (px - b.cx) * W, dy = (py - b.cy) * H;
  const lx = dx * Math.cos(r) - dy * Math.sin(r);
  const ly = dx * Math.sin(r) + dy * Math.cos(r);
  return Math.abs(lx) <= (b.w * W) / 2 && Math.abs(ly) <= (b.h * H) / 2;
}

/** CSS font shorthand for a text style at pixel size. */
export const textFont = (st, size) => `${st.italic ? "italic " : ""}${st.weight} ${size}px ${st.font}`;
const applyCase = (text, st) => (st.uppercase ? text.toUpperCase() : text);

export function drawText(ctx, item, t, W, H) {
  const lt = t - item.start;
  if (lt < 0 || lt >= item.dur) return;
  const st = item.style;
  const a = animState(item.anim, lt, item.dur);
  const tr = transformAt(item, lt, true);
  if (tr.opacity <= 0) return;
  const size = st.size * (W / 1920);
  ctx.save();
  ctx.globalAlpha = a.alpha * tr.opacity;
  ctx.translate(tr.x * W + a.dx * W, tr.y * H + a.dy * H);
  ctx.rotate((tr.rotation * Math.PI) / 180);
  ctx.scale(a.scale * tr.scale, a.scale * tr.scale);
  if (item.shape) { drawShape(ctx, item.shape, W / 1920); ctx.restore(); return; }
  ctx.font = textFont(st, size);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  // Captions carry per-word timing; plain text is split into words for layout only.
  const words = item.words?.length
    ? item.words
    : item.text.split(/(\s+)/).filter(Boolean).map((w) => ({ w }));
  let full = applyCase(words.map((w) => w.w).join(""), st);
  if (a.reveal < 1) full = full.slice(0, Math.round(full.length * a.reveal));
  const lines = wrap(ctx, full, wrapWidth(item, W));
  const lh = size * (st.lineHeight || 1.2);
  const y0 = -((lines.length - 1) * lh) / 2;
  const spacing = (st.letterSpacing || 0) * size;
  const lineW = (l) => ctx.measureText(l).width + Math.max(0, [...l].length - 1) * spacing;
  const maxW = Math.max(...lines.map(lineW));

  if (st.bg) {
    const pad = size * (st.bgPad ?? 0.6);
    const bw = maxW + pad;
    ctx.fillStyle = st.bg;
    roundRect(ctx, -bw / 2, y0 - lh / 2 - size * 0.15, bw, lines.length * lh + size * 0.3, size * (st.bgRadius ?? 0.25));
    ctx.fill();
  }

  // Active caption word (karaoke-style highlight).
  const activeWord = item.words?.findIndex((w) => t >= w.t0 && t < w.t1) ?? -1;
  let charIndex = 0;
  const activeRange = activeWord >= 0
    ? (() => {
        let s = 0;
        for (let i = 0; i < activeWord; i++) s += item.words[i].w.length;
        const w = item.words[activeWord].w;
        const lead = w.length - w.trimStart().length;
        return [s + lead, s + w.length];
      })()
    : null;

  const shadow = st.shadow;
  const setShadow = (on) => {
    if (!shadow) return;
    ctx.shadowColor = on ? shadow.color || "#000000aa" : "transparent";
    ctx.shadowBlur = on ? (shadow.blur ?? 8) * (W / 1920) : 0;
    ctx.shadowOffsetX = on ? (shadow.x ?? 4) * (W / 1920) : 0;
    ctx.shadowOffsetY = on ? (shadow.y ?? 4) * (W / 1920) : 0;
  };

  lines.forEach((line, li) => {
    const y = y0 + li * lh;
    const lw = lineW(line);
    let x = st.align === "left" ? -maxW / 2 : st.align === "right" ? maxW / 2 - lw : -lw / 2;
    ctx.textAlign = "left";
    if (st.underline && lw > 0) {
      ctx.fillStyle = st.color;
      setShadow(true);
      ctx.fillRect(x, y + size * 0.45, lw, Math.max(1, size * 0.07));
      setShadow(false);
    }
    for (const ch of line) {
      const cw = ctx.measureText(ch).width;
      const hl = activeRange && charIndex >= activeRange[0] && charIndex < activeRange[1];
      setShadow(true);
      if (st.strokeWidth > 0) {
        ctx.strokeStyle = st.stroke;
        ctx.lineWidth = st.strokeWidth * (W / 1920) * 2;
        ctx.strokeText(ch, x, y);
        setShadow(false);
      }
      ctx.fillStyle = hl ? st.highlight : st.color;
      ctx.fillText(ch, x, y);
      setShadow(false);
      x += cw + spacing;
      charIndex++;
    }
    charIndex++; // the space consumed by wrapping
  });
  ctx.restore();
}

/**
 * Where a text's lines break, in its own (unscaled) pixels: the text box width the user dragged
 * (item.boxW, a fraction of the frame width), 85% of the frame by default, or never with item.oneLine
 * (then only Enter starts a new line). Scaling the text doesn't move the breaks.
 */
export const wrapWidth = (item, W) => (item.oneLine ? Infinity : (item.boxW ?? 0.85) * W);

function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      const test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxW && line) {
        out.push(line);
        line = word;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draws the full composition at time t into a 2D context sized project.width x height. */
/** Whether the last preview frame had a clip whose video wasn't ready yet (the player shows "Loading…"). */
export const frameStatus = { loading: false };

export function drawFrame(ctx, project, t, opts = {}) {
  if (!opts.nested) frameStatus.loading = false;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  // Inside a compound clip with nothing on its main track, empty areas stay see-through.
  if (!opts.nested || project.main.length) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
  }
  const { clips, transition } = activeClips(project, t);
  const hidden = (key) => !!project.trackState?.[key]?.hidden;
  if (hidden("main")) { /* main track hidden: nothing drawn from it */ }
  else if (transition) {
    const A = scratch(depth * 2, W, H), B = scratch(depth * 2 + 1, W, H);
    A.clearRect(0, 0, W, H); B.clearRect(0, 0, W, H);
    A.fillStyle = B.fillStyle = "#000";
    A.fillRect(0, 0, W, H); B.fillRect(0, 0, W, H);
    drawClip(A, project, transition.a, W, H);
    drawClip(B, project, transition.b, W, H);
    ctx.drawImage(renderTransition(transition.type, A.canvas, B.canvas, transition.p, W, H), 0, 0);
  } else if (clips[0]) {
    drawClip(ctx, project, clips[0], W, H);
  }
  for (const o of activeOverlays(project, t)) if (!hidden(`overlay:${o.item.track ?? 0}`)) drawVisual(ctx, project, o.item, o.local, W, H);
  // Timeline effects apply to everything under them (not to the texts above).
  for (const e of activeTimed(project.effects, t)) {
    if (hidden(`effect:${e.item.track ?? 0}`)) continue;
    const fx = fxSettingsAt(e.item, e.local);
    if (!fx) continue;
    const out = applyFx(ctx.canvas, fx, e.local, W, H);
    ctx.save();
    ctx.globalAlpha = valueAt(e.item, "opacity", e.local, e.item.opacity ?? 1);
    ctx.drawImage(out, 0, 0, W, H);
    ctx.restore();
  }
  // Texts on higher text tracks draw on top (like the timeline rows).
  if (!hidden("text")) for (const item of [...project.texts].sort((a, b) => (a.track ?? 0) - (b.track ?? 0))) drawText(ctx, item, t, W, H);
}

/** Items of a lane (overlays, audio, effects) visible at t, with local and source time. */
export function activeTimed(list, t) {
  const out = [];
  for (const item of list || []) {
    if (t < item.start || t >= item.start + item.dur) continue;
    const local = t - item.start;
    out.push({ item, local, sourceTime: sourceAt(item, local) });
  }
  return out;
}

/**
 * When a text's sound starts, in seconds after the text starts. text.sound.when:
 *  "anim" (default) — as the in-animation is nearly done (85% through it), so the sound lands as the text settles
 *  "start" — as soon as the text appears
 *  "custom" — text.sound.delay seconds after it appears
 */
export function textSoundOffset(text) {
  const s = text.sound || {};
  if (s.when === "start") return 0;
  if (s.when === "custom") return Math.max(0, s.delay || 0);
  const a = text.anim?.in;
  return a && a.type !== "none" ? (a.dur || 0) * 0.85 : 0;
}

/** Text sounds as audio items, so they play and export like any other audio (they move with their text). */
export function textSounds(project) {
  const out = [];
  for (const t of project.texts || []) {
    const s = t.sound;
    const media = s && project.media[s.mediaId];
    if (!media || media.missing) continue;
    const dur = Math.max(0.05, (media.duration || 1) - (s.in || 0));
    out.push({ id: t.id + "~snd", mediaId: s.mediaId, start: t.start + textSoundOffset(t), in: s.in || 0, dur,
      audio: { volume: s.volume ?? 1 }, ...(s.mute ? { mute: true } : {}), track: "text" });
  }
  return out;
}

/** Overlay layers at t, bottom track first. */
export const activeOverlays = (project, t) => activeTimed(project.overlays, t).sort((a, b) => (a.item.track ?? 0) - (b.item.track ?? 0));

const scratchCtx = [];
function scratch(i, W, H) {
  if (!scratchCtx[i]) scratchCtx[i] = new OffscreenCanvas(W, H).getContext("2d");
  const c = scratchCtx[i];
  if (c.canvas.width !== W || c.canvas.height !== H) { c.canvas.width = W; c.canvas.height = H; }
  return c;
}

// ---------- GPU transitions ----------

export const TRANSITIONS = {
  crossfade: "Cross fade",
  fadeBlack: "Fade to black",
  wipe: "Wipe",
  slide: "Slide",
  zoom: "Zoom blur",
  circle: "Circle reveal",
  glitch: "Glitch",
  pushUp: "Push up",
  wipeDown: "Wipe down",
  pixelate: "Pixelate",
  flash: "Flash",
  spin: "Spin",
  dissolve: "Dissolve",
  wipeLeft: "Wipe left",
  slideRight: "Slide right",
  pushDown: "Push down",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  blur: "Blur",
  ripple: "Ripple",
  swirl: "Swirl",
  diagonal: "Diagonal wipe",
  clock: "Clock wipe",
  barnDoor: "Barn door",
  heart: "Heart",
  zoomPush: "Zoom push (in)",
  zoomPull: "Zoom pull (out)",
  whip: "Whip",
};

const FRAG = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 o;
uniform sampler2D A, B;
uniform float p;
uniform float aspect;
uniform int mode;
float rnd(vec2 c){ return fract(sin(dot(c, vec2(12.9898,78.233))) * 43758.5453); }
vec4 zoomBlur(sampler2D t, vec2 c, float s){
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 12; i++) acc += texture(t, (c - 0.5) * (1.0 - s * float(i) / 12.0) + 0.5);
  return acc / 12.0;
}
void main(){
  vec2 f = vec2(uv.x, 1.0 - uv.y);
  if (mode == 0) { o = mix(texture(A,f), texture(B,f), p); }
  else if (mode == 1) { o = p < 0.5 ? texture(A,f) * (1.0 - p*2.0) : texture(B,f) * (p*2.0 - 1.0); }
  else if (mode == 2) { float e = smoothstep(p - 0.05, p + 0.05, f.x); o = mix(texture(B,f), texture(A,f), e); }
  else if (mode == 3) { o = f.x < 1.0 - p ? texture(A, vec2(f.x + p, f.y)) : texture(B, vec2(f.x - (1.0 - p), f.y)); }
  else if (mode == 4) { float s = sin(p * 3.14159) * 0.35; o = mix(zoomBlur(A,f,s), zoomBlur(B,f,s), smoothstep(0.4,0.6,p)); }
  else if (mode == 5) { vec2 d = (f - 0.5) * vec2(aspect, 1.0); float r = length(d) / length(vec2(aspect, 1.0) * 0.5);
    float e = smoothstep(p - 0.02, p + 0.02, r); o = mix(texture(B,f), texture(A,f), e); }
  else if (mode == 7) { o = f.y < 1.0 - p ? texture(A, vec2(f.x, f.y + p)) : texture(B, vec2(f.x, f.y - (1.0 - p))); }
  else if (mode == 8) { float e = smoothstep(p - 0.05, p + 0.05, f.y); o = mix(texture(B,f), texture(A,f), e); }
  else if (mode == 9) {
    float s = 0.002 + sin(p * 3.14159) * 0.05;
    vec2 g = (floor(f / vec2(s / aspect, s)) + 0.5) * vec2(s / aspect, s);
    o = p < 0.5 ? texture(A, g) : texture(B, g);
  }
  else if (mode == 10) { vec4 base = p < 0.5 ? texture(A,f) : texture(B,f); o = mix(base, vec4(1.0), smoothstep(0.0, 1.0, 1.0 - abs(p * 2.0 - 1.0))); }
  else if (mode == 11) {
    float ang = (p < 0.5 ? p : p - 1.0) * 3.14159;
    float s = 1.0 + sin(p * 3.14159) * 1.5;
    vec2 d = (f - 0.5) * vec2(aspect, 1.0);
    d = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * d * s;
    vec2 g = d / vec2(aspect, 1.0) + 0.5;
    bool inside = all(greaterThanEqual(g, vec2(0.0))) && all(lessThanEqual(g, vec2(1.0)));
    o = inside ? (p < 0.5 ? texture(A, g) : texture(B, g)) : vec4(0.0, 0.0, 0.0, 1.0);
  }
  else if (mode == 12) { float n = rnd(floor(f * vec2(aspect * 90.0, 90.0))); o = n < p ? texture(B,f) : texture(A,f); }
  else if (mode == 13) { float e = smoothstep(p - 0.05, p + 0.05, 1.0 - f.x); o = mix(texture(B,f), texture(A,f), e); }
  else if (mode == 14) { o = f.x > p ? texture(A, vec2(f.x - p, f.y)) : texture(B, vec2(f.x + (1.0 - p), f.y)); }
  else if (mode == 15) { o = f.y > p ? texture(A, vec2(f.x, f.y - p)) : texture(B, vec2(f.x, f.y + (1.0 - p))); }
  else if (mode == 16) { vec4 a = texture(A, (f - 0.5) / (1.0 + p * 1.5) + 0.5); o = mix(a, texture(B, f), smoothstep(0.3, 1.0, p)); }
  else if (mode == 17) { vec4 b = texture(B, (f - 0.5) * (2.0 - p) + 0.5); o = mix(texture(A, f), b, smoothstep(0.0, 0.7, p)); }
  else if (mode == 18) { float s = sin(p * 3.14159) * 0.02; vec4 a = vec4(0.0), b = vec4(0.0);
    for (int i = 0; i < 12; i++) { float ang = float(i) * 0.5236; vec2 off = vec2(cos(ang), sin(ang) * aspect) * s;
      a += texture(A, f + off); b += texture(B, f + off); }
    o = mix(a / 12.0, b / 12.0, smoothstep(0.35, 0.65, p)); }
  else if (mode == 19) { vec2 d = (f - 0.5) * vec2(aspect, 1.0); float r = length(d); float k = sin(p * 3.14159);
    vec2 g = f + normalize(d + 1e-5) / vec2(aspect, 1.0) * sin(r * 50.0 - p * 30.0) * 0.02 * k;
    o = mix(texture(A, g), texture(B, g), smoothstep(0.3, 0.7, p)); }
  else if (mode == 20) { vec2 d = (f - 0.5) * vec2(aspect, 1.0); float k = sin(p * 3.14159) * 6.0 * smoothstep(0.7, 0.0, length(d));
    d = mat2(cos(k), -sin(k), sin(k), cos(k)) * d; vec2 g = d / vec2(aspect, 1.0) + 0.5;
    o = mix(texture(A, g), texture(B, g), smoothstep(0.4, 0.6, p)); }
  else if (mode == 21) { float e = smoothstep(p * 2.2 - 0.1, p * 2.2 + 0.1, f.x + f.y); o = mix(texture(B,f), texture(A,f), e); }
  else if (mode == 22) { vec2 d = f - 0.5; float ang = atan(d.x, -d.y) / 6.28318 + 0.5; float e = smoothstep(p - 0.01, p + 0.01, ang);
    o = mix(texture(B,f), texture(A,f), e); }
  else if (mode == 23) { float e = smoothstep(p - 0.03, p + 0.03, abs(f.x - 0.5) * 2.0); o = mix(texture(B,f), texture(A,f), e); }
  // Zoom push: the outgoing shot rushes in with a radial blur, the next one settles out of it.
  else if (mode == 25) { float s = p < 0.5 ? p * 2.0 : (1.0 - p) * 2.0; s = s * s;
    vec2 c = (f - 0.5) / (1.0 + s * 1.6) + 0.5; o = p < 0.5 ? zoomBlur(A, c, s * 0.35) : zoomBlur(B, c, s * 0.35); }
  // Zoom pull: the outgoing shot shrinks away with blur, the next one comes in from slightly larger.
  else if (mode == 26) { float s = p < 0.5 ? p * 2.0 : (1.0 - p) * 2.0; s = s * s;
    vec2 m = (f - 0.5) * (1.0 + s * 0.9) + 0.5; m = 1.0 - abs(1.0 - mod(m + 2.0, 2.0)); // mirror past the edges
    o = p < 0.5 ? zoomBlur(A, m, s * 0.25)
                : zoomBlur(B, (f - 0.5) / (1.0 + s * 0.6) + 0.5, s * 0.25); }
  // Whip: the picture is flung vertically with heavy motion blur into the next shot.
  else if (mode == 27) { float e = p * p * (3.0 - 2.0 * p); float bl = sin(p * 3.14159) * 0.18; vec4 acc = vec4(0.0);
    for (int i = 0; i < 14; i++) { float y = f.y + e + bl * (float(i) / 13.0 - 0.5);
      acc += y < 1.0 ? texture(A, vec2(f.x, clamp(y, 0.0, 1.0))) : texture(B, vec2(f.x, clamp(y - 1.0, 0.0, 1.0))); }
    o = acc / 14.0; }
  else if (mode == 24) { vec2 q = (f - vec2(0.5, 0.45)) * vec2(aspect, 1.0) / max(p * 2.2, 1e-3) * 1.6;
    q.y = -q.y + 0.25; float h = pow(q.x * q.x + q.y * q.y - 1.0, 3.0) - q.x * q.x * q.y * q.y * q.y;
    o = (h < 0.0 || p > 0.98) ? texture(B, f) : texture(A, f); }
  else {
    float k = sin(p * 3.14159);
    float band = step(0.5, rnd(vec2(floor(f.y * 24.0), floor(p * 20.0))));
    vec2 g = vec2(f.x + (band - 0.5) * 0.12 * k, f.y);
    vec4 a = vec4(texture(A, g + vec2(0.01*k,0)).r, texture(A, g).g, texture(A, g - vec2(0.01*k,0)).b, 1.0);
    vec4 b = vec4(texture(B, g + vec2(0.01*k,0)).r, texture(B, g).g, texture(B, g - vec2(0.01*k,0)).b, 1.0);
    o = p < 0.5 ? a : b;
  }
}`;

let gl = null, prog = null, texA = null, texB = null;
function initGL(W, H) {
  const canvas = new OffscreenCanvas(W, H);
  gl = canvas.getContext("webgl2", { premultipliedAlpha: false });
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, `#version 300 es
    in vec2 pos; out vec2 uv;
    void main(){ uv = pos * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }`));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "pos");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const mk = (unit) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };
  texA = mk(0);
  texB = mk(1);
  gl.uniform1i(gl.getUniformLocation(prog, "A"), 0);
  gl.uniform1i(gl.getUniformLocation(prog, "B"), 1);
}

function renderTransition(type, a, b, p, W, H) {
  if (!gl) initGL(W, H);
  if (gl.canvas.width !== W || gl.canvas.height !== H) { gl.canvas.width = W; gl.canvas.height = H; }
  gl.viewport(0, 0, W, H);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texB);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, b);
  gl.uniform1f(gl.getUniformLocation(prog, "p"), p);
  gl.uniform1f(gl.getUniformLocation(prog, "aspect"), W / H);
  gl.uniform1i(gl.getUniformLocation(prog, "mode"), Object.keys(TRANSITIONS).indexOf(type));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return gl.canvas;
}

// ---------- syncing video elements to a timeline time ----------

/**
 * Positions every video element for time t. When `playing`, active clips play and are
 * nudged only on drift; otherwise they are seeked exactly. Resolves when frames are ready.
 */
export function syncMedia(project, t, playing) {
  const active = new Set();
  const waits = [];
  syncInto(project, t, playing, active, waits, { muted: false, rate: 1, vol: 1, level: 0 });
  for (const [id, el] of elements) {
    if (!active.has(id) && el instanceof HTMLMediaElement && !el.paused) el.pause();
  }
  if (playing) prerollUpcoming(project, t, active);
  return Promise.all(waits);
}

/** Positions the players of one timeline; compound clips recurse with their speed, volume and mute. */
function syncInto(project, t, playing, active, waits, outer) {
  const { clips } = activeClips(project, t);
  const nested = (item, lt, sourceTime, media, muted, frozen) => {
    if (outer.level >= MAX_DEPTH || !media.sequence) return;
    syncInto(compoundView(project, media, item.id), sourceTime, playing && !frozen, active, waits, {
      muted, rate: outer.rate * rateAt(item, lt), vol: outer.vol * volumeAt(item, lt), level: outer.level + 1,
    });
  };
  const position = (item, lt, el, sourceTime, frozen, muted) => {
    el.muted = muted;
    if (!muted) {
      const vol = volumeAt(item, lt) * outer.vol;
      const media = project.media[item.mediaId];
      const level = item.audio?.normalize ? levelFor(media) ?? 1 : 1;
      if (needsLiveRoute(item, vol) || isRouted(el)) routeLive(el, item, vol, level);
      else el.volume = Math.max(0, Math.min(1, vol));
    }
    if (playing && !frozen) {
      // Follow the speed (curve), and catch up gently on small drift by nudging the rate instead of seeking.
      const drift = sourceTime - el.currentTime;
      const rate = Math.max(0.0625, Math.min(16, rateAt(item, lt) * outer.rate + Math.max(-0.5, Math.min(0.5, drift * 2.5))));
      if (Math.abs(el.playbackRate - rate) > 0.005) el.playbackRate = rate;
      if (Math.abs(el.currentTime - sourceTime) > 0.3 * Math.max(1, rate)) el.currentTime = sourceTime;
      if (el.paused) el.play().catch(() => {});
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - sourceTime) > 1 / 120 || el.readyState < 2) {
        waits.push(seekTo(el, sourceTime));
      }
    }
  };
  for (const c of clips) {
    const media = project.media[c.seg.mediaId];
    if (!media) continue;
    active.add(c.seg.id);
    // Inside a transition one side is "frozen" on its first/last frame.
    const frozen = t < c.seg.start || t >= c.seg.start + c.seg.dur;
    const muted = outer.muted || !playing || frozen || clips.length > 1 && c !== clips[0] || !!c.seg.mute || !!project.trackState?.main?.muted;
    if (media.kind === "compound") { nested(c.seg, c.local, c.sourceTime, media, muted, frozen); continue; }
    const el = elementFor(c.seg, media);
    if (!(el instanceof HTMLMediaElement)) {
      if (!el.complete) waits.push(new Promise((r) => (el.onload = r)));
      continue;
    }
    position(c.seg, c.local, el, c.sourceTime, frozen, muted);
  }
  for (const list of [project.overlays, project.audio, textSounds(project)]) {
    for (const o of activeTimed(list, t)) {
      const media = project.media[o.item.mediaId];
      if (!media) continue;
      active.add(o.item.id);
      const lane = list === project.overlays ? "overlay" : "audio";
      const muted = outer.muted || !playing || !!o.item.mute || !!project.trackState?.[`${lane}:${o.item.track ?? 0}`]?.muted;
      if (media.kind === "compound") { nested(o.item, o.local, o.sourceTime, media, muted, false); continue; }
      const el = elementFor(o.item, media);
      if (!(el instanceof HTMLMediaElement)) {
        if (!el.complete) waits.push(new Promise((r) => (el.onload = r)));
        continue;
      }
      position(o.item, o.local, el, o.sourceTime, false, muted);
    }
  }
}

/**
 * While playing, parks the player of every clip that starts within the next 1.5 s on its first frame, so
 * at the cut it can start straight away instead of briefly showing wherever it was left (e.g. the other
 * half of a split clip).
 */
function prerollUpcoming(project, t, active) {
  const soon = [];
  for (const s of layoutMain(project)) if (s.start > t && s.start - t < 1.5) soon.push(s);
  for (const list of [project.overlays, project.audio, textSounds(project)]) for (const x of list || []) if (x.start > t && x.start - t < 1.5) soon.push(x);
  for (const item of soon) {
    if (active.has(item.id)) continue;
    const media = project.media[item.mediaId];
    if (!media || media.kind === "image" || media.kind === "compound") continue;
    const el = elementFor(item, media);
    if (!(el instanceof HTMLMediaElement) || !el.paused || el.seeking) continue;
    const start = sourceAt(item, 0);
    if (Math.abs(el.currentTime - start) > 0.03) seekTo(el, start);
  }
}

/**
 * True when every visible video is showing (about) the right moment. During playback the render loop
 * holds the previous frame while a player is still seeking, instead of flashing the wrong frame.
 */
export function framesReady(project, t, level = 0) {
  const check = (item, lt, sourceTime) => {
    const media = project.media[item.mediaId];
    if (media?.kind === "compound") return level >= MAX_DEPTH || !media.sequence || framesReady(compoundView(project, media, item.id), sourceTime, level + 1);
    const el = elements.get(item.id);
    if (!(el instanceof HTMLVideoElement)) return true;
    if (el.readyState < 2 || el.seeking) return false;
    return Math.abs(el.currentTime - sourceTime) <= 0.25 * Math.max(1, rateAt(item, lt));
  };
  const { clips } = activeClips(project, t);
  for (const c of clips) {
    if (t < c.seg.start || t >= c.seg.start + c.seg.dur) continue; // frozen side of a transition
    if (!check(c.seg, c.local, c.sourceTime)) return false;
  }
  for (const o of activeTimed(project.overlays, t)) if (!check(o.item, o.local, o.sourceTime)) return false;
  return true;
}

/** Live preview volume (0..1) from the volume setting, its keyframes and fades. Louder than 100% plays through audiofx. */
export function liveVolume(item, lt) {
  return Math.max(0, Math.min(1, volumeAt(item, lt)));
}

/** Volume multiplier at local time: base volume (keyframable) x fade in/out. */
export function volumeAt(item, lt) {
  const au = item.audio || {};
  let v = valueAt(item, "volume", lt, au.volume ?? 1);
  if (au.fadeIn > 0 && lt < au.fadeIn) v *= Math.max(0, lt / au.fadeIn);
  if (au.fadeOut > 0 && lt > item.dur - au.fadeOut) v *= Math.max(0, (item.dur - lt) / au.fadeOut);
  return v;
}

// One seek in flight per element. Chromium cancels a running seek whenever currentTime is set again, so
// re-seeking on every frame while scrubbing would never show a picture until the mouse stops. Instead a new
// target replaces the queued one and is sought as soon as the running seek lands: frames keep coming.
const pendingSeeks = new WeakMap(); // el -> { time, promise }

function seekTo(el, time) {
  const running = pendingSeeks.get(el);
  if (running) {
    running.time = time;
    return running.promise;
  }
  let resolve, timer, issued = null;
  const st = { time, promise: new Promise((r) => (resolve = r)) };
  const finish = () => {
    clearTimeout(timer);
    el.removeEventListener("seeked", landed);
    el.removeEventListener("loadeddata", landed);
    if (pendingSeeks.get(el) === st) pendingSeeks.delete(el);
    resolve();
  };
  const go = () => {
    clearTimeout(timer);
    timer = setTimeout(finish, 2000); // never hang on a bad frame
    issued = st.time;
    el.currentTime = st.time;
  };
  // Seeking to the current position doesn't always fire "seeked"; first-frame data arriving also counts.
  const landed = () => (issued !== null && Math.abs(st.time - issued) > 1e-4 ? go() : finish());
  el.addEventListener("seeked", landed);
  el.addEventListener("loadeddata", landed);
  pendingSeeks.set(el, st);
  if (el.readyState === 0) {
    timer = setTimeout(finish, 2000);
    el.addEventListener("loadedmetadata", go, { once: true });
  } else go();
  return st.promise;
}
