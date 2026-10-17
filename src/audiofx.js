// Audio settings for clips, layers and audio items: volume (keyframable), fades, one-switch voice
// cleanup and voice effects. The same node graph is built for the live preview and for export.
//
// item.audio = { volume, fadeIn, fadeOut, denoise, enhance, normalize, voice }

export const VOICE_EFFECTS = {
  none: "None",
  chipmunk: "Chipmunk",
  deep: "Deep voice",
  monster: "Monster",
  robot: "Robot",
  alien: "Alien",
  telephone: "Telephone",
  radio: "Old radio",
  megaphone: "Megaphone",
  echo: "Echo",
  hall: "Concert hall",
  cave: "Cave",
  underwater: "Underwater",
  vibrato: "Vibrato",
};

const WORKLET = new URL("./voice-worklet.js", import.meta.url).href;
const loaded = new WeakMap(); // ctx -> Promise

/** Loads the worklet processors into a context (once). Must finish before buildChain uses them. */
export function prepareContext(ctx) {
  if (!loaded.has(ctx)) loaded.set(ctx, ctx.audioWorklet.addModule(WORKLET).catch((e) => { console.warn("Voice effects unavailable:", e); }));
  return loaded.get(ctx);
}

/** True when an item's audio needs processing beyond plain volume. */
export const needsChain = (au) => !!au && (au.denoise || au.enhance || (au.voice && au.voice !== "none"));

const curveCache = new Map();
function softClip(k) {
  if (!curveCache.has(k)) {
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = ((1 + k) * x) / (1 + k * Math.abs(x)); }
    curveCache.set(k, c);
  }
  return curveCache.get(k);
}

function impulse(ctx, seconds, decay) {
  const len = Math.round(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

const filter = (ctx, type, freq, q = 0.7, gain = 0) => {
  const f = ctx.createBiquadFilter();
  f.type = type; f.frequency.value = freq; f.Q.value = q; f.gain.value = gain;
  return f;
};

/** Connects nodes in series; returns [first, last]. */
function series(...nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return [nodes[0], nodes[nodes.length - 1]];
}

/** Dry + wet mix around a send: returns [input, output]. */
function wetDry(ctx, wetIn, wetOut, wet, dry = 1) {
  const input = ctx.createGain(), output = ctx.createGain();
  const d = ctx.createGain(); d.gain.value = dry;
  const w = ctx.createGain(); w.gain.value = wet;
  input.connect(d).connect(output);
  input.connect(wetIn); wetOut.connect(w).connect(output);
  return [input, output];
}

function pitch(ctx, semitones) {
  const node = new AudioWorkletNode(ctx, "cutline-pitch", { outputChannelCount: [2] });
  node.parameters.get("ratio").value = Math.pow(2, semitones / 12);
  return node;
}

function ringMod(ctx, freq) {
  const g = ctx.createGain(); g.gain.value = 0;
  const osc = ctx.createOscillator(); osc.frequency.value = freq; osc.start();
  osc.connect(g.gain);
  return g;
}

function vibrato(ctx, rate, depth) {
  const delay = ctx.createDelay(0.05); delay.delayTime.value = 0.008;
  const lfo = ctx.createOscillator(); lfo.frequency.value = rate;
  const amt = ctx.createGain(); amt.gain.value = depth;
  lfo.connect(amt).connect(delay.delayTime); lfo.start();
  return delay;
}

function echo(ctx, time, feedback, tone = 4000) {
  const delay = ctx.createDelay(2); delay.delayTime.value = time;
  const fb = ctx.createGain(); fb.gain.value = feedback;
  const lp = filter(ctx, "lowpass", tone);
  delay.connect(lp).connect(fb).connect(delay);
  return [delay, lp];
}

function voiceEffect(ctx, type) {
  switch (type) {
    case "chipmunk": { const p = pitch(ctx, 7); return [p, p]; }
    case "deep": { const p = pitch(ctx, -5); return [p, p]; }
    case "monster": {
      const p = pitch(ctx, -9);
      const ws = ctx.createWaveShaper(); ws.curve = softClip(3);
      return series(p, filter(ctx, "lowshelf", 200, 0.7, 6), ws);
    }
    case "robot": {
      const rm = ringMod(ctx, 55);
      const [ein, eout] = echo(ctx, 0.012, 0.45, 8000);
      const [i, o] = wetDry(ctx, ein, eout, 0.6, 1);
      rm.connect(i);
      return [rm, o];
    }
    case "alien": {
      const p = pitch(ctx, 5);
      const rm = ringMod(ctx, 28);
      const [i, o] = wetDry(ctx, rm, rm, 0.5, 0.7);
      p.connect(i);
      return [p, o];
    }
    case "telephone": {
      const ws = ctx.createWaveShaper(); ws.curve = softClip(4);
      return series(filter(ctx, "highpass", 400), filter(ctx, "lowpass", 3200), ws);
    }
    case "radio": {
      const ws = ctx.createWaveShaper(); ws.curve = softClip(8);
      return series(filter(ctx, "highpass", 300), filter(ctx, "peaking", 1500, 1, 6), filter(ctx, "lowpass", 4500), ws);
    }
    case "megaphone": {
      const ws = ctx.createWaveShaper(); ws.curve = softClip(30);
      const out = ctx.createGain(); out.gain.value = 0.6;
      return series(filter(ctx, "highpass", 700), filter(ctx, "peaking", 2000, 1, 8), filter(ctx, "lowpass", 3800), ws, out);
    }
    case "echo": { const [ein, eout] = echo(ctx, 0.32, 0.42); return wetDry(ctx, ein, eout, 0.55); }
    case "hall": {
      const cv = ctx.createConvolver(); cv.buffer = impulse(ctx, 2.8, 2.5);
      return wetDry(ctx, cv, cv, 0.45, 0.8);
    }
    case "cave": {
      const cv = ctx.createConvolver(); cv.buffer = impulse(ctx, 1.6, 1.8);
      const [ein, eout] = echo(ctx, 0.18, 0.35, 2500);
      cv.connect(ein);
      return wetDry(ctx, cv, eout, 0.6, 0.7);
    }
    case "underwater": {
      const v = vibrato(ctx, 3.5, 0.003);
      return series(filter(ctx, "lowpass", 550, 1.2), v, filter(ctx, "lowshelf", 150, 0.7, 4));
    }
    case "vibrato": { const v = vibrato(ctx, 6, 0.0025); return [v, v]; }
    default: return null;
  }
}

/**
 * Builds the processing chain for item.audio: cleanup → voice effect → loudness gain.
 * Returns { input, output }. Call prepareContext(ctx) first when voice effects or denoise are on.
 */
export function buildChain(ctx, au = {}, loudnessGain = 1) {
  const stages = [];
  if (au.denoise) {
    const gate = new AudioWorkletNode(ctx, "cutline-gate", { outputChannelCount: [2] });
    gate.parameters.get("strength").value = au.denoise === true ? 0.8 : au.denoise;
    stages.push(series(filter(ctx, "highpass", 90), gate, filter(ctx, "lowpass", 11000)));
  }
  if (au.enhance) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -22; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.15; comp.knee.value = 8;
    const makeup = ctx.createGain(); makeup.gain.value = 1.4;
    stages.push(series(filter(ctx, "highpass", 80), filter(ctx, "peaking", 250, 1, -3), filter(ctx, "peaking", 3500, 0.9, 4),
      filter(ctx, "highshelf", 9000, 0.7, 2.5), comp, makeup));
  }
  const v = au.voice && au.voice !== "none" ? voiceEffect(ctx, au.voice) : null;
  if (v) stages.push(v);
  const out = ctx.createGain();
  out.gain.value = loudnessGain;
  stages.push([out, out]);
  for (let i = 0; i < stages.length - 1; i++) stages[i][1].connect(stages[i + 1][0]);
  return { input: stages[0][0], output: out };
}

/** Gain that brings a section of audio to roughly -16 LUFS (RMS-based, limited to +12 dB). */
export function loudnessGain(buffer, from = 0, to = buffer.duration) {
  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.floor(from * sr)), b = Math.min(buffer.length, Math.ceil(to * sr));
  let sum = 0, n = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = a; i < b; i += 4) {
      // Gate out near-silence so pauses don't drag the level down (like LUFS gating).
      const x = d[i];
      if (Math.abs(x) > 0.003) { sum += x * x; n++; }
    }
  }
  if (!n) return 1;
  const rms = Math.sqrt(sum / n);
  const target = Math.pow(10, -19 / 20); // RMS ≈ -19 dBFS ~ -16 LUFS for speech
  return Math.min(4, Math.max(0.1, target / rms));
}

// ---------------- live preview ----------------

let live = null;
const routes = new WeakMap(); // media element -> { src, gain, sig, chain }

export function liveContext() {
  live ??= new AudioContext({ latencyHint: "interactive" });
  return live;
}

/** Resume audio after a user gesture (play button / Space). */
export function resumeLive() {
  if (live && live.state !== "running") live.resume().catch(() => {});
}

/** True when an item has to play through Web Audio in the preview (effects, or louder than 100%). */
export const needsLiveRoute = (item, vol) => needsChain(item.audio) || vol > 1.001 || !!item.audio?.normalize;

/**
 * Routes a media element through its effect chain for preview playback. Once routed an element stays
 * routed (the browser can't undo that); the chain is rebuilt when the settings change.
 */
export function routeLive(el, item, volume, normalize = 1) {
  const ctx = liveContext();
  let r = routes.get(el);
  if (!r) {
    r = { src: ctx.createMediaElementSource(el), gain: ctx.createGain(), sig: null, chain: null };
    r.gain.connect(ctx.destination);
    routes.set(el, r);
  }
  const au = item.audio || {};
  const sig = JSON.stringify([au.denoise, au.enhance, au.voice, normalize]);
  if (sig !== r.sig) {
    r.sig = sig;
    r.src.disconnect();
    r.chain?.output.disconnect();
    const build = () => {
      r.chain = buildChain(ctx, au, normalize);
      r.src.connect(r.chain.input);
      r.chain.output.connect(r.gain);
    };
    if (needsChain(au)) {
      r.src.connect(r.gain); // play dry until the worklet is ready
      prepareContext(ctx).then(() => { if (r.sig === sig) { r.src.disconnect(); build(); } });
    } else build();
  }
  el.volume = 1;
  r.gain.gain.setTargetAtTime(volume, ctx.currentTime, 0.02);
  return true;
}

export const isRouted = (el) => routes.has(el);
