// Rendering engine: decides what is visible at time t and draws it.
// Clips use Canvas 2D; transitions blend two clip frames in a WebGL shader; colour, filters and
// effects run in fx.js. Layer order, bottom to top: main track → overlay tracks → timeline effects → texts.
import { layoutMain } from "./store.js";
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

export function elementFor(seg, media) {
  let el = elements.get(seg.id);
  if (el && el.dataset.src === media.url) return el;
  if (media.kind === "image") {
    el = new Image();
    el.src = media.url;
  } else if (media.kind === "audio") {
    el = new Audio();
    el.src = media.url;
    el.preload = "auto";
  } else {
    el = document.createElement("video");
    el.src = media.url;
    el.preload = "auto";
    el.playsInline = true;
    el.crossOrigin = "anonymous";
  }
  el.dataset.src = media.url;
  elements.set(seg.id, el);
  return el;
}

export function allVideoElements() {
  return [...elements.values()].filter((e) => e instanceof HTMLMediaElement);
}

/** The media element already created for an item, if any. */
export const existingElement = (id) => elements.get(id);

/** Which main segments are visible at t, and what source time each should show. */
export function activeClips(project, t) {
  const segs = layoutMain(project);
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const end = seg.start + seg.dur;
    // A transition straddles the cut between seg and the next one: [cut - d/2, cut + d/2].
    const tr = seg.transition && segs[i + 1] ? seg.transition : null;
    const half = tr ? tr.dur / 2 : 0;
    const prevTr = i > 0 && segs[i - 1].transition ? segs[i - 1].transition.dur / 2 : 0;
    if (t >= seg.start - prevTr && t < end + half) {
      const local = Math.max(0, Math.min(seg.dur - 1e-3, t - seg.start));
      out.push({ seg, index: i, local, sourceTime: sourceAt(seg, local) });
    }
  }
  // Transition progress if two clips overlap in this window.
  let transition = null;
  if (out.length === 2) {
    const [a, b] = out;
    const cut = b.seg.start;
    const d = a.seg.transition.dur;
    transition = { type: a.seg.transition.type, p: clamp01((t - (cut - d / 2)) / d), a, b };
  }
  return { clips: out, transition };
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
const sizeOf = (el, media) => [el.displayWidth || el.videoWidth || el.naturalWidth || media.w, el.displayHeight || el.videoHeight || el.naturalHeight || media.h];

/**
 * Draws a main-track clip or an overlay layer at its local time `lt`: keyframed transform and opacity,
 * crop, flips, cutout, colour/filters/effects and blend mode. Items without any of those take the
 * original direct path, so older projects render exactly as before.
 */
function drawVisual(ctx, project, item, lt, W, H) {
  const media = project.media[item.mediaId];
  if (!media || media.kind === "audio") return;
  // During export a decoded VideoFrame may stand in for the <video> element.
  const el = exportFrames.get(item.id) || elementFor(item, media);
  const [sw, sh] = sizeOf(el, media);
  if (!sw || !sh) return;
  const a = animState(item.anim, lt, item.dur);
  const tr = transformAt(item, lt);
  const crop = item.crop || NO_CROP;
  const fit = Math.min(W / sw, H / sh);
  const fx = fxSettingsAt(item, lt);
  const src = (item.cutout?.mode && cutoutFrame(item, el, sw, sh)) || el;
  const target = fx ? layer(W, H) : ctx;
  target.save();
  if (!fx) {
    target.globalAlpha = a.alpha * tr.opacity;
    if (item.blend && item.blend !== "normal") target.globalCompositeOperation = BLEND_MODES[item.blend]?.[1] || "source-over";
  }
  target.translate(tr.x * W + a.dx * W, tr.y * H + a.dy * H);
  target.rotate((tr.rotation * Math.PI) / 180);
  target.scale(a.scale * tr.scale * (item.flipH ? -1 : 1), a.scale * tr.scale * (item.flipV ? -1 : 1));
  const sx = crop.l * sw, sy = crop.t * sh;
  const cw = sw * (1 - crop.l - crop.r), ch = sh * (1 - crop.t - crop.b);
  if (cw > 0.5 && ch > 0.5) target.drawImage(src, sx, sy, cw, ch, (-sw * fit) / 2 + sx * fit, (-sh * fit) / 2 + sy * fit, cw * fit, ch * fit);
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
  const st = item.style;
  const size = st.size * (W / 1920);
  const m = measureCtx();
  m.font = textFont(st, size);
  const lines = wrap(m, applyCase(item.text, st), W * 0.85);
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
  const lines = wrap(ctx, full, W * 0.85);
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
export function drawFrame(ctx, project, t) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);
  const { clips, transition } = activeClips(project, t);
  const hidden = (key) => !!project.trackState?.[key]?.hidden;
  if (hidden("main")) { /* main track hidden: nothing drawn from it */ }
  else if (transition) {
    const A = scratch(0, W, H), B = scratch(1, W, H);
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
  if (!hidden("text")) for (const item of project.texts) drawText(ctx, item, t, W, H);
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
  const { clips } = activeClips(project, t);
  const active = new Set(clips.map((c) => c.seg.id));
  const waits = [];
  const position = (item, lt, el, sourceTime, frozen, muted) => {
    el.muted = muted;
    if (!muted) {
      const vol = volumeAt(item, lt);
      const media = project.media[item.mediaId];
      const level = item.audio?.normalize ? levelFor(media) ?? 1 : 1;
      if (needsLiveRoute(item, vol) || isRouted(el)) routeLive(el, item, vol, level);
      else el.volume = Math.max(0, Math.min(1, vol));
    }
    if (playing && !frozen) {
      // Follow the speed (curve), and catch up gently on small drift by nudging the rate instead of seeking.
      const drift = sourceTime - el.currentTime;
      const rate = Math.max(0.0625, Math.min(16, rateAt(item, lt) + Math.max(-0.5, Math.min(0.5, drift * 2.5))));
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
    const el = elementFor(c.seg, project.media[c.seg.mediaId]);
    if (!(el instanceof HTMLMediaElement)) {
      if (!el.complete) waits.push(new Promise((r) => (el.onload = r)));
      continue;
    }
    // Inside a transition one side is "frozen" on its first/last frame.
    const frozen = t < c.seg.start || t >= c.seg.start + c.seg.dur;
    const muted = !playing || frozen || clips.length > 1 && c !== clips[0] || !!c.seg.mute || !!project.trackState?.main?.muted;
    position(c.seg, c.local, el, c.sourceTime, frozen, muted);
  }
  for (const list of [project.overlays, project.audio]) {
    for (const o of activeTimed(list, t)) {
      const media = project.media[o.item.mediaId];
      if (!media) continue;
      active.add(o.item.id);
      const el = elementFor(o.item, media);
      if (!(el instanceof HTMLMediaElement)) {
        if (!el.complete) waits.push(new Promise((r) => (el.onload = r)));
        continue;
      }
      const lane = list === project.audio ? "audio" : "overlay";
      position(o.item, o.local, el, o.sourceTime, false, !playing || !!o.item.mute || !!project.trackState?.[`${lane}:${o.item.track ?? 0}`]?.muted);
    }
  }
  for (const [id, el] of elements) {
    if (!active.has(id) && el instanceof HTMLMediaElement && !el.paused) el.pause();
  }
  return Promise.all(waits);
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

// One in-flight seek per element: re-issuing the same seek every frame would restart it forever.
const pendingSeeks = new WeakMap(); // el -> { time, promise }

function seekTo(el, time) {
  const pending = pendingSeeks.get(el);
  if (pending && Math.abs(pending.time - time) < 1e-4) return pending.promise;
  const promise = new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      el.removeEventListener("seeked", done);
      el.removeEventListener("loadeddata", done);
      if (pendingSeeks.get(el)?.promise === promise) pendingSeeks.delete(el);
      resolve();
    };
    el.addEventListener("seeked", done);
    // Seeking to the current position doesn't always fire "seeked"; first-frame data arriving also counts.
    el.addEventListener("loadeddata", done);
    if (el.readyState === 0) el.addEventListener("loadedmetadata", () => (el.currentTime = time), { once: true });
    else el.currentTime = time;
    setTimeout(done, 2000); // never hang on a bad frame
  });
  pendingSeeks.set(el, { time, promise });
  return promise;
}
