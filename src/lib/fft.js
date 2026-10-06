/**
 * Real FFT of a power-of-two length (2048 here), in float64.
 *
 * Conventions follow numpy: `forward` is `np.fft.rfft` (no scaling) and
 * `inverse` is `np.fft.irfft` (1/N scaling, imaginary parts of the DC and
 * Nyquist bins ignored). The real transform packs even and odd samples into
 * one complex FFT of length N/2 (iterative radix-2, twiddles computed
 * directly with Math.cos / Math.sin, never by recurrence), which keeps the
 * error at a few ulp and well inside the 1e-9 conformance tolerance.
 * @module fft
 */

export class RealFFT {
  /** @param {number} n transform length, a power of two >= 4 */
  constructor(n) {
    if (n < 4 || (n & (n - 1)) !== 0) throw new RangeError('FFT length must be a power of two >= 4');
    this.n = n;
    const m = n >> 1;
    this.m = m;
    // Bit reversal for the half-length complex FFT.
    const bits = Math.log2(m);
    this.rev = new Uint32Array(m);
    for (let i = 0; i < m; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    // Complex twiddles e^{-2 pi i k / m}, k < m/2.
    this.cw = new Float64Array(m / 2);
    this.sw = new Float64Array(m / 2);
    for (let k = 0; k < m / 2; k++) {
      const a = (-2 * Math.PI * k) / m;
      this.cw[k] = Math.cos(a);
      this.sw[k] = Math.sin(a);
    }
    // Real-split twiddles e^{-2 pi i k / n}, k <= m.
    this.cr = new Float64Array(m + 1);
    this.sr = new Float64Array(m + 1);
    for (let k = 0; k <= m; k++) {
      const a = (-2 * Math.PI * k) / n;
      this.cr[k] = Math.cos(a);
      this.sr[k] = Math.sin(a);
    }
    this.zr = new Float64Array(m);
    this.zi = new Float64Array(m);
  }

  /** In-place complex FFT of (zr, zi); sign -1 forward, +1 inverse (unscaled). */
  _cfft(zr, zi, sign) {
    const m = this.m;
    const rev = this.rev;
    for (let i = 0; i < m; i++) {
      const j = rev[i];
      if (j > i) {
        let t = zr[i]; zr[i] = zr[j]; zr[j] = t;
        t = zi[i]; zi[i] = zi[j]; zi[j] = t;
      }
    }
    const cw = this.cw;
    const sw = this.sw;
    const conj = sign > 0;
    for (let size = 2; size <= m; size <<= 1) {
      const half = size >> 1;
      const step = m / size;
      for (let start = 0; start < m; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cw[k * step];
          const wi = conj ? -sw[k * step] : sw[k * step];
          const a = start + k;
          const b = a + half;
          const xr = zr[b] * wr - zi[b] * wi;
          const xi = zr[b] * wi + zi[b] * wr;
          zr[b] = zr[a] - xr;
          zi[b] = zi[a] - xi;
          zr[a] += xr;
          zi[a] += xi;
        }
      }
    }
  }

  /**
   * rfft of `x[offset .. offset+n)`.
   * @param {Float64Array} x
   * @param {Float64Array} re output, length n/2+1
   * @param {Float64Array} im output, length n/2+1
   * @param {number} [offset]
   */
  forward(x, re, im, offset = 0) {
    const m = this.m;
    const zr = this.zr;
    const zi = this.zi;
    for (let i = 0; i < m; i++) {
      zr[i] = x[offset + 2 * i];
      zi[i] = x[offset + 2 * i + 1];
    }
    this._cfft(zr, zi, -1);
    const cr = this.cr;
    const sr = this.sr;
    for (let k = 0; k <= m; k++) {
      const k1 = k === m ? 0 : k;
      const k2 = k === 0 ? 0 : m - k;
      // E = (Z[k] + conj Z[m-k]) / 2 ; O = (Z[k] - conj Z[m-k]) / (2i)
      const er = 0.5 * (zr[k1] + zr[k2]);
      const ei = 0.5 * (zi[k1] - zi[k2]);
      const or = 0.5 * (zi[k1] + zi[k2]);
      const oi = -0.5 * (zr[k1] - zr[k2]);
      re[k] = er + (cr[k] * or - sr[k] * oi);
      im[k] = ei + (cr[k] * oi + sr[k] * or);
    }
  }

  /**
   * irfft into `out[offset .. offset+n)`.
   * @param {Float64Array} re length n/2+1
   * @param {Float64Array} im length n/2+1
   * @param {Float64Array} out
   * @param {number} [offset]
   */
  inverse(re, im, out, offset = 0) {
    const m = this.m;
    const zr = this.zr;
    const zi = this.zi;
    const cr = this.cr;
    const sr = this.sr;
    for (let k = 0; k < m; k++) {
      const ar = re[k];
      const ai = k === 0 ? 0 : im[k];
      const br = re[m - k];
      const bi = k === 0 ? 0 : im[m - k]; // imaginary part of the Nyquist bin is ignored
      // E = (X[k] + conj X[m-k]) / 2 ; O = (X[k] - conj X[m-k]) * e^{+2 pi i k/n} / 2
      const er = 0.5 * (ar + br);
      const ei = 0.5 * (ai - bi);
      const dr = 0.5 * (ar - br);
      const di = 0.5 * (ai + bi);
      const or = dr * cr[k] + di * sr[k];
      const oi = di * cr[k] - dr * sr[k];
      // Z = E + i O
      zr[k] = er - oi;
      zi[k] = ei + or;
    }
    this._cfft(zr, zi, +1);
    const s = 1 / m;
    for (let i = 0; i < m; i++) {
      out[offset + 2 * i] = zr[i] * s;
      out[offset + 2 * i + 1] = zi[i] * s;
    }
  }
}

const cache = new Map();
/** Shared transform instance for length n. */
export function getFFT(n = 2048) {
  let f = cache.get(n);
  if (!f) {
    f = new RealFFT(n);
    cache.set(n, f);
  }
  return f;
}
