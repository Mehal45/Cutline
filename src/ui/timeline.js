// Multi-track timeline: timeline effects, text, picture-in-picture layers, the main video track and audio tracks.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  useStore, getState, setState, edit, editLive, checkpoint, undo, redo, layoutMain, projectDuration, isSelected, select, findItem,
  compactTracks, trackFlags, toggleTrackFlag,
} from "../store.js";
import { clipSpeed, TRANSITIONS } from "../engine.js";
import { hasCurve, sourceAt } from "../speed.js";
import {
  pause, seek, splitAtPlayhead, deleteSelection, rippleDelete, duplicateSelection, addText, freezeFrame, splitItemAt,
  addMediaToTimeline, importFiles, clampZoom, zoomToFit, ZOOM_MIN, ZOOM_MAX, toast, trimToPlayhead, mirrorSelection,
  detachAudio, zoomTimeline,
} from "../actions.js";
import { keyTimes, shiftKeyframes } from "../keyframes.js";
import { decodeMedia } from "../media-audio.js";
import { html, fmt, Icon } from "./kit.js";

const additiveKey = (e) => e.shiftKey || e.ctrlKey || e.metaKey;
const LABEL = 150;
const LANE_H = { effect: 34, text: 52, overlay: 52, main: 72, audio: 48 };
const LANE_KEY = { effect: "effects", overlay: "overlays", audio: "audio" };

/**
 * Pointer drag helper: calls onMove(ev, dx, dy) after a small threshold; one undo step per drag.
 * With `scroll` (the timeline's scroll box), holding the pointer near or past an edge keeps scrolling that
 * way, and dx/dy include the distance scrolled, so whatever is being dragged stays under the pointer.
 */
export function dragGesture(e, onMove, { onClick, undoable = true, onEnd, scroll, tip } = {}) {
  e.stopPropagation();
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY;
  const sl0 = scroll?.scrollLeft ?? 0, st0 = scroll?.scrollTop ?? 0;
  let started = false, last = null, timer = null;
  const fire = () => {
    onMove(last, last.clientX - x0 + ((scroll?.scrollLeft ?? 0) - sl0), last.clientY - y0 + ((scroll?.scrollTop ?? 0) - st0));
    if (tip) setState({ trimTip: { x: last.clientX, y: last.clientY, text: tip() } });
  };
  const autoScroll = () => {
    if (!last) return;
    const r = scroll.getBoundingClientRect();
    const edge = 56;
    const speed = (d) => Math.min(48, 4 + d / 2); // faster the further past the edge
    let vx = 0, vy = 0;
    if (last.clientX < r.left + LABEL + edge) vx = -speed(r.left + LABEL + edge - last.clientX);
    else if (last.clientX > r.right - edge) vx = speed(last.clientX - (r.right - edge));
    if (last.clientY < r.top + 30) vy = -speed((r.top + 30 - last.clientY) * 1.5);
    else if (last.clientY > r.bottom - 24) vy = speed((last.clientY - (r.bottom - 24)) * 1.5);
    if (!vx && !vy) return;
    const bl = scroll.scrollLeft, bt = scroll.scrollTop;
    scroll.scrollLeft += vx;
    scroll.scrollTop += vy;
    if (scroll.scrollLeft !== bl || scroll.scrollTop !== bt) fire();
  };
  const move = (ev) => {
    if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
    if (!started) {
      if (undoable) checkpoint();
      started = true;
      if (scroll) timer = setInterval(autoScroll, 16);
    }
    last = ev;
    fire();
  };
  const up = (ev) => {
    clearInterval(timer);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!started) onClick?.(ev);
    else onEnd?.(ev);
    setState({ guides: null, snapAt: null, trimTip: null });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

/** The timeline row under a screen point: { type: "main"|"overlay"|"audio"|"effect"|"text"|"above"|"below", track }. */
function rowAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return { type: "below" };
  if (el.closest(".ruler")) return { type: "above" };
  const row = el.closest(".track");
  if (!row) {
    const inner = el.closest(".tl-inner");
    const main = inner?.querySelector(".main-track")?.getBoundingClientRect();
    return { type: main && y < main.top ? "above" : "below" };
  }
  return { type: row.dataset.lane, track: row.dataset.track != null ? +row.dataset.track : undefined };
}

/** Visual-clip properties that carry over when a clip moves between the main track and a layer. */
const LOOK_KEYS = ["mediaId", "in", "dur", "speed", "anim", "transform", "opacity", "blend", "crop", "flipH", "flipV",
  "adjust", "filter", "fx", "chroma", "cutout", "keyframes", "audio", "mute"];
const pickLook = (x) => Object.fromEntries(LOOK_KEYS.filter((k) => x[k] !== undefined).map((k) => [k, structuredClone(x[k])]));

/** Where a clip dropped on the main track at time t would go: index among the other clips. */
function mainIndexAt(project, t, skipId) {
  let start = 0, index = 0;
  for (const s of project.main) {
    if (s.id === skipId) continue;
    if (start + s.dur / 2 < t) index++;
    start += s.dur;
  }
  return index;
}

/** Timeline x (seconds) of the boundary before main-track index `index`, ignoring one clip. */
function mainBoundary(project, index, skipId) {
  let t = 0, i = 0;
  for (const s of project.main) {
    if (s.id === skipId) continue;
    if (i++ === index) break;
    t += s.dur;
  }
  return t;
}

// ---------------- snapping ----------------

/** Edges an item can snap to: playhead, cuts on the main track and the edges of every other item. */
function snapPoints(project, skipIds) {
  const pts = [getState().time, 0];
  for (const s of layoutMain(project)) pts.push(s.start, s.start + s.dur);
  for (const lane of ["texts", "overlays", "audio", "effects"]) {
    for (const x of project[lane] || []) if (!skipIds.has(x.id)) pts.push(x.start, x.start + x.dur);
  }
  return pts;
}

/** Snaps a start time so that either the start or the end lands on a snap point (within 8 px). */
function snapMove(start, dur, pts, zoom) {
  if (!getState().snap) return { t: start, at: null };
  const tol = 8 / zoom;
  let best = null;
  for (const p of pts) {
    for (const [edge, off] of [[start, 0], [start + dur, dur]]) {
      const d = Math.abs(edge - p);
      if (d < tol && (!best || d < best.d)) best = { d, t: p - off, at: p };
    }
  }
  return best ? { t: best.t, at: best.at } : { t: start, at: null };
}

function snapEdge(t, pts, zoom) {
  if (!getState().snap) return { t, at: null };
  const tol = 8 / zoom;
  let best = null;
  for (const p of pts) { const d = Math.abs(t - p); if (d < tol && (!best || d < best.d)) best = { d, p }; }
  return best ? { t: best.p, at: best.p } : { t, at: null };
}

/** Nearest free track at or above `want` for [start, start+dur). */
function freeTrackFrom(list, want, start, dur, skipId) {
  for (let track = Math.max(0, want); ; track++) {
    const busy = list.some((x) => x.id !== skipId && (x.track ?? 0) === track && x.start < start + dur - 1e-3 && x.start + x.dur > start + 1e-3);
    if (!busy) return track;
  }
}

// ---------------- waveform ----------------

const peaksCache = new Map(); // mediaId -> Float32Array (max abs per 10 ms)

function usePeaks(media) {
  const [peaks, setPeaks] = useState(() => peaksCache.get(media?.id) || null);
  useEffect(() => {
    if (!media || peaks) return;
    let alive = true;
    decodeMedia(media).then((buf) => {
      if (!buf || !alive) return;
      const step = Math.round(buf.sampleRate / 100);
      const n = Math.ceil(buf.length / step);
      const out = new Float32Array(n);
      const chans = [...Array(buf.numberOfChannels)].map((_, i) => buf.getChannelData(i));
      for (let i = 0; i < n; i++) {
        let m = 0;
        for (const d of chans) for (let j = i * step, e = Math.min(d.length, j + step); j < e; j += 4) { const v = Math.abs(d[j]); if (v > m) m = v; }
        out[i] = m;
      }
      // Scale to the file's loudest moment so quiet recordings are still readable.
      let max = 0;
      for (const v of out) if (v > max) max = v;
      if (max > 0) for (let i = 0; i < n; i++) out[i] /= max;
      peaksCache.set(media.id, out);
      setPeaks(out);
    });
    return () => { alive = false; };
  }, [media?.id]);
  return peaks;
}

function Wave({ media, item, width, height }) {
  const peaks = usePeaks(media);
  const ref = useRef();
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks) return;
    const w = Math.max(1, Math.min(4000, Math.round(width))), h = height;
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    x.clearRect(0, 0, w, h);
    x.fillStyle = "rgba(255,255,255,.55)";
    for (let px = 0; px < w; px++) {
      // Follows the clip's speed (and speed curve) so the waveform lines up with what plays.
      const a = Math.floor(sourceAt(item, (px / w) * item.dur) * 100), b = Math.max(a + 1, Math.floor(sourceAt(item, ((px + 1) / w) * item.dur) * 100));
      let m = 0;
      for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
      const bar = Math.max(1, m * h * 0.9);
      x.fillRect(px, (h - bar) / 2, 1, bar);
    }
  }, [peaks, width, height, item.in, item.dur, item.speed, item.speedCurve]);
  return html`<canvas ref=${ref} class="wave" />`;
}

/** "Length 00:02.40 · from 00:01.10" for the trim tooltip. */
function trimText(kind, id) {
  const it = findItem(getState().project, kind, id);
  return it ? `Length ${fmt(it.dur)}${"in" in it || kind === "main" ? ` · from ${fmt(it.in || 0)}` : ""}` : "";
}

// ---------------- track headers ----------------

/** Track key of a timeline row element ("main", "text", "overlay:1" …). */
const rowKey = (row) => (!row ? null : row.dataset.lane === "main" || row.dataset.lane === "text" ? row.dataset.lane : `${row.dataset.lane}:${row.dataset.track}`);

/** Name, icon and lock / hide / mute buttons on the left of a track. */
function TrackHead({ k, label, icon, project, hide = true, mute = true }) {
  const f = trackFlags(project, k);
  const b = (flag, on, off, title) => html`<button class=${f[flag] ? "on" : ""} title=${title}
    onClick=${(e) => { e.stopPropagation(); toggleTrackFlag(k, flag); }}><${Icon} n=${f[flag] ? on : off} /></button>`;
  return html`<div class="track-label" onPointerDown=${(e) => e.stopPropagation()}>
    <span class="th-name"><${Icon} n=${icon} /> ${label}</span>
    <span class="th-btns">
      ${b("locked", "lock", "lock-open", f.locked ? "Unlock track" : "Lock track (no editing)")}
      ${hide && b("hidden", "eye-off", "eye", f.hidden ? "Show track" : "Hide track")}
      ${mute && b("muted", "volume-x", "volume-2", f.muted ? "Unmute track" : "Mute track")}
    </span>
  </div>`;
}

// ---------------- the timeline ----------------

export function Timeline() {
  const project = useStore((s) => s.project);
  const time = useStore((s) => s.time);
  const zoom = useStore((s) => s.zoom);
  const canUndo = useStore((s) => s.canUndo);
  const canRedo = useStore((s) => s.canRedo);
  const snap = useStore((s) => s.snap);
  const snapAt = useStore((s) => s.snapAt);
  useStore((s) => s.selection); // re-render on selection change
  const scroller = useRef();
  const inner = useRef();
  const [marquee, setMarquee] = useState(null);
  const [ghost, setGhost] = useState(null); // floating clip while dragging between tracks
  const [viewW, setViewW] = useState(1200);

  useEffect(() => {
    const ro = new ResizeObserver(() => setViewW(scroller.current?.clientWidth || 1200));
    ro.observe(scroller.current);
    return () => ro.disconnect();
  }, []);
  const segs = layoutMain(project);
  const dur = projectDuration(project);
  // Always room to drag past the end, and never narrower than the visible area at any zoom.
  const total = Math.max(dur + Math.max(10, dur * 0.25), (viewW - LABEL) / zoom, 20);

  const tool = useStore((s) => s.tool);
  const prevZoom = useRef(zoom);
  // Track names stay pinned to the left edge while scrolling sideways (no re-render needed).
  const pinLabels = () => inner.current?.style.setProperty("--sx", (scroller.current?.scrollLeft || 0) + "px");
  useLayoutEffect(pinLabels);

  const timeAt = (clientX) => {
    const r = scroller.current.getBoundingClientRect();
    return (clientX - r.left + scroller.current.scrollLeft - LABEL) / zoom;
  };

  // Ctrl/⌘ + mouse wheel (or a trackpad pinch) zooms; Shift + wheel scrolls sideways.
  useEffect(() => {
    const el = scroller.current;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const z0 = getState().zoom;
        const z = clampZoom(z0 * Math.exp(-e.deltaY * 0.0025));
        if (z === z0) return;
        setState({ zoom: z });
      } else if (e.shiftKey && !e.deltaX) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  // Every zoom (wheel, slider, keys) keeps the playhead where it is on screen; if the playhead was out of
  // view, it is brought to the middle.
  useLayoutEffect(() => {
    const z0 = prevZoom.current;
    prevZoom.current = zoom;
    if (z0 === zoom || getState().zoomFit) { setState({ zoomFit: false }); return; }
    const el = scroller.current;
    const t = getState().time;
    const x = LABEL + t * z0 - el.scrollLeft; // playhead position on screen before the zoom
    const visible = x >= LABEL && x <= el.clientWidth;
    el.scrollLeft = Math.max(0, LABEL + t * zoom - (visible ? x : (el.clientWidth + LABEL) / 2));
  }, [zoom]);

  /** Hand tool (H) or middle mouse button: drag to pan. Razor tool (B): click a clip to cut it there. */
  const onToolPointerDown = (e) => {
    if (e.target.closest(".ruler")) return;
    // Locked tracks: nothing on them can be selected, moved, trimmed or cut.
    const row = e.target.closest(".track");
    if (row?.classList.contains("locked") && e.button === 0 && e.target.closest("[data-kind], .handle")) {
      e.preventDefault();
      e.stopPropagation();
      toast("This track is locked — click the 🔒 on the left to unlock it");
      return;
    }
    if (e.button === 1 || (tool === "hand" && e.button === 0)) {
      e.preventDefault();
      e.stopPropagation();
      const el = scroller.current;
      const x0 = e.clientX, y0 = e.clientY, sl = el.scrollLeft, st = el.scrollTop;
      el.classList.add("panning");
      const move = (ev) => { el.scrollLeft = sl - (ev.clientX - x0); el.scrollTop = st - (ev.clientY - y0); };
      const up = () => { el.classList.remove("panning"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    if (tool === "razor" && e.button === 0) {
      const seg = e.target.closest("[data-kind]");
      if (!seg || seg.dataset.kind === "transition") return;
      e.preventDefault();
      e.stopPropagation();
      if (getState().playing) pause();
      splitItemAt(seg.dataset.kind, seg.dataset.id, timeAt(e.clientX));
    }
  };

  const scrub = (e) => {
    if (getState().playing) pause();
    seek(timeAt(e.clientX));
    const move = (ev) => seek(timeAt(ev.clientX));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Rubber-band selection on empty track space; a plain click seeks instead.
  const onTracksPointerDown = (e) => {
    if (e.button !== 0 || e.target.closest(".seg, .diamond")) return;
    const additive = additiveKey(e);
    const base = additive ? getState().selection : [];
    const ir = inner.current.getBoundingClientRect();
    const x0 = e.clientX - ir.left, y0 = e.clientY - ir.top;
    dragGesture(e, (ev) => {
      const r = inner.current.getBoundingClientRect();
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
      const box = { left: Math.min(x0, x1), top: Math.min(y0, y1), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
      setMarquee(box);
      const hits = [...inner.current.querySelectorAll("[data-kind]")].filter((el) => !el.closest(".track.locked")).filter((el) => {
        const b = el.getBoundingClientRect();
        const bl = b.left - r.left, bt = b.top - r.top;
        return bl < box.left + box.width && bl + b.width > box.left && bt < box.top + box.height && bt + b.height > box.top;
      }).map((el) => ({ kind: el.dataset.kind, id: el.dataset.id }));
      const merged = [...base];
      for (const h of hits) if (!merged.some((m) => m.kind === h.kind && m.id === h.id)) merged.push(h);
      setState({ selection: merged });
    }, {
      undoable: false,
      scroll: scroller.current,
      onClick: (ev) => { if (!additive) select([]); if (getState().playing) pause(); seek(timeAt(ev.clientX)); },
    });
    const clear = () => { setMarquee(null); window.removeEventListener("pointerup", clear); };
    window.addEventListener("pointerup", clear);
  };

  const pick = (e, kind, id) => {
    if (additiveKey(e)) select([{ kind, id }], true);
    else if (!isSelected(kind, id)) select([{ kind, id }]);
  };

  // Ruler ticks: the smallest round step that leaves ~70 px between labels.
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((x) => x * zoom >= 70) || 3600;
  const ticks = [];
  for (let s = 0; s <= total; s += step) ticks.push(s);
  const tickLabel = (s) => (s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`
    : fmt(s).slice(0, 5));

  /** Keyframe markers along a segment. */
  const keyMarks = (item) => keyTimes(item).map((t) => html`<i key=${t} class="kmark" style=${{ left: t * zoom - 4 }} />`);

  // ----- generic lane item (text / overlay / audio / effect) -----
  const laneItem = (kind, item, cls, label, extra) => {
    const lane = kind === "text" ? "texts" : LANE_KEY[kind];
    const media = item.mediaId ? project.media[item.mediaId] : null;
    const maxSrc = !media || media.kind === "image" ? 1e9 : media.duration;
    const sp = clipSpeed(item);
    const onBody = (e) => {
      pick(e, kind, item.id);
      // Drag moves every selected item of this lane together; layers/audio/effects can also change track.
      const movers = getState().project[lane].filter((x) => isSelected(kind, x.id)).map((x) => structuredClone(x));
      const skip = new Set(movers.map((m) => m.id));
      const pts = snapPoints(getState().project, skip);
      const lead = movers.find((m) => m.id === item.id) || movers[0];
      const maxT = Math.max(-1, ...getState().project[lane].map((x) => x.track ?? 0));
      let toMain = null; // a single layer dropped on the main track becomes a main clip
      dragGesture(e, (ev, dx) => {
        let dt = Math.max(-Math.min(...movers.map((m) => m.start)), dx / zoom);
        const s = snapMove(lead.start + dt, lead.dur, pts, zoom);
        if (s.at != null) dt = Math.max(-Math.min(...movers.map((m) => m.start)), s.t - lead.start);
        setState({ snapAt: s.at });
        // The track follows the row under the pointer; past the top/bottom lane a new track is made.
        const row = rowAt(ev.clientX, ev.clientY);
        toMain = null;
        if (kind === "overlay" && movers.length === 1 && row.type === "main") {
          const t = lead.start + dt;
          const index = mainIndexAt(getState().project, t, null);
          toMain = index;
          setGhost({ line: LABEL + mainBoundary(getState().project, index, null) * zoom, lane: "main" });
          return;
        }
        setGhost(null);
        let want = null;
        if (kind === "overlay") want = row.type === "overlay" ? row.track : ["above", "text", "effect"].includes(row.type) ? maxT + 1 : null;
        if (kind === "audio") want = row.type === "audio" ? row.track : row.type === "below" ? maxT + 1 : null;
        if (kind === "effect") want = row.type === "effect" ? row.track : row.type === "above" ? 0 : null;
        editLive((p) => {
          for (const m of movers) {
            const x = p[lane].find((y) => y.id === m.id);
            x.start = m.start + dt;
            if (m.words) x.words = m.words.map((w) => ({ ...w, t0: w.t0 + dt, t1: w.t1 + dt }));
            if (kind !== "text") {
              const target = want == null ? (x.track ?? 0) : want + ((m.track ?? 0) - (lead.track ?? 0));
              x.track = freeTrackFrom(p[lane].filter((y) => !skip.has(y.id) || y.id === x.id), target, x.start, x.dur, x.id);
            }
          }
        });
      }, {
        scroll: scroller.current,
        onEnd: () => {
          setGhost(null);
          if (toMain != null) {
            const index = toMain;
            editLive((p) => {
              const x = p.overlays.find((y) => y.id === item.id);
              p.overlays = p.overlays.filter((y) => y.id !== item.id);
              p.main.splice(index, 0, { id: x.id, transition: null, ...pickLook(x), anim: x.anim || { in: { type: "none", dur: 0.4 }, out: { type: "none", dur: 0.4 } } });
              compactTracks(p);
            });
            setState({ selection: [{ kind: "main", id: item.id }] });
            toast("Moved onto the main track");
            return;
          }
          if (kind !== "text") editLive(compactTracks);
        },
      });
    };
    const trimLeft = (e) => {
      const orig = structuredClone(item);
      const pts = snapPoints(getState().project, new Set([item.id]));
      dragGesture(e, (ev, dx) => editLive((p) => {
        const x = p[lane].find((y) => y.id === item.id);
        let ns = Math.max(0, Math.min(orig.start + orig.dur - 0.2, orig.start + dx / zoom));
        const s = snapEdge(ns, pts, zoom);
        if (s.at != null && s.t < orig.start + orig.dur - 0.2) ns = s.t;
        setState({ snapAt: s.at });
        let cut = ns - orig.start;
        if ("in" in orig) cut = Math.max(-(orig.in || 0) / sp, cut); // can't reveal footage before the source start
        x.start = orig.start + cut;
        x.dur = orig.dur - cut;
        if ("in" in orig) x.in = (orig.in || 0) + cut * sp;
        x.keyframes = orig.keyframes && structuredClone(orig.keyframes);
        if (x.keyframes) shiftKeyframes(x, -cut, x.dur);
      }), { scroll: scroller.current, tip: () => trimText(kind, item.id) });
    };
    const trimRight = (e) => {
      const orig = structuredClone(item);
      const pts = snapPoints(getState().project, new Set([item.id]));
      dragGesture(e, (ev, dx) => editLive((p) => {
        const x = p[lane].find((y) => y.id === item.id);
        let end = orig.start + Math.max(0.2, orig.dur + dx / zoom);
        const s = snapEdge(end, pts, zoom);
        if (s.at != null && s.t > orig.start + 0.2) end = s.t;
        setState({ snapAt: s.at });
        x.dur = Math.min((maxSrc - (orig.in || 0)) / sp, end - orig.start);
      }), { scroll: scroller.current, tip: () => trimText(kind, item.id) });
    };
    return html`<div key=${item.id} data-kind=${kind} data-id=${item.id}
        class=${`seg ${cls}` + (isSelected(kind, item.id) ? " selected" : "") + (item.mute ? " muted" : "")}
        style=${{ left: LABEL + item.start * zoom, width: Math.max(4, item.dur * zoom) }}
        onPointerDown=${onBody}>
      ${extra}
      <div class="handle l" title="Drag to trim or extend the start" onPointerDown=${trimLeft} />
      <span class=${kind === "overlay" ? "label" : ""}>${label}</span>
      ${hasCurve(item) ? html`<b class="speed-badge" title="Speed curve">〰 curve</b>` : sp !== 1 && html`<b class="speed-badge">${+sp.toFixed(2)}×</b>`}
      ${keyMarks(item)}
      <div class="handle r" title="Drag to trim or extend the end" onPointerDown=${trimRight} />
    </div>`;
  };

  /**
   * Dragging a main-track clip: a copy follows the pointer. Drop it between other main clips to reorder,
   * or on a layer row (or above) to turn it into a picture-in-picture layer at that time.
   */
  const mainDrag = (e, s, media) => {
    if (e.button !== 0) return;
    pick(e, "main", s.id);
    const grab = timeAt(e.clientX) - s.start; // where in the clip it was grabbed
    let drop = null;
    dragGesture(e, (ev) => {
      const t = Math.max(0, timeAt(ev.clientX) - grab);
      const row = rowAt(ev.clientX, ev.clientY);
      const p = getState().project;
      const box = (rowType) => {
        const el = inner.current.querySelector(rowType === "main" ? ".main-track" : `.lane-overlay[data-track="${row.track}"]`);
        const ir = inner.current.getBoundingClientRect();
        const r = el ? el.getBoundingClientRect() : null;
        return r ? { top: r.top - ir.top + 6, height: r.height - 12 } : { top: ev.clientY - ir.top - 20, height: 40 };
      };
      if (row.type === "main" || row.type === "below" || row.type === "audio") {
        const index = mainIndexAt(p, timeAt(ev.clientX), s.id);
        drop = { to: "main", index };
        setGhost({ ...box("main"), left: LABEL + t * zoom, width: Math.max(4, s.dur * zoom), label: media?.name, line: LABEL + mainBoundary(p, index, s.id) * zoom, lane: "main" });
      } else {
        const maxT = Math.max(-1, ...p.overlays.map((x) => x.track ?? 0));
        const track = row.type === "overlay" ? row.track : maxT + 1;
        drop = { to: "overlay", time: t, track };
        setGhost({ ...box(row.type === "overlay" ? "overlay" : "none"), left: LABEL + t * zoom, width: Math.max(4, s.dur * zoom), label: `${media?.name} → layer`, lane: "overlay" });
      }
    }, {
      undoable: false,
      scroll: scroller.current,
      onEnd: () => {
        setGhost(null);
        if (!drop) return;
        const p = getState().project;
        const from = p.main.findIndex((x) => x.id === s.id);
        if (drop.to === "main") {
          if (drop.index === from) return; // dropped where it was
          edit((d) => {
            const [clip] = d.main.splice(d.main.findIndex((x) => x.id === s.id), 1);
            clip.transition = null;
            d.main.splice(drop.index, 0, clip);
          });
        } else {
          edit((d) => {
            const clip = d.main.find((x) => x.id === s.id);
            d.main = d.main.filter((x) => x.id !== s.id);
            const track = d.overlays.some((x) => (x.track ?? 0) === drop.track && x.start < drop.time + clip.dur && x.start + x.dur > drop.time)
              ? freeTrackFrom(d.overlays, drop.track, drop.time, clip.dur) : drop.track;
            d.overlays.push({ id: clip.id, ...pickLook(clip), track, start: drop.time });
            compactTracks(d);
          });
          setState({ selection: [{ kind: "overlay", id: s.id }] });
          toast("Moved to a layer");
        }
      },
    });
  };

  // Dropping from the media library (or files from the computer) onto the timeline.
  const onDragOver = (e) => {
    const types = [...e.dataTransfer.types];
    if (!types.includes("text/x-cutline-media") && !types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const row = rowAt(e.clientX, e.clientY);
    const p = getState().project;
    const ir = inner.current.getBoundingClientRect();
    if (row.type === "main") setGhost({ line: LABEL + mainBoundary(p, mainIndexAt(p, timeAt(e.clientX), null), null) * zoom, lane: "main" });
    else setGhost({ left: LABEL + Math.max(0, timeAt(e.clientX)) * zoom, width: 3, top: 24, height: ir.height - 24, lane: "drop" });
  };
  const onDrop = async (e) => {
    setGhost(null);
    const id = e.dataTransfer.getData("text/x-cutline-media");
    const files = [...(e.dataTransfer.files || [])];
    if (!id && !files.length) return;
    e.preventDefault();
    const t = Math.max(0, timeAt(e.clientX));
    const row = rowAt(e.clientX, e.clientY);
    const ids = id ? [id] : await importFiles(files);
    let offset = 0;
    for (const mid of ids) {
      const m = getState().project.media[mid];
      if (!m) continue;
      const p = getState().project;
      if (m.kind === "audio") addMediaToTimeline(m, "audio", { time: t + offset, track: row.type === "audio" ? row.track : undefined, range: { in: 0, dur: m.duration } });
      else if (row.type === "overlay" || row.type === "above" || row.type === "text" || row.type === "effect") addMediaToTimeline(m, "overlay", { time: t + offset, track: row.type === "overlay" ? row.track : undefined, range: { in: 0, dur: m.duration } });
      else addMediaToTimeline(m, "main", { index: row.type === "main" ? mainIndexAt(p, t + offset, null) : p.main.length, range: { in: 0, dur: m.duration } });
      offset += m.duration;
    }
  };

  const maxTrack = (list) => Math.max(-1, ...(list || []).map((x) => x.track ?? 0));
  const effectTracks = [...Array(maxTrack(project.effects) + 1).keys()];
  const overlayTracks = [...Array(maxTrack(project.overlays) + 1).keys()].reverse();
  const audioTracks = [...Array(maxTrack(project.audio) + 1).keys()];

  const fxBadges = (s) => [
    s.filter?.type && html`<b class="badge" title="Filter">◐</b>`,
    s.fx?.length && html`<b class="badge" title="Effects">✦</b>`,
    (s.cutout?.mode || s.chroma?.on) && html`<b class="badge" title="Background removed">✂</b>`,
    s.mute && html`<b class="badge" title="Muted">🔇</b>`,
  ];

  return html`<section class="timeline">
    <${ResizeBar} />
    <div class="tl-toolbar">
      <span class="tgroup">
        <button class=${"ibtn" + (!tool ? " on" : "")} onClick=${() => setState({ tool: null })} title="Select (V)"><${Icon} n="mouse-pointer-2" /></button>
        <button class=${"ibtn" + (tool === "razor" ? " on" : "")} onClick=${() => setState({ tool: tool === "razor" ? null : "razor" })} title="Razor: click a clip to cut it (B)"><${Icon} n="scissors-line-dashed" /></button>
        <button class=${"ibtn" + (tool === "hand" ? " on" : "")} onClick=${() => setState({ tool: tool === "hand" ? null : "hand" })} title="Hand: drag to pan (H, or middle mouse button)"><${Icon} n="hand" /></button>
      </span>
      <span class="sep"></span>
      <button class="ibtn" onClick=${undo} disabled=${!canUndo} title="Undo (Ctrl+Z)"><${Icon} n="undo-2" /></button>
      <button class="ibtn" onClick=${redo} disabled=${!canRedo} title="Redo (Ctrl+Y)"><${Icon} n="redo-2" /></button>
      <span class="sep"></span>
      <button class="ibtn" onClick=${splitAtPlayhead} title="Split (S · Ctrl+B splits everything)"><${Icon} n="scissors" /></button>
      <button class="ibtn" onClick=${() => trimToPlayhead("left")} title="Delete left of the playhead (Q)"><${Icon} n="arrow-left-to-line" /></button>
      <button class="ibtn" onClick=${() => trimToPlayhead("right")} title="Delete right of the playhead (W)"><${Icon} n="arrow-right-to-line" /></button>
      <button class="ibtn" onClick=${deleteSelection} title="Delete (Del)"><${Icon} n="trash-2" /></button>
      <button class="ibtn" onClick=${rippleDelete} title="Ripple delete: delete and close the gap (Shift+Del)"><${Icon} n="between-horizontal-start" /></button>
      <span class="sep"></span>
      <button class="ibtn" onClick=${() => freezeFrame()} title="Freeze frame (F)"><${Icon} n="snowflake" /></button>
      <button class="ibtn" onClick=${mirrorSelection} title="Mirror"><${Icon} n="flip-horizontal-2" /></button>
      <button class="ibtn" onClick=${duplicateSelection} title="Duplicate (Ctrl+D)"><${Icon} n="copy" /></button>
      <button class="ibtn" onClick=${detachAudio} title="Detach audio to its own track"><${Icon} n="audio-lines" /></button>
      <button class="ibtn" onClick=${() => addText()} title="Add text"><${Icon} n="type" /></button>
      <span class="spacer"></span>
      <button class=${"ibtn" + (snap ? " on" : "")} onClick=${() => setState({ snap: !snap })} title="Magnetic snapping (N)"><${Icon} n="magnet" /></button>
      <span class="sep"></span>
      <button class="ibtn" onClick=${() => zoomTimeline(1 / 1.25)} title="Zoom out (−, Ctrl + wheel)"><${Icon} n="zoom-out" /></button>
      <input class="zoom" type="range" min="0" max="1000" title="Zoom (Ctrl + mouse wheel)"
        value=${Math.round((1000 * Math.log(zoom / ZOOM_MIN)) / Math.log(ZOOM_MAX / ZOOM_MIN))}
        onChange=${(e) => setState({ zoom: clampZoom(ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, +e.target.value / 1000)) })} />
      <button class="ibtn" onClick=${() => zoomTimeline(1.25)} title="Zoom in (+, Ctrl + wheel)"><${Icon} n="zoom-in" /></button>
      <button class="ibtn" onClick=${zoomToFit} title="Fit the whole project (Shift+Z)"><${Icon} n="maximize-2" /></button>
    </div>
    <div class=${"tl-scroll" + (tool ? " tool-" + tool : "")} ref=${scroller} onScroll=${pinLabels}>
      <div class="tl-inner" ref=${inner} style=${{ width: LABEL + total * zoom }} onPointerDownCapture=${onToolPointerDown} onPointerDown=${onTracksPointerDown}
        onDragOver=${onDragOver} onDragLeave=${(e) => { if (!inner.current.contains(e.relatedTarget)) setGhost(null); }} onDrop=${onDrop}
        onAuxClick=${(e) => e.button === 1 && e.preventDefault()}>
        <div class="ruler" onPointerDown=${(e) => { e.stopPropagation(); scrub(e); }}>
          ${ticks.map((s) => html`<div class="tick" key=${s} style=${{ left: LABEL + s * zoom }}>${tickLabel(s)}</div>`)}
        </div>

        ${effectTracks.map((tr) => html`<div class=${"track lane-effect" + (trackFlags(project, `effect:${tr}`).locked ? " locked" : "") + (trackFlags(project, `effect:${tr}`).hidden ? " hidden" : "")} data-lane="effect" data-track=${tr} key=${"e" + tr}>
          <${TrackHead} k=${`effect:${tr}`} label=${`Effect${effectTracks.length > 1 ? " " + (tr + 1) : ""}`} icon="sparkles" project=${project} mute=${false} />
          ${project.effects.filter((x) => (x.track ?? 0) === tr).map((x) => laneItem("effect", x, "effect", x.name || "Effect"))}
        </div>`)}

        <div class=${"track text-track" + (trackFlags(project, "text").locked ? " locked" : "") + (trackFlags(project, "text").hidden ? " hidden" : "")} data-lane="text">
          <${TrackHead} k="text" label="Text" icon="type" project=${project} mute=${false} />
          ${project.texts.map((t) => laneItem("text", t, "text" + (t.caption ? " caption" : ""), t.text))}
        </div>

        ${overlayTracks.map((tr) => html`<div class=${"track lane-overlay" + (trackFlags(project, `overlay:${tr}`).locked ? " locked" : "") + (trackFlags(project, `overlay:${tr}`).hidden ? " hidden" : "")} data-lane="overlay" data-track=${tr} key=${"o" + tr}>
          <${TrackHead} k=${`overlay:${tr}`} label=${`Layer ${tr + 1}`} icon="layers" project=${project} />
          ${project.overlays.filter((x) => (x.track ?? 0) === tr).map((x) => laneItem("overlay", x, "overlay", project.media[x.mediaId]?.name, fxBadges(x)))}
        </div>`)}

        <div class=${"track main-track" + (trackFlags(project, "main").locked ? " locked" : "") + (trackFlags(project, "main").hidden ? " hidden" : "")} data-lane="main">
          <${TrackHead} k="main" label="Main" icon="film" project=${project} />
          ${segs.map((s, i) => {
            const media = project.media[s.mediaId];
            const maxSrc = media?.kind === "image" ? 1e9 : (media?.duration ?? s.dur);
            const sp = clipSpeed(s);
            return html`<${React.Fragment} key=${s.id}>
              <div data-kind="main" data-id=${s.id}
                  class=${"seg clip" + (isSelected("main", s.id) ? " selected" : "") + (s.mute ? " muted" : "")}
                  style=${{ left: LABEL + s.start * zoom, width: Math.max(4, s.dur * zoom) }}
                  onPointerDown=${(e) => mainDrag(e, s, media)}>
                <div class="handle l" onPointerDown=${(e) => {
                  const orig = structuredClone(s);
                  dragGesture(e, (ev, dx) => editLive((p) => {
                    // Timeline seconds trimmed × speed = source seconds trimmed.
                    const x = p.main.find((y) => y.id === s.id);
                    const cut = Math.max(-s.in / sp, Math.min(s.dur - 0.2, dx / zoom));
                    x.in = s.in + cut * sp; x.dur = s.dur - cut;
                    x.keyframes = orig.keyframes && structuredClone(orig.keyframes);
                    if (x.keyframes) shiftKeyframes(x, -cut, x.dur);
                  }), { scroll: scroller.current, tip: () => trimText("main", s.id) });
                }} title="Drag to trim or extend the start" />
                <span class="label">${media?.name}</span>
                ${hasCurve(s) ? html`<b class="speed-badge" title="Speed curve">〰 curve</b>` : sp !== 1 && html`<b class="speed-badge">${+sp.toFixed(2)}×</b>`}
                ${fxBadges(s)}
                ${keyMarks(s)}
                <div class="handle r" onPointerDown=${(e) => dragGesture(e, (ev, dx) => editLive((p) => {
                  p.main.find((y) => y.id === s.id).dur = Math.max(0.2, Math.min((maxSrc - s.in) / sp, s.dur + dx / zoom)); }), { scroll: scroller.current, tip: () => trimText("main", s.id) })}
                  title="Drag to trim or extend the end" />
              </div>
              ${i < segs.length - 1 && html`<div data-kind=${s.transition ? "transition" : undefined} data-id=${s.id}
                  class=${"diamond" + (s.transition ? " has" : "") + (isSelected("transition", s.id) ? " selected" : "")}
                  style=${{ left: LABEL + (s.start + s.dur) * zoom }}
                  title=${s.transition ? TRANSITIONS[s.transition.type] : "Add transition"}
                  onPointerDown=${(e) => {
                    e.stopPropagation();
                    if (!s.transition) edit((p) => (p.main.find((y) => y.id === s.id).transition = { type: "crossfade", dur: 0.6 }));
                    pick(e, "transition", s.id);
                  }}>◆</div>`}
            <//>`;
          })}
          ${segs.length === 0 && html`<div class="empty">Drag clips here from the library, or preview one and press “Add to timeline”</div>`}
        </div>

        ${audioTracks.map((tr) => html`<div class=${"track lane-audio" + (trackFlags(project, `audio:${tr}`).locked ? " locked" : "") + (trackFlags(project, `audio:${tr}`).hidden ? " hidden" : "")} data-lane="audio" data-track=${tr} key=${"a" + tr}>
          <${TrackHead} k=${`audio:${tr}`} label=${`Audio ${tr + 1}`} icon="music" project=${project} hide=${false} />
          ${project.audio.filter((x) => (x.track ?? 0) === tr).map((x) => {
            const media = project.media[x.mediaId];
            return laneItem("audio", x, "audio", media?.name, [html`<${Wave} key="w" media=${media} item=${x} width=${x.dur * zoom} height=${LANE_H.audio - 16} />`, ...fxBadges(x)]);
          })}
        </div>`)}

        ${marquee && html`<div class="marquee" style=${marquee} />`}
        ${ghost?.line != null && html`<div class="insert-line" style=${{ left: ghost.line }} />`}
        ${ghost?.width != null && html`<div class=${"drag-ghost " + ghost.lane} style=${{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height }}>${ghost.label}</div>`}
        ${snapAt != null && html`<div class="snapline" style=${{ left: LABEL + snapAt * zoom }} />`}
        <${TrimTip} />
        <div class="playhead" style=${{ left: LABEL + time * zoom }} />
      </div>
    </div>
  </section>`;
}

/** Floating readout while trimming a clip. */
function TrimTip() {
  const tip = useStore((s) => s.trimTip);
  return tip ? html`<div class="trimtip" style=${{ left: tip.x + 14, top: tip.y - 30 }}>${tip.text}</div>` : null;
}

/** Drag the top edge of the timeline to make it taller or shorter. */
function ResizeBar() {
  return html`<div class="tl-resize" title="Drag to resize the timeline" onPointerDown=${(e) => {
    const h0 = getState().timelineH || 300, y0 = e.clientY;
    dragGesture(e, (ev) => {
      const h = Math.max(160, Math.min(window.innerHeight - 260, h0 - (ev.clientY - y0)));
      setState({ timelineH: h });
    }, { undoable: false });
  }} />`;
}
