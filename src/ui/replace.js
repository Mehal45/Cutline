// Replace clip: drop a video from the library onto a clip and pick which part of it to use. The new footage
// takes the old clip's place and length; its position, effects, filter, animation, keyframes and audio
// settings stay.
import { useEffect, useRef, useState } from "react";
import { useStore, getState, setState, edit, findItem } from "../store.js";
import { sourceAt } from "../speed.js";
import { toast } from "../actions.js";
import { html, fmt, Icon } from "./kit.js";

/** Source seconds a clip uses (its length × speed, or along its speed curve). */
const spanOf = (it) => sourceAt(it, it.dur) - (it.in || 0);

/** Starts replacing a clip: images go straight in, videos open the trim dialog. */
export function startReplace(kind, id, mediaId) {
  const m = getState().project.media[mediaId];
  if (!m) return;
  if (m.kind === "image") return replaceClip(kind, id, mediaId, 0);
  setState({ replacing: { kind, id, mediaId } });
}

export function replaceClip(kind, id, mediaId, inPoint) {
  const m = getState().project.media[mediaId];
  let shorter = false;
  edit((p) => {
    const it = findItem(p, kind, id);
    if (!it) return;
    const need = spanOf(it);
    it.mediaId = mediaId;
    if (m.kind === "image") it.in = 0;
    else if (m.duration + 1e-3 >= need) it.in = Math.max(0, Math.min(m.duration - need, inPoint));
    else {
      // The new video is shorter than the clip: use all of it at the clip's speed.
      shorter = true;
      it.in = 0;
      delete it.speedCurve;
      it.dur = Math.max(0.1, m.duration / (it.speed ?? 1));
    }
  });
  setState({ replacing: null, selection: [{ kind, id }] });
  toast(shorter ? `Replaced — “${m.name}” is shorter, so the clip got shorter` : `Replaced with “${m.name}”`);
}

export function ReplaceDialog() {
  const job = useStore((s) => s.replacing);
  if (!job) return null;
  return html`<${Dialog} key=${job.id + job.mediaId} job=${job} />`;
}

function Dialog({ job }) {
  const project = getState().project;
  const item = findItem(project, job.kind, job.id);
  const m = project.media[job.mediaId];
  const need = item ? spanOf(item) : 0;
  const total = m?.duration || 0;
  const fits = total + 1e-3 >= need;
  const win = fits ? need : total;
  const [inPt, setIn] = useState(0);
  const [playing, setPlaying] = useState(false);
  const video = useRef();
  const strip = useRef();
  const close = () => setState({ replacing: null });

  useEffect(() => { if (video.current && !playing) video.current.currentTime = inPt; }, [inPt]);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const stop = () => { if (v.currentTime >= inPt + win - 0.03) { v.pause(); v.currentTime = inPt; setPlaying(false); } };
    v.addEventListener("timeupdate", stop);
    return () => v.removeEventListener("timeupdate", stop);
  }, [inPt, win]);
  useEffect(() => {
    const key = (e) => { if (e.key === "Escape") close(); if (e.key === "Enter") replaceClip(job.kind, job.id, job.mediaId, inPt); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [inPt]);
  if (!item || !m) return null;

  const play = () => {
    const v = video.current;
    if (playing) { v.pause(); setPlaying(false); return; }
    v.currentTime = inPt; v.play(); setPlaying(true);
  };
  // Drag the highlighted window (or click anywhere on the bar) to choose the part to use.
  const drag = (e) => {
    e.preventDefault();
    const r = strip.current.getBoundingClientRect();
    const winPx = (win / total) * r.width;
    const onWin = e.target.classList.contains("rp-win");
    const grab = onWin ? e.clientX - (r.left + (inPt / total) * r.width) : winPx / 2;
    const move = (ev) => {
      const x = ev.clientX - r.left - grab;
      setIn(Math.max(0, Math.min(total - win, (x / r.width) * total)));
      video.current?.pause(); setPlaying(false);
    };
    move(e);
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const nudge = (d) => setIn((t) => Math.max(0, Math.min(total - win, t + d)));

  return html`<div class="modal-bg" onPointerDown=${close}>
    <div class="modal replace-dlg" onPointerDown=${(e) => e.stopPropagation()}>
      <div class="row between"><h3><${Icon} n="replace" /> Replace clip</h3><button onClick=${close}>✕</button></div>
      <p class="muted">Choose the part of <b>${m.name}</b> to use. It's trimmed to the clip's length
        (<b>${fmt(item.dur)}</b>) and keeps its place, effects, filter, animation and keyframes.</p>
      ${!fits && html`<p class="warn">This video (${fmt(total)}) is shorter than the clip, so all of it is used and the clip gets shorter.</p>`}
      <video ref=${video} class="rp-video" src=${m.url} preload="auto" muted=${false} onClick=${play} />
      <div class="rp-strip" ref=${strip} onPointerDown=${drag}>
        <div class="rp-win" style=${{ left: (inPt / total) * 100 + "%", width: Math.max(1, (win / total) * 100) + "%" }} title="Drag to choose the part to use" />
      </div>
      <div class="row between rp-times">
        <span class="muted">${fmt(inPt)} → ${fmt(inPt + win)}</span>
        <span class="row">
          <button class="ibtn" title="Back 1 s" onClick=${() => nudge(-1)}><${Icon} n="chevrons-left" /></button>
          <button class="ibtn" title="Back 1 frame" onClick=${() => nudge(-1 / (project.fps || 30))}><${Icon} n="chevron-left" /></button>
          <button class="ibtn" title="Play the chosen part" onClick=${play}><${Icon} n=${playing ? "pause" : "play"} /></button>
          <button class="ibtn" title="Forward 1 frame" onClick=${() => nudge(1 / (project.fps || 30))}><${Icon} n="chevron-right" /></button>
          <button class="ibtn" title="Forward 1 s" onClick=${() => nudge(1)}><${Icon} n="chevrons-right" /></button>
        </span>
        <span class="muted">${fmt(total)}</span>
      </div>
      <div class="row end">
        <button onClick=${close}>Cancel</button>
        <button class="primary" onClick=${() => replaceClip(job.kind, job.id, job.mediaId, inPt)}>Replace</button>
      </div>
    </div>
  </div>`;
}
