// "My presets". Kinds: text (look of a text layer), adjust (an adjustment layer / timeline effect) and audio
// (volume, fades, cleanup and voice effect for clips and audio layers).
//
// Text presets: a saved look (style, position, size, rotation, opacity, animation, keyframes and
// length) that adds a ready-styled text layer in one click. Stored on this computer: in the desktop app in
// a file next to its settings (survives updates), in a browser in local storage.
import { getState, setState, edit, uid, freeTrack, findItem } from "./store.js";
import { toast, addText } from "./actions.js";

const KEY = "cutline.textPresets";
const desktop = typeof window !== "undefined" ? window.cutlineDesktop : null;

/** The parts of a text item a preset keeps. */
const LOOK = ["dur", "style", "x", "y", "scale", "rotation", "opacity", "anim", "keyframes"];

async function read() {
  try {
    if (desktop?.loadPrefs) {
      const prefs = await desktop.loadPrefs();
      if (Array.isArray(prefs?.textPresets)) return prefs.textPresets;
    }
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch { return []; }
}

async function write(list) {
  setState({ textPresets: list });
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage full or blocked */ }
  try { if (desktop?.savePrefs) await desktop.savePrefs({ ...(await desktop.loadPrefs()), textPresets: list }); } catch { /* not saved to file */ }
}

export async function loadTextPresets() {
  setState({ textPresets: await read() });
}

const kindOf = (p) => p.kind || "text";
export const allPresets = () => getState().textPresets || [];
export const textPresets = () => allPresets().filter((p) => kindOf(p) === "text");
export const presetsOf = (kind) => allPresets().filter((p) => kindOf(p) === kind);
export const defaultPreset = () => textPresets().find((p) => p.isDefault) || null;

/** Saves a text item's look as a new preset (or overwrites one with the same name). */
export async function saveTextPreset(item, name) {
  await savePreset("text", item, name, LOOK, { sample: item.text.slice(0, 40) });
}

const ADJUST_LOOK = ["dur", "fx", "filter", "adjust", "opacity", "keyframes", "name"];
const AUDIO_KEYS = ["volume", "fadeIn", "fadeOut", "denoise", "enhance", "normalize", "voice"];

/** Saves (or overwrites, by name within its kind) a preset of `kind` from an item. */
async function savePreset(kind, item, name, keys, extra = {}) {
  name = (name || "").trim() || "My preset";
  const look = Object.fromEntries(keys.filter((k) => item[k] !== undefined).map((k) => [k, structuredClone(item[k])]));
  const old = allPresets().find((p) => kindOf(p) === kind && p.name === name);
  const list = allPresets().filter((p) => p !== old);
  list.push({ id: old?.id || uid(), kind, name, isDefault: old?.isDefault || false, ...extra, look });
  await write(list);
  toast(`Saved ${kind === "adjust" ? "adjustment" : kind} preset “${name}”`);
}

/** Adjustment layer: its effects, filter, colour adjustments, mix and length. */
export const saveAdjustPreset = (item, name) => savePreset("adjust", item, name, ADJUST_LOOK);

/** Audio settings of a clip, layer or audio item (not its timing). */
export async function saveAudioPreset(item, name) {
  const audio = Object.fromEntries(AUDIO_KEYS.filter((k) => item.audio?.[k] !== undefined).map((k) => [k, item.audio[k]]));
  await savePreset("audio", { audio }, name, ["audio"]);
}

/** Adds an adjustment layer at the playhead with a preset's settings. */
export function addAdjustFromPreset(preset) {
  const { time } = getState();
  const id = uid();
  const look = structuredClone(preset.look);
  const dur = look.dur || 3;
  edit((p) => p.effects.push({ id, track: freeTrack(p.effects, time, dur), start: time, dur, fx: [], ...look, name: preset.name }));
  setState({ selection: [{ kind: "effect", id }] });
}

/** Applies an audio preset to the selected clips, layers and audio items. */
export function applyAudioPreset(preset) {
  const targets = getState().selection.filter((s) => ["main", "overlay", "audio"].includes(s.kind));
  if (!targets.length) return toast("Select a clip or audio layer first");
  edit((p) => targets.forEach((t) => {
    const it = findItem(p, t.kind, t.id);
    if (!it) return;
    it.audio = { ...structuredClone(preset.look.audio || {}) };
    if (it.keyframes?.volume) delete it.keyframes.volume; // the preset's volume replaces any volume animation
  }));
  toast(`Applied “${preset.name}” to ${targets.length} item${targets.length > 1 ? "s" : ""}`);
}

export async function deleteTextPreset(id) {
  await write(allPresets().filter((p) => p.id !== id));
}

export async function renameTextPreset(id, name) {
  await write(allPresets().map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)));
}

/** Marks one text preset as the one "Add text" (and the T key) uses; click again to unmark. */
export async function toggleDefaultPreset(id) {
  await write(allPresets().map((p) => (kindOf(p) !== "text" ? p : { ...p, isDefault: p.id === id ? !p.isDefault : false })));
}

/** Adds a text layer at the playhead with a preset's look, selected and ready to type. */
export function addTextFromPreset(preset, text) {
  const { time } = getState();
  const id = uid();
  const look = structuredClone(preset.look);
  edit((p) => p.texts.push({
    id, start: time, dur: 3, text: text ?? "Your text", x: 0.5, y: 0.5, scale: 1, rotation: 0,
    anim: { in: { type: "fade", dur: 0.4 }, out: { type: "fade", dur: 0.4 } },
    ...look,
    style: { ...look.style },
  }));
  setState({ selection: [{ kind: "text", id }] });
  return id;
}

/** "Add text": uses the preset marked as default, if any, otherwise the plain default text. */
export function addDefaultText() {
  const p = defaultPreset();
  if (p) return addTextFromPreset(p);
  addText();
}

/** Gives the selected texts a preset's look (their words and timing stay). */
export function applyPresetToSelection(preset) {
  const ids = new Set(getState().selection.filter((s) => s.kind === "text").map((s) => s.id));
  if (!ids.size) return toast("Select a text first");
  const look = preset.look;
  edit((p) => p.texts.forEach((t) => {
    if (!ids.has(t.id)) return;
    for (const k of ["style", "x", "y", "scale", "rotation", "opacity", "anim", "keyframes"]) {
      if (look[k] !== undefined) t[k] = structuredClone(look[k]);
      else if (k === "keyframes") delete t.keyframes;
    }
  }));
  toast(`Applied “${preset.name}” to ${ids.size} text${ids.size > 1 ? "s" : ""}`);
}
