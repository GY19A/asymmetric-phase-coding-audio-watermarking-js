/**
 * Microphone capture for "Sign your voice": raw PCM through an AudioWorklet, a live level and
 * timer, and a speech check before anything is signed. Nothing leaves the tab.
 * @module ui/recorder
 */

const TAP = `
class Tap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const chans = inputs[0];
    if (chans && chans.length) {
      const len = chans[0].length;
      for (let i = 0; i < len; i++) {
        let v = 0;
        for (const c of chans) v += c[i];
        this.buf[this.n++] = v / chans.length;
        if (this.n === this.buf.length) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(4096);
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('apc-tap', Tap);
`;

/**
 * Share of 32 ms frames that carry speech, and the loud level (95th percentile frame RMS, dBFS).
 * A frame counts when it is within 30 dB of the loud level and above -55 dBFS.
 * @param {Float32Array|Float64Array} x
 * @param {number} rate
 */
export function speechActivity(x, rate) {
  const n = Math.max(1, Math.round(rate * 0.032));
  const frames = Math.floor(x.length / n);
  if (!frames) return { active: 0, levelDb: -Infinity };
  const rms = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * n; i < (f + 1) * n; i++) s += x[i] * x[i];
    rms[f] = Math.sqrt(s / n);
  }
  const loud = Float64Array.from(rms).sort()[Math.min(frames - 1, Math.floor(0.95 * frames))];
  const thr = Math.max(loud * 10 ** (-30 / 20), 10 ** (-55 / 20));
  let on = 0;
  for (const r of rms) if (r > thr) on++;
  return { active: on / frames, levelDb: 20 * Math.log10(loud || 1e-12) };
}

export const micSupported = () =>
  !!(globalThis.isSecureContext && navigator.mediaDevices?.getUserMedia && globalThis.AudioWorkletNode);

/**
 * Open the microphone and record until `stop()` or `maxSeconds`.
 * @param {{maxSeconds: number, onTick: (t: {seconds: number, levelDb: number}) => void, onAutoStop: () => void}} o
 * @returns {Promise<{stop: () => {samples: Float32Array, sampleRate: number}, cancel: () => void}>}
 */
export async function startRecording({ maxSeconds, onTick, onAutoStop }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  });
  const ctx = new AudioContext();
  const release = () => {
    for (const t of stream.getTracks()) t.stop();
    ctx.close().catch(() => {});
  };
  try {
    const url = URL.createObjectURL(new Blob([TAP], { type: 'text/javascript' }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    await ctx.resume();
  } catch (e) {
    release();
    throw e;
  }
  const rate = ctx.sampleRate;
  const cap = Math.round(maxSeconds * rate);
  const chunks = [];
  let total = 0;
  let done = false;
  const src = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, 'apc-tap');
  // A silent path to the destination keeps the worklet pulled in every browser.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(tap).connect(mute).connect(ctx.destination);

  const collect = () => {
    const out = new Float32Array(Math.min(total, cap));
    let o = 0;
    for (const c of chunks) {
      const k = Math.min(c.length, out.length - o);
      out.set(c.subarray(0, k), o);
      o += k;
    }
    return out;
  };
  const finish = () => {
    done = true;
    tap.port.onmessage = null;
    src.disconnect();
    release();
    return { samples: collect(), sampleRate: rate };
  };

  tap.port.onmessage = (ev) => {
    if (done) return;
    const c = ev.data;
    chunks.push(c);
    total += c.length;
    let s = 0;
    for (const v of c) s += v * v;
    onTick({ seconds: Math.min(total, cap) / rate, levelDb: 10 * Math.log10(s / c.length || 1e-12) });
    if (total >= cap) onAutoStop();
  };

  return {
    stop: finish,
    cancel: () => {
      if (!done) finish();
    },
  };
}
