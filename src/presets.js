// "My presets" for text: a saved look (style, position, size, rotation, opacity, animation, keyframes and
// length) that adds a ready-styled text layer in one click. Stored on this computer: in the desktop app in
// a file next to its settings (survives updates), in a browser in local storage.
import { getState, setState, edit, uid } from "./store.js";
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

export const textPresets = () => getState().textPresets || [];
export const defaultPreset = () => textPresets().find((p) => p.isDefault) || null;

/** Saves a text item's look as a new preset (or overwrites one with the same name). */
export async function saveTextPreset(item, name) {
  name = (name || "").trim() || "My preset";
  const look = Object.fromEntries(LOOK.filter((k) => item[k] !== undefined).map((k) => [k, structuredClone(item[k])]));
  const list = textPresets().filter((p) => p.name !== name);
  const old = textPresets().find((p) => p.name === name);
  list.push({ id: old?.id || uid(), name, sample: item.text.slice(0, 40), isDefault: old?.isDefault || false, look });
  await write(list);
  toast(`Saved text preset “${name}”`);
}

export async function deleteTextPreset(id) {
  await write(textPresets().filter((p) => p.id !== id));
}

export async function renameTextPreset(id, name) {
  await write(textPresets().map((p) => (p.id === id ? { ...p, name: name.trim() || p.name } : p)));
}

/** Marks one preset as the one "Add text" (and the T key) uses; click again to unmark. */
export async function toggleDefaultPreset(id) {
  await write(textPresets().map((p) => ({ ...p, isDefault: p.id === id ? !p.isDefault : false })));
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
