#!/usr/bin/env node
/**
 * Smoke test of the demonstration.
 *
 * With Playwright, it tests the built site: dist/ is served on 127.0.0.1 and opened in headless
 * Chromium under the host name apcaw.test, which the browser maps to 127.0.0.1. That origin
 * is not a secure context, so crypto.subtle is missing, as when the page is opened from a LAN
 * address over plain http. One click on "Run the full protocol" with the defaults must open
 * every card, verify, and reject the three controls, with no console errors. The page is
 * then narrowed to a phone width, which must not scroll sideways.
 *
 * Without Playwright, or with --node, it runs the same pipeline in Node on every bundled clip.
 *
 *   npm run build && npm run smoke
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright npm run smoke
 *   npm run smoke -- --node
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const HOST = 'apcaw.test';
const RUN_TIMEOUT = 60_000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wav': 'audio/wav',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon',
};

const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const spec of [process.env.PLAYWRIGHT_MODULE, 'playwright']) {
    if (!spec) continue;
    try {
      return require(spec);
    } catch {
      // Try the next location.
    }
  }
  return null;
}

/** Static server for dist/, loopback only. */
function serve(dir) {
  const server = createServer(async (req, res) => {
    const rel = path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    let file = path.join(dir, rel);
    if (file !== dir && !file.startsWith(dir + path.sep)) return res.writeHead(403).end();
    if (rel.endsWith(path.sep)) file = path.join(file, 'index.html');
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)));
}

async function browserSmoke(pw) {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    console.error('dist/index.html not found. Run `npm run build` first.');
    process.exit(1);
  }
  const server = await serve(DIST);
  const url = `http://${HOST}:${server.address().port}/`;
  const args = [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`];
  let browser;
  try {
    browser = await pw.chromium.launch({ args });
  } catch (e) {
    // Playwright's own Chromium is not downloaded: use an installed Google Chrome.
    browser = await pw.chromium.launch({ args, channel: 'chrome' }).catch(() => {
      server.close();
      throw e;
    });
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    console.log(`Browser smoke: Chromium ${browser.version()}, ${url}`);
    await page.goto(url);
    const ctx = await page.evaluate(() => ({ secure: isSecureContext, subtle: typeof crypto.subtle }));
    check(!ctx.secure && ctx.subtle === 'undefined', `insecure origin, no crypto.subtle (secure ${ctx.secure}, subtle ${ctx.subtle})`);
    check(/Asymmetric Phase Coding Audio Watermarking/.test(await page.title()), 'page title');

    const t0 = Date.now();
    await page.click('#run-btn');
    await page.waitForSelector('[aria-labelledby="card-j-title"][data-state="open"]', { timeout: RUN_TIMEOUT });
    const ms = Date.now() - t0;
    const status = (await page.textContent('#tracker-status')).trim();
    console.log(`  ${status}`);
    check(status.startsWith('Verified'), 'verified with the public key only');
    const cards = await page.$$eval('#story .card', (els) => els.map((e) => [e.querySelector('.card-letter')?.textContent, e.dataset.state]));
    check(cards.length === 10 && cards.every(([, s]) => s === 'open'), `cards a to j open (${cards.map(([l, s]) => `${l}:${s}`).join(' ')})`);
    const rejected = await page.$$eval('[aria-labelledby="card-j-title"] .control .v:not(.bad)', (els) => els.length);
    check(rejected === 3, `negative controls rejected: ${rejected} of 3`);
    check(ms < RUN_TIMEOUT, `one click to the last card in ${(ms / 1000).toFixed(2)} s`);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= 390, `no sideways scroll at 390 px (scrollWidth ${sw})`);
    check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
  } finally {
    await browser.close();
    server.close();
  }
}

async function nodeSmoke() {
  const { runProtocol } = await import('../src/demo/pipeline.js');
  const { CLIPS, DEFAULT_ATTACKS, DEFAULT_MESSAGE } = await import('../src/demo/stages.js');
  console.log(`Node pipeline smoke: ${process.version}, defaults, ${CLIPS.length} clips`);
  for (const c of CLIPS) {
    const bytes = new Uint8Array(await readFile(path.join(ROOT, 'public', 'media', c.file)));
    const t0 = performance.now();
    const rep = await runProtocol({
      source: { kind: 'wav', bytes, name: c.name }, message: DEFAULT_MESSAGE, profile: 'wb', attacks: DEFAULT_ATTACKS, resync: false,
    });
    const r = rep.result;
    const ctl = rep.stages.controls;
    const rejected = [ctl.wrongKey, ctl.unsigned, ctl.impostor].filter((x) => !x.verified).length;
    const ms = Math.round(performance.now() - t0);
    check(r.verified && r.message === DEFAULT_MESSAGE && rejected === 3,
      `${c.name}: ${r.verified ? `verified (${r.channel}, RS ${r.rs_corrected} of 15)` : `not verified: ${r.reason}`}, controls rejected ${rejected} of 3, ${ms} ms`);
  }
}

const pw = process.argv.includes('--node') ? null : loadPlaywright();
if (pw) {
  await browserSmoke(pw);
} else {
  if (!process.argv.includes('--node')) {
    console.log('Playwright not found (install it, or set PLAYWRIGHT_MODULE). Falling back to the Node pipeline.');
  }
  await nodeSmoke();
}
console.log(failures.length ? `\nSmoke FAILED: ${failures.length} check(s)` : '\nSmoke passed');
process.exit(failures.length ? 1 : 0);
