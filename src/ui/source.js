// Library preview ("source viewer"): plays an imported file in the viewer before it goes on the timeline.
// Mark In/Out to add only part of it.
import React, { useEffect, useRef, useState } from "react";
import { useStore, getState, setState } from "../store.js";
import { closePreview, addMediaToTimeline, previewRange } from "../actions.js";
import { html, fmt } from "./kit.js";

let el = null; // the <video>/<audio> element of the open preview

export const sourceActive = () => !!getState().preview;

export function toggleSource() {
  if (!el) return;
  if (el.paused) {
    const pv = getState().preview;
    // Playing from the Out mark (or the end) starts again at In.
    const end = pv?.out ?? el.duration;
    if (el.currentTime >= end - 0.05) el.currentTime = pv?.in ?? 0;
    el.play().catch(() => {});
  } else el.pause();
}

export function stepSource(seconds) {
  if (!el) return;
  el.pause();
  el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + seconds));
}

export function markSource(which) {
  const pv = getState().preview;
  if (!pv || !el) return;
  const t = el.currentTime;
  const next = { ...pv, [which]: t };
  // Keep In before Out.
  if (next.in != null && next.out != null && next.out <= next.in) next[which === "in" ? "out" : "in"] = null;
  setState({ preview: next });
}

export function addFromSource(where) {
  const pv = getState().preview;
  const media = pv && getState().project.media[pv.mediaId];
  if (media) addMediaToTimeline(media, where);
}

export function SourceViewer() {
  const pv = useStore((s) => s.preview);
  const media = useStore((s) => (s.preview ? s.project.media[s.preview.mediaId] : null));
  const ref = useRef();
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    el = ref.current;
    if (!el) return;
    const tick = () => {
      setT(el.currentTime);
      // Stop at the Out mark.
      const out = getState().preview?.out;
      if (out != null && !el.paused && el.currentTime >= out) { el.pause(); el.currentTime = out; }
    };
    setBroken(false);
    const onPlay = () => setPlaying(true), onPause = () => setPlaying(false);
    const check = () => { if (el && el.tagName === "VIDEO" && el.readyState >= 1 && !el.videoWidth) setBroken(true); };
    el.addEventListener("error", () => setBroken(true));
    el.addEventListener("loadedmetadata", check);
    el.addEventListener("timeupdate", tick);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    const raf = setInterval(tick, 50);
    el.play().catch(() => {});
    return () => {
      clearInterval(raf);
      el?.removeEventListener("timeupdate", tick);
      el?.removeEventListener("play", onPlay);
      el?.removeEventListener("pause", onPause);
      el?.pause();
      el = null;
    };
  }, [media?.id]);
  if (!media) return null;
  const dur = media.kind === "image" ? 0 : media.duration;
  const range = previewRange(media);
  const pct = (x) => `${(x / Math.max(dur, 1e-6)) * 100}%`;
  const scrub = (e) => {
    if (!el || !dur) return;
    const bar = e.currentTarget.getBoundingClientRect();
    const go = (ev) => { el.currentTime = Math.max(0, Math.min(dur, ((ev.clientX - bar.left) / bar.width) * dur)); setT(el.currentTime); };
    go(e);
    const up = () => { window.removeEventListener("pointermove", go); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", go);
    window.addEventListener("pointerup", up);
  };
  return html`<div class="source">
    <div class="source-head">
      <span class="source-tag">Library preview</span>
      <b class="ell">${media.name}</b>
      <button class="mini" onClick=${closePreview} title="Back to the timeline view (Esc)">✕ Back to timeline</button>
    </div>
    <div class="source-stage">
      ${media.kind === "image" ? html`<img src=${media.url} />`
        : media.kind === "audio" ? html`<div class="source-audio">♪<audio ref=${ref} src=${media.url} /></div>`
        : html`<video ref=${ref} src=${media.url} playsInline onClick=${toggleSource} />`}
      ${(broken || media.noPicture) && html`<div class="stage-hint error">
        <b>Can't show this video</b>
        <span>Its format isn't supported by Cutline's video engine (common with some HEVC/H.265, ProRes or old camera files).
          Convert it to MP4 (H.264), for example with the free HandBrake app, then import it again.</span>
      </div>`}
    </div>
    ${dur > 0 && html`
      <div class="source-bar" onPointerDown=${scrub}>
        ${(pv.in != null || pv.out != null) && html`<div class="source-range" style=${{ left: pct(range.in), width: pct(range.dur) }} />`}
        <div class="source-head-pos" style=${{ left: pct(t) }} />
      </div>
      <div class="transport">
        <button class="play" onClick=${toggleSource} title="Play/pause (Space)">${playing ? "❚❚" : "▶"}</button>
        <span class="tc">${fmt(t)} / ${fmt(dur)}</span>
        <button onClick=${() => markSource("in")} title="Mark In (I)">⟦ In</button>
        <button onClick=${() => markSource("out")} title="Mark Out (O)">Out ⟧</button>
        ${(pv.in != null || pv.out != null) && html`<span class="muted">${fmt(range.dur)} selected</span>
          <button class="mini" onClick=${() => setState({ preview: { ...pv, in: null, out: null } })}>Clear</button>`}
        <span class="spacer"></span>
      </div>`}
    <div class="source-add">
      ${media.kind === "audio"
        ? html`<button class="primary" onClick=${() => addFromSource("audio")}>+ Add to audio track</button>`
        : html`<button class="primary" onClick=${() => addFromSource("main")} title="Add to the end of the main track (Enter)">+ Add to timeline</button>
          <button onClick=${() => addFromSource("overlay")} title="Add as a picture-in-picture layer at the playhead">+ Add as layer</button>`}
      <span class="muted">or drag it from the library onto the timeline</span>
    </div>
  </div>`;
}
