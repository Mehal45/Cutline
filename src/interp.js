// Frame interpolation for export (e.g. 60 fps recordings exported at 90 or 120 fps, or smooth slow motion).
// Runs on the GPU (WebGL2):
//  - "flow": motion interpolation. For each in-between frame, a coarse-to-fine search finds how every area
//    moved between the two real frames (measured at the in-between moment, so nothing is pushed apart), then
//    both frames are warped to that moment and mixed. Where the motion can't be matched (things appearing
//    or disappearing) it falls back to a soft cross-fade instead of tearing.
//  - "blend": a plain cross-fade between the two real frames (fast, a little ghosty on fast motion).
// Optional motion blur averages several moments around the in-between frame (like a camera shutter).

let gl = null, canvas = null, progs = null, ok = null;
const tex = {}; // named textures
const fbos = new Map(); // texture -> framebuffer

const VS = `#version 300 es
in vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }`;

const LUMA = `float L(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }`;

// Luma of A (r) and B (g), averaged down from the full frames.
const PYR0 = `#version 300 es
precision highp float;
uniform sampler2D A, B; uniform vec2 size, texel; out vec4 o; ${LUMA}
void main() {
  vec2 uv = gl_FragCoord.xy / size;
  vec2 q = texel * 0.75;
  float a = 0.0, b = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 k = vec2(i < 2 ? -q.x : q.x, (i % 2 == 0) ? -q.y : q.y);
    a += L(texture(A, uv + k).rgb); b += L(texture(B, uv + k).rgb);
  }
  o = vec4(a * 0.25, b * 0.25, 0.0, 1.0);
}`;

// Next pyramid level from the previous one.
const PYRN = `#version 300 es
precision highp float;
uniform sampler2D P; uniform vec2 size, texel; out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / size;
  vec2 q = texel * 0.5;
  vec2 s = texture(P, uv + vec2(-q.x, -q.y)).rg + texture(P, uv + vec2(q.x, -q.y)).rg
         + texture(P, uv + vec2(-q.x, q.y)).rg + texture(P, uv + vec2(q.x, q.y)).rg;
  o = vec4(s * 0.25, 0.0, 1.0);
}`;

// Symmetric block search around the coarser level's estimate. Flow is in texture units (A -> B).
const SEARCH = `#version 300 es
precision highp float;
uniform sampler2D P, F; uniform bool hasPrev; uniform vec2 size; uniform float alpha, step; uniform int R; out vec4 o;
float cost(vec2 uv, vec2 d, vec2 t) {
  float c = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 k = vec2(float(x), float(y)) * 2.0 * t;
    c += abs(texture(P, uv + k - alpha * d).r - texture(P, uv + k + (1.0 - alpha) * d).g);
  }
  return c;
}
void main() {
  vec2 t = 1.0 / size;
  vec2 uv = gl_FragCoord.xy * t;
  vec2 d0 = hasPrev ? texture(F, uv).xy : vec2(0.0);
  vec2 best = d0; float bc = cost(uv, d0, t);
  for (int j = -R; j <= R; j++) for (int i = -R; i <= R; i++) {
    if (i == 0 && j == 0) continue;
    vec2 d = d0 + vec2(float(i), float(j)) * t * step;
    float c = cost(uv, d, t) + 0.004 * length(vec2(float(i), float(j)) * step);
    if (c < bc) { bc = c; best = d; }
  }
  o = vec4(best, bc, 1.0);
}`;

// Smooths the motion field, trusting well-matched neighbours more.
const SMOOTH = `#version 300 es
precision highp float;
uniform sampler2D F; uniform vec2 size; out vec4 o;
void main() {
  vec2 t = 1.0 / size, uv = gl_FragCoord.xy * t;
  vec2 acc = vec2(0.0); float w = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec4 f = texture(F, uv + vec2(float(x), float(y)) * t);
    float k = 1.0 / (0.02 + f.z);
    acc += f.xy * k; w += k;
  }
  o = vec4(acc / w, texture(F, uv).z, 1.0);
}`;

// Final picture at full size (flipped upright for the canvas).
const FINAL = `#version 300 es
precision highp float;
uniform sampler2D A, B, F; uniform vec2 size; uniform float alpha, span; uniform int taps; uniform bool useFlow; out vec4 o; ${LUMA}
void main() {
  vec2 uv = vec2(gl_FragCoord.x, size.y - gl_FragCoord.y) / size;
  vec2 d = useFlow ? texture(F, uv).xy : vec2(0.0);
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 9; k++) {
    if (k >= taps) break;
    float a = taps > 1 ? clamp(alpha + span * (float(k) / float(taps - 1) - 0.5), 0.0, 1.0) : alpha;
    vec3 ca = texture(A, uv - a * d).rgb, cb = texture(B, uv + (1.0 - a) * d).rgb;
    vec3 c = mix(ca, cb, a);
    if (useFlow) {
      float e = abs(L(ca) - L(cb));
      c = mix(c, mix(texture(A, uv).rgb, texture(B, uv).rgb, a), smoothstep(0.12, 0.32, e));
    }
    acc += c;
  }
  o = vec4(acc / float(max(taps, 1)), 1.0);
}`;

function compile(fs) {
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "p");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

function init() {
  if (ok !== null) return ok;
  try {
    canvas = new OffscreenCanvas(16, 16);
    gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) return (ok = false);
    const flowOk = !!gl.getExtension("EXT_color_buffer_float");
    progs = { final: compile(FINAL) };
    if (flowOk) Object.assign(progs, { pyr0: compile(PYR0), pyrN: compile(PYRN), search: compile(SEARCH), smooth: compile(SMOOTH) });
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    ok = { flow: flowOk };
  } catch (e) {
    console.warn("interpolation unavailable", e);
    ok = false;
  }
  return ok;
}

/** A texture of `w`×`h` (float for motion fields), recreated when the size changes. */
function target(name, w, h, float) {
  let t = tex[name];
  if (t && t.w === w && t.h === h) return t;
  if (t) { gl.deleteTexture(t.t); fbos.delete(t.t); }
  const tt = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tt);
  gl.texImage2D(gl.TEXTURE_2D, 0, float ? gl.RGBA16F : gl.RGBA8, w, h, 0, gl.RGBA, float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tt, 0);
  fbos.set(tt, fb);
  return (tex[name] = { t: tt, w, h });
}

function upload(name, frame) {
  let t = tex[name];
  if (!t) {
    t = tex[name] = { t: gl.createTexture() };
    gl.bindTexture(gl.TEXTURE_2D, t.t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  }
  gl.bindTexture(gl.TEXTURE_2D, t.t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, frame);
  return t.t;
}

function pass(prog, out, uniforms, textures) {
  gl.useProgram(prog);
  gl.bindFramebuffer(gl.FRAMEBUFFER, out ? fbos.get(out.t) : null);
  gl.viewport(0, 0, out ? out.w : canvas.width, out ? out.h : canvas.height);
  let unit = 0;
  for (const [name, t] of Object.entries(textures)) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit++);
  }
  for (const [name, v] of Object.entries(uniforms)) {
    const loc = gl.getUniformLocation(prog, name);
    if (typeof v === "boolean") gl.uniform1i(loc, v ? 1 : 0);
    else if (Number.isInteger(v) && name !== "alpha" && name !== "span" && name !== "step") gl.uniform1i(loc, v);
    else if (Array.isArray(v)) gl.uniform2f(loc, v[0], v[1]);
    else gl.uniform1f(loc, v);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/** Whether this computer can interpolate: { flow } or false. */
export const interpolationSupport = () => init();

/**
 * The in-between picture `alpha` (0..1) of the way from frame `a` to frame `b`. `span` (0..1 of the gap between
 * the two frames) adds motion blur. Returns a canvas that is reused by the next call: draw it right away.
 */
export function interpolate(a, b, alpha, { method = "flow", span = 0 } = {}) {
  const support = init();
  if (!support) return null;
  const W = a.displayWidth || a.width, H = a.displayHeight || a.height;
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const A = upload("A", a), B = upload("B", b);
  const useFlow = method === "flow" && support.flow;
  let flow = null;
  if (useFlow) {
    // Pyramid of half, quarter, ... size (smallest side at least ~40 px).
    const levels = [];
    let w = Math.max(8, Math.round(W / 2)), h = Math.max(8, Math.round(H / 2));
    for (let i = 0; i < 6 && Math.min(w, h) >= 40; i++) { levels.push([w, h]); w = Math.round(w / 2); h = Math.round(h / 2); }
    const pyr = levels.map(([lw, lh], i) => target(`pyr${i}`, lw, lh, false));
    pass(progs.pyr0, pyr[0], { size: [pyr[0].w, pyr[0].h], texel: [1 / W, 1 / H] }, { A, B });
    for (let i = 1; i < pyr.length; i++) pass(progs.pyrN, pyr[i], { size: [pyr[i].w, pyr[i].h], texel: [1 / pyr[i - 1].w, 1 / pyr[i - 1].h] }, { P: pyr[i - 1].t });
    let prev = null;
    for (let i = pyr.length - 1; i >= 0; i--) {
      const lv = pyr[i];
      const est = target(`flow${i}`, lv.w, lv.h, true);
      const coarsest = i === pyr.length - 1;
      pass(progs.search, est, { size: [lv.w, lv.h], alpha, hasPrev: !!prev, R: coarsest ? 4 : 1, step: 1 }, { P: lv.t, F: prev ? prev.t : lv.t });
      const sm = target(`flowS${i}`, lv.w, lv.h, true);
      pass(progs.smooth, sm, { size: [lv.w, lv.h] }, { F: est.t });
      prev = sm;
    }
    // Half-pixel refinement at the finest level.
    const lv = pyr[0];
    const fine = target("flowFine", lv.w, lv.h, true);
    pass(progs.search, fine, { size: [lv.w, lv.h], alpha, hasPrev: true, R: 1, step: 0.5 }, { P: lv.t, F: prev.t });
    const fineS = target("flowFineS", lv.w, lv.h, true);
    pass(progs.smooth, fineS, { size: [lv.w, lv.h] }, { F: fine.t });
    flow = fineS;
  }
  const taps = span > 0.01 ? 7 : 1;
  pass(progs.final, null, { size: [W, H], alpha, span, taps, useFlow: !!flow }, { A, B, F: flow ? flow.t : A });
  return canvas;
}
