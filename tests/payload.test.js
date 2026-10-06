// Payload bytes (format §4) and key encodings.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPayload, parsePayload, keygen, loadSecretKey, loadPublicKey, secretPem, publicPem, splitPayload,
  rsEncode, MAX_MSG_LEN,
} from '../src/lib/index.js';
import { publicKeyOf } from '../src/lib/ed25519.js';
import { publicKey } from '../src/lib/keys.js';
import { oracleJSON, A, B, NIPS_MSG, FIXED_SECRET, fromHex, toHex } from './helpers.js';

// Text written by Python `cryptography` for the secret seed 00 01 .. 1f.
const SK_PEM = '-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4f\n-----END PRIVATE KEY-----\n';
const PK_PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAA6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=\n-----END PUBLIC KEY-----\n';

test('payload bytes equal the Python reference for 6 messages (empty to 159 bytes, UTF-8)', () => {
  const o = oracleJSON('payload.json');
  assert.equal(toHex(A.publicKey), o.public_key_hex);
  for (const m of o.messages) {
    const msg = fromHex(m.message_hex);
    const p = buildPayload(msg, FIXED_SECRET);
    assert.equal(toHex(p), m.payload_hex, `message ${m.message_hex.slice(0, 20)}`);
    assert.equal(p.length, msg.length + 96);
    const parts = splitPayload(p);
    assert.equal(parts.length, msg.length);
    assert.equal(toHex(parts.signature), m.signature_hex);
    assert.equal(toHex(parts.parity), m.parity_hex);
  }
});

test('public keys and layout seeds of 4 secret seeds', () => {
  for (const k of oracleJSON('payload.json').keys) {
    assert.equal(toHex(publicKeyOf(fromHex(k.secret_seed_hex))), k.public_key_hex);
    assert.equal(toHex(keygen(k.secret_seed_hex).publicKey), k.public_key_hex);
  }
});

test('keys: raw, hex and PEM give the same bytes; PEM text equals cryptography', () => {
  assert.equal(secretPem(FIXED_SECRET), SK_PEM);
  assert.equal(publicPem(A.publicKey), PK_PEM);
  assert.deepEqual(loadSecretKey(SK_PEM), FIXED_SECRET);
  assert.deepEqual(loadSecretKey(new TextEncoder().encode(SK_PEM)), FIXED_SECRET);
  assert.deepEqual(loadSecretKey(toHex(FIXED_SECRET)), FIXED_SECRET);
  assert.deepEqual(loadSecretKey(new TextEncoder().encode(toHex(FIXED_SECRET) + '\n')), FIXED_SECRET);
  assert.deepEqual(loadPublicKey(PK_PEM), A.publicKey);
  assert.deepEqual(publicKey(SK_PEM), A.publicKey);
  assert.deepEqual(buildPayload(NIPS_MSG, SK_PEM), buildPayload(NIPS_MSG, FIXED_SECRET));
  assert.ok(parsePayload(buildPayload(NIPS_MSG, FIXED_SECRET), PK_PEM).ok);
  assert.throws(() => loadPublicKey(new Uint8Array(31)), /malformed public key/);
  assert.throws(() => loadPublicKey(SK_PEM), /not an Ed25519 public key PEM/);
  assert.throws(() => loadSecretKey('zz'.repeat(32)), /malformed secret key/);
});

test('keygen: fresh keys differ, a fixed seed is reproducible', () => {
  const k1 = keygen();
  const k2 = keygen();
  assert.equal(k1.secretKey.length, 32);
  assert.notDeepEqual(k1.secretKey, k2.secretKey);
  assert.deepEqual(keygen(FIXED_SECRET), A);
});

test('message length limit: 159 bytes pass, 160 throw', () => {
  assert.equal(MAX_MSG_LEN, 159);
  assert.equal(buildPayload('y'.repeat(159), FIXED_SECRET).length, 255);
  assert.throws(() => buildPayload('y'.repeat(160), FIXED_SECRET), /message too long/);
});

test('parse round trip and counters', () => {
  const r = parsePayload(buildPayload(NIPS_MSG, FIXED_SECRET), A.publicKey);
  assert.equal(r.ok, true);
  assert.equal(r.rs_ok, true);
  assert.equal(r.sig_checked, true);
  assert.equal(r.rs_corrected, 0);
  assert.equal(new TextDecoder().decode(r.message), NIPS_MSG);
});

test('tampering: up to 15 byte errors are repaired, 16 and 30 are not', () => {
  const p = buildPayload(NIPS_MSG, FIXED_SECRET);
  for (const [nerr, ok] of [[1, true], [15, true], [16, false], [30, false]]) {
    const q = Uint8Array.from(p);
    for (let i = 0; i < nerr; i++) q[(i * 7) % q.length] ^= 1 + ((i * 29) % 255);
    const r = parsePayload(q, A.publicKey);
    assert.equal(r.ok, ok, `${nerr} errors`);
    if (ok) assert.equal(r.rs_corrected, nerr);
    else assert.equal(r.rs_ok, false);
  }
});

test('wrong key: RS passes, Ed25519 rejects; a flipped signature bit is rejected after RS', () => {
  const p = buildPayload(NIPS_MSG, FIXED_SECRET);
  const r = parsePayload(p, B.publicKey);
  assert.deepEqual([r.ok, r.rs_ok, r.sig_checked, r.reason], [false, true, true, 'signature invalid']);
  // RS-encode a payload whose signature differs in one bit: RS is clean, the signature is not
  const inner = Uint8Array.from(p.subarray(0, p.length - 30));
  inner[2 + splitPayload(p).length + 5] ^= 1;
  const r2 = parsePayload(rsEncode(inner), A.publicKey);
  assert.deepEqual([r2.ok, r2.rs_ok, r2.rs_corrected, r2.sig_checked], [false, true, 0, true]);
});

test('length field inconsistent', () => {
  const p = buildPayload('abc', FIXED_SECRET);
  const inner = new Uint8Array(2 + 3 + 64);
  inner.set(p.subarray(0, 69));
  inner[1] = 4; // claims 4 message bytes, but 2 + 4 + 64 != 69
  const r = parsePayload(rsEncode(inner), A.publicKey);
  assert.deepEqual([r.ok, r.rs_ok, r.sig_checked, r.reason], [false, true, false, 'length field inconsistent']);
});
