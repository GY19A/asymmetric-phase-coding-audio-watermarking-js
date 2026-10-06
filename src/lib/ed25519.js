/**
 * Ed25519 (RFC 8032) on top of `@noble/ed25519`, with a cofactorless verifier.
 *
 * Signing is noble's deterministic RFC 8032 signing, which is byte-identical to
 * OpenSSL (used by the Python reference through `cryptography`).
 *
 * Verification does not use noble's `verify`, because noble checks the
 * cofactored equation [8][S]B = [8]R + [8][k]A (even with `zip215: false`).
 * The Python reference accepts a signature iff the cofactorless check passes,
 * as OpenSSL does it: S < L, A decodes, R' = [S]B - [k]A, and the encoding of
 * R' equals the first 32 signature bytes. A signature that passes only the
 * cofactored check is therefore rejected here too (see tests/ed25519.test.js).
 * No WebCrypto is needed, so this works from plain http:// origins.
 * @module ed25519
 */

import * as ed from '@noble/ed25519';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = sha512;

const L = 0x1000000000000000000000000000000014def9dea2f79cd65812631a5cf5d3edn;
const G = ed.Point.BASE;

function bytesToNumberLE(b) {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

function asBytes(x, len, what) {
  if (!(x instanceof Uint8Array)) throw new TypeError(`${what} must be a Uint8Array`);
  if (len !== undefined && x.length !== len) throw new RangeError(`${what} must be ${len} bytes, got ${x.length}`);
  return x;
}

/**
 * @param {Uint8Array} [seed] optional 32-byte secret seed (returned verbatim)
 * @returns {{secretKey: Uint8Array, publicKey: Uint8Array}}
 */
export function keygen(seed) {
  if (seed !== undefined && seed !== null) asBytes(seed, 32, 'seed');
  const { secretKey, publicKey } = ed.keygen(seed ?? undefined);
  return { secretKey: Uint8Array.from(secretKey), publicKey: Uint8Array.from(publicKey) };
}

/** @param {Uint8Array} secretKey 32-byte seed @returns {Uint8Array} 32-byte public key */
export function publicKeyOf(secretKey) {
  return ed.getPublicKey(asBytes(secretKey, 32, 'secretKey'));
}

/** @returns {Uint8Array} 64-byte deterministic signature */
export function edSign(message, secretKey) {
  return ed.sign(asBytes(message, undefined, 'message'), asBytes(secretKey, 32, 'secretKey'));
}

/**
 * Cofactorless RFC 8032 verification (OpenSSL acceptance rule).
 * @param {Uint8Array} signature 64 bytes
 * @param {Uint8Array} message
 * @param {Uint8Array} publicKey 32 bytes
 * @returns {boolean}
 */
export function edVerify(signature, message, publicKey) {
  if (!(signature instanceof Uint8Array) || signature.length !== 64) return false;
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 32) return false;
  const r = signature.subarray(0, 32);
  const S = bytesToNumberLE(signature.subarray(32, 64));
  if (S >= L) return false;
  let A;
  try {
    // OpenSSL's decoder reduces y mod p and tolerates x = 0 with the sign bit set,
    // which corresponds to noble's permissive (ZIP-215) decoding of A.
    A = ed.Point.fromBytes(publicKey, true);
  } catch {
    return false;
  }
  const k = bytesToNumberLE(sha512(concat(r, publicKey, message))) % L;
  const Rp = G.multiplyUnsafe(S).subtract(A.multiplyUnsafe(k));
  const enc = Rp.toBytes();
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= enc[i] ^ r[i];
  return diff === 0;
}

/**
 * Noble's cofactored check, exported only so tests can show the difference.
 * @returns {boolean}
 */
export function edVerifyCofactored(signature, message, publicKey) {
  try {
    return ed.verify(signature, message, publicKey, { zip215: false });
  } catch {
    return false;
  }
}

function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export { sha256, sha512 };
export const Point = ed.Point;
export const getExtendedPublicKey = ed.utils.getExtendedPublicKey;
export const CURVE_ORDER = L;
