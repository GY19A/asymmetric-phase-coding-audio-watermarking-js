/**
 * Protocol diagram after Fig. 1 of the paper: signer lane, attacks, verifier lane. Each box
 * lights up when the worker reports its stage and shows that stage's numbers. A lit box
 * opens its card.
 * @module ui/flow
 */

import { select, easeCubicInOut } from 'd3';
import { C } from './colors.js';
import { reducedMotion } from './dom.js';

const VW = 1000;
const VH = 438;
const SR = 44100;
const LH = { t: 16, s: 14, v: 22 };
const KIND = { neutral: C.soft, key: C.darkerBlue, crypto: C.darkestBlue, phase: C.blue, mag: C.darkestGold };

const box = (id, x, y, w, h, kind, stage, card, idle) => ({ id, x, y, w, h, kind, stage, card, idle });

const NODES = [
  box('kpriv', 188, 12, 140, 40, 'key', 'identity', 'a', [['Secret key', 't'], ['never leaves this tab', 's']]),
  box('host', 524, 12, 116, 40, 'neutral', 'load', 'g', [['Host audio', 't'], ['speech clip', 's']]),
  box('layout', 652, 12, 150, 40, 'key', 'payload', 'c', [['Bit layout', 't'], ['from the public key', 's']]),
  box('msg', 40, 87, 124, 56, 'neutral', 'payload', 'b', [['Message', 't'], ['UTF-8 text', 's']]),
  box('sign', 188, 87, 140, 56, 'crypto', 'payload', 'b', [['Ed25519 sign', 't'], ['64-byte signature', 's']]),
  box('rs', 352, 87, 132, 56, 'neutral', 'payload', 'b', [['Reed-Solomon', 't'], ['30 parity bytes', 's']]),
  box('phase', 538, 70, 216, 42, 'phase', 'embed', 'e', [['Phase channel', 't'], ['bit to ±π/2', 's']]),
  box('mag', 538, 118, 216, 42, 'mag', 'embed', 'f', [['Magnitude channel', 't'], ['QIM on bin pairs', 's']]),
  box('istft', 800, 87, 64, 56, 'neutral', 'embed', 'd', [['ISTFT', 't']]),
  box('signed', 880, 87, 110, 56, 'neutral', 'embed', 'g', [['Signed audio', 't'], ['16-bit WAV', 's']]),
  box('transport', 0, 188, VW, 42, 'neutral', 'attack', 'h', [['Attacks on the signed file', 't'], ['none', 's']]),
  box('recv', 40, 302, 124, 56, 'neutral', 'attack', 'g', [['Received', 't'], ['attacked audio', 's']]),
  box('pread', 200, 270, 200, 42, 'phase', 'verify', 'h', [['Phase read', 't'], ['sign of sin φ', 's']]),
  box('mread', 200, 322, 200, 42, 'mag', 'verify', 'h', [['Magnitude read', 't'], ['parity of d', 's']]),
  box('rsp', 436, 270, 140, 42, 'neutral', 'verify', 'i', [['RS decode', 't'], ['length search', 's']]),
  box('rsm', 436, 322, 140, 42, 'neutral', 'verify', 'i', [['RS decode', 't'], ['length search', 's']]),
  box('verify', 604, 266, 140, 98, 'crypto', 'verify', 'i', [['Ed25519 verify', 't'], ['each channel', 's']]),
  box('out', 770, 266, 220, 98, 'crypto', 'verify', 'i', [['Accept if either', 't'], ['channel verifies', 't']]),
  box('xlayout', 200, 388, 200, 40, 'key', 'verify', 'c', [['Bit layout', 't'], ['from the public key', 's']]),
  box('kpub', 604, 388, 140, 40, 'key', 'identity', 'a', [['Public key', 't'], ['the only trust anchor', 's']]),
  box('ctrl', 770, 388, 220, 40, 'crypto', 'controls', 'j', [['Negative controls', 't'], ['wrong key, unsigned, impostor', 's']]),
];

// Path, the stage that lights it, its color, and (verifier side) the channel it belongs to.
const EDGES = [
  ['M164,115H188', 'payload', 'neutral'],
  ['M258,52V87', 'payload', 'key'],
  ['M328,115H352', 'payload', 'crypto'],
  ['M484,115H506V91H538', 'embed', 'phase'],
  ['M484,115H506V139H538', 'embed', 'mag'],
  ['M582,52V62', 'embed', 'neutral'],
  ['M727,52V62', 'embed', 'key'],
  ['M754,91H782V115H800', 'embed', 'phase'],
  ['M754,139H782V115H800', 'embed', 'mag'],
  ['M864,115H880', 'embed', 'neutral'],
  ['M935,143V188', 'attack', 'neutral'],
  ['M102,230V302', 'attack', 'neutral'],
  ['M164,330H176V291H200', 'verify', 'phase'],
  ['M164,330H176V343H200', 'verify', 'mag'],
  ['M400,291H436', 'verify', 'phase'],
  ['M400,343H436', 'verify', 'mag'],
  ['M576,291H604', 'verify', 'neutral', 'phase'],
  ['M576,343H604', 'verify', 'neutral', 'magnitude'],
  ['M744,315H770', 'verify', 'crypto'],
  ['M300,388V376', 'verify', 'key'],
  ['M674,388V364', 'verify', 'key'],
  ['M604,408H400', 'verify', 'key'],
].map(([d, stage, kind, channel]) => ({ d, stage, kind, channel }));

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Draw the diagram into `host`.
 * @param {HTMLElement} host
 * @param {{onOpen?: (card: string) => void}} [opts] called with a card letter when a lit box is chosen
 */
export function createFlow(host, { onOpen } = {}) {
  const still = reducedMotion();
  const svg = select(host)
    .append('svg')
    .attr('viewBox', `0 0 ${VW} ${VH}`)
    .attr('role', 'group')
    .attr('aria-label', 'Protocol diagram: signer, attacks, verifier');
  const defs = svg.append('defs');
  const markers = new Map();
  const arrow = (color) => {
    if (!markers.has(color)) {
      const id = `flow-arrow-${markers.size}`;
      defs
        .append('marker')
        .attr('id', id)
        .attr('viewBox', '0 0 10 10')
        .attr('refX', 9)
        .attr('refY', 5)
        .attr('markerUnits', 'userSpaceOnUse')
        .attr('markerWidth', 8)
        .attr('markerHeight', 8)
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,1L9,5L0,9z')
        .attr('fill', color);
      markers.set(color, `url(#${id})`);
    }
    return markers.get(color);
  };

  // Lanes and STFT frames.
  const bg = svg.append('g');
  for (const [y0, y1, label] of [[0, 178, 'SIGNER'], [242, VH, 'VERIFIER']]) {
    bg.append('rect').attr('class', 'lane-head').attr('x', 0.5).attr('y', y0 + 0.5).attr('width', 28).attr('height', y1 - y0 - 1).attr('rx', 8);
    bg.append('rect').attr('class', 'lane-head').attr('x', 16).attr('y', y0 + 0.5).attr('width', 12.5).attr('height', y1 - y0 - 1);
    bg.append('rect').attr('class', 'lane').attr('x', 0.5).attr('y', y0 + 0.5).attr('width', VW - 1).attr('height', y1 - y0 - 1).attr('rx', 8);
    bg.append('text')
      .attr('class', 'lane-label')
      .attr('transform', `translate(18,${(y0 + y1) / 2}) rotate(-90)`)
      .attr('text-anchor', 'middle')
      .text(label);
  }
  for (const [x, y, w, h] of [[526, 62, 240, 106], [188, 256, 224, 120]]) {
    bg.append('rect').attr('class', 'stft').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 6);
    bg.append('rect').attr('class', 'tab-bg').attr('x', x + w / 2 - 20).attr('y', y - 7).attr('width', 40).attr('height', 14);
    bg.append('text').attr('class', 'tab').attr('x', x + w / 2).attr('y', y + 3.5).attr('text-anchor', 'middle').text('STFT');
  }

  const gEdges = svg.append('g').attr('class', 'edges');
  for (const e of EDGES) e.path = gEdges.append('path').attr('d', e.d);
  for (const [x, y] of [[506, 115], [782, 115], [176, 330]]) gEdges.append('circle').attr('class', 'junction').attr('cx', x).attr('cy', y).attr('r', 2.2);
  const gDots = svg.append('g');

  const nodes = new Map();
  const gNodes = svg.append('g');
  for (const n of NODES) {
    const g = gNodes.append('g').attr('class', 'node');
    g.append('rect').attr('class', 'box').attr('x', n.x + 0.5).attr('y', n.y + 0.5).attr('width', n.w - 1).attr('height', n.h - 1).attr('rx', 6);
    g.append('circle').attr('class', 'led').attr('cx', n.x + n.w - 9).attr('cy', n.y + 9).attr('r', 3);
    const tg = g.append('g');
    const open = () => g.classed('linked') && onOpen?.(n.card);
    g.on('click', open);
    g.on('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        open();
      }
    });
    nodes.set(n.id, { n, g, tg, lines: n.idle });
  }

  function write(tg, n, lines) {
    tg.selectAll('*').remove();
    let y = n.y + (n.h - lines.reduce((a, [, c]) => a + LH[c], 0)) / 2;
    for (const [s, cls, color] of lines) {
      y += LH[cls];
      tg.append('text').attr('class', cls).attr('x', n.x + n.w / 2).attr('y', y - 4).attr('text-anchor', 'middle').attr('fill', color ?? null).text(s);
    }
  }

  function paint(id, state, lines) {
    const node = nodes.get(id);
    const { n, g, tg } = node;
    if (lines) {
      node.lines = lines;
      write(tg, n, lines);
    }
    const color = { done: id === 'out' ? C.ok : KIND[n.kind], fail: C.bad, run: C.blue }[state] ?? C.line2;
    const lit = state === 'done' || state === 'fail' || state === 'skip';
    g.attr('data-state', state);
    g.select('.box')
      .attr('stroke', color)
      .attr('stroke-width', state === 'done' || state === 'fail' ? 1.6 : 1.2)
      .attr('stroke-dasharray', state === 'skip' || id === 'transport' ? '4 3' : null);
    g.select('.led').attr('fill', state === 'idle' || state === 'skip' ? C.line : color);
    g.classed('linked', lit)
      .attr('tabindex', lit ? 0 : null)
      .attr('role', lit ? 'button' : null)
      .attr('aria-label', lit ? `${node.lines.map((l) => l[0]).join(', ')}. Open card ${n.card}.` : null);
  }

  function edgeIdle(e) {
    e.path.interrupt().attr('stroke', C.line2).attr('stroke-width', 1.3).attr('stroke-dasharray', null).attr('stroke-dashoffset', null).attr('marker-end', arrow(C.line2));
  }

  function edgeOn(e, i) {
    const color = KIND[e.kind];
    e.path.attr('stroke', color).attr('stroke-width', 1.6);
    if (still) {
      e.path.attr('marker-end', arrow(color));
      return;
    }
    const p = e.path.node();
    const L = p.getTotalLength();
    e.path
      .attr('marker-end', null)
      .attr('stroke-dasharray', `${L} ${L}`)
      .attr('stroke-dashoffset', L)
      .transition()
      .delay(i * 70)
      .duration(420)
      .ease(easeCubicInOut)
      .attr('stroke-dashoffset', 0)
      .on('end', () => e.path.attr('stroke-dasharray', null).attr('stroke-dashoffset', null).attr('marker-end', arrow(color)));
    const p0 = p.getPointAtLength(0);
    gDots
      .append('circle')
      .attr('r', 3.4)
      .attr('fill', color)
      .attr('transform', `translate(${p0.x},${p0.y})`)
      .transition()
      .delay(i * 70)
      .duration(650)
      .ease(easeCubicInOut)
      .attrTween('transform', () => (t) => {
        const q = p.getPointAtLength(t * L);
        return `translate(${q.x},${q.y})`;
      })
      .remove();
  }

  let attackText = 'none';

  const api = {
    reset() {
      gDots.selectAll('*').interrupt().remove();
      for (const { n } of nodes.values()) paint(n.id, 'idle', n.idle);
      EDGES.forEach(edgeIdle);
      api.attacks(attackText);
    },
    /** Attack list shown before a run. */
    attacks(text) {
      attackText = text;
      if (nodes.get('transport').g.attr('data-state') === 'idle') paint('transport', 'idle', [['Attacks on the signed file', 't'], [text, 's']]);
    },
    start(stage) {
      for (const n of NODES) if (n.stage === stage) paint(n.id, 'run');
    },
    fail(stage) {
      for (const n of NODES) if (n.stage === stage) paint(n.id, 'fail');
    },
    done(stage, d) {
      let channel = null;
      if (stage === 'identity') {
        paint('kpriv', 'done', [['Secret key', 't'], ['never leaves this tab', 's']]);
        paint('kpub', 'done', [['Public key', 't'], [`${d.publicKey.slice(0, 16)}…`, 's']]);
      } else if (stage === 'load') {
        paint('host', 'done', [['Host audio', 't'], [`${d.seconds.toFixed(1)} s`, 's']]);
      } else if (stage === 'payload') {
        paint('msg', 'done', [['Message', 't'], [plural(d.parts.message.length, 'byte', 'bytes'), 's']]);
        paint('sign', 'done', [['Ed25519 sign', 't'], ['64-byte signature', 's']]);
        paint('rs', 'done', [['Reed-Solomon', 't'], [`${d.payload.length} bytes in all`, 's']]);
        paint('layout', 'done', [['Bit layout', 't'], [`${d.band.bp} bins, ${d.band.bm} pairs`, 's']]);
      } else if (stage === 'embed') {
        paint('phase', 'done', [['Phase channel', 't'], [`bit to ±π/2, ${plural(d.replicas.phase, 'copy', 'copies')}`, 's']]);
        paint('mag', 'done', [['Magnitude channel', 't'], [`QIM, ${plural(d.replicas.magnitude, 'copy', 'copies')}`, 's']]);
        paint('istft', 'done', [['ISTFT', 't']]);
        paint('signed', 'done', [['Signed audio', 't'], [`SNR ${d.snr.toFixed(1)} dB`, 's']]);
      } else if (stage === 'attack') {
        const steps = d.steps.filter((s) => !s.skipped).map((s) => s.label);
        paint('transport', 'done', [['Attacks on the signed file', 't'], [steps.length ? steps.join(', ') : 'none', 's']]);
        paint('recv', 'done', [['Received', 't'], [`${(d.samples / SR).toFixed(1)} s`, 's']]);
      } else if (stage === 'verify') {
        const r = d.result;
        channel = r.verified ? r.channel : null;
        for (const [ch, read, rs, title, how] of [['phase', 'pread', 'rsp', 'Phase read', 'sign of sin φ'], ['magnitude', 'mread', 'rsm', 'Magnitude read', 'parity of d']]) {
          const c = d.transport.attacked[ch].combined;
          paint(read, 'done', [[title, 't'], [channel === ch && c ? `${how}, ${plural(c.byteErrors, 'bad byte', 'bad bytes')}` : how, 's']]);
          const sub = channel === ch ? `${plural(r.rs_corrected, 'byte', 'bytes')} repaired` : 'not used';
          paint(rs, channel === ch ? 'done' : 'skip', [['RS decode', 't'], [sub, 's']]);
        }
        paint('verify', r.verified ? 'done' : 'fail', [['Ed25519 verify', 't'], [r.verified ? 'signature valid' : 'no valid signature', 's']]);
        paint('out', r.verified ? 'done' : 'fail', r.verified
          ? [['Verified', 'v', C.ok], [`from the ${r.channel} channel`, 's'], [`“${clip(r.message, 30)}”`, 's']]
          : [['Not verified', 'v', C.bad], [clip(r.reason, 34), 's']]);
        paint('xlayout', 'done', [['Bit layout', 't'], ['rebuilt from the public key', 's']]);
      } else if (stage === 'controls') {
        const n = ['wrongKey', 'unsigned', 'impostor'].filter((k) => !d[k].verified).length;
        paint('ctrl', n === 3 ? 'done' : 'fail', [['Negative controls', 't'], [`${n} of 3 rejected`, 's']]);
      }
      EDGES.filter((e) => e.stage === stage && (!e.channel || e.channel === channel)).forEach(edgeOn);
    },
  };
  api.reset();
  return api;
}
