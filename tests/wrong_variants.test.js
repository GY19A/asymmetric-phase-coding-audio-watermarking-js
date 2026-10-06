// Deliberately wrong implementations and inputs. Each one must be caught: a port that made
// the same mistake would fail these checks (or the vector tests) instead of passing silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sign, verify, readSoft, embedPayload, embedBits, buildPayload, buildStream, capacity, bytesToBits, makeLayout,
  seedFromPublicKey, phaseBins, parsePayload, rsEncode, WB, N_FFT,
} from '../src/lib/index.js';
import { sha256, edVerify, edVerifyCofactored } from '../src/lib/ed25519.js';
import { clip, SR, FIXED_SECRET, A, B, NIPS_MSG, pcm16, vectorJSON, mixedOrderCase, maxAbsDiff } from './helpers.js';

const seedA = seedFromPublicKey(A.publicKey);

/** Hard-decision errors of a channel's soft values against the embedded stream. */
function bitErrors(soft, stream) {
  let e = 0;
  for (let i = 0; i < stream.length; i++) if ((soft[i] > 0 ? 1 : 0) !== stream[i]) e++;
  return e;
}

test('a layout with two phase bins or two magnitude pairs swapped produces raw bit errors', () => {
  const x = clip(1);
  const payload = buildPayload(NIPS_MSG, FIXED_SECRET);
  const good = makeLayout(seedA, WB);
  const trace = {};
  const y = pcm16(embedPayload(x, payload, seedA, WB, {}, trace, good));
  const ref = readSoft(y, seedA, WB);
  const base = [bitErrors(ref.phase, trace.phase.stream), bitErrors(ref.magnitude, trace.magnitude.stream)];

  const kp = Uint16Array.from(good.kp);
  [kp[0], kp[1]] = [kp[1], kp[0]];
  const y1 = pcm16(embedPayload(x, payload, seedA, WB, {}, null, { kp, pairs: good.pairs }));
  const s1 = readSoft(y1, seedA, WB);
  const ps = trace.phase.stream;
  let expected = 0;
  for (let i = 0; i + 1 < ps.length; i += WB.bp) expected += ps[i] !== ps[i + 1] ? 2 : 0;
  assert.ok(expected > 0);
  assert.ok(bitErrors(s1.phase, ps) >= base[0] + expected - 2, 'swapped phase bins must flip bits');

  // swap pair slots 0 and 1 (swapping the two bins inside one pair only negates d, and the
  // parity of round(d / delta) is symmetric, so that variant is invisible by design)
  const pairs = Uint16Array.from(good.pairs);
  [pairs[0], pairs[1], pairs[2], pairs[3]] = [pairs[2], pairs[3], pairs[0], pairs[1]];
  const y2 = pcm16(embedPayload(x, payload, seedA, WB, {}, null, { kp: good.kp, pairs }));
  const s2 = readSoft(y2, seedA, WB);
  const ms = trace.magnitude.stream;
  let flips = 0;
  for (let i = 0; i + 1 < ms.length; i += WB.bm) flips += ms[i] !== ms[i + 1] ? 2 : 0;
  assert.ok(flips > 0);
  assert.ok(bitErrors(s2.magnitude, ms) >= base[1] + flips - 4, 'swapped pairs must flip bits');
});

test("another key's payload on this key's layout: RS passes, the signature does not", () => {
  const y = pcm16(sign(clip(2), SR, B.secretKey, NIPS_MSG, { options: { seed: seedA } }));
  const r = verify(y, SR, A.publicKey);
  assert.equal(r.verified, false);
  assert.ok(r.rs_passes >= 1 && r.sig_checks >= 1, `rs_passes ${r.rs_passes}, sig_checks ${r.sig_checks}`);
  assert.match(r.reason, /^signature invalid/);
  assert.equal(verify(y, SR, B.publicKey, { options: { seed: seedA } }).verified, true);
  assert.equal(verify(y, SR, B.publicKey).verified, false, 'the layout is bound to the signing key');
});

test('a conjugated spectrum (wrong FFT sign) negates every phase soft value', () => {
  const y = pcm16(sign(clip(1), SR, FIXED_SECRET, NIPS_MSG));
  // x[(N - n) mod N] inside every frame has spectrum conj(X)
  const z = new Float64Array(y.length);
  const full = Math.floor(y.length / N_FFT) * N_FFT;
  for (let o = 0; o < full; o += N_FFT) for (let n = 0; n < N_FFT; n++) z[o + n] = y[o + ((N_FFT - n) % N_FFT)];
  const a = readSoft(y, seedA, WB);
  const b = readSoft(z, seedA, WB);
  let worst = 0;
  for (let i = 0; i < a.phase.length; i++) worst = Math.max(worst, Math.abs(a.phase[i] + b.phase[i]));
  assert.ok(worst < 1e-6, `phase soft of conj spectrum is the negation (worst ${worst})`);
  assert.ok(maxAbsDiff(a.magnitude, b.magnitude) < 1e-6, 'magnitudes are unchanged');
  const r = verify(z, SR, A.publicKey, { profile: 'wb' });
  assert.equal(r.verified, true);
  assert.equal(r.channel, 'magnitude', 'the phase channel must fail under the wrong sign');
});

test('a little-endian seed derivation gives a different layout than the vectors', () => {
  const h = sha256(A.publicKey);
  let le = 0n;
  for (let i = 7; i >= 0; i--) le = le * 256n + BigInt(h[i]);
  const wrongSeed = Number(le % 2n ** 32n);
  assert.notEqual(wrongSeed, seedA);
  const vec = vectorJSON('layout.json').seeds.find((s) => s.seed === 1415792460);
  assert.deepEqual(Array.from(phaseBins(seedA, WB)), vec.wb.phase_bins);
  assert.notDeepEqual(Array.from(phaseBins(wrongSeed, WB)), vec.wb.phase_bins);
  const y = pcm16(sign(clip(1), SR, FIXED_SECRET, NIPS_MSG));
  assert.equal(verify(y, SR, A.publicKey, { options: { seed: wrongSeed } }).verified, false);
});

test('legacy seed 42 does not verify under the key-derived layout, and does with seed 42', () => {
  const y = pcm16(sign(clip(0), SR, FIXED_SECRET, NIPS_MSG, { options: { seed: 42 } }));
  assert.equal(verify(y, SR, A.publicKey).verified, false);
  assert.equal(verify(y, SR, A.publicKey, { options: { seed: 42 } }).verified, true);
});

test('a cofactored verifier would accept a mixed-order payload; the format verifier rejects it', async () => {
  const { publicKey, message, signature } = await mixedOrderCase();
  assert.equal(edVerifyCofactored(signature, message, publicKey), true, 'the cofactored rule accepts');
  assert.equal(edVerify(signature, message, publicKey), false, 'the format rule rejects');
  const inner = new Uint8Array(2 + message.length + 64);
  inner[1] = message.length;
  inner.set(message, 2);
  inner.set(signature, 2 + message.length);
  const r = parsePayload(rsEncode(inner), publicKey);
  assert.deepEqual([r.ok, r.rs_ok, r.sig_checked, r.reason], [false, true, true, 'signature invalid']);
});

test('a corrupted header: the v1 search still verifies, the legacy header verifier does not', () => {
  const x = clip(1);
  const body = bytesToBits(buildPayload(NIPS_MSG, FIXED_SECRET));
  const cap = capacity(x.length, WB);
  const ps = buildStream(body, cap.phase, WB.rp);
  const ms = buildStream(body, cap.magnitude, WB.rm);
  for (let i = 0; i < 96; i++) {
    ps[i] ^= 1;
    ms[i] ^= 1;
  }
  const y = pcm16(embedBits(x, ps, ms, makeLayout(seedA, WB), WB));
  const r = verify(y, SR, A.publicKey);
  assert.deepEqual([r.verified, r.channel, r.path], [true, 'phase', 'search']);
  const h = verify(y, SR, A.publicKey, { options: { verifier: 'header' } });
  assert.equal(h.verified, false);
});
