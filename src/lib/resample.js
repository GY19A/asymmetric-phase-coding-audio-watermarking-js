/**
 * Band-limited resampling to 44.1 kHz for inputs at other rates (browser drops, WAVs at 48 kHz).
 *
 * Windowed-sinc interpolation (Kaiser window, beta 8.6, 32 zero crossings per side, kernel
 * table with 1024 phases per crossing, linear interpolation between phases). When
 * downsampling, the cutoff moves to 0.95 x the output Nyquist frequency.
 *
 * The watermark format is defined at 44.1 kHz only. The paper's numbers were measured on
 * 44.1 kHz material and do not depend on this resampler; it only exists so the demo and
 * the tools can accept other rates. Resampling a signed file destroys the phase grid the
 * verifier expects, so sign after resampling, never before.
 * @module resample
 */

const ZEROS = 32;
const PHASES = 1024;
const BETA = 8.6;

function besselI0(x) {
  let sum = 1;
  let term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 64; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

let table = null;
function kernelTable() {
  if (table) return table;
  const len = ZEROS * PHASES + 2;
  table = new Float64Array(len);
  const i0b = besselI0(BETA);
  for (let i = 0; i < len; i++) {
    const t = i / PHASES; // in zero crossings
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const r = t / ZEROS;
    const w = r >= 1 ? 0 : besselI0(BETA * Math.sqrt(1 - r * r)) / i0b;
    table[i] = sinc * w;
  }
  return table;
}

/**
 * @param {ArrayLike<number>} x input samples
 * @param {number} fromRate input rate in Hz
 * @param {number} [toRate] output rate in Hz (default 44100)
 * @returns {Float64Array}
 */
export function resample(x, fromRate, toRate = 44100) {
  if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('sample rates must be positive');
  if (fromRate === toRate) return Float64Array.from(x);
  const tab = kernelTable();
  const ratio = toRate / fromRate;
  const cutoff = ratio < 1 ? 0.95 * ratio : 1; // relative to the input Nyquist
  const nOut = Math.floor((x.length * toRate) / fromRate);
  const out = new Float64Array(nOut);
  const half = ZEROS / cutoff; // kernel half-width in input samples
  const n = x.length;
  for (let i = 0; i < nOut; i++) {
    const t = (i * fromRate) / toRate; // position in input samples
    const j0 = Math.max(0, Math.ceil(t - half));
    const j1 = Math.min(n - 1, Math.floor(t + half));
    let acc = 0;
    for (let j = j0; j <= j1; j++) {
      const u = Math.abs(t - j) * cutoff * PHASES;
      const k = u | 0;
      if (k >= ZEROS * PHASES) continue;
      const f = u - k;
      acc += x[j] * (tab[k] + f * (tab[k + 1] - tab[k]));
    }
    out[i] = acc * cutoff;
  }
  return out;
}
