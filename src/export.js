// Offline audio mix + frame-by-frame MP4 export with WebCodecs.
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { layoutMain, projectDuration } from "./store.js";
import {
  drawFrame, renderLock, clipSpeed, activeClips, activeOverlays, exportFrames, seekClipElement, volumeAt, textSounds, visibleSources, compoundView,
} from "./engine.js";
import { demux, SegmentDecoder } from "./decode.js";
import { interpolate } from "./interp.js";
import { buildChain, needsChain, prepareContext, loudnessGain } from "./audiofx.js";
import { decodeMedia } from "./media-audio.js";
import { loadCutout } from "./segment.js";
import { hasKeys } from "./keyframes.js";
import { hasCurve, sourceSpan, rateSamples } from "./speed.js";

/** Every piece of timeline audio: { item, start, buf-source media } — main clips, overlay layers, audio items. */
function audioSources(project, level = 0) {
  const out = [];
  const ts = project.trackState || {};
  for (const seg of layoutMain(project)) out.push({ item: seg, start: seg.start, main: true, track: "main" });
  for (const o of project.overlays || []) out.push({ item: o, start: o.start, track: `overlay:${o.track ?? 0}` });
  for (const a of project.audio || []) out.push({ item: a, start: a.start, track: `audio:${a.track ?? 0}` });
  for (const a of textSounds(project)) out.push({ item: a, start: a.start, track: "text" });
  // Muted items and muted tracks are left out; a hidden picture track keeps its sound (like most editors).
  const kept = out.filter((s) => !s.item.mute && !ts[s.track]?.muted);
  const flat = [];
  for (const s of kept) {
    const media = project.media[s.item.mediaId];
    if (media?.kind !== "compound") { flat.push(s); continue; }
    if (level >= 6 || !media.sequence) continue;
    // The compound clip's own sounds, cut to the part of it that's used and played at its speed and volume.
    const c = s.item, sp = clipSpeed(c), a = c.in || 0, b = a + c.dur * sp, gain = c.audio?.volume ?? 1;
    for (const n of audioSources(compoundView(project, media, c.id), level + 1)) {
      const x = n.item, lo = Math.max(n.start, a), hi = Math.min(n.start + x.dur, b);
      if (hi - lo < 0.01) continue;
      const xs = clipSpeed(x);
      const { speedCurve: _c, ...rest } = x;
      flat.push({ start: s.start + (lo - a) / sp, track: s.track, item: {
        ...rest, in: (x.in || 0) + (lo - n.start) * xs, dur: (hi - lo) / sp, speed: xs * sp,
        audio: { ...x.audio, volume: (x.audio?.volume ?? 1) * gain },
      } });
    }
  }
  return flat;
}

/** Whether an item's volume is anything other than a constant 100%. */
const shapedVolume = (item) => {
  const au = item.audio || {};
  return (au.volume ?? 1) !== 1 || au.fadeIn > 0 || au.fadeOut > 0 || hasKeys(item, "volume");
};

/** Mixes all timeline audio into one AudioBuffer at `sampleRate` with `channels`. */
export async function mixAudio(project, sampleRate = 48000, channels = 2) {
  const dur = Math.max(0.1, projectDuration(project));
  const ctx = new OfflineAudioContext(channels, Math.ceil(dur * sampleRate), sampleRate);
  const sources = audioSources(project);
  if (sources.some((s) => needsChain(s.item.audio))) await prepareContext(ctx);
  for (const { item, start } of sources) {
    const media = project.media[item.mediaId];
    if (!media) continue;
    const buf = await decodeMedia(media);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    const end = start + item.dur;
    if (!shapedVolume(item)) {
      // Short fades at cuts avoid clicks.
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(1, start + 0.01);
      gain.gain.setValueAtTime(1, Math.max(start + 0.01, end - 0.01));
      gain.gain.linearRampToValueAtTime(0, end);
    } else {
      // Volume keyframes and fades, sampled at 200 Hz, with the same anti-click ramps at the ends.
      const n = Math.max(2, Math.ceil(item.dur * 200));
      const curve = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const lt = (i / (n - 1)) * item.dur;
        const edge = Math.min(1, lt / 0.01, (item.dur - lt) / 0.01);
        curve[i] = Math.max(0, volumeAt(item, lt) * Math.max(0, edge));
      }
      gain.gain.setValueAtTime(0, 0);
      gain.gain.setValueCurveAtTime(curve, start, Math.max(0.001, item.dur));
    }
    const speed = clipSpeed(item);
    const span = sourceSpan(item);
    const level = item.audio?.normalize ? loudnessGain(buf, item.in || 0, (item.in || 0) + span) : 1;
    src.connect(gain);
    if (needsChain(item.audio) || level !== 1) {
      const chain = buildChain(ctx, item.audio || {}, level);
      gain.connect(chain.input);
      chain.output.connect(ctx.destination);
    } else {
      gain.connect(ctx.destination);
    }
    // Speed changes pitch in the offline mix (the live preview keeps pitch).
    if (hasCurve(item)) {
      src.playbackRate.setValueAtTime(rateSamples(item, 2)[0], 0);
      src.playbackRate.setValueCurveAtTime(rateSamples(item, Math.ceil(item.dur * 100)), start, Math.max(0.001, item.dur));
    } else src.playbackRate.value = speed;
    src.start(start, item.in || 0, span);
  }
  return ctx.startRendering();
}

async function pickAudioCodec(sampleRate, numberOfChannels) {
  for (const [codec, muxCodec] of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
    const cfg = { codec, sampleRate, numberOfChannels, bitrate: 160_000 };
    if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, muxCodec };
  }
  return null;
}

/** Video codecs offered in the export dialog, best-compatibility first. */
export const VIDEO_CODECS = {
  avc: { label: "H.264 (plays everywhere)", strings: ["avc1.640034", "avc1.640033", "avc1.640028", "avc1.4d0028", "avc1.42001f"] },
  hevc: { label: "HEVC / H.265 (smaller files)", strings: ["hvc1.1.6.L153.B0", "hvc1.1.6.L150.B0", "hvc1.1.6.L123.B0", "hev1.1.6.L123.B0"] },
  av1: { label: "AV1 (smallest, newer devices)", strings: ["av01.0.12M.08", "av01.0.08M.08", "av01.0.05M.08", "av01.0.04M.08"] },
  vp9: { label: "VP9", strings: ["vp09.00.50.08", "vp09.00.41.08", "vp09.00.40.08", "vp09.00.31.08"] },
};

export const QUALITY = {
  max: { label: "Maximum", bpp: 0.3 },
  high: { label: "High", bpp: 0.13 },
  standard: { label: "Standard", bpp: 0.08 },
  small: { label: "Small file", bpp: 0.045 },
  custom: { label: "Custom bitrate…" },
};

/** Video bitrate in bits/s. `customKbps` is used when quality is "custom" (e.g. 40000 = 40 Mbps). */
export function bitrateFor(width, height, fps, quality = "high", customKbps) {
  if (quality === "custom" && customKbps > 0) return Math.round(customKbps * 1000);
  return Math.round(Math.min(200e6, Math.max(1.5e6, width * height * fps * (QUALITY[quality]?.bpp ?? 0.13))));
}

async function pickVideoCodec(codec, width, height, fps, bitrate) {
  for (const s of VIDEO_CODECS[codec].strings) {
    const cfg = { codec: s, width, height, bitrate, framerate: fps };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch { /* next */ }
  }
  return null;
}

/** Which codecs this computer can encode at a size (for the export dialog). */
export async function supportedCodecs(width, height, fps) {
  const out = {};
  for (const k of Object.keys(VIDEO_CODECS)) out[k] = !!(await pickVideoCodec(k, width, height, fps, bitrateFor(width, height, fps)));
  return out;
}

/**
 * Makes the frame for time t available to drawFrame: decoded VideoFrames where possible,
 * otherwise an exactly-seeked <video>. Decoders of clips and layers that have ended are closed.
 */
const interpCanvases = new Map(); // item id -> 2d context holding its interpolated picture

/** Copies an interpolated picture out of the shared GPU canvas (several clips can be visible at once). */
function keepPicture(id, src) {
  let c = interpCanvases.get(id);
  if (!c) { c = new OffscreenCanvas(src.width, src.height).getContext("2d"); interpCanvases.set(id, c); }
  if (c.canvas.width !== src.width || c.canvas.height !== src.height) { c.canvas.width = src.width; c.canvas.height = src.height; }
  c.drawImage(src, 0, 0);
  return c.canvas;
}

/**
 * Picks (or makes) the picture each video shows at export time t. With `smooth` = { method, blur, fps }, frames
 * that fall between two real frames are interpolated, and `blur` (0..1 of a frame) adds motion blur.
 */
async function prepareFrame(project, t, decoders, smooth) {
  const visible = visibleSources(project, t);
  const live = new Set(visible.map((c) => c.item.id));
  for (const [id, dec] of decoders) {
    if (!live.has(id)) { dec?.close(); decoders.delete(id); exportFrames.delete(id); }
  }
  for (const c of visible) {
    const media = c.media;
    if (!media || media.kind === "audio") continue;
    if (media.kind !== "video") { await seekClipElement(c.item, media, 0); continue; }
    if (!decoders.has(c.item.id)) {
      const d = await demux(media);
      decoders.set(c.item.id, d ? new SegmentDecoder(d, c.sourceTime) : null);
    }
    const dec = decoders.get(c.item.id);
    let frame = null;
    if (dec && smooth && smooth.method !== "off") {
      try {
        const { a, b, alpha } = await dec.pairAt(c.sourceTime);
        frame = a;
        if (a && b) {
          // Blur covers `blur` of an output frame, in units of the gap between the two real frames.
          const gap = (b.timestamp - a.timestamp) / 1e6;
          const span = smooth.blur > 0 ? Math.min(1, (smooth.blur * clipSpeed(c.item)) / smooth.fps / gap) : 0;
          // Only when the export has more frames than the clip (higher frame rate or slow motion).
          const upsampling = clipSpeed(c.item) / smooth.fps < gap * 0.95;
          if (upsampling && ((alpha > 0.02 && alpha < 0.98) || span > 0)) {
            const pic = interpolate(a, b, alpha, { method: smooth.method, span });
            if (pic) frame = keepPicture(c.item.id, pic);
          }
        }
      } catch {
        dec.close();
        decoders.set(c.item.id, null);
      }
    } else if (dec) {
      try {
        frame = await dec.frameAt(c.sourceTime);
      } catch {
        dec.close();
        decoders.set(c.item.id, null); // fall back to seeking for the rest of this clip
      }
    }
    if (frame) exportFrames.set(c.item.id, frame);
    else {
      exportFrames.delete(c.item.id);
      await seekClipElement(c.item, media, c.sourceTime);
    }
  }
}

/**
 * Renders the project to an MP4 Blob. `onProgress(0..1)` is called per frame.
 * opts = { width, height, fps, codec: "avc"|"hevc"|"av1"|"vp9", quality } (defaults: project size, H.264, high).
 */
export async function exportMp4(project, onProgress, signal, opts = {}) {
  const width = opts.width ?? project.width, height = opts.height ?? project.height, fps = opts.fps ?? project.fps;
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error("Nothing to export — add a clip first.");

  const codec = opts.codec ?? "avc";
  const bitrate = bitrateFor(width, height, fps, opts.quality, opts.customKbps);
  const vcfg = await pickVideoCodec(codec, width, height, fps, bitrate);
  if (!vcfg) {
    if (await pickVideoCodec(codec, width, height, fps, 8e6)) {
      throw new Error(`This computer's ${VIDEO_CODECS[codec].label.split(" (")[0]} encoder doesn't accept ${Math.round(bitrate / 1000).toLocaleString()} kbps at ${width}×${height}. Try a lower bitrate.`);
    }
    if (codec === "avc") throw new Error("This browser cannot encode H.264 video. Try Chrome or Edge.");
    throw new Error(`This computer can't encode ${VIDEO_CODECS[codec].label.split(" (")[0]} at ${width}×${height}. Pick H.264 or a smaller size.`);
  }
  const usesCutout = [...project.main, ...(project.overlays || [])].some((x) => x.cutout?.mode);
  if (usesCutout && !(await loadCutout())) throw new Error("Background removal couldn't load (check your internet connection).");
  const audio = await pickAudioCodec(48000, 2);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec, width, height, frameRate: fps },
    audio: audio ? { codec: audio.muxCodec, numberOfChannels: 2, sampleRate: 48000 } : undefined,
    fastStart: "in-memory",
  });

  let encodeError = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => (encodeError = e),
  });
  venc.configure(vcfg);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const frames = Math.ceil(duration * fps);
  const mixPromise = audio ? mixAudio(project, 48000, 2) : null; // runs alongside the video encode
  mixPromise?.catch(() => {});
  const decoders = new Map(); // item id -> SegmentDecoder | null (null = seek fallback)
  const smooth = opts.smooth && opts.smooth.method !== "off" ? { ...opts.smooth, fps } : null;
  renderLock.exporting = true;
  try {
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
      if (encodeError) throw encodeError;
      const t = i / fps;
      await prepareFrame(project, t, decoders, smooth);
      drawFrame(ctx, project, t);
      const frame = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
      venc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();
      while (venc.encodeQueueSize > 8) await new Promise((r) => venc.addEventListener("dequeue", r, { once: true }));
      onProgress?.((i + 1) / frames * (audio ? 0.9 : 1));
    }
    await venc.flush();
  } finally {
    renderLock.exporting = false;
    decoders.forEach((d) => d?.close());
    exportFrames.clear();
    interpCanvases.clear();
  }

  if (audio) {
    const mix = await mixPromise;
    const aenc = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => (encodeError = e),
    });
    aenc.configure(audio.cfg);
    const block = 4800;
    const L = mix.getChannelData(0), R = mix.getChannelData(1);
    for (let off = 0; off < mix.length; off += block) {
      const n = Math.min(block, mix.length - off);
      const planar = new Float32Array(n * 2);
      planar.set(L.subarray(off, off + n), 0);
      planar.set(R.subarray(off, off + n), n);
      const data = new AudioData({
        format: "f32-planar", sampleRate: 48000, numberOfFrames: n, numberOfChannels: 2,
        timestamp: Math.round((off / 48000) * 1e6), data: planar,
      });
      aenc.encode(data);
      data.close();
    }
    await aenc.flush();
    if (encodeError) throw encodeError;
  }
  muxer.finalize();
  onProgress?.(1);
  return new Blob([target.buffer], { type: "video/mp4" });
}

/** The timeline's audio as a 16-bit stereo WAV file. */
export async function exportWav(project) {
  if (projectDuration(project) <= 0) throw new Error("Nothing to export — add a clip first.");
  return wavBlob(await mixAudio(project, 48000, 2));
}

/** Encodes an AudioBuffer as a 16-bit PCM WAV Blob. */
export function wavBlob(buf) {
  const ch = buf.numberOfChannels, n = buf.length, sr = buf.sampleRate;
  const data = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); data.setUint32(4, 36 + n * ch * 2, true); str(8, "WAVE");
  str(12, "fmt "); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
  data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true); data.setUint16(34, 16, true);
  str(36, "data"); data.setUint32(40, n * ch * 2, true);
  const chans = [...Array(ch)].map((_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { data.setInt16(o, Math.max(-1, Math.min(1, chans[c][i])) * 0x7fff, true); o += 2; }
  return new Blob([data.buffer], { type: "audio/wav" });
}

/** The frame at time t as a full-resolution PNG. */
export async function exportFrame(project, t) {
  const canvas = new OffscreenCanvas(project.width, project.height);
  const decoders = new Map();
  renderLock.exporting = true;
  try {
    await prepareFrame(project, t, decoders);
    drawFrame(canvas.getContext("2d"), project, t);
  } finally {
    renderLock.exporting = false;
    decoders.forEach((d) => d?.close());
    exportFrames.clear();
  }
  return canvas.convertToBlob({ type: "image/png" });
}
