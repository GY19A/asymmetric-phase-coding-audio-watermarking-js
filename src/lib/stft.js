/**
 * Rectangular-window STFT with hop = N = 2048, no centering (format §1).
 *
 * Spectra are stored frame-major: bin k of frame t lives at index t * 1025 + k.
 * @module stft
 */

import { getFFT } from './fft.js';
import { N_FFT, N_BINS } from './layout.js';

/** Number of full frames in a signal of `len` samples. */
export function frameCount(len, n = N_FFT) {
  return len < n ? 0 : Math.floor((len - n) / n) + 1;
}

/**
 * @typedef {object} Spectrum
 * @property {number} frames
 * @property {Float64Array} re  frames * 1025
 * @property {Float64Array} im  frames * 1025
 */

/**
 * @param {Float64Array} x mono signal
 * @param {number} [offset] first sample of frame 0
 * @param {number} [maxFrames]
 * @returns {Spectrum}
 */
export function stft(x, offset = 0, maxFrames = Infinity) {
  const fft = getFFT(N_FFT);
  const frames = Math.min(frameCount(x.length - offset), maxFrames);
  const re = new Float64Array(frames * N_BINS);
  const im = new Float64Array(frames * N_BINS);
  const fr = new Float64Array(N_BINS);
  const fi = new Float64Array(N_BINS);
  for (let t = 0; t < frames; t++) {
    fft.forward(x, fr, fi, offset + t * N_FFT);
    re.set(fr, t * N_BINS);
    im.set(fi, t * N_BINS);
  }
  return { frames, re, im };
}

/**
 * Per-frame irfft, frames concatenated into `out[0 .. frames*N)`.
 * @param {Spectrum} spec
 * @param {Float64Array} out
 */
export function istftInto(spec, out) {
  const fft = getFFT(N_FFT);
  const fr = new Float64Array(N_BINS);
  const fi = new Float64Array(N_BINS);
  for (let t = 0; t < spec.frames; t++) {
    fr.set(spec.re.subarray(t * N_BINS, (t + 1) * N_BINS));
    fi.set(spec.im.subarray(t * N_BINS, (t + 1) * N_BINS));
    fft.inverse(fr, fi, out, t * N_FFT);
  }
  return out;
}

/** |X| as numpy computes it (hypot). */
export function magnitude(spec) {
  const n = spec.re.length;
  const a = new Float64Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.hypot(spec.re[i], spec.im[i]);
  return a;
}

/** angle(X) = atan2(im, re). */
export function phase(spec) {
  const n = spec.re.length;
  const p = new Float64Array(n);
  for (let i = 0; i < n; i++) p[i] = Math.atan2(spec.im[i], spec.re[i]);
  return p;
}

const TWO_PI = 2 * Math.PI;
/** numpy `(p + pi) % (2 pi) - pi` (remainder takes the sign of the divisor). */
export function wrapPhase(p) {
  let r = (p + Math.PI) % TWO_PI;
  if (r !== 0 && r < 0) r += TWO_PI;
  else if (r === 0) r = 0;
  return r - Math.PI;
}

/**
 * Mean of exactly 8 values a[base + j * stride], summed left to right then divided by 8
 * (the reference `_group_mean` order).
 */
export function mean8(a, base, stride) {
  let s = a[base];
  for (let j = 1; j < 8; j++) s += a[base + j * stride];
  return s / 8;
}

/** numpy `np.round` (round half to even). */
export function roundHalfEven(x) {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff > 0.5) return f + 1;
  if (diff < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}
