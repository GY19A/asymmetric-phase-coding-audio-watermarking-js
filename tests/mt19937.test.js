// MT19937 and RandomState.shuffle against numpy (tests/oracle).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MT19937, rawOutputs, shuffledRange } from '../src/lib/mt19937.js';
import { oracleJSON } from './helpers.js';

test('MT19937 raw outputs equal numpy RandomState for 8 seeds x 700 draws', () => {
  const { seeds } = oracleJSON('mt19937.json');
  assert.equal(seeds.length, 8);
  for (const { seed, outputs } of seeds) {
    assert.deepEqual(rawOutputs(seed, outputs.length), outputs, `seed ${seed}`);
  }
});

test('the reference first output for seed 5489 (init_genrand default)', () => {
  assert.equal(new MT19937(5489).nextUint32(), 3499211612);
});

test('shuffle equals RandomState(seed).shuffle(arange(n)) including n = 1, 2, 255, 1000', () => {
  const { shuffles } = oracleJSON('layout.json');
  for (const { seed, n, perm } of shuffles) {
    assert.deepEqual(Array.from(shuffledRange(0, n, seed)), perm, `seed ${seed} n ${n}`);
  }
});

test('seeds are taken mod 2^32 as unsigned', () => {
  assert.deepEqual(rawOutputs(2 ** 32 - 1, 4), rawOutputs(-1 >>> 0, 4));
});
