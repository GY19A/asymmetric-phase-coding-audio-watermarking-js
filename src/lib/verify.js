/**
 * Soft reading (format §7) and header-independent verification (section 8).
 * @module verify
 */

import { stft, magnitude, phase, mean8 } from './stft.js';
import { N_BINS, GROUP, HEADER_BITS, SAMPLE_RATE, WB, NB, getProfile, defaultOptions, resolveSeed, makeLayout } from './layout.js';
import { parsePayload, bitsToBytes, OVERHEAD } from './payload.js';
import { toFloat64, meanLog, replicaCount } from './embed.js';
import { resyncSearch } from './resync.js';

/** The two channels in verification order. */
export const CHANNELS = Object.freeze(['phase', 'magnitude']);

/**
 * Magnitude and phase of every full frame of `x` (from `offset`).
 * @returns {{frames: number, A: Float64Array, P: Float64Array}}
 */
export function analyze(samples, offset = 0) {
  const x = toFloat64(samples);
  const spec = stft(x, offset);
  return { frames: spec.frames, A: magnitude(spec), P: phase(spec) };
}

/**
 * Soft values of both channels from an analysis (format §7).
 * @param {{frames: number, A: Float64Array, P: Float64Array}} an
 * @param {number} seed
 * @param {import('./layout.js').Profile} prof
 * @param {import('./layout.js').Options} opt
 * @param {{kp: ArrayLike<number>, pairs: ArrayLike<number>}} [lay] precomputed layout for `seed`
 * @returns {{groups: number, phase: Float64Array, magnitude: Float64Array}}
 */
export function softFromAnalysis(an, seed, prof, opt, lay = makeLayout(seed, prof)) {
  const { A, P } = an;
  const groups = Math.floor(an.frames / GROUP);
  const tau = opt.erasure_tau;
  const kp = lay.kp;
  const bp = prof.bp;
  const sp = new Float64Array(groups * bp);
  for (let i = 0; i < sp.length; i++) {
    const g = (i / bp) | 0;
    const idx = g * GROUP * N_BINS + kp[i - g * bp];
    sp[i] = tau > 0 && A[idx] < tau ? 0 : Math.sin(P[idx]);
  }
  const pairs = lay.pairs;
  const bm = prof.bm;
  const step = prof.delta;
  const sm = new Float64Array(groups * bm);
  const scratch = new Float64Array(GROUP);
  for (let i = 0; i < sm.length; i++) {
    const g = (i / bm) | 0;
    const s = i - g * bm;
    const base = g * GROUP * N_BINS;
    const k1 = pairs[2 * s];
    const k2 = pairs[2 * s + 1];
    if (tau > 0 && mean8(A, base + k1, N_BINS) < tau && mean8(A, base + k2, N_BINS) < tau) {
      sm[i] = 0;
      continue;
    }
    const l1 = meanLog(A, base + k1, scratch);
    const l2 = meanLog(A, base + k2, scratch);
    sm[i] = -Math.cos((Math.PI * (l1 - l2)) / step);
  }
  return { groups, phase: sp, magnitude: sm };
}

/**
 * Soft values of both channels (Python `read_soft`).
 * @param {ArrayLike<number>} samples mono, 44.1 kHz
 * @param {number} seed layout seed
 * @param {string|import('./layout.js').Profile} [profile]
 * @param {Partial<import('./layout.js').Options>} [options]
 * @returns {{groups: number, phase: Float64Array, magnitude: Float64Array}}
 */
export function readSoft(samples, seed, profile = 'wb', options = {}) {
  return softFromAnalysis(analyze(samples), seed, getProfile(profile), defaultOptions(options));
}

/** Per-bit header sums h0 + h1 + h2. @returns {Float64Array} length 32 */
export function headerSums(soft) {
  const s = new Float64Array(32);
  for (let j = 0; j < 32; j++) s[j] = soft[j] + soft[32 + j] + soft[64 + j];
  return s;
}

/** The 32-bit header length from the majority of the three copies (null if fewer than 96 values). */
export function headerLength(soft) {
  if (soft.length < HEADER_BITS) return null;
  const s = headerSums(soft);
  let v = 0;
  for (let j = 0; j < 32; j++) v = v * 2 + (s[j] > 0 ? 1 : 0);
  return v;
}

/**
 * Replica-combined body sums at a trial length, summed in replica order.
 * @param {Float64Array} soft channel soft values (length = capacity)
 * @param {number} bitLen body length in bits
 * @param {number} maxReplicas channel R
 * @returns {{replicas: number, sums: Float64Array}}
 */
export function bodySums(soft, bitLen, maxReplicas) {
  const r = replicaCount(soft.length, bitLen, maxReplicas);
  const sums = new Float64Array(bitLen);
  for (let j = 0; j < bitLen; j++) sums[j] = soft[HEADER_BITS + j];
  for (let q = 1; q < r; q++) {
    const o = HEADER_BITS + q * bitLen;
    for (let j = 0; j < bitLen; j++) sums[j] += soft[o + j];
  }
  return { replicas: r, sums };
}

/** Hard payload bytes at a trial length: sum > 0 is bit 1. */
export function decodeBody(soft, bitLen, maxReplicas) {
  const { sums } = bodySums(soft, bitLen, maxReplicas);
  return bitsToBytes(sums.map((v) => (v > 0 ? 1 : 0)));
}

/** Shortest payload in bits (empty message): 8 * 96. */
export const MIN_PAYLOAD_BITS = 8 * OVERHEAD;

/**
 * Candidate payload lengths (bits) of one channel in format §8 order.
 * Search verifier: the header length first, if it is a multiple of 8 in
 * [768, 8 * (96 + max_msg_len)] and fits, then every message length 0..max_msg_len that fits.
 * Header verifier (legacy HybridCoder rule): the header length only, if non-zero, a multiple
 * of 8, and it fits.
 * @returns {{path: 'header'|'search', bits: number, m: number|null}[]}
 */
export function candidateLengths(soft, opt) {
  const cap = soft.length;
  const ell = headerLength(soft);
  const mOf = (bits) => (bits / 8 >= OVERHEAD ? bits / 8 - OVERHEAD : null);
  const out = [];
  if (opt.verifier === 'header') {
    if (ell !== null && ell !== 0 && ell <= cap - HEADER_BITS && ell % 8 === 0) out.push({ path: 'header', bits: ell, m: mOf(ell) });
    return out;
  }
  if (opt.verifier !== 'search') throw new RangeError("verifier must be 'search' or 'header'");
  const hi = 8 * (OVERHEAD + opt.max_msg_len);
  if (ell !== null && ell % 8 === 0 && ell >= MIN_PAYLOAD_BITS && ell <= hi && ell <= cap - HEADER_BITS) {
    out.push({ path: 'header', bits: ell, m: mOf(ell) });
  }
  for (let m = 0; m <= opt.max_msg_len; m++) {
    const bits = 8 * (m + OVERHEAD);
    if (cap - HEADER_BITS < bits) break;
    out.push({ path: 'search', bits, m });
  }
  return out;
}

/**
 * All payload candidates of one channel as bytes, in order (Python `extract_payload_candidates`).
 * @returns {{path: string, bits: number, m: number|null, bytes: Uint8Array}[]}
 */
export function extractPayloadCandidates(soft, maxReplicas, options = {}) {
  const opt = defaultOptions(options);
  return candidateLengths(soft, opt).map((c) => ({ ...c, bytes: decodeBody(soft, c.bits, maxReplicas) }));
}

const dec = new TextDecoder('utf-8', { fatal: false });
const hex = (b) => Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('');
const keyOf = (b) => String.fromCharCode.apply(null, b);

/**
 * State of one verify call: global de-duplication of candidate byte strings (across
 * profiles, channels and alignments) plus the work counters (Python `_Search`).
 */
class Search {
  constructor(publicKey, seed, profiles, opt, trace) {
    this.publicKey = publicKey;
    this.opt = opt;
    this.seed = seed;
    this.profiles = profiles.map((p) => ({ prof: p, lay: makeLayout(seed, p) }));
    this.seen = new Set();
    this.candidates_tried = 0;
    this.rs_passes = 0;
    this.sig_checks = 0;
    this.anyCandidatePossible = false;
    this.trace = trace;
  }

  counters() {
    return { candidates_tried: this.candidates_tried, rs_passes: this.rs_passes, sig_checks: this.sig_checks };
  }

  /** Section 8 steps 1 to 3 on one analysis for every profile; the first acceptance wins. */
  run(an, pathOverride = null, alignment = null) {
    for (const { prof, lay } of this.profiles) {
      const soft = softFromAnalysis(an, this.seed, prof, this.opt, lay);
      for (const channel of CHANNELS) {
        const s = channel === 'phase' ? soft.phase : soft.magnitude;
        const R = channel === 'phase' ? prof.rp : prof.rm;
        if (s.length - HEADER_BITS >= MIN_PAYLOAD_BITS) this.anyCandidatePossible = true;
        const tr = this.trace
          ? {
              profile: prof.name, channel, alignment, capacity: s.length, soft: s,
              header_sums: s.length >= HEADER_BITS ? headerSums(s) : null, header_length: headerLength(s), candidates: [],
            }
          : null;
        if (tr) this.trace.attempts.push(tr);
        for (const c of candidateLengths(s, this.opt)) {
          const { replicas, sums } = bodySums(s, c.bits, R);
          const bytes = bitsToBytes(sums.map((v) => (v > 0 ? 1 : 0)));
          const key = keyOf(bytes);
          if (this.seen.has(key)) {
            if (tr) tr.candidates.push({ path: c.path, m: c.m, bits: c.bits, replicas, duplicate: true });
            continue;
          }
          this.seen.add(key);
          this.candidates_tried++;
          const r = parsePayload(bytes, this.publicKey);
          if (r.rs_ok) this.rs_passes++;
          if (r.sig_checked) this.sig_checks++;
          if (tr) {
            tr.candidates.push({
              path: c.path, m: c.m, bits: c.bits, replicas, duplicate: false, rs_ok: r.rs_ok,
              rs_corrected: r.rs_corrected, sig_checked: r.sig_checked, ok: r.ok, reason: r.reason,
            });
          }
          if (r.ok) {
            if (tr) tr.accepted = { path: c.path, m: c.m, bits: c.bits, replicas, body_sums: sums, payload: bytes, signature: r.signature };
            return {
              verified: true,
              message: dec.decode(r.message),
              message_hex: hex(r.message),
              message_bytes: r.message,
              channel,
              profile: prof.name,
              path: pathOverride ?? c.path,
              rs_corrected: r.rs_corrected,
              payload_bits: c.bits,
              ...this.counters(),
              reason: 'ok',
            };
          }
        }
      }
    }
    return null;
  }

  failure(nSamples) {
    let reason;
    if (this.candidates_tried === 0) {
      reason = this.anyCandidatePossible
        ? 'no candidate: header length invalid and search disabled'
        : `too short: ${nSamples} samples cannot carry the smallest payload (${HEADER_BITS + MIN_PAYLOAD_BITS} bits per channel)`;
    } else if (this.sig_checks) {
      reason = `signature invalid (${this.sig_checks} candidate(s) passed RS with a consistent length; none verified under this public key)`;
    } else if (this.rs_passes) {
      reason = `length field inconsistent (${this.rs_passes} RS-decodable candidate(s))`;
    } else {
      reason = `no candidate passed RS decoding (${this.candidates_tried} tried)`;
    }
    return {
      verified: false, message: null, message_hex: null, message_bytes: null, channel: null, profile: null, path: null,
      rs_corrected: null, payload_bits: null, ...this.counters(), reason,
    };
  }
}

/**
 * Blind verification with the public key only (format §8, Python `verify`).
 * @param {ArrayLike<number>} samples mono float samples
 * @param {number} sampleRate must be 44100
 * @param {Uint8Array} publicKey 32 bytes
 * @param {object} [o]
 * @param {string|import('./layout.js').Profile|null} [o.profile] given profile, or null for wb then nb
 * @param {Partial<import('./layout.js').Options>} [o.options]
 * @param {boolean} [o.resync] also search sample offsets and frame skips when the plain alignment fails
 * @param {object|null} [o.trace] filled with soft values, header sums and every candidate
 * @returns {{verified: boolean, message: string|null, message_hex: string|null, message_bytes: Uint8Array|null,
 *   channel: string|null, profile: string|null, path: string|null, rs_corrected: number|null,
 *   payload_bits: number|null, candidates_tried: number, rs_passes: number, sig_checks: number,
 *   reason: string, offset?: {delta: number, f0: number, samples: number}}}
 */
export function verifySamples(samples, sampleRate, publicKey, { profile = null, options = {}, resync = false, trace = null } = {}) {
  if (sampleRate !== SAMPLE_RATE) throw new RangeError(`sample rate must be ${SAMPLE_RATE} Hz, got ${sampleRate}; resample first`);
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) throw new TypeError('publicKey must be 32 bytes');
  const x = toFloat64(samples);
  const opt = defaultOptions(options);
  const profiles = profile === null || profile === undefined ? [WB, NB] : [getProfile(profile)];
  if (trace) Object.assign(trace, { attempts: [], resync: null });
  const st = new Search(publicKey, resolveSeed(opt, publicKey), profiles, opt, trace);
  const r = st.run(analyze(x));
  if (r) return r;
  if (resync) {
    const rr = resyncSearch(x, st, analyze);
    if (rr) return rr;
  }
  return st.failure(x.length);
}
