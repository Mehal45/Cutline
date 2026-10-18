// Saved elements: a clip or layer saved with all its settings (green-screen key, background removal, crop,
// position and size, effects, filter, colour, speed, volume, animations, keyframes, blend mode, trim) so it can
// be dropped into any project ready to go. Stored with the other presets (kind "element"); the file is found
// again by its place on this computer, and brought into the library when it isn't there yet.
import { getState, setState, edit, uid, freeTrack, findItem, layoutMain } from "./store.js";
import { toast, importPaths } from "./actions.js";
import { drawFrame } from "./engine.js";
import { allPresets, presetsOf, savePresetList } from "./presets.js";

/** Settings an element keeps (everything except where it sits on the timeline). */
const DROP = ["id", "start", "track", "transition", "mediaId"];

export const elements = () => presetsOf("element");

/** A small picture of the item as it looks now (key and cutout applied), for the Elements tab. */
function thumbnail(project, kind, item) {
  try {
    const t = getState().time;
    const start = kind === "main" ? layoutMain(project).find((s) => s.id === item.id)?.start ?? 0 : item.start;
    const at = t >= start && t < start + item.dur ? t - start : Math.min(0.5, item.dur / 2);
    const solo = { ...project, main: [], texts: [], audio: [], effects: [], trackState: undefined,
      overlays: [{ ...item, start: 0, track: 0, transform: { ...(item.transform || {}), x: 0.5, y: 0.5, scale: 1, rotation: 0 }, anim: undefined }] };
    const c = new OffscreenCanvas(192, 108);
    drawFrame(c.getContext("2d"), solo, at, { nested: true });
    const out = document.createElement("canvas");
    out.width = 192; out.height = 108;
    out.getContext("2d").drawImage(c, 0, 0);
    return out.toDataURL("image/png");
  } catch { return null; }
}

/** Saves the clip or layer `id` as an element named `name`. */
export async function saveElement(kind, id, name) {
  const p = getState().project;
  const item = findItem(p, kind, id);
  const media = item && p.media[item.mediaId];
  if (!media) return;
  if (media.kind === "compound") return toast("Compound clips can't be saved as elements yet. Save the clips inside them instead");
  if (!media.path && window.cutlineDesktop) return toast("This clip wasn't opened from a file on this computer, so it can't be saved as an element");
  const settings = Object.fromEntries(Object.entries(structuredClone(item)).filter(([k]) => !DROP.includes(k)));
  name = (name || "").trim() || media.name.replace(/\.[^.]+$/, "");
  const old = allPresets().find((x) => x.kind === "element" && x.name === name);
  const entry = {
    id: old?.id || uid(), kind: "element", name,
    look: {
      lane: kind === "main" ? "main" : "overlay",
      item: settings,
      media: { name: media.name, path: media.path || null, kind: media.kind, size: media.file?.size ?? media.size ?? null },
      thumb: thumbnail(p, kind, item),
    },
  };
  await writeAll([...allPresets().filter((x) => x !== old), entry]);
  toast(`Saved element “${name}” — find it in the Elements tab`);
}

const writeAll = (list) => savePresetList(list);

/** Main-track position nearest to time t (between clips). */
function mainIndexAt(project, t) {
  let start = 0, index = 0;
  for (const s of project.main) {
    if (start + s.dur / 2 < t) index++;
    start += s.dur;
  }
  return index;
}

/** The element's file in this project's library, imported from its place on disk when needed. */
async function mediaFor(el) {
  const m = el.look.media;
  const lib = Object.values(getState().project.media);
  let found = lib.find((x) => m.path && x.path === m.path) || lib.find((x) => !x.missing && x.name === m.name && (m.size == null || (x.file?.size ?? x.size) === m.size));
  if (!found && m.path && window.cutlineDesktop) {
    const { added } = await importPaths([m.path]);
    found = getState().project.media[added[0]];
  }
  return found || null;
}

/**
 * Adds an element to the timeline: by default where it was saved from (a layer at the playhead, or the main
 * track), or `where` = "overlay" | "main". `opts.time` / `opts.track` / `opts.index` place it (drag and drop).
 */
export async function addElement(el, where, opts = {}) {
  const media = await mediaFor(el);
  if (!media) return toast(`“${el.look.media.name}” wasn't found on this computer. It may have been moved or renamed`, 6000);
  where ??= el.look.lane;
  const id = uid();
  const base = { ...structuredClone(el.look.item), id, mediaId: media.id };
  // The saved trim must fit the file (it may have been replaced by a shorter one).
  if (media.kind !== "image" && media.duration) {
    base.in = Math.min(base.in || 0, Math.max(0, media.duration - 0.1));
    const sp = base.speed || 1;
    base.dur = Math.max(0.1, Math.min(base.dur, (media.duration - base.in) / sp));
  }
  if (where === "main") {
    edit((p) => {
      const at = opts.index ?? (layoutMain(p).length ? mainIndexAt(p, getState().time) : 0);
      p.main.splice(Math.max(0, Math.min(p.main.length, at)), 0, { ...base, transition: null });
    });
    setState({ selection: [{ kind: "main", id }] });
  } else {
    const start = Math.max(0, opts.time ?? getState().time);
    edit((p) => {
      const busy = (tr) => p.overlays.some((x) => (x.track ?? 0) === tr && x.start < start + base.dur && x.start + x.dur > start);
      const track = opts.track != null && !busy(opts.track) ? opts.track : freeTrack(p.overlays, start, base.dur);
      p.overlays.push({ ...base, start, track, transform: base.transform || { x: 0.5, y: 0.5, scale: 1, rotation: 0 } });
    });
    setState({ selection: [{ kind: "overlay", id }] });
  }
  toast(`Added “${el.name}”`);
}
