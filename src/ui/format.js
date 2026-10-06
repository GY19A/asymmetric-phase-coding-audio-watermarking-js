/**
 * Format constants and number formatting for the page. The constants repeat the library's
 * (tests/ui.test.js checks they agree) so the main thread does not load the library.
 * @module ui/format
 */

export const SAMPLE_RATE = 44100;
export const N_FFT = 2048;
export const N_BINS = N_FFT / 2 + 1;
export const GROUP = 8;
export const HEADER_BITS = 96;
export const MAX_MSG_LEN = 159;
export const SIG_LEN = 64;
export const NSYM = 30;

/** Center frequency of STFT bin k in Hz. */
export const binHz = (k) => (k * SAMPLE_RATE) / N_FFT;
/** Bin k as kHz with two decimals. */
export const binKHz = (k) => (binHz(k) / 1000).toFixed(2);

export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtDb(v, digits = 1) {
  if (v === Infinity) return 'no change';
  if (!Number.isFinite(v)) return 'n/a';
  return `${v.toFixed(digits)} dB`;
}

export function fmtInt(n) {
  return Number(n).toLocaleString('en-US');
}

export function fmtPct(x, digits = 1) {
  if (!Number.isFinite(x)) return 'n/a';
  return `${(100 * x).toFixed(digits)}%`;
}

export function hex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function byteHex(b) {
  return `0x${b.toString(16).padStart(2, '0')}`;
}

export function byteBits(b) {
  return b.toString(2).padStart(8, '0');
}

/** Printable ASCII for a byte, or a middle dot. */
export function byteChar(b) {
  return b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·';
}

export function utf8Length(s) {
  return new TextEncoder().encode(s).length;
}

export function fmtSeconds(s) {
  const m = Math.floor(s / 60);
  const r = s - 60 * m;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}
