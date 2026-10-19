// Editing commands shared by buttons, keyboard shortcuts and the preview overlay.
import {
  getState, setState, edit, editLive, uid, layoutMain, projectDuration, defaultTextStyle, LANES, findItem, freeTrack,
  compactTracks,
} from "./store.js";
import { allVideoElements, clipSpeed, elementFor } from "./engine.js";
import { resumeLive } from "./audiofx.js";
import { splitKeyframes, shiftKeyframes, setKey, removeKey, keyAt, propAt, hasKeys, setStatic } from "./keyframes.js";
import { EFFECTS, FILTERS } from "./fx.js";
import { hasCurve, sourceAt, sourceSpan, subCurve, rampEnd, rampStart, startSpeed, endSpeed } from "./speed.js";

/** Splits a clip's speed curve at local time `local` between two halves a (before) and b (after); mutates. */
function splitCurve(a, b, local) {
  if (!hasCurve(a)) return;
  const full = a.speedCurve;
  const total = local + b.dur;
  b.speedCurve = subCurve(full, local, total, total);
  a.speedCurve = subCurve(full, 0, local, total);
}

// ---------------- playback clock ----------------

export const clock = { startT: 0, startNow: 0 };

export function play() {
  const s = getState();
  const t = s.time >= projectDuration(s.project) - 0.05 ? 0 : s.time;
  Object.assign(clock, { startT: t, startNow: performance.now() });
  resumeLive();
  if (s.preview) closePreview();
  setState({ playing: true, time: t });
}

export function pause() {
  setState({ playing: false });
  allVideoElements().forEach((v) => v.pause());
}

export const togglePlay = () => (getState().playing ? pause() : play());

export function seek(t) {
  if (getState().preview) closePreview();
  const time = Math.max(0, Math.min(projectDuration(getState().project), t));
  Object.assign(clock, { startT: time, startNow: performance.now() });
  setState({ time });
}

// ---------------- feedback ----------------

let toastTimer;
export function toast(message, ms = 1600) {
  clearTimeout(toastTimer);
  setState({ toast: message });
  toastTimer = setTimeout(() => setState({ toast: null }), ms);
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
      let meta = null;
      const done = (extra = {}) => resolve(meta ? { ...meta, ...extra } : null);
      v.onloadedmetadata = () => {
        meta = { duration: v.duration, w: v.videoWidth || 0, h: v.videoHeight || 0 };
        if (kind !== "video") return done();
        // A picture this engine can't decode (some HEVC, ProRes or old camera files) either has no size or
        // fails once the first frame is decoded, so wait for that frame before trusting the file.
        if (!v.videoWidth) return done({ noPicture: true });
        v.onloadeddata = () => done();
        setTimeout(() => done(), 4000);
      };
      v.onerror = () => done(meta ? { noPicture: true } : {});
      if (kind === "video") v.preload = "auto";
      v.src = url;
      setTimeout(() => resolve(null), 15000); // never hang on a broken file
    }
  });
}

const CANT_PLAY = "This video's format can't be played here. Convert it to MP4 (H.264), e.g. with HandBrake or your phone's \"Most compatible\" camera setting.";

/**
 * Adds files to the media library. By default they only go to the library (preview them there, then add
 * them); `addToTimeline` also puts video/pictures on the main track and audio on an audio track.
 */
export async function importFiles(files, { addToTimeline = false } = {}) {
  const added = [];
  let warned = false;
  for (const file of files) {
    const kind = kindOf(file);
    if (!kind) continue;
    const url = URL.createObjectURL(file);
    const meta = await probe(kind, url);
    if (!meta) { toast(kind === "video" ? `${file.name}: ${CANT_PLAY}` : `Couldn't read ${file.name}`, 8000); warned = true; continue; }
    if (meta.noPicture) { toast(`${file.name}: ${CANT_PLAY}`, 8000); warned = true; }
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
      setCanvasFromFirstClip(p, meta);
      p.main.push(newClip(id, meta.duration));
    });
    added.push(id);
  }
  if (added.length && !addToTimeline && !warned) toast(`${added.length} file${added.length > 1 ? "s" : ""} added to the library — click to preview, then add to the timeline`);
  return added;
}

/**
 * Desktop app: adds files to the library straight from their paths on disk (no copy in memory). Files
 * already in the library are skipped. Returns { added, missing, skipped }.
 */
export async function importPaths(paths) {
  const desktop = window.cutlineDesktop;
  if (!desktop) return { added: [], missing: paths, skipped: [] };
  const have = new Set(Object.values(getState().project.media).map((m) => m.path).filter(Boolean));
  const added = [], missing = [], skipped = [];
  for (const path of paths) {
    if (have.has(path)) { skipped.push(path); continue; }
    if (!(await desktop.exists(path))) { missing.push(path); continue; }
    const name = path.split(/[\\/]/).pop();
    const kind = kindOf({ type: "", name });
    if (!kind) { missing.push(path); continue; }
    const url = desktop.fileUrl(path);
    const meta = await probe(kind, url);
    if (!meta) { missing.push(path); continue; }
    const id = uid();
    const file = { name, type: "", arrayBuffer: () => fetch(url).then((r) => { if (!r.ok) throw new Error("missing"); return r.arrayBuffer(); }) };
    edit((p) => { p.media[id] = { id, name, kind, url, file, path, ...meta }; });
    added.push(id);
    have.add(path);
  }
  return { added, missing, skipped };
}

/** The first clip on an empty main track sets the canvas aspect, like most editors do (mutates). */
function setCanvasFromFirstClip(p, media) {
  if (p.main.length || !media.w || !media.h) return;
  const r = media.w / media.h;
  Object.assign(p, r > 1.2 ? { width: 1920, height: 1080 } : r < 0.85 ? { width: 1080, height: 1920 } : { width: 1080, height: 1080 });
}

// ---------------- library preview (source viewer) ----------------

/** Shows a library item in the viewer instead of the timeline. */
export function openPreview(mediaId) {
  if (getState().playing) pause();
  setState({ preview: { mediaId, in: null, out: null } });
}

export function closePreview() {
  setState({ preview: null });
}

/** The marked In/Out range of the previewed item, in source seconds (whole file when unmarked). */
export function previewRange(media) {
  const pv = getState().preview;
  const a = pv?.mediaId === media.id && pv.in != null ? pv.in : 0;
  const b = pv?.mediaId === media.id && pv.out != null ? pv.out : media.duration;
  return b - a > 0.05 ? { in: a, dur: b - a } : { in: 0, dur: media.duration };
}

/**
 * Puts a media item on the timeline: the main track (default for video/pictures, appended at the end, or
 * at `opts.index`), as an overlay layer, or on an audio track (at `opts.time`, default the playhead).
 * Uses the In/Out range marked in the preview, if any.
 */
/** Whether compound media `m` contains media `id`, at any depth. */
function compoundContains(m, id, all, depth = 0) {
  if (m?.kind !== "compound" || depth > 8) return false;
  return [...(m.sequence.main || []), ...(m.sequence.overlays || [])].some((x) => x.mediaId === id || compoundContains(all[x.mediaId], id, all, depth + 1));
}

export function addMediaToTimeline(media, where, opts = {}) {
  if (media.missing) return toast("That file is missing — relink it first");
  const open = getState().compoundOpen || [];
  if (media.kind === "compound" && open.some((id) => id === media.id || compoundContains(media, id, getState().project.media))) {
    return toast("A compound clip can't go inside itself");
  }
  where ??= media.kind === "audio" ? "audio" : "main";
  if (where === "main" && media.kind === "audio") where = "audio";
  if (where === "overlay" && media.kind === "audio") where = "audio";
  const range = opts.range || previewRange(media);
  const id = uid();
  if (where === "main") {
    edit((p) => {
      setCanvasFromFirstClip(p, media);
      const clip = { ...newClip(media.id, range.dur), id, in: range.in };
      const at = opts.index == null ? p.main.length : Math.max(0, Math.min(p.main.length, opts.index));
      p.main.splice(at, 0, clip);
    });
    setState({ selection: [{ kind: "main", id }] });
  } else {
    const start = Math.max(0, opts.time ?? getState().time);
    const lane = where === "overlay" ? "overlays" : "audio";
    edit((p) => {
      const track = opts.track != null
        ? (p[lane].some((x) => (x.track ?? 0) === opts.track && x.start < start + range.dur && x.start + x.dur > start) ? freeTrack(p[lane], start, range.dur) : opts.track)
        : freeTrack(p[lane], start, range.dur);
      const item = { id, mediaId: media.id, track, start, in: range.in, dur: range.dur };
      if (where === "overlay") Object.assign(item, { anim: noAnim(), transform: { x: 0.5, y: 0.5, scale: 0.45, rotation: 0 } });
      p[lane].push(item);
    });
    setState({ selection: [{ kind: where === "overlay" ? "overlay" : "audio", id }] });
  }
  if (getState().preview) closePreview();
  toast(where === "main" ? "Added to the main track" : where === "overlay" ? "Added as a layer at the playhead" : "Added to an audio track");
}

export function addText(preset = {}) {
  const { time } = getState();
  const id = uid();
  edit((p) => p.texts.push({
    id, start: time, dur: 3, text: "Your text", x: 0.5, y: 0.5, scale: 1, rotation: 0, oneLine: true,
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
    if ("in" in a) b.in = sourceAt(a, local);
    splitCurve(a, b, local);
    a.dur = local;
    if (a.words) { a.words = a.words.filter((w) => w.t0 < time); b.words = b.words.filter((w) => w.t0 >= time); }
    if (b.sound) delete b.sound; // a text's sound belongs to its first piece
    if (a.keyframes) [a.keyframes, b.keyframes] = splitKeyframes(a, local);
    // Text pieces each keep the original in and out animation; clips/layers only animate at the outer ends.
    if (a.anim && lane !== "texts") { b.anim = { in: { ...a.anim.in, type: "none" }, out: a.anim.out }; a.anim.out = { ...a.anim.out, type: "none" }; }
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
        if (b.sound) delete b.sound;
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
  const b = { ...structuredClone(a), id: uid(), in: sourceAt(a, local), dur: a.dur - local };
  b.anim = { in: { ...a.anim.in, type: "none" }, out: a.anim.out };
  if (a.keyframes) [a.keyframes, b.keyframes] = splitKeyframes(a, local);
  splitCurve(a, b, local);
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

/**
 * Q / W: removes the part of the selected clip(s) before (Q) or after (W) the playhead, like most editors.
 * With nothing selected it works on the main-track clip under the playhead. The main track closes the gap.
 */
export function trimToPlayhead(side) {
  const { project, time, selection } = getState();
  let targets = selection.filter((s) => ["main", "overlay", "audio", "text", "effect"].includes(s.kind));
  if (!targets.length) {
    const seg = layoutMain(project).find((s) => time > s.start && time < s.start + s.dur);
    if (seg) targets = [{ kind: "main", id: seg.id }];
  }
  if (!targets.length) return toast("Select a clip under the playhead first");
  let n = 0;
  edit((p) => {
    const segs = layoutMain(p);
    for (const t of targets) {
      const it = findItem(p, t.kind, t.id);
      if (!it) continue;
      const start = t.kind === "main" ? segs.find((s) => s.id === t.id)?.start : it.start;
      const local = time - start;
      if (local <= 0.02 || local >= it.dur - 0.02) continue;
      if (side === "left") {
        if ("in" in it || t.kind === "main") it.in = sourceAt(it, local);
        if (it.keyframes) shiftKeyframes(it, -local, it.dur - local);
        if (it.words) it.words = it.words.filter((w) => w.t1 > time);
        if (t.kind !== "main") it.start = time;
        it.dur -= local;
      } else {
        it.dur = local;
        if (t.kind === "main") it.transition = null;
        if (it.words) it.words = it.words.filter((w) => w.t0 < time);
      }
      n++;
    }
  });
  if (!n) toast("Move the playhead inside the clip first");
  else if (side === "left" && targets[0].kind === "main") seek(layoutMain(getState().project).find((s) => s.id === targets[0].id)?.start ?? time);
}

/**
 * Smooths the speed change at a cut between two touching clips (main track, or the same layer/audio
 * track). mode: "both" glides from one speed to the other across the cut, "out" eases the left clip into
 * the right clip's speed, "in" eases the right clip in from the left clip's speed. `seconds` = ramp length.
 */
export function easeSpeedAtCut(kind, leftId, rightId, mode = "both", seconds = getState().speedRamp ?? 0.6) {
  const p0 = getState().project;
  const a0 = findItem(p0, kind, leftId), b0 = findItem(p0, kind, rightId);
  if (!a0 || !b0) return;
  const va = endSpeed(a0), vb = startSpeed(b0);
  if (Math.abs(Math.log(va / vb)) < 0.02) return toast("Both clips already play at the same speed at this cut");
  const mid = Math.sqrt(va * vb);
  edit((p) => {
    const a = findItem(p, kind, leftId), b = findItem(p, kind, rightId);
    if (mode === "both") { rampEnd(a, mid, seconds / 2); rampStart(b, mid, seconds / 2); }
    else if (mode === "out") rampEnd(a, vb, seconds);
    else rampStart(b, va, seconds);
    if (kind !== "main") {
      // Layers/audio: keep the right clip butted against the left one after the left's length changed.
      b.start = a.start + a.dur;
    }
  });
  toast(mode === "both" ? `Speed eases ${+va.toFixed(2)}× → ${+vb.toFixed(2)}× across the cut` : mode === "out" ? `Left clip eases into ${+vb.toFixed(2)}×` : `Right clip eases in from ${+va.toFixed(2)}×`);
}

/** The clip right after / before an item on its own track, if they touch. */
export function neighbour(project, kind, item, dir) {
  if (kind === "main") {
    const i = project.main.findIndex((s) => s.id === item.id);
    return project.main[i + dir] || null;
  }
  const lane = LANES[kind];
  const edge = dir > 0 ? item.start + item.dur : item.start;
  return (project[lane] || []).find((x) => x.id !== item.id && (x.track ?? 0) === (item.track ?? 0)
    && Math.abs((dir > 0 ? x.start : x.start + x.dur) - edge) < 0.05) || null;
}

/** Removes any speed curve from the selected clips (back to their average constant speed). */
export function resetSpeedCurve(kind, id) {
  // Same footage and length: the clip plays at its average speed instead of the curve.
  edit((p) => { const it = findItem(p, kind, id); if (it && hasCurve(it)) { const v = sourceSpan(it) / it.dur; delete it.speedCurve; it.speed = v; } });
}

// ---------------- sounds on texts ----------------

/** Gives texts a sound (from the library). `ids` default: the selected texts. Keeps their timing setting. */
export function setTextSound(mediaId, ids) {
  const targets = new Set(ids ?? getState().selection.filter((s) => s.kind === "text").map((s) => s.id));
  if (!targets.size) return toast("Select a text first");
  edit((p) => p.texts.forEach((t) => {
    if (!targets.has(t.id)) return;
    const m = p.media[mediaId];
    t.sound = mediaId ? { when: "anim", volume: 1, ...(t.sound || {}), mediaId, name: m?.name, ...(m?.path ? { path: m.path } : {}) } : undefined;
    if (!mediaId) delete t.sound;
  }));
  if (mediaId) toast(`Sound added to ${targets.size} text${targets.size > 1 ? "s" : ""}`);
}

/** Copies one text's sound (file, timing, volume) to every text, or every caption. */
export function soundToAll(fromId, onlyCaptions = false) {
  const src = getState().project.texts.find((t) => t.id === fromId)?.sound;
  if (!src) return;
  let n = 0;
  edit((p) => p.texts.forEach((t) => { if (t.id !== fromId && (!onlyCaptions || t.caption)) { t.sound = { ...src }; n++; } }));
  toast(`Same sound on ${n} more text${n === 1 ? "" : "s"}`);
}

/** Mirrors the selected clips/layers left-right (toggle). */
export function mirrorSelection() {
  const targets = visualTargets();
  if (!targets.length) return toast("Select a clip to mirror");
  edit((p) => targets.forEach((t) => { const it = findItem(p, t.kind, t.id); if (it) it.flipH = !it.flipH || undefined; }));
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
  setState({ zoom: clampZoom(getState().zoom * factor) });
}

/** Timeline zoom limits in pixels per second: from about 2 hours on screen down to frame-level detail. */
export const ZOOM_MIN = 0.15, ZOOM_MAX = 400;
export const clampZoom = (z) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

/** Zooms so the whole project fits the visible timeline width. */
export function zoomToFit() {
  const el = document.querySelector(".tl-scroll");
  const dur = Math.max(1, projectDuration(getState().project));
  setState({ zoomFit: true, zoom: clampZoom(((el?.clientWidth || 1200) - 70 - 40) / dur) });
  if (el) el.scrollLeft = 0;
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
      const span = sourceSpan(s); // seconds of source footage used
      delete s.speedCurve; // a constant speed replaces any speed curve
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
  const srcTime = sourceAt(item, local);
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
      const b = { ...structuredClone(a), id: uid(), in: sourceAt(a, local), dur: a.dur - local, keyframes: undefined };
      splitCurve(a, b, local);
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
      if (!ids.has(a.id) || !ids.has(b.id) || a.mediaId !== b.mediaId || clipSpeed(a) !== clipSpeed(b) || hasCurve(a) || hasCurve(b)) continue;
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
      ...(it.speed ? { speed: it.speed } : {}), ...(it.speedCurve ? { speedCurve: structuredClone(it.speedCurve) } : {}),
      ...(it.audio ? { audio: structuredClone(it.audio) } : {}),
      ...(it.keyframes?.volume ? { keyframes: { volume: structuredClone(it.keyframes.volume) } } : {}),
    });
    it.mute = true;
  }));
  toast("Audio detached to an audio track");
}
