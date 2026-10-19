// Project state + snapshot undo/redo. Times are in seconds.
//
// project = {
//   width, height, fps,
//   media: { [id]: { id, name, kind: "video"|"image", url, file, duration, w, h } },
//   main:  [ { id, mediaId, in, dur, anim: {in, out}, transition: {type, dur} | null } ]  // back-to-back
//   texts: [ { id, start, dur, text, style, x, y, scale, anim: {in, out}, words? } ]
//   overlays: [ { id, mediaId, track, start, in, dur, ...same visual props as a main clip } ]  // picture-in-picture layers
//   audio:    [ { id, mediaId, track, start, in, dur, speed?, audio: {...} } ]                // music, voice-over, TTS
//   effects:  [ { id, track, start, dur, type, amount } ]                                     // whole-frame effects
// }
// Optional props on clips/overlays/texts (absent = old behaviour): opacity, blend, crop, flipH, flipV,
// adjust, filter, fx, chroma, cutout, keyframes, audio. See engine.js / fx.js / audiofx.js.
import { useSyncExternalStore } from "react";

export const uid = () => Math.random().toString(36).slice(2, 10);

export const defaultTextStyle = () => ({
  font: "Inter, Arial, sans-serif",
  size: 72,
  weight: 800,
  color: "#ffffff",
  stroke: "#000000",
  strokeWidth: 6,
  bg: "",
  highlight: "#ffd400",
});

const initial = {
  project: { width: 1920, height: 1080, fps: 30, media: {}, main: [], texts: [], overlays: [], audio: [], effects: [] },
  selection: [], // [{ kind: "main"|"text"|"transition", id }]
  home: typeof window !== "undefined" && !!window.cutlineDesktop, // the desktop app starts on the Home screen (recent projects)
  time: 0,
  playing: false,
  zoom: 80, // px per second
  canUndo: false,
  canRedo: false,
};

let state = initial;
const listeners = new Set();
const past = [];
const future = [];

export const getState = () => state;

export function setState(patch) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  listeners.forEach((l) => l());
}

const historyFlags = () => ({ canUndo: past.length > 0, canRedo: future.length > 0 });

/** Mutate the project with undo support. `fn` receives a draft copy and mutates it. */
export function edit(fn) {
  const draft = structuredCloneProject(state.project);
  fn(draft);
  linkToMain(state.project, draft);
  stackTexts(draft);
  past.push(state.project);
  if (past.length > 100) past.shift();
  future.length = 0;
  setState({ project: draft, ...historyFlags() });
}

/**
 * Swaps the undo/redo history for another one (each open compound clip has its own). Returns the old one.
 * `next` = null starts empty.
 */
export function swapHistory(next) {
  const prev = { past: past.splice(0), future: future.splice(0) };
  if (next) { past.push(...next.past); future.push(...next.future); }
  setState(historyFlags());
  return prev;
}

/** Saves an undo point without changing anything (call once at the start of a drag). */
export function checkpoint() {
  past.push(state.project);
  future.length = 0;
  setState(historyFlags());
}

// ---- selection helpers ----

export const isSelected = (kind, id) => state.selection.some((s) => s.kind === kind && s.id === id);

/** Selects `items`; with `additive`, toggles them into the current selection instead. */
export function select(items, additive = false) {
  if (!additive) return setState({ selection: items });
  const next = [...state.selection];
  for (const it of items) {
    const i = next.findIndex((s) => s.kind === it.kind && s.id === it.id);
    if (i >= 0) next.splice(i, 1);
    else next.push(it);
  }
  setState({ selection: next });
}

/** Mutates the project without adding an undo step (used while dragging). */
export function editLive(fn) {
  const draft = structuredCloneProject(state.project);
  fn(draft);
  linkToMain(state.project, draft);
  setState({ project: draft });
}

export function undo() {
  if (!past.length) return;
  future.push(state.project);
  const project = past.pop();
  setState({ project, selection: [], ...historyFlags() });
}

export function redo() {
  if (!future.length) return;
  past.push(state.project);
  const project = future.pop();
  setState({ project, selection: [], ...historyFlags() });
}

// File objects can't be structured-cloned cheaply, so media entries are shared by reference.
function structuredCloneProject(p) {
  return {
    ...p,
    media: { ...p.media },
    main: p.main.map((s) => structuredClone(s)),
    texts: p.texts.map((t) => structuredClone(t)),
    overlays: (p.overlays || []).map((o) => structuredClone(o)),
    audio: (p.audio || []).map((a) => structuredClone(a)),
    effects: (p.effects || []).map((e) => structuredClone(e)),
    ...(p.trackState ? { trackState: structuredClone(p.trackState) } : {}),
  };
}

export function useStore(selector) {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => selector(state),
  );
}

// ---- derived timeline helpers ----

/**
 * Linkage (timeline toggle, on by default): texts, layers, audio and effects sit on a main-track clip and
 * move with it when that clip moves (clips before it deleted, trimmed, reordered…). Items lying entirely
 * inside a deleted clip go with it. Items the edit itself moved are left alone.
 */
function linkToMain(prev, next) {
  if (state.linkage === false || !prev?.main || !next?.main) return;
  const before = layoutMain(prev);
  const after = new Map(layoutMain(next).map((s) => [s.id, s]));
  if (before.every((s) => after.get(s.id)?.start === s.start)) return;
  for (const lane of ["texts", "overlays", "audio", "effects"]) {
    if (!next[lane] || !prev[lane]) continue;
    const old = new Map(prev[lane].map((x) => [x.id, x]));
    next[lane] = next[lane].filter((x) => {
      const o = old.get(x.id);
      if (!o || o.start !== x.start) return true;
      const host = before.find((s) => o.start >= s.start - 1e-6 && o.start < s.start + s.dur - 1e-6);
      if (!host) return true;
      const now = after.get(host.id);
      if (!now) return !(o.start + o.dur <= host.start + host.dur + 1e-3); // its clip was deleted
      const d = now.start - host.start;
      if (Math.abs(d) < 1e-9) return true;
      const shift = Math.max(d, -x.start);
      x.start += shift;
      if (x.words) x.words = x.words.map((w) => ({ ...w, t0: w.t0 + shift, t1: w.t1 + shift }));
      return true;
    });
  }
}

/**
 * Removes main-track clips. With the main track magnet off, the space they took stays empty
 * (added to the gap before the next clip) so nothing after them moves.
 */
export function removeMain(p, ids, keepGap = state.mainMagnet === false) {
  let carry = 0;
  p.main = p.main.filter((s) => {
    if (ids.has(s.id)) { if (keepGap) carry += (s.gap || 0) + s.dur; return false; }
    if (carry) { s.gap = (s.gap || 0) + carry; carry = 0; }
    return true;
  });
}

/** Removes all empty space from the main track (turning the magnet on). */
export function closeMainGaps(p) {
  for (const s of p.main) delete s.gap;
}

/** Main-track segments with their computed timeline start. */
export function layoutMain(project) {
  let t = 0;
  return project.main.map((seg) => {
    t += seg.gap || 0; // empty space before the clip (main track magnet off)
    const out = { ...seg, start: t };
    t += seg.dur;
    return out;
  });
}

export function projectDuration(project) {
  const mainEnd = project.main.reduce((a, s) => a + (s.gap || 0) + s.dur, 0);
  const end = (list) => (list || []).reduce((a, t) => Math.max(a, t.start + t.dur), 0);
  return Math.max(mainEnd, end(project.texts), end(project.overlays), end(project.audio), end(project.effects));
}

/** Every timed item that isn't on the main track, by selection kind. */
export const LANES = { text: "texts", overlay: "overlays", audio: "audio", effect: "effects" };

/** Finds any item by selection kind + id. */
export function findItem(project, kind, id) {
  const list = kind === "main" || kind === "transition" ? project.main : project[LANES[kind]];
  return list?.find((x) => x.id === id);
}

/** Lowest track index of `list` with nothing in [start, start + dur), so new items never overlap. */
export function freeTrack(list, start, dur, skipId) {
  for (let track = 0; ; track++) {
    const busy = list.some((x) => x.id !== skipId && (x.track ?? 0) === track && x.start < start + dur - 1e-3 && x.start + x.dur > start + 1e-3);
    if (!busy) return track;
  }
}

/**
 * Texts that would overlap in time on the same text track go to the next free one (a new text track if
 * needed), so a text added on top of another gets its own row. Earlier texts keep their track (mutates).
 */
export function stackTexts(p) {
  const done = [];
  for (const x of p.texts || []) {
    const t = x.track ?? 0;
    if (done.some((y) => (y.track ?? 0) === t && y.start < x.start + x.dur - 1e-3 && y.start + y.dur > x.start + 1e-3)) x.track = freeTrack(done, x.start, x.dur);
    done.push(x);
  }
}

/** Renumbers the tracks of overlays, audio and effects so no empty lanes are left between them (mutates). */
export function compactTracks(p) {
  const state = p.trackState || {};
  const moved = {};
  for (const [lane, kind] of [["texts", "text"], ["overlays", "overlay"], ["audio", "audio"], ["effects", "effect"]]) {
    const used = [...new Set((p[lane] || []).map((x) => x.track ?? 0))].sort((a, b) => a - b);
    const map = new Map(used.map((t, i) => [t, i]));
    for (const x of p[lane] || []) x.track = map.get(x.track ?? 0);
    // Lock / hide / mute settings follow their track to its new number.
    if (kind === "text") continue; // all text tracks share one lock / hide setting ("text")
    for (const [from, to] of map) if (state[`${kind}:${from}`]) moved[`${kind}:${to}`] = state[`${kind}:${from}`];
  }
  if (p.trackState) p.trackState = { ...(state.main ? { main: state.main } : {}), ...(state.text ? { text: state.text } : {}), ...moved };
}

// ---------------- track lock / hide / mute ----------------

/** Key of the track an item lives on: "main", "text", "overlay:2", "audio:0", "effect:1". */
export function trackKey(kind, item) {
  if (kind === "main" || kind === "transition") return "main";
  if (kind === "text") return "text";
  return `${kind}:${item?.track ?? 0}`;
}

/** { hidden, muted, locked } of a track (all false when never set). */
export const trackFlags = (project, key) => project.trackState?.[key] || {};

/** Toggles one flag of a track, as an undoable edit. */
export function toggleTrackFlag(key, flag) {
  edit((p) => {
    p.trackState = { ...(p.trackState || {}) };
    const cur = { ...(p.trackState[key] || {}) };
    cur[flag] = !cur[flag] || undefined;
    p.trackState[key] = cur;
  });
  if (flag === "locked") setState({ selection: state.selection.filter((s) => trackKey(s.kind, findItem(state.project, s.kind, s.id)) !== key) });
}

/** True when the item's track is locked (it can't be selected, moved or edited). */
export const isLocked = (project, kind, item) => !!trackFlags(project, trackKey(kind, item)).locked;
