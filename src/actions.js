// Editing commands shared by buttons, keyboard shortcuts and the preview overlay.
import {
  getState, setState, edit, editLive, uid, layoutMain, projectDuration, defaultTextStyle, LANES, findItem, freeTrack,
  compactTracks,
} from "./store.js";
import { allVideoElements, clipSpeed, elementFor } from "./engine.js";
import { resumeLive } from "./audiofx.js";
import { splitKeyframes, shiftKeyframes, setKey, removeKey, keyAt, propAt, hasKeys, setStatic } from "./keyframes.js";
import { EFFECTS, FILTERS } from "./fx.js";

// ---------------- playback clock ----------------

export const clock = { startT: 0, startNow: 0 };

export function play() {
  const s = getState();
  const t = s.time >= projectDuration(s.project) - 0.05 ? 0 : s.time;
  Object.assign(clock, { startT: t, startNow: performance.now() });
  resumeLive();
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

const kindOf = (file) => file.type.startsWith("image") ? "image"
  : file.type.startsWith("video") ? "video"
  : file.type.startsWith("audio") ? "audio"
  : /\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name) ? "video"
  : /\.(mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(file.name) ? "audio"
  : /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(file.name) ? "image" : null;

/** Reads a file's duration and size. */
function probe(kind, url) {
  return new Promise((resolve) => {
    if (kind === "image") {
      const img = new Image();
      img.onload = () => resolve({ duration: 5, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = url;
    } else {
      const v = document.createElement(kind === "audio" ? "audio" : "video");
      v.preload = "metadata";
      v.onloadedmetadata = () => resolve({ duration: v.duration, w: v.videoWidth || 0, h: v.videoHeight || 0 });
      v.onerror = () => resolve(null);
      v.src = url;
    }
  });
}

/** Adds files to the media pool. Video and images also go on the main track, audio on an audio track. */
export async function importFiles(files, { addToTimeline = true } = {}) {
  const added = [];
  for (const file of files) {
    const kind = kindOf(file);
    if (!kind) continue;
    const url = URL.createObjectURL(file);
    const meta = await probe(kind, url);
    if (!meta) { toast(`Couldn't read ${file.name}`); continue; }
    const id = uid();
    edit((p) => {
      const path = window.cutlineDesktop?.pathFor(file); // desktop app: lets saved projects find the file again
      p.media[id] = { id, name: file.name, kind, url, file, ...meta, ...(path ? { path } : {}) };
      if (!addToTimeline) return;
      if (kind === "audio") {
        const start = getState().time;
        p.audio.push({ id: uid(), mediaId: id, track: freeTrack(p.audio, start, meta.duration), start, in: 0, dur: meta.duration });
        return;
      }
      if (p.main.length === 0 && meta.w && meta.h) {
        // First clip sets the canvas aspect, like most editors do.
        const r = meta.w / meta.h;
        Object.assign(p, r > 1.2 ? { width: 1920, height: 1080 } : r < 0.85 ? { width: 1080, height: 1920 } : { width: 1080, height: 1080 });
      }
      p.main.push(newClip(id, meta.duration));
    });
    added.push(id);
  }
  return added;
}

/** Puts a media item on the main track (default), as an overlay layer at the playhead, or on an audio track. */
export function addMediaToTimeline(media, where) {
  where ??= media.kind === "audio" ? "audio" : "main";
  if (where === "main") {
    if (media.kind === "audio") return toast("Audio goes on an audio track");
    return edit((p) => p.main.push(newClip(media.id, media.duration)));
  }
  const start = getState().time;
  const id = uid();
  if (where === "overlay") {
    if (media.kind === "audio") return toast("Audio can't be a picture layer");
    edit((p) => p.overlays.push({
      id, mediaId: media.id, track: freeTrack(p.overlays, start, media.duration), start, in: 0, dur: media.duration,
      anim: noAnim(), transform: { x: 0.5, y: 0.5, scale: 0.45, rotation: 0 },
    }));
    setState({ selection: [{ kind: "overlay", id }] });
  } else {
    edit((p) => p.audio.push({ id, mediaId: media.id, track: freeTrack(p.audio, start, media.duration), start, in: 0, dur: media.duration }));
    setState({ selection: [{ kind: "audio", id }] });
  }
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

// ---------------- selection helpers ----------------

const selIds = (kind) => new Set(getState().selection.filter((s) => s.kind === kind).map((s) => s.id));

/** Clips/layers to act on: the selection, otherwise whatever is under the playhead. */
export function visualTargets() {
  const { project, selection, time } = getState();
  const picked = selection.filter((s) => s.kind === "main" || s.kind === "overlay");
  if (picked.length) return picked;
  const seg = layoutMain(project).find((s) => time >= s.start && time < s.start + s.dur);
  return seg ? [{ kind: "main", id: seg.id }] : [];
}

/** Local time of the playhead inside an item. */
export function localTime(project, kind, item, time = getState().time) {
  if (kind === "main") return time - (layoutMain(project).find((s) => s.id === item.id)?.start ?? 0);
  return time - item.start;
}

// ---------------- split / delete ----------------

function splitTimed(p, lane, ids, time) {
  for (const id of ids) {
    const i = p[lane].findIndex((x) => x.id === id);
    const a = p[lane][i];
    if (!a || time <= a.start + 0.05 || time >= a.start + a.dur - 0.05) continue;
    const local = time - a.start;
    const b = structuredClone(a);
    b.id = uid();
    b.start = time;
    b.dur = a.dur - local;
    if ("in" in a) b.in = (a.in || 0) + local * clipSpeed(a);
    a.dur = local;
    if (a.words) { a.words = a.words.filter((w) => w.t0 < time); b.words = b.words.filter((w) => w.t0 >= time); }
    if (a.keyframes) [a.keyframes, b.keyframes] = splitKeyframes(a, local);
    if (a.anim) { b.anim = { in: { ...a.anim.in, type: "none" }, out: a.anim.out }; a.anim.out = { ...a.anim.out, type: "none" }; }
    if (a.audio?.fadeOut) a.audio.fadeOut = 0;
    if (b.audio?.fadeIn) b.audio.fadeIn = 0;
    p[lane].splice(i + 1, 0, b);
  }
}

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
        if (a.keyframes) [a.keyframes, b.keyframes] = splitKeyframes(a, time - t.start);
        p.texts.splice(i + 1, 0, b);
      }
    });
    return;
  }

  // Selected layers, audio or timeline effects under the playhead.
  const lanes = ["overlay", "audio", "effect"].map((k) => [LANES[k], [...selIds(k)]]).filter(([, ids]) => ids.length);
  const hits = lanes.some(([lane, ids]) => project[lane].some((x) => ids.includes(x.id) && time > x.start + 0.05 && time < x.start + x.dur - 0.05));
  if (hits) return edit((p) => lanes.forEach(([lane, ids]) => splitTimed(p, lane, ids, time)));

  const seg = layoutMain(project).find((s) => time > s.start + 0.05 && time < s.start + s.dur - 0.05);
  if (!seg) return toast("Move the playhead over a clip to split it");
  edit((p) => splitMain(p, seg, time));
}

/** Splits the main-track clip `seg` (with its computed start) at timeline time `time` (mutates). */
function splitMain(p, seg, time) {
  const i = p.main.findIndex((s) => s.id === seg.id);
  const a = p.main[i];
  const local = time - seg.start;
  const b = { ...structuredClone(a), id: uid(), in: a.in + local * clipSpeed(a), dur: a.dur - local };
  b.anim = { in: { ...a.anim.in, type: "none" }, out: a.anim.out };
  if (a.keyframes) [a.keyframes, b.keyframes] = splitKeyframes(a, local);
  if (a.audio?.fadeOut) a.audio.fadeOut = 0;
  if (b.audio?.fadeIn) b.audio.fadeIn = 0;
  a.dur = local;
  a.transition = null;
  a.anim.out = { ...a.anim.out, type: "none" };
  p.main.splice(i + 1, 0, b);
}

/** Ctrl+B: splits every clip, layer, text, audio item and effect under the playhead, whatever is selected. */
export function splitAllAtPlayhead() {
  const { project, time } = getState();
  const inside = (x) => time > x.start + 0.05 && time < x.start + x.dur - 0.05;
  const seg = layoutMain(project).find(inside);
  const lanes = ["texts", "overlays", "audio", "effects"].map((lane) => [lane, project[lane].filter(inside).map((x) => x.id)]).filter(([, ids]) => ids.length);
  if (!seg && !lanes.length) return toast("Nothing under the playhead to split");
  edit((p) => {
    if (seg) splitMain(p, seg, time);
    for (const [lane, ids] of lanes) splitTimed(p, lane, ids, time);
  });
}

/** Razor tool: splits one item at a clicked time. */
export function splitItemAt(kind, id, time) {
  const { project } = getState();
  if (kind === "main") {
    const seg = layoutMain(project).find((s) => s.id === id);
    if (seg && time > seg.start + 0.05 && time < seg.start + seg.dur - 0.05) edit((p) => splitMain(p, seg, time));
    return;
  }
  const lane = LANES[kind];
  if (!lane) return;
  const x = project[lane].find((y) => y.id === id);
  if (x && time > x.start + 0.05 && time < x.start + x.dur - 0.05) edit((p) => splitTimed(p, lane, [id], time));
}

/** M: mutes or unmutes the selected clips, layers and audio. */
export function toggleMute() {
  const { project, selection } = getState();
  const sel = selection.filter((s) => ["main", "overlay", "audio"].includes(s.kind));
  if (!sel.length) return toast("Select a clip to mute it");
  const allMuted = sel.every((s) => findItem(project, s.kind, s.id)?.mute);
  edit((p) => sel.forEach((s) => { const it = findItem(p, s.kind, s.id); if (it) it.mute = allMuted ? undefined : true; }));
  toast(allMuted ? "Unmuted" : "Muted");
}

/** Zooms the timeline by a factor (keyboard shortcuts). */
export function zoomTimeline(factor) {
  setState({ zoom: Math.max(10, Math.min(300, getState().zoom * factor)) });
}

export function deleteSelection() {
  const { selection } = getState();
  if (!selection.length) return;
  const ids = (kind) => new Set(selection.filter((s) => s.kind === kind).map((s) => s.id));
  const main = ids("main"), texts = ids("text"), transitions = ids("transition");
  edit((p) => {
    p.main = p.main.filter((s) => !main.has(s.id));
    p.texts = p.texts.filter((t) => !texts.has(t.id));
    for (const k of ["overlay", "audio", "effect"]) { const set = ids(k); p[LANES[k]] = p[LANES[k]].filter((x) => !set.has(x.id)); }
    for (const s of p.main) if (transitions.has(s.id)) s.transition = null;
    compactTracks(p);
  });
  setState({ selection: [] });
}

/**
 * Ripple delete: removes the selection and closes the gap it leaves on its own track.
 * (The main track always closes gaps; this extends that to layers, audio, texts and effects.)
 */
export function rippleDelete() {
  const { project, selection } = getState();
  if (!selection.length) return;
  edit((p) => {
    for (const k of ["text", "overlay", "audio", "effect"]) {
      const lane = LANES[k];
      const gone = project[lane].filter((x) => selection.some((s) => s.kind === k && s.id === x.id));
      // Delete from the latest so each shift uses the right positions.
      for (const g of gone.sort((a, b) => b.start - a.start)) {
        p[lane] = p[lane].filter((x) => x.id !== g.id);
        for (const x of p[lane]) {
          if ((x.track ?? 0) !== (g.track ?? 0) || x.start < g.start + g.dur - 1e-3) continue;
          x.start -= g.dur;
          if (x.words) x.words = x.words.map((w) => ({ ...w, t0: w.t0 - g.dur, t1: w.t1 - g.dur }));
        }
      }
    }
    const main = new Set(selection.filter((s) => s.kind === "main").map((s) => s.id));
    p.main = p.main.filter((s) => !main.has(s.id));
    compactTracks(p);
  });
  setState({ selection: [] });
}

export function selectAll() {
  const { project } = getState();
  setState({
    selection: [
      ...project.main.map((s) => ({ kind: "main", id: s.id })),
      ...project.texts.map((t) => ({ kind: "text", id: t.id })),
      ...["overlay", "audio", "effect"].flatMap((k) => project[LANES[k]].map((x) => ({ kind: k, id: x.id }))),
    ],
  });
}

// ---------------- clipboard ----------------

let clipboard = null; // { main: [seg], texts: [text], overlays, audio, effects }

export function copySelection() {
  const { project, selection } = getState();
  const sel = (kind) => new Set(selection.filter((s) => s.kind === kind).map((s) => s.id));
  const main = sel("main"), texts = sel("text");
  clipboard = {
    main: project.main.filter((s) => main.has(s.id)).map((s) => structuredClone(s)),
    texts: project.texts.filter((t) => texts.has(t.id)).map((t) => structuredClone(t)),
  };
  for (const k of ["overlay", "audio", "effect"]) clipboard[LANES[k]] = project[LANES[k]].filter((x) => sel(k).has(x.id)).map((x) => structuredClone(x));
  const n = Object.values(clipboard).reduce((a, l) => a + l.length, 0);
  if (n) toast(`Copied ${n} item${n > 1 ? "s" : ""}`);
  return n;
}

export function cutSelection() {
  if (copySelection()) deleteSelection();
}

/** Inserts clips after `afterIndex` and timed items starting at `textTime` (relative offsets kept), then selects them. */
function insertCopies(main, texts, afterIndex, textTime, others = {}) {
  const newSel = [];
  edit((p) => {
    const clips = main.map((s) => {
      const c = { ...structuredClone(s), id: uid() };
      newSel.push({ kind: "main", id: c.id });
      return c;
    });
    p.main.splice(afterIndex + 1, 0, ...clips);
    const timed = [...texts, ...Object.values(others).flat()];
    const base = Math.min(...timed.map((t) => t.start));
    for (const t of texts) {
      const c = structuredClone(t);
      c.id = uid();
      const shift = textTime + (t.start - base) - t.start;
      c.start += shift;
      if (c.words) c.words = c.words.map((w) => ({ ...w, t0: w.t0 + shift, t1: w.t1 + shift }));
      p.texts.push(c);
      newSel.push({ kind: "text", id: c.id });
    }
    for (const [lane, list] of Object.entries(others)) {
      const kind = Object.keys(LANES).find((k) => LANES[k] === lane);
      for (const x of list) {
        const c = structuredClone(x);
        c.id = uid();
        c.start = textTime + (x.start - base);
        c.track = freeTrack(p[lane], c.start, c.dur);
        p[lane].push(c);
        newSel.push({ kind, id: c.id });
      }
    }
  });
  setState({ selection: newSel });
  toast(`Pasted ${newSel.length} item${newSel.length > 1 ? "s" : ""}`);
}

const otherLanes = (src) => ({ overlays: src.overlays || [], audio: src.audio || [], effects: src.effects || [] });

export function paste() {
  if (!clipboard || !Object.values(clipboard).some((l) => l.length)) return toast("Clipboard is empty");
  const { project, time } = getState();
  const segs = layoutMain(project);
  // Clips go right after the clip under the playhead (or at the end).
  const under = segs.findIndex((s) => time >= s.start && time < s.start + s.dur);
  insertCopies(clipboard.main, clipboard.texts, under >= 0 ? under : segs.length - 1, time, otherLanes(clipboard));
}

export function duplicateSelection() {
  const { project, selection } = getState();
  const sel = (kind) => new Set(selection.filter((s) => s.kind === kind).map((s) => s.id));
  const main = sel("main"), texts = sel("text");
  const clips = project.main.filter((s) => main.has(s.id));
  const txts = project.texts.filter((t) => texts.has(t.id));
  const others = {};
  for (const k of ["overlay", "audio", "effect"]) others[LANES[k]] = project[LANES[k]].filter((x) => sel(k).has(x.id));
  const timed = [...txts, ...Object.values(others).flat()];
  if (!clips.length && !timed.length) return;
  const lastIndex = Math.max(-1, ...project.main.map((s, i) => (main.has(s.id) ? i : -1)));
  const textEnd = Math.max(0, ...timed.map((t) => t.start + t.dur));
  insertCopies(clips, txts, lastIndex >= 0 ? lastIndex : project.main.length - 1, textEnd, others);
}

// ---------------- speed ----------------

export const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 3, 4];

/** Sets playback speed on the given clips (default: selected clips and layers), keeping the same source footage. */
export function setClipSpeed(speed, ids) {
  const { selection } = getState();
  const targets = new Set(ids ?? selection.filter((s) => ["main", "overlay", "audio"].includes(s.kind)).map((s) => s.id));
  if (!targets.size) return toast("Select a clip to change its speed");
  edit((p) => {
    for (const s of [...p.main, ...p.overlays, ...p.audio]) {
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

// ---------------- effects & filters ----------------

/** Adds an effect to the selected clips/layers, or as a 3-second timeline effect when nothing is selected. */
export function applyEffect(type, { toTimeline = false } = {}) {
  const targets = toTimeline ? [] : getState().selection.filter((s) => s.kind === "main" || s.kind === "overlay");
  if (!targets.length) {
    const { time } = getState();
    const id = uid();
    edit((p) => p.effects.push({ id, track: freeTrack(p.effects, time, 3), start: time, dur: 3, name: EFFECTS[type].label, fx: [{ id: uid(), type, amount: 0.7 }] }));
    setState({ selection: [{ kind: "effect", id }] });
    return toast(`${EFFECTS[type].label} added to the timeline`);
  }
  edit((p) => targets.forEach((t) => {
    const it = findItem(p, t.kind, t.id);
    it.fx = [...(it.fx || []), { id: uid(), type, amount: 0.7 }];
  }));
  toast(`${EFFECTS[type].label} added to ${targets.length} clip${targets.length > 1 ? "s" : ""}`);
}

/** Sets a filter on the selected clips/layers (or the clip under the playhead). */
export function applyFilter(type, amount = 1) {
  const targets = visualTargets();
  if (!targets.length) return toast("Add a clip first");
  edit((p) => targets.forEach((t) => {
    const it = findItem(p, t.kind, t.id);
    it.filter = type ? { type, amount: it.filter?.amount ?? amount } : null;
  }));
  toast(type ? `${FILTERS[type].label} filter applied` : "Filter removed");
}

/** An empty adjustment layer: colour, filter and effects on everything under it for 3 seconds. */
export function addAdjustmentLayer() {
  const { time } = getState();
  const id = uid();
  edit((p) => p.effects.push({ id, track: freeTrack(p.effects, time, 3), start: time, dur: 3, name: "Adjustment", fx: [], adjust: {} }));
  setState({ selection: [{ kind: "effect", id }] });
}

// ---------------- keyframes ----------------

/**
 * Sets a property on an item: if the property is keyframed, the keyframe at the playhead is created or
 * updated; otherwise the static value changes (the usual editor behaviour).
 */
export function setAnimatable(kind, id, path, value, live = false) {
  const p0 = getState().project;
  const item = findItem(p0, kind, id);
  if (!item) return;
  const lt = localTime(p0, kind, item);
  const apply = (p) => {
    const it = findItem(p, kind, id);
    if (hasKeys(it, path)) setKey(it, path, Math.max(0, Math.min(it.dur, lt)), value);
    else setStatic(it, path, value);
  };
  return live ? editLive(apply) : edit(apply);
}

/** Adds a keyframe at the playhead holding the current value, or removes the one that is there. */
export function toggleKeyframe(kind, id, path, fallback) {
  const p0 = getState().project;
  const item = findItem(p0, kind, id);
  if (!item) return;
  const lt = Math.max(0, Math.min(item.dur, localTime(p0, kind, item)));
  if (getState().time < (kind === "main" ? layoutMain(p0).find((s) => s.id === id).start : item.start) - 1e-3 || lt > item.dur) return toast("Move the playhead over the item first");
  edit((p) => {
    const it = findItem(p, kind, id);
    if (keyAt(it, path, lt)) removeKey(it, path, lt);
    else setKey(it, path, lt, propAt(it, path, lt, fallback));
  });
}

/** Removes every keyframe of a property (the value at the playhead becomes the static value). */
export function clearKeyframes(kind, id, path, fallback) {
  const p0 = getState().project;
  const item = findItem(p0, kind, id);
  const lt = localTime(p0, kind, item);
  const v = propAt(item, path, lt, fallback);
  edit((p) => {
    const it = findItem(p, kind, id);
    delete it.keyframes[path];
    setStatic(it, path, v);
  });
}

/** Left-trim helper: keyframes stay pinned to the footage when the start moves by `dt` timeline seconds. */
export const shiftItemKeys = (item, dt) => item.keyframes && shiftKeyframes(item, -dt, item.dur);

// ---------------- cut tools ----------------

/**
 * Freeze frame: holds the frame under the playhead for `dur` seconds. On the main track the clip is split
 * and the still goes in between; on a layer, the still is inserted on the same track.
 */
export async function freezeFrame(dur = 3) {
  const { project, time, selection } = getState();
  const layerSel = selection.find((s) => s.kind === "overlay");
  const layer = layerSel && project.overlays.find((o) => o.id === layerSel.id && time >= o.start && time < o.start + o.dur);
  const seg = !layer && layoutMain(project).find((s) => time >= s.start && time < s.start + s.dur);
  const item = layer || seg;
  if (!item) return toast("Park the playhead inside a clip to freeze a frame");
  const media = project.media[item.mediaId];
  if (media.kind !== "video") return toast("Freeze frame works on video clips");
  const local = time - item.start;
  const el = elementFor(item, media);
  const srcTime = (item.in || 0) + local * clipSpeed(item);
  if (Math.abs(el.currentTime - srcTime) > 1 / 60) {
    await new Promise((r) => { el.addEventListener("seeked", r, { once: true }); el.currentTime = srcTime; setTimeout(r, 1500); });
  }
  const c = document.createElement("canvas");
  c.width = media.w; c.height = media.h;
  c.getContext("2d").drawImage(el, 0, 0, media.w, media.h);
  const blob = await new Promise((r) => c.toBlob(r, "image/png"));
  const file = new File([blob], `${media.name.replace(/\.[^.]+$/, "")} frame ${local.toFixed(2)}s.png`, { type: "image/png" });
  const mid = uid();
  const still = { id: mid, name: file.name, kind: "image", url: URL.createObjectURL(blob), file, duration: 5, w: media.w, h: media.h };
  const copyLook = (x) => {
    const keep = ["transform", "opacity", "blend", "crop", "flipH", "flipV", "adjust", "filter", "fx", "chroma", "cutout"];
    return Object.fromEntries(keep.filter((k) => x[k] !== undefined).map((k) => [k, structuredClone(x[k])]));
  };
  edit((p) => {
    p.media[mid] = still;
    if (layer) {
      const it = p.overlays.find((o) => o.id === layer.id);
      const after = structuredClone(it);
      after.id = uid();
      after.start = time + dur;
      after.dur = it.dur - local;
      after.in = srcTime;
      it.dur = local;
      for (const o of p.overlays) if ((o.track ?? 0) === (it.track ?? 0) && o.start >= time - 1e-3 && o.id !== it.id) o.start += dur;
      p.overlays.push({ ...copyLook(it), id: uid(), mediaId: mid, track: it.track ?? 0, start: time, in: 0, dur, anim: noAnim() }, after);
      if (after.dur < 0.02) p.overlays.pop();
    } else {
      const i = p.main.findIndex((s) => s.id === seg.id);
      const a = p.main[i];
      const freeze = { ...newClip(mid, dur), ...copyLook(a) };
      if (local < 0.02) { p.main.splice(i, 0, freeze); return; }
      const b = { ...structuredClone(a), id: uid(), in: a.in + local * clipSpeed(a), dur: a.dur - local, keyframes: undefined };
      b.anim = { in: { ...a.anim.in, type: "none" }, out: a.anim.out };
      a.dur = local;
      a.anim.out = { ...a.anim.out, type: "none" };
      const tr = a.transition;
      a.transition = null;
      freeze.transition = null;
      b.transition = tr;
      p.main.splice(i + 1, 0, freeze, ...(b.dur > 0.02 ? [b] : []));
    }
  });
  toast(`Froze the frame for ${dur} s`);
}

/** Merges selected neighbouring main-track pieces that came from one split back into a single clip. */
export function mergeClips() {
  const { project, selection } = getState();
  const ids = new Set(selection.filter((s) => s.kind === "main").map((s) => s.id));
  if (ids.size < 2) return toast("Select two or more neighbouring clips to merge");
  let merged = 0;
  edit((p) => {
    for (let i = p.main.length - 2; i >= 0; i--) {
      const a = p.main[i], b = p.main[i + 1];
      if (!ids.has(a.id) || !ids.has(b.id) || a.mediaId !== b.mediaId || clipSpeed(a) !== clipSpeed(b)) continue;
      if (Math.abs(a.in + a.dur * clipSpeed(a) - b.in) > 0.05) continue; // not contiguous footage
      a.dur += b.dur;
      a.transition = b.transition;
      a.anim.out = b.anim.out;
      p.main.splice(i + 1, 1);
      merged++;
    }
  });
  toast(merged ? `Merged ${merged + 1} clips` : "Only pieces of the same clip that follow each other can be merged");
}

/** Detaches a main clip's sound onto an audio track and mutes the clip. */
export function detachAudio() {
  const { project, selection } = getState();
  const sel = selection.filter((s) => s.kind === "main" || s.kind === "overlay");
  if (!sel.length) return toast("Select a clip to detach its audio");
  const segs = layoutMain(project);
  edit((p) => sel.forEach((s) => {
    const it = findItem(p, s.kind, s.id);
    if (p.media[it.mediaId]?.kind !== "video" || it.mute) return;
    const start = s.kind === "main" ? segs.find((x) => x.id === s.id).start : it.start;
    p.audio.push({
      id: uid(), mediaId: it.mediaId, track: freeTrack(p.audio, start, it.dur), start, in: it.in || 0, dur: it.dur,
      ...(it.speed ? { speed: it.speed } : {}), ...(it.audio ? { audio: structuredClone(it.audio) } : {}),
      ...(it.keyframes?.volume ? { keyframes: { volume: structuredClone(it.keyframes.volume) } } : {}),
    });
    it.mute = true;
  }));
  toast("Audio detached to an audio track");
}
