// Smooth-preview proxies: a light copy of each video (max 720p, a keyframe every 15 frames) built in the
// background. The preview plays and scrubs the proxy, so jumping anywhere only decodes a few frames instead of
// everything since the last keyframe (OBS recordings often have one every few seconds). Export always reads
// the original files. Building pauses while the preview plays or an export runs, and works a little at a time
// so editing stays responsive. On the desktop app proxies are saved next to the app's settings and reused.
import { Muxer, ArrayBufferTarget, StreamTarget } from "mp4-muxer";
import { getState, setState } from "./store.js";
import { demux } from "./decode.js";
import { decodeMedia } from "./media-audio.js";
import { renderLock } from "./engine.js";

const MAX_H = 720;
const KEY_EVERY = 15;
const desktop = typeof window !== "undefined" ? window.cutlineDesktop : null;

const ready = new Map(); // mediaId -> { url, audio }
const failed = new Set();
let running = null; // mediaId being built

export const proxiesEnabled = () => getState().proxyMode !== "off";

export function setProxyMode(mode) {
  setState({ proxyMode: mode });
  try { localStorage.setItem("cutline.proxies", mode); } catch { /* private mode */ }
}

/** The proxy URL to preview a video with, or null (none yet, turned off, or it has no sound and sound is needed). */
export function proxySrc(media, needSound) {
  if (!proxiesEnabled() || media?.kind !== "video") return null;
  const p = ready.get(media.id);
  if (!p || (needSound && !p.audio)) return null;
  return p.url;
}

const status = (id, patch) => setState({ proxies: { ...getState().proxies, [id]: { ...getState().proxies?.[id], ...patch } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits while the preview is playing or exporting, so building never competes with them. */
async function idle() {
  while (getState().playing || renderLock.exporting || !proxiesEnabled()) await sleep(300);
}

/** Videos still needing a proxy: the ones on the timeline first. */
function queue() {
  const p = getState().project;
  const used = new Set([...p.main, ...(p.overlays || [])].map((x) => x.mediaId));
  return Object.values(p.media)
    .filter((m) => m.kind === "video" && !m.missing && !m.noPicture && !ready.has(m.id) && !failed.has(m.id) && m.w && m.h)
    .sort((a, b) => (used.has(b.id) ? 1 : 0) - (used.has(a.id) ? 1 : 0));
}

async function tick() {
  if (running || !proxiesEnabled()) return;
  const next = queue()[0];
  if (!next) return;
  running = next.id;
  try {
    const out = await build(next);
    ready.set(next.id, out);
    status(next.id, { state: "ready", progress: 1 });
  } catch (e) {
    console.warn("proxy failed", next.name, e);
    failed.add(next.id);
    status(next.id, { state: "failed" });
  } finally {
    running = null;
  }
}

/** Starts the background builder (checks for new videos every couple of seconds). */
export function startProxies() {
  let mode = "on";
  try { mode = localStorage.getItem("cutline.proxies") || "on"; } catch { /* default */ }
  setState({ proxyMode: mode, proxies: {} });
  setInterval(tick, 2000);
}

async function pickVideo(width, height, fps) {
  for (const codec of ["avc1.4d4028", "avc1.42e028", "avc1.640028", "avc1.4d401f"]) {
    const cfg = { codec, width, height, framerate: fps, bitrate: Math.round(width * height * Math.min(fps, 60) * 0.09) };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* next */ }
  }
  return null;
}

async function pickAudio(sampleRate, numberOfChannels) {
  for (const [codec, muxCodec] of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
    const cfg = { codec, sampleRate, numberOfChannels, bitrate: 128_000 };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, muxCodec }; } catch { /* next */ }
  }
  return null;
}

/** Where the proxy goes: a file on disk (desktop) or memory (browser). */
async function openOutput(media) {
  if (desktop?.proxyOpen && media.path) {
    const slot = await desktop.proxyOpen(media.path);
    if (slot?.exists) return { existing: desktop.fileUrl(slot.path), audio: slot.audio };
    if (slot?.part) {
      let writes = Promise.resolve();
      const target = new StreamTarget({
        chunked: true, chunkSize: 4 * 1024 * 1024,
        onData: (data, position) => { const copy = data.slice(); writes = writes.then(() => desktop.proxyWrite(slot.part, position, copy)); },
      });
      return {
        target,
        finish: async (audio) => { await writes; const final = await desktop.proxyDone(slot.part, slot.path, audio); return desktop.fileUrl(final); },
        abort: async () => { await writes.catch(() => {}); await desktop.proxyAbort(slot.part); },
      };
    }
  }
  const target = new ArrayBufferTarget();
  return { target, finish: async () => URL.createObjectURL(new Blob([target.buffer], { type: "video/mp4" })), abort: async () => {} };
}

async function build(media) {
  status(media.id, { state: "building", progress: 0 });
  const out = await openOutput(media);
  if (out.existing) {
    status(media.id, { state: "ready", progress: 1 });
    return { url: out.existing, audio: out.audio };
  }
  const scale = Math.min(1, MAX_H / media.h);
  const W = Math.max(2, Math.round((media.w * scale) / 2) * 2), H = Math.max(2, Math.round((media.h * scale) / 2) * 2);
  const demuxed = /\.(mp4|m4v|mov|mkv|webm)$/i.test(media.name) ? await demux(media) : null;
  // Frame rate: from the MP4's sample count, else assume 60 (captures every frame of anything up to 60 fps).
  const measured = demuxed && demuxed.samples.length > 1 ? (demuxed.samples.length - 1) / ((demuxed.samples.at(-1).ts - demuxed.samples[0].ts) / 1e6 || 1) : 0;
  const fps = Math.min(120, Math.max(1, Math.round(measured || 60)));
  const vcfg = await pickVideo(W, H, fps);
  if (!vcfg) throw new Error("no H.264 encoder");
  const sound = await decodeMedia(media).catch(() => null);
  const acodec = sound ? await pickAudio(sound.sampleRate, Math.min(2, sound.numberOfChannels)) : null;
  const channels = sound ? Math.min(2, sound.numberOfChannels) : 0;

  const muxer = new Muxer({
    target: out.target,
    video: { codec: "avc", width: W, height: H, frameRate: fps },
    audio: acodec ? { codec: acodec.muxCodec, numberOfChannels: channels, sampleRate: sound.sampleRate } : undefined,
    fastStart: false,
    firstTimestampBehavior: "offset",
  });
  let err = null;
  const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: (e) => (err = e) });
  venc.configure(vcfg);
  const aenc = acodec ? new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: (e) => (err = e) }) : null;
  aenc?.configure(acodec.cfg);

  // Sound is fed alongside the picture, up to the time of the latest frame.
  let audioPos = 0;
  const pumpAudio = (upto) => {
    if (!aenc) return;
    const end = Math.min(sound.length, Math.floor(upto * sound.sampleRate));
    const block = 4800;
    while (audioPos < end) {
      const n = Math.min(block, end - audioPos);
      const planar = new Float32Array(n * channels);
      for (let c = 0; c < channels; c++) planar.set(sound.getChannelData(c).subarray(audioPos, audioPos + n), c * n);
      const data = new AudioData({ format: "f32-planar", sampleRate: sound.sampleRate, numberOfFrames: n, numberOfChannels: channels,
        timestamp: Math.round((audioPos / sound.sampleRate) * 1e6), data: planar });
      aenc.encode(data);
      data.close();
      audioPos += n;
    }
  };

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  let n = 0, lastTs = -1;
  const encodeFrom = async (source, tsMicros, durMicros) => {
    if (tsMicros <= lastTs) return;
    lastTs = tsMicros;
    ctx.drawImage(source, 0, 0, W, H);
    const frame = new VideoFrame(canvas, { timestamp: tsMicros, duration: durMicros || Math.round(1e6 / fps) });
    venc.encode(frame, { keyFrame: n % KEY_EVERY === 0 });
    frame.close();
    n++;
    pumpAudio(tsMicros / 1e6 + 0.5);
    while (venc.encodeQueueSize > 4) await new Promise((r) => venc.addEventListener("dequeue", r, { once: true }));
    if (n % 30 === 0) status(media.id, { progress: Math.min(0.99, tsMicros / 1e6 / Math.max(0.1, media.duration)) });
  };

  try {
    if (demuxed) await fromDecoder(demuxed, encodeFrom, () => err);
    else await fromPlayback(media, fps, encodeFrom, () => err);
    if (err) throw err;
    pumpAudio(Infinity);
    await venc.flush();
    if (aenc) await aenc.flush();
    if (err) throw err;
    muxer.finalize();
    const audio = !!aenc || !sound; // false: the original has sound that couldn't go into the proxy
    const url = await out.finish(audio);
    return { url, audio };
  } catch (e) {
    try { venc.close(); aenc?.close(); } catch { /* already closed */ }
    await out.abort();
    throw e;
  }
}

/** MP4/MOV: decode the samples with WebCodecs, as fast as the computer comfortably allows. */
async function fromDecoder(demuxed, encodeFrom, error) {
  const frames = [];
  let wake = null;
  const dec = new VideoDecoder({
    output: (f) => { frames.push(f); wake?.(); },
    error: (e) => { frames.push(e); wake?.(); },
  });
  dec.configure(demuxed.config);
  const t0 = demuxed.samples.find((s) => s.key)?.ts ?? 0;
  const drain = async () => {
    while (frames.length) {
      const f = frames.shift();
      if (f instanceof Error || f instanceof DOMException) throw f;
      try { await encodeFrom(f, Math.max(0, f.timestamp - t0), f.duration); } finally { f.close(); }
    }
  };
  let i = 0;
  for (const s of demuxed.samples) {
    if (error()) throw error();
    if (i++ % 8 === 0) { await idle(); await sleep(0); }
    dec.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: s.ts, duration: s.dur, data: s.data }));
    while (dec.decodeQueueSize > 6) { await drain(); await new Promise((r) => { wake = r; setTimeout(r, 50); }); }
    await drain();
  }
  await dec.flush();
  await drain();
  dec.close();
}

/** Other formats (e.g. MKV): play the file hidden and capture every frame it shows. */
async function fromPlayback(media, fps, encodeFrom, error) {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.crossOrigin = "anonymous";
  v.preload = "auto";
  Object.assign(v.style, { position: "fixed", left: "-8px", top: "-8px", width: "4px", height: "4px", opacity: "0", pointerEvents: "none" });
  v.src = media.url;
  document.body.append(v);
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error("can't play")); });
    // Fast enough to catch every frame on a 60 Hz screen: 30 fps plays at 2×, 60 fps at 1×.
    const rate = Math.max(1, Math.min(4, 60 / fps));
    let pending = Promise.resolve();
    await new Promise((res, rej) => {
      const onFrame = (_now, meta) => {
        if (error()) return rej(error());
        pending = pending.then(() => encodeFrom(v, Math.round(meta.mediaTime * 1e6))).catch(rej);
        if (!v.ended) v.requestVideoFrameCallback(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
      v.onended = () => pending.then(res, rej);
      // Pause while the editor plays or exports; carry on afterwards.
      const watch = setInterval(() => {
        if (!document.body.contains(v)) return clearInterval(watch);
        const hold = getState().playing || renderLock.exporting || !proxiesEnabled();
        if (hold && !v.paused) v.pause();
        else if (!hold && v.paused && !v.ended) { v.playbackRate = rate; v.play().catch(() => {}); }
      }, 250);
      v.playbackRate = rate;
      v.play().catch(rej);
    });
  } finally {
    v.pause();
    v.removeAttribute("src");
    v.load();
    v.remove();
  }
}
