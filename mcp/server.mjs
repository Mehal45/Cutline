#!/usr/bin/env node
// Cutline MCP server: lets an AI assistant build and edit Cutline projects (.cutline JSON), look at any frame,
// and export videos without the editor window (uses `Cutline --export`, see desktop/main.cjs).
//
// Coordinates: x / y / scale of clips and texts are fractions of the frame (0.5, 0.5 = centre). Times in seconds.
// Text sizes are 1920-wide pixels. Shadow / border sizes are 1080p pixels. Tilt in degrees.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_BIN = "/Applications/Cutline.app/Contents/MacOS/Cutline";

/** How to start Cutline headless: CUTLINE_BIN, else the installed app if it knows --export, else this repo's Electron. */
function cutlineCommand() {
  if (process.env.CUTLINE_BIN) return { cmd: process.env.CUTLINE_BIN, args: [] };
  try {
    const main = fs.readFileSync("/Applications/Cutline.app/Contents/Resources/app.asar", "latin1");
    if (main.includes("cutline:headless-job")) return { cmd: APP_BIN, args: [] };
  } catch { /* not installed or unreadable */ }
  const electron = path.join(REPO, "node_modules", ".bin", "electron");
  return { cmd: electron, args: [REPO] };
}

const uid = () => randomBytes(4).toString("hex");
const NO_ANIM = { in: { type: "none", dur: 0.4 }, out: { type: "none", dur: 0.4 } };
const abs = (p) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));

function load(file) {
  const data = JSON.parse(fs.readFileSync(abs(file), "utf8"));
  if (data.app !== "Cutline" || !data.project) throw new Error("Not a Cutline project: " + file);
  const p = data.project;
  for (const k of ["main", "texts", "overlays", "audio", "effects", "backgrounds"]) p[k] ??= [];
  p.media ??= {};
  return p;
}
function save(file, project) {
  const f = abs(file), tmp = f + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ app: "Cutline", version: 1, savedAt: new Date().toISOString(), project }));
  fs.renameSync(tmp, f);
}
const LISTS = ["main", "overlays", "texts", "audio", "effects", "backgrounds"];
function find(p, id) {
  for (const list of LISTS) {
    const i = p[list].findIndex((x) => x.id === id);
    if (i >= 0) return { list, i, item: p[list][i] };
  }
  return null;
}
/** Deep merge for plain objects; arrays and other values replace. null deletes the key. */
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v === null) delete out[k];
    else if (v && typeof v === "object" && !Array.isArray(v) && a?.[k] && typeof a[k] === "object" && !Array.isArray(a[k])) out[k] = merge(a[k], v);
    else out[k] = v;
  }
  return out;
}
const mainStarts = (p) => { let t = 0; return p.main.map((c) => { t += c.gap || 0; const s = t; t += c.dur / (c.speed || 1); return s; }); };
function duration(p) {
  const st = mainStarts(p);
  let d = p.main.length ? st.at(-1) + p.main.at(-1).dur / (p.main.at(-1).speed || 1) : 0;
  for (const l of ["texts", "overlays", "audio", "effects"]) for (const x of p[l]) d = Math.max(d, (x.start || 0) + (x.dur || 0));
  return d;
}
const ok = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) }] });

function probe(file) {
  const j = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", file], { encoding: "utf8" }));
  const v = j.streams.find((s) => s.codec_type === "video"), a = j.streams.find((s) => s.codec_type === "audio");
  const ext = path.extname(file).toLowerCase();
  const kind = /\.(png|jpe?g|webp|gif|bmp)$/.test(ext) ? "image" : v ? "video" : a ? "audio" : null;
  if (!kind) throw new Error("No picture or sound in " + file);
  return { kind, duration: kind === "image" ? 5 : +j.format.duration || 0, w: v?.width || 0, h: v?.height || 0 };
}

// ---------------- headless runs ----------------
const jobs = new Map();
function runCutline(projectFile, out, opts) {
  const { cmd, args } = cutlineCommand();
  const id = uid();
  const job = { id, out, status: "running", progress: 0, error: null, started: Date.now(), log: "" };
  jobs.set(id, job);
  job.done = new Promise((resolve) => {
    const ch = spawn(cmd, [...args, "--export", abs(projectFile), "--out", abs(out), "--opts", JSON.stringify(opts || {})], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    ch.stdout.on("data", (d) => {
      buf += d;
      let n;
      while ((n = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, n); buf = buf.slice(n + 1);
        if (line.startsWith("PROGRESS ")) job.progress = +line.slice(9);
        else if (line.startsWith("DONE ")) { job.status = "done"; job.progress = 1; }
        else if (line.startsWith("ERROR ")) { job.status = "error"; job.error = line.slice(6); }
      }
    });
    ch.stderr.on("data", (d) => { job.log = (job.log + d).slice(-4000); });
    ch.on("close", (code) => {
      if (job.status === "running") { job.status = code === 0 ? "done" : "error"; job.error ||= code === 0 ? null : `exited with ${code}: ${job.log.slice(-500)}`; }
      job.seconds = (Date.now() - job.started) / 1000;
      resolve(job);
    });
  });
  return job;
}

// ---------------- server ----------------
const server = new McpServer({ name: "cutline", version: "1.0.0" }, {
  instructions: "Build Cutline video projects as files: create_project, add_media, add_clip/add_text/add_audio/add_background, " +
    "then render_frame to check moments and export to make the MP4 (export runs in the background; poll export_status). " +
    "x/y/scale are fractions of the frame; times are seconds. open_in_cutline shows the project in the editor for the user.",
});
const P = z.string().describe("Path to the .cutline project file");
const any = z.record(z.any());

server.registerTool("create_project", {
  description: "Create an empty Cutline project file.",
  inputSchema: { project: P, width: z.number().default(1920), height: z.number().default(1080), fps: z.number().default(60), overwrite: z.boolean().default(false) },
}, async ({ project, width, height, fps, overwrite }) => {
  if (fs.existsSync(abs(project)) && !overwrite) throw new Error("File exists (pass overwrite: true): " + project);
  fs.mkdirSync(path.dirname(abs(project)), { recursive: true });
  save(project, { width, height, fps, media: {}, main: [], texts: [], overlays: [], audio: [], effects: [], backgrounds: [] });
  return ok({ project: abs(project), width, height, fps });
});

server.registerTool("add_media", {
  description: "Add a media file (video, image or audio) to the project's library. Returns its mediaId, kind, duration and size.",
  inputSchema: { project: P, file: z.string(), id: z.string().optional() },
}, async ({ project, file, id }) => {
  const p = load(project), f = abs(file);
  const existing = Object.values(p.media).find((m) => m.path === f);
  if (existing) return ok({ mediaId: existing.id, ...existing });
  const m = { id: id || "m" + uid(), name: path.basename(f), path: f, size: fs.statSync(f).size, ...probe(f) };
  p.media[m.id] = m;
  save(project, p);
  return ok({ mediaId: m.id, ...m });
});

const CLIP_PROPS = "Optional clip props: transform {x,y,scale,rotation}; crop {l,t,r,b} (0-1); mask {shape:'rect'|'circle'|..., x,y,w,h (0-1 of the clip frame), radius 0-1, feather %, invert}; " +
  "shadow {blur,x,y,color,opacity}; border {width,color}; tiltX/tiltY (deg) + perspective (px, default 2400); opacity; blend; cutout {mode:'person',feather}; " +
  "keyframes {prop:[{t,v,ease}]} with t from the clip start, props x,y,scale,rotation,opacity,tiltX,tiltY,volume,mask.x/y/w/h/radius,...; " +
  "ease: linear|easeInOut|easeIn|easeOut|smooth|backOut|hold; anim {in:{type,dur},out:{type,dur}}; transition {type,dur} (main only, into this clip); speed; audio {volume,fadeIn,fadeOut}; fx; adjust; filter.";

server.registerTool("add_clip", {
  description: "Add a video/image clip. track 'main' = the back-to-back main track (appended, or inserted at `index`); 'overlay' = a layer at `start` on overlay track `layer`. " + CLIP_PROPS,
  inputSchema: {
    project: P, mediaId: z.string(), track: z.enum(["main", "overlay"]).default("main"),
    in: z.number().default(0).describe("Source in-point (s)"), dur: z.number().describe("Length on the timeline (s)"),
    start: z.number().optional().describe("Overlay start (s)"), layer: z.number().default(0).describe("Overlay track number"),
    index: z.number().optional().describe("Main track position (default: end)"), props: any.optional(),
  },
}, async ({ project, mediaId, track, in: inPt, dur, start, layer, index, props }) => {
  const p = load(project);
  if (!p.media[mediaId]) throw new Error("Unknown mediaId " + mediaId);
  const base = { id: "c" + uid(), mediaId, in: inPt, dur, anim: NO_ANIM, transform: { x: 0.5, y: 0.5, scale: 1, rotation: 0 } };
  const item = merge(base, props || {});
  if (track === "main") { item.transition ??= null; p.main.splice(index ?? p.main.length, 0, item); }
  else { if (start == null) throw new Error("overlay clips need start"); p.overlays.push({ ...item, track: layer, start }); }
  save(project, p);
  const at = track === "main" ? mainStarts(p)[p.main.indexOf(item)] : start;
  return ok({ id: item.id, track, start: at, end: at + dur / (item.speed || 1) });
});

server.registerTool("add_text", {
  description: "Add a text (or shape) item. style {font,size,weight,color,stroke,strokeWidth,bg,bgPad,bgRadius,uppercase,letterSpacing,lineHeight,align,shadow,boxW}; " +
    "anim {in:{type:'fade'|'slideUp'|'slideDown'|'zoom'|'rise'|'softZoom'|'pop'|'typewriter'|'none',dur},out:{...}}; behind: true puts it behind the person in the main clip (person cutout). " +
    "keyframes like clips (x,y,scale,rotation,opacity). words [{w,t0,t1}] + caption:true for karaoke captions. shape {type,w,h,fill,stroke,strokeW,mode,radius} for shapes.",
  inputSchema: {
    project: P, text: z.string(), start: z.number(), dur: z.number(), x: z.number().default(0.5), y: z.number().default(0.5),
    scale: z.number().default(1), behind: z.boolean().default(false), style: any.optional(), anim: any.optional(), track: z.number().optional(), props: any.optional(),
  },
}, async ({ project, text, start, dur, x, y, scale, behind, style, anim, track, props }) => {
  const p = load(project);
  const item = merge({
    id: "t" + uid(), start, dur, text, x, y, scale, rotation: 0,
    style: { font: "Inter, Arial, sans-serif", size: 72, weight: 800, color: "#ffffff", stroke: "#000000", strokeWidth: 0, bg: "", highlight: "#ffd400", ...style },
    anim: anim || { in: { type: "fade", dur: 0.4 }, out: { type: "fade", dur: 0.4 } }, track: track ?? 0, ...(behind ? { behind: true } : {}),
  }, props || {});
  p.texts.push(item);
  save(project, p);
  return ok({ id: item.id });
});

server.registerTool("add_audio", {
  description: "Add an audio item (music, voice-over, sound effect) at `start`. audio {volume (1 = 100%), fadeIn, fadeOut}; keyframes.volume for ducking.",
  inputSchema: { project: P, mediaId: z.string(), start: z.number(), in: z.number().default(0), dur: z.number().optional(), track: z.number().default(0), audio: any.optional(), props: any.optional() },
}, async ({ project, mediaId, start, in: inPt, dur, track, audio, props }) => {
  const p = load(project), m = p.media[mediaId];
  if (!m) throw new Error("Unknown mediaId " + mediaId);
  const item = merge({ id: "a" + uid(), mediaId, track, start, in: inPt, dur: dur ?? Math.max(0.05, m.duration - inPt), audio: { volume: 1, ...audio } }, props || {});
  p.audio.push(item);
  save(project, p);
  return ok({ id: item.id, end: start + item.dur });
});

server.registerTool("add_background", {
  description: "Add an animated background shown behind the main track (visible wherever clips don't cover the frame, e.g. a scaled-down framed screen recording). " +
    "type 'glow' = dark base with soft drifting coloured lights (colors = lights, base = base colour); 'gradient' = linear gradient between colors at `angle`, turning slowly with speed.",
  inputSchema: {
    project: P, start: z.number().default(0), dur: z.number(), type: z.enum(["glow", "gradient"]).default("glow"), colors: z.array(z.string()).optional(),
    base: z.string().optional(), speed: z.number().default(1), intensity: z.number().default(1), angle: z.number().optional(),
  },
}, async ({ project, ...b }) => {
  const p = load(project);
  const item = { id: "b" + uid(), ...b };
  p.backgrounds.push(item);
  save(project, p);
  return ok({ id: item.id });
});

server.registerTool("add_effect", {
  description: "Add a whole-frame effect / adjustment layer for a time range: fx [{id,type,amount}], adjust {exposure,contrast,saturation,temperature,...}, filter {type,amount}.",
  inputSchema: { project: P, start: z.number(), dur: z.number(), track: z.number().default(0), props: any },
}, async ({ project, start, dur, track, props }) => {
  const p = load(project);
  const item = { id: "e" + uid(), track, start, dur, ...props };
  p.effects.push(item);
  save(project, p);
  return ok({ id: item.id });
});

server.registerTool("update_item", {
  description: "Change any item (clip, overlay, text, audio, effect, background) by id. `patch` is deep-merged (null deletes a key; arrays replace). Use replace_keyframes to swap whole keyframe lists.",
  inputSchema: { project: P, id: z.string(), patch: any },
}, async ({ project, id, patch }) => {
  const p = load(project), f = find(p, id);
  if (!f) throw new Error("No item " + id);
  p[f.list][f.i] = merge(f.item, patch);
  save(project, p);
  return ok({ id, list: f.list });
});

server.registerTool("remove_item", {
  description: "Delete an item by id.",
  inputSchema: { project: P, id: z.string() },
}, async ({ project, id }) => {
  const p = load(project), f = find(p, id);
  if (!f) throw new Error("No item " + id);
  p[f.list].splice(f.i, 1);
  save(project, p);
  return ok({ removed: id });
});

server.registerTool("add_keyframes", {
  description: "Add keyframes to an item: keys {prop: [{t, v, ease}]} with t in seconds from the item's start. Existing keys at the same times are replaced.",
  inputSchema: { project: P, id: z.string(), keys: z.record(z.array(z.object({ t: z.number(), v: z.number(), ease: z.string().optional() }))) },
}, async ({ project, id, keys }) => {
  const p = load(project), f = find(p, id);
  if (!f) throw new Error("No item " + id);
  const kf = { ...(f.item.keyframes || {}) };
  for (const [prop, list] of Object.entries(keys)) {
    const old = (kf[prop] || []).filter((k) => !list.some((n) => Math.abs(n.t - k.t) < 1e-3));
    kf[prop] = [...old, ...list.map((k) => ({ ease: "easeInOut", ...k }))].sort((a, b) => a.t - b.t);
  }
  p[f.list][f.i] = { ...f.item, keyframes: kf };
  save(project, p);
  return ok({ id, props: Object.keys(kf) });
});

/** Linear value of a keyframed prop at local time t (enough for placing new keys around a window). */
function valueNow(item, prop, t, base) {
  const ks = item.keyframes?.[prop];
  if (!ks?.length) return base;
  if (t <= ks[0].t) return ks[0].v;
  for (let i = 1; i < ks.length; i++) if (t <= ks[i].t) { const a = ks[i - 1], b = ks[i]; return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t || 1)); }
  return ks.at(-1).v;
}

server.registerTool("zoom_inside_frame", {
  description: "Smooth zoom into a point of a masked clip (e.g. a framed screen recording) while its frame/mask stays put on screen: " +
    "zooms in over `ramp` s starting at local time `at`, holds `hold` s, zooms back out. focusX/focusY = the point of the source picture (0-1) to bring to the frame centre.",
  inputSchema: {
    project: P, id: z.string(), at: z.number(), hold: z.number().default(2), ramp: z.number().default(0.9),
    zoom: z.number().default(1.3), focusX: z.number(), focusY: z.number(),
  },
}, async ({ project, id, at, hold, ramp, zoom, focusX, focusY }) => {
  const p = load(project), f = find(p, id);
  if (!f || !["main", "overlays"].includes(f.list)) throw new Error("No clip " + id);
  const it = f.item, med = p.media[it.mediaId], W = p.width, H = p.height;
  const fit = Math.min(W / med.w, H / med.h), fw = (med.w * fit) / W, fh = (med.h * fit) / H; // clip frame size in frame fractions at scale 1
  const tr = it.transform || { x: 0.5, y: 0.5, scale: 1 };
  const m = it.mask || { shape: "rect", x: 0.5, y: 0.5, w: 1, h: 1, radius: 0 };
  const t0 = at, t1 = at + ramp, t2 = t1 + hold, t3 = t2 + ramp;
  const s0 = valueNow(it, "scale", t0, tr.scale), x0 = valueNow(it, "x", t0, tr.x), y0 = valueNow(it, "y", t0, tr.y);
  const mx0 = valueNow(it, "mask.x", t0, m.x), my0 = valueNow(it, "mask.y", t0, m.y), mw0 = valueNow(it, "mask.w", t0, m.w), mh0 = valueNow(it, "mask.h", t0, m.h);
  // the mask's centre on screen stays where it is; the content scales by `zoom` around the focus point
  const cx = x0 + (mx0 - 0.5) * fw * s0, cy = y0 + (my0 - 0.5) * fh * s0;
  const s1 = s0 * zoom;
  let x1 = cx - (focusX - 0.5) * fw * s1, y1 = cy - (focusY - 0.5) * fh * s1;
  // keep the zoomed picture covering the mask: clamp so no empty edge shows inside the frame
  const halfMW = (mw0 * fw * s0) / 2, halfMH = (mh0 * fh * s0) / 2, halfW = (fw * s1) / 2, halfH = (fh * s1) / 2;
  x1 = Math.min(cx - halfMW + halfW, Math.max(cx + halfMW - halfW, x1));
  y1 = Math.min(cy - halfMH + halfH, Math.max(cy + halfMH - halfH, y1));
  const mx1 = 0.5 + (cx - x1) / (fw * s1), my1 = 0.5 + (cy - y1) / (fh * s1), mw1 = mw0 / zoom, mh1 = mh0 / zoom;
  const r = (v) => Math.round(v * 1e5) / 1e5;
  const keys = {
    scale: [[s0, s1]], x: [[x0, x1]], y: [[y0, y1]], "mask.x": [[mx0, mx1]], "mask.y": [[my0, my1]], "mask.w": [[mw0, mw1]], "mask.h": [[mh0, mh1]],
  };
  const kf = { ...(it.keyframes || {}) };
  for (const [prop, [[a, b]]] of Object.entries(keys)) {
    const old = (kf[prop] || []).filter((k) => k.t < t0 - 1e-3 || k.t > t3 + 1e-3);
    kf[prop] = [...old, { t: t0, v: r(a), ease: "easeInOut" }, { t: t1, v: r(b), ease: "easeInOut" }, { t: t2, v: r(b), ease: "easeInOut" }, { t: t3, v: r(a), ease: "easeInOut" }].sort((u, v) => u.t - v.t);
  }
  if (!it.mask) it.mask = m;
  p[f.list][f.i] = { ...it, keyframes: kf };
  save(project, p);
  return ok({ id, zoomIn: [t0, t1], hold: [t1, t2], zoomOut: [t2, t3] });
});

server.registerTool("get_project", {
  description: "Summary of the project: size, duration, media, and every item with id and timing (main clips with their computed start).",
  inputSchema: { project: P, full: z.boolean().default(false).describe("Return the whole JSON instead of a summary") },
}, async ({ project, full }) => {
  const p = load(project);
  if (full) return ok(p);
  const st = mainStarts(p);
  const short = (x) => Object.fromEntries(Object.entries(x).filter(([k]) => !["style", "keyframes", "words", "anim", "media"].includes(k)));
  return ok({
    width: p.width, height: p.height, fps: p.fps, duration: +duration(p).toFixed(3),
    media: Object.values(p.media).map((m) => ({ id: m.id, name: m.name, kind: m.kind, duration: m.duration, w: m.w, h: m.h })),
    main: p.main.map((c, i) => ({ ...short(c), start: +st[i].toFixed(3), keyframed: Object.keys(c.keyframes || {}) })),
    overlays: p.overlays.map((o) => ({ ...short(o), keyframed: Object.keys(o.keyframes || {}) })),
    texts: p.texts.map((t) => ({ id: t.id, text: t.text, start: t.start, dur: t.dur, x: t.x, y: t.y, behind: !!t.behind, track: t.track })),
    audio: p.audio.map(short), effects: p.effects.map(short), backgrounds: p.backgrounds,
  });
});

server.registerTool("render_frame", {
  description: "Render one frame of the project at `time` (seconds) exactly as the export would, and return it as an image so you can check it. Also saved as PNG at `out` if given.",
  inputSchema: { project: P, time: z.number(), out: z.string().optional(), width: z.number().default(960).describe("Width of the returned preview image") },
}, async ({ project, time, out, width }) => {
  const file = out ? abs(out) : path.join(os.tmpdir(), `cutline-frame-${uid()}.png`);
  const job = runCutline(project, file, { frame: time });
  await job.done;
  if (job.status !== "done") throw new Error(job.error || "frame render failed");
  const prev = path.join(os.tmpdir(), `cutline-prev-${uid()}.jpg`);
  execFileSync("sips", ["-s", "format", "jpeg", "-Z", String(width), file, "--out", prev], { stdio: "ignore" });
  const img = fs.readFileSync(prev).toString("base64");
  fs.rmSync(prev, { force: true });
  if (!out) fs.rmSync(file, { force: true });
  return { content: [{ type: "image", data: img, mimeType: "image/jpeg" }, { type: "text", text: `frame at ${time}s${out ? " saved to " + file : ""}` }] };
});

server.registerTool("export", {
  description: "Export the project to MP4 in the background (no window). Returns a jobId; poll export_status. " +
    "opts: fps, res (short side, e.g. 1080 / 1440 / 2160) or width+height, codec avc|hevc|av1|vp9, quality max|high|standard|small or customKbps, encoder hardware|software, smooth {method,blur}.",
  inputSchema: { project: P, out: z.string(), opts: any.optional() },
}, async ({ project, out, opts }) => {
  const job = runCutline(project, abs(out), opts || {});
  return ok({ jobId: job.id, out: abs(out) });
});

server.registerTool("export_status", {
  description: "Progress of an export job (status running|done|error, progress 0-1, seconds). wait: true waits until it finishes (up to `timeout` s).",
  inputSchema: { jobId: z.string(), wait: z.boolean().default(false), timeout: z.number().default(600) },
}, async ({ jobId, wait, timeout }) => {
  const job = jobs.get(jobId);
  if (!job) throw new Error("Unknown job " + jobId);
  if (wait && job.status === "running") await Promise.race([job.done, new Promise((r) => setTimeout(r, timeout * 1000))]);
  return ok({ jobId, status: job.status, progress: +job.progress.toFixed(3), out: job.out, error: job.error,
    seconds: +(job.seconds ?? (Date.now() - job.started) / 1000).toFixed(1) });
});

server.registerTool("open_in_cutline", {
  description: "Open the project in the Cutline editor so the user can see and change it.",
  inputSchema: { project: P },
}, async ({ project }) => {
  execFileSync("open", ["-a", "Cutline", abs(project)]);
  return ok("opened " + abs(project));
});

await server.connect(new StdioServerTransport());
