// Key-derived layout (format §2, 3).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { layout, phaseBins, magPairs, seedFromPublicKey, WB, NB } from '../src/lib/index.js';
import { sha256 as sha256Of } from '../src/lib/ed25519.js';
import { oracleJSON, A, B, fromHex } from './helpers.js';

test('phase bins and magnitude pairs equal numpy for 8 seeds, both profiles', () => {
  const { seeds } = oracleJSON('layout.json');
  for (const e of seeds) {
    for (const [name, prof] of [['wb', WB], ['nb', NB]]) {
      assert.deepEqual(Array.from(phaseBins(e.seed, prof)), e[name].phase_bins, `Kp seed ${e.seed} ${name}`);
      const mp = magPairs(e.seed, prof);
      const pairs = [];
      for (let i = 0; i < mp.length; i += 2) pairs.push([mp[i], mp[i + 1]]);
      assert.deepEqual(pairs, e[name].mag_pairs, `pairs seed ${e.seed} ${name}`);
    }
  }
});

test('layout seed is SHA-256(pk)[:8] big-endian mod 2^32', () => {
  const { keys } = oracleJSON('payload.json');
  for (const k of keys) {
    const pk = fromHex(k.public_key_hex);
    assert.equal(seedFromPublicKey(pk), k.seed);
    const h = sha256Of(pk);
    const big = h.subarray(0, 8).reduce((acc, v) => acc * 256n + BigInt(v), 0n);
    assert.equal(BigInt(k.seed), big % 2n ** 32n);
  }
  assert.equal(seedFromPublicKey(A.publicKey), 1415792460);
});

test('profile geometry: wb 240 phase bins / 120 pairs, nb 240 / 76, overlap 2.15 to 6.46 kHz', () => {
  assert.equal(WB.bp, 240);
  assert.equal(WB.bm, 120);
  assert.equal(NB.bp, 240);
  assert.equal(NB.bm, 76);
  const hz = (k) => (k * 44100) / 2048;
  assert.equal(hz(WB.m_lo).toFixed(0), '2153');
  assert.equal(hz(WB.p_hi).toFixed(0), '6460');
});

test('layout() JSON shape and key dependence', () => {
  const la = layout(A.publicKey, null);
  const lb = layout(B.publicKey, null);
  assert.deepEqual(Object.keys(la), ['seed', 'wb', 'nb']);
  assert.equal(la.wb.phase_bins.length, 240);
  assert.equal(la.nb.mag_pairs.length, 76);
  assert.notDeepEqual(la.wb.phase_bins, lb.wb.phase_bins);
  const one = layout(A.publicKey, 'wb');
  assert.equal(one.profile, 'wb');
  assert.equal(one.seed, 1415792460);
  assert.deepEqual(layout(null, 'wb', { seed: 42 }).phase_bins, Array.from(phaseBins(42, WB)));
});

test('every phase bin and every magnitude bin is used exactly once', () => {
  for (const prof of [WB, NB]) {
    const kp = Array.from(phaseBins(1415792460, prof)).sort((a, b) => a - b);
    assert.deepEqual(kp, Array.from({ length: prof.bp }, (_, i) => prof.p_lo + i));
    const mp = Array.from(magPairs(1415792460, prof)).sort((a, b) => a - b);
    assert.deepEqual(mp, Array.from({ length: 2 * prof.bm }, (_, i) => prof.m_lo + i));
  }
});
