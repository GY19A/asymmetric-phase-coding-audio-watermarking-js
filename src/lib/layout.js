/**
 * Profiles, options and the key-derived layout (format §2, 3).
 * @module layout
 */

import { sha256 } from './ed25519.js';
import { shuffledRange } from './mt19937.js';

/** STFT size and hop (samples). */
export const N_FFT = 2048;
/** Frames per group. */
export const GROUP = 8;
/** Number of rfft bins. */
export const N_BINS = N_FFT / 2 + 1;
/** Sample rate the format is defined at. */
export const SAMPLE_RATE = 44100;
/** Header length in bits (three copies of a 32-bit length). */
export const HEADER_BITS = 96;
/** Largest message the verifier searches for (bytes). */
export const MAX_MSG_LEN = 159;

/**
 * @typedef {object} Profile
 * @property {string} name   'wb' or 'nb'
 * @property {number} p_lo   first phase bin
 * @property {number} p_hi   one past the last phase bin
 * @property {number} m_lo   first magnitude bin
 * @property {number} m_hi   one past the last magnitude bin
 * @property {number} delta  QIM step in nats
 * @property {number} rp     max body replicas on the phase channel
 * @property {number} rm     max body replicas on the magnitude channel
 * @property {number} bp     phase bits per group (p_hi - p_lo)
 * @property {number} bm     magnitude bits per group (number of bin pairs)
 */

function makeProfile(name, p_lo, p_hi, m_lo, m_hi, delta, rp, rm) {
  const w = (m_hi - m_lo) - ((m_hi - m_lo) % 2);
  return Object.freeze({ name, p_lo, p_hi, m_lo, m_hi, delta, rp, rm, bp: p_hi - p_lo, bm: w / 2 });
}

/** @type {Profile} */
export const WB = makeProfile('wb', 60, 300, 100, 340, 1.0, 1, 5);
/** @type {Profile} */
export const NB = makeProfile('nb', 60, 300, 16, 168, 1.0, 1, 5);
export const PROFILES = Object.freeze({ wb: WB, nb: NB });

/**
 * @param {string|Profile} p
 * @returns {Profile}
 */
export function getProfile(p) {
  if (p && typeof p === 'object') {
    if (p.bp !== undefined) return p;
    return makeProfile(p.name ?? 'custom', p.p_lo, p.p_hi, p.m_lo, p.m_hi, p.delta ?? 1.0, p.rp ?? 1, p.rm ?? 5);
  }
  const prof = PROFILES[String(p).toLowerCase()];
  if (!prof) throw new RangeError(`unknown profile ${p}; expected 'wb' or 'nb'`);
  return prof;
}


/**
 * @typedef {object} Options
 * @property {number} phase_frames  1 (v1) or 8 (legacy): frames written per phase bit
 * @property {'search'|'header'} verifier  v1 protocol search or legacy header-only
 * @property {'passthrough'|'zero'} tail  samples after the last full frame
 * @property {number} erasure_tau  silent-bin erasure threshold (0 disables)
 * @property {number|null} seed  layout seed override (null = derive from the public key)
 * @property {number} max_msg_len  longest message the search tries
 */

/** v1 defaults. @returns {Options} */
export function defaultOptions(overrides = {}) {
  return {
    phase_frames: 1, verifier: 'search', tail: 'passthrough', erasure_tau: 1e-6, seed: null,
    max_msg_len: MAX_MSG_LEN, ...overrides,
  };
}

/** The legacy configuration: seed 42 as in the benchmark. @returns {Options} */
export function legacyOptions(overrides = {}) {
  return {
    phase_frames: 8, verifier: 'header', tail: 'zero', erasure_tau: 0, seed: 42,
    max_msg_len: MAX_MSG_LEN, ...overrides,
  };
}

/**
 * Layout seed: first 8 bytes of SHA-256(public key), big-endian, mod 2^32.
 * @param {Uint8Array} publicKey 32 bytes
 * @returns {number}
 */
export function seedFromPublicKey(publicKey) {
  const h = sha256(publicKey);
  // (x mod 2^32) of a big-endian 64-bit integer is its low 4 bytes.
  return ((h[4] << 24) | (h[5] << 16) | (h[6] << 8) | h[7]) >>> 0;
}

/** Effective seed for an options object and a public key. */
export function resolveSeed(options, publicKey) {
  if (options && options.seed !== null && options.seed !== undefined) return options.seed >>> 0;
  return seedFromPublicKey(publicKey);
}

/**
 * Shuffled phase carrier bins `Kp`.
 * @returns {Int32Array} length p_hi - p_lo
 */
export function phaseBins(seed, profile = WB) {
  const prof = getProfile(profile);
  return shuffledRange(prof.p_lo, prof.p_hi, seed);
}

/**
 * Magnitude pairs in slot order, flattened: [k1_0, k2_0, k1_1, k2_1, ...].
 * @returns {Int32Array} length 2 * Bm
 */
export function magPairs(seed, profile = WB) {
  const prof = getProfile(profile);
  const nPairs = prof.bm;
  const perm = shuffledRange(0, nPairs, ((seed ^ 0xdeadbeef) & 0xffffffff) >>> 0);
  const out = new Int32Array(2 * nPairs);
  for (let s = 0; s < nPairs; s++) {
    out[2 * s] = prof.m_lo + 2 * perm[s];
    out[2 * s + 1] = prof.m_lo + 2 * perm[s] + 1;
  }
  return out;
}

/**
 * Layout used by the embedder and the reader (Python `make_layout`).
 * @returns {{kp: Int32Array, pairs: Int32Array}} phase bins, and magnitude pairs flattened
 */
export function makeLayout(seed, profile = WB) {
  return { kp: phaseBins(seed, profile), pairs: magPairs(seed, profile) };
}

function layoutJSON(seed, prof) {
  const mp = magPairs(seed, prof);
  const pairs = [];
  for (let i = 0; i < mp.length; i += 2) pairs.push([mp[i], mp[i + 1]]);
  return { phase_bins: Array.from(phaseBins(seed, prof)), mag_pairs: pairs };
}

/**
 * Key-derived layout as plain JSON-friendly data.
 * With a profile: {profile, seed, phase_bins, mag_pairs}. With profile null: the
 * `apcaw layout --json` shape {seed, wb: {phase_bins, mag_pairs}, nb: {...}}.
 * @param {Uint8Array|null} publicKey
 * @param {string|Profile|null} [profile]
 * @param {{seed?: number|null}} [options]
 */
export function layout(publicKey, profile = 'wb', options = {}) {
  const seed = resolveSeed(options, publicKey);
  if (profile === null || profile === undefined) {
    const out = { seed };
    for (const [name, prof] of Object.entries(PROFILES)) out[name] = layoutJSON(seed, prof);
    return out;
  }
  const prof = getProfile(profile);
  return { profile: prof.name, seed, ...layoutJSON(seed, prof) };
}
