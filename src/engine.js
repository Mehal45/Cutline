// Rendering engine: decides what is visible at time t and draws it.
// Clips use Canvas 2D; transitions blend two clip frames in a WebGL shader.
import { layoutMain } from "./store.js";

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
  return [...elements.values()].filter((e) => e instanceof HTMLVideoElement);
}

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
      out.push({ seg, index: i, local, sourceTime: seg.in + local * clipSpeed(seg) });
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
  const media = project.media[clip.seg.mediaId];
  if (!media) return;
  // During export a decoded VideoFrame may stand in for the <video> element.
  const el = exportFrames.get(clip.seg.id) || elementFor(clip.seg, media);
  const a = animState(clip.seg.anim, clip.local, clip.seg.dur);
  const tr = clipTransform(clip.seg);
  const sw = el.displayWidth || el.videoWidth || el.naturalWidth || media.w;
  const sh = el.displayHeight || el.videoHeight || el.naturalHeight || media.h;
  if (!sw || !sh) return;
  const fit = Math.min(W / sw, H / sh);
  ctx.save();
  ctx.globalAlpha = a.alpha;
  ctx.translate(tr.x * W + a.dx * W, tr.y * H + a.dy * H);
  ctx.rotate((tr.rotation * Math.PI) / 180);
  ctx.scale(a.scale * tr.scale, a.scale * tr.scale);
  ctx.drawImage(el, (-sw * fit) / 2, (-sh * fit) / 2, sw * fit, sh * fit);
  ctx.restore();
}

/** Playback speed of a main-track clip. Timeline duration = source span / speed. */
export const clipSpeed = (seg) => seg.speed ?? 1;

export const clipTransform = (seg) => seg.transform ?? { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

/**
 * On-screen bounds of a clip or text in canvas fractions: {cx, cy, w, h, rotation}.
 * w is a fraction of the canvas width, h of its height. Ignores in/out animation offsets.
 */
export function itemBounds(project, kind, item, W, H) {
  if (kind === "main") {
    const media = project.media[item.mediaId];
    if (!media?.w || !media?.h) return null;
    const tr = clipTransform(item);
    const fit = Math.min(W / media.w, H / media.h);
    return { cx: tr.x, cy: tr.y, w: (media.w * fit * tr.scale) / W, h: (media.h * fit * tr.scale) / H, rotation: tr.rotation };
  }
  const st = item.style;
  const size = st.size * (W / 1920);
  const m = measureCtx();
  m.font = `${st.weight} ${size}px ${st.font}`;
  const lines = wrap(m, item.text, W * 0.85);
  const pad = st.bg ? size * 0.6 : size * 0.2;
  const tw = Math.max(...lines.map((l) => m.measureText(l).width)) + pad;
  const th = lines.length * size * 1.2 + size * 0.2;
  const s = item.scale || 1;
  return { cx: item.x, cy: item.y, w: (tw * s) / W, h: (th * s) / H, rotation: item.rotation || 0 };
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

export function drawText(ctx, item, t, W, H) {
  const lt = t - item.start;
  if (lt < 0 || lt >= item.dur) return;
  const st = item.style;
  const a = animState(item.anim, lt, item.dur);
  const size = st.size * (W / 1920);
  ctx.save();
  ctx.globalAlpha = a.alpha;
  ctx.translate(item.x * W + a.dx * W, item.y * H + a.dy * H);
  ctx.rotate(((item.rotation || 0) * Math.PI) / 180);
  ctx.scale(a.scale * (item.scale || 1), a.scale * (item.scale || 1));
  ctx.font = `${st.weight} ${size}px ${st.font}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  // Captions carry per-word timing; plain text is split into words for layout only.
  const words = item.words?.length
    ? item.words
    : item.text.split(/(\s+)/).filter(Boolean).map((w) => ({ w }));
  let full = words.map((w) => w.w).join("");
  if (a.reveal < 1) full = full.slice(0, Math.round(full.length * a.reveal));
  const lines = wrap(ctx, full, W * 0.85);
  const lh = size * 1.2;
  const y0 = -((lines.length - 1) * lh) / 2;

  if (st.bg) {
    const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + size * 0.6;
    ctx.fillStyle = st.bg;
    roundRect(ctx, -bw / 2, y0 - lh / 2 - size * 0.15, bw, lines.length * lh + size * 0.3, size * 0.25);
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

  lines.forEach((line, li) => {
    const y = y0 + li * lh;
    const lw = ctx.measureText(line).width;
    let x = -lw / 2;
    ctx.textAlign = "left";
    for (const ch of line) {
      const cw = ctx.measureText(ch).width;
      const hl = activeRange && charIndex >= activeRange[0] && charIndex < activeRange[1];
      if (st.strokeWidth > 0) {
        ctx.strokeStyle = st.stroke;
        ctx.lineWidth = st.strokeWidth * (W / 1920) * 2;
        ctx.strokeText(ch, x, y);
      }
      ctx.fillStyle = hl ? st.highlight : st.color;
      ctx.fillText(ch, x, y);
      x += cw;
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
  if (transition) {
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
  for (const item of project.texts) drawText(ctx, item, t, W, H);
}

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
  for (const c of clips) {
    const el = elementFor(c.seg, project.media[c.seg.mediaId]);
    if (!(el instanceof HTMLVideoElement)) {
      if (!el.complete) waits.push(new Promise((r) => (el.onload = r)));
      continue;
    }
    // Inside a transition one side is "frozen" on its first/last frame.
    const frozen = t < c.seg.start || t >= c.seg.start + c.seg.dur;
    el.muted = !playing || frozen || clips.length > 1 && c !== clips[0];
    if (playing && !frozen) {
      const rate = clipSpeed(c.seg);
      if (el.playbackRate !== rate) el.playbackRate = rate;
      if (Math.abs(el.currentTime - c.sourceTime) > 0.3 * Math.max(1, rate)) el.currentTime = c.sourceTime;
      if (el.paused) el.play().catch(() => {});
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - c.sourceTime) > 1 / 120 || el.readyState < 2) {
        waits.push(seekTo(el, c.sourceTime));
      }
    }
  }
  for (const [id, el] of elements) {
    if (!active.has(id) && el instanceof HTMLVideoElement && !el.paused) el.pause();
  }
  return Promise.all(waits);
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
