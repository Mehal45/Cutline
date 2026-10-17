// Timeline filmstrip thumbnails. Frames are grabbed on demand from a hidden <video> per file, cached as
// small canvases, and requested newest-first so the tiles you are looking at load before anything else.

const H = 72; // cached frame height in pixels (drawn smaller on the timeline)
const entries = new Map(); // mediaId -> { q, frames: Map<bucket, canvas>, wanted: bucket[], video, busy }
const listeners = new Set();
let notifyTimer = null;

/** Subscribe to "more frames are ready" (throttled). Returns an unsubscribe function. */
export function onThumbs(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => { notifyTimer = null; listeners.forEach((f) => f()); }, 120);
}

function entryFor(media) {
  let e = entries.get(media.id);
  if (!e) {
    // Frame spacing: fine for short clips, coarser for long ones (at most ~800 cached frames per file).
    const q = Math.max(0.1, (media.duration || 1) / 800);
    e = { q, frames: new Map(), wanted: [], video: null, busy: false, failed: false };
    entries.set(media.id, e);
  }
  return e;
}

function pump(media, e) {
  if (e.busy || e.failed || !e.wanted.length || !media.url) return;
  e.busy = true;
  if (!e.video) {
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.playsInline = true;
    v.crossOrigin = "anonymous";
    v.src = media.url;
    v.addEventListener("error", () => { e.failed = true; e.busy = false; }, { once: true });
    e.video = v;
  }
  const v = e.video;
  const bucket = e.wanted.pop(); // newest request first
  const grab = () => {
    try {
      const w = Math.max(1, Math.round((H * (v.videoWidth || 16)) / (v.videoHeight || 9)));
      const c = document.createElement("canvas");
      c.width = w; c.height = H;
      c.getContext("2d").drawImage(v, 0, 0, w, H);
      e.frames.set(bucket, c);
      notify();
    } catch { /* frame not drawable */ }
    e.busy = false;
    pump(media, e);
  };
  const go = () => {
    const t = Math.min(Math.max(0, bucket * e.q), Math.max(0, (v.duration || media.duration) - 0.05));
    if (Math.abs(v.currentTime - t) < 1e-3 && v.readyState >= 2) { grab(); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; v.removeEventListener("seeked", finish); grab(); };
    v.addEventListener("seeked", finish);
    v.currentTime = t;
    setTimeout(finish, 1500); // never stall the queue on one bad frame
  };
  if (v.readyState >= 1) go();
  else v.addEventListener("loadedmetadata", go, { once: true });
}

/**
 * The best frame available for source time t: the exact one if cached, otherwise the nearest cached
 * neighbour (and the exact one is requested). Returns a canvas or null.
 */
export function frameFor(media, t) {
  const e = entryFor(media);
  const b = Math.max(0, Math.round(t / e.q));
  const hit = e.frames.get(b);
  if (hit) return hit;
  if (!e.wanted.includes(b)) {
    e.wanted.push(b);
    if (e.wanted.length > 120) e.wanted.shift(); // forget stale requests (scrolled away)
  }
  pump(media, e);
  for (let d = 1; d < 40; d++) {
    const n = e.frames.get(b - d) || e.frames.get(b + d);
    if (n) return n;
  }
  return null;
}

/** Drops cached frames for a file (e.g. when it is relinked). */
export function forgetThumbs(mediaId) {
  const e = entries.get(mediaId);
  if (e?.video) e.video.src = "";
  entries.delete(mediaId);
}
