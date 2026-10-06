/**
 * Hero background: a field of short phase vectors, one per time-frequency cell. Each vector
 * turns slowly in its own random direction. Brightness breathes in ripples that spread from a
 * few slowly drifting sources; the brightest crests get gold tips.
 * The motion is slow and low-contrast, so it also runs under reduced motion. About 30 frames
 * per second, paused when off screen or hidden.
 * @module ui/hero
 */

import { C, signal } from './colors.js';
import { sizeCanvas } from './dom.js';

const CELL = 28;
const LEN = 10;
const FPS = 30;
const TAU = 2 * Math.PI;
/** Alpha buckets, so each column draws in a few batched paths. */
const LEVELS = 8;
/** Ripple wavelength (px) and angular speed (rad/s): rings move outward at about 25 px/s. */
const WAVE = 190;
const OMEGA = 0.85;
const SOURCES = [
  { x: 0.62, y: 0.32, ax: 0.22, ay: 0.2, fx: 0.031, fy: 0.023, p: 0 },
  { x: 0.85, y: 0.7, ax: 0.12, ay: 0.22, fx: 0.019, fy: 0.037, p: 2.1 },
  { x: 0.4, y: 0.75, ax: 0.18, ay: 0.15, fx: 0.027, fy: 0.017, p: 4.2 },
];

/** Seeded PRNG (mulberry32), so the field is the same on every load. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function startHero(canvas) {
  if (!canvas) return;
  const host = canvas.parentElement;
  let W = 0;
  let H = 0;
  let ctx = null;
  let cols = 0;
  let rows = 0;
  let colors = [];
  let phase0 = new Float32Array(0);
  let rate = new Float32Array(0);
  let breath = new Float32Array(0);
  let breathPhase = new Float32Array(0);
  let raf = 0;
  let last = 0;
  let visible = true;

  const resize = () => {
    W = host.clientWidth;
    H = host.clientHeight;
    if (!W || !H) return;
    ctx = sizeCanvas(canvas, W, H);
    cols = Math.ceil(W / CELL) + 1;
    rows = Math.ceil(H / CELL) + 1;
    colors = Array.from({ length: cols }, (_, c) => signal(Math.min(1, (c * CELL) / W)));
    const rand = rng(0x41504321);
    const n = cols * rows;
    phase0 = new Float32Array(n);
    rate = new Float32Array(n);
    breath = new Float32Array(n);
    breathPhase = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      phase0[i] = rand() * TAU;
      rate[i] = (rand() < 0.5 ? -1 : 1) * (0.06 + 0.26 * rand());
      breath[i] = 0.3 + 0.5 * rand();
      breathPhase[i] = rand() * TAU;
    }
    draw(last / 1000);
  };

  function draw(t) {
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = 'round';
    ctx.lineWidth = 1.25;
    const x0 = (W - (cols - 1) * CELL) / 2;
    const y0 = (H - (rows - 1) * CELL) / 2;
    const k = TAU / WAVE;
    const src = SOURCES.map((s) => ({
      x: W * (s.x + s.ax * Math.sin(s.fx * t + s.p)),
      y: H * (s.y + s.ay * Math.cos(s.fy * t + s.p)),
      p: s.p,
    }));
    for (let c = 0; c < cols; c++) {
      const x = x0 + c * CELL;
      const segs = Array.from({ length: LEVELS }, () => new Path2D());
      const tips = Array.from({ length: LEVELS }, () => new Path2D());
      const crest = new Path2D();
      let onCrest = false;
      for (let r = 0; r < rows; r++) {
        const i = c * rows + r;
        const y = y0 + r * CELL;
        // Sum of damped rings from each source, mapped to [0, 1] and sharpened at the crests.
        let wave = 0;
        let norm = 0;
        for (const s of src) {
          const d = Math.hypot(x - s.x, y - s.y);
          const env = 1 / (1 + d / 420);
          wave += env * Math.cos(k * d - OMEGA * t + s.p);
          norm += env;
        }
        let b = 0.5 + 0.5 * (wave / norm);
        b = b * b * (3 - 2 * b);
        b = Math.min(1, Math.max(0, b + 0.1 * Math.sin(breath[i] * t + breathPhase[i])));
        const a = phase0[i] + rate[i] * t;
        const half = (LEN / 2) * (0.75 + 0.5 * b);
        const dx = Math.cos(a) * half;
        const dy = Math.sin(a) * half;
        const L = Math.min(LEVELS - 1, Math.floor(b * LEVELS));
        segs[L].moveTo(x - dx, y + dy);
        segs[L].lineTo(x + dx, y - dy);
        const gold = b > 0.86;
        onCrest ||= gold;
        const tip = gold ? crest : tips[L];
        tip.moveTo(x + dx + 1.5, y - dy);
        tip.arc(x + dx, y - dy, 1.5, 0, TAU);
      }
      ctx.strokeStyle = colors[c];
      ctx.fillStyle = colors[c];
      for (let L = 0; L < LEVELS; L++) {
        ctx.globalAlpha = 0.08 + 0.87 * ((L + 0.5) / LEVELS) ** 1.6;
        ctx.lineWidth = L >= LEVELS - 2 ? 1.6 : 1.25;
        ctx.stroke(segs[L]);
        ctx.fill(tips[L]);
      }
      if (onCrest) {
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = C.darkestGold;
        ctx.fill(crest);
      }
    }
    ctx.globalAlpha = 1;
  }

  const frame = (now) => {
    raf = 0;
    if (!visible || document.hidden) return;
    if (now - last >= 1000 / FPS - 1) {
      last = now;
      draw(now / 1000);
    }
    raf = requestAnimationFrame(frame);
  };
  const wake = () => {
    if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame);
  };

  new ResizeObserver(resize).observe(host);
  resize();
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      visible = entries.some((e) => e.isIntersecting);
      wake();
    }).observe(host);
  }
  document.addEventListener('visibilitychange', wake);
  wake();
}
