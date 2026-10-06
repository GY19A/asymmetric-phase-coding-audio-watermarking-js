// The page's own copies of library facts, and the rules the page code keeps: the main thread
// never loads the library, the constants in ui/format.js agree with it, and the page text
// has no em dashes, no Chinese and no MP3 claim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

import * as lib from '../src/lib/index.js';
import { N_BINS } from '../src/lib/layout.js';
import * as fmt from '../src/ui/format.js';
import { STAGES, CLIPS, DEFAULT_ATTACKS, DEFAULT_MESSAGE, CANDIDATE_CODES, PAGE_MSG_MAX } from '../src/demo/stages.js';
import { SNIPPETS } from '../src/ui/snippets.js';
import { ROOT, MEDIA, CLIPS as TEST_CLIPS } from './helpers.js';

const SRC = path.join(ROOT, 'src');
const read = (f) => readFileSync(f, 'utf8');

test('ui/format.js constants agree with the library', () => {
  for (const k of ['SAMPLE_RATE', 'N_FFT', 'GROUP', 'HEADER_BITS', 'MAX_MSG_LEN', 'SIG_LEN', 'NSYM']) {
    assert.equal(fmt[k], lib[k], k);
  }
  assert.equal(fmt.N_BINS, N_BINS);
  assert.equal(fmt.binHz(1024), lib.SAMPLE_RATE / 2);
  assert.equal(fmt.hex([0, 15, 255]), lib.toHex(Uint8Array.of(0, 15, 255)));
  assert.equal(fmt.utf8Length('Grüße'), lib.messageBytes('Grüße').length);
});

test('number formatting', () => {
  assert.equal(fmt.fmtMs(0.4), '<1 ms');
  assert.equal(fmt.fmtMs(912.4), '912 ms');
  assert.equal(fmt.fmtMs(2345), '2.35 s');
  assert.equal(fmt.fmtDb(Infinity), 'no change');
  assert.equal(fmt.fmtInt(123456), '123,456');
  assert.equal(fmt.byteHex(10), '0x0a');
  assert.equal(fmt.byteBits(5), '00000101');
  assert.equal(fmt.byteChar(0x41), 'A');
  assert.equal(fmt.byteChar(0x00), '·');
  assert.equal(fmt.fmtSeconds(75.25), '1:15.3');
});

test('demo defaults: stages, clips, message, attack keys', () => {
  assert.deepEqual(STAGES.map((s) => s.id), ['identity', 'load', 'payload', 'embed', 'attack', 'verify', 'controls']);
  assert.deepEqual(CLIPS.map((c) => c.file), TEST_CLIPS);
  for (const c of CLIPS) assert.ok(existsSync(path.join(MEDIA, c.file)), c.file);
  assert.equal(DEFAULT_MESSAGE, 'Authenticity Deepfake Defense Test: I love Orie.');
  assert.ok(lib.messageBytes(DEFAULT_MESSAGE).length <= PAGE_MSG_MAX);
  assert.deepEqual(Object.keys(DEFAULT_ATTACKS).sort(), ['codec', 'cropHead', 'cropTail', 'lowpass', 'noise', 'requant', 'shift']);
  assert.deepEqual(Object.values(CANDIDATE_CODES).sort(), [0, 1, 2, 3, 4]);
});

/** Relative module specifiers of a source file (static imports and re-exports). */
function imports(file) {
  const out = [];
  for (const m of read(file).matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+'([^']+)'|(?:^|\n)\s*import\s+'([^']+)'/g)) {
    const s = m[1] ?? m[2];
    if (s.startsWith('.')) out.push(path.resolve(path.dirname(file), s));
  }
  return out;
}

test('the main thread does not load the library (it runs in the worker)', () => {
  const seen = new Set();
  const walk = (f) => {
    if (seen.has(f) || !f.endsWith('.js')) return;
    seen.add(f);
    for (const g of imports(f)) walk(g);
  };
  walk(path.join(SRC, 'ui', 'main.js'));
  const inLib = [...seen].filter((f) => f.startsWith(path.join(SRC, 'lib') + path.sep));
  assert.deepEqual(inLib, []);
  assert.ok(seen.has(path.join(SRC, 'ui', 'cards', 'decode.js')) && seen.has(path.join(SRC, 'demo', 'stages.js')));
  assert.ok(!seen.has(path.join(SRC, 'demo', 'pipeline.js')));
  // The worker is the one entry that does.
  assert.match(read(path.join(SRC, 'ui', 'main.js')), /new Worker\(new URL\('\.\.\/demo\/worker\.js', import\.meta\.url\)/);
});

test('page text: no em dashes, no Chinese, no emoji, no MP3 claim, full title', () => {
  const files = [path.join(ROOT, 'index.html')];
  for (const dir of ['ui', 'ui/cards', 'demo']) {
    for (const f of readdirSync(path.join(SRC, dir))) if (f.endsWith('.js')) files.push(path.join(SRC, dir, f));
  }
  for (const f of files) {
    const s = read(f);
    assert.doesNotMatch(s, /—/, `${f}: em dash`);
    assert.doesNotMatch(s, /[一-鿿　-〿]/, `${f}: Chinese text`);
    assert.doesNotMatch(s, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, `${f}: emoji`);
    // The only MP3 on the page is the file picker accepting a user's own .mp3.
    assert.doesNotMatch(s.replace(/accept="[^"]*"/g, ''), /mp3/i, `${f}: MP3`);
  }
  const html = read(path.join(ROOT, 'index.html'));
  assert.match(html, /Asymmetric Phase Coding Audio Watermarking/);
  assert.match(html, /https:\/\/arxiv\.org\/abs\/2605\.07241/);
  assert.match(html, /https:\/\/neurips\.cc\/virtual\/2026\/loc\/atlanta\/poster\/149813/);
  for (const a of ['Guang Yang', 'Fengchen Liu', 'Amir Ghasemian', 'Zhong Wang', 'Ninareh Mehrabi', 'Homa Hosseinmardi']) {
    assert.ok(html.includes(a), a);
  }
});

test('code samples: six lines each, one per language', () => {
  assert.deepEqual(SNIPPETS.map((s) => s.id), ['js', 'rust', 'python']);
  for (const s of SNIPPETS) assert.equal(s.code.split('\n').length, 6, s.id);
});
