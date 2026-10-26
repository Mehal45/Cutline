// App settings (Menu › Settings): where projects are saved, autosave, export defaults, encoder, preview and
// timeline defaults. Desktop: stored in prefs.json next to the app's other settings (survives updates);
// browser: local storage.
import { getState, setState } from "./store.js";

const desktop = typeof window !== "undefined" ? window.cutlineDesktop : null;
const KEY = "cutline.settings";

export const DEFAULTS = {
  projectsDir: "", // "" = Documents › Cutline Projects
  autosaveSec: 20, // 0 = only when closing
  startScreen: "home", // "home" | "last" (open the last project)
  exportRes: "project", // "project" or a short side in px (1080, 720…)
  exportFps: "project",
  exportCodec: "avc",
  exportQuality: "high",
  exportKbps: 40000, // custom bitrate
  encoder: "auto", // "auto" | "hardware" | "software"
  exportDir: "", // "" = ask / Downloads
  askExportPath: true,
  imageDur: 5,
  textDur: 3,
  gpu: true, // graphics acceleration for the whole app (restart needed)
  autoUpdate: true, // look for a new version when the app opens
};

export const settings = () => ({ ...DEFAULTS, ...(getState().settings || {}) });
export const setting = (k) => settings()[k];

export async function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { /* ignore */ }
  try { if (desktop?.loadPrefs) s = { ...s, ...((await desktop.loadPrefs())?.settings || {}) }; } catch { /* ignore */ }
  setState({ settings: s });
  return settings();
}

export async function setSetting(k, v) {
  const s = { ...(getState().settings || {}), [k]: v };
  setState({ settings: s });
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
  try { if (desktop?.savePrefs) await desktop.savePrefs({ ...(await desktop.loadPrefs()), settings: s }); } catch { /* ignore */ }
}

// Last used durations (transitions, in / out animations): new ones start with what you used last.
const DUR_KEY = "cutline.lastDurations";
export function lastDur(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(DUR_KEY) || "{}")[key]; return typeof v === "number" ? v : fallback; } catch { return fallback; }
}
export function rememberDur(key, v) {
  try { const o = JSON.parse(localStorage.getItem(DUR_KEY) || "{}"); o[key] = v; localStorage.setItem(DUR_KEY, JSON.stringify(o)); } catch { /* ignore */ }
}
