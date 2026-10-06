// Every attack combination the page offers, on every bundled clip, with fresh keys and
// several messages. Each run must verify, return the exact message, and reject all three
// negative controls. Usage: node scripts/sweep.mjs [keys per case, default 25]
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (isMainThread) {
  const { DEFAULT_ATTACKS, DEFAULT_MESSAGE, CLIPS, PAGE_OPTIONS, PAGE_MSG_MAX } = await import('../src/demo/stages.js');
  const keys = Number(process.argv[2] ?? 25);
  const enc = new TextEncoder();
  const cjk = '\u6c34\u5370'.repeat(Math.floor(PAGE_MSG_MAX / 6));
  const messages = [
    ['default', DEFAULT_MESSAGE],
    [`ascii ${PAGE_MSG_MAX} B`, 'M'.repeat(PAGE_MSG_MAX)],
    [`utf-8 ${enc.encode(cjk).length} B`, cjk],
    ['1 B', 'A'],
    ['empty', ''],
  ];
  for (const [, m] of messages) if (enc.encode(m).length > PAGE_MSG_MAX) throw new Error('message over the page cap');

  const combos = [];
  for (const [head] of PAGE_OPTIONS.cropHead)
    for (const [tail] of PAGE_OPTIONS.cropTail)
      for (const [lp] of PAGE_OPTIONS.lowpass) {
        const a = Object.fromEntries(Object.entries(DEFAULT_ATTACKS).map(([k, v]) => [k, { ...v, on: false }]));
        a.cropHead = { on: head > 0, pct: head };
        a.cropTail = { on: tail > 0, pct: tail };
        a.lowpass = { on: lp > 0, hz: lp };
        combos.push({ name: `head ${head}% tail ${tail}% lp ${lp ? `${lp / 1000} kHz` : 'off'}`, attacks: a });
      }

  const jobs = [];
  for (let c = 0; c < combos.length; c++)
    for (let i = 0; i < CLIPS.length; i++)
      for (let m = 0; m < messages.length; m++)
        for (let k = 0; k < keys; k++) jobs.push([c, i, m]);

  const n = Math.max(1, Math.min(os.availableParallelism() - 2, 30));
  console.log(`${combos.length} attack combinations x ${CLIPS.length} clips x ${messages.length} messages x ${keys} keys = ${jobs.length} runs on ${n} threads`);
  const t0 = Date.now();
  const fails = [];
  const perCombo = combos.map(() => ({ ok: 0, n: 0, worstBad: 0 }));
  await Promise.all(
    Array.from({ length: n }, (_, w) => new Promise((resolve, reject) => {
      const mine = jobs.filter((_, j) => j % n === w);
      const worker = new Worker(fileURLToPath(import.meta.url), {
        workerData: { jobs: mine, combos, messages, clips: CLIPS.map((c) => c.file) },
      });
      worker.on('message', (r) => {
        const s = perCombo[r.c];
        s.n++;
        if (r.ok) s.ok++;
        else fails.push(r);
        s.worstBad = Math.max(s.worstBad, r.bad);
      });
      worker.on('error', reject);
      worker.on('exit', resolve);
    })),
  );
  for (const [c, s] of perCombo.entries()) {
    console.log(`${s.ok === s.n ? 'ok  ' : 'FAIL'} ${combos[c].name.padEnd(32)} ${s.ok}/${s.n}  worst bad bytes on the winning channel ${s.worstBad} of 15`);
  }
  for (const f of fails.slice(0, 20)) console.log('  failure:', JSON.stringify(f));
  const total = perCombo.reduce((a, s) => a + s.n, 0);
  console.log(`\n${total - fails.length}/${total} runs passed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exitCode = fails.length ? 1 : 0;
} else {
  const { runProtocol } = await import('../src/demo/pipeline.js');
  const { jobs, combos, messages, clips } = workerData;
  const bytes = clips.map((f) => new Uint8Array(readFileSync(path.join(ROOT, 'public', 'media', f))));
  for (const [c, i, m] of jobs) {
    const msg = messages[m][1];
    let r;
    try {
      r = await runProtocol({
        source: { kind: 'wav', bytes: bytes[i], name: clips[i] },
        message: msg,
        profile: 'wb',
        attacks: combos[c].attacks,
        resync: false,
      });
    } catch (e) {
      parentPort.postMessage({ c, clip: i, msg: messages[m][0], ok: false, bad: 99, error: String(e?.message ?? e) });
      continue;
    }
    const v = r.result;
    const ctl = r.stages.controls;
    const rejected = ['wrongKey', 'unsigned', 'impostor'].every((k) => !ctl[k].verified);
    const ch = v.verified ? v.channel : null;
    const bad = ch ? v.rs_corrected : 99;
    const ok = v.verified && v.message === msg && rejected;
    const why = !v.verified ? v.reason : v.message !== msg ? 'wrong message' : !rejected ? 'control accepted' : null;
    parentPort.postMessage({ c, clip: i, msg: messages[m][0], ok, bad, why });
  }
}
