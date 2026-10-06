// Official apcaw-v1 conformance vectors (vectors/, format §11). Every test here
// fails, it never skips, when a vector file is missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  sign, verify, readSoft, buildPayload, phaseBins, magPairs, legacyOptions, rsEncode, rsDecode, ReedSolomonError,
  seedFromPublicKey, buildStream, capacity, headerBits, bytesToBits, bitsToBytes, writeWav, WB, NB, fromHex, toHex,
} from '../src/lib/index.js';
import { rawOutputs } from '../src/lib/mt19937.js';
import { publicKeyOf } from '../src/lib/ed25519.js';
import {
  VECTORS, requireVectors, vectorJSON, vectorF64, vectorWav, sha256hex, maxAbsDiff, pick, SR,
} from './helpers.js';

const ALL = [
  'MANIFEST.json', 'README.md', 'clip_A.wav', 'clip_A_signed_legacy.wav', 'clip_A_signed_v1.f64', 'clip_A_signed_v1.npy',
  'clip_A_signed_v1.wav', 'clip_A_signed_v1_mp3.wav', 'layout.json', 'mt19937.json', 'negatives.json', 'payload.json',
  'rs.json', 'soft_A.json',
];
const TOL = 1e-9;
const bytesOf = (name) => (requireVectors(name), readFileSync(path.join(VECTORS, name)));

test('all vector files are present and match MANIFEST.json SHA-256 and sizes', () => {
  requireVectors(...ALL);
  const m = vectorJSON('MANIFEST.json');
  assert.equal(m.reedsolo, '1.7.0');
  assert.deepEqual(Object.keys(m.files).sort(), ALL.filter((n) => n !== 'MANIFEST.json').sort());
  for (const [name, { sha256, bytes }] of Object.entries(m.files)) {
    const b = bytesOf(name);
    assert.equal(b.length, bytes, `${name} size`);
    assert.equal(sha256hex(b), sha256, `${name} sha256`);
  }
});

test('mt19937.json: first 16 outputs for 5 seeds', () => {
  const { seeds } = vectorJSON('mt19937.json');
  assert.equal(seeds.length, 5);
  for (const { seed, outputs } of seeds) assert.deepEqual(rawOutputs(seed, 16), outputs, `seed ${seed}`);
});

test('layout.json: phase bins and magnitude pairs for 5 seeds, wb and nb', () => {
  const { seeds } = vectorJSON('layout.json');
  assert.deepEqual(seeds.map((s) => s.seed), [0, 1, 42, 4294967295, 1415792460]);
  for (const e of seeds) {
    for (const [name, prof] of [['wb', WB], ['nb', NB]]) {
      assert.deepEqual(Array.from(phaseBins(e.seed, prof)), e[name].phase_bins, `Kp seed ${e.seed} ${name}`);
      const mp = magPairs(e.seed, prof);
      assert.deepEqual(e[name].mag_pairs, Array.from({ length: prof.bm }, (_, i) => [mp[2 * i], mp[2 * i + 1]]));
    }
  }
});

test('payload.json: key, signatures, payloads, header bits and both wb streams of clip_A', () => {
  const v = vectorJSON('payload.json');
  const sk = fromHex(v.secret_seed_hex);
  const pk = publicKeyOf(sk);
  assert.equal(toHex(pk), v.public_key_hex);
  assert.equal(seedFromPublicKey(pk), v.key_seed);
  const cap = capacity(v.clip_A_capacity_wb.samples, 'wb');
  assert.deepEqual(cap, {
    frames: v.clip_A_capacity_wb.frames, groups: v.clip_A_capacity_wb.groups,
    phase: v.clip_A_capacity_wb.phase, magnitude: v.clip_A_capacity_wb.magnitude,
  });
  assert.deepEqual(v.messages.map((m) => m.message_len), [0, 1, 49, 159]);
  for (const m of v.messages) {
    const p = buildPayload(fromHex(m.message_hex), sk);
    assert.equal(toHex(p), m.payload_hex);
    assert.equal(toHex(p.subarray(2 + m.message_len, 2 + m.message_len + 64)), m.signature_hex);
    assert.equal(8 * p.length, m.payload_bits);
    assert.equal(Array.from(headerBits(m.payload_bits)).join(''), m.header_bits);
    const body = bytesToBits(p);
    for (const [ch, c, R] of [['phase', cap.phase, WB.rp], ['magnitude', cap.magnitude, WB.rm]]) {
      const ref = m.streams_clip_A_wb[ch];
      assert.equal(ref.capacity, c);
      const s = buildStream(body, c, R);
      assert.equal(s.length, ref.stream_len, `${ch} stream length, message ${m.message_len}`);
      assert.equal(s.length, 96 + ref.replicas * body.length);
      assert.equal(toHex(bitsToBytes(s)), ref.stream_hex, `${ch} stream bits, message ${m.message_len}`);
    }
  }
});

test('rs.json: codewords of 5 messages, 5/15/16 errors at the given positions', () => {
  const { cases } = vectorJSON('rs.json');
  assert.equal(cases.length, 5);
  for (const c of cases) {
    const cw = rsEncode(fromHex(c.message_hex));
    assert.equal(toHex(cw), c.codeword_hex);
    assert.deepEqual(c.corrupted.map((k) => k.n_errors), [5, 15, 16]);
    for (const k of c.corrupted) {
      const rx = fromHex(k.received_hex);
      const diff = [];
      for (let i = 0; i < rx.length; i++) if (rx[i] !== cw[i]) diff.push(i);
      assert.deepEqual(diff, k.positions);
      let got;
      try {
        const r = rsDecode(rx);
        got = { decodes: true, decoded_hex: toHex(r.decoded), n_corrected: r.errata.length };
      } catch (e) {
        if (!(e instanceof ReedSolomonError)) throw e;
        got = { decodes: false, decoded_hex: null, n_corrected: null };
      }
      assert.deepEqual(got, { decodes: k.decodes, decoded_hex: k.decoded_hex, n_corrected: k.n_corrected },
        `seed ${c.seed}, ${k.n_errors} errors`);
    }
  }
});

function paperMessage() {
  return fromHex(vectorJSON('payload.json').messages.find((m) => m.message_len === 49).message_hex);
}
const secret = () => fromHex(vectorJSON('payload.json').secret_seed_hex);

test('sign(clip_A) equals clip_A_signed_v1.f64 within 1e-9; the .npy holds the same samples', () => {
  const y = sign(vectorWav('clip_A.wav'), SR, secret(), paperMessage());
  const ref = vectorF64('clip_A_signed_v1.f64');
  const d = maxAbsDiff(y, ref);
  assert.ok(d <= TOL, `max |js - python| = ${d}`);
  const npy = bytesOf('clip_A_signed_v1.npy');
  const hdr = 10 + npy.readUInt16LE(8);
  assert.match(npy.subarray(10, hdr).toString('latin1'), /'descr': '<f8'/);
  assert.ok(npy.subarray(hdr).equals(bytesOf('clip_A_signed_v1.f64')));
});

test('the PCM16 WAV written by JS is byte-identical to clip_A_signed_v1.wav', () => {
  const y = sign(vectorWav('clip_A.wav'), SR, secret(), paperMessage());
  const wav = writeWav(y, SR, { format: 'pcm16' });
  assert.equal(sha256hex(wav), sha256hex(bytesOf('clip_A_signed_v1.wav')));
});

test('legacy sign (seed 42, 8 phase frames, zeroed tail) is byte-identical to clip_A_signed_legacy.wav', () => {
  const y = sign(vectorWav('clip_A.wav'), SR, secret(), paperMessage(), { options: legacyOptions() });
  assert.equal(sha256hex(writeWav(y, SR)), sha256hex(bytesOf('clip_A_signed_legacy.wav')));
});

test('soft_A.json: soft values within 1e-9 and verify results of the three signed WAVs (incl. MP3)', () => {
  const v = vectorJSON('soft_A.json');
  const pk = fromHex(v.public_key_hex);
  assert.deepEqual(v.files.map((f) => f.file), ['clip_A_signed_v1.wav', 'clip_A_signed_v1_mp3.wav', 'clip_A_signed_legacy.wav']);
  for (const f of v.files) {
    const y = vectorWav(f.file);
    const options = f.options === 'legacy' ? legacyOptions() : {};
    const seed = f.options === 'legacy' ? 42 : seedFromPublicKey(pk);
    const s = readSoft(y, seed, f.profile, options);
    const dp = maxAbsDiff(s.phase, f.phase_soft);
    const dm = maxAbsDiff(s.magnitude, f.mag_soft);
    assert.ok(dp <= TOL && dm <= TOL, `${f.file}: soft diff phase ${dp}, magnitude ${dm}`);
    const r = verify(y, SR, pk, { profile: f.options === 'legacy' ? f.profile : null, options });
    assert.deepEqual(pick(r), pick(f.verify), f.file);
  }
});

test('the MP3 round trip verifies with 2 corrected RS bytes', () => {
  const r = verify(vectorWav('clip_A_signed_v1_mp3.wav'), SR, vectorJSON('payload.json').public_key_hex);
  assert.equal(r.verified, true);
  assert.equal(r.rs_corrected, 2);
  assert.equal(r.message, 'NIPS2026: Authenticity Token for Deepfake Defense');
});

test('negatives.json: wrong key and unsigned audio, exact counters and reasons', () => {
  const { cases } = vectorJSON('negatives.json');
  assert.equal(cases.length, 2);
  for (const c of cases) {
    const r = verify(vectorWav(c.file), SR, fromHex(c.public_key_hex));
    assert.deepEqual(pick(r), pick(c), c.case);
  }
});
