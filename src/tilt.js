// 3D tilt of a layer (rotateX / rotateY with perspective), drawn on the GPU: the flat layer is a texture on a
// quad whose corners are rotated around the item's centre and projected, so text and edges stay sharp and the
// texture is perspective-correct. Used by engine.js for items with tiltX / tiltY.
let gl = null, prog = null, tex = null, buf = null, loc = null;

const VS = `#version 300 es
in vec2 a; out vec2 uv;
uniform vec2 res, pivot; uniform float ax, ay, dist;
void main() {
  uv = a;
  vec3 p = vec3(a * res - pivot, 0.0);
  float cx = cos(ax), sx = sin(ax), cy = cos(ay), sy = sin(ay);
  p = vec3(p.x, p.y * cx - p.z * sx, p.y * sx + p.z * cx);   // tilt forward / back
  p = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);   // turn left / right
  float w = (dist + p.z) / dist;
  vec2 piv = pivot / res * 2.0 - 1.0;
  vec2 q = p.xy / res * 2.0;
  gl_Position = vec4(vec2(piv.x * w + q.x, -(piv.y * w + q.y)), 0.0, w);
}`;
const FS = `#version 300 es
precision highp float; in vec2 uv; uniform sampler2D t; out vec4 o;
void main() { o = texture(t, uv); }`;

function init(W, H) {
  const canvas = new OffscreenCanvas(W, H);
  gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: true });
  if (!gl) return false;
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { gl = null; return false; }
  buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  loc = Object.fromEntries(["res", "pivot", "ax", "ay", "dist"].map((n) => [n, gl.getUniformLocation(prog, n)]));
  loc.a = gl.getAttribLocation(prog, "a");
  return true;
}

/**
 * Returns a canvas (W x H) with `src` (a full-frame layer) tilted by tiltX / tiltY degrees around (px, py),
 * seen from `perspective` pixels away (like CSS perspective). Null if WebGL isn't available.
 */
export function tiltLayer(src, W, H, tiltX, tiltY, px, py, perspective) {
  if ((!gl || gl.canvas.width !== W || gl.canvas.height !== H) && !init(W, H)) return null;
  if (gl.isContextLost()) { gl = null; return null; }
  gl.viewport(0, 0, W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(prog);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc.a);
  gl.vertexAttribPointer(loc.a, 2, gl.FLOAT, false, 0, 0);
  gl.uniform2f(loc.res, W, H);
  gl.uniform2f(loc.pivot, px, py);
  gl.uniform1f(loc.ax, (tiltX * Math.PI) / 180);
  gl.uniform1f(loc.ay, (tiltY * Math.PI) / 180);
  gl.uniform1f(loc.dist, Math.max(200, perspective));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return gl.canvas;
}
