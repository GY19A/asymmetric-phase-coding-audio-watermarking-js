/**
 * Optional decoder-side resynchronization (format §8, Python `apcaw.resync`).
 *
 * Every integer sample offset delta in [0, N) and whole-frame skip f0 in [0, 10] is scored
 * by the magnitude-weighted phase alignment sum|Im Z| / sum|Z| over the phase band
 * p_lo..p_hi-1 of the frames f0 + 8g (g < 6). The phase write puts carrier phases at
 * +-pi/2, so the score peaks when the frame grid lines up. The band is the same for every
 * key, so the score is key-free. Verification then runs on delta = 0 (every f0) and on the
 * 8 best-scoring offsets. Ed25519 still gates every acceptance.
 *
 * The band of each of the 51 scored frames is tracked with a sliding DFT across delta
 * (O(frames * bins) per sample step instead of one FFT per frame and offset), and is
 * recomputed exactly with the FFT every 256 steps to bound rounding drift. Scores are only
 * used for ranking; the verifier re-analyzes each chosen alignment from scratch.
 * @module resync
 */

import { getFFT } from './fft.js';
import { N_FFT, N_BINS, GROUP } from './layout.js';

export const FMAX = 10;
export const SCORE_GROUPS = 6;
export const TOPK_DELTA = 8;
/** Frames needed to score every f0: FMAX + (SCORE_GROUPS - 1) * G + 1 = 51. */
export const SCORE_FRAMES = FMAX + (SCORE_GROUPS - 1) * GROUP + 1;
const REFRESH = 256;

/**
 * S[delta * (FMAX + 1) + f0]: the alignment score, or -1 where the frames f0 + 8g
 * (g < SCORE_GROUPS) do not all exist or carry no energy.
 * @param {Float64Array} x
 * @param {number} pLo first phase-band bin
 * @param {number} pHi one past the last phase-band bin
 * @returns {Float64Array} length N * (FMAX + 1)
 */
export function scoreGrid(x, pLo, pHi) {
  const W = FMAX + 1;
  const s = new Float64Array(N_FFT * W).fill(-1);
  const n = x.length;
  const nb = pHi - pLo;
  const F = Math.min(SCORE_FRAMES, Math.floor(n / N_FFT));
  if (F === 0) return s;
  const wr = new Float64Array(nb);
  const wi = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    wr[b] = Math.cos((2 * Math.PI * (pLo + b)) / N_FFT);
    wi[b] = Math.sin((2 * Math.PI * (pLo + b)) / N_FFT);
  }
  const re = new Float64Array(F * nb);
  const im = new Float64Array(F * nb);
  const num = new Float64Array(F);
  const den = new Float64Array(F);
  const fft = getFFT(N_FFT);
  const fr = new Float64Array(N_BINS);
  const fi = new Float64Array(N_BINS);

  for (let d = 0; d < N_FFT; d++) {
    const nf = Math.min(SCORE_FRAMES, Math.max(0, Math.floor((n - d) / N_FFT)));
    if (nf === 0) break;
    if (d % REFRESH === 0) {
      for (let t = 0; t < nf; t++) {
        fft.forward(x, fr, fi, d + t * N_FFT);
        for (let b = 0; b < nb; b++) {
          re[t * nb + b] = fr[pLo + b];
          im[t * nb + b] = fi[pLo + b];
        }
      }
    }
    for (let t = 0; t < nf; t++) {
      let a = 0;
      let z = 0;
      const o = t * nb;
      for (let b = 0; b < nb; b++) {
        const r = re[o + b];
        const i = im[o + b];
        a += Math.abs(i);
        z += Math.sqrt(r * r + i * i);
      }
      num[t] = a;
      den[t] = z;
    }
    for (let f0 = 0; f0 <= FMAX; f0++) {
      if (f0 + (SCORE_GROUPS - 1) * GROUP >= nf) continue;
      let a = 0;
      let z = 0;
      for (let g = 0; g < SCORE_GROUPS; g++) {
        a += num[f0 + g * GROUP];
        z += den[f0 + g * GROUP];
      }
      s[d * W + f0] = z > 0 ? a / z : -1;
    }
    // slide every frame by one sample: X <- (X - x[start] + x[start + N]) e^{2 pi i k / N}
    if ((d + 1) % REFRESH !== 0) {
      for (let t = 0; t < nf; t++) {
        const start = d + t * N_FFT;
        const dx = (start + N_FFT < n ? x[start + N_FFT] : 0) - x[start];
        const o = t * nb;
        for (let b = 0; b < nb; b++) {
          const r = re[o + b] + dx;
          const i = im[o + b];
          re[o + b] = r * wr[b] - i * wi[b];
          im[o + b] = r * wi[b] + i * wr[b];
        }
      }
    }
  }
  return s;
}

/** Indices 0..n-1 sorted by descending value, ties by index (numpy stable argsort of -v). */
function argsortDesc(v) {
  return Array.from(v.keys()).sort((a, b) => (v[b] - v[a]) || (a - b));
}

/**
 * The offsets tried, in order: 0, then the TOPK_DELTA best by row maximum (0 not repeated).
 * @param {Float64Array} s scoreGrid output
 * @returns {number[]}
 */
export function deltaOrder(s) {
  const W = FMAX + 1;
  const best = new Float64Array(N_FFT);
  for (let d = 0; d < N_FFT; d++) {
    let m = -Infinity;
    for (let f = 0; f < W; f++) m = Math.max(m, s[d * W + f]);
    best[d] = m;
  }
  return [0, ...argsortDesc(best).slice(0, TOPK_DELTA).filter((d) => d !== 0)];
}

/**
 * Try alignments in reference order on the verify state `st` (shared de-duplication and
 * counters). (delta, f0) = (0, 0) is the plain path and is skipped.
 * @param {Float64Array} x
 * @param {object} st verify state with `profiles`, `run(analysis, pathOverride, alignment)` and `trace`
 * @param {(x: Float64Array, offset: number) => {frames: number, A: Float64Array, P: Float64Array}} analyze
 * @returns {object|null} the verify result on success
 */
export function resyncSearch(x, st, analyze) {
  const { prof } = st.profiles[0];
  const W = FMAX + 1;
  const s = scoreGrid(x, prof.p_lo, prof.p_hi);
  const order = deltaOrder(s);
  const tr = st.trace ? (st.trace.resync = { order, tried: [], best: order.map((d) => Array.from(s.subarray(d * W, d * W + W))) }) : null;
  for (const d of order) {
    const an = analyze(x, d);
    if (an.frames === 0) continue;
    const row = s.subarray(d * W, d * W + W);
    for (const f0 of argsortDesc(row)) {
      if (row[f0] < 0 || (d === 0 && f0 === 0)) continue;
      if (tr) tr.tried.push({ delta: d, f0, score: row[f0] });
      const sub = { frames: an.frames - f0, A: an.A.subarray(f0 * N_BINS), P: an.P.subarray(f0 * N_BINS) };
      const r = st.run(sub, 'resync', { delta: d, f0 });
      if (r) return { ...r, reason: `ok (resync delta=${d} f0=${f0})`, offset: { delta: d, f0, samples: d + f0 * N_FFT } };
    }
  }
  return null;
}
