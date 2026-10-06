/**
 * Shared test fixtures: paths, keys, clips, the attack conditions of the NumPy oracle, and
 * loaders that fail loudly (never skip) when a reference file is missing.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

import { keygen, parseWav, quantize, fromHex, toHex } from '../src/lib/index.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ORACLE = path.join(ROOT, 'tests', 'oracle');
export const MEDIA = path.join(ROOT, 'public', 'media');
export const VECTORS = path.resolve(process.env.APC_VECTORS || path.join(ROOT, 'vectors'));

export const CLIPS = [
  '0000_librispeech_5639-40744-0030.wav',
  '0001_librispeech_8555-284447-0010.wav',
  '0002_librispeech_3570-5695-0012.wav',
];
export const SR = 44100;
export const NIPS_MSG = 'NIPS2026: Authenticity Token for Deepfake Defense';
export const FIXED_SECRET = Uint8Array.from({ length: 32 }, (_, i) => i);
export const OTHER_SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
export const A = keygen(FIXED_SECRET);
export const B = keygen(OTHER_SECRET);

export { fromHex, toHex };

function need(dir, what, names) {
  const missing = names.filter((n) => !existsSync(path.join(dir, n)));
  if (missing.length) {
    throw new Error(`${what} missing in ${dir}: ${missing.join(', ')}`);
  }
}

/** Throws (the test fails, it is not skipped) unless every named official vector exists. */
export function requireVectors(...names) {
  need(VECTORS, 'official conformance vector(s)', names);
}

/** Same for the NumPy oracle data in tests/oracle/. */
export function requireOracle(...names) {
  need(ORACLE, 'oracle file(s) in tests/oracle', names);
}

export function oracleJSON(name) {
  requireOracle(name);
  return JSON.parse(readFileSync(path.join(ORACLE, name), 'utf8'));
}

export function vectorJSON(name) {
  requireVectors(name);
  return JSON.parse(readFileSync(path.join(VECTORS, name), 'utf8'));
}

/** Raw little-endian float64 file as a Float64Array. */
export function readF64(file) {
  const b = readFileSync(file);
  assert.equal(b.length % 8, 0, `${file} is not a whole number of float64 values`);
  const out = new Float64Array(b.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = b.readDoubleLE(8 * i);
  return out;
}

export const oracleF64 = (name) => (requireOracle(name), readF64(path.join(ORACLE, name)));
export const vectorF64 = (name) => (requireVectors(name), readF64(path.join(VECTORS, name)));

/** Mono samples of a WAV file (asserts 44.1 kHz mono). */
export function readWavMono(file) {
  const w = parseWav(readFileSync(file));
  assert.equal(w.sampleRate, SR, `${file}: sample rate`);
  assert.equal(w.channels.length, 1, `${file}: channels`);
  return w.channels[0];
}

export const clip = (i) => readWavMono(path.join(MEDIA, CLIPS[i]));
export const vectorWav = (name) => (requireVectors(name), readWavMono(path.join(VECTORS, name)));

export const sha256hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function maxAbsDiff(a, b) {
  assert.equal(a.length, b.length, 'length mismatch');
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

/** Every stride-th sample, as the oracle stores signed audio. */
export function strided(x, stride) {
  const out = new Float64Array(Math.ceil(x.length / stride));
  for (let i = 0; i < out.length; i++) out[i] = x[i * stride];
  return out;
}

// Attack conditions, identical to the Python reference's test suite.
export const pcm16 = (y) => quantize(y, 16);
export const requant8 = (y) => quantize(y, 8);

export function cropHead(y, pct) {
  const out = Float64Array.from(y);
  out.fill(0, 0, Math.round((y.length * pct) / 100));
  return out;
}

export function cropTail(y, pct) {
  const cl = Math.floor(y.length * (1 - pct / 100));
  const out = new Float64Array(y.length);
  out.set(y.subarray(0, cl));
  return out;
}

export function padDelay(y, k) {
  const out = new Float64Array(y.length);
  out.set(y.subarray(0, y.length - k), k);
  return out;
}

/** The verify-result fields every implementation reports (Python `VerifyResult`). */
export const RESULT_KEYS = [
  'verified', 'message_hex', 'channel', 'profile', 'path', 'rs_corrected', 'payload_bits',
  'candidates_tried', 'rs_passes', 'sig_checks', 'reason',
];

export function pick(r, keys = RESULT_KEYS) {
  return Object.fromEntries(keys.map((k) => [k, r[k] ?? null]));
}

// ---------------------------------------------------------------- Ed25519 mixed-order case
const le32 = (n) => Uint8Array.from({ length: 32 }, (_, i) => Number((n >> BigInt(8 * i)) & 0xffn));
export const leNum = (b) => b.reduceRight((acc, v) => acc * 256n + BigInt(v), 0n);
export { le32 };

/**
 * A signature under a mixed-order public key A' = aB + T with T of order 8. The cofactorless
 * equation [S]B = R + [k]A' is off by [k]T (k mod 8 != 0), while the cofactored equation
 * [8][S]B = [8]R + [8][k]A' holds. RFC 8032 and OpenSSL (the Python reference) reject it.
 */
export async function mixedOrderCase() {
  const { Point, sha512, CURVE_ORDER } = await import('../src/lib/ed25519.js');
  const T = Point.fromHex('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05');
  const a = 0x1234567890abcdefn;
  const r = 0xfedcba0987654321n;
  const Ap = Point.BASE.multiply(a).add(T).toBytes();
  const R = Point.BASE.multiply(r).toBytes();
  for (let i = 0; ; i++) {
    const msg = new TextEncoder().encode(`mixed order ${i}`);
    const h = new Uint8Array(64 + msg.length);
    h.set(R);
    h.set(Ap, 32);
    h.set(msg, 64);
    const k = leNum(sha512(h)) % CURVE_ORDER;
    if (k % 8n === 0n) continue;
    const sig = new Uint8Array(64);
    sig.set(R);
    sig.set(le32((r + k * a) % CURVE_ORDER), 32);
    return { T, publicKey: Ap, message: msg, signature: sig };
  }
}
