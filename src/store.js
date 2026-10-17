// Project state + snapshot undo/redo. Times are in seconds.
//
// project = {
//   width, height, fps,
//   media: { [id]: { id, name, kind: "video"|"image", url, file, duration, w, h } },
//   main:  [ { id, mediaId, in, dur, anim: {in, out}, transition: {type, dur} | null } ]  // back-to-back
//   texts: [ { id, start, dur, text, style, x, y, scale, anim: {in, out}, words? } ]
// }
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
  project: { width: 1920, height: 1080, fps: 30, media: {}, main: [], texts: [] },
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
  const textEnd = project.texts.reduce((a, t) => Math.max(a, t.start + t.dur), 0);
  return Math.max(mainEnd, textEnd);
}
