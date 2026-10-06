// Silent-bin erasure (format §7): cells written into digital silence read as exactly 0
// in v1, instead of the legacy confident -1 (tau = 0). Mirrors tests/test_erasure.py of the Python reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sign, verify, readSoft, bodySums, buildPayload, buildStream, capacity, bytesToBits, seedFromPublicKey, WB,
} from '../src/lib/index.js';
import { clip, SR, FIXED_SECRET, A, NIPS_MSG } from './helpers.js';

const LEAD = 3 * SR; // 3 s of digital silence before the speech
const SILENT_GROUPS = Math.floor(LEAD / (2048 * 8)); // groups whose 8 frames lie in the zeros
const seed = seedFromPublicKey(A.publicKey);

const padded = [0, 1, 2].map((i) => {
  const x = clip(i);
  const xp = new Float64Array(LEAD + x.length);
  xp.set(x, LEAD);
  return sign(xp, SR, FIXED_SECRET, NIPS_MSG);
});

test('the signed output is exactly zero in the silence', () => {
  assert.equal(SILENT_GROUPS, 8);
  for (const y of padded) {
    for (let i = 0; i < SILENT_GROUPS * 8 * 2048; i++) if (y[i] !== 0) assert.fail(`sample ${i} is ${y[i]}`);
  }
});

test('silent positions are erased (0), the legacy reader returns a confident -1', () => {
  for (const y of padded) {
    const v1 = readSoft(y, seed, WB);
    const t0 = readSoft(y, seed, WB, { erasure_tau: 0 });
    const nm = SILENT_GROUPS * WB.bm;
    const np = SILENT_GROUPS * WB.bp;
    assert.ok(v1.magnitude.subarray(0, nm).every((v) => v === 0));
    assert.ok(t0.magnitude.subarray(0, nm).every((v) => v === -1));
    assert.ok(v1.phase.subarray(0, np).every((v) => v === 0));
    assert.ok(t0.phase.subarray(0, np).every((v) => v === 0));
    let differ = 0;
    let zeros = 0;
    for (let i = nm; i < v1.magnitude.length; i++) {
      if (v1.magnitude[i] !== t0.magnitude[i]) differ++;
      if (v1.magnitude[i] === 0) zeros++;
    }
    assert.ok(differ <= zeros);
  }
});

test('erasure never increases body bit errors', () => {
  const truth = bytesToBits(buildPayload(NIPS_MSG, FIXED_SECRET));
  for (const y of padded) {
    const cap = capacity(y.length, WB);
    const r = (buildStream(truth, cap.magnitude, WB.rm).length - 96) / truth.length;
    const errs = (soft) => {
      const { sums } = bodySums(soft, truth.length, r);
      let e = 0;
      for (let j = 0; j < truth.length; j++) e += (sums[j] > 0 ? 1 : 0) !== truth[j] ? 1 : 0;
      return e;
    };
    const e1 = errs(readSoft(y, seed, WB).magnitude);
    const e0 = errs(readSoft(y, seed, WB, { erasure_tau: 0 }).magnitude);
    assert.ok(e1 <= e0, `v1 ${e1} errors, tau 0 ${e0}`);
  }
});

test('v1 verifies despite a silent header; the header-only verifier does not', () => {
  for (const y of padded) {
    const r = verify(y, SR, A.publicKey);
    assert.deepEqual([r.verified, r.channel, r.path, r.message], [true, 'magnitude', 'search', NIPS_MSG]);
    assert.equal(verify(y, SR, A.publicKey, { options: { verifier: 'header' } }).verified, false);
  }
});
