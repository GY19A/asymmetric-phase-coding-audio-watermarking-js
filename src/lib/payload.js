/**
 * Signed payload: RS_encode(be16(len M) || M || Ed25519(sk, M)) (format §4).
 * @module payload
 */

import { edSign, edVerify, publicKeyOf } from './ed25519.js';
import { rsEncode, rsDecode, ReedSolomonError, NSYM } from './rs.js';
import { MAX_MSG_LEN } from './layout.js';

export const SIG_LEN = 64;
/** Payload bytes beyond the message: 2 (length) + 64 (signature) + 30 (parity). */
export const OVERHEAD = 2 + SIG_LEN + NSYM;

const enc = new TextEncoder();

/** @param {string|Uint8Array} message @returns {Uint8Array} */
export function messageBytes(message) {
  if (message instanceof Uint8Array) return message;
  if (typeof message === 'string') return enc.encode(message);
  throw new TypeError('message must be a string or Uint8Array');
}

/**
 * @param {string|Uint8Array} message
 * @param {Uint8Array} secretKey 32-byte Ed25519 seed
 * @returns {Uint8Array} payload of length len(M) + 96
 */
export function buildPayload(message, secretKey) {
  const m = messageBytes(message);
  if (m.length > MAX_MSG_LEN) throw new RangeError(`message too long: ${m.length} bytes > ${MAX_MSG_LEN}`);
  const sig = edSign(m, secretKey);
  const c = new Uint8Array(2 + m.length + SIG_LEN);
  c[0] = m.length >>> 8;
  c[1] = m.length & 0xff;
  c.set(m, 2);
  c.set(sig, 2 + m.length);
  return rsEncode(c);
}

/**
 * The pieces of a payload, for display.
 * @param {Uint8Array} payload
 */
export function splitPayload(payload) {
  const len = (payload[0] << 8) | payload[1];
  return {
    length: len,
    message: payload.subarray(2, 2 + len),
    signature: payload.subarray(2 + len, 2 + len + SIG_LEN),
    parity: payload.subarray(2 + len + SIG_LEN),
  };
}

/**
 * @typedef {object} ParseResult
 * @property {boolean} ok            RS passed, the length field fits and Ed25519 accepted
 * @property {Uint8Array|null} message
 * @property {boolean} rs_ok         Reed-Solomon decoding succeeded
 * @property {boolean} sig_checked   the length field was consistent, so Ed25519 was evaluated
 * @property {number|null} rs_corrected  number of corrected bytes
 * @property {string} reason        'ok', 'RS decoding failed', 'length field inconsistent' or 'signature invalid'
 * @property {Uint8Array|null} signature
 */

/**
 * Decode and check a payload candidate under a public key (Python `parse_payload`).
 * Never throws on bad data.
 * @param {Uint8Array} bytes
 * @param {Uint8Array} publicKey
 * @returns {ParseResult}
 */
export function parsePayload(bytes, publicKey) {
  const out = { ok: false, message: null, rs_ok: false, sig_checked: false, rs_corrected: null, reason: '', signature: null };
  let decoded;
  try {
    const r = rsDecode(bytes);
    decoded = r.decoded;
    out.rs_ok = true;
    out.rs_corrected = r.errata.length;
  } catch (e) {
    if (!(e instanceof ReedSolomonError) && !(e instanceof RangeError)) throw e;
    out.reason = 'RS decoding failed';
    return out;
  }
  const len = decoded.length >= 2 ? (decoded[0] << 8) | decoded[1] : -1;
  if (decoded.length < 2 || decoded.length !== 2 + len + SIG_LEN) {
    out.reason = 'length field inconsistent';
    return out;
  }
  const msg = decoded.slice(2, 2 + len);
  const sig = decoded.slice(2 + len);
  out.sig_checked = true;
  out.signature = sig;
  if (edVerify(sig, msg, publicKey)) {
    out.ok = true;
    out.message = msg;
    out.reason = 'ok';
  } else {
    out.reason = 'signature invalid';
  }
  return out;
}

export { publicKeyOf };

/** MSB-first bits of `bytes` (numpy `unpackbits`). @returns {Uint8Array} */
export function bytesToBits(bytes) {
  const out = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    for (let j = 0; j < 8; j++) out[8 * i + j] = (b >> (7 - j)) & 1;
  }
  return out;
}

/**
 * Pack `nBits` bits (numbers, 0 or non-zero) starting at `offset`, MSB first (numpy `packbits`).
 * @returns {Uint8Array}
 */
export function bitsToBytes(bits, offset = 0, nBits = bits.length - offset) {
  const out = new Uint8Array(Math.ceil(nBits / 8));
  for (let i = 0; i < nBits; i++) if (bits[offset + i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

/** The 32 header bits: be32 of the body length in bits. @returns {Uint8Array} */
export function headerBits(bodyBits) {
  const out = new Uint8Array(32);
  for (let j = 0; j < 32; j++) out[j] = Math.floor(bodyBits / 2 ** (31 - j)) & 1;
  return out;
}
