// Text-to-speech worker: Kokoro-82M (Apache-2.0) via kokoro-js, fully on-device. The ~90 MB model
// downloads from Hugging Face on first use and is cached by the browser.
import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
let tts = null;

/** Splits long text into sentence-sized pieces the model handles well (it reads up to ~500 tokens at once). */
function pieces(text) {
  const parts = text.replace(/\s+/g, " ").match(/[^.!?…]+[.!?…]*["')\]]*\s*/g) || [text];
  const out = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + p).length > 300 && cur) { out.push(cur.trim()); cur = ""; }
    cur += p;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

self.onmessage = async ({ data }) => {
  const { id, text, voice, speed } = data;
  try {
    if (!tts) {
      self.postMessage({ id, type: "progress", stage: "download", progress: 0 });
      const files = new Map();
      tts = await KokoroTTS.from_pretrained(MODEL, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (p) => {
          if (p.status === "progress" && p.total) {
            files.set(p.file, [p.loaded, p.total]);
            const [l, t] = [...files.values()].reduce((a, [x, y]) => [a[0] + x, a[1] + y], [0, 0]);
            self.postMessage({ id, type: "progress", stage: "download", progress: (l / t) * 100 });
          }
        },
      });
    }
    const chunks = pieces(text);
    const parts = [];
    let rate = 24000;
    for (let i = 0; i < chunks.length; i++) {
      self.postMessage({ id, type: "progress", stage: "speak", progress: (i / chunks.length) * 100 });
      const audio = await tts.generate(chunks[i], { voice, speed });
      rate = audio.sampling_rate;
      parts.push(audio.audio);
      parts.push(new Float32Array(Math.round(rate * 0.18))); // short pause between pieces
    }
    const total = parts.reduce((a, p) => a + p.length, 0);
    const pcm = new Float32Array(total);
    let o = 0;
    for (const p of parts) { pcm.set(p, o); o += p.length; }
    self.postMessage({ id, type: "result", pcm, rate }, [pcm.buffer]);
  } catch (err) {
    self.postMessage({ id, type: "error", message: err?.message || String(err) });
  }
};
