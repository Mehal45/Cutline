// Runs Whisper in a worker so the UI stays responsive.
// In: { audio: Float32Array (16 kHz mono), model, language }  Out: progress / result / error messages.
import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1";

env.allowLocalModels = false;
const pipes = new Map();

self.onmessage = async ({ data }) => {
  const { audio, model, language } = data;
  try {
    if (!pipes.has(model)) {
      pipes.set(model, await pipeline("automatic-speech-recognition", model, {
        progress_callback: (p) => {
          if (p.status === "progress") self.postMessage({ type: "progress", stage: "download", file: p.file, progress: p.progress });
        },
      }));
    }
    self.postMessage({ type: "progress", stage: "transcribe" });
    const asr = pipes.get(model);
    const base = { chunk_length_s: 30, stride_length_s: 5 };
    if (language && !model.endsWith(".en")) Object.assign(base, { language, task: "transcribe" });
    let chunks;
    try {
      chunks = (await asr(audio, { ...base, return_timestamps: "word" })).chunks;
    } catch {
      // Some model builds lack the attention outputs needed for word timing:
      // fall back to sentence timestamps and spread words evenly inside each sentence.
      const out = await asr(audio, { ...base, return_timestamps: true });
      chunks = (out.chunks || []).flatMap(({ text, timestamp: [s, e] }) => {
        const words = text.trim().split(/\s+/).filter(Boolean);
        const end = e ?? s + words.length * 0.35;
        const step = (end - s) / Math.max(1, words.length);
        return words.map((w, i) => ({ text: " " + w, timestamp: [s + i * step, s + (i + 1) * step] }));
      });
    }
    self.postMessage({ type: "result", chunks: chunks || [] });
  } catch (err) {
    self.postMessage({ type: "error", message: String(err?.message || err) });
  }
};
