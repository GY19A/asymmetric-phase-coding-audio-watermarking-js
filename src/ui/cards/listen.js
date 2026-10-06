/**
 * Card g: waveforms and an A/B player for the original, the signed file and the attacked
 * file, plus WAV downloads of all three.
 * @module ui/cards/listen
 */

import { select, pointer, scaleLinear, axisBottom } from 'd3';
import { h, fig, readouts, onWidth, sizeCanvas, segmented, download, wavBytes, showTip, hideTip } from '../dom.js';
import { C } from '../colors.js';
import { SAMPLE_RATE, fmtDb, fmtSeconds } from '../format.js';

let ctxAudio = null;
let active = null;

/** Stop any playback left over from an earlier run. */
export function stopAudio() {
  active?.stop();
  active = null;
}

function peakAbs(x) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  return m;
}

/** Min/max envelope of x over `cols` columns of `per` samples. */
function envelope(x, cols, per) {
  const lo = new Float32Array(cols);
  const hi = new Float32Array(cols);
  for (let c = 0; c < cols; c++) {
    const a = Math.floor(c * per);
    const b = Math.min(x.length, Math.floor((c + 1) * per));
    let mn = 0;
    let mx = 0;
    for (let i = a; i < b; i++) {
      if (x[i] < mn) mn = x[i];
      if (x[i] > mx) mx = x[i];
    }
    lo[c] = mn;
    hi[c] = mx;
  }
  return { lo, hi };
}

export function renderListen(body, run) {
  stopAudio();
  const x = run.load.audio;
  const y = run.embed.audio;
  const z = run.attack.audio;
  const res = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) res[i] = y[i] - x[i];
  const scale = Math.max(peakAbs(x), peakAbs(y), peakAbs(z)) || 1;
  const resPeak = peakAbs(res) || 1e-9;
  const gain = Math.max(1, 2 ** Math.floor(Math.log2((0.8 * scale) / resPeak)));
  const tracks = [
    { id: 'original', name: 'Original', samples: x, color: C.soft },
    { id: 'signed', name: 'Signed', samples: y, color: C.blue },
    { id: 'attacked', name: 'Attacked', samples: z, color: C.bad },
  ];
  const lanes = [
    { name: 'Original', samples: x, color: C.soft, g: 1 },
    { name: 'Signed', samples: y, color: C.blue, g: 1 },
    { name: `Watermark, signed minus original, x${gain}`, samples: res, color: C.darkestGold, g: gain },
    { name: 'Attacked', samples: z, color: C.bad, g: 1 },
  ];
  const seconds = Math.max(x.length, y.length, z.length) / SAMPLE_RATE;
  const steps = run.attack.steps.filter((s) => !s.skipped);

  body.append(
    h(
      'div',
      { class: 'card-text' },
      h('p', { text: `The watermark sits ${fmtDb(run.embed.snr)} below the speech. Switch versions while playing.` }),
    ),
  );

  // Player state.
  let which = 'signed';
  let playing = false;
  let src = null;
  let startedAt = 0;
  let offset = 0;
  const buffers = {};
  const playBtn = h('button', { type: 'button', class: 'play', 'aria-label': 'Play' });
  const icon = (p) => {
    playBtn.replaceChildren(
      p
        ? h('svg:svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' }, h('svg:rect', { x: 4, y: 3, width: 3, height: 10, fill: 'currentColor' }), h('svg:rect', { x: 9, y: 3, width: 3, height: 10, fill: 'currentColor' }))
        : h('svg:svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' }, h('svg:path', { d: 'M4.5 2.8v10.4L13 8z', fill: 'currentColor' })),
    );
    playBtn.setAttribute('aria-label', p ? 'Pause' : 'Play');
  };
  icon(false);
  const time = h('span', { class: 'ptime', text: `0:00.0 / ${fmtSeconds(seconds)}` });
  const lenOf = (id) => tracks.find((t) => t.id === id).samples.length / SAMPLE_RATE;
  const pos = () => (playing ? offset + (ctxAudio.currentTime - startedAt) : offset);
  const bufferOf = (id) => {
    if (!buffers[id]) {
      const t = tracks.find((tr) => tr.id === id);
      const b = ctxAudio.createBuffer(1, t.samples.length, SAMPLE_RATE);
      b.copyToChannel(t.samples, 0);
      buffers[id] = b;
    }
    return buffers[id];
  };
  const halt = () => {
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // already stopped
      }
      src.disconnect();
      src = null;
    }
  };
  const start = (at) => {
    halt();
    const len = lenOf(which);
    if (at >= len) at = 0;
    src = ctxAudio.createBufferSource();
    src.buffer = bufferOf(which);
    src.connect(ctxAudio.destination);
    src.onended = () => {
      if (!playing) return;
      playing = false;
      offset = 0;
      icon(false);
    };
    src.start(0, at);
    startedAt = ctxAudio.currentTime;
    offset = at;
    playing = true;
    icon(true);
    tick();
  };
  const pause = () => {
    offset = pos();
    playing = false;
    halt();
    icon(false);
  };
  active = { stop: () => { playing = false; halt(); } };
  playBtn.addEventListener('click', async () => {
    ctxAudio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (ctxAudio.state === 'suspended') await ctxAudio.resume();
    if (playing) pause();
    else start(offset);
  });
  const pick = segmented(tracks.map((t) => [t.id, t.name]), which, (v) => {
    which = v;
    if (playing) start(pos());
    drawHead();
  }, 'Version to play');

  // Waveform lanes with a shared playhead.
  const wf = fig('Waveforms');
  let drawHead = () => {};
  let raf = 0;
  const tick = () => {
    cancelAnimationFrame(raf);
    const step = () => {
      drawHead();
      if (playing) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  };
  onWidth(wf.plot, (W) => {
    wf.plot.replaceChildren();
    const laneH = 58;
    const gap = 22;
    const m = { t: 16, b: 24 };
    const Hh = m.t + lanes.length * (laneH + gap) - gap + m.b;
    wf.plot.style.height = `${Hh}px`;
    const canvas = h('canvas');
    const svgEl = h('svg:svg', { class: 'layer', width: W, height: Hh });
    wf.plot.append(canvas, svgEl);
    const ctx = sizeCanvas(canvas, W, Hh);
    const xs = scaleLinear().domain([0, seconds]).range([0, W]);
    lanes.forEach((ln, li) => {
      const y0 = m.t + li * (laneH + gap);
      const mid = y0 + laneH / 2;
      const cols = Math.max(1, Math.round(xs(ln.samples.length / SAMPLE_RATE)));
      const env = envelope(ln.samples, cols, ln.samples.length / cols);
      const k = ((laneH / 2 - 2) * ln.g) / scale;
      ctx.fillStyle = ln.color;
      ctx.globalAlpha = 0.85;
      for (let c = 0; c < cols; c++) {
        const a = Math.max(-laneH / 2, env.lo[c] * k);
        const b = Math.min(laneH / 2, env.hi[c] * k);
        ctx.fillRect(c, mid - b, 1, Math.max(0.6, b - a));
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = C.grid;
      ctx.fillRect(0, mid, W, 0.5);
    });
    const svg = select(svgEl);
    lanes.forEach((ln, li) => {
      svg.append('text').attr('class', 'axis-label').attr('x', 0).attr('y', m.t + li * (laneH + gap) - 5).text(ln.name);
    });
    const step = seconds > 20 ? 5 : seconds > 8 ? 2 : 1;
    const ticks = [];
    for (let s = 0; s <= seconds + 1e-9; s += step) ticks.push(s);
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${Hh - m.b + 4})`)
      .call(axisBottom(xs).tickValues(ticks).tickFormat((s) => `${s} s`).tickSize(3));
    const head = svg.append('line').attr('y1', m.t - 4).attr('y2', Hh - m.b).attr('stroke', C.text).attr('stroke-width', 1.2).attr('opacity', 0);
    drawHead = () => {
      const p = Math.min(pos(), lenOf(which));
      time.textContent = `${fmtSeconds(p)} / ${fmtSeconds(lenOf(which))}`;
      head.attr('x1', xs(p)).attr('x2', xs(p)).attr('opacity', p > 0 || playing ? 0.9 : 0);
    };
    drawHead();
    svg.append('rect').attr('width', W).attr('height', Hh).attr('fill', 'transparent').style('cursor', 'pointer')
      .on('click', (ev) => {
        const s = Math.max(0, Math.min(lenOf(which), xs.invert(pointer(ev)[0])));
        if (playing) start(s);
        else {
          offset = s;
          drawHead();
        }
      })
      .on('pointermove', (ev) => showTip(ev, fmtSeconds(Math.max(0, xs.invert(pointer(ev)[0]))), [['click', 'seek here']]))
      .on('pointerleave', hideTip);
  });

  body.append(h('div', { class: 'player' }, playBtn, pick.el, time));
  body.append(wf.el);
  body.append(
    h(
      'div',
      { class: 'downloads' },
      tracks.map((t) =>
        h('button', {
          type: 'button',
          class: t.id === 'original' ? 'btn' : 'btn ok',
          text: `Download ${t.name.toLowerCase()} WAV`,
          onclick: () => download(`apcaw-${t.id}.wav`, wavBytes(t.samples, SAMPLE_RATE), 'audio/wav'),
        }),
      ),
    ),
  );
  body.append(
    readouts([
      ['Length', `${fmtSeconds(x.length / SAMPLE_RATE)} at 44.1 kHz`],
      ['Signal to watermark', fmtDb(run.embed.snr), 'accent'],
      ['Signed to attacked', fmtDb(run.attack.snr)],
      ['Attacked length', fmtSeconds(z.length / SAMPLE_RATE)],
      ['Format', 'mono, 16-bit PCM'],
    ]),
  );
}
