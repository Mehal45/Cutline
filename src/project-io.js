// Saving and opening projects (.cutline files).
//
// A project file is JSON: the timeline plus a list of media. Media that came from disk is stored by its
// path (desktop app) or name (browser); media Cutline made itself (freeze frames, voice-overs) is embedded.
import { getState, setState, projectDuration } from "./store.js";
import { toast } from "./actions.js";
import { rootProject, resetCompounds } from "./compound.js";

export const desktop = typeof window !== "undefined" ? window.cutlineDesktop : null;
const EMBED_LIMIT = 40e6; // bytes

let savedSnapshot = null; // the project object at the last save/open (identity check = "no changes")
let currentPath = null;

// While a compound clip is open the project counts as changed (its edits are written back on save).
export const isDirty = () => { const p = rootProject(); return p !== savedSnapshot && hasContent(p); };
const hasContent = (p) => p.main.length || p.texts.length || p.overlays?.length || p.audio?.length || p.effects?.length;
export const projectName = () => (currentPath ? currentPath.split(/[\\/]/).pop().replace(/\.cutline$/i, "") : "Untitled");

function toBase64(buf) {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Serialises the project. */
export async function serialize(project = rootProject()) {
  const media = {};
  for (const m of Object.values(project.media)) {
    const entry = { id: m.id, name: m.name, kind: m.kind, duration: m.duration, w: m.w, h: m.h, size: m.file?.size };
    if (m.kind === "compound") entry.sequence = m.sequence;
    else if (m.path) entry.path = m.path;
    else if (m.file && m.file.size <= EMBED_LIMIT && m.file instanceof Blob) {
      entry.data = `data:${m.file.type || "application/octet-stream"};base64,` + toBase64(await m.file.arrayBuffer());
    }
    media[m.id] = entry;
  }
  const { media: _, ...rest } = project;
  return JSON.stringify({ app: "Cutline", version: 1, savedAt: new Date().toISOString(), project: { ...rest, media } });
}

/** A File-like object that reads a desktop file through the app's local server on demand. */
function diskFile(m) {
  const url = desktop.fileUrl(m.path);
  return { url, file: { name: m.name, size: m.size, type: "", arrayBuffer: () => fetch(url).then((r) => { if (!r.ok) throw new Error("missing"); return r.arrayBuffer(); }) } };
}

/** Turns saved media back into usable media. Returns the ones that still need relinking (browser). */
async function restoreMedia(saved) {
  const media = {};
  const missing = [];
  for (const m of Object.values(saved)) {
    if (m.kind === "compound") {
      media[m.id] = { ...m, url: "" };
    } else if (m.data) {
      const blob = await (await fetch(m.data)).blob();
      const file = new File([blob], m.name, { type: blob.type });
      media[m.id] = { ...m, data: undefined, file, url: URL.createObjectURL(file) };
    } else if (m.path && desktop) {
      const ok = await desktop.exists(m.path);
      if (ok) media[m.id] = { ...m, ...diskFile(m) };
      else { media[m.id] = { ...m, missing: true, url: "" }; missing.push(m); }
    } else {
      media[m.id] = { ...m, missing: true, url: "" };
      missing.push(m);
    }
  }
  return { media, missing };
}

/** Loads a project from file text. */
export async function loadProject(text, path = null) {
  const data = JSON.parse(text);
  if (data.app !== "Cutline" || !data.project) throw new Error("This isn't a Cutline project file.");
  const { media, missing } = await restoreMedia(data.project.media || {});
  const project = { overlays: [], audio: [], effects: [], ...data.project, media };
  resetCompounds();
  setState({ project, selection: [], time: 0, playing: false, canUndo: false, canRedo: false, relink: missing.length ? missing : null });
  savedSnapshot = project;
  currentPath = path;
  desktop?.setTitle(projectName());
  setState({ home: false });
  if (path) rememberRecent(path, 2500);
  return missing;
}

/** Points missing media at files the user picked (matched by name). */
export function relink(files) {
  const { project } = getState();
  const media = { ...project.media };
  let n = 0;
  for (const f of files) {
    const m = Object.values(media).find((x) => x.missing && x.name === f.name) || Object.values(media).find((x) => x.missing && x.name.toLowerCase() === f.name.toLowerCase());
    if (!m) continue;
    const path = desktop?.pathFor(f);
    media[m.id] = { ...m, missing: false, file: f, url: URL.createObjectURL(f), ...(path ? { path } : {}) };
    n++;
  }
  const still = Object.values(media).filter((m) => m.missing);
  setState({ project: { ...project, media }, relink: still.length ? still : null });
  return n;
}

export async function saveProject({ saveAs = false } = {}) {
  const json = await serialize();
  if (desktop) {
    const path = await desktop.saveProject(json, saveAs ? null : currentPath, projectName());
    if (!path) return false;
    currentPath = path;
    desktop.setTitle(projectName());
    desktop.clearAutosave();
    rememberRecent(path, 0);
  } else {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    a.download = projectName() + ".cutline";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  savedSnapshot = rootProject();
  setState({ autoSavedAt: Date.now() });
  toast("Project saved");
  return true;
}

export async function openProject(file) {
  if (isDirty() && !confirm("Discard unsaved changes to the current project?")) return;
  try {
    if (desktop && !file) {
      const res = await desktop.openProject();
      if (!res) return;
      await loadProject(res.text, res.path);
    } else if (file) {
      await loadProject(await file.text());
    }
    const missing = getState().relink;
    toast(missing ? `Opened — ${missing.length} media file${missing.length > 1 ? "s" : ""} need relinking` : "Project opened");
  } catch (err) {
    toast("Couldn't open: " + err.message);
  }
}

/** Opens a project Explorer handed to the desktop app ({ path, text }). */
export async function openFromDisk(f) {
  if (!f) return;
  if (isDirty() && !confirm("Discard unsaved changes to the current project?")) return;
  try {
    const missing = await loadProject(f.text, f.path);
    toast(missing.length ? `Opened — ${missing.length} media file${missing.length > 1 ? "s" : ""} need relinking` : "Project opened");
  } catch (err) {
    toast("Couldn't open: " + err.message);
  }
}

export function newProject() {
  if (isDirty() && !confirm("Discard unsaved changes to the current project?")) return;
  const project = { width: 1920, height: 1080, fps: 30, media: {}, main: [], texts: [], overlays: [], audio: [], effects: [] };
  resetCompounds();
  setState({ project, selection: [], time: 0, playing: false, canUndo: false, canRedo: false, relink: null });
  savedSnapshot = project;
  currentPath = null;
  desktop?.setTitle(projectName());
  setState({ home: false });
}

// ---------------- recent projects (desktop) ----------------

export const currentProjectPath = () => currentPath;

/** Puts a project at the top of the recent list, then saves a small picture of the preview with it. */
function rememberRecent(path, thumbDelay) {
  if (!desktop?.recentAdd) return;
  const name = path.split(/[\\/]/).pop().replace(/\.cutline$/i, "");
  desktop.recentAdd({ path, name, dur: projectDuration(rootProject()) });
  setTimeout(() => {
    const thumb = previewThumb();
    if (thumb && currentPath === path) desktop.recentAdd({ path, thumb, keepOrder: true });
  }, thumbDelay);
}

/** A 320-px JPEG of the preview canvas, or null if it's blank. */
function previewThumb() {
  const src = document.querySelector(".player .stage canvas");
  if (!src || !src.width) return null;
  const c = document.createElement("canvas");
  c.width = 320; c.height = Math.round((320 * src.height) / src.width);
  const g = c.getContext("2d");
  g.drawImage(src, 0, 0, c.width, c.height);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 64) sum += px[i] + px[i + 1] + px[i + 2];
  if (sum / (px.length / 64) < 12) return null; // all black: nothing drawn yet
  return c.toDataURL("image/jpeg", 0.72);
}

/** Opens a project from its path (recent list). */
export async function openRecent(path) {
  const f = await desktop?.openPath?.(path);
  if (!f) { toast("That project file can't be found any more"); return false; }
  await openFromDisk(f);
  return true;
}

// ---------------- autosave & recovery (desktop) ----------------

let lastAuto = null;
export function startAutosave() {
  if (!desktop) return;
  setInterval(async () => {
    const p = rootProject();
    if (p === lastAuto || !hasContent(p) || !isDirty()) return;
    lastAuto = p;
    try { await desktop.autosave(await serialize(p)); setState({ autoSavedAt: Date.now() }); } catch { /* ignore */ }
  }, 20000);
  window.addEventListener("beforeunload", (e) => {
    if (isDirty()) { e.preventDefault(); e.returnValue = ""; }
  });
}

export async function checkRecovery() {
  if (!desktop) return null;
  return desktop.recover();
}

/** Media files dropped into the app keep their path in the desktop app (so projects can find them again). */
export const pathOf = (file) => desktop?.pathFor(file) || null;
