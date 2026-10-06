/**
 * apcaw-js: Asymmetric Phase Coding Audio Watermarking (format apcaw-v1).
 *
 * Public API. Names and result keys mirror the Python reference (`apcaw`) and the Rust port.
 * @module apcaw
 */

import { keygen as edKeygen, publicKeyOf, edVerify } from './ed25519.js';
import { loadSecretKey, loadPublicKey, secretPem, publicPem } from './keys.js';
import {
  WB, NB, PROFILES, SAMPLE_RATE, N_FFT, GROUP, HEADER_BITS, MAX_MSG_LEN, getProfile,
  defaultOptions, legacyOptions, seedFromPublicKey, resolveSeed, phaseBins, magPairs, makeLayout, layout as layoutOf,
} from './layout.js';
import {
  buildPayload as buildPayloadRaw, parsePayload as parsePayloadRaw, splitPayload, messageBytes, bytesToBits,
  bitsToBytes, headerBits, OVERHEAD, SIG_LEN,
} from './payload.js';
import { embedPayload, embedBits, capacity, buildStream, replicaCount, toFloat64, TooShortError } from './embed.js';
import {
  verifySamples, readSoft, analyze, softFromAnalysis, headerLength, headerSums, bodySums, decodeBody,
  candidateLengths, extractPayloadCandidates, CHANNELS, MIN_PAYLOAD_BITS,
} from './verify.js';
import { scoreGrid, deltaOrder, FMAX, SCORE_GROUPS, TOPK_DELTA, SCORE_FRAMES } from './resync.js';
import { rsEncode, rsDecode, ReedSolomonError, NSYM } from './rs.js';

export const FORMAT = 'apcaw-v1';
export const VERSION = '1.0.0';

function checkRate(sampleRate) {
  if (sampleRate !== SAMPLE_RATE) {
    throw new RangeError(`sample rate must be ${SAMPLE_RATE} Hz, got ${sampleRate}; resample first (see resample.js)`);
  }
}

/**
 * A new Ed25519 identity, or the one of a fixed 32-byte seed (tests, vectors).
 * Randomness comes from crypto.getRandomValues, which works on plain http:// origins.
 * @param {Uint8Array|string} [seed] 32 bytes or 64 hex digits
 * @returns {{secretKey: Uint8Array, publicKey: Uint8Array}}
 */
export function keygen(seed) {
  return edKeygen(seed === undefined || seed === null ? undefined : loadSecretKey(seed));
}

/**
 * Sign a mono 44.1 kHz clip: build the signed payload and embed it in both channels.
 * The layout seed is derived from the public key of `secretKey` unless options.seed is set.
 * @param {ArrayLike<number>} samples mono float samples in [-1, 1]
 * @param {number} sampleRate must be 44100
 * @param {Uint8Array|string} secretKey 32-byte Ed25519 secret seed (raw, hex or PKCS#8 PEM)
 * @param {string|Uint8Array} message at most 159 bytes (UTF-8 for strings)
 * @param {object} [o]
 * @param {string|import('./layout.js').Profile} [o.profile] 'wb' (default) or 'nb'
 * @param {Partial<import('./layout.js').Options>} [o.options]
 * @param {object|null} [o.trace] filled with the payload, streams, layout and per-bit values
 * @returns {Float64Array} signed samples, same length as the input (not clipped or quantized)
 */
export function sign(samples, sampleRate, secretKey, message, { profile = 'wb', options = {}, trace = null } = {}) {
  checkRate(sampleRate);
  const x = toFloat64(samples);
  const prof = getProfile(profile);
  const opt = defaultOptions(options);
  const sk = loadSecretKey(secretKey);
  const m = messageBytes(message);
  if (m.length > opt.max_msg_len) throw new RangeError(`message too long: ${m.length} bytes > max_msg_len ${opt.max_msg_len}`);
  const payload = buildPayloadRaw(m, sk);
  const need = HEADER_BITS + 8 * payload.length;
  const cap = capacity(x.length, prof);
  if (Math.min(cap.phase, cap.magnitude) < need) {
    throw new TooShortError(
      `too short: ${x.length} samples give ${cap.groups} groups; profile ${prof.name} needs ` +
        `${need} bits per channel (phase cap ${cap.phase}, magnitude cap ${cap.magnitude})`,
    );
  }
  const pk = publicKeyOf(sk);
  const seed = resolveSeed(opt, pk);
  if (trace) {
    trace.public_key = pk;
    trace.message = m;
    trace.parts = splitPayload(payload);
  }
  return embedPayload(x, payload, seed, prof, opt, trace);
}

/**
 * Blind verification with the public key only (format §8).
 * Result keys: verified, message, message_hex, channel, profile, path, rs_corrected,
 * payload_bits, candidates_tried, rs_passes, sig_checks, reason. A resync success also
 * carries offset {delta, f0, samples}.
 * @param {ArrayLike<number>} samples
 * @param {number} sampleRate must be 44100
 * @param {Uint8Array|string} publicKey raw 32 bytes, 64 hex digits or SPKI PEM
 * @param {{profile?: string|null, options?: object, resync?: boolean, trace?: object|null}} [o]
 */
export function verify(samples, sampleRate, publicKey, o = {}) {
  checkRate(sampleRate);
  return verifySamples(samples, sampleRate, loadPublicKey(publicKey), o);
}

/** Signed payload bytes of a message (Python `build_payload`). */
export function buildPayload(message, secretKey) {
  return buildPayloadRaw(message, loadSecretKey(secretKey));
}

/** Decode and check a payload candidate (Python `parse_payload`). Never throws on bad data. */
export function parsePayload(bytes, publicKey) {
  return parsePayloadRaw(bytes, loadPublicKey(publicKey));
}

/**
 * Phase bins and magnitude pairs of a key (Python `apcaw layout --json`). With a profile,
 * {profile, seed, phase_bins, mag_pairs}; with profile null, {seed, wb: {...}, nb: {...}}.
 * @param {Uint8Array|string|null} publicKey ignored when options.seed is set
 */
export function layout(publicKey, profile = 'wb', options = {}) {
  const opt = defaultOptions(options);
  return layoutOf(opt.seed === null || opt.seed === undefined ? loadPublicKey(publicKey) : null, profile, opt);
}

/**
 * Per-channel soft statistics without a decision (Python `apcaw inspect --json`, without `file`).
 * @param {ArrayLike<number>} samples
 * @param {number} sampleRate
 * @param {Uint8Array|string} publicKey
 * @param {{options?: object}} [o]
 */
export function inspect(samples, sampleRate, publicKey, { options = {} } = {}) {
  checkRate(sampleRate);
  const opt = defaultOptions(options);
  const x = toFloat64(samples);
  const pk = opt.seed === null || opt.seed === undefined ? loadPublicKey(publicKey) : null;
  const seed = resolveSeed(opt, pk);
  const an = analyze(x);
  const rep = { samples: x.length, frames: an.frames, seed, profiles: {} };
  for (const [name, prof] of Object.entries(PROFILES)) {
    const cap = capacity(x.length, prof);
    const soft = softFromAnalysis(an, seed, prof, opt);
    const ent = { groups: cap.groups, frames: cap.frames };
    for (const [ch, s, R] of [['phase', soft.phase, prof.rp], ['magnitude', soft.magnitude, prof.rm]]) {
      const ell = headerLength(s);
      let n = s.length;
      if (ell !== null && ell % 8 === 0 && ell >= MIN_PAYLOAD_BITS && ell <= s.length - HEADER_BITS) {
        n = HEADER_BITS + replicaCount(s.length, ell, R) * ell;
      }
      let erased = 0;
      for (let i = 0; i < s.length; i++) if (s[i] === 0) erased++;
      ent[ch] = {
        capacity: s.length,
        header_length: ell,
        stream_bits: n,
        mean_abs_soft: n ? meanAbs(s, n) : null,
        mean_abs_soft_capacity: s.length ? meanAbs(s, s.length) : null,
        erased,
      };
    }
    rep.profiles[name] = ent;
  }
  return rep;
}

function meanAbs(s, n) {
  let a = 0;
  for (let i = 0; i < n; i++) a += Math.abs(s[i]);
  return a / n;
}

export {
  publicKeyOf, edVerify, loadSecretKey, loadPublicKey, secretPem, publicPem,
  WB, NB, PROFILES, SAMPLE_RATE, N_FFT, GROUP, HEADER_BITS, MAX_MSG_LEN, OVERHEAD, SIG_LEN, NSYM, CHANNELS,
  MIN_PAYLOAD_BITS, getProfile, defaultOptions, legacyOptions, seedFromPublicKey, resolveSeed, phaseBins, magPairs,
  makeLayout, splitPayload, messageBytes, bytesToBits, bitsToBytes, headerBits,
  embedPayload, embedBits, capacity, buildStream, replicaCount, TooShortError,
  readSoft, analyze, softFromAnalysis, headerLength, headerSums, bodySums, decodeBody,
  candidateLengths, extractPayloadCandidates, scoreGrid, deltaOrder, FMAX, SCORE_GROUPS, TOPK_DELTA, SCORE_FRAMES,
  rsEncode, rsDecode, ReedSolomonError,
};
export { parseWav, writeWav, mixToMono, quantize, quantizeSample } from './wav.js';
export { resample } from './resample.js';

/** Lowercase hex of bytes. */
export function toHex(bytes) {
  return Array.from(bytes, (v) => v.toString(16).padStart(2, '0')).join('');
}

/** Bytes of a hex string (whitespace ignored). */
export function fromHex(hex) {
  const h = hex.replace(/\s+/g, '');
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new TypeError('invalid hex string');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}
