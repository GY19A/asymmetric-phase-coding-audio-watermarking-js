/**
 * Card h: what the attacks did to the spectrum and to the soft bits of each channel, and
 * how many errors remain after the replicas are summed.
 * @module ui/cards/transport
 */

import { select, pointer, scaleLinear, scaleSqrt, axisBottom, axisLeft, line, max } from 'd3';
import { h, fig, readouts, onWidth, sizeCanvas, showTip, hideTip } from '../dom.js';
import { C } from '../colors.js';
import { HEADER_BITS, N_BINS, binHz, binKHz, fmtDb, fmtInt, fmtPct } from '../format.js';

const CHANNELS = [
  { id: 'phase', name: 'Phase', color: C.blue },
  { id: 'magnitude', name: 'Magnitude', color: C.darkestGold },
];

function spectrumPlot(plot, spectrum, band) {
  onWidth(plot, (W) => {
    plot.replaceChildren();
    const Hh = 220;
    const m = { l: 40, r: 10, t: 20, b: 28 };
    const svg = select(plot).append('svg').attr('width', W).attr('height', Hh);
    svg.attr('role', 'img').attr('aria-label', 'Mean spectrum of the signed and the attacked file');
    const x = scaleLinear().domain([0, N_BINS - 1]).range([m.l, W - m.r]);
    let top = -Infinity;
    for (const v of spectrum.signed) top = Math.max(top, v);
    top = Math.ceil(top / 10) * 10;
    const y = scaleLinear().domain([top - 100, top]).range([Hh - m.b, m.t]).clamp(true);
    for (const [a, b, col] of [[band.p_lo, band.p_hi, C.blue], [band.m_lo, band.m_hi, C.darkestGold]]) {
      svg.append('rect').attr('x', x(a)).attr('width', x(b) - x(a)).attr('y', m.t).attr('height', Hh - m.t - m.b).attr('fill', col).attr('fill-opacity', 0.07);
    }
    for (let v = top - 100; v <= top; v += 20) svg.append('line').attr('class', 'gridline').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(v)).attr('y2', y(v));
    const ln = (arr) => line().x((_, k) => x(k)).y((v) => y(v))(Array.from(arr));
    svg.append('path').attr('d', ln(spectrum.signed)).attr('fill', 'none').attr('stroke', C.line2).attr('stroke-width', 3.2).attr('stroke-linejoin', 'round');
    svg.append('path').attr('d', ln(spectrum.attacked)).attr('fill', 'none').attr('stroke', C.bad).attr('stroke-width', 1.1);
    const kTicks = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22].map((f) => (f * 1000 * 2048) / 44100).filter((k) => k < N_BINS);
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${Hh - m.b})`)
      .call(axisBottom(x).tickValues(kTicks).tickFormat((k) => `${Math.round(binHz(k) / 1000)}`).tickSize(3));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(axisLeft(y).ticks(5).tickSize(3));
    svg.append('text').attr('class', 'axis-label').attr('x', W - m.r).attr('y', Hh - 2).attr('text-anchor', 'end').text('kHz');
    svg.append('text').attr('class', 'axis-label').attr('x', 4).attr('y', 10).text('dBFS');
    const mark = svg.append('line').attr('y1', m.t).attr('y2', Hh - m.b).attr('stroke', C.text).attr('stroke-opacity', 0);
    svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', Hh - m.t - m.b).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const k = Math.max(0, Math.min(N_BINS - 1, Math.round(x.invert(pointer(ev)[0]))));
        mark.attr('x1', x(k)).attr('x2', x(k)).attr('stroke-opacity', 0.4);
        showTip(ev, `${binKHz(k)} kHz, bin ${k}`, [
          ['signed', `${spectrum.signed[k].toFixed(1)} dBFS`],
          ['attacked', `${spectrum.attacked[k].toFixed(1)} dBFS`],
          ['change', fmtDb(spectrum.attacked[k] - spectrum.signed[k])],
        ]);
      })
      .on('pointerleave', () => {
        mark.attr('stroke-opacity', 0);
        hideTip();
      });
  });
}

/** Distribution of soft value times the true sign: right of zero reads correctly. */
function softPlot(plot, clean, attacked, color) {
  onWidth(plot, (W) => {
    plot.replaceChildren();
    const Hh = 150;
    const m = { l: 6, r: 6, t: 20, b: 22 };
    const svg = select(plot).append('svg').attr('width', W).attr('height', Hh);
    const nb = attacked.counts.length;
    const x = scaleLinear().domain([-1, 1]).range([m.l, W - m.r]);
    const share = (hst) => Array.from(hst.counts, (c) => c / Math.max(1, hst.n));
    const a = share(attacked);
    const c = share(clean);
    const y = scaleSqrt().domain([0, max([...a, ...c]) || 1]).range([Hh - m.b, m.t]);
    const bw = (x(1) - x(-1)) / nb;
    svg.append('rect').attr('x', x(-1)).attr('width', x(0) - x(-1)).attr('y', m.t).attr('height', Hh - m.t - m.b).attr('fill', C.bad).attr('fill-opacity', 0.05);
    svg.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y1', m.t).attr('y2', Hh - m.b).attr('stroke', C.line2);
    a.forEach((v, b) => {
      if (!v) return;
      const left = -1 + (2 * b) / nb;
      svg.append('rect').attr('x', x(left) + 0.5).attr('width', Math.max(0.5, bw - 1)).attr('y', y(v)).attr('height', y(0) - y(v))
        .attr('fill', left < 0 ? C.bad : color).attr('fill-opacity', 0.8);
    });
    const pts = [];
    c.forEach((v, b) => {
      pts.push([x(-1 + (2 * b) / nb), y(v)], [x(-1 + (2 * (b + 1)) / nb), y(v)]);
    });
    svg.append('path').attr('d', line()(pts)).attr('fill', 'none').attr('stroke', C.text).attr('stroke-width', 1).attr('stroke-opacity', 0.7);
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${Hh - m.b})`)
      .call(axisBottom(x).tickValues([-1, -0.5, 0, 0.5, 1]).tickFormat((v) => (v === 0 ? '0' : v.toFixed(1))).tickSize(3));
    svg.append('text').attr('class', 'axis-label').attr('x', x(-1)).attr('y', 11).attr('fill', C.bad).text('reads wrong');
    svg.append('text').attr('class', 'axis-label').attr('x', x(1)).attr('y', 11).attr('text-anchor', 'end').text('reads right');
    svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', Hh - m.t - m.b).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const b = Math.max(0, Math.min(nb - 1, Math.floor((pointer(ev)[0] - x(-1)) / bw)));
        const left = -1 + (2 * b) / nb;
        showTip(ev, `${left.toFixed(2)} to ${(left + 2 / nb).toFixed(2)}`, [
          ['attacked', fmtPct(a[b], 2)],
          ['clean', fmtPct(c[b], 2)],
        ]);
      })
      .on('pointerleave', hideTip);
  });
}

/** Summed soft values per body bit, times the true sign: one bar per bit, red below zero. */
function marginPlot(plot, sums, truth) {
  onWidth(plot, (W) => {
    plot.replaceChildren();
    const Hh = 56;
    const n = sums.length;
    const canvas = h('canvas');
    plot.append(canvas);
    const ctx = sizeCanvas(canvas, W, Hh);
    let peak = 0;
    const v = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      v[j] = sums[j] * (truth[j] ? 1 : -1);
      peak = Math.max(peak, Math.abs(v[j]));
    }
    peak ||= 1;
    const mid = Hh * 0.62;
    const up = mid - 2;
    const down = Hh - mid - 2;
    const bw = W / n;
    ctx.fillStyle = C.grid;
    ctx.fillRect(0, mid, W, 1);
    for (let j = 0; j < n; j++) {
      const t = v[j] / peak;
      if (t === 0) {
        // Erased: no replica reached this bit, so it carries no vote.
        ctx.fillStyle = C.line2;
        ctx.globalAlpha = 1;
        ctx.fillRect(j * bw, mid - 3, Math.max(1, bw), 6);
      } else if (t > 0) {
        ctx.fillStyle = C.ok;
        ctx.globalAlpha = 0.75;
        ctx.fillRect(j * bw, mid - t * up, Math.max(0.6, bw), t * up);
      } else {
        ctx.fillStyle = C.bad;
        ctx.globalAlpha = 1;
        ctx.fillRect(j * bw, mid, Math.max(1, bw), Math.max(3, -t * down));
      }
    }
    ctx.globalAlpha = 1;
    canvas.addEventListener('pointermove', (ev) => {
      const j = Math.max(0, Math.min(n - 1, Math.floor(ev.offsetX / bw)));
      showTip(ev, `Body bit ${j}, byte ${j >> 3}`, [['margin', v[j].toFixed(2)], ['decision', v[j] > 0 ? 'right' : v[j] < 0 ? 'wrong' : 'erased, no vote']]);
    });
    canvas.addEventListener('pointerleave', hideTip);
  });
}

function berTable(tr, bits) {
  const row = (label, side) =>
    CHANNELS.map((ch) => {
      const s = side[ch.id];
      const cmb = s.combined;
      return h(
        'tr',
        {},
        h('th', { scope: 'row' }, h('span', { class: 'sw', style: { background: ch.color } }), `${ch.name}, ${label}`),
        h('td', { text: fmtInt(s.capacity) }),
        h('td', { text: s.raw.n ? fmtPct(s.raw.errors / s.raw.n, 2) : 'n/a' }),
        h('td', { text: cmb ? String(cmb.replicas) : '0' }),
        h('td', { text: cmb ? `${cmb.bitErrors} of ${fmtInt(bits)}` : 'no full replica' }),
        h('td', { class: cmb ? (cmb.byteErrors <= 15 ? 'ok' : 'bad') : 'bad', text: cmb ? `${cmb.byteErrors}` : 'n/a' }),
      );
    });
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'ber' },
      h('thead', {}, h('tr', {}, ['Channel', 'Soft bits', 'Raw bit errors', 'Replicas', 'After summing', 'Byte errors (RS fixes 15)'].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', {}, row('clean', tr.clean), row('attacked', tr.attacked)),
    ),
  );
}

export function renderTransport(body, run) {
  const a = run.attack;
  const v = run.verify;
  const tr = v.transport;
  const band = run.payload.band;
  const bits = run.payload.bits;
  const truth = run.embed.streams.phase.subarray(HEADER_BITS, HEADER_BITS + bits);
  const done = a.steps.filter((s) => !s.skipped);
  const best = CHANNELS.map((ch) => ({ ch, c: tr.attacked[ch.id].combined })).filter((o) => o.c).sort((p, q) => p.c.byteErrors - q.c.byteErrors)[0];

  body.append(
    h(
      'div',
      { class: 'card-text' },
      h('p', { text: best ? `After voting, the better channel has ${best.c.byteErrors} bad byte${best.c.byteErrors === 1 ? '' : 's'}; Reed-Solomon repairs up to 15.` : 'Reed-Solomon repairs up to 15 bad bytes.' }),
    ),
  );
  body.append(
    h('ul', { class: 'chips', 'aria-label': 'Attacks applied' },
      a.steps.length
        ? a.steps.map((s) => h('li', { class: s.skipped ? 'skipped' : null }, h('span', { text: s.label }), s.skipped ? null : h('small', { text: s.ms < 1 ? '<1 ms' : `${Math.round(s.ms)} ms` })))
        : h('li', {}, h('span', { text: 'No attacks' }))),
  );
  const sp = fig('Mean spectrum, signed and attacked', { caption: 'Gray: signed. Red: attacked. Shaded: phase (blue) and magnitude (gold) bands.' });
  spectrumPlot(sp.plot, a.spectrum, band);
  body.append(sp.el);

  const cols = h('div', { class: 'cols' });
  for (const ch of CHANNELS) {
    const f = fig(`${ch.name} channel, soft bits`);
    softPlot(f.plot, tr.clean[ch.id].hist, tr.attacked[ch.id].hist, ch.color);
    const cmb = tr.attacked[ch.id].combined;
    const mg = h('div', { class: 'plot margin' });
    const mt = h('p', { class: 'fig-title sub', text: cmb ? `After summing ${cmb.replicas} replica${cmb.replicas === 1 ? '' : 's'}, per body bit` : 'After summing' });
    f.el.append(mt, mg);
    if (cmb) marginPlot(mg, cmb.sums, truth);
    else mg.append(h('p', { class: 'fig-cap', text: 'Too short for one full copy on this channel.' }));
    cols.append(f.el);
  }
  body.append(cols);
  body.append(h('p', { class: 'fig-cap', text: 'Top: soft values, attacked (bars) and clean (outline). Bottom: vote per bit; blue right, red wrong, gray erased.' }));
  body.append(berTable(tr, bits));
  body.append(
    readouts([
      ['Attacks', String(done.length)],
      ['Signed to attacked', fmtDb(a.snr)],
      ['Samples left', `${fmtInt(a.samples)} of ${fmtInt(run.embed.audio.length)}`],
    ]),
  );
}
