/**
 * Card a: the Ed25519 identity. Shows the public key, a glyph of its SHA-256 and the
 * layout seed. The secret key never reaches the page.
 * @module ui/cards/identity
 */

import { select, easeCubicOut } from 'd3';
import { h, readouts, copyButton, download, reducedMotion } from '../dom.js';
import { C } from '../colors.js';
import { hex } from '../format.js';

const TAU = Math.PI * 2;

/** Radial glyph: 64 spokes, one per nibble of SHA-256(public key); 32 dots, one per key byte. */
function glyph(svgEl, fingerprint, publicKey, animate) {
  const S = 220;
  const cx = S / 2;
  const r0 = 30;
  const r1 = 96;
  const svg = select(svgEl).attr('viewBox', `0 0 ${S} ${S}`);
  svg.append('title').text('Glyph of the SHA-256 of the public key');
  svg.append('circle').attr('cx', cx).attr('cy', cx).attr('r', r1 + 10).attr('fill', 'none').attr('stroke', C.line2);
  svg.append('circle').attr('cx', cx).attr('cy', cx).attr('r', r0 - 6).attr('fill', 'none').attr('stroke', C.line2);
  const nibbles = [];
  for (const b of fingerprint) nibbles.push(b >> 4, b & 15);
  const g = svg.append('g').attr('transform', `translate(${cx},${cx})`);
  const spokes = g
    .selectAll('line')
    .data(nibbles)
    .join('line')
    .attr('x1', (_, i) => r0 * Math.cos((i / 64) * TAU - Math.PI / 2))
    .attr('y1', (_, i) => r0 * Math.sin((i / 64) * TAU - Math.PI / 2))
    .attr('stroke', C.ok)
    .attr('stroke-width', 2)
    .attr('stroke-linecap', 'round')
    .attr('stroke-opacity', (v) => 0.3 + (0.7 * v) / 15);
  const end = (v, i, f) => (r0 + ((v + 1) / 16) * (r1 - r0)) * f((i / 64) * TAU - Math.PI / 2);
  const toEnd = (sel) => sel.attr('x2', (v, i) => end(v, i, Math.cos)).attr('y2', (v, i) => end(v, i, Math.sin));
  if (animate) {
    spokes.attr('x2', (_, i) => r0 * Math.cos((i / 64) * TAU - Math.PI / 2)).attr('y2', (_, i) => r0 * Math.sin((i / 64) * TAU - Math.PI / 2));
    spokes.transition().delay((_, i) => 200 + i * 9).duration(700).ease(easeCubicOut).call(toEnd);
  } else {
    toEnd(spokes);
  }
  g.selectAll('circle.kb')
    .data(Array.from(publicKey))
    .join('circle')
    .attr('class', 'kb')
    .attr('cx', (_, i) => (r1 + 10) * Math.cos((i / 32) * TAU - Math.PI / 2))
    .attr('cy', (_, i) => (r1 + 10) * Math.sin((i / 32) * TAU - Math.PI / 2))
    .attr('r', (v) => 0.8 + (2.6 * v) / 255)
    .attr('fill', C.ok)
    .attr('fill-opacity', 0.85);
  g.append('text')
    .attr('text-anchor', 'middle')
    .attr('dy', '0.35em')
    .attr('fill', C.muted)
    .attr('font-family', 'ui-monospace, Menlo, Consolas, monospace')
    .attr('font-size', 10)
    .text(hex(fingerprint.subarray(0, 2)));
}

function fromHex(s) {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function renderIdentity(body, run) {
  const d = run.identity;
  const pk = fromHex(d.publicKey);
  const svg = h('svg:svg', { class: 'glyph', role: 'img', 'aria-label': 'Glyph of the SHA-256 of the public key' });
  glyph(svg, d.fingerprint, pk, !reducedMotion());
  const groups = d.publicKey.match(/.{8}/g).map((s) => h('span', { text: s }));
  const seedHex = `0x${d.seed.toString(16).padStart(8, '0')}`;
  body.append(
    h(
      'div',
      { class: 'card-text' },
      h('p', { text: 'A fresh key pair made in this tab. The public key alone verifies, and its hash sets where the bits go.' }),
    ),
    h(
      'div',
      { class: 'identity' },
      svg,
      h(
        'div',
        {},
        h('p', { class: 'fig-title', text: 'Public key, 32 bytes' }),
        h('p', { class: 'hexkey', 'aria-label': `Public key ${d.publicKey}` }, groups),
        h(
          'div',
          { class: 'keyrow' },
          copyButton(() => d.publicKey, 'Copy public key'),
          h('button', { type: 'button', class: 'btn ok', text: 'Download public key (PEM)', onclick: () => download('apcaw-public.pem', d.pem, 'application/x-pem-file') }),
        ),
        h(
          'p',
          { class: 'lockline' },
          h('svg:svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
            h('svg:rect', { x: 3, y: 7, width: 10, height: 7, rx: 1.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 }),
            h('svg:path', { d: 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 })),
          'Secret key: kept in this tab, never displayed.',
        ),
      ),
    ),
    readouts([
      ['Scheme', 'Ed25519, RFC 8032'],
      ['SHA-256 of key', `${hex(d.fingerprint.subarray(0, 6))}...`],
      ['Layout seed', seedHex, 'ok'],
      ['Seed rule', 'SHA-256 bytes 0 to 7, mod 2^32'],
    ]),
  );
}
