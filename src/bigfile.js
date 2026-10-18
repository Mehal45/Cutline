// Big recordings (several GB, e.g. long OBS sessions) are read a piece at a time instead of loading the whole
// file into memory: the file is indexed once (where every frame and audio packet is), and frames are read from
// disk when they're needed. Works for MKV/WebM and MP4/MOV, for both the picture and the sound.
import { createFile } from "mp4box";

const WINDOW = 16 * 1024 * 1024;

/** Random access to a media file's bytes: a File/Blob in memory, or a file on disk through the local server. */
export async function byteSource(media) {
  const f = media.file;
  if (f instanceof Blob) {
    return { size: f.size, read: async (a, b) => new Uint8Array(await f.slice(a, b).arrayBuffer()) };
  }
  const url = media.url;
  const read = async (a, b) => {
    const r = await fetch(url, { headers: { Range: `bytes=${a}-${b - 1}` } });
    if (!r.ok) throw new Error("can't read " + media.name);
    return new Uint8Array(await r.arrayBuffer());
  };
  let size = f?.size || media.size;
  if (!size) {
    const r = await fetch(url, { headers: { Range: "bytes=0-0" } });
    size = +((r.headers.get("Content-Range") || "").split("/")[1] || 0);
    await r.arrayBuffer().catch(() => {});
  }
  return { size, read };
}

/** Small reads served from a moving 16 MB window (the file is mostly walked front to back). */
class Reader {
  constructor(src) { this.src = src; this.at = -1; this.buf = null; }
  async bytes(pos, n) {
    n = Math.min(n, this.src.size - pos);
    if (!this.buf || pos < this.at || pos + n > this.at + this.buf.length) {
      this.at = pos;
      this.buf = await this.src.read(pos, Math.min(this.src.size, pos + Math.max(WINDOW, n)));
    }
    return this.buf.subarray(pos - this.at, pos - this.at + n);
  }
}

// ---------------- Matroska ----------------

const ID = {
  Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Tracks: 0x1654ae6b, TrackEntry: 0xae,
  TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2, Video: 0xe0, PixelWidth: 0xb0,
  PixelHeight: 0xba, DefaultDuration: 0x23e383, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, ReferenceBlock: 0xfb,
};
const TOP = new Set([ID.Cluster, 0x1c53bb6b, 0x1254c367, 0x1043a770, 0x1941a469, 0x114d9b74, ID.Info, ID.Tracks]);

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
const uint = (b) => { let v = 0; for (let i = 0; i < b.length; i++) v = v * 256 + b[i]; return v; };
const str = (b) => String.fromCharCode(...b).replace(/\0+$/, "");
const float = (b) => { const dv = new DataView(b.buffer, b.byteOffset, b.byteLength); return b.length === 4 ? dv.getFloat32(0) : dv.getFloat64(0); };

async function walk(r, start, end, fn, stopAtTop) {
  let pos = start;
  while (pos < end - 1) {
    const h = await r.bytes(pos, Math.min(16, end - pos));
    if (h.length < 2) break;
    const id = vint(h, 0, true);
    if (stopAtTop && TOP.has(id.value)) return pos;
    const size = vint(h, id.len);
    const data = pos + id.len + size.len;
    const len = size.unknown ? end - data : Math.min(size.value, end - data);
    const next = await fn(id.value, data, len, size.unknown);
    pos = next ?? data + len;
  }
  return pos;
}

/** Indexes an MKV/WebM file: tracks plus every block's position (no frame data is kept). */
export async function indexMatroska(src) {
  const r = new Reader(src);
  let scale = 1e6;
  const tracks = [];
  const blocks = [];
  const block = async (pos, size, tc, simple, keyHint) => {
    const h = await r.bytes(pos, 12);
    const tn = vint(h, 0);
    const rel = ((h[tn.len] << 24) >> 16) | h[tn.len + 1];
    const flags = h[tn.len + 2];
    if (flags & 0x06) return; // laced blocks aren't supported here
    const start = pos + tn.len + 3;
    blocks.push({ track: tn.value, tc: tc + rel, key: simple ? !!(flags & 0x80) : keyHint, offset: start, size: pos + size - start });
  };
  const segment = (pos, end) => walk(r, pos, end, async (cid, cpos, csize, unknown) => {
    if (cid === ID.Info) await walk(r, cpos, cpos + csize, async (iid, ipos, isize) => { if (iid === ID.TimecodeScale) scale = uint(await r.bytes(ipos, isize)); });
    else if (cid === ID.Tracks) await walk(r, cpos, cpos + csize, async (tid, tpos, tsize) => {
      if (tid !== ID.TrackEntry) return;
      const t = {};
      await walk(r, tpos, tpos + tsize, async (eid, epos, esize) => {
        if (eid === ID.TrackNumber) t.number = uint(await r.bytes(epos, esize));
        else if (eid === ID.TrackType) t.type = uint(await r.bytes(epos, esize));
        else if (eid === ID.CodecID) t.codec = str(await r.bytes(epos, esize));
        else if (eid === ID.CodecPrivate) t.priv = (await r.bytes(epos, esize)).slice();
        else if (eid === ID.DefaultDuration) t.frameNs = uint(await r.bytes(epos, esize));
        else if (eid === ID.Video) await walk(r, epos, epos + esize, async (vid, vpos, vsize) => {
          if (vid === ID.PixelWidth) t.width = uint(await r.bytes(vpos, vsize));
          if (vid === ID.PixelHeight) t.height = uint(await r.bytes(vpos, vsize));
        });
        else if (eid === ID.Audio) await walk(r, epos, epos + esize, async (aid, apos, asize) => {
          if (aid === ID.SamplingFrequency) t.rate = float(await r.bytes(apos, asize));
          if (aid === ID.Channels) t.channels = uint(await r.bytes(apos, asize));
        });
      });
      tracks.push(t);
    });
    else if (cid === ID.Cluster) {
      let tc = 0;
      return walk(r, cpos, unknown ? end : cpos + csize, async (bid, bpos, bsize) => {
        if (bid === ID.Timecode) tc = uint(await r.bytes(bpos, bsize));
        else if (bid === ID.SimpleBlock) await block(bpos, bsize, tc, true);
        else if (bid === ID.BlockGroup) {
          let b = null, ref = false;
          await walk(r, bpos, bpos + bsize, async (gid, gpos, gsize) => {
            if (gid === ID.Block) b = [gpos, gsize];
            if (gid === ID.ReferenceBlock) ref = true;
          });
          if (b) await block(b[0], b[1], tc, false, !ref);
        }
      }, unknown);
    }
  });
  await walk(r, 0, src.size, async (id, pos, size) => { if (id === ID.Segment) await segment(pos, Math.min(src.size, pos + size)); });
  const toUs = (tc) => (tc * scale) / 1000;
  return { tracks, blocks, toUs };
}

/** Samples of one track in decode order: { key, ts, dur, offset, size } with ts in µs from the first frame. */
export function mkvSamples(index, track, firstUs) {
  const mine = index.blocks.filter((b) => b.track === track.number);
  const pts = [...new Set(mine.map((b) => b.tc))].sort((x, y) => x - y);
  const nextOf = new Map(pts.map((v, i) => [v, pts[i + 1]]));
  const frameUs = track.frameNs ? track.frameNs / 1000 : 0;
  const t0 = firstUs ?? index.toUs(pts[0] ?? 0);
  return mine.map((b) => {
    const n = nextOf.get(b.tc);
    return { key: b.key, ts: index.toUs(b.tc) - t0, dur: n != null ? index.toUs(n) - index.toUs(b.tc) : frameUs || 16667, offset: b.offset, size: b.size };
  });
}

// ---------------- MP4 / MOV ----------------

/** Indexes an MP4/MOV by reading only its header boxes (the media data is skipped). */
export async function indexMp4(src) {
  const mp4 = createFile();
  let info = null, failed = null;
  mp4.onReady = (i) => (info = i);
  mp4.onError = (e) => (failed = e);
  let pos = 0;
  while (!info && !failed && pos < src.size) {
    const chunk = await src.read(pos, Math.min(src.size, pos + 4 * 1024 * 1024));
    const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
    ab.fileStart = pos;
    const next = mp4.appendBuffer(ab);
    pos = next > pos ? next : pos + chunk.byteLength;
  }
  if (!info) return null;
  return { mp4, info };
}

/** Samples of an MP4 track (needs its moov sample tables; fragmented files return []). */
export function mp4Samples(index, trackId) {
  const trak = index.mp4.getTrackById(trackId);
  return (trak?.samples || []).map((s) => ({
    key: s.is_sync, ts: (s.cts * 1e6) / s.timescale, dur: (s.duration * 1e6) / s.timescale, offset: s.offset, size: s.size,
  }));
}

// ---------------- reading frames ----------------

/** Fills in `.data` for samples[from..to) with one read per stretch of the file. */
export async function loadData(src, samples, from, to) {
  let i = from;
  while (i < to) {
    // Group samples that sit close together into one read (up to ~8 MB).
    let j = i + 1;
    while (j < to && samples[j].offset >= samples[j - 1].offset && samples[j].offset + samples[j].size - samples[i].offset < 8 * 1024 * 1024) j++;
    const start = samples[i].offset, end = Math.max(...samples.slice(i, j).map((s) => s.offset + s.size));
    const bytes = await src.read(start, end);
    for (let k = i; k < j; k++) samples[k].data = bytes.subarray(samples[k].offset - start, samples[k].offset - start + samples[k].size);
    i = j;
  }
}

/** Frees frame data that has been sent to the decoder. */
export function dropData(samples, from, to) {
  for (let k = from; k < to; k++) if (samples[k].offset != null) samples[k].data = undefined;
}

// ---------------- sound ----------------

/** WebCodecs audio config for a track, or null. */
function audioConfig(codec, priv, rate, channels) {
  if (codec === "A_AAC" || codec === "mp4a") return { codec: "mp4a.40.2", sampleRate: rate, numberOfChannels: channels, ...(priv ? { description: priv } : {}) };
  if (codec === "A_OPUS" || codec === "opus") return { codec: "opus", sampleRate: rate, numberOfChannels: channels, ...(priv ? { description: priv } : {}) };
  return null;
}

/** The audio track of a big file, decoded into an AudioBuffer a piece at a time. Null if there's no usable sound. */
export async function decodeBigAudio(media) {
  const src = await byteSource(media);
  let samples, config;
  if (/\.(mkv|webm)$/i.test(media.name)) {
    const index = await indexMatroska(src);
    const t = index.tracks.find((x) => x.type === 2);
    if (!t) return null;
    config = audioConfig(t.codec, t.priv, t.rate || 48000, t.channels || 2);
    const v = index.tracks.find((x) => x.type === 1);
    const vFirst = v ? Math.min(...index.blocks.filter((b) => b.track === v.number).map((b) => b.tc)) : undefined;
    samples = mkvSamples(index, t, vFirst != null && isFinite(vFirst) ? index.toUs(vFirst) : undefined);
  } else {
    const index = await indexMp4(src);
    const t = index?.info.audioTracks[0];
    if (!t) return null;
    const entry = index.mp4.getTrackById(t.id).mdia.minf.stbl.stsd.entries[0];
    const dsi = entry?.esds?.esd?.descs?.[0]?.descs?.[0]?.data;
    config = audioConfig(t.codec.startsWith("mp4a") ? "mp4a" : t.codec, dsi ? new Uint8Array(dsi) : null, t.audio.sample_rate, t.audio.channel_count);
    samples = mp4Samples(index, t.id);
  }
  if (!config || !samples.length) return null;
  if (!(await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }))).supported) return null;
  const rate = config.sampleRate, channels = config.numberOfChannels;
  const last = samples.reduce((m, s) => Math.max(m, s.ts + s.dur), 0);
  const length = Math.max(1, Math.ceil((last / 1e6) * rate));
  const out = Array.from({ length: channels }, () => new Float32Array(length));
  let error = null;
  const dec = new AudioDecoder({
    output: (d) => {
      const at = Math.round((d.timestamp / 1e6) * rate);
      for (let c = 0; c < Math.min(channels, d.numberOfChannels); c++) {
        const tmp = new Float32Array(d.numberOfFrames);
        d.copyTo(tmp, { planeIndex: c, format: "f32-planar" });
        if (at >= 0) out[c].set(tmp.subarray(0, Math.max(0, Math.min(tmp.length, length - at))), at);
      }
      d.close();
    },
    error: (e) => (error = e),
  });
  dec.configure(config);
  const BATCH = 400;
  for (let i = 0; i < samples.length; i += BATCH) {
    const to = Math.min(samples.length, i + BATCH);
    await loadData(src, samples, i, to);
    for (let k = i; k < to; k++) {
      const s = samples[k];
      if (s.ts < 0) continue;
      dec.decode(new EncodedAudioChunk({ type: "key", timestamp: s.ts, duration: s.dur, data: s.data }));
    }
    dropData(samples, i, to);
    while (dec.decodeQueueSize > 200) await new Promise((r) => setTimeout(r, 5));
    if (error) throw error;
  }
  await dec.flush();
  dec.close();
  const buf = new AudioBuffer({ length, numberOfChannels: channels, sampleRate: rate });
  out.forEach((data, c) => buf.copyToChannel(data, c));
  return buf;
}
