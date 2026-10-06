/**
 * Embedding: stream layout (format §5) and the two channels (section 6).
 * @module embed
 */

import { stft, istftInto, magnitude, phase, wrapPhase, mean8, roundHalfEven, frameCount } from './stft.js';
import { N_BINS, GROUP, HEADER_BITS, getProfile, defaultOptions, makeLayout } from './layout.js';
import { bytesToBits, headerBits } from './payload.js';

/** Offset inside log() for the QIM statistic. */
export const LOG_EPS = 1e-8;
const HALF_PI = Math.PI / 2;

/** Thrown when a clip cannot carry the payload. Its message starts with "too short". */
export class TooShortError extends RangeError {
  constructor(message) {
    super(message);
    this.name = 'TooShortError';
  }
}

/** @param {ArrayLike<number>} x @returns {Float64Array} */
export function toFloat64(x) {
  if (x instanceof Float64Array) return x;
  if (x && typeof x.length === 'number') return Float64Array.from(x);
  throw new TypeError('samples must be an array of numbers (mono)');
}

/**
 * Frames, groups and per-channel capacity (bits) of a clip of `nSamples`.
 * @param {number} nSamples
 * @param {string|import('./layout.js').Profile} [profile]
 */
export function capacity(nSamples, profile = 'wb') {
  const prof = getProfile(profile);
  const frames = frameCount(nSamples);
  const groups = Math.floor(frames / GROUP);
  return { frames, groups, phase: groups * prof.bp, magnitude: groups * prof.bm };
}

/** Body replicas for a channel: r = max(1, min(R, floor((cap - 96) / |b|))). */
export function replicaCount(cap, bodyBits, maxReplicas) {
  return Math.max(1, Math.min(maxReplicas, Math.floor((cap - HEADER_BITS) / bodyBits)));
}

/**
 * h || h || h || b^r for one channel.
 * @param {Uint8Array} body body bits
 * @param {number} cap channel capacity in bits
 * @param {number} maxReplicas R
 * @returns {Uint8Array}
 */
export function buildStream(body, cap, maxReplicas) {
  if (cap - HEADER_BITS < body.length) {
    throw new TooShortError(`too short: the channel holds ${cap} bits, the stream needs ${HEADER_BITS + body.length}`);
  }
  const r = replicaCount(cap, body.length, maxReplicas);
  const h = headerBits(body.length);
  const out = new Uint8Array(HEADER_BITS + r * body.length);
  for (let c = 0; c < 3; c++) out.set(h, 32 * c);
  for (let j = 0; j < r; j++) out.set(body, HEADER_BITS + j * body.length);
  return out;
}

/** Mean over the 8 group frames of log(A[k, f] + 1e-8), reference summation order. */
export function meanLog(A, base, scratch) {
  for (let j = 0; j < GROUP; j++) scratch[j] = Math.log(A[base + j * N_BINS] + LOG_EPS);
  return mean8(scratch, 0, 1);
}

/**
 * Write stream positions 0..len-1 of each channel into the clip (Python `embed_bits`).
 * Both channels read the original STFT; untouched cells are resynthesized from their own
 * magnitude and phase.
 * @param {ArrayLike<number>} samples mono, 44.1 kHz
 * @param {ArrayLike<number>} phaseBits phase stream (0/1)
 * @param {ArrayLike<number>} magBits magnitude stream (0/1)
 * @param {{kp: ArrayLike<number>, pairs: ArrayLike<number>}} lay layout (see makeLayout)
 * @param {string|import('./layout.js').Profile} [profile]
 * @param {Partial<import('./layout.js').Options>} [options]
 * @param {object|null} [trace] receives per-bit phase and QIM values when given
 * @returns {Float64Array} signed samples, same length as the input
 */
export function embedBits(samples, phaseBits, magBits, lay, profile = 'wb', options = {}, trace = null) {
  const prof = getProfile(profile);
  const opt = defaultOptions(options);
  const pf = opt.phase_frames;
  if (!Number.isInteger(pf) || pf < 1 || pf > GROUP) throw new RangeError('phase_frames must be an integer in 1..8');
  if (opt.tail !== 'passthrough' && opt.tail !== 'zero') throw new RangeError("tail must be 'passthrough' or 'zero'");
  const x = toFloat64(samples);
  const spec = stft(x);
  const frames = spec.frames;
  const bp = prof.bp;
  const bm = prof.bm;
  const ps = phaseBits;
  const ms = magBits;
  if (ps.length && ((ps.length - 1) / bp | 0) * GROUP >= frames) throw new RangeError('phase stream longer than capacity');
  if (ms.length && ((ms.length - 1) / bm | 0) * GROUP + GROUP > frames) throw new RangeError('magnitude stream longer than capacity');

  const A = magnitude(spec);
  const P = phase(spec);
  const A2 = A.slice();
  const P2 = P.slice();

  // Phase channel: bit i -> bin Kp[i mod Bp], frame (i div Bp) * G.
  const kp = lay.kp;
  const tp = trace ? { before: new Float64Array(ps.length), after: new Float64Array(ps.length) } : null;
  for (let i = 0; i < ps.length; i++) {
    const g = (i / bp) | 0;
    const idx = g * GROUP * N_BINS + kp[i - g * bp];
    const target = ps[i] ? HALF_PI : -HALF_PI;
    const delta = target - P[idx];
    for (let j = 0; j < pf; j++) P2[idx + j * N_BINS] += delta;
    if (tp) {
      tp.before[i] = P[idx];
      tp.after[i] = wrapPhase(P2[idx]);
    }
  }

  // Magnitude channel: QIM on the mean log-magnitude difference of a bin pair over a group.
  const pairs = lay.pairs;
  const step = prof.delta;
  const scratch = new Float64Array(GROUP);
  const tm = trace
    ? { d_before: new Float64Array(ms.length), d_after: new Float64Array(ms.length), cell: new Int32Array(ms.length), shift: new Float64Array(ms.length) }
    : null;
  for (let i = 0; i < ms.length; i++) {
    const g = (i / bm) | 0;
    const s = i - g * bm;
    const base = g * GROUP * N_BINS;
    const k1 = pairs[2 * s];
    const k2 = pairs[2 * s + 1];
    const d = meanLog(A, base + k1, scratch) - meanLog(A, base + k2, scratch);
    let c = roundHalfEven(d / step);
    if ((c & 1) !== (ms[i] ? 1 : 0)) c = d >= c * step ? c + 1 : c - 1;
    const shift = c * step - d;
    const e1 = Math.exp(shift / 2);
    const e2 = Math.exp(-shift / 2);
    for (let j = 0; j < GROUP; j++) {
      const o = base + j * N_BINS;
      A2[o + k1] = A[o + k1] * e1;
      A2[o + k2] = A[o + k2] * e2;
    }
    if (tm) {
      tm.d_before[i] = d;
      tm.d_after[i] = c * step;
      tm.cell[i] = c;
      tm.shift[i] = shift;
    }
  }

  // Recombine X' = A' exp(j wrap(P')) and invert frame by frame.
  const n = A2.length;
  const re = spec.re;
  const im = spec.im;
  for (let i = 0; i < n; i++) {
    const p = wrapPhase(P2[i]);
    re[i] = A2[i] * Math.cos(p);
    im[i] = A2[i] * Math.sin(p);
  }
  const out = opt.tail === 'passthrough' ? Float64Array.from(x) : new Float64Array(x.length);
  istftInto(spec, out);
  if (trace) {
    trace.phase = { ...trace.phase, bins: kp, ...tp };
    trace.magnitude = { ...trace.magnitude, pairs, delta: step, ...tm };
  }
  return out;
}

/**
 * Embed an arbitrary payload (format §5–6, Python `embed_payload`).
 * @param {ArrayLike<number>} samples mono, 44.1 kHz
 * @param {Uint8Array} payload bytes to embed (normally buildPayload output)
 * @param {number} seed layout seed
 * @param {string|import('./layout.js').Profile} [profile]
 * @param {Partial<import('./layout.js').Options>} [options]
 * @param {object|null} [trace] filled with intermediate artifacts when given
 * @param {{kp: ArrayLike<number>, pairs: ArrayLike<number>}|null} [lay] layout override (tests)
 * @returns {Float64Array} signed samples, same length as the input
 */
export function embedPayload(samples, payload, seed, profile = 'wb', options = {}, trace = null, lay = null) {
  const prof = getProfile(profile);
  const x = toFloat64(samples);
  const body = bytesToBits(payload);
  if (body.length === 0) throw new RangeError('payload is empty');
  const cap = capacity(x.length, prof);
  const ps = buildStream(body, cap.phase, prof.rp);
  const ms = buildStream(body, cap.magnitude, prof.rm);
  if (trace) {
    Object.assign(trace, {
      frames: cap.frames,
      groups: cap.groups,
      seed,
      profile: prof.name,
      payload: Uint8Array.from(payload),
      header_bits: headerBits(body.length),
      body_bits: body,
      phase: {
        capacity: cap.phase,
        bits_per_group: prof.bp,
        replicas: replicaCount(cap.phase, body.length, prof.rp),
        stream: ps,
      },
      magnitude: {
        capacity: cap.magnitude,
        bits_per_group: prof.bm,
        replicas: replicaCount(cap.magnitude, body.length, prof.rm),
        stream: ms,
      },
    });
  }
  return embedBits(x, ps, ms, lay ?? makeLayout(seed, prof), prof, options, trace);
}
