// Offline audio mix + frame-by-frame MP4 export with WebCodecs.
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { layoutMain, projectDuration } from "./store.js";
import { drawFrame, renderLock, clipSpeed, activeClips, exportFrames, seekClipElement } from "./engine.js";
import { demux, SegmentDecoder } from "./decode.js";

const decoded = new Map(); // mediaId -> AudioBuffer | null

async function decodeMedia(media) {
  if (decoded.has(media.id)) return decoded.get(media.id);
  let buf = null;
  if (media.kind === "video") {
    try {
      const ctx = new AudioContext();
      buf = await ctx.decodeAudioData(await media.file.arrayBuffer());
      ctx.close();
    } catch {
      buf = null; // silent video
    }
  }
  decoded.set(media.id, buf);
  return buf;
}

/** Mixes the main-track audio into one AudioBuffer at `sampleRate` with `channels`. */
export async function mixAudio(project, sampleRate = 48000, channels = 2) {
  const dur = Math.max(0.1, projectDuration(project));
  const ctx = new OfflineAudioContext(channels, Math.ceil(dur * sampleRate), sampleRate);
  for (const seg of layoutMain(project)) {
    const buf = await decodeMedia(project.media[seg.mediaId]);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    // Short fades at cuts avoid clicks.
    gain.gain.setValueAtTime(0, seg.start);
    gain.gain.linearRampToValueAtTime(1, seg.start + 0.01);
    gain.gain.setValueAtTime(1, Math.max(seg.start + 0.01, seg.start + seg.dur - 0.01));
    gain.gain.linearRampToValueAtTime(0, seg.start + seg.dur);
    src.connect(gain).connect(ctx.destination);
    // Speed changes pitch in the offline mix (the live preview keeps pitch).
    const speed = clipSpeed(seg);
    src.playbackRate.value = speed;
    src.start(seg.start, seg.in, seg.dur * speed);
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

async function pickVideoCodec(width, height, fps) {
  for (const codec of ["avc1.640033", "avc1.640028", "avc1.4d0028", "avc1.42001f"]) {
    const cfg = { codec, width, height, bitrate: 8_000_000, framerate: fps };
    if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
  }
  throw new Error("This browser cannot encode H.264 video. Try Chrome or Edge.");
}

/**
 * Makes the frame for time t available to drawFrame: decoded VideoFrames where possible,
 * otherwise an exactly-seeked <video>. Decoders of clips that have ended are closed.
 */
async function prepareFrame(project, t, decoders) {
  const { clips } = activeClips(project, t);
  const live = new Set(clips.map((c) => c.seg.id));
  for (const [id, dec] of decoders) {
    if (!live.has(id)) { dec?.close(); decoders.delete(id); exportFrames.delete(id); }
  }
  for (const c of clips) {
    const media = project.media[c.seg.mediaId];
    if (media.kind !== "video") { await seekClipElement(c.seg, media, 0); continue; }
    if (!decoders.has(c.seg.id)) {
      const d = await demux(media);
      decoders.set(c.seg.id, d ? new SegmentDecoder(d, c.sourceTime) : null);
    }
    const dec = decoders.get(c.seg.id);
    let frame = null;
    if (dec) {
      try {
        frame = await dec.frameAt(c.sourceTime);
      } catch {
        dec.close();
        decoders.set(c.seg.id, null); // fall back to seeking for the rest of this clip
      }
    }
    if (frame) exportFrames.set(c.seg.id, frame);
    else {
      exportFrames.delete(c.seg.id);
      await seekClipElement(c.seg, media, c.sourceTime);
    }
  }
}

/** Renders the project to an MP4 Blob. `onProgress(0..1)` is called per frame. */
export async function exportMp4(project, onProgress, signal) {
  const { width, height, fps } = project;
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error("Nothing to export — add a clip first.");

  const vcfg = await pickVideoCodec(width, height, fps);
  const audio = await pickAudioCodec(48000, 2);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: "avc", width, height, frameRate: fps },
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
  const decoders = new Map(); // segId -> SegmentDecoder | null (null = seek fallback)
  renderLock.exporting = true;
  try {
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
      if (encodeError) throw encodeError;
      const t = i / fps;
      await prepareFrame(project, t, decoders);
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
