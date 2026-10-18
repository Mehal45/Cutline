// Scans a big MKV/WebM recording once, front to back (the fastest way to read a hard drive), and saves:
//  - an index of every video frame (where it is in the file, its time, keyframe or not)
//  - the sound track's packets (a few MB), so the sound never needs the big file again
// Results live in <userData>/scan/<hash of path+size+date>/ and are reused by later exports and sessions.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CHUNK = 8 * 1024 * 1024;
const ID = {
  Segment: 0x18538067, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Tracks: 0x1654ae6b, TrackEntry: 0xae,
  TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63a2, Video: 0xe0, PixelWidth: 0xb0,
  PixelHeight: 0xba, DefaultDuration: 0x23e383, Audio: 0xe1, SamplingFrequency: 0xb5, Channels: 0x9f,
  Cluster: 0x1f43b675, Timecode: 0xe7, SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, ReferenceBlock: 0xfb,
};
const TOP = new Set([ID.Cluster, 0x1c53bb6b, 0x1254c367, 0x1043a770, 0x1941a469, 0x114d9b74, ID.Info, ID.Tracks]);

/** Sequential reader over a file descriptor with an 8 MB window. */
class Reader {
  constructor(fd, size) { this.fd = fd; this.size = size; this.at = 0; this.buf = Buffer.alloc(0); }
  bytes(pos, n) {
    n = Math.min(n, this.size - pos);
    if (n <= 0) return Buffer.alloc(0);
    if (pos < this.at || pos + n > this.at + this.buf.length) {
      const len = Math.min(this.size - pos, Math.max(CHUNK, n));
      const buf = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) { const r = fs.readSync(this.fd, buf, got, len - got, pos + got); if (!r) break; got += r; }
      this.buf = buf.subarray(0, got); this.at = pos;
    }
    return this.buf.subarray(pos - this.at, pos - this.at + n);
  }
}

function vint(b, p, keep) {
  const first = b[p];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { len++; mask >>= 1; }
  if (len > 8) throw new Error("bad EBML");
  let v = keep ? first : first & (mask - 1), ones = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xff) ones = false; }
  return { value: v, len, unknown: !keep && ones };
}
const uint = (b) => { let v = 0; for (const x of b) v = v * 256 + x; return v; };
const float = (b) => (b.length === 4 ? b.readFloatBE(0) : b.readDoubleBE(0));

function walk(r, start, end, fn, stopAtTop) {
  let pos = start;
  while (pos < end - 1) {
    const h = r.bytes(pos, 16);
    if (h.length < 2) break;
    const id = vint(h, 0, true);
    if (stopAtTop && TOP.has(id.value)) return pos;
    const size = vint(h, id.len);
    const data = pos + id.len + size.len;
    const len = size.unknown ? end - data : Math.min(size.value, end - data);
    const next = fn(id.value, data, len, size.unknown);
    pos = next ?? data + len;
  }
  return pos;
}

function scanFile(src, outDir, onProgress) {
  const fd = fs.openSync(src, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const r = new Reader(fd, size);
    let scale = 1e6;
    const tracks = [];
    const video = []; // [offset, size, tc, key]
    const audio = []; // [tc, size]
    const audioParts = [];
    let audioTrack = null, videoTrack = null, lastReport = 0;
    const block = (pos, bsize, tc, simple, keyHint) => {
      const h = r.bytes(pos, 12);
      const tn = vint(h, 0);
      const rel = h.readInt16BE(tn.len);
      const flags = h[tn.len + 2];
      if (flags & 0x06) return; // laced
      const start = pos + tn.len + 3, n = pos + bsize - start, t = tc + rel;
      if (videoTrack && tn.value === videoTrack.number) video.push([start, n, t, simple ? (flags & 0x80 ? 1 : 0) : keyHint ? 1 : 0]);
      else if (audioTrack && tn.value === audioTrack.number) { audioParts.push(Buffer.from(r.bytes(start, n))); audio.push([t, n]); }
    };
    const pickTracks = () => {
      videoTrack = tracks.find((t) => t.type === 1) || null;
      audioTrack = tracks.find((t) => t.type === 2) || null;
    };
    const segment = (pos, end) => walk(r, pos, end, (cid, cpos, csize, unknown) => {
      if (cid === ID.Info) walk(r, cpos, cpos + csize, (iid, ipos, isize) => { if (iid === ID.TimecodeScale) scale = uint(r.bytes(ipos, isize)); });
      else if (cid === ID.Tracks) {
        walk(r, cpos, cpos + csize, (tid, tpos, tsize) => {
          if (tid !== ID.TrackEntry) return;
          const t = {};
          walk(r, tpos, tpos + tsize, (eid, epos, esize) => {
            const b = r.bytes(epos, esize);
            if (eid === ID.TrackNumber) t.number = uint(b);
            else if (eid === ID.TrackType) t.type = uint(b);
            else if (eid === ID.CodecID) t.codec = b.toString("latin1").replace(/\0+$/, "");
            else if (eid === ID.CodecPrivate) t.priv = Buffer.from(b).toString("base64");
            else if (eid === ID.DefaultDuration) t.frameNs = uint(b);
            else if (eid === ID.Video) walk(r, epos, epos + esize, (vid, vpos, vsize) => {
              if (vid === ID.PixelWidth) t.width = uint(r.bytes(vpos, vsize));
              if (vid === ID.PixelHeight) t.height = uint(r.bytes(vpos, vsize));
            });
            else if (eid === ID.Audio) walk(r, epos, epos + esize, (aid, apos, asize) => {
              if (aid === ID.SamplingFrequency) t.rate = float(Buffer.from(r.bytes(apos, asize)));
              if (aid === ID.Channels) t.channels = uint(r.bytes(apos, asize));
            });
          });
          tracks.push(t);
        });
        pickTracks();
      } else if (cid === ID.Cluster) {
        let tc = 0;
        if (onProgress && cpos - lastReport > 64 * 1024 * 1024) { lastReport = cpos; onProgress(cpos / size); }
        return walk(r, cpos, unknown ? end : cpos + csize, (bid, bpos, bsize) => {
          if (bid === ID.Timecode) tc = uint(r.bytes(bpos, bsize));
          else if (bid === ID.SimpleBlock) block(bpos, bsize, tc, true);
          else if (bid === ID.BlockGroup) {
            let b = null, ref = false;
            walk(r, bpos, bpos + bsize, (gid, gpos, gsize) => {
              if (gid === ID.Block) b = [gpos, gsize];
              if (gid === ID.ReferenceBlock) ref = true;
            });
            if (b) block(b[0], b[1], tc, false, !ref);
          }
        }, unknown);
      }
    });
    walk(r, 0, size, (id, pos, sz) => { if (id === ID.Segment) segment(pos, Math.min(size, pos + sz)); });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "audio.bin"), Buffer.concat(audioParts));
    const index = { version: 1, scale, video: videoTrack, audio: audioTrack, frames: video, packets: audio };
    fs.writeFileSync(path.join(outDir, "index.json.part"), JSON.stringify(index));
    fs.renameSync(path.join(outDir, "index.json.part"), path.join(outDir, "index.json"));
    return index;
  } finally {
    fs.closeSync(fd);
  }
}

const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");

// Worker side: scan, report progress, send the result.
if (!isMainThread && workerData?.scan) {
  try {
    const index = scanFile(workerData.src, workerData.dir, (p) => parentPort.postMessage({ progress: p }));
    parentPort.postMessage({ done: true, frames: index.frames.length });
  } catch (e) {
    parentPort.postMessage({ error: String(e && e.message || e) });
  }
}

const running = new Map(); // src -> Promise

/** Folder for one recording's scan, and whether it's done. */
function slot(userData, src) {
  const st = fs.statSync(src);
  const key = crypto.createHash("sha1").update(`${src}|${st.size}|${st.mtimeMs}`).digest("hex").slice(0, 20);
  const dir = path.join(userData, "scan", key);
  return { dir, done: fs.existsSync(path.join(dir, "index.json")) };
}

const load = (dir) => ({ index: JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8")), audioPath: path.join(dir, "audio.bin") });

/**
 * The scan of `src`: cached, or run now on a worker thread (the app stays responsive).
 * Resolves to { index, audioPath }. onProgress(0..1) while scanning.
 */
function getScan(userData, src, onProgress) {
  const s = slot(userData, src);
  if (s.done) return Promise.resolve(load(s.dir));
  if (!running.has(src)) {
    const p = new Promise((resolve, reject) => {
      const w = new Worker(__filename, { workerData: { scan: true, src, dir: s.dir } });
      w.on("message", (m) => {
        if (m.progress != null) onProgress?.(m.progress);
        else if (m.done) resolve(load(s.dir));
        else if (m.error) reject(new Error(m.error));
      });
      w.on("error", reject);
      w.on("exit", (code) => code && reject(new Error("scan stopped")));
    }).finally(() => running.delete(src));
    running.set(src, p);
  }
  return running.get(src);
}

module.exports = { getScan, scanFile };
