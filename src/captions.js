// Auto-captions: mix timeline audio at 16 kHz, run Whisper, group words into caption segments.
import { mixAudio } from "./export.js";
import { defaultTextStyle, uid } from "./store.js";

export const CAPTION_MODELS = {
  "Xenova/whisper-tiny.en": "English (tiny, ~40 MB, fastest)",
  "Xenova/whisper-base": "Multilingual (base, ~80 MB)",
};

let worker = null;

export async function transcribe(project, { model, language }, onProgress) {
  onProgress?.({ stage: "audio" });
  const mix = await mixAudio(project, 16000, 1);
  const audio = mix.getChannelData(0).slice();
  worker ??= new Worker(new URL("./whisper-worker.js", import.meta.url), { type: "module" });
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === "progress") onProgress?.(data);
      else if (data.type === "result") resolve(data.chunks);
      else if (data.type === "error") reject(new Error(data.message));
    };
    worker.postMessage({ audio, model, language }, [audio.buffer]);
  });
}

/** Turns Whisper word chunks into caption text segments of a few words each. */
export function wordsToCaptions(chunks, { maxWords = 5, maxGap = 0.6 } = {}) {
  const words = chunks
    .filter((c) => c.text?.trim() && c.timestamp?.[0] != null)
    .map((c) => ({ w: c.text, t0: c.timestamp[0], t1: c.timestamp[1] ?? c.timestamp[0] + 0.3 }));
  const groups = [];
  let cur = [];
  for (const w of words) {
    const last = cur[cur.length - 1];
    const breakHere = cur.length >= maxWords || (last && w.t0 - last.t1 > maxGap) || (last && /[.!?]$/.test(last.w.trim()));
    if (breakHere && cur.length) { groups.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups.map((g) => {
    g[0] = { ...g[0], w: g[0].w.trimStart() };
    const start = g[0].t0;
    const end = Math.max(g[g.length - 1].t1, start + 0.3);
    return {
      id: uid(),
      caption: true,
      start,
      dur: end - start,
      text: g.map((w) => w.w).join(""),
      words: g,
      x: 0.5,
      y: 0.82,
      scale: 1,
      style: { ...defaultTextStyle(), size: 64 },
      anim: { in: { type: "pop", dur: 0.2 }, out: { type: "none", dur: 0.2 } },
    };
  });
}
