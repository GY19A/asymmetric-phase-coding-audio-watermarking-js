// Real FFT against numpy pocketfft (tests/oracle/fft_*.f64), tolerance 1e-9.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RealFFT, getFFT } from '../src/lib/fft.js';
import { wrapPhase, roundHalfEven, frameCount, mean8 } from '../src/lib/stft.js';
import { oracleJSON, oracleF64 } from './helpers.js';

const N = 2048;
const B = N / 2 + 1;
const TOL = 1e-9;

function rows() {
  const { frames } = oracleJSON('fft.json');
  return { frames, x: oracleF64('fft_in.f64'), z: oracleF64('fft_out.f64'), ang: oracleF64('fft_angle.f64'), inv: oracleF64('fft_irfft.f64') };
}

test('rfft equals numpy on 4 frames (noise, pure bin-100 tone, impulse, speech)', () => {
  const { frames, x, z } = rows();
  const fft = getFFT(N);
  const re = new Float64Array(B);
  const im = new Float64Array(B);
  let worst = 0;
  for (let f = 0; f < frames; f++) {
    fft.forward(x, re, im, f * N);
    for (let k = 0; k < B; k++) {
      worst = Math.max(worst, Math.abs(re[k] - z[2 * (f * B + k)]), Math.abs(im[k] - z[2 * (f * B + k) + 1]));
    }
  }
  assert.ok(worst <= TOL, `max |rfft - numpy| = ${worst}`);
});

test('angle(rfft) equals numpy (sign convention e^{-i})', () => {
  const { frames, x, ang } = rows();
  const fft = getFFT(N);
  const re = new Float64Array(B);
  const im = new Float64Array(B);
  let worst = 0;
  for (let f = 0; f < frames; f++) {
    fft.forward(x, re, im, f * N);
    for (let k = 0; k < B; k++) {
      const a = Math.atan2(im[k], re[k]);
      const ref = ang[f * B + k];
      // atan2 near the branch cut can differ by 2 pi when |im| is at rounding level
      let d = Math.abs(a - ref);
      if (d > Math.PI) d = Math.abs(d - 2 * Math.PI);
      if (Math.hypot(re[k], im[k]) > 1e-6) worst = Math.max(worst, d);
    }
  }
  assert.ok(worst <= 1e-9, `max angle error ${worst}`);
  // a pure cosine at bin 100 has phase 0 there
  fft.forward(x, re, im, N);
  assert.ok(Math.abs(re[100] - N / 2) < 1e-9 && Math.abs(im[100]) < 1e-9);
});

test('irfft(rfft(x) * e^{0.5i}) equals numpy', () => {
  const { frames, x, inv } = rows();
  const fft = getFFT(N);
  const re = new Float64Array(B);
  const im = new Float64Array(B);
  const out = new Float64Array(N);
  const c = Math.cos(0.5);
  const s = Math.sin(0.5);
  let worst = 0;
  for (let f = 0; f < frames; f++) {
    fft.forward(x, re, im, f * N);
    for (let k = 0; k < B; k++) {
      const r = re[k] * c - im[k] * s;
      im[k] = re[k] * s + im[k] * c;
      re[k] = r;
    }
    fft.inverse(re, im, out, 0);
    for (let i = 0; i < N; i++) worst = Math.max(worst, Math.abs(out[i] - inv[f * N + i]));
  }
  assert.ok(worst <= TOL, `max |irfft - numpy| = ${worst}`);
});

test('forward then inverse is the identity; other powers of two work', () => {
  for (const n of [8, 64, 2048, 4096]) {
    const fft = new RealFFT(n);
    const x = Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.37) + ((i * 7919) % 13) / 13);
    const re = new Float64Array(n / 2 + 1);
    const im = new Float64Array(n / 2 + 1);
    const y = new Float64Array(n);
    fft.forward(x, re, im, 0);
    fft.inverse(re, im, y, 0);
    for (let i = 0; i < n; i++) assert.ok(Math.abs(x[i] - y[i]) < 1e-12, `n=${n} i=${i}`);
  }
  assert.throws(() => new RealFFT(1000), /power of two/);
});

test('numpy helpers: round half to even, phase wrap, frame count, sequential mean', () => {
  // numpy gives -0.0 for -0.5; the sign of zero never matters here, so compare with +0
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 2.4999, 2.5001].map((v) => roundHalfEven(v) + 0), [0, 2, 2, 0, -2, -2, 2, 3]);
  // (p + pi) % 2pi - pi with Python's remainder sign
  assert.equal(wrapPhase(Math.PI), -Math.PI);
  assert.equal(wrapPhase(-Math.PI), -Math.PI);
  assert.ok(Math.abs(wrapPhase(3 * Math.PI / 2) + Math.PI / 2) < 1e-15);
  assert.ok(Math.abs(wrapPhase(-7) - (-7 + 2 * Math.PI)) < 1e-15);
  assert.equal(frameCount(2047), 0);
  assert.equal(frameCount(2048), 1);
  assert.equal(frameCount(441000), 215);
  const a = Float64Array.from({ length: 16 }, (_, i) => 0.1 * i);
  let acc = a[1];
  for (let j = 1; j < 8; j++) acc += a[1 + 2 * j];
  assert.equal(mean8(a, 1, 2), acc / 8);
});
