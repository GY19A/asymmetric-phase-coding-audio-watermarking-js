/**
 * Card b (the signed payload and its bit streams) and card c (the key-derived layout).
 * @module ui/cards/payload
 */

import { select, pointer, scaleLinear, axisBottom, easeCubicInOut } from 'd3';
import { h, fig, readouts, onWidth, sizeCanvas, showTip, hideTip, reducedMotion } from '../dom.js';
import { C, signal } from '../colors.js';
import { HEADER_BITS, N_BINS, NSYM, binKHz, binHz, byteHex, byteBits, byteChar, fmtInt } from '../format.js';

/** Payload segments in byte order. */
function segments(parts) {
  const m = parts.message.length;
  return [
    { id: 'length', name: 'Length', short: 'len', start: 0, n: 2, color: C.muted },
    { id: 'message', name: 'Message', short: 'message', start: 2, n: m, color: C.blue },
    { id: 'signature', name: 'Ed25519 signature', short: 'signature', start: 2 + m, n: 64, color: C.darkestGold },
    { id: 'parity', name: 'Reed-Solomon parity', short: 'RS parity', start: 2 + m + 64, n: NSYM, color: C.darkestBlue },
  ];
}

const segOf = (segs, j) => segs.find((s) => j >= s.start && j < s.start + s.n);

function segmentBar(plot, segs, total) {
  onWidth(plot, (W) => {
    plot.replaceChildren();
    const Hh = 30;
    const x = scaleLinear().domain([0, total]).range([0, W]);
    const svg = select(plot).append('svg').attr('width', W).attr('height', Hh + 4).attr('class', 'segbar');
    const g = svg.selectAll('g').data(segs).join('g').attr('transform', (s) => `translate(${x(s.start)},0)`);
    g.append('rect')
      .attr('width', (s) => Math.max(1, x(s.n) - 2))
      .attr('height', Hh)
      .attr('rx', 5)
      .attr('fill', (s) => s.color)
      .attr('fill-opacity', 0.22)
      .attr('stroke', (s) => s.color)
      .attr('stroke-opacity', 0.9);
    g.append('text')
      .attr('x', 9)
      .attr('y', Hh / 2)
      .attr('dy', '0.35em')
      .attr('fill', C.text)
      .text((s) => {
        const full = `${s.short} ${s.n}`;
        const w = x(s.n);
        if (w > full.length * 7 + 18) return full;
        if (w > String(s.n).length * 7 + 14) return String(s.n);
        return '';
      });
  });
}

function byteMap(plot, payload, segs, onHover) {
  onWidth(plot, (W) => {
    plot.replaceChildren();
    const cell = W < 520 ? 20 : 24;
    const cols = Math.max(8, Math.floor(W / cell));
    const rows = Math.ceil(payload.length / cols);
    const svg = select(plot).append('svg').attr('width', W).attr('height', rows * cell).attr('class', 'bytemap');
    svg.attr('role', 'img').attr('aria-label', `Map of the ${payload.length} payload bytes`);
    const g = svg
      .selectAll('g')
      .data(Array.from(payload))
      .join('g')
      .attr('transform', (_, j) => `translate(${(j % cols) * cell},${Math.floor(j / cols) * cell})`);
    g.append('rect')
      .attr('class', 'byte')
      .attr('width', cell - 3)
      .attr('height', cell - 3)
      .attr('rx', 3)
      .attr('fill', (_, j) => segOf(segs, j).color)
      .attr('fill-opacity', (v) => 0.12 + (0.33 * v) / 255);
    g.append('text')
      .attr('x', (cell - 3) / 2)
      .attr('y', (cell - 3) / 2)
      .attr('dy', '0.36em')
      .attr('text-anchor', 'middle')
      .attr('font-family', 'ui-monospace, Menlo, Consolas, monospace')
      .attr('font-size', cell < 24 ? 8 : 9.5)
      .attr('fill', C.text)
      .attr('pointer-events', 'none')
      .text((v) => v.toString(16).padStart(2, '0'));
    g.on('pointermove', (ev, v) => {
      const j = g.nodes().indexOf(ev.currentTarget);
      const s = segOf(segs, j);
      showTip(ev, `Byte ${j} of ${payload.length}`, [
        ['part', `${s.name}, byte ${j - s.start + 1} of ${s.n}`],
        ['hex', byteHex(v)],
        ['ascii', byteChar(v)],
        ['bits', byteBits(v)],
        ['stream', `body bits ${8 * j} to ${8 * j + 7}`],
      ]);
      select(ev.currentTarget).select('rect').classed('hl', true);
      onHover(j);
    }).on('pointerleave', (ev) => {
      hideTip();
      select(ev.currentTarget).select('rect').classed('hl', false);
      onHover(null);
    });
  });
}

/**
 * Bit strips of both channel streams at a common scale: three header copies, then the body
 * replicas. `highlight(j)` outlines the bits of payload byte j in every replica.
 */
function bitStrips(plot, streams, bodyBits) {
  const lanes = [
    { id: 'phase', name: 'Phase stream', bits: streams.phase },
    { id: 'magnitude', name: 'Magnitude stream', bits: streams.magnitude },
  ];
  const maxLen = Math.max(...lanes.map((l) => l.bits.length));
  let hl = null;
  let redraw = () => {};
  const off = lanes.map((l) => {
    const c = document.createElement('canvas');
    c.width = l.bits.length;
    c.height = 1;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(l.bits.length, 1);
    const one = [39, 116, 174];
    const zero = [255, 184, 28];
    for (let i = 0; i < l.bits.length; i++) {
      const col = l.bits[i] ? one : zero;
      img.data.set([...col, 255], 4 * i);
    }
    ctx.putImageData(img, 0, 0);
    return c;
  });
  onWidth(plot, (W) => {
    plot.replaceChildren();
    const laneH = 16;
    const gap = 56;
    const top = 30;
    const Hh = top + lanes.length * (laneH + gap) - gap + 22;
    const canvas = h('canvas');
    const svgEl = h('svg:svg', { class: 'layer', width: W, height: Hh });
    plot.style.height = `${Hh}px`;
    plot.append(canvas, svgEl);
    const ctx = sizeCanvas(canvas, W, Hh);
    const x = scaleLinear().domain([0, maxLen]).range([0, W]);
    const svg = select(svgEl);
    redraw = () => {
      ctx.clearRect(0, 0, W, Hh);
      lanes.forEach((l, li) => {
        const y = top + li * (laneH + gap);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(off[li], 0, 0, l.bits.length, 1, 0, y, x(l.bits.length), laneH);
        if (hl !== null) {
          ctx.strokeStyle = C.text;
          ctx.lineWidth = 1.5;
          const reps = Math.floor((l.bits.length - HEADER_BITS) / bodyBits);
          for (let r = 0; r < reps; r++) {
            const a = HEADER_BITS + r * bodyBits + 8 * hl;
            const x0 = x(a);
            ctx.strokeRect(x0 - 1, y - 3, Math.max(3, x(a + 8) - x0) + 2, laneH + 6);
          }
        }
      });
    };
    redraw();
    lanes.forEach((l, li) => {
      const y = top + li * (laneH + gap);
      const reps = Math.floor((l.bits.length - HEADER_BITS) / bodyBits);
      const spans = [{ a: 0, b: HEADER_BITS, label: 'header x3', header: true }];
      for (let r = 0; r < reps; r++) {
        spans.push({ a: HEADER_BITS + r * bodyBits, b: HEADER_BITS + (r + 1) * bodyBits, label: reps > 1 ? `body, replica ${r + 1}` : 'body' });
      }
      const g = svg.append('g').attr('transform', `translate(0,${y})`);
      g.append('text').attr('x', 0).attr('y', -21).attr('class', 'axis-label').attr('fill', C.muted)
        .text(`${l.name}: ${fmtInt(l.bits.length)} bits`);
      for (const s of spans) {
        const x0 = x(s.a) + 0.5;
        const x1 = x(s.b) - 1;
        g.append('path').attr('d', `M${x0},-3 v-4 H${x1} v4`).attr('fill', 'none').attr('stroke', s.header ? C.soft : C.line2);
        if (!s.header) g.append('text').attr('x', x0 + 4).attr('y', -9).attr('class', 'axis-label').attr('font-size', 10).text(s.label);
      }
      // Header copies: three ticks inside the header span.
      for (let c = 1; c < 3; c++) g.append('line').attr('x1', x(32 * c)).attr('x2', x(32 * c)).attr('y1', -1).attr('y2', laneH + 1).attr('stroke', C.bg).attr('stroke-width', 1.5);
      g.append('text').attr('x', 0).attr('y', laneH + 13).attr('class', 'axis-label').attr('font-size', 10).text('header x3');
      g.append('rect').attr('width', x(l.bits.length)).attr('height', laneH).attr('fill', 'transparent')
        .on('pointermove', (ev) => {
          const i = Math.max(0, Math.min(l.bits.length - 1, Math.floor(x.invert(pointer(ev)[0]))));
          const part = i < HEADER_BITS
            ? `header copy ${Math.floor(i / 32) + 1}, bit ${i % 32}`
            : `body bit ${(i - HEADER_BITS) % bodyBits}${reps > 1 ? `, replica ${Math.floor((i - HEADER_BITS) / bodyBits) + 1}` : ''}`;
          showTip(ev, `${l.name}, position ${i}`, [['part', part], ['bit', l.bits[i]]]);
        })
        .on('pointerleave', hideTip);
    });
  });
  return (j) => {
    hl = j;
    redraw();
  };
}

export function renderPayload(body, run) {
  const d = run.payload;
  const e = run.embed;
  const segs = segments(d.parts);
  const mBytes = d.parts.message.length;
  body.append(
    h(
      'div',
      { class: 'card-text' },
      h('p', { text: `Length, message and Ed25519 signature, plus 30 Reed-Solomon bytes that repair up to 15 errors: ${d.payload.length} bytes in all.` }),
    ),
  );
  const bar = fig('Payload layout, bytes');
  segmentBar(bar.plot, segs, d.payload.length);
  const legend = h('ul', { class: 'legend' }, segs.map((s) => h('li', {}, h('span', { class: 'sw', style: { background: s.color } }), `${s.name}, ${s.n} B`)));
  bar.el.append(legend);
  const map = fig('Every byte', { caption: 'Hover a byte to see its value and where its bits sit in both streams.' });
  const strips = fig('Bit streams, one per channel', {
    caption: 'Blue is a 1, gold a 0. Extra copies are summed before each bit is read.',
  });
  let highlight = () => {};
  byteMap(map.plot, d.payload, segs, (j) => highlight(j));
  highlight = bitStrips(strips.plot, e.streams, d.bits);
  body.append(bar.el, map.el, strips.el);
  body.append(
    readouts([
      ['Message', `${mBytes} B, UTF-8`],
      ['Payload', `${d.payload.length} B = ${fmtInt(d.bits)} bits`],
      ['Header', `${d.bits} as be32, 3 copies`],
      ['Phase replicas', String(e.replicas.phase), 'accent'],
      ['Magnitude replicas', String(e.replicas.magnitude), 'accent'],
      ['RS repair budget', '15 bytes'],
    ]),
  );
}

// ---------- card c ----------

function layoutPlot(plot, d, animate) {
  const band = d.band;
  const kp = d.kp;
  const pairs = d.pairs;
  const bm = band.bm;
  const role = new Map();
  kp.forEach((k, i) => role.set(k, { slot: i }));
  for (let s = 0; s < bm; s++) {
    for (const [k, partner] of [[pairs[2 * s], pairs[2 * s + 1]], [pairs[2 * s + 1], pairs[2 * s]]]) {
      const r = role.get(k) ?? {};
      r.pair = s;
      r.partner = partner;
      role.set(k, r);
    }
  }
  const lo = Math.max(0, Math.min(band.p_lo, band.m_lo) - 14);
  const hi = Math.min(N_BINS, Math.max(band.p_hi, band.m_hi) + 14);
  const ovLo = Math.max(band.p_lo, band.m_lo);
  const ovHi = Math.min(band.p_hi, band.m_hi);
  let play = () => {};
  onWidth(plot, (W) => {
    plot.replaceChildren();
    const m = { l: 6, r: 6 };
    const ctxH = 30;
    const yAxis = 190;
    const arcH = 90;
    const Hh = yAxis + arcH + 50;
    const svg = select(plot).append('svg').attr('width', W).attr('height', Hh);
    svg.attr('role', 'img').attr('aria-label', 'Phase bins and magnitude bin pairs chosen by the key');
    const defs = svg.append('defs');
    defs.append('pattern').attr('id', 'hatch').attr('width', 6).attr('height', 6).attr('patternUnits', 'userSpaceOnUse').attr('patternTransform', 'rotate(45)')
      .append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6).attr('stroke', C.text).attr('stroke-opacity', 0.35).attr('stroke-width', 1.2);

    // Context: the whole 1025-bin axis, 0 to 22.05 kHz.
    const xc = scaleLinear().domain([0, N_BINS - 1]).range([m.l, W - m.r]);
    const gc = svg.append('g').attr('transform', 'translate(0,16)');
    gc.append('rect').attr('x', xc(0)).attr('width', xc(N_BINS - 1) - xc(0)).attr('height', 10).attr('rx', 2).attr('fill', C.grid);
    gc.append('rect').attr('x', xc(band.p_lo)).attr('width', xc(band.p_hi) - xc(band.p_lo)).attr('height', 5).attr('fill', C.blue).attr('fill-opacity', 0.75);
    gc.append('rect').attr('x', xc(band.m_lo)).attr('y', 5).attr('width', xc(band.m_hi) - xc(band.m_lo)).attr('height', 5).attr('fill', C.darkestGold).attr('fill-opacity', 0.75);
    gc.append('rect').attr('x', xc(lo)).attr('y', -3).attr('width', xc(hi) - xc(lo)).attr('height', 16).attr('fill', 'none').attr('stroke', C.muted).attr('rx', 3);
    const kTicks = [0, 5, 10, 15, 20].map((f) => (f * 1000 * 2048) / 44100);
    gc.append('g').attr('class', 'axis').attr('transform', 'translate(0,12)')
      .call(axisBottom(xc).tickValues(kTicks).tickFormat((k) => `${Math.round(binHz(k) / 1000)} kHz`).tickSize(3))
      .call((a) => a.select('.domain').remove());
    svg.append('text').attr('x', m.l).attr('y', 8).attr('class', 'axis-label').text(W < 560 ? `All ${N_BINS} bins, 0 to 22.05 kHz` : `All ${N_BINS} bins, 0 to 22.05 kHz. The marked bands, zoomed below.`);
    // Zoom lines from the context window to the focus axis.
    const x = scaleLinear().domain([lo, hi]).range([m.l, W - m.r]);
    svg.append('path').attr('d', `M${xc(lo)},29 L${x(lo)},${ctxH + 34} M${xc(hi)},29 L${x(hi)},${ctxH + 34}`).attr('stroke', C.line2).attr('fill', 'none').attr('stroke-dasharray', '2 3');

    // Focus: phase slots on top, bins on the axis, magnitude slots below. Each magnitude
    // slot owns a pair of adjacent bins; the key shuffles which pair goes to which slot.
    const ySlots = ctxH + 44;
    const g = svg.append('g');
    g.append('rect').attr('x', x(ovLo)).attr('y', ySlots).attr('width', Math.max(0, x(ovHi) - x(ovLo))).attr('height', yAxis - ySlots + arcH)
      .attr('fill', 'url(#hatch)').attr('opacity', 0.18);
    g.append('rect').attr('x', x(band.p_lo)).attr('y', yAxis - 7).attr('width', x(band.p_hi) - x(band.p_lo)).attr('height', 6).attr('fill', C.blue).attr('fill-opacity', 0.5);
    g.append('rect').attr('x', x(band.m_lo)).attr('y', yAxis + 1).attr('width', x(band.m_hi) - x(band.m_lo)).attr('height', 6).attr('fill', C.darkestGold).attr('fill-opacity', 0.5);
    g.append('text').attr('x', x(lo)).attr('y', ySlots - 8).attr('class', 'axis-label').text('phase slot, in order');
    g.append('text').attr('x', x(hi)).attr('y', ySlots - 8).attr('text-anchor', 'end').attr('class', 'axis-label')
      .text(`overlap ${binKHz(ovLo)} to ${binKHz(ovHi)} kHz`);
    const slotX = (i) => x(band.p_lo + ((i + 0.5) * (band.p_hi - band.p_lo)) / band.bp);
    const braid = g.append('g').attr('fill', 'none').attr('stroke-width', 1).attr('stroke-opacity', 0.75);
    const braidPath = (i, t) => {
      const x0 = slotX(i);
      const x1 = x(kp[i] + 0.5);
      const xm = x0 + (x1 - x0) * t;
      const ym = (ySlots + yAxis - 8) / 2;
      return `M${x0},${ySlots} C${x0},${ym} ${xm},${ym} ${xm},${yAxis - 8}`;
    };
    const lines = braid.selectAll('path').data(Array.from(kp)).join('path').attr('stroke', (_, i) => signal(i / (band.bp - 1)));
    g.append('g').selectAll('rect').data(Array.from(kp)).join('rect')
      .attr('x', (_, i) => slotX(i) - 0.6).attr('y', ySlots - 3).attr('width', 1.2).attr('height', 4).attr('fill', (_, i) => signal(i / (band.bp - 1)));
    const yMag = yAxis + arcH - 4;
    const magX = (s) => x(band.m_lo + ((s + 0.5) * (band.m_hi - band.m_lo)) / bm);
    const slotsM = Array.from({ length: bm }, (_, s) => s);
    const arcs = g.append('g').attr('fill', 'none').attr('stroke-width', 1).selectAll('path').data(slotsM).join('path')
      .attr('stroke', (s) => signal(s / (bm - 1))).attr('stroke-opacity', 0.75);
    g.append('g').selectAll('rect').data(slotsM).join('rect')
      .attr('x', (s) => magX(s) - 0.8).attr('y', yMag - 1).attr('width', 1.6).attr('height', 4).attr('fill', (s) => signal(s / (bm - 1)));
    // A bracket under each pair, then a line down to its slot.
    const arcPath = (s, t) => {
      const a = x(pairs[2 * s] + 0.15);
      const b = x(pairs[2 * s + 1] + 0.85);
      const c = (a + b) / 2;
      const y0 = yAxis + 9;
      const x1 = magX(s);
      const xm = c + (x1 - c) * t;
      const ym = (y0 + 4 + yMag) / 2;
      return `M${a},${y0} L${a},${y0 + 3} L${b},${y0 + 3} L${b},${y0} M${c},${y0 + 3} C${c},${ym} ${xm},${ym} ${xm},${y0 + 3 + (yMag - y0 - 3) * t}`;
    };
    const kHzTicks = [];
    for (let f = Math.ceil(binHz(lo) / 1000); f <= binHz(hi) / 1000; f++) kHzTicks.push((f * 1000 * 2048) / 44100);
    g.append('g').attr('class', 'axis').attr('transform', `translate(0,${yAxis + arcH + 22})`)
      .call(axisBottom(x).tickValues(kHzTicks).tickFormat((k) => `${Math.round(binHz(k) / 1000)} kHz`).tickSize(4));
    g.append('text').attr('x', x(lo)).attr('y', yMag + 14).attr('class', 'axis-label').text('magnitude slot, in order');

    // Hover: the role of the bin under the pointer.
    const mark = g.append('g').attr('pointer-events', 'none');
    svg.append('rect').attr('x', x(lo)).attr('y', ySlots - 6).attr('width', x(hi) - x(lo)).attr('height', yAxis - ySlots + arcH + 12).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const k = Math.round(x.invert(pointer(ev)[0]) - 0.5);
        const r = role.get(k);
        mark.selectAll('*').remove();
        mark.append('line').attr('x1', x(k + 0.5)).attr('x2', x(k + 0.5)).attr('y1', ySlots).attr('y2', yAxis + arcH).attr('stroke', C.text).attr('stroke-opacity', 0.5);
        const rows = [['frequency', `${binKHz(k)} kHz`]];
        if (r?.slot !== undefined) {
          rows.push(['phase', `slot ${r.slot}: stream bits ${r.slot}, ${r.slot + band.bp}, ${r.slot + 2 * band.bp}, ...`]);
          mark.append('circle').attr('cx', slotX(r.slot)).attr('cy', ySlots).attr('r', 3.5).attr('fill', C.text);
          lines.attr('stroke-opacity', (_, i) => (i === r.slot ? 1 : 0.12));
        } else {
          lines.attr('stroke-opacity', 0.75);
        }
        if (r?.pair !== undefined) {
          rows.push(['magnitude', `slot ${r.pair}, paired with bin ${r.partner}`]);
          mark.append('circle').attr('cx', magX(r.pair)).attr('cy', yMag + 1).attr('r', 3.5).attr('fill', C.text);
          arcs.attr('stroke-opacity', (s) => (s === r.pair ? 1 : 0.12)).attr('stroke-width', (s) => (s === r.pair ? 2 : 1));
        } else {
          arcs.attr('stroke-opacity', 0.75).attr('stroke-width', 1);
        }
        if (!r) rows.push(['role', 'not used']);
        showTip(ev, `Bin ${k}`, rows);
      })
      .on('pointerleave', () => {
        hideTip();
        mark.selectAll('*').remove();
        lines.attr('stroke-opacity', 0.75);
        arcs.attr('stroke-opacity', 0.75).attr('stroke-width', 1);
      });

    play = (anim) => {
      lines.interrupt().attr('d', (_, i) => braidPath(i, anim ? 0 : 1));
      arcs.interrupt().attr('d', (s) => arcPath(s, anim ? 0 : 1));
      if (!anim) return;
      lines.transition().delay((_, i) => 250 + (i % 40) * 12).duration(1300).ease(easeCubicInOut).attrTween('d', (_, i) => (t) => braidPath(i, t));
      arcs.transition().delay((s) => 700 + (s % 30) * 16).duration(1100).ease(easeCubicInOut).attrTween('d', (s) => (t) => arcPath(s, t));
    };
    play(animate);
    animate = false;
  });
  return (anim) => play(anim);
}

export function renderLayout(body, run) {
  const d = run.payload;
  const band = d.band;
  const ovLo = Math.max(band.p_lo, band.m_lo);
  const ovHi = Math.min(band.p_hi, band.m_hi);
  body.append(
    h(
      'div',
      { class: 'card-text' },
      h('p', { text: 'A shuffle seeded by the public key places every bit, so the verifier rebuilds the layout and nothing is stored.' }),
    ),
  );
  const f = fig('Key-derived layout', { caption: 'Phase slots drop to their bins; magnitude slots rise to their bin pairs. Hover a bin for details.' });
  const replay = h('button', { type: 'button', class: 'btn', text: 'Replay shuffle' });
  f.el.querySelector('.fig-title').append(replay);
  const play = layoutPlot(f.plot, d, !reducedMotion());
  replay.addEventListener('click', () => play(!reducedMotion()));
  body.append(f.el);
  body.append(
    readouts([
      ['Phase bins', `${band.bp}, bins ${band.p_lo} to ${band.p_hi - 1}`],
      ['Magnitude pairs', `${band.bm}, bins ${band.m_lo} to ${band.m_hi - 1}`],
      ['Overlap', ovHi > ovLo ? `${binKHz(ovLo)} to ${binKHz(ovHi)} kHz` : 'none'],
      ['Bits per group', `${band.bp} phase + ${band.bm} magnitude`],
      ['Group', '8 frames of 2048 samples'],
    ]),
  );
}

