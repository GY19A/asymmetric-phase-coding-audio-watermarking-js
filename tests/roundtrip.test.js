// Sign and verify on the three bundled LibriSpeech clips, WAV I/O and the resampler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  sign, verify, keygen, parseWav, writeWav, resample, TooShortError, quantize,
} from '../src/lib/index.js';
import { clip, CLIPS, MEDIA, SR, FIXED_SECRET, A, B, NIPS_MSG, pcm16, maxAbsDiff } from './helpers.js';

test('the three bundled clips are 44.1 kHz mono PCM16 and have an attribution file', () => {
  for (const name of CLIPS) {
    const w = parseWav(readFileSync(path.join(MEDIA, name)));
    assert.deepEqual([w.sampleRate, w.channels.length, w.bitsPerSample, w.format], [SR, 1, 16, 'pcm']);
    assert.ok(w.channels[0].length > 5 * SR, `${name} is at least 5 s`);
  }
  const attr = readFileSync(path.join(MEDIA, 'ATTRIBUTION.txt'), 'utf8');
  assert.match(attr, /LibriSpeech/);
  assert.match(attr, /CC BY 4\.0/);
});

for (const [i, profile] of [[0, 'wb'], [1, 'wb'], [2, 'nb']]) {
  test(`round trip through a PCM16 WAV file: clip ${i}, ${profile}`, () => {
    const x = clip(i);
    const y = sign(x, SR, FIXED_SECRET, NIPS_MSG, { profile });
    const w = parseWav(writeWav(y, SR));
    // wb and nb share the phase bins, so pin the profile to check the one that was signed
    const r = verify(w.channels[0], SR, A.publicKey, { profile });
    assert.deepEqual([r.verified, r.message, r.profile], [true, NIPS_MSG, profile]);
    assert.equal(verify(w.channels[0], SR, A.publicKey).verified, true);
    assert.equal(verify(w.channels[0], SR, B.publicKey).verified, false);
    assert.equal(verify(x, SR, A.publicKey).verified, false);
  });
}

test('the same key signs another message; a fresh key round trips', () => {
  const y = pcm16(sign(clip(1), SR, FIXED_SECRET, 'A'));
  const r = verify(y, SR, A.publicKey);
  assert.deepEqual([r.verified, r.message, r.payload_bits], [true, 'A', 8 * 97]);
  const k = keygen();
  const y2 = pcm16(sign(clip(2), SR, k.secretKey, 'fresh key'));
  assert.equal(verify(y2, SR, k.publicKey).message, 'fresh key');
  assert.equal(verify(y2, SR, A.publicKey).verified, false);
});

test('too short: sign throws, verify reports why with zero candidates', () => {
  const z = new Float64Array(16384);
  assert.throws(() => sign(z, SR, FIXED_SECRET, NIPS_MSG), TooShortError);
  const r = verify(z, SR, A.publicKey);
  assert.equal(r.verified, false);
  assert.equal(r.candidates_tried, 0);
  assert.match(r.reason, /^too short: 16384 samples/);
});

test('WAV write/parse: PCM16 and PCM24 are exact after quantization, float32 within 2^-24', () => {
  const x = Float64Array.from({ length: 4000 }, (_, n) => 0.9 * Math.sin(n / 7) * Math.cos(n / 131));
  x[0] = 1.5; // clipped by the PCM writers
  x[1] = -1.5;
  for (const [format, bits] of [['pcm16', 16], ['pcm24', 24]]) {
    const w = parseWav(writeWav([x, x.map((v) => -v)], 48000, { format }));
    assert.deepEqual([w.sampleRate, w.channels.length, w.bitsPerSample, w.format], [48000, 2, bits, 'pcm']);
    assert.deepEqual(w.channels[0], quantize(x, bits));
    assert.deepEqual(w.channels[1], quantize(x.map((v) => -v), bits));
  }
  const w = parseWav(writeWav(x, SR, { format: 'float32' }));
  assert.equal(w.format, 'float');
  assert.equal(w.channels[0][0], 1.5);
  assert.ok(maxAbsDiff(w.channels[0], x) < 2 ** -24);
  assert.throws(() => parseWav(new Uint8Array(44)), /not a RIFF\/WAVE file/);
});

test('resample: identity at 44.1 kHz, a 1 kHz tone keeps its frequency and level from 48 kHz', () => {
  const x = Float64Array.from({ length: 48000 }, (_, n) => 0.5 * Math.sin((2 * Math.PI * 1000 * n) / 48000));
  assert.deepEqual(resample(x, SR), x.slice());
  const y = resample(x, 48000);
  assert.equal(y.length, SR);
  let worst = 0;
  for (let n = 2000; n < SR - 2000; n++) worst = Math.max(worst, Math.abs(y[n] - 0.5 * Math.sin((2 * Math.PI * 1000 * n) / SR)));
  assert.ok(worst < 1e-3, `interior error ${worst}`);
  const z = resample(Float64Array.from({ length: 22050 }, (_, n) => Math.sin(n / 3)), 22050);
  assert.equal(z.length, SR);
});
