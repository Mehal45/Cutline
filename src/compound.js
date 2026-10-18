// Compound clips: several clips, layers and texts packed into one clip. The packed timeline lives on a
// media entry { kind: "compound", sequence: { main, texts, overlays, audio, effects } }, so a compound clip can
// be trimmed, sped up, moved, keyframed and given effects like any video, used more than once, and nested.
//
// Double-clicking one opens its own timeline for editing (with its own undo history). Closing it writes the
// changes back as one undo step in the timeline around it.
import { getState, setState, edit, uid, layoutMain, projectDuration, findItem, freeTrack, swapHistory } from "./store.js";
import { clipSpeed } from "./engine.js";
import { newClip, toast } from "./actions.js";

const stack = []; // open compound clips, outermost first: { project, history, mediaId, time, name, opened }

const LANE_OF = { overlay: "overlays", text: "texts", audio: "audio", effect: "effects" };

/** The breadcrumb shown above the timeline while a compound clip is open. */
const publishTrail = () => setState({ compoundTrail: stack.map((s) => s.name), compoundOpen: stack.map((s) => s.mediaId) });

const sequenceOf = (p) => ({
  main: p.main, texts: p.texts, overlays: p.overlays || [], audio: p.audio || [], effects: p.effects || [],
  ...(p.trackState ? { trackState: p.trackState } : {}),
});

/** The parent timeline with an edited compound timeline written back into it. */
function foldInto(parent, mediaId, child) {
  const old = parent.media[mediaId];
  const duration = Math.max(0.1, projectDuration(child));
  const media = { ...child.media, [mediaId]: { ...child.media[mediaId], sequence: sequenceOf(child), duration } };
  // Uses of the compound clip stay valid: ones that showed all of it grow or shrink with it, others are trimmed.
  const fit = (x) => {
    if (x.mediaId !== mediaId) return x;
    const sp = clipSpeed(x), inn = Math.min(x.in || 0, duration - 0.05);
    const whole = (x.in || 0) < 0.01 && Math.abs(x.dur * sp - (old?.duration ?? 0)) < 0.05;
    const dur = whole ? duration / sp : Math.min(x.dur, (duration - inn) / sp);
    return { ...x, in: inn, dur: Math.max(0.05, dur) };
  };
  return { ...parent, width: child.width, height: child.height, media, main: parent.main.map(fit), overlays: (parent.overlays || []).map(fit) };
}

/** The whole project (what gets saved), even while a compound clip is open. */
export function rootProject() {
  let p = getState().project;
  for (let i = stack.length - 1; i >= 0; i--) p = foldInto(stack[i].project, stack[i].mediaId, p);
  return p;
}

/** Forgets open compound clips (after opening or starting a project). */
export function resetCompounds() {
  stack.length = 0;
  publishTrail();
}

export const insideCompound = () => stack.length > 0;
/** Whether a compound media is open (adding it to itself would loop forever). */
export const isOpenCompound = (mediaId) => stack.some((s) => s.mediaId === mediaId);

/** Opens a compound clip's own timeline. */
export function openCompound(mediaId) {
  const s = getState();
  const parent = s.project;
  const m = parent.media[mediaId];
  if (!m?.sequence) return;
  if (isOpenCompound(mediaId)) return toast("That compound clip is already open");
  const history = swapHistory(null);
  const child = { width: parent.width, height: parent.height, fps: parent.fps, media: parent.media, trackState: undefined, ...m.sequence };
  if (!child.trackState) delete child.trackState;
  stack.push({ project: parent, history, mediaId, time: s.time, name: m.name, opened: child });
  setState({ project: child, selection: [], time: 0, playing: false });
  publishTrail();
  toast(`Editing ${m.name}. Click ◂ Back above the timeline when you're done`, 2600);
}

/** Closes open compound clips (`levels` of them, default 1), keeping the changes. */
export function closeCompound(levels = 1) {
  while (levels-- > 0 && stack.length) {
    const top = stack.pop();
    const child = getState().project;
    swapHistory(top.history);
    setState({ project: top.project, selection: [], playing: false });
    if (child !== top.opened) {
      const after = foldInto(top.project, top.mediaId, child);
      edit((p) => Object.assign(p, after));
    }
    setState({ time: top.time });
  }
  publishTrail();
}

const compoundCount = (media) => Object.values(media).filter((m) => m.kind === "compound").length;

/** Packs the selected clips, layers, texts, audio and effects into one compound clip. */
export function createCompound() {
  const s = getState();
  const p = s.project;
  const sel = s.selection.filter((x) => x.kind === "main" || LANE_OF[x.kind]);
  if (!sel.length) return toast("Select the clips, layers or texts to put in the compound clip first");
  const segs = layoutMain(p);
  const mainSel = segs.filter((x) => sel.some((y) => y.kind === "main" && y.id === x.id));
  const idx = mainSel.map((x) => segs.indexOf(x));
  if (mainSel.length && Math.max(...idx) - Math.min(...idx) + 1 !== idx.length) {
    return toast("Main-track clips in a compound clip have to be next to each other");
  }
  const picked = {};
  for (const [kind, lane] of Object.entries(LANE_OF)) picked[lane] = sel.filter((x) => x.kind === kind).map((x) => findItem(p, kind, x.id)).filter(Boolean);
  const laneItems = Object.values(picked).flat();
  const t0 = mainSel.length ? mainSel[0].start : Math.min(...laneItems.map((x) => x.start));
  if (mainSel.length && laneItems.some((x) => x.start < t0 - 1e-3)) {
    return toast("Layers and texts in a compound clip can't start before its first main-track clip");
  }
  const strip = ({ start: _s, ...x }) => structuredClone(x);
  const sequence = {
    main: mainSel.map((x, i) => ({ ...strip(x), transition: i < mainSel.length - 1 ? x.transition : null })),
    texts: picked.texts.map((x) => ({ ...structuredClone(x), start: x.start - t0 })),
    overlays: picked.overlays.map((x) => ({ ...structuredClone(x), start: x.start - t0 })),
    audio: picked.audio.map((x) => ({ ...structuredClone(x), start: x.start - t0 })),
    effects: picked.effects.map((x) => ({ ...structuredClone(x), start: x.start - t0 })),
  };
  const duration = Math.max(0.1, projectDuration(sequence));
  const mediaId = uid();
  const name = `Compound clip ${compoundCount(p.media) + 1}`;
  const clip = newClip(mediaId, duration);
  const onMain = mainSel.length > 0;
  edit((d) => {
    d.media[mediaId] = { id: mediaId, name, kind: "compound", url: "", duration, w: d.width, h: d.height, sequence };
    if (onMain) {
      const first = d.main.findIndex((x) => x.id === mainSel[0].id);
      clip.transition = mainSel.at(-1).transition || null;
      d.main.splice(first, mainSel.length, clip);
    }
    for (const [lane, items] of Object.entries(picked)) {
      const gone = new Set(items.map((x) => x.id));
      d[lane] = (d[lane] || []).filter((x) => !gone.has(x.id));
    }
    if (!onMain) {
      // Layers only: the compound clip becomes a full-frame layer where they were.
      d.overlays.push({ ...clip, start: t0, track: freeTrack(d.overlays, t0, duration) });
    }
  });
  setState({ selection: [{ kind: onMain ? "main" : "overlay", id: clip.id }] });
  toast(`${name} made — double-click it to edit what's inside`);
}

/** Unpacks a compound clip back into its clips, layers and texts (it must be untrimmed and at normal speed). */
export function breakApart(kind, id) {
  const p = getState().project;
  const c = findItem(p, kind, id);
  const m = c && p.media[c.mediaId];
  if (!m?.sequence) return;
  if ((c.in || 0) > 0.01 || Math.abs(c.dur - m.duration) > 0.05 || Math.abs(clipSpeed(c) - 1) > 1e-3) {
    return toast("Break apart works on a compound clip at full length and normal speed");
  }
  const seq = m.sequence;
  const start = kind === "main" ? layoutMain(p).find((x) => x.id === id).start : c.start;
  const fresh = (x) => ({ ...structuredClone(x), id: uid() });
  const ids = [];
  edit((d) => {
    const place = (lane, x, at) => {
      const item = { ...fresh(x), start: at };
      if (lane !== "texts" || x.track != null) item.track = freeTrack(d[lane], at, item.dur);
      d[lane].push(item);
      ids.push({ kind: Object.keys(LANE_OF).find((k) => LANE_OF[k] === lane), id: item.id });
    };
    if (kind === "main") {
      const i = d.main.findIndex((x) => x.id === id);
      const inner = seq.main.map(fresh);
      if (inner.length) inner[inner.length - 1].transition = c.transition || null;
      d.main.splice(i, 1, ...inner);
      inner.forEach((x) => ids.push({ kind: "main", id: x.id }));
      // Keep everything after it in place if the inner main track is shorter than the compound clip.
      const gap = c.dur - inner.reduce((a, x) => a + x.dur, 0);
      if (gap > 0.01) for (const lane of Object.values(LANE_OF)) for (const x of d[lane] || []) if (x.start >= start + c.dur - 1e-3) x.start -= gap;
    } else {
      d.overlays = d.overlays.filter((x) => x.id !== id);
      for (const s of layoutMain({ main: seq.main })) {
        const { start: _s, transition: _t, ...x } = s;
        place("overlays", { ...x, transform: x.transform || { x: 0.5, y: 0.5, scale: 1, rotation: 0 } }, start + s.start);
      }
    }
    for (const [lane, list] of Object.entries({ texts: seq.texts, overlays: seq.overlays, audio: seq.audio, effects: seq.effects })) {
      for (const x of list || []) place(lane, x, start + x.start);
    }
  });
  setState({ selection: ids });
  toast("Compound clip broken apart");
}
