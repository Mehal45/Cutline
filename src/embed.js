// Cutline inside Flodit (opened as index.html?embed=flodit in a frame on the same site). Flodit sends the
// clips, or a whole AI edit as a project, and its chat can change the open project; the exported video goes
// back to Flodit. Nothing here runs when Cutline is opened on its own.
import { edit, getState, setState } from "./store.js";
import { importFiles, toast } from "./actions.js";
import { loadProject, relink } from "./project-io.js";
import { CAPTION_MODELS, transcribe, wordsToCaptions } from "./captions.js";

export const embedded = new URLSearchParams(location.search).get("embed") === "flodit" && window.parent !== window;

const post = (msg) => parent.postMessage(msg, location.origin);

/** The timeline lists the chat may change; media stays as it is. */
const LISTS = ["main", "texts", "overlays", "audio", "effects"];

/** The open project without its files: what Flodit's chat reads and edits. */
export function plainProject() {
  const p = getState().project;
  const media = Object.fromEntries(Object.values(p.media).map((m) => [m.id, { id: m.id, name: m.name, kind: m.kind, duration: m.duration, w: m.w, h: m.h }]));
  const { media: _, ...rest } = p;
  return { ...structuredClone(rest), media };
}

/** Swaps in the chat's changed lists, as one undo step. Anything pointing at media that isn't there is dropped. */
export function applyLists(next) {
  const p = getState().project;
  const known = (x) => !x.mediaId || p.media[x.mediaId];
  edit((d) => {
    for (const k of LISTS) if (Array.isArray(next[k])) d[k] = next[k].filter(known);
    for (const k of ["width", "height", "fps"]) if (Number.isFinite(next[k]) && next[k] > 0) d[k] = next[k];
  });
  setState({ selection: [] });
}

/** Captions from the speech, the same way the Captions button makes them (on this computer, Whisper). */
async function autoCaptions() {
  const project = getState().project;
  if (!project.main.length && !project.audio.length && !project.overlays.length) return;
  toast("Writing captions from the speech… (the first time downloads a small model)", 4000);
  const chunks = await transcribe(project, { model: Object.keys(CAPTION_MODELS)[0], language: "english" });
  const caps = wordsToCaptions(chunks);
  if (caps.length) edit((p) => { p.texts = p.texts.filter((t) => !t.caption).concat(caps); });
  toast(caps.length ? `Added ${caps.length} captions` : "No speech found for captions", 3000);
}

/** The exported video goes to Flodit. */
export function sendExport(blob) {
  if (embedded) post({ type: "cutline:exported", blob });
}

if (embedded) {
  addEventListener("message", async (e) => {
    if (e.origin !== location.origin || e.source !== parent) return;
    const m = e.data || {};
    try {
      if (m.type === "cutline:open") {
        if (m.project) {
          const missing = await loadProject(JSON.stringify(m.project));
          if (missing.length && m.files?.length) relink(m.files);
        } else if (m.files?.length) {
          await importFiles(m.files, { addToTimeline: true });
        }
        post({ type: "cutline:opened", id: m.id });
      } else if (m.type === "cutline:get") {
        const { time, selection } = getState();
        post({ type: "cutline:project", id: m.id, project: plainProject(), time, selection: selection.map(({ kind, id }) => ({ kind, id })) });
      } else if (m.type === "cutline:files") {
        // Which file each video in the project is, so Flodit can clean up its voice.
        const media = Object.values(getState().project.media).filter((x) => x.kind === "video" && x.file);
        post({ type: "cutline:files", id: m.id, files: media.map((x) => ({ mediaId: x.id, name: x.name, file: x.file, duration: x.duration })) });
      } else if (m.type === "cutline:replace-media") {
        // A new version of a file (the voice cleaned up): every clip using it stays where it is.
        const blob = await (await fetch(m.src)).blob();
        const p = getState().project;
        const old = p.media[m.mediaId];
        if (old) {
          const file = new File([blob], old.name, { type: blob.type || "video/mp4" });
          setState({ project: { ...p, media: { ...p.media, [old.id]: { ...old, file, url: URL.createObjectURL(file) } } } });
          if (m.note) toast(m.note, 3000);
        }
        post({ type: "cutline:replaced", id: m.id });
      } else if (m.type === "cutline:apply") {
        if (Object.keys(m.lists || {}).length) applyLists(m.lists);
        if (m.note) toast(m.note, 3000);
        if (m.actions?.includes("captions")) await autoCaptions();
        post({ type: "cutline:applied", id: m.id });
      }
    } catch (err) {
      post({ type: "cutline:error", id: m.id, message: err?.message || String(err) });
    }
  });
}

/**
 * Where the Chat tab's body is (Flodit draws its chat there), kept up to date as panels resize; null when
 * another tab is open. Returns a stop function.
 */
export function reportChatSlot(el) {
  if (!embedded) return () => {};
  if (!el) {
    post({ type: "cutline:chat-slot", rect: null });
    return () => {};
  }
  const send = () => {
    const r = el.getBoundingClientRect();
    post({ type: "cutline:chat-slot", rect: { x: r.left, y: r.top, width: r.width, height: r.height } });
  };
  const ro = new ResizeObserver(send);
  ro.observe(el);
  addEventListener("resize", send);
  send();
  return () => {
    ro.disconnect();
    removeEventListener("resize", send);
  };
}

if (embedded) setState({ floditChat: true });

/** Called once the editor is on screen. */
export function announceReady() {
  if (embedded) post({ type: "cutline:ready" });
}
