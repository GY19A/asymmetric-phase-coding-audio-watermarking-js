/**
 * Signal attacks for the demonstration, applied to the signed 44.1 kHz samples.
 *
 * Every function is a plain transform on a Float64Array, so the same code runs in the
 * browser worker and in the Node tests. Noise uses a seeded generator; the seed is
 * reported with the run so a result can be reproduced.
 * @module demo/attacks
 */

import { quantize } from '../lib/index.js';
import { RealFFT } from '../lib/fft.js';

/** Requantize to `bits` bits (the PCM16 writer's clip and round half to even). */
export function requantize(x, bits) {
  return quantize(x, bits);
}

function besselI0(x) {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/**
 * Zero-phase low-pass FIR (Kaiser-windowed sinc, 80 dB stopband, 500 Hz transition
 * centered on `cutoff`), applied by one zero-padded FFT convolution.
 */
export function lowpass(x, cutoff = 8000, sampleRate = 44100) {
  const beta = 7.857; // Kaiser beta for 80 dB attenuation
  const tw = 500 / sampleRate;
  const half = Math.ceil((80 - 8) / (2.285 * 2 * Math.PI * tw) / 2);
  const fc = cutoff / sampleRate;
  const h = new Float64Array(half + 1); // h[k] = h[-k]
  const i0b = besselI0(beta);
  for (let k = 0; k <= half; k++) {
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const r = k / (half + 1);
    h[k] = sinc * (besselI0(beta * Math.sqrt(1 - r * r)) / i0b);
  }
  let n = 4;
  while (n < x.length + 2 * half + 1) n *= 2;
  const fft = new RealFFT(n);
  const buf = new Float64Array(n);
  buf.set(x);
  const xr = new Float64Array(n / 2 + 1);
  const xi = new Float64Array(n / 2 + 1);
  fft.forward(buf, xr, xi);
  buf.fill(0);
  buf[0] = h[0];
  for (let k = 1; k <= half; k++) {
    buf[k] = h[k];
    buf[n - k] = h[k];
  }
  const hr = new Float64Array(n / 2 + 1);
  const hi = new Float64Array(n / 2 + 1);
  fft.forward(buf, hr, hi);
  for (let k = 0; k <= n / 2; k++) {
    const a = xr[k] * hr[k] - xi[k] * hi[k];
    const b = xr[k] * hi[k] + xi[k] * hr[k];
    xr[k] = a;
    xi[k] = b;
  }
  fft.inverse(xr, xi, buf);
  return buf.slice(0, x.length);
}

/** Drop the last `pct` percent of the file (the result is shorter). */
export function cropTail(x, pct) {
  return x.slice(0, Math.floor(x.length * (1 - pct / 100)));
}

/** Silence the first `pct` percent, keeping the timeline (the paper's head crop). */
export function cropHead(x, pct) {
  const out = Float64Array.from(x);
  out.fill(0, 0, Math.round((x.length * pct) / 100));
  return out;
}

/** Delay by `k` samples: k zeros in front, the same length (a desynchronization). */
export function shift(x, k) {
  const out = new Float64Array(x.length);
  if (k < x.length) out.set(x.subarray(0, x.length - k), k);
  return out;
}

/** mulberry32: a small seeded 32-bit generator, uniform in [0, 1). */
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(u) {
  let spare = null;
  return () => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let a;
    do a = u(); while (a === 0);
    const r = Math.sqrt(-2 * Math.log(a));
    const t = 2 * Math.PI * u();
    spare = r * Math.sin(t);
    return r * Math.cos(t);
  };
}

/**
 * Additive noise at a given SNR over the whole file. `color` is 'white' (Gaussian) or
 * 'pink' (Paul Kellet's three-pole 1/f filter on white noise).
 * @returns {Float64Array}
 */
export function addNoise(x, snrDb, color = 'white', seed = 1) {
  const g = gaussian(rng(seed));
  const w = new Float64Array(x.length);
  if (color === 'pink') {
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < w.length; i++) {
      const v = g();
      b0 = 0.99765 * b0 + v * 0.099046;
      b1 = 0.963 * b1 + v * 0.2965164;
      b2 = 0.57 * b2 + v * 1.0526913;
      w[i] = b0 + b1 + b2 + v * 0.1848;
    }
  } else {
    for (let i = 0; i < w.length; i++) w[i] = g();
  }
  let ps = 0;
  let pn = 0;
  for (let i = 0; i < x.length; i++) {
    ps += x[i] * x[i];
    pn += w[i] * w[i];
  }
  const scale = pn > 0 ? Math.sqrt(ps / pn / 10 ** (snrDb / 10)) : 0;
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + scale * w[i];
  return out;
}

/** 10 log10(signal power / error power) of `y` against the reference `x` (common length). */
export function snrDb(x, y) {
  const n = Math.min(x.length, y.length);
  let ps = 0;
  let pe = 0;
  for (let i = 0; i < n; i++) {
    ps += x[i] * x[i];
    const e = y[i] - x[i];
    pe += e * e;
  }
  return pe === 0 ? Infinity : 10 * Math.log10(ps / pe);
}

/**
 * The attack chain in a fixed order: shift, head crop, tail crop, low-pass, noise,
 * lossy codec (async, browser only, passed in as `codec`), requantization.
 * @param {Float64Array} y signed samples
 * @param {object} s attack settings (see DEFAULT_ATTACKS)
 * @param {{codec?: (x: Float64Array) => Promise<{samples: Float64Array, label: string}>, seed?: number}} [env]
 * @returns {Promise<{samples: Float64Array, steps: {id: string, label: string, ms: number}[]}>}
 */
export async function applyAttacks(y, s, env = {}) {
  let z = y;
  const steps = [];
  const run = async (id, label, f) => {
    const t0 = performance.now();
    z = await f(z);
    steps.push({ id, label, ms: performance.now() - t0 });
  };
  if (s.shift?.on) await run('shift', `Delay by ${s.shift.samples} samples`, (v) => shift(v, s.shift.samples));
  if (s.cropHead?.on) await run('cropHead', `Head crop ${s.cropHead.pct}% (silenced)`, (v) => cropHead(v, s.cropHead.pct));
  if (s.cropTail?.on) await run('cropTail', `Tail crop ${s.cropTail.pct}% (removed)`, (v) => cropTail(v, s.cropTail.pct));
  if (s.lowpass?.on) await run('lowpass', `Low-pass ${s.lowpass.hz / 1000} kHz`, (v) => lowpass(v, s.lowpass.hz));
  if (s.noise?.on) {
    await run('noise', `${s.noise.color === 'pink' ? 'Pink' : 'White'} noise at ${s.noise.snr} dB SNR`,
      (v) => addNoise(v, s.noise.snr, s.noise.color, env.seed ?? 1));
  }
  if (s.codec?.on && !env.codec) {
    steps.push({ id: 'codec', label: 'Opus round trip skipped: WebCodecs audio encoding is not available here', ms: 0, skipped: true });
  } else if (s.codec?.on) {
    let label = 'Lossy codec';
    await run('codec', label, async (v) => {
      const r = await env.codec(v, s.codec);
      label = r.label;
      return r.samples;
    });
    steps[steps.length - 1].label = label;
  }
  if (s.requant?.on) await run('requant', `Requantize to ${s.requant.bits} bits`, (v) => requantize(v, s.requant.bits));
  return { samples: z === y ? Float64Array.from(y) : z, steps };
}

export { DEFAULT_ATTACKS } from './stages.js';
