// Keyframes: any numeric property of a clip, layer or text can change over time.
//
// item.keyframes = { [prop]: [ { t, v, ease } ] }   // t = seconds from the item's start, sorted
// prop is a path such as "x", "scale", "opacity", "volume", "adjust.brightness" or "fx.<id>.amount".
// `ease` shapes the move from this key to the next: a preset name, "hold", or a cubic Bézier [x1, y1, x2, y2].

export const EASINGS = {
  linear: { label: "Linear", curve: [0, 0, 1, 1] },
  easeInOut: { label: "Ease in-out", curve: [0.42, 0, 0.58, 1] },
  easeIn: { label: "Ease in", curve: [0.42, 0, 1, 1] },
  easeOut: { label: "Ease out", curve: [0, 0, 0.58, 1] },
  smooth: { label: "Smooth", curve: [0.25, 0.1, 0.25, 1] },
  backOut: { label: "Overshoot", curve: [0.34, 1.56, 0.64, 1] },
  hold: { label: "Hold", curve: null },
};

/** The Bézier control points for an ease value (null = hold). */
export function easeCurve(ease) {
  if (Array.isArray(ease)) return ease;
  return ease in EASINGS ? EASINGS[ease].curve : EASINGS.linear.curve;
}

/** y of a CSS-style cubic Bézier (0,0)-(x1,y1)-(x2,y2)-(1,1) at x. */
export function bezierAt([x1, y1, x2, y2], x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bx = (t) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 30; i++) { // bisection: robust for any control points
    t = (lo + hi) / 2;
    if (bx(t) < x) lo = t; else hi = t;
  }
  return by(t);
}

const EPS = 1 / 240;

// New keyframes ease in and out ("smooth") unless the user switched that off; remembered per computer.
let newEase = (() => { try { return localStorage.getItem("cutline.keyEase") || "easeInOut"; } catch { return "easeInOut"; } })();
export const defaultEase = () => newEase;
export function setDefaultEase(ease) {
  newEase = ease;
  try { localStorage.setItem("cutline.keyEase", ease); } catch { /* not saved */ }
}

export const keysOf = (item, prop) => item?.keyframes?.[prop] || [];
export const hasKeys = (item, prop) => keysOf(item, prop).length > 0;
export const animatedProps = (item) => Object.keys(item?.keyframes || {}).filter((p) => item.keyframes[p].length);

/** The value of `prop` at local time t, or `fallback` when it has no keyframes. */
export function valueAt(item, prop, t, fallback) {
  const ks = keysOf(item, prop);
  if (!ks.length) return fallback;
  if (t <= ks[0].t) return ks[0].v;
  const last = ks[ks.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < ks.length - 2 && ks[i + 1].t <= t) i++;
  const a = ks[i], b = ks[i + 1];
  const curve = easeCurve(a.ease);
  if (!curve) return a.v;
  return a.v + (b.v - a.v) * bezierAt(curve, (t - a.t) / Math.max(1e-6, b.t - a.t));
}

/** The keyframe of `prop` at t (within a frame), if any. */
export const keyAt = (item, prop, t) => keysOf(item, prop).find((k) => Math.abs(k.t - t) < EPS);

/** Adds or updates a keyframe (mutates item). */
export function setKey(item, prop, t, v, ease) {
  item.keyframes ??= {};
  const ks = (item.keyframes[prop] ??= []);
  const hit = ks.find((k) => Math.abs(k.t - t) < EPS);
  if (hit) { hit.v = v; if (ease !== undefined) hit.ease = ease; return; }
  ks.push({ t: Math.max(0, t), v, ease: ease ?? newEase });
  ks.sort((a, b) => a.t - b.t);
}

export function removeKey(item, prop, t) {
  const ks = keysOf(item, prop);
  const i = ks.findIndex((k) => Math.abs(k.t - t) < EPS);
  if (i >= 0) ks.splice(i, 1);
  if (!ks.length && item.keyframes) delete item.keyframes[prop];
}

/** Sorted, de-duplicated times of every keyframe on the item. */
export function keyTimes(item) {
  const out = [];
  for (const p of animatedProps(item)) for (const k of item.keyframes[p]) if (!out.some((x) => Math.abs(x - k.t) < EPS)) out.push(k.t);
  return out.sort((a, b) => a - b);
}

/**
 * Splits keyframes at local time `at` for a cut: returns [left, right] keyframe maps. Each half keeps the
 * keyframe just beyond its edge (outside its own duration), so eased motion continues exactly as before.
 */
export function splitKeyframes(item, at) {
  if (!animatedProps(item).length) return [item.keyframes, item.keyframes];
  const left = {}, right = {};
  for (const p of animatedProps(item)) {
    const ks = item.keyframes[p];
    const firstAfter = ks.findIndex((k) => k.t > at + EPS);
    const lastBefore = ks.length - 1 - [...ks].reverse().findIndex((k) => k.t < at - EPS);
    left[p] = ks.slice(0, firstAfter < 0 ? ks.length : firstAfter + 1).map((k) => ({ ...k }));
    const from = lastBefore >= ks.length ? 0 : lastBefore;
    right[p] = ks.slice(from).map((k) => ({ ...k, t: k.t - at }));
  }
  return [left, right];
}

/** Shifts every key by dt seconds and drops the ones before 0 or after `dur` (used when trimming the start). */
export function shiftKeyframes(item, dt, dur = Infinity) {
  for (const p of animatedProps(item)) {
    item.keyframes[p] = item.keyframes[p].map((k) => ({ ...k, t: k.t + dt })).filter((k) => k.t >= -EPS && k.t <= dur + EPS);
    if (!item.keyframes[p].length) delete item.keyframes[p];
  }
}

/** Reads a dotted path ("adjust.brightness") from an object. */
export function getPath(obj, path, fallback) {
  let o = obj;
  for (const part of path.split(".")) { if (o == null) return fallback; o = o[part]; }
  return o ?? fallback;
}

/** Writes a dotted path, creating objects on the way. fx.<id>.amount addresses an effect by id. */
export function setPath(obj, path, value) {
  const parts = path.split(".");
  if (parts[0] === "fx") {
    const fx = obj.fx?.find((f) => f.id === parts[1]);
    if (fx) fx[parts[2]] = value;
    return;
  }
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]] ??= {};
  o[parts[parts.length - 1]] = value;
}

const TRANSFORM_PROPS = ["x", "y", "scale", "rotation"];
const DEFAULT_TRANSFORM = { x: 0.5, y: 0.5, scale: 1, rotation: 0 };

/**
 * Static (un-keyframed) value of a path. Understands fx.<id>.<field>, clip/layer transforms (stored in
 * item.transform; texts keep x/y/scale/rotation at the top level) and volume (stored in item.audio).
 */
export function staticValue(item, path, fallback) {
  const parts = path.split(".");
  if (parts[0] === "fx") return item.fx?.find((f) => f.id === parts[1])?.[parts[2]] ?? fallback;
  if (TRANSFORM_PROPS.includes(path) && item.mediaId) return (item.transform || DEFAULT_TRANSFORM)[path] ?? fallback;
  if (path === "volume") return item.audio?.volume ?? fallback;
  return getPath(item, path, fallback);
}

/** Writes the static value of a path (the counterpart of staticValue). */
export function setStatic(item, path, value) {
  if (TRANSFORM_PROPS.includes(path) && item.mediaId) item.transform = { ...(item.transform || DEFAULT_TRANSFORM), [path]: value };
  else if (path === "volume") item.audio = { ...(item.audio || {}), volume: value };
  else setPath(item, path, value);
}

/** Current value: keyframed if animated, else the static property. */
export const propAt = (item, path, t, fallback) => valueAt(item, path, t, staticValue(item, path, fallback));
