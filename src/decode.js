// Fast sequential frame access for export: demux MP4/MOV (mp4box) or MKV/WebM (below), decode with WebCodecs.
// Each export segment gets its own decoder that only moves forward in time, so every frame
// is decoded once instead of seeking a <video> element per frame.
import { createFile, DataStream } from "mp4box";
import { byteSource, indexMatroska, mkvSamples, indexMp4, mp4Samples, loadData, dropData } from "./bigfile.js";

const demuxCache = new Map(); // mediaId -> Promise<{config, samples} | null>

/** Demuxes the first video track of a media file. Resolves to null if unsupported. */
export function demux(media) {
  if (!demuxCache.has(media.id)) demuxCache.set(media.id, demuxMedia(media).catch((e) => { console.warn("demux", media.name, e); return null; }));
  return demuxCache.get(media.id);
}

/** Files bigger than this are indexed and read piece by piece instead of loaded whole. */
const lazyBytes = () => globalThis.CUTLINE_LAZY_BYTES ?? 512e6;

const isMatroska = (media) => /\.(mkv|webm)$/i.test(media.name || "");
const desk = () => (typeof window !== "undefined" ? window.cutlineDesktop : null);

async function demuxMedia(media) {
  const src = await byteSource(media);
  // Desktop: MKV recordings use their saved scan (one read of the file, ever) instead of being parsed here.
  if (isMatroska(media) && media.path && desk()?.scan) return demuxScanned(media, src);
  if (src.size > lazyBytes()) return demuxLazy(src);
  return demuxFile(media.file);
}

/** Video frames of an MKV from its scan; frames are read from the file as they're decoded. */
async function demuxScanned(media, src) {
  const { index } = await desk().scan(media.path);
  const v = index.video;
  const priv = v?.priv ? Uint8Array.from(atob(v.priv), (c) => c.charCodeAt(0)) : null;
  const codec = v && codecString(v.codec, priv);
  if (!codec || !index.frames.length) return null;
  const config = { codec, codedWidth: v.width, codedHeight: v.height, ...(priv && /AVC|HEVC|AV1/.test(v.codec) ? { description: priv } : {}) };
  const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support.supported) return null;
  const toUs = (tc) => (tc * index.scale) / 1000;
  const pts = [...new Set(index.frames.map((f) => f[2]))].sort((a, b) => a - b);
  const nextOf = new Map(pts.map((x, i) => [x, pts[i + 1]]));
  const t0 = toUs(pts[0]);
  const frameUs = v.frameNs ? v.frameNs / 1000 : 16667;
  const samples = index.frames.map(([offset, size, tc, key]) => {
    const n = nextOf.get(tc);
    return { key: !!key, ts: toUs(tc) - t0, dur: n != null ? toUs(n) - toUs(tc) : frameUs, offset, size };
  });
  return { config, samples, src, lazy: true };
}

/** The scan's sound packets for an MKV ({ config, samples with data }), or null. Shared with media-audio.js. */
export async function scannedAudio(media) {
  if (!isMatroska(media) || !media.path || !desk()?.scan) return null;
  const { index, audioPath } = await desk().scan(media.path);
  const a = index.audio;
  if (!a || !index.packets.length) return null;
  const bytes = new Uint8Array(await (await fetch(desk().fileUrl(audioPath))).arrayBuffer());
  const priv = a.priv ? Uint8Array.from(atob(a.priv), (c) => c.charCodeAt(0)) : null;
  const toUs = (tc) => (tc * index.scale) / 1000;
  const vt = index.frames.length ? Math.min(...index.frames.slice(0, 200).map((f) => f[2])) : index.packets[0][0];
  let off = 0;
  const samples = index.packets.map(([tc, size], i) => {
    const s = { ts: toUs(tc) - toUs(vt), data: bytes.subarray(off, off + size) };
    off += size;
    const next = index.packets[i + 1];
    s.dur = next ? toUs(next[0]) - toUs(tc) : 21333;
    return s;
  });
  const codec = a.codec === "A_AAC" ? "mp4a.40.2" : a.codec === "A_OPUS" ? "opus" : null;
  if (!codec) return null;
  return { config: { codec, sampleRate: a.rate || 48000, numberOfChannels: a.channels || 2, ...(priv ? { description: priv } : {}) }, samples };
}

/** Starts scanning big MKV recordings in the background as soon as they're in the library. */
export function startScans(getState, setState) {
  if (!desk()?.scan) return;
  const started = new Set();
  desk().onScanProgress?.(({ path, progress }) => setState({ scans: { ...getState().scans, [path]: progress } }));
  setInterval(() => {
    for (const m of Object.values(getState().project.media)) {
      if (m.kind !== "video" || !m.path || m.missing || !isMatroska(m) || started.has(m.path)) continue;
      started.add(m.path);
      desk().scan(m.path).catch((e) => console.warn("scan", m.name, e));
    }
  }, 2000);
}

/** Big file: an index of where every frame is; SegmentDecoder reads frames from disk as it goes. */
async function demuxLazy(src) {
  const head = await src.read(0, 4);
  let config = null, samples = [];
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    const index = await indexMatroska(src);
    const v = index.tracks.find((t) => t.type === 1);
    const codec = v && codecString(v.codec, v.priv);
    if (!codec) return null;
    config = { codec, codedWidth: v.width, codedHeight: v.height, ...(v.priv && /AVC|HEVC|AV1/.test(v.codec) ? { description: v.priv } : {}) };
    samples = mkvSamples(index, v);
  } else {
    const index = await indexMp4(src);
    const track = index?.info.videoTracks[0];
    if (!track) return null;
    config = {
      codec: track.codec.startsWith("vp08") ? "vp8" : track.codec,
      codedWidth: track.video.width, codedHeight: track.video.height,
      description: codecDescription(index.mp4.getTrackById(track.id)),
    };
    samples = mp4Samples(index, track.id);
  }
  if (!samples.length) return null;
  const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support.supported) return null;
  return { config, samples, src, lazy: true };
}

/** Makes sure samples[from..to) have their bytes (big files read ahead ~120 frames at a time). */
export async function ensureData(demuxed, from, to) {
  if (!demuxed.lazy) return;
  for (let k = from; k < to; k++) {
    if (!demuxed.samples[k].data) { await loadData(demuxed.src, demuxed.samples, k, Math.min(demuxed.samples.length, Math.max(to, k + 120))); return; }
  }
}
export const releaseData = (demuxed, from, to) => demuxed.lazy && dropData(demuxed.samples, from, to);

async function demuxFile(file) {
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return demuxMatroska(buf);
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
    this.demuxed = demuxed;
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

  async feed(n = 8) {
    const from = this.next, to = Math.min(this.samples.length, from + n);
    await ensureData(this.demuxed, from, to);
    for (let i = from; i < to; i++, this.next++) {
      const s = this.samples[i];
      this.decoder.decode(new EncodedVideoChunk({ type: s.key ? "key" : "delta", timestamp: s.ts, duration: s.dur, data: s.data }));
    }
    releaseData(this.demuxed, from, to);
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
        else await this.feed();
      } else {
        this.flushing ??= this.decoder.flush().then(() => { this.done = true; this.wake(); }, (e) => { this.error = e; });
        await this.waitOutput();
      }
    }
  }

  /**
   * The real frames on either side of source time t and how far between them t is:
   * { a, b, alpha } (b is null at the end). Both stay owned by the decoder.
   */
  async pairAt(t) {
    const a = await this.frameAt(t);
    while (!this.queue.length && !this.done && !this.error) {
      if (this.next < this.samples.length) {
        if (this.decoder.decodeQueueSize > 12) await this.waitOutput();
        else await this.feed();
      } else {
        this.flushing ??= this.decoder.flush().then(() => { this.done = true; this.wake(); }, (e) => { this.error = e; });
        await this.waitOutput();
      }
    }
    this.queue.sort((x, y) => x.timestamp - y.timestamp);
    const b = this.queue[0] || null;
    if (!a || !b || b.timestamp <= a.timestamp) return { a, b: null, alpha: 0 };
    const alpha = Math.max(0, Math.min(1, (t * 1e6 - a.timestamp) / (b.timestamp - a.timestamp)));
    return { a, b, alpha };
  }

  close() {
    this.current?.close();
    this.queue.forEach((f) => f.close());
    this.queue = [];
    if (this.decoder.state !== "closed") this.decoder.close();
  }
}

// ---------------- Matroska / WebM (OBS .mkv recordings) ----------------

const ID = {
  Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Tracks: 0x1654ae6b, TrackEntry: 0xae,
  TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2, Video: 0xe0, PixelWidth: 0xb0,
  PixelHeight: 0xba, DefaultDuration: 0x23e383, Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3,
  BlockGroup: 0xa0, Block: 0xa1, ReferenceBlock: 0xfb,
};
// Elements that can follow a Cluster of unknown size (it ends where one of these starts).
const TOP = new Set([ID.Cluster, 0x1c53bb6b, 0x1254c367, 0x1043a770, 0x1941a469, 0x114d9b74, ID.Info, ID.Tracks]);

/** Reads an EBML variable-length number at `pos`: { value, len, unknown }. `keepMarker` for element IDs. */
function vint(bytes, pos, keepMarker) {
  const first = bytes[pos];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8) throw new Error("bad EBML");
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { value = value * 256 + bytes[pos + i]; if (bytes[pos + i] !== 0xff) allOnes = false; }
  return { value, len, unknown: !keepMarker && allOnes };
}

const uint = (bytes, pos, size) => { let v = 0; for (let i = 0; i < size; i++) v = v * 256 + bytes[pos + i]; return v; };
const str = (bytes, pos, size) => String.fromCharCode(...bytes.subarray(pos, pos + size)).replace(/\0+$/, "");

/** Walks the child elements in [start, end): fn(id, dataPos, size, unknownSize) may return where to continue. */
function children(bytes, start, end, fn, stopAtTop) {
  let pos = start;
  while (pos < end - 1) {
    const id = vint(bytes, pos, true);
    if (stopAtTop && TOP.has(id.value)) return pos;
    const size = vint(bytes, pos + id.len);
    const data = pos + id.len + size.len;
    const len = size.unknown ? end - data : Math.min(size.value, end - data);
    const next = fn(id.value, data, len, size.unknown);
    pos = next ?? data + len;
  }
  return pos;
}

/** WebCodecs codec string from the track's codec id and its avcC / hvcC record. */
function codecString(codecId, priv) {
  const hex = (n) => n.toString(16).padStart(2, "0");
  if (codecId === "V_MPEG4/ISO/AVC" && priv?.length > 3) return `avc1.${hex(priv[1])}${hex(priv[2])}${hex(priv[3])}`;
  if (codecId === "V_MPEGH/ISO/HEVC" && priv?.length > 12) {
    const b = priv[1], space = ["", "A", "B", "C"][b >> 6], tier = (b >> 5) & 1 ? "H" : "L", profile = b & 0x1f;
    let compat = 0;
    for (let i = 0; i < 4; i++) compat = (compat * 256) + priv[2 + i];
    let rev = 0; // the compatibility flags are written bit-reversed
    for (let i = 0; i < 32; i++) if (Math.floor(compat / 2 ** i) % 2) rev += 2 ** (31 - i);
    const cons = [...priv.subarray(6, 12)];
    while (cons.length && cons[cons.length - 1] === 0) cons.pop();
    return [`hvc1.${space}${profile}`, rev.toString(16), `${tier}${priv[12]}`, ...cons.map((c) => c.toString(16))].join(".");
  }
  if (codecId === "V_VP9") return "vp09.00.10.08";
  if (codecId === "V_VP8") return "vp8";
  if (codecId === "V_AV1") return "av01.0.08M.08";
  return null;
}

async function demuxMatroska(buf) {
  const bytes = new Uint8Array(buf);
  let scale = 1e6; // nanoseconds per timecode unit
  const tracks = [];
  const blocks = []; // { track, tc, key, data } in file (decode) order
  const readBlock = (pos, size, cluster, simple, keyHint) => {
    const tn = vint(bytes, pos);
    const rel = ((bytes[pos + tn.len] << 24) >> 16) | bytes[pos + tn.len + 1]; // signed 16-bit
    const flags = bytes[pos + tn.len + 2];
    if (flags & 0x06) return; // laced blocks are audio; not needed
    blocks.push({ track: tn.value, tc: cluster + rel, key: simple ? !!(flags & 0x80) : keyHint, data: bytes.subarray(pos + tn.len + 3, pos + size) });
  };
  const segment = (pos, end) => children(bytes, pos, end, (cid, cpos, csize, unknown) => {
    if (cid === ID.Info) children(bytes, cpos, cpos + csize, (iid, ipos, isize) => { if (iid === ID.TimecodeScale) scale = uint(bytes, ipos, isize); });
    else if (cid === ID.Tracks) children(bytes, cpos, cpos + csize, (tid, tpos, tsize) => {
      if (tid !== ID.TrackEntry) return;
      const t = {};
      children(bytes, tpos, tpos + tsize, (eid, epos, esize) => {
        if (eid === ID.TrackNumber) t.number = uint(bytes, epos, esize);
        else if (eid === ID.TrackType) t.type = uint(bytes, epos, esize);
        else if (eid === ID.CodecID) t.codec = str(bytes, epos, esize);
        else if (eid === ID.CodecPrivate) t.priv = bytes.slice(epos, epos + esize);
        else if (eid === ID.DefaultDuration) t.frameNs = uint(bytes, epos, esize);
        else if (eid === ID.Video) children(bytes, epos, epos + esize, (vid, vpos, vsize) => {
          if (vid === ID.PixelWidth) t.width = uint(bytes, vpos, vsize);
          if (vid === ID.PixelHeight) t.height = uint(bytes, vpos, vsize);
        });
      });
      tracks.push(t);
    });
    else if (cid === ID.Cluster) {
      let tc = 0;
      // A cluster of unknown size (live recording) runs until the next top-level element.
      return children(bytes, cpos, unknown ? end : cpos + csize, (bid, bpos, bsize) => {
        if (bid === ID.Timecode) tc = uint(bytes, bpos, bsize);
        else if (bid === ID.SimpleBlock) readBlock(bpos, bsize, tc, true);
        else if (bid === ID.BlockGroup) {
          let block = null, ref = false;
          children(bytes, bpos, bpos + bsize, (gid, gpos, gsize) => {
            if (gid === ID.Block) block = [gpos, gsize];
            if (gid === ID.ReferenceBlock) ref = true;
          });
          if (block) readBlock(block[0], block[1], tc, false, !ref);
        }
      }, unknown);
    }
  });
  children(bytes, 0, bytes.length, (id, pos, size) => { if (id === ID.Segment) segment(pos, Math.min(bytes.length, pos + size)); });

  const video = tracks.find((t) => t.type === 1);
  const codec = video && codecString(video.codec, video.priv);
  if (!codec) return null;
  const config = { codec, codedWidth: video.width, codedHeight: video.height, ...(video.priv && /AVC|HEVC|AV1/.test(video.codec) ? { description: video.priv } : {}) };
  const support = await VideoDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support.supported) return null;
  const mine = blocks.filter((b) => b.track === video.number);
  if (!mine.length) return null;
  // Presentation order gives each frame's duration (decode order differs when there are B-frames).
  const pts = [...new Set(mine.map((b) => b.tc))].sort((x, y) => x - y);
  const nextOf = new Map(pts.map((v, i) => [v, pts[i + 1]]));
  const toUs = (tc) => (tc * scale) / 1000;
  const frameUs = video.frameNs ? video.frameNs / 1000 : 16667;
  const t0 = toUs(pts[0]);
  return {
    config,
    samples: mine.map((b) => {
      const n = nextOf.get(b.tc);
      return { key: b.key, ts: toUs(b.tc) - t0, dur: n != null ? toUs(n) - toUs(b.tc) : frameUs, data: b.data };
    }),
  };
}
