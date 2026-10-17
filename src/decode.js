// Fast sequential frame access for export: demux MP4/MOV with mp4box, decode with WebCodecs.
// Each export segment gets its own decoder that only moves forward in time, so every frame
// is decoded once instead of seeking a <video> element per frame.
import { createFile, DataStream } from "mp4box";

const demuxCache = new Map(); // mediaId -> Promise<{config, samples} | null>

/** Demuxes the first video track of a media file. Resolves to null if unsupported. */
export function demux(media) {
  if (!demuxCache.has(media.id)) demuxCache.set(media.id, demuxFile(media.file).catch(() => null));
  return demuxCache.get(media.id);
}

async function demuxFile(file) {
  const buf = await file.arrayBuffer();
  const result = await new Promise((resolve, reject) => {
    const mp4 = createFile();
    let track = null;
    const samples = [];
    mp4.onError = (e) => reject(new Error(String(e)));
    mp4.onReady = (info) => {
      track = info.videoTracks[0];
      if (!track) return resolve(null);
      mp4.setExtractionOptions(track.id, null, { nbSamples: Infinity });
      mp4.start();
    };
    mp4.onSamples = (_id, _user, batch) => samples.push(...batch);
    buf.fileStart = 0;
    mp4.appendBuffer(buf);
    mp4.flush();
    // All sample callbacks fire synchronously for an in-memory file.
    if (!track) return resolve(null);
    const trak = mp4.getTrackById(track.id);
    resolve({ track, trak, samples });
  });
  if (!result) return null;
  const { track, trak, samples } = result;
  const config = {
    codec: track.codec.startsWith("vp08") ? "vp8" : track.codec,
    codedWidth: track.video.width,
    codedHeight: track.video.height,
    description: codecDescription(trak),
  };
  const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support.supported || !samples.length) return null;
  return {
    config,
    samples: samples.map((s) => ({
      key: s.is_sync,
      ts: (s.cts * 1e6) / s.timescale,
      dur: (s.duration * 1e6) / s.timescale,
      data: s.data,
    })),
  };
}

/** The avcC/hvcC/vpcC/av1C box payload WebCodecs needs as `description`. */
function codecDescription(trak) {
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) {
      const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
      box.write(stream);
      return new Uint8Array(stream.buffer, 8); // skip the box header
    }
  }
  return undefined;
}

/** Forward-only frame reader for one segment, starting near `startTime` (seconds). */
export class SegmentDecoder {
  constructor(demuxed, startTime) {
    this.samples = demuxed.samples;
    this.queue = [];
    this.current = null;
    this.done = false;
    this.flushing = null;
    this.waiters = [];
    this.error = null;
    this.decoder = new VideoDecoder({
      output: (frame) => { this.queue.push(frame); this.wake(); },
      error: (e) => { this.error = e; this.wake(); },
    });
    this.decoder.configure(demuxed.config);
    // Start at the last keyframe at or before the start time (decode order = sample order).
    const target = startTime * 1e6;
    let start = 0;
    for (let i = 0; i < this.samples.length; i++) {
      if (this.samples[i].key && this.samples[i].ts <= target + 1) start = i;
      if (this.samples[i].ts > target && this.samples[i].key) break;
    }
    this.next = start;
  }

  wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((r) => r());
  }

  waitOutput() {
    return new Promise((r) => {
      this.waiters.push(r);
      setTimeout(r, 500); // safety net
    });
  }

  feed(n = 8) {
    for (let i = 0; i < n && this.next < this.samples.length; i++, this.next++) {
      const s = this.samples[this.next];
      this.decoder.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: s.ts, duration: s.dur, data: s.data }));
    }
  }

  /** Returns the frame to show at source time t (seconds). The frame stays owned by the decoder. */
  async frameAt(t) {
    const target = t * 1e6 + 500;
    for (;;) {
      if (this.error) throw this.error;
      this.queue.sort((a, b) => a.timestamp - b.timestamp);
      while (this.queue.length && this.queue[0].timestamp <= target) {
        this.current?.close();
        this.current = this.queue.shift();
      }
      if (this.queue.length || this.done) return this.current ?? this.queue[0] ?? null;
      if (this.next < this.samples.length) {
        if (this.decoder.decodeQueueSize > 12) await this.waitOutput();
        else this.feed();
      } else {
        this.flushing ??= this.decoder.flush().then(() => { this.done = true; this.wake(); }, (e) => { this.error = e; });
        await this.waitOutput();
      }
    }
  }

  close() {
    this.current?.close();
    this.queue.forEach((f) => f.close());
    this.queue = [];
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}
