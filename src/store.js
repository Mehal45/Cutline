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
  past.push(state.project);
  if (past.length > 100) past.shift();
  future.length = 0;
  setState({ project: draft, ...historyFlags() });
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
  };
}

export function useStore(selector) {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => selector(state),
  );
}

// ---- derived timeline helpers ----

/** Main-track segments with their computed timeline start. */
export function layoutMain(project) {
  let t = 0;
  return project.main.map((seg) => {
    const out = { ...seg, start: t };
    t += seg.dur;
    return out;
  });
}

export function projectDuration(project) {
  const mainEnd = project.main.reduce((a, s) => a + s.dur, 0);
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

/** Renumbers the tracks of overlays, audio and effects so no empty lanes are left between them (mutates). */
export function compactTracks(p) {
  for (const lane of ["overlays", "audio", "effects"]) {
    const used = [...new Set((p[lane] || []).map((x) => x.track ?? 0))].sort((a, b) => a - b);
    const map = new Map(used.map((t, i) => [t, i]));
    for (const x of p[lane] || []) x.track = map.get(x.track ?? 0);
  }
}
