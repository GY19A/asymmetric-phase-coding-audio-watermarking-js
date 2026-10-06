/**
 * Card d: spectrograms of the original, the signed file and their difference, on one
 * shared scale, with a hover that shows which bins of which frame carry which bits.
 * @module ui/cards/spectra
 */

import { select, pointer, scaleLinear, axisLeft, axisBottom } from 'd3';
import { h, fig, readouts, onWidth, sizeCanvas, showTip, hideTip, segmented } from '../dom.js';
import { C, LEVEL, DIVERGING } from '../colors.js';
import { GROUP, SAMPLE_RATE, N_FFT, binHz, binKHz, fmtDb, fmtSeconds } from '../format.js';

const RANGE = 80;
const dbfs = (v) => `${v.toFixed(1)} dBFS`;
const FRAME_S = N_FFT / SAMPLE_RATE;

/** Image of a spectrogram (time left to right, frequency bottom to top) through a LUT. */
function image(spec, map, value) {
  const { frames, bins, db } = spec;
  const c = document.createElement('canvas');
  c.width = frames;
  c.height = bins;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(frames, bins);
  for (let t = 0; t < frames; t++) {
    for (let k = 0; k < bins; k++) {
      const v = value(db[t * bins + k], t * bins + k);
      const q = Math.max(0, Math.min(255, Math.round(v * 255)));
      const o = 4 * ((bins - 1 - k) * frames + t);
      img.data[o] = map[4 * q];
      img.data[o + 1] = map[4 * q + 1];
      img.data[o + 2] = map[4 * q + 2];
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function peak(db) {
  let m = -Infinity;
  for (let i = 0; i < db.length; i++) if (db[i] > m) m = db[i];
  return m;
}

/** Colorbar as an SVG gradient strip. */
function colorbar(svg, x, y, w, map, lo, hi, fmt) {
  const id = `cb${Math.random().toString(36).slice(2, 8)}`;
  const grad = svg.append('defs').append('linearGradient').attr('id', id);
  for (let i = 0; i <= 16; i++) {
    const q = Math.round((i / 16) * 255);
    grad.append('stop').attr('offset', `${(i / 16) * 100}%`).attr('stop-color', `rgb(${map[4 * q]},${map[4 * q + 1]},${map[4 * q + 2]})`);
  }
  const g = svg.append('g').attr('transform', `translate(${x},${y})`);
  g.append('rect').attr('width', w).attr('height', 6).attr('rx', 2).attr('fill', `url(#${id})`);
  g.append('text').attr('class', 'axis-label').attr('y', 18).text(fmt(lo));
  g.append('text').attr('class', 'axis-label').attr('x', w).attr('y', 18).attr('text-anchor', 'end').text(fmt(hi));
}

export function renderSpectra(body, run) {
  const e = run.embed;
  const p = run.payload;
  const band = p.band;
  const { before, after, residual } = e.spec;
  const bins = before.bins;
  const frames = before.frames;
  const loudest = Math.max(peak(before.db), peak(after.db));
  const top = Math.ceil(loudest / 5) * 5;
  const lo = top - RANGE;
  const resPeak = peak(residual.db);
  const norm = (v) => (v - lo) / RANGE;
  // Where the ear could hear a change: after minus before, masked where both are near silence.
  const change = new Float32Array(before.db.length);
  for (let i = 0; i < change.length; i++) {
    change[i] = Math.max(before.db[i], after.db[i]) < lo + 10 ? 0 : after.db[i] - before.db[i];
  }
  const imgs = {
    before: image(before, LEVEL, norm),
    after: image(after, LEVEL, norm),
    residual: image(residual, LEVEL, norm),
  };
  let changeImg = null;
  const role = new Map();
  p.kp.forEach((k, i) => role.set(k, { slot: i }));
  for (let s = 0; s < band.bm; s++) {
    for (const [k, other] of [[p.pairs[2 * s], p.pairs[2 * s + 1]], [p.pairs[2 * s + 1], p.pairs[2 * s]]]) {
      const r = role.get(k) ?? {};
      r.pair = s;
      r.partner = other;
      role.set(k, r);
    }
  }

  body.append(
    h(
      'div',
      { class: 'card-text' },
      h('p', { text: `One column per 46 ms frame. The change from signing peaks at ${dbfs(resPeak)}, far below the speech.` }),
    ),
  );

  const panels = [
    { id: 'before', title: 'Original' },
    { id: 'after', title: 'Signed' },
    { id: 'third', title: 'Difference' },
  ];
  let third = 'residual';
  const draws = [];
  const hovers = [];
  const toggle = segmented([['residual', 'Residual'], ['change', 'Level change']], 'residual', (v) => {
    third = v;
    if (v === 'change' && !changeImg) changeImg = image(before, DIVERGING, (_, i) => 0.5 + Math.max(-1, Math.min(1, change[i] / 5)) / 2);
    draws[2]?.();
  }, 'Difference panel');
  const cap = h('p', { class: 'fig-cap' });
  const setCap = () => {
    cap.textContent = third === 'residual'
      ? 'Residual: signed minus original, same color scale.'
      : 'Level change in dB, -5 (gold) to +5 (blue).';
  };
  setCap();

  const grid = h('div', { class: 'spec-grid' });
  for (const [pi, pnl] of panels.entries()) {
    const f = fig(pnl.title, { extra: pi === 2 ? toggle.el : null });
    grid.append(f.el);
    if (pi === 2) f.el.append(cap);
    const canvas = h('canvas');
    const svgEl = h('svg:svg', { class: 'layer' });
    f.plot.append(canvas, svgEl);
    f.plot.setAttribute('role', 'img');
    f.plot.setAttribute('aria-label', `${pnl.title} spectrogram, 0 to 11 kHz`);
    onWidth(f.plot, (W) => {
      const m = { l: 40, r: 26, t: 4, b: 34 };
      const Hh = Math.round(Math.min(300, Math.max(190, W * 0.62)));
      f.plot.style.height = `${Hh}px`;
      const ctx = sizeCanvas(canvas, W, Hh);
      const svg = select(svgEl).attr('width', W).attr('height', Hh);
      svg.selectAll('*').remove();
      const x = scaleLinear().domain([0, frames]).range([m.l, W - m.r]);
      const y = scaleLinear().domain([0, bins]).range([Hh - m.b, m.t]);
      const draw = () => {
        const src = pi < 2 ? imgs[pnl.id] : third === 'residual' ? imgs.residual : changeImg;
        ctx.clearRect(0, 0, W, Hh);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, x(0), y(bins), x(frames) - x(0), y(0) - y(bins));
        // Group boundaries every 8 frames.
        ctx.strokeStyle = 'rgba(0,59,92,0.10)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let t = GROUP; t < frames; t += GROUP) {
          const xx = Math.round(x(t)) + 0.5;
          ctx.moveTo(xx, y(bins));
          ctx.lineTo(xx, y(0));
        }
        ctx.stroke();
        if (pi === 2) {
          svg.selectAll('.cb').remove();
          const cb = svg.append('g').attr('class', 'cb');
          if (third === 'residual') colorbar(cb, W - m.r - 110, Hh - 12, 110, LEVEL, lo, top, (v) => `${v} dB`);
          else colorbar(cb, W - m.r - 110, Hh - 12, 110, DIVERGING, -5, 5, (v) => `${v > 0 ? '+' : ''}${v} dB`);
          setCap();
        }
      };
      draws[pi] = draw;
      draw();
      const fTicks = [0, 2, 4, 6, 8, 10].map((f) => (f * 1000 * N_FFT) / SAMPLE_RATE);
      svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`)
        .call(axisLeft(y).tickValues(fTicks).tickFormat((k) => Math.round(binHz(k) / 1000)).tickSize(3));
      svg.append('text').attr('class', 'axis-label').attr('x', 2).attr('y', m.t + 8).text('kHz');
      const secs = frames * FRAME_S;
      const step = secs > 20 ? 5 : secs > 8 ? 2 : 1;
      const tTicks = [];
      for (let s = 0; s <= secs; s += step) tTicks.push(s / FRAME_S);
      svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${Hh - m.b})`)
        .call(axisBottom(x).tickValues(tTicks).tickFormat((t) => `${Math.round(t * FRAME_S)} s`).tickSize(3));
      // Band markers on the right edge: phase (blue) and magnitude (gold).
      const bandMark = (a, b, col, dx) => svg.append('rect').attr('x', W - m.r + dx).attr('width', 3).attr('rx', 1)
        .attr('y', y(Math.min(b, bins))).attr('height', Math.max(0, y(Math.min(a, bins)) - y(Math.min(b, bins)))).attr('fill', col);
      bandMark(band.p_lo, band.p_hi, C.blue, 5);
      bandMark(band.m_lo, band.m_hi, C.darkestGold, 11);
      if (pi === 0) {
        svg.append('text').attr('class', 'axis-label').attr('x', W - m.r + 6).attr('y', y(band.p_hi) - 4).attr('fill', C.blue).text('P');
        svg.append('text').attr('class', 'axis-label').attr('x', W - m.r + 12).attr('y', y(Math.min(band.m_hi, bins)) - 4).attr('fill', C.darkestGold).text('M');
      }
      const over = svg.append('g').attr('pointer-events', 'none');
      hovers[pi] = (t, k) => {
        over.selectAll('*').remove();
        if (t === null) return;
        const g0 = t - (t % GROUP);
        over.append('rect').attr('x', x(g0)).attr('width', x(Math.min(frames, g0 + GROUP)) - x(g0)).attr('y', y(bins)).attr('height', y(0) - y(bins))
          .attr('fill', 'rgba(255,209,0,0.10)').attr('stroke', C.darkestBlue).attr('stroke-opacity', 0.6);
        over.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(k + 0.5)).attr('y2', y(k + 0.5)).attr('stroke', C.text).attr('stroke-opacity', 0.45);
        const r = role.get(k);
        if (r?.partner !== undefined && r.partner < bins) {
          over.append('line').attr('x1', x(g0)).attr('x2', x(Math.min(frames, g0 + GROUP))).attr('y1', y(r.partner + 0.5)).attr('y2', y(r.partner + 0.5))
            .attr('stroke', C.darkestGold).attr('stroke-width', 2);
        }
        if (r?.pair !== undefined) {
          over.append('line').attr('x1', x(g0)).attr('x2', x(Math.min(frames, g0 + GROUP))).attr('y1', y(k + 0.5)).attr('y2', y(k + 0.5))
            .attr('stroke', C.darkestGold).attr('stroke-width', 2);
        }
        if (r?.slot !== undefined) {
          over.append('circle').attr('cx', x(g0 + 0.5)).attr('cy', y(k + 0.5)).attr('r', 3.5).attr('fill', 'none').attr('stroke', C.blue).attr('stroke-width', 1.6);
        }
      };
      svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', Hh - m.t - m.b).attr('fill', 'transparent')
        .on('pointermove', (ev) => {
          const [px, py] = pointer(ev);
          const t = Math.max(0, Math.min(frames - 1, Math.floor(x.invert(px))));
          const k = Math.max(0, Math.min(bins - 1, Math.floor(y.invert(py))));
          for (const fn of hovers) fn?.(t, k);
          const i = t * bins + k;
          const g = Math.floor(t / GROUP);
          const r = role.get(k);
          const rows = [
            ['time', `${fmtSeconds(t * FRAME_S)}, frame ${t}, group ${g}`],
            ['frequency', `${binKHz(k)} kHz, bin ${k}`],
            ['original', dbfs(before.db[i])],
            ['signed', dbfs(after.db[i])],
            ['residual', dbfs(residual.db[i])],
          ];
          if (g < e.groups) {
            if (r?.slot !== undefined) rows.push(['phase bit', `stream position ${g * band.bp + r.slot}, first frame of the group`]);
            if (r?.pair !== undefined) rows.push(['magnitude bit', `stream position ${g * band.bm + r.pair}, pair with bin ${r.partner}`]);
          }
          if (!r) rows.push(['role', 'unmarked bin']);
          showTip(ev, pnl.title, rows);
        })
        .on('pointerleave', () => {
          for (const fn of hovers) fn?.(null);
          hideTip();
        });
    });
  }
  body.append(grid);
  body.append(
    h('ul', { class: 'legend' },
      h('li', {}, h('span', { class: 'sw', style: { background: C.blue } }), `phase band, ${binKHz(band.p_lo)} to ${binKHz(band.p_hi)} kHz`),
      h('li', {}, h('span', { class: 'sw', style: { background: C.darkestGold } }), `magnitude band, ${binKHz(band.m_lo)} to ${binKHz(band.m_hi)} kHz`),
      h('li', {}, h('span', { class: 'sw ring', style: { color: C.text } }), 'hover: the 8-frame group and the bits under the pointer'),
    ),
  );
  body.append(
    readouts([
      ['Frames', `${frames} of 2048 samples`],
      ['Groups', String(e.groups)],
      ['Signal to watermark', fmtDb(e.snr), 'accent'],
      ['Residual peak', dbfs(resPeak)],
      ['Loudest cell', dbfs(loudest)],
      ['Shown', '0 to 11 kHz'],
    ]),
  );
}
