/**
 * Card e (the phase channel on its polar dial) and card f (the magnitude channel on the
 * 1-nat parity lattice).
 * @module ui/cards/channels
 */

import { select, pointer, scaleLinear, axisBottom, axisLeft, max, timer, easeCubicInOut } from 'd3';
import { h, fig, readouts, onWidth, sizeCanvas, showTip, hideTip, segmented, reducedMotion, whenVisible } from '../dom.js';
import { C } from '../colors.js';
import { fmtPct, fmtInt } from '../format.js';

const PI = Math.PI;
const wrap = (a) => a - 2 * PI * Math.round(a / (2 * PI));
const deg = (a) => (a * 180) / PI;

/** Deterministic jitter in [0, 1) per index, so the dial does not reshuffle on resize. */
const jitter = (i) => {
  const v = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return v - Math.floor(v);
};

function histogram(values, lo, hi, nb, keep = () => true) {
  const c = new Uint32Array(nb);
  for (let i = 0; i < values.length; i++) {
    if (!keep(i)) continue;
    const q = Math.floor(((values[i] - lo) / (hi - lo)) * nb);
    c[Math.max(0, Math.min(nb - 1, q))]++;
  }
  return c;
}

/** Stacked two-class histogram (bit 1 over bit 0) as SVG. With `fill`, the height follows the plot box. */
function histPlot(plot, { lo, hi, nb, ones, zeros, ticks, tickFormat, height = 120, marks = [], fill = false }) {
  const draw = (W, Hp) => {
    plot.replaceChildren();
    const height = fill ? Math.max(Hp, 120) : Hp;
    const m = { l: 6, r: 6, t: 8, b: 22 };
    const svg = select(plot).append('svg').attr('width', W).attr('height', height);
    const x = scaleLinear().domain([lo, hi]).range([m.l, W - m.r]);
    const top = max(ones, (v, i) => v + zeros[i]) || 1;
    const y = scaleLinear().domain([0, top]).range([height - m.b, m.t]);
    const bw = (x(hi) - x(lo)) / nb;
    for (const mk of marks) {
      svg.append('line').attr('x1', x(mk)).attr('x2', x(mk)).attr('y1', m.t).attr('y2', height - m.b).attr('class', 'gridline').attr('stroke-dasharray', '2 3');
    }
    const g = svg.append('g');
    for (let b = 0; b < nb; b++) {
      const x0 = x(lo) + b * bw + 0.5;
      const w = Math.max(0.5, bw - 1);
      if (zeros[b]) g.append('rect').attr('x', x0).attr('width', w).attr('y', y(zeros[b])).attr('height', y(0) - y(zeros[b])).attr('fill', C.bit0).attr('fill-opacity', 0.85);
      if (ones[b]) g.append('rect').attr('x', x0).attr('width', w).attr('y', y(zeros[b] + ones[b])).attr('height', y(0) - y(ones[b])).attr('fill', C.bit1).attr('fill-opacity', 0.85);
    }
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${height - m.b})`)
      .call(axisBottom(x).tickValues(ticks).tickFormat(tickFormat).tickSize(3));
    svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', height - m.t - m.b).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const b = Math.max(0, Math.min(nb - 1, Math.floor((pointer(ev)[0] - x(lo)) / bw)));
        const a = lo + ((hi - lo) * b) / nb;
        showTip(ev, `${tickFormat(a)} to ${tickFormat(a + (hi - lo) / nb)}`, [['bit 1', ones[b]], ['bit 0', zeros[b]]]);
      })
      .on('pointerleave', hideTip);
  };
  if (!fill) {
    onWidth(plot, (W) => draw(W, height));
    return;
  }
  // The flex layout sets this plot's height; redraw whenever its size changes.
  let last = '';
  let raf = 0;
  const run = () => {
    raf = 0;
    const W = Math.floor(plot.clientWidth);
    const Hp = Math.floor(plot.clientHeight);
    const key = `${W}x${Hp}`;
    if (W > 0 && key !== last) {
      last = key;
      draw(W, Hp);
    }
  };
  new ResizeObserver(() => {
    if (!raf) raf = requestAnimationFrame(run);
  }).observe(plot);
  run();
}

const piFormat = (v) => {
  const r = Math.round((v / PI) * 4) / 4;
  if (r === 0) return '0';
  const map = { 1: 'π', '-1': '-π', 0.5: 'π/2', '-0.5': '-π/2', 0.25: 'π/4', '-0.25': '-π/4', 0.75: '3π/4', '-0.75': '-3π/4' };
  return map[r] ?? (v / PI).toFixed(2) + 'π';
};

// ---------- card e ----------

export function renderPhase(body, run) {
  const e = run.embed;
  const bits = e.streams.phase;
  const before = e.phase.before;
  const after = e.phase.after;
  const n = bits.length;
  const errs = new Float64Array(n);
  let within = 0;
  for (let i = 0; i < n; i++) {
    errs[i] = Math.abs(wrap(after[i] - (bits[i] ? PI / 2 : -PI / 2)));
    if (errs[i] < (5 * PI) / 180) within++;
  }
  const sorted = Float64Array.from(errs).sort();
  const median = sorted[n >> 1];
  let wrong = 0;
  for (let i = 0; i < n; i++) if ((Math.sin(after[i]) > 0 ? 1 : 0) !== bits[i]) wrong++;

  body.append(
    h(
      'div',
      { class: 'card-text' },
      h('p', { text: 'Signing turns each marked phase to the top pole for a 1 and the bottom for a 0. Only the sign of sin φ is read.' }),
    ),
  );
  const cols = h('div', { class: 'cols wide-left' });
  let state = reducedMotion() ? 'after' : 'before';
  let t = state === 'after' ? 1 : 0;
  let anim = null;
  let paint = () => {};
  const dialFig = fig('Phase of each marked cell');
  const toggle = segmented([['before', 'Original'], ['after', 'Signed']], state, (v) => go(v, true), 'Phase dial view');
  dialFig.el.querySelector('.fig-title').append(toggle.el);
  const go = (v, animate) => {
    state = v;
    toggle.set(v);
    const t0 = t;
    const t1 = v === 'after' ? 1 : 0;
    anim?.stop();
    if (!animate || reducedMotion()) {
      t = t1;
      paint();
      return;
    }
    anim = timer((el) => {
      const u = Math.min(1, el / 1400);
      t = t0 + (t1 - t0) * easeCubicInOut(u);
      paint();
      if (u >= 1) anim.stop();
    });
  };
  const angleAt = (i, u) => before[i] + wrap(after[i] - before[i]) * u;
  onWidth(dialFig.plot, (W) => {
    dialFig.plot.replaceChildren();
    const S = Math.min(W, 380);
    const canvas = h('canvas', { style: { margin: '0 auto' } });
    const svgEl = h('svg:svg', { class: 'layer', width: S, height: S, style: { left: `${(W - S) / 2}px`, right: 'auto' } });
    dialFig.plot.style.height = `${S}px`;
    dialFig.plot.append(canvas, svgEl);
    const ctx = sizeCanvas(canvas, S, S);
    const cx = S / 2;
    const R = S / 2 - 26;
    const svg = select(svgEl);
    svg.append('circle').attr('cx', cx).attr('cy', cx).attr('r', R).attr('fill', 'none').attr('stroke', C.line2);
    svg.append('circle').attr('cx', cx).attr('cy', cx).attr('r', R * 0.5).attr('fill', 'none').attr('stroke', C.grid);
    for (const [a, lab] of [[PI / 2, '+π/2  bit 1'], [-PI / 2, '-π/2  bit 0'], [0, '0'], [PI, 'π']]) {
      const x = cx + (R + 12) * Math.cos(a);
      const y = cx - (R + 12) * Math.sin(a);
      svg.append('line').attr('x1', cx + R * 0.46 * Math.cos(a)).attr('y1', cx - R * 0.46 * Math.sin(a)).attr('x2', cx + R * Math.cos(a)).attr('y2', cx - R * Math.sin(a))
        .attr('class', 'gridline');
      svg.append('text').attr('class', 'axis-label').attr('x', x).attr('y', y).attr('dy', '0.35em')
        .attr('text-anchor', a === 0 ? 'start' : a === PI ? 'end' : 'middle')
        .attr('fill', a === PI / 2 ? C.bit1 : a === -PI / 2 ? C.bit0 : null).text(lab);
    }
    svg.append('text').attr('class', 'axis-label').attr('x', cx).attr('y', cx).attr('dy', '0.35em').attr('text-anchor', 'middle')
      .text(`${fmtInt(n)} cells`);
    paint = () => {
      ctx.clearRect(0, 0, S, S);
      for (const b of [0, 1]) {
        ctx.fillStyle = b ? C.bit1 : C.bit0;
        ctx.globalAlpha = 0.7;
        for (let i = 0; i < n; i++) {
          if (bits[i] !== b) continue;
          const a = angleAt(i, t);
          const r = R * (0.56 + 0.4 * jitter(i));
          ctx.beginPath();
          ctx.arc(cx + r * Math.cos(a), cx - r * Math.sin(a), 1.6, 0, 2 * PI);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };
    paint();
  });
  dialFig.el.append(h('p', { class: 'fig-cap', text: 'One dot per phase bit: blue for 1, gold for 0.' }));

  const side = h('div', { class: 'side-fill' });
  const nb = 48;
  const ticks = [-PI, -PI / 2, 0, PI / 2, PI];
  const hb = fig('Original phase');
  const ha = fig('Signed phase');
  histPlot(hb.plot, { lo: -PI, hi: PI, nb, ones: histogram(before, -PI, PI, nb, (i) => bits[i] === 1), zeros: histogram(before, -PI, PI, nb, (i) => bits[i] === 0), ticks, tickFormat: piFormat, marks: [-PI / 2, PI / 2], fill: true });
  histPlot(ha.plot, { lo: -PI, hi: PI, nb, ones: histogram(after, -PI, PI, nb, (i) => bits[i] === 1), zeros: histogram(after, -PI, PI, nb, (i) => bits[i] === 0), ticks, tickFormat: piFormat, marks: [-PI / 2, PI / 2], fill: true });
  side.append(hb.el, ha.el);
  cols.append(dialFig.el, side);
  body.append(cols);
  body.append(
    readouts([
      ['Phase bits', fmtInt(n)],
      ['Median error', `${deg(median).toFixed(2)} deg`, 'accent'],
      ['Within 5 deg', fmtPct(within / n)],
      ['Wrong sign', `${wrong} of ${fmtInt(n)}`, wrong ? 'bad' : null],
      ['Target', '+π/2 for 1, -π/2 for 0'],
    ]),
  );
  // Play the rotation once, when the dial comes into view.
  if (state === 'before') whenVisible(dialFig.el, () => setTimeout(() => go('after', true), 400));
}

// ---------- card f ----------

export function renderMagnitude(body, run) {
  const e = run.embed;
  const bits = e.streams.magnitude;
  const { before, after, shift } = e.qim;
  const n = bits.length;
  let absShift = 0;
  let agree = 0;
  for (let i = 0; i < n; i++) {
    absShift += Math.abs(shift[i]);
    if ((-Math.cos(PI * after[i]) > 0 ? 1 : 0) === bits[i]) agree++;
  }
  absShift /= n;
  const sortedB = Float64Array.from(before).sort();
  const q = (p) => sortedB[Math.min(n - 1, Math.max(0, Math.floor(p * n)))];
  const span = Math.max(2, Math.ceil(Math.max(Math.abs(q(0.02)), Math.abs(q(0.98)))) + 0.5);

  body.append(
    h(
      'div',
      { class: 'card-text' },
      h('p', { text: 'Each bit is the level difference d of two bins, moved to the nearest odd integer for a 1 and even for a 0.' }),
    ),
  );
  const cols = h('div', { class: 'cols wide-left' });
  const sc = fig('Before and after quantization');
  let u = reducedMotion() ? 1 : 0;
  let paint = () => {};
  onWidth(sc.plot, (W) => {
    sc.plot.replaceChildren();
    const Hh = Math.round(Math.min(380, Math.max(260, W * 0.62)));
    const m = { l: 38, r: 12, t: 10, b: 34 };
    sc.plot.style.height = `${Hh}px`;
    const canvas = h('canvas');
    const svgEl = h('svg:svg', { class: 'layer', width: W, height: Hh });
    sc.plot.append(svgEl, canvas);
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.pointerEvents = 'none';
    const ctx = sizeCanvas(canvas, W, Hh);
    const x = scaleLinear().domain([-span, span]).range([m.l, W - m.r]);
    const y = scaleLinear().domain([-span, span]).range([Hh - m.b, m.t]);
    const svg = select(svgEl);
    const lim = Math.floor(span);
    for (let c = -lim; c <= lim; c++) {
      svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(c)).attr('y2', y(c))
        .attr('stroke', c & 1 ? C.bit1 : C.bit0).attr('stroke-opacity', 0.28).attr('stroke-width', 1);
    }
    svg.append('line').attr('x1', x(-span)).attr('y1', y(-span)).attr('x2', x(span)).attr('y2', y(span)).attr('stroke', C.muted).attr('stroke-dasharray', '3 4');
    svg.append('text').attr('class', 'axis-label').attr('x', x(span) - 4).attr('y', y(span) + 14).attr('text-anchor', 'end').text('no change');
    const ticks = [];
    for (let c = -lim; c <= lim; c++) ticks.push(c);
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${Hh - m.b})`).call(axisBottom(x).tickValues(ticks).tickSize(3));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(axisLeft(y).tickValues(ticks).tickSize(3));
    svg.append('text').attr('class', 'axis-label').attr('x', W - m.r).attr('y', Hh - 4).attr('text-anchor', 'end').text('d in the original, nats');
    svg.append('text').attr('class', 'axis-label').attr('x', m.l + 4).attr('y', m.t + 10).text('d in the signed file');
    paint = () => {
      ctx.clearRect(0, 0, W, Hh);
      ctx.save();
      ctx.beginPath();
      ctx.rect(m.l, m.t, W - m.l - m.r, Hh - m.t - m.b);
      ctx.clip();
      ctx.globalAlpha = 0.72;
      for (const b of [0, 1]) {
        ctx.fillStyle = b ? C.bit1 : C.bit0;
        for (let i = 0; i < n; i++) {
          if (bits[i] !== b) continue;
          const yy = before[i] + (after[i] - before[i]) * u;
          ctx.beginPath();
          ctx.arc(x(before[i]), y(yy), 1.7, 0, 2 * PI);
          ctx.fill();
        }
      }
      ctx.restore();
    };
    paint();
    svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', W - m.l - m.r).attr('height', Hh - m.t - m.b).attr('fill', 'transparent')
      .on('pointermove', (ev) => {
        const [px, py] = pointer(ev);
        let best = -1;
        let bd = 64;
        for (let i = 0; i < n; i++) {
          const dd = (x(before[i]) - px) ** 2 + (y(after[i]) - py) ** 2;
          if (dd < bd) {
            bd = dd;
            best = i;
          }
        }
        if (best < 0) return hideTip();
        const i = best;
        showTip(ev, `Magnitude bit ${i}`, [
          ['bit', bits[i]],
          ['d original', before[i].toFixed(3)],
          ['lattice point', `${e.qim.cell[i]} (${e.qim.cell[i] & 1 ? 'odd' : 'even'})`],
          ['d signed', after[i].toFixed(3)],
          ['shift', `${shift[i].toFixed(3)} nat`],
        ]);
      })
      .on('pointerleave', hideTip);
  });
  if (u === 0) {
    whenVisible(sc.el, () => {
      const tm = timer((el) => {
        const v = Math.min(1, Math.max(0, (el - 300) / 1300));
        u = easeCubicInOut(v);
        paint();
        if (v >= 1) tm.stop();
      });
    });
  }
  sc.el.append(h('p', { class: 'fig-cap', text: 'One dot per bit; each lands on a line of its color (blue odd, gold even).' }));

  const side = h('div', { class: 'side-fill' });
  const hs = fig('Shift applied to d');
  const nb = 40;
  histPlot(hs.plot, {
    lo: -1, hi: 1, nb,
    ones: histogram(shift, -1, 1, nb, (i) => bits[i] === 1),
    zeros: histogram(shift, -1, 1, nb, (i) => bits[i] === 0),
    ticks: [-1, -0.5, 0, 0.5, 1],
    tickFormat: (v) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(1)),
    fill: true,
  });
  hs.el.append(h('p', { class: 'fig-cap', text: 'At most one step; each bin moves half, in opposite directions.' }));
  side.append(hs.el);
  side.append(
    readouts([
      ['Magnitude bits', fmtInt(n)],
      ['Step', '1 nat'],
      ['Mean |shift|', `${absShift.toFixed(3)} nat`, 'accent'],
      ['Per-bin level', `${(4.343 * absShift).toFixed(2)} dB mean`],
      ['Parity kept', fmtPct(agree / n), agree === n ? 'ok' : null],
    ]),
  );
  cols.append(sc.el, side);
  body.append(cols);
}
