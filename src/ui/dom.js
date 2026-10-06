/**
 * Small DOM helpers: element builder, tooltip, resize observation, copy and download.
 * @module ui/dom
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Build an element (`svg:circle` for SVG). `text` sets textContent; there is no innerHTML
 * path. `on*` functions become listeners, `dataset` and `style` objects are merged, other
 * keys are attributes (false and null are skipped).
 */
export function h(tag, attrs = {}, ...children) {
  const svg = tag.startsWith('svg:');
  const el = svg ? document.createElementNS(SVG_NS, tag.slice(4)) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

/** Section of a card: a figure with a title row, the plot container and a caption. */
export function fig(title, { caption, extra, cls } = {}) {
  const plot = h('div', { class: 'plot' });
  const el = h(
    'figure',
    { class: `fig${cls ? ` ${cls}` : ''}` },
    h('figcaption', { class: 'fig-title' }, h('span', { text: title }), extra),
    plot,
    caption ? h('p', { class: 'fig-cap', text: caption }) : null,
  );
  return { el, plot };
}

/** A definition list of readouts: [[label, value, cls?], ...]. */
export function readouts(items) {
  return h(
    'dl',
    { class: 'readouts' },
    items.filter(Boolean).map(([dt, dd, cls]) => h('div', {}, h('dt', { text: dt }), h('dd', { class: cls, title: typeof dd === 'string' ? dd : null }, dd))),
  );
}

/** Segmented control. Calls `onPick(value)`; returns the element and a setter. */
export function segmented(options, value, onPick, label) {
  const el = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const buttons = options.map(([v, text]) =>
    h('button', { type: 'button', 'aria-pressed': String(v === value), dataset: { v }, text, onclick: () => set(v, true) }),
  );
  el.append(...buttons);
  function set(v, fire) {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.v === String(v)));
    if (fire) onPick(v);
  }
  return { el, set };
}

// ---------- tooltip ----------

let tipEl = null;

function tipNode() {
  tipEl ??= document.getElementById('tip');
  return tipEl;
}

/** Show the shared tooltip near the pointer. `rows` is [[key, value], ...] or a string. */
export function showTip(ev, title, rows = []) {
  const el = tipNode();
  el.replaceChildren();
  if (title) el.append(h('b', { text: title }));
  for (const [k, v] of rows) el.append(h('div', {}, h('span', { class: 'k', text: `${k} ` }), String(v)));
  el.hidden = false;
  const pad = 14;
  const r = el.getBoundingClientRect();
  let x = ev.clientX + pad;
  let y = ev.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = ev.clientX - pad - r.width;
  if (y + r.height > window.innerHeight - 8) y = ev.clientY - pad - r.height;
  el.style.left = `${Math.max(8, x)}px`;
  el.style.top = `${Math.max(8, y)}px`;
}

export function hideTip() {
  const el = tipNode();
  if (el) el.hidden = true;
}

// ---------- layout ----------

/**
 * Call `draw(width)` now and whenever the element's content width changes (debounced to
 * one frame). Returns a disposer.
 */
export function onWidth(el, draw) {
  let last = -1;
  let raf = 0;
  const run = () => {
    raf = 0;
    const w = Math.floor(el.clientWidth);
    if (w > 0 && w !== last) {
      last = w;
      draw(w);
    }
  };
  const ro = new ResizeObserver(() => {
    if (!raf) raf = requestAnimationFrame(run);
  });
  ro.observe(el);
  run();
  return () => ro.disconnect();
}

/** Size a canvas for the device pixel ratio and return its 2D context in CSS pixels. */
export function sizeCanvas(canvas, w, hgt) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(hgt * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${hgt}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Call `fn` once, the first time `el` is at least `share` visible. */
export function whenVisible(el, fn, share = 0.35) {
  if (!('IntersectionObserver' in window)) return fn();
  const io = new IntersectionObserver((entries) => {
    if (entries.some((en) => en.isIntersecting)) {
      io.disconnect();
      fn();
    }
  }, { threshold: share });
  io.observe(el);
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- clipboard and files ----------

/** Copy text; falls back to a hidden textarea where the async clipboard needs https. */
export async function copyText(text) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the legacy path
    }
  }
  const ta = h('textarea', { readonly: true, style: { position: 'fixed', top: '-1000px', opacity: '0' } });
  ta.value = text;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

/** Copy button that confirms in place. */
export function copyButton(getText, label = 'Copy') {
  const b = h('button', { type: 'button', class: 'btn', text: label });
  b.addEventListener('click', async () => {
    const ok = await copyText(getText());
    b.textContent = ok ? 'Copied' : 'Select and copy';
    setTimeout(() => (b.textContent = label), 1400);
  });
  return b;
}

export function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Mono PCM16 WAV bytes of samples already on the 16-bit grid (the worker quantizes). */
export function wavBytes(samples, sampleRate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + 2 * n);
  const v = new DataView(buf);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + 2 * n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, 2 * sampleRate, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, 2 * n, true);
  for (let i = 0; i < n; i++) {
    const q = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768)));
    v.setInt16(44 + 2 * i, q, true);
  }
  return new Uint8Array(buf);
}
