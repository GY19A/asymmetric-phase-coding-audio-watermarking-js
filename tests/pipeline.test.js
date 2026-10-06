// The demonstration's protocol (demo/pipeline.js) in Node, as the browser worker runs it:
// every stage reports in order, the defaults verify on every bundled clip, the accepted
// word repairs to the embedded payload, and the three negative controls are rejected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { runProtocol, STAGES } from '../src/demo/pipeline.js';
import { DEFAULT_ATTACKS, DEFAULT_MESSAGE, PAGE_OPTIONS, PAGE_MSG_MAX, VOICE_SECONDS, VOICE_HEAD_MAX } from '../src/demo/stages.js';
import { toHex, publicPem, fromHex, parseWav, resample } from '../src/lib/index.js';
import { MEDIA, CLIPS } from './helpers.js';

const wav = (i) => ({ kind: 'wav', bytes: new Uint8Array(readFileSync(path.join(MEDIA, CLIPS[i]))), name: CLIPS[i] });

async function run(i, over = {}) {
  const events = [];
  const report = await runProtocol(
    { source: wav(i), message: DEFAULT_MESSAGE, profile: 'wb', attacks: DEFAULT_ATTACKS, resync: false, noiseSeed: 7, ...over },
    { onStage: (id, state) => events.push(`${id}:${state}`) },
  );
  return { report, events };
}

function checkControls(report) {
  const c = report.stages.controls;
  for (const k of ['wrongKey', 'unsigned', 'impostor']) {
    assert.equal(c[k].verified, false, `${k} must be rejected`);
    assert.equal(c[k].message_hex, null, k);
  }
  assert.notEqual(c.wrongKey.publicKey, report.stages.identity.publicKey);
}

/** The accepted candidate as read, and after Reed-Solomon, against the embedded payload. */
function checkAccepted(report) {
  const v = report.stages.verify;
  const acc = v.attempts.find((a) => a.accepted)?.accepted;
  assert.ok(acc, 'one attempt has an accepted candidate');
  assert.equal(toHex(acc.repaired), toHex(report.stages.payload.payload));
  assert.equal(acc.fixed.length, report.result.rs_corrected);
  for (const j of acc.fixed) assert.notEqual(acc.payload[j], acc.repaired[j]);
  return acc;
}

for (const i of [0, 1, 2]) {
  test(`strongest page options verify on clip ${i} with a ${PAGE_MSG_MAX}-byte message`, async () => {
    const values = (k) => PAGE_OPTIONS[k].map(([v]) => v).filter(Boolean);
    const attacks = {
      ...DEFAULT_ATTACKS,
      cropHead: { on: true, pct: Math.max(...values('cropHead')) },
      cropTail: { on: true, pct: Math.max(...values('cropTail')) },
      lowpass: { on: true, hz: Math.min(...values('lowpass')) },
    };
    const { report } = await run(i, { attacks, message: 'M'.repeat(PAGE_MSG_MAX) });
    assert.equal(report.result.verified, true, report.result.reason);
  });
}

for (const i of [0, 1, 2]) {
  test(`defaults verify on clip ${i}, controls rejected`, async () => {
    const { report, events } = await run(i);
    assert.deepEqual(events, STAGES.flatMap((s) => [`${s.id}:start`, `${s.id}:done`]));
    const r = report.result;
    assert.equal(r.verified, true, r.reason);
    assert.equal(new TextDecoder().decode(fromHex(r.message_hex)), DEFAULT_MESSAGE);
    assert.equal(r.message, DEFAULT_MESSAGE);
    assert.equal(r.profile, 'wb');
    assert.ok(r.rs_corrected <= 15);
    checkAccepted(report);
    checkControls(report);
    // The attacks named on the page, in chain order.
    assert.deepEqual(report.stages.attack.steps.map((s) => s.id), ['cropHead', 'cropTail', 'lowpass']);
    for (const s of STAGES) assert.ok(Number.isFinite(report.stages[s.id].ms), `${s.id} time`);
  });
}

test('the identity stage reports only public material', async () => {
  const { report } = await run(2);
  const id = report.stages.identity;
  assert.deepEqual(Object.keys(id).sort(), ['fingerprint', 'ms', 'pem', 'publicKey', 'seed']);
  assert.match(id.publicKey, /^[0-9a-f]{64}$/);
  assert.equal(id.pem, publicPem(fromHex(id.publicKey)));
  assert.doesNotMatch(id.pem, /PRIVATE/);
  assert.equal(report.result.message_bytes, undefined);
});

test('a 5000-sample delay is found by resync, controls rejected under the same search', async () => {
  const attacks = { ...DEFAULT_ATTACKS, shift: { on: true, samples: 5000 } };
  const { report } = await run(0, { attacks, resync: true });
  assert.equal(report.result.verified, true, report.result.reason);
  assert.equal(report.result.offset.samples, 5000);
  assert.equal(report.stages.verify.transport.offset, 5000);
  checkAccepted(report);
  checkControls(report);
});

test('narrowband verifies with a 5% head crop on every clip', async () => {
  const attacks = { ...DEFAULT_ATTACKS, cropHead: { on: true, pct: 5 } };
  for (const i of [0, 1, 2]) {
    const { report } = await run(i, { profile: 'nb', attacks });
    assert.equal(report.result.verified, true, `clip ${i}: ${report.result.reason}`);
    assert.equal(report.result.profile, 'nb');
    checkAccepted(report);
    checkControls(report);
  }
});

test('without WebCodecs the Opus step is reported as skipped, never faked', async () => {
  const attacks = { ...DEFAULT_ATTACKS, codec: { on: true, bitrate: 64000 } };
  const { report } = await run(1, { attacks });
  const step = report.stages.attack.steps.find((s) => s.id === 'codec');
  assert.equal(step.skipped, true);
  assert.match(step.label, /^Opus round trip skipped/);
  assert.equal(report.result.verified, true);
});

test('an injected codec is applied and its label is kept', async () => {
  const attacks = { ...DEFAULT_ATTACKS, codec: { on: true, bitrate: 96000 } };
  let seen = null;
  const codec = async (x, s) => ((seen = s.bitrate), { samples: Float64Array.from(x), label: 'identity codec' });
  const report = await runProtocol(
    { source: wav(2), message: 'codec', profile: 'wb', attacks, resync: false, noiseSeed: 7 },
    { codec },
  );
  assert.equal(seen, 96000);
  assert.equal(report.stages.attack.steps.find((s) => s.id === 'codec').label, 'identity codec');
  assert.equal(report.result.verified, true);
});

test('a PCM source at another rate and with two channels is mixed and resampled', async () => {
  const w = wav(0);
  const { parseWav } = await import('../src/lib/index.js');
  const { resample } = await import('../src/lib/resample.js');
  const mono = parseWav(w.bytes).channels[0];
  const x = Float32Array.from(resample(mono, 44100, 48000));
  const report = await runProtocol(
    { source: { kind: 'pcm', channels: [x, x], sampleRate: 48000, name: 'pcm' }, message: 'pcm', profile: 'wb', attacks: DEFAULT_ATTACKS, resync: false, noiseSeed: 7 },
  );
  const load = report.stages.load;
  assert.equal(load.sampleRate, 48000);
  assert.equal(load.channels, 2);
  assert.equal(load.resampled, true);
  assert.equal(report.result.verified, true, report.result.reason);
});

test(`a ${VOICE_SECONDS} s microphone-rate recording verifies under the strongest options for recordings`, async () => {
  const parts = [0, 1].map((i) => parseWav(new Uint8Array(readFileSync(path.join(MEDIA, CLIPS[i])))).channels[0]);
  const joined = new Float64Array(parts[0].length + parts[1].length);
  joined.set(parts[0]);
  joined.set(parts[1], parts[0].length);
  const mic = Float32Array.from(resample(joined.subarray(0, VOICE_SECONDS * 44100), 44100, 48000));
  const max = (k) => Math.max(...PAGE_OPTIONS[k].map(([v]) => v));
  const attacks = {
    ...DEFAULT_ATTACKS,
    cropHead: { on: true, pct: VOICE_HEAD_MAX },
    cropTail: { on: true, pct: max('cropTail') },
    lowpass: { on: true, hz: Math.min(...PAGE_OPTIONS.lowpass.map(([v]) => v).filter(Boolean)) },
  };
  const { report } = await run(0, { source: { kind: 'pcm', channels: [mic], sampleRate: 48000, name: 'voice' }, attacks });
  assert.equal(report.stages.load.seconds, VOICE_SECONDS);
  assert.equal(report.result.verified, true, report.result.reason);
  assert.equal(report.result.message, DEFAULT_MESSAGE);
  checkControls(report);
});
