// AudioWorklet processors used by audiofx.js (live preview and export render the same way).

/** Pitch shift without changing speed: two crossfaded read heads sweep a short delay line. */
class PitchShift extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "ratio", defaultValue: 1, minValue: 0.25, maxValue: 4, automationRate: "k-rate" }];
  }
  constructor() {
    super();
    this.size = 8192;
    this.grain = Math.round(sampleRate * 0.06);
    this.bufs = [];
    this.w = 0;
    this.phase = 0;
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    const ratio = params.ratio[0];
    const L = this.grain, N = this.size;
    while (this.bufs.length < output.length) this.bufs.push(new Float32Array(N));
    const frames = output[0]?.length || 128;
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < output.length; ch++) this.bufs[ch][this.w] = input[ch]?.[i] ?? input[0]?.[i] ?? 0;
      const d1 = this.phase, d2 = (this.phase + L / 2) % L;
      const w1 = Math.sin((Math.PI * d1) / L), w2 = Math.sin((Math.PI * d2) / L);
      for (let ch = 0; ch < output.length; ch++) {
        const b = this.bufs[ch];
        const tap = (d) => {
          const pos = this.w - d - 1;
          const i0 = Math.floor(pos), f = pos - i0;
          const a = b[(i0 + N * 4) % N], c = b[(i0 + 1 + N * 4) % N];
          return a + (c - a) * f;
        };
        output[ch][i] = tap(d1) * w1 + tap(d2) * w2;
      }
      this.phase += 1 - ratio;
      this.phase = ((this.phase % L) + L) % L;
      this.w = (this.w + 1) % N;
    }
    return true;
  }
}
registerProcessor("cutline-pitch", PitchShift);

/**
 * Noise reduction by downward expansion: follows the signal level and an estimate of the noise floor,
 * and turns the volume down whenever the level sits near the floor (pauses, room hiss between words).
 */
class NoiseGate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "strength", defaultValue: 0.8, minValue: 0, maxValue: 1, automationRate: "k-rate" }];
  }
  constructor() {
    super();
    this.env = 0;
    this.floor = 0.002;
    this.gain = 1;
    this.att = Math.exp(-1 / (sampleRate * 0.005));
    this.rel = Math.exp(-1 / (sampleRate * 0.12));
    this.floorRise = Math.exp(-1 / (sampleRate * 2.5));
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    const strength = params.strength[0];
    const frames = output[0]?.length || 128;
    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let ch = 0; ch < input.length; ch++) peak = Math.max(peak, Math.abs(input[ch][i] || 0));
      const k = peak > this.env ? this.att : this.rel;
      this.env = k * this.env + (1 - k) * peak;
      // The floor drops instantly to quieter levels and creeps up slowly.
      this.floor = this.env < this.floor ? this.env : this.floorRise * this.floor + (1 - this.floorRise) * this.env;
      this.floor = Math.max(this.floor, 1e-5);
      const ratio = this.env / (this.floor * 3);
      const target = ratio >= 1 ? 1 : Math.max(1 - strength * 0.95, ratio * ratio);
      const g = target < this.gain ? 0.999 : 0.98; // close slowly, open fast
      this.gain = g * this.gain + (1 - g) * target;
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = (input[ch]?.[i] ?? 0) * this.gain;
    }
    return true;
  }
}
registerProcessor("cutline-gate", NoiseGate);
