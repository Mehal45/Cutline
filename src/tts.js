// Text-to-speech front end: runs the worker and drops the generated voice on an audio track at the playhead.
import { setState, getState } from "./store.js";
import { importFiles, toast } from "./actions.js";

export const TTS_VOICES = [
  ["af_heart", "Heart (US, female)"], ["af_bella", "Bella (US, female)"], ["af_nicole", "Nicole (US, female, soft)"],
  ["af_sarah", "Sarah (US, female)"], ["af_kore", "Kore (US, female)"], ["af_aoede", "Aoede (US, female)"],
  ["am_michael", "Michael (US, male)"], ["am_fenrir", "Fenrir (US, male)"], ["am_puck", "Puck (US, male)"],
  ["am_echo", "Echo (US, male)"], ["am_santa", "Santa (US, male)"],
  ["bf_emma", "Emma (UK, female)"], ["bf_isabella", "Isabella (UK, female)"], ["bm_george", "George (UK, male)"],
  ["bm_fable", "Fable (UK, male)"], ["bm_lewis", "Lewis (UK, male)"],
].map(([id, label]) => ({ id, label }));

let worker = null;
let status = "idle";
let seq = 0;
export const ttsStatus = () => status;

/** Mono float PCM → 16-bit WAV. */
function wav(pcm, rate) {
  const view = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); view.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, "data"); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([view.buffer], { type: "audio/wav" });
}

/** Generates speech and adds it to the timeline. Resolves when the clip is on an audio track. */
export function speak(text, { voice = "af_heart", speed = 1 } = {}) {
  worker ??= new Worker(new URL("./tts-worker.js", import.meta.url), { type: "module" });
  const id = ++seq;
  status = "loading";
  return new Promise((resolve, reject) => {
    const onMessage = async ({ data }) => {
      if (data.id !== id) return;
      if (data.type === "progress") {
        setState({ ttsStatus: data.stage === "download" ? `Downloading the voice model (first time only)… ${Math.round(data.progress)}%` : `Speaking… ${Math.round(data.progress)}%` });
        return;
      }
      worker.removeEventListener("message", onMessage);
      setState({ ttsStatus: null });
      if (data.type === "error") { status = "failed"; return reject(new Error(data.message)); }
      status = "ready";
      const name = `Voice - ${text.trim().slice(0, 28).replace(/[\/:*?"<>|]/g, "")}${text.length > 28 ? "…" : ""}.wav`;
      await importFiles([new File([wav(data.pcm, data.rate)], name, { type: "audio/wav" })]);
      toast("Voice-over added at the playhead");
      resolve();
    };
    worker.addEventListener("message", onMessage);
    worker.postMessage({ id, text, voice, speed });
  });
}

export const ttsBusy = () => !!getState().ttsStatus;
