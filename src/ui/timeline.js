// Multi-track timeline: timeline effects, text, picture-in-picture layers, the main video track and audio tracks.
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  useStore, getState, setState, edit, editLive, checkpoint, undo, redo, layoutMain, projectDuration, isSelected, select,
  compactTracks,
} from "../store.js";
import { clipSpeed, TRANSITIONS } from "../engine.js";
import {
  pause, seek, splitAtPlayhead, deleteSelection, rippleDelete, duplicateSelection, addText, freezeFrame, splitItemAt,
} from "../actions.js";
import { keyTimes, shiftKeyframes } from "../keyframes.js";
import { decodeMedia } from "../media-audio.js";
import { html, fmt } from "./kit.js";

const additiveKey = (e) => e.shiftKey || e.ctrlKey || e.metaKey;
const LABEL = 70;
const LANE_H = { effect: 34, text: 52, overlay: 52, main: 72, audio: 48 };
const LANE_KEY = { effect: "effects", overlay: "overlays", audio: "audio" };

/** Pointer drag helper: calls onMove(ev, dx, dy) after a small threshold; one undo step per drag. */
export function dragGesture(e, onMove, { onClick, undoable = true, onEnd } = {}) {
  e.stopPropagation();
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY;
  let started = false;
  const move = (ev) => {
    if (!started && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
    if (!started) { if (undoable) checkpoint(); started = true; }
    onMove(ev, ev.clientX - x0, ev.clientY - y0);
  };
  const up = (ev) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!started) onClick?.(ev);
    else onEnd?.(ev);
    setState({ guides: null, snapAt: null });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
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
    const speed = clipSpeed(item);
    const from = (item.in || 0) * 100, span = item.dur * speed * 100;
    for (let px = 0; px < w; px++) {
      const a = Math.floor(from + (px / w) * span), b = Math.max(a + 1, Math.floor(from + ((px + 1) / w) * span));
      let m = 0;
      for (let i = a; i < b && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
      const bar = Math.max(1, m * h * 0.9);
      x.fillRect(px, (h - bar) / 2, 1, bar);
    }
  }, [peaks, width, height, item.in, item.dur, item.speed]);
  return html`<canvas ref=${ref} class="wave" />`;
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
  const segs = layoutMain(project);
  const total = Math.max(projectDuration(project) + 5, 20);

  const tool = useStore((s) => s.tool);
  const anchor = useRef(null);

  const timeAt = (clientX) => {
    const r = scroller.current.getBoundingClientRect();
    return (clientX - r.left + scroller.current.scrollLeft - LABEL) / zoom;
  };

  // Ctrl/⌘ + mouse wheel (or a trackpad pinch) zooms around the pointer; Shift + wheel scrolls sideways.
  useEffect(() => {
    const el = scroller.current;
    const onWheel = (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const z0 = getState().zoom;
        const z = Math.max(10, Math.min(300, z0 * Math.exp(-e.deltaY * 0.0025)));
        if (z === z0) return;
        const x = e.clientX - el.getBoundingClientRect().left;
        anchor.current = { t: (x + el.scrollLeft - LABEL) / z0, x };
        setState({ zoom: z });
      } else if (e.shiftKey && !e.deltaX) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  // Keep the moment under the pointer in place after a wheel zoom.
  useLayoutEffect(() => {
    const a = anchor.current;
    if (!a) return;
    anchor.current = null;
    scroller.current.scrollLeft = Math.max(0, LABEL + a.t * zoom - a.x);
  }, [zoom]);

  /** Hand tool (H) or middle mouse button: drag to pan. Razor tool (B): click a clip to cut it there. */
  const onToolPointerDown = (e) => {
    if (e.target.closest(".ruler")) return;
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
      const hits = [...inner.current.querySelectorAll("[data-kind]")].filter((el) => {
        const b = el.getBoundingClientRect();
        const bl = b.left - r.left, bt = b.top - r.top;
        return bl < box.left + box.width && bl + b.width > box.left && bt < box.top + box.height && bt + b.height > box.top;
      }).map((el) => ({ kind: el.dataset.kind, id: el.dataset.id }));
      const merged = [...base];
      for (const h of hits) if (!merged.some((m) => m.kind === h.kind && m.id === h.id)) merged.push(h);
      setState({ selection: merged });
    }, {
      undoable: false,
      onClick: (ev) => { if (!additive) select([]); if (getState().playing) pause(); seek(timeAt(ev.clientX)); },
    });
    const clear = () => { setMarquee(null); window.removeEventListener("pointerup", clear); };
    window.addEventListener("pointerup", clear);
  };

  const pick = (e, kind, id) => {
    if (additiveKey(e)) select([{ kind, id }], true);
    else if (!isSelected(kind, id)) select([{ kind, id }]);
  };

  const ticks = [];
  const step = zoom > 60 ? 1 : zoom > 20 ? 5 : 10;
  for (let s = 0; s <= total; s += step) ticks.push(s);

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
      const laneH = LANE_H[kind];
      dragGesture(e, (ev, dx, dy) => {
        let dt = Math.max(-Math.min(...movers.map((m) => m.start)), dx / zoom);
        const s = snapMove(lead.start + dt, lead.dur, pts, zoom);
        if (s.at != null) dt = Math.max(-Math.min(...movers.map((m) => m.start)), s.t - lead.start);
        setState({ snapAt: s.at });
        const dTrack = kind === "text" ? 0 : Math.round((kind === "overlay" ? -dy : dy) / laneH);
        editLive((p) => {
          for (const m of movers) {
            const x = p[lane].find((y) => y.id === m.id);
            x.start = m.start + dt;
            if (m.words) x.words = m.words.map((w) => ({ ...w, t0: w.t0 + dt, t1: w.t1 + dt }));
            if (kind !== "text") x.track = freeTrackFrom(p[lane].filter((y) => !skip.has(y.id) || y.id === x.id), (m.track ?? 0) + dTrack, x.start, x.dur, x.id);
          }
        });
      }, { onEnd: () => kind !== "text" && editLive(compactTracks) });
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
      }));
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
      }));
    };
    return html`<div key=${item.id} data-kind=${kind} data-id=${item.id}
        class=${`seg ${cls}` + (isSelected(kind, item.id) ? " selected" : "") + (item.mute ? " muted" : "")}
        style=${{ left: LABEL + item.start * zoom, width: Math.max(4, item.dur * zoom) }}
        onPointerDown=${onBody}>
      ${extra}
      <div class="handle l" onPointerDown=${trimLeft} />
      <span>${label}</span>
      ${sp !== 1 && html`<b class="speed-badge">${+sp.toFixed(2)}×</b>`}
      ${keyMarks(item)}
      <div class="handle r" onPointerDown=${trimRight} />
    </div>`;
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
      <button onClick=${undo} disabled=${!canUndo} title="Undo (Ctrl+Z)">↶</button>
      <button onClick=${redo} disabled=${!canRedo} title="Redo (Ctrl+Y)">↷</button>
      <span class="sep"></span>
      <button onClick=${splitAtPlayhead} title="Split (S or Ctrl+B)">✂ Split</button>
      <button onClick=${deleteSelection} title="Delete (Del)">🗑 Delete</button>
      <button onClick=${rippleDelete} title="Delete and close the gap (Shift+Del)">⇤ Ripple</button>
      <button onClick=${duplicateSelection} title="Duplicate (Ctrl+D)">⧉ Duplicate</button>
      <button onClick=${() => freezeFrame()} title="Freeze the frame under the playhead (F)">❄ Freeze</button>
      <button onClick=${() => addText()}>T Add text</button>
      <span class="spacer"></span>
      <button class=${tool === "razor" ? "chip on" : "chip"} onClick=${() => setState({ tool: tool === "razor" ? null : "razor" })} title="Razor: click a clip to cut it (B)">🔪 Razor</button>
      <button class=${tool === "hand" ? "chip on" : "chip"} onClick=${() => setState({ tool: tool === "hand" ? null : "hand" })} title="Hand: drag to pan the timeline (H, or middle mouse button)">✋ Pan</button>
      <button class=${snap ? "chip on" : "chip"} onClick=${() => setState({ snap: !snap })} title="Magnetic snapping (N)">🧲 Snap</button>
      <span class="muted" title="Ctrl + mouse wheel also zooms">Zoom</span>
      <input type="range" min="10" max="300" value=${zoom} onChange=${(e) => setState({ zoom: +e.target.value })} />
    </div>
    <div class=${"tl-scroll" + (tool ? " tool-" + tool : "")} ref=${scroller}>
      <div class="tl-inner" ref=${inner} style=${{ width: LABEL + total * zoom }} onPointerDownCapture=${onToolPointerDown} onPointerDown=${onTracksPointerDown}
        onAuxClick=${(e) => e.button === 1 && e.preventDefault()}>
        <div class="ruler" onPointerDown=${(e) => { e.stopPropagation(); scrub(e); }}>
          ${ticks.map((s) => html`<div class="tick" key=${s} style=${{ left: LABEL + s * zoom }}>${fmt(s).slice(0, 5)}</div>`)}
        </div>

        ${effectTracks.map((tr) => html`<div class="track lane-effect" key=${"e" + tr}>
          <div class="track-label">Effect ${effectTracks.length > 1 ? tr + 1 : ""}</div>
          ${project.effects.filter((x) => (x.track ?? 0) === tr).map((x) => laneItem("effect", x, "effect", x.name || "Effect"))}
        </div>`)}

        <div class="track text-track">
          <div class="track-label">Text</div>
          ${project.texts.map((t) => laneItem("text", t, "text" + (t.caption ? " caption" : ""), t.text))}
        </div>

        ${overlayTracks.map((tr) => html`<div class="track lane-overlay" key=${"o" + tr}>
          <div class="track-label">Layer ${tr + 1}</div>
          ${project.overlays.filter((x) => (x.track ?? 0) === tr).map((x) => laneItem("overlay", x, "overlay", project.media[x.mediaId]?.name, fxBadges(x)))}
        </div>`)}

        <div class="track main-track">
          <div class="track-label">Video</div>
          ${segs.map((s, i) => {
            const media = project.media[s.mediaId];
            const maxSrc = media?.kind === "image" ? 1e9 : (media?.duration ?? s.dur);
            const sp = clipSpeed(s);
            return html`<${React.Fragment} key=${s.id}>
              <div data-kind="main" data-id=${s.id}
                  class=${"seg clip" + (isSelected("main", s.id) ? " selected" : "") + (s.mute ? " muted" : "")}
                  style=${{ left: LABEL + s.start * zoom, width: Math.max(4, s.dur * zoom) }}
                  onPointerDown=${(e) => { e.stopPropagation(); pick(e, "main", s.id); }}>
                <div class="handle l" onPointerDown=${(e) => {
                  const orig = structuredClone(s);
                  dragGesture(e, (ev, dx) => editLive((p) => {
                    // Timeline seconds trimmed × speed = source seconds trimmed.
                    const x = p.main.find((y) => y.id === s.id);
                    const cut = Math.max(-s.in / sp, Math.min(s.dur - 0.2, dx / zoom));
                    x.in = s.in + cut * sp; x.dur = s.dur - cut;
                    x.keyframes = orig.keyframes && structuredClone(orig.keyframes);
                    if (x.keyframes) shiftKeyframes(x, -cut, x.dur);
                  }));
                }} />
                <span>${media?.name}</span>
                ${sp !== 1 && html`<b class="speed-badge">${+sp.toFixed(2)}×</b>`}
                ${fxBadges(s)}
                ${keyMarks(s)}
                <div class="handle r" onPointerDown=${(e) => dragGesture(e, (ev, dx) => editLive((p) => {
                  p.main.find((y) => y.id === s.id).dur = Math.max(0.2, Math.min((maxSrc - s.in) / sp, s.dur + dx / zoom)); }))} />
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
          ${segs.length === 0 && html`<div class="empty">Import media and click it to add clips here</div>`}
        </div>

        ${audioTracks.map((tr) => html`<div class="track lane-audio" key=${"a" + tr}>
          <div class="track-label">Audio ${tr + 1}</div>
          ${project.audio.filter((x) => (x.track ?? 0) === tr).map((x) => {
            const media = project.media[x.mediaId];
            return laneItem("audio", x, "audio", media?.name, [html`<${Wave} key="w" media=${media} item=${x} width=${x.dur * zoom} height=${LANE_H.audio - 16} />`, ...fxBadges(x)]);
          })}
        </div>`)}

        ${marquee && html`<div class="marquee" style=${marquee} />`}
        ${snapAt != null && html`<div class="snapline" style=${{ left: LABEL + snapAt * zoom }} />`}
        <div class="playhead" style=${{ left: LABEL + time * zoom }} />
      </div>
    </div>
  </section>`;
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
