// Editing commands shared by buttons, keyboard shortcuts and the preview overlay.
import { getState, setState, edit, uid, layoutMain, projectDuration, defaultTextStyle } from "./store.js";
import { allVideoElements, clipSpeed } from "./engine.js";

// ---------------- playback clock ----------------

export const clock = { startT: 0, startNow: 0 };

export function play() {
  const s = getState();
  const t = s.time >= projectDuration(s.project) - 0.05 ? 0 : s.time;
  Object.assign(clock, { startT: t, startNow: performance.now() });
  setState({ playing: true, time: t });
}

export function pause() {
  setState({ playing: false });
  allVideoElements().forEach((v) => v.pause());
}

export const togglePlay = () => (getState().playing ? pause() : play());

export function seek(t) {
  const time = Math.max(0, Math.min(projectDuration(getState().project), t));
  Object.assign(clock, { startT: time, startNow: performance.now() });
  setState({ time });
}

// ---------------- feedback ----------------

let toastTimer;
export function toast(message) {
  clearTimeout(toastTimer);
  setState({ toast: message });
  toastTimer = setTimeout(() => setState({ toast: null }), 1600);
}

// ---------------- adding things ----------------

const noAnim = () => ({ in: { type: "none", dur: 0.4 }, out: { type: "none", dur: 0.4 } });
export const newClip = (mediaId, duration) => ({
  id: uid(), mediaId, in: 0, dur: duration, anim: noAnim(), transition: null,
  transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0 },
});

export async function importFiles(files) {
  for (const file of files) {
    const kind = file.type.startsWith("image") ? "image"
      : file.type.startsWith("video") || file.type.startsWith("audio") ? "video" : null;
    if (!kind) continue;
    const url = URL.createObjectURL(file);
    const meta = await new Promise((resolve) => {
      if (kind === "image") {
        const img = new Image();
        img.onload = () => resolve({ duration: 5, w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve(null);
        img.src = url;
      } else {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.onloadedmetadata = () => resolve({ duration: v.duration, w: v.videoWidth, h: v.videoHeight });
        v.onerror = () => resolve(null);
        v.src = url;
      }
    });
    if (!meta) { toast(`Couldn't read ${file.name}`); continue; }
    const id = uid();
    edit((p) => {
      p.media[id] = { id, name: file.name, kind, url, file, ...meta };
      if (p.main.length === 0 && meta.w && meta.h) {
        // First clip sets the canvas aspect, like most editors do.
        const r = meta.w / meta.h;
        Object.assign(p, r > 1.2 ? { width: 1920, height: 1080 } : r < 0.85 ? { width: 1080, height: 1920 } : { width: 1080, height: 1080 });
      }
      p.main.push(newClip(id, meta.duration));
    });
  }
}

export function addMediaToTimeline(media) {
  edit((p) => p.main.push(newClip(media.id, media.duration)));
}

export function addText(preset = {}) {
  const { time } = getState();
  const id = uid();
  edit((p) => p.texts.push({
    id, start: time, dur: 3, text: "Your text", x: 0.5, y: 0.5, scale: 1, rotation: 0,
    style: { ...defaultTextStyle(), ...preset.style },
    anim: { in: { type: "fade", dur: 0.4 }, out: { type: "fade", dur: 0.4 }, ...preset.anim },
    ...(preset.text ? { text: preset.text } : {}),
  }));
  setState({ selection: [{ kind: "text", id }] });
}

// ---------------- split / delete ----------------

export function splitAtPlayhead() {
  const { project, time, selection } = getState();
  const selectedTexts = selection.filter((s) => s.kind === "text").map((s) => s.id);
  const textsToSplit = project.texts.filter((t) => selectedTexts.includes(t.id) && time > t.start + 0.05 && time < t.start + t.dur - 0.05);

  if (textsToSplit.length) {
    edit((p) => {
      for (const t of textsToSplit) {
        const i = p.texts.findIndex((x) => x.id === t.id);
        const a = p.texts[i];
        const b = structuredClone(a);
        b.id = uid();
        b.start = time;
        b.dur = a.start + a.dur - time;
        a.dur = time - a.start;
        if (a.words) { a.words = a.words.filter((w) => w.t0 < time); b.words = b.words.filter((w) => w.t0 >= time); }
        p.texts.splice(i + 1, 0, b);
      }
    });
    return;
  }

  const seg = layoutMain(project).find((s) => time > s.start + 0.05 && time < s.start + s.dur - 0.05);
  if (!seg) return toast("Move the playhead over a clip to split it");
  edit((p) => {
    const i = p.main.findIndex((s) => s.id === seg.id);
    const a = p.main[i];
    const local = time - seg.start;
    const b = { ...structuredClone(a), id: uid(), in: a.in + local * clipSpeed(a), dur: a.dur - local };
    b.anim = { in: { ...a.anim.in, type: "none" }, out: a.anim.out };
    a.dur = local;
    a.transition = null;
    a.anim.out = { ...a.anim.out, type: "none" };
    p.main.splice(i + 1, 0, b);
  });
}

export function deleteSelection() {
  const { selection } = getState();
  if (!selection.length) return;
  const ids = (kind) => new Set(selection.filter((s) => s.kind === kind).map((s) => s.id));
  const main = ids("main"), texts = ids("text"), transitions = ids("transition");
  edit((p) => {
    p.main = p.main.filter((s) => !main.has(s.id));
    p.texts = p.texts.filter((t) => !texts.has(t.id));
    for (const s of p.main) if (transitions.has(s.id)) s.transition = null;
  });
  setState({ selection: [] });
}

export function selectAll() {
  const { project } = getState();
  setState({
    selection: [
      ...project.main.map((s) => ({ kind: "main", id: s.id })),
      ...project.texts.map((t) => ({ kind: "text", id: t.id })),
    ],
  });
}

// ---------------- clipboard ----------------

let clipboard = null; // { main: [seg], texts: [text] }

export function copySelection() {
  const { project, selection } = getState();
  const sel = (kind) => new Set(selection.filter((s) => s.kind === kind).map((s) => s.id));
  const main = sel("main"), texts = sel("text");
  clipboard = {
    main: project.main.filter((s) => main.has(s.id)).map((s) => structuredClone(s)),
    texts: project.texts.filter((t) => texts.has(t.id)).map((t) => structuredClone(t)),
  };
  const n = clipboard.main.length + clipboard.texts.length;
  if (n) toast(`Copied ${n} item${n > 1 ? "s" : ""}`);
  return n;
}

export function cutSelection() {
  if (copySelection()) deleteSelection();
}

/** Inserts clips after `afterIndex` and texts starting at `textTime`, then selects them. */
function insertCopies(main, texts, afterIndex, textTime) {
  const newSel = [];
  edit((p) => {
    const clips = main.map((s) => {
      const c = { ...structuredClone(s), id: uid() };
      newSel.push({ kind: "main", id: c.id });
      return c;
    });
    p.main.splice(afterIndex + 1, 0, ...clips);
    const base = Math.min(...texts.map((t) => t.start));
    for (const t of texts) {
      const c = structuredClone(t);
      c.id = uid();
      const shift = textTime + (t.start - base) - t.start;
      c.start += shift;
      if (c.words) c.words = c.words.map((w) => ({ ...w, t0: w.t0 + shift, t1: w.t1 + shift }));
      p.texts.push(c);
      newSel.push({ kind: "text", id: c.id });
    }
  });
  setState({ selection: newSel });
  toast(`Pasted ${newSel.length} item${newSel.length > 1 ? "s" : ""}`);
}

export function paste() {
  if (!clipboard || !(clipboard.main.length + clipboard.texts.length)) return toast("Clipboard is empty");
  const { project, time } = getState();
  const segs = layoutMain(project);
  // Clips go right after the clip under the playhead (or at the end).
  const under = segs.findIndex((s) => time >= s.start && time < s.start + s.dur);
  insertCopies(clipboard.main, clipboard.texts, under >= 0 ? under : segs.length - 1, time);
}

export function duplicateSelection() {
  const { project, selection } = getState();
  const sel = (kind) => new Set(selection.filter((s) => s.kind === kind).map((s) => s.id));
  const main = sel("main"), texts = sel("text");
  const clips = project.main.filter((s) => main.has(s.id));
  const txts = project.texts.filter((t) => texts.has(t.id));
  if (!clips.length && !txts.length) return;
  const lastIndex = Math.max(-1, ...project.main.map((s, i) => (main.has(s.id) ? i : -1)));
  const textEnd = Math.max(0, ...txts.map((t) => t.start + t.dur));
  insertCopies(clips, txts, lastIndex >= 0 ? lastIndex : project.main.length - 1, textEnd);
}

// ---------------- speed ----------------

export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 3, 4];

/** Sets playback speed on the given clips (default: selected clips), keeping the same source footage. */
export function setClipSpeed(speed, ids) {
  const { selection } = getState();
  const targets = new Set(ids ?? selection.filter((s) => s.kind === "main").map((s) => s.id));
  if (!targets.size) return toast("Select a clip to change its speed");
  edit((p) => {
    for (const s of p.main) {
      if (!targets.has(s.id)) continue;
      const span = s.dur * clipSpeed(s); // seconds of source footage used
      s.speed = speed;
      s.dur = Math.max(0.05, span / speed);
    }
  });
}

// ---------------- transitions ----------------

/**
 * Applies a transition. Targets, in order: selected cuts (◆), the cut after each selected clip,
 * otherwise the cut nearest the playhead. `all` applies to every cut.
 */
export function applyTransition(type, dur = 0.6, all = false) {
  const { project, selection, time } = getState();
  const segs = layoutMain(project);
  if (segs.length < 2) return toast("Add at least two clips to use transitions");
  const cutOwners = segs.slice(0, -1).map((s) => s.id); // a cut belongs to the clip before it
  let targets;
  if (all) targets = cutOwners;
  else {
    targets = selection
      .filter((s) => (s.kind === "transition" || s.kind === "main") && cutOwners.includes(s.id))
      .map((s) => s.id);
    if (!targets.length) {
      let best = 0, bestDist = Infinity;
      segs.slice(0, -1).forEach((s, i) => {
        const d = Math.abs(s.start + s.dur - time);
        if (d < bestDist) { bestDist = d; best = i; }
      });
      targets = [cutOwners[best]];
    }
  }
  edit((p) => {
    for (const s of p.main) if (targets.includes(s.id)) s.transition = { type, dur: s.transition?.dur ?? dur };
  });
  setState({ selection: targets.map((id) => ({ kind: "transition", id })) });
  toast(`Transition applied to ${targets.length} cut${targets.length > 1 ? "s" : ""}`);
}
