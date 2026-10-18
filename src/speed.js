// Speed curves (speed ramping): a clip's speed can change over its length, e.g. normal → fast → normal.
//
// item.speedCurve = { points: [ { p, v } ], smooth }   p = position in the clip 0..1, v = speed (0.1–10×)
// With `smooth`, speed eases in and out between points (no sudden jumps); otherwise it changes linearly.
// Timeline time maps to source time by integrating the speed, and the clip's timeline length is chosen
// so the same piece of footage is used: duration = source span ÷ average speed.

export const SPEED_CURVES = {
  smoothFast: { label: "Fast, then normal", points: [[0, 1], [0.2, 3], [0.8, 3], [1, 1]] },
  rampUp: { label: "Speed up", points: [[0, 1], [1, 4]] },
  rampDown: { label: "Slow down", points: [[0, 4], [1, 1]] },
  slowMo: { label: "Slow-mo middle", points: [[0, 1], [0.35, 0.3], [0.65, 0.3], [1, 1]] },
  montage: { label: "Montage", points: [[0, 1], [0.2, 2.5], [0.45, 0.5], [0.55, 0.5], [0.8, 2.5], [1, 1]] },
  hero: { label: "Hero", points: [[0, 2], [0.35, 2], [0.5, 0.25], [0.65, 2], [1, 2]] },
  bullet: { label: "Bullet", points: [[0, 4], [0.4, 0.2], [0.6, 0.2], [1, 4]] },
  jumpCut: { label: "Jump cut", points: [[0, 1], [0.42, 1], [0.5, 6], [0.58, 1], [1, 1]] },
  flashIn: { label: "Flash in", points: [[0, 6], [0.6, 1], [1, 1]] },
  flashOut: { label: "Flash out", points: [[0, 1], [0.4, 1], [1, 6]] },
};

export const MIN_SPEED = 0.1, MAX_SPEED = 10;

export const presetCurve = (key) => ({ points: SPEED_CURVES[key].points.map(([p, v]) => ({ p, v })), smooth: true, preset: key });

export const hasCurve = (item) => (item?.speedCurve?.points?.length ?? 0) >= 2;

/** Speed at position p (0..1). Interpolates in log space so 1× → 4× feels even; smooth = ease in/out per segment. */
export function curveSpeedAt(curve, p) {
  const pts = curve.points;
  if (p <= pts[0].p) return pts[0].v;
  const last = pts[pts.length - 1];
  if (p >= last.p) return last.v;
  let i = 0;
  while (i < pts.length - 2 && pts[i + 1].p <= p) i++;
  const a = pts[i], b = pts[i + 1];
  let k = (p - a.p) / Math.max(1e-6, b.p - a.p);
  if (curve.smooth !== false) k = k * k * (3 - 2 * k); // smoothstep: starts and ends gently
  return Math.exp(Math.log(a.v) + (Math.log(b.v) - Math.log(a.v)) * k);
}

const N = 512;
const tables = new WeakMap(); // curve object -> { cum: Float64Array(N + 1), mean }

/** Cumulative integral of speed over p (normalised), so source offset = dur × cum(p). */
function table(curve) {
  let t = tables.get(curve);
  if (t) return t;
  const cum = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) {
    const v0 = curveSpeedAt(curve, (i - 1) / N), v1 = curveSpeedAt(curve, i / N);
    cum[i] = cum[i - 1] + ((v0 + v1) / 2) / N;
  }
  t = { cum, mean: cum[N] };
  tables.set(curve, t);
  return t;
}

const constSpeed = (item) => item.speed ?? 1;

/** Average speed of the clip (constant speed, or the curve's mean). */
export const meanSpeed = (item) => (hasCurve(item) ? table(item.speedCurve).mean : constSpeed(item));

/** Source time shown at local timeline time lt. */
export function sourceAt(item, lt) {
  if (!hasCurve(item)) return (item.in || 0) + lt * constSpeed(item);
  const { cum } = table(item.speedCurve);
  const x = Math.max(0, Math.min(1, lt / Math.max(1e-6, item.dur))) * N;
  const i = Math.min(N - 1, Math.floor(x));
  return (item.in || 0) + item.dur * (cum[i] + (cum[i + 1] - cum[i]) * (x - i));
}

/** Playback rate at local time lt. */
export const rateAt = (item, lt) => (hasCurve(item) ? curveSpeedAt(item.speedCurve, lt / Math.max(1e-6, item.dur)) : constSpeed(item));

/** Seconds of source footage the clip uses. */
export const sourceSpan = (item) => item.dur * meanSpeed(item);

/** Rates sampled across the clip (for audio automation in export). */
export function rateSamples(item, n = 200) {
  const out = new Float32Array(Math.max(2, n));
  for (let i = 0; i < out.length; i++) out[i] = rateAt(item, (i / (out.length - 1)) * item.dur);
  return out;
}

/** The part of a curve between local times [a, b] of a clip of length dur, as a new normalised curve. */
export function subCurve(curve, a, b, dur, samples = 17) {
  const points = [];
  for (let i = 0; i < samples; i++) {
    const p = (a + ((b - a) * i) / (samples - 1)) / dur;
    points.push({ p: i / (samples - 1), v: curveSpeedAt(curve, p) });
  }
  return { points, smooth: false };
}

/**
 * Applies a curve to an item (mutates), keeping the same source footage: the timeline length changes to
 * span ÷ new average speed. Pass null to go back to the item's constant speed.
 */
export function setSpeedCurve(item, curve) {
  const span = sourceSpan(item);
  if (!curve) {
    delete item.speedCurve;
    item.dur = Math.max(0.05, span / constSpeed(item));
    return;
  }
  delete item.speed;
  item.speedCurve = curve;
  item.dur = Math.max(0.05, span / table(curve).mean);
}
