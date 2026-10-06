// Optional decoder-side resync (format §8, off by default) on an integer-sample delay.
// Mirrors tests/test_resync.py of the Python reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sign, verify } from '../src/lib/index.js';
import { clip, SR, FIXED_SECRET, A, NIPS_MSG, padDelay } from './helpers.js';

const signed0 = sign(clip(0), SR, FIXED_SECRET, NIPS_MSG);

for (const shift of [5000, 2048 * 3]) {
  test(`resync recovers a ${shift}-sample delay`, () => {
    const yd = padDelay(signed0, shift);
    if (shift % 2048) assert.equal(verify(yd, SR, A.publicKey).verified, false);
    const r = verify(yd, SR, A.publicKey, { resync: true });
    assert.deepEqual([r.verified, r.path, r.message], [true, 'resync', NIPS_MSG]);
    assert.ok(r.reason.includes(`delta=${shift % 2048}`) && r.reason.includes(`f0=${Math.floor(shift / 2048)}`), r.reason);
    assert.deepEqual(r.offset, { delta: shift % 2048, f0: Math.floor(shift / 2048), samples: shift });
  });
}

test('resync is not used when the plain path verifies', () => {
  const r = verify(signed0, SR, A.publicKey, { resync: true });
  assert.deepEqual([r.verified, r.path], [true, 'header']);
  assert.equal(r.offset, undefined);
});

test('resync on unsigned audio does not verify', () => {
  const r = verify(clip(0), SR, A.publicKey, { resync: true });
  assert.equal(r.verified, false);
  assert.equal(r.message, null);
});
