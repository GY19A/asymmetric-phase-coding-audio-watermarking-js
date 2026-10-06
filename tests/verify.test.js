// Blind verification against the Python reference: soft values (1e-9) and the full result
// (counters and reason text) of 17 signal x condition x key cases (tests/oracle/soft.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sign, verify, inspect, readSoft, legacyOptions, seedFromPublicKey } from '../src/lib/index.js';
import {
  oracleJSON, oracleF64, clip, SR, FIXED_SECRET, A, B, NIPS_MSG, maxAbsDiff, pick,
  pcm16, requant8, cropHead, cropTail, padDelay,
} from './helpers.js';

const cache = new Map();
function signal(name) {
  if (cache.has(name)) return cache.get(name);
  let y;
  if (name === 'clip0_wb_v1') y = pcm16(sign(clip(0), SR, FIXED_SECRET, NIPS_MSG));
  else if (name === 'clip1_nb_v1') y = pcm16(sign(clip(1), SR, FIXED_SECRET, 'nb profile', { profile: 'nb' }));
  else if (name === 'clip2_wb_legacy') y = pcm16(sign(clip(2), SR, FIXED_SECRET, NIPS_MSG, { options: legacyOptions() }));
  else if (name.startsWith('unsigned_clip')) y = clip(Number(name.slice(-1)));
  else if (name === 'short') y = new Float64Array(100000);
  else throw new Error(`unknown oracle signal ${name}`);
  cache.set(name, y);
  return y;
}

const CONDITIONS = {
  clean_pcm16: (y) => y,
  requant_8bit: requant8,
  crop_head_20: (y) => cropHead(y, 20),
  crop_tail_50: (y) => cropTail(y, 50),
  crop_head_60: (y) => cropHead(y, 60),
  pad_delay_5000: (y) => padDelay(y, 5000),
  pad_delay_5000_noresync: (y) => padDelay(y, 5000),
  clean_pcm16_wb_only: (y) => y,
  clean_pcm16_legacy: (y) => y,
  clean_pcm16_v1: (y) => y,
  clean_pcm16_seed42: (y) => y,
  zeros_100000: (y) => y,
};

/** Python keyword arguments of `apcaw.verify` to the JS call. */
function jsArgs(kw) {
  const options = {};
  if ('verifier' in kw) options.verifier = kw.verifier;
  if ('tau' in kw) options.erasure_tau = kw.tau;
  if ('seed' in kw) options.seed = kw.seed;
  return { profile: kw.profiles ? kw.profiles[0] : null, options, resync: !!kw.resync };
}

test('soft values of the signed clip after PCM16 equal Python (6240 phase, 3120 magnitude)', () => {
  const s = readSoft(signal('clip0_wb_v1'), seedFromPublicKey(A.publicKey), 'wb');
  assert.equal(s.groups, 26);
  const dp = maxAbsDiff(s.phase, oracleF64('soft_clip0_phase.f64'));
  const dm = maxAbsDiff(s.magnitude, oracleF64('soft_clip0_magnitude.f64'));
  assert.ok(dp <= 1e-9, `phase soft diff ${dp}`);
  assert.ok(dm <= 1e-9, `magnitude soft diff ${dm}`);
});

const cases = oracleJSON('soft.json').verify;
test('the oracle has 17 verify cases', () => assert.equal(cases.length, 17));
for (const c of cases) {
  test(`verify ${c.signal} / ${c.condition} / key ${c.key}: same result as Python`, () => {
    const cond = CONDITIONS[c.condition];
    assert.ok(cond, `unknown condition ${c.condition}`);
    const z = cond(signal(c.signal));
    const r = verify(z, SR, c.key === 'fixed' ? A.publicKey : B.publicKey, jsArgs(c.kwargs));
    assert.deepEqual(pick(r), pick(c));
    if (r.verified) assert.equal(Buffer.from(r.message, 'utf8').toString('hex'), c.message_hex);
  });
}

test('resync result carries the offset', () => {
  const r = verify(padDelay(signal('clip0_wb_v1'), 5000), SR, A.publicKey, { resync: true });
  assert.deepEqual(r.offset, { delta: 904, f0: 2, samples: 5000 });
});

test('inspect: per-profile, per-channel soft statistics', () => {
  const rep = inspect(signal('clip0_wb_v1'), SR, A.publicKey);
  assert.deepEqual(Object.keys(rep), ['samples', 'frames', 'seed', 'profiles']);
  assert.equal(rep.seed, 1415792460);
  assert.deepEqual(Object.keys(rep.profiles), ['wb', 'nb']);
  const ph = rep.profiles.wb.phase;
  assert.deepEqual(Object.keys(ph), ['capacity', 'header_length', 'stream_bits', 'mean_abs_soft', 'mean_abs_soft_capacity', 'erased']);
  assert.equal(ph.header_length, 1160);
  assert.equal(ph.stream_bits, 96 + 1160);
  assert.ok(ph.mean_abs_soft > 0.9, 'a clean phase channel reads close to +-1');
  const un = inspect(signal('unsigned_clip1'), SR, A.publicKey);
  assert.ok(un.profiles.wb.phase.mean_abs_soft_capacity < 0.75, 'unsigned phase soft values are spread');
});

test('verify trace: soft arrays, header sums, candidates and the accepted payload', () => {
  const trace = {};
  const r = verify(signal('clip0_wb_v1'), SR, A.publicKey, { trace });
  assert.equal(r.verified, true);
  const first = trace.attempts[0];
  assert.deepEqual([first.profile, first.channel, first.capacity, first.header_length], ['wb', 'phase', 6240, 1160]);
  assert.equal(first.soft.length, 6240);
  assert.equal(first.header_sums.length, 32);
  assert.equal(first.candidates[0].path, 'header');
  assert.equal(first.candidates[0].rs_corrected, 11);
  assert.equal(first.accepted.payload.length, 145);
  assert.equal(first.accepted.signature.length, 64);
  assert.equal(first.accepted.body_sums.length, 1160);
  assert.equal(trace.resync, null);

  const t2 = {};
  const neg = verify(signal('unsigned_clip1'), SR, A.publicKey, { trace: t2 });
  assert.equal(neg.verified, false);
  assert.deepEqual(t2.attempts.map((a) => `${a.profile}/${a.channel}`), ['wb/phase', 'wb/magnitude', 'nb/phase', 'nb/magnitude']);
  const tried = t2.attempts.flatMap((a) => a.candidates).filter((c) => !c.duplicate);
  assert.equal(tried.length, neg.candidates_tried);
  assert.equal(tried.filter((c) => c.rs_ok).length, neg.rs_passes);
  assert.equal(tried.filter((c) => c.sig_checked).length, neg.sig_checks);
});

test('verify rejects bad arguments', () => {
  assert.throws(() => verify(new Float64Array(441000), 48000, A.publicKey), /sample rate must be 44100/);
  assert.throws(() => verify(new Float64Array(441000), SR, new Uint8Array(5)), /malformed public key/);
});
