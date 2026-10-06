// Embedding against the Python reference (tests/oracle/embed.json and *.f64), tolerance 1e-9.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sign, legacyOptions, embedPayload, buildPayload, capacity, makeLayout, WB, TooShortError, fromHex } from '../src/lib/index.js';
import { oracleJSON, oracleF64, clip, CLIPS, SR, FIXED_SECRET, A, NIPS_MSG, sha256hex, maxAbsDiff, strided } from './helpers.js';

const TOL = 1e-9;

function signRun(run) {
  const x = clip(CLIPS.indexOf(run.clip));
  const options = run.seed === 42 ? legacyOptions() : {};
  const trace = {};
  const y = sign(x, SR, FIXED_SECRET, fromHex(run.message_hex), { profile: run.profile, options, trace });
  return { x, y, trace };
}

function pcm16Bytes(y) {
  const b = Buffer.alloc(2 * y.length);
  for (let i = 0; i < y.length; i++) {
    const v = Math.min(Math.max(y[i], -1), 32767 / 32768) * 32768;
    // numpy round is half to even
    const f = Math.floor(v);
    const r = v - f > 0.5 || (v - f === 0.5 && f % 2 !== 0) ? f + 1 : f;
    b.writeInt16LE(r, 2 * i);
  }
  return b;
}

for (const run of oracleJSON('embed.json').runs) {
  test(`sign ${run.name}: samples, sums, PCM16 hash and stream sizes equal Python`, () => {
    const { x, y, trace } = signRun(run);
    assert.equal(y.length, run.n);
    const d = maxAbsDiff(strided(y, run.stride), oracleF64(`${run.name}.f64`));
    assert.ok(d <= TOL, `max |js - python| = ${d}`);
    let s = 0;
    let s2 = 0;
    let e = 0;
    let p = 0;
    for (let i = 0; i < y.length; i++) {
      s += y[i];
      s2 += y[i] * y[i];
      p += x[i] * x[i];
      e += (y[i] - x[i]) ** 2;
    }
    assert.ok(Math.abs(s - run.sum) < 1e-6, `sum ${s} vs ${run.sum}`);
    assert.ok(Math.abs(s2 - run.sum_sq) < 1e-6, `sum_sq ${s2} vs ${run.sum_sq}`);
    assert.ok(Math.abs(10 * Math.log10(p / e) - run.snr_db) < 1e-6);
    assert.equal(sha256hex(pcm16Bytes(y)), run.pcm16_sha256);
    assert.equal(trace.frames, run.frames);
    assert.equal(trace.groups, run.groups);
    assert.equal(trace.phase.replicas, run.phase_replicas);
    assert.equal(trace.magnitude.replicas, run.magnitude_replicas);
    assert.equal(trace.phase.stream.length, run.phase_stream_len);
    assert.equal(trace.magnitude.stream.length, run.magnitude_stream_len);
  });
}

test('sign trace: payload parts, header, streams, bins and per-bit values', () => {
  const x = clip(0);
  const trace = {};
  sign(x, SR, FIXED_SECRET, NIPS_MSG, { trace });
  const pl = buildPayload(NIPS_MSG, FIXED_SECRET);
  assert.deepEqual(trace.payload, pl);
  assert.deepEqual(trace.public_key, A.publicKey);
  assert.equal(trace.parts.length, 49);
  assert.equal(trace.parts.signature.length, 64);
  assert.equal(trace.parts.parity.length, 30);
  assert.equal(trace.body_bits.length, 8 * pl.length);
  // header: be32(1160) three times
  assert.equal(Array.from(trace.header_bits).join(''), (1160).toString(2).padStart(32, '0'));
  const ps = trace.phase.stream;
  for (let i = 0; i < 96; i++) assert.equal(ps[i], trace.header_bits[i % 32]);
  for (let i = 0; i < trace.body_bits.length; i++) assert.equal(ps[96 + i], trace.body_bits[i]);
  const ms = trace.magnitude.stream;
  assert.equal(ms.length, 96 + 2 * 1160);
  for (let i = 0; i < 1160; i++) assert.equal(ms[96 + 1160 + i], trace.body_bits[i]);
  assert.deepEqual(trace.phase.bins, makeLayout(trace.seed, WB).kp);
  assert.equal(trace.phase.before.length, ps.length);
  // after embedding the written phase is +pi/2 for a 1 and -pi/2 for a 0
  for (let i = 0; i < ps.length; i++) assert.ok(Math.abs(trace.phase.after[i] - (ps[i] ? 1 : -1) * Math.PI / 2) < 1e-12);
  const tm = trace.magnitude;
  for (let i = 0; i < ms.length; i++) {
    assert.equal(Math.abs(tm.cell[i] % 2), ms[i], `parity of cell ${i}`);
    assert.equal(tm.d_after[i], tm.cell[i] * tm.delta);
    assert.ok(Math.abs(tm.shift[i]) <= tm.delta + 1e-12, 'QIM moves by at most one step');
    assert.ok(Math.abs(tm.d_before[i] + tm.shift[i] - tm.d_after[i]) < 1e-12);
  }
});

test('capacity of a 10 s clip, and short input errors', () => {
  assert.deepEqual(capacity(441000, 'wb'), { frames: 215, groups: 26, phase: 6240, magnitude: 3120 });
  assert.throws(() => sign(new Float64Array(16384), SR, FIXED_SECRET, 'x'), TooShortError);
  assert.throws(() => sign(new Float64Array(441000), 48000, FIXED_SECRET, 'x'), /sample rate must be 44100/);
  assert.throws(() => embedPayload(new Float64Array(441000), new Uint8Array(0), 1), /empty/);
});

test('sign leaves samples past the last full frame untouched (tail passthrough) or zero (legacy)', () => {
  const x = clip(1).subarray(0, 441000 - 1000);
  const y = sign(x, SR, FIXED_SECRET, 'tail');
  const last = Math.floor(x.length / 2048) * 2048;
  for (let i = last; i < x.length; i++) assert.equal(y[i], x[i]);
  const z = sign(x, SR, FIXED_SECRET, 'tail', { options: legacyOptions() });
  for (let i = last; i < x.length; i++) assert.equal(z[i], 0);
});
