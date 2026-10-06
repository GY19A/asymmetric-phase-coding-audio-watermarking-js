/**
 * MT19937 and numpy legacy `RandomState.shuffle`, bit-exact.
 *
 * The layout of apcaw-v1 (format §2) is defined by numpy's legacy
 * `RandomState(seed).shuffle`. That call is:
 *
 *   init_genrand(seed)                       Matsumoto and Nishimura, 2002
 *   for i = n-1 down to 1:
 *     j = interval(i)                        masked rejection sampling
 *     swap a[i], a[j]
 *
 * where interval(m) draws 32-bit outputs, masks them with the smallest
 * 2^b - 1 >= m, and rejects values greater than m. Conformance vectors in
 * `vectors/mt19937.json` and `layout.json` pin this behavior.
 * @module mt19937
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class MT19937 {
  /** @param {number} seed integer in [0, 2^32) */
  constructor(seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new RangeError('MT19937 seed must be an integer in [0, 2^32)');
    }
    this.mt = new Uint32Array(N);
    this.index = N;
    const mt = this.mt;
    mt[0] = seed >>> 0;
    for (let i = 1; i < N; i++) {
      const s = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = (Math.imul(1812433253, s) + i) >>> 0;
    }
  }

  /** Regenerate the 624-word state block. */
  twist() {
    const mt = this.mt;
    let kk = 0;
    let y;
    for (; kk < N - M; kk++) {
      y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
      mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
    }
    for (; kk < N - 1; kk++) {
      y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
      mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
    }
    y = (mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK);
    mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
    this.index = 0;
  }

  /** @returns {number} next tempered 32-bit output as an unsigned integer */
  nextUint32() {
    if (this.index >= N) this.twist();
    let y = this.mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /**
   * numpy `random_interval(max)` for max < 2^32: uniform integer in [0, max].
   * @param {number} max
   * @returns {number}
   */
  interval(max) {
    if (max === 0) return 0;
    let mask = max;
    mask |= mask >>> 1;
    mask |= mask >>> 2;
    mask |= mask >>> 4;
    mask |= mask >>> 8;
    mask |= mask >>> 16;
    mask >>>= 0;
    let value;
    do {
      value = (this.nextUint32() & mask) >>> 0;
    } while (value > max);
    return value;
  }

  /**
   * In-place numpy legacy Fisher-Yates shuffle of a 1-D array.
   * @template {Int32Array|Uint32Array|number[]} T
   * @param {T} a
   * @returns {T} the same array
   */
  shuffle(a) {
    for (let i = a.length - 1; i >= 1; i--) {
      const j = this.interval(i);
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }
}

/**
 * `RandomState(seed).shuffle(arange(lo, hi))` as an Int32Array.
 * @param {number} lo
 * @param {number} hi exclusive
 * @param {number} seed
 * @returns {Int32Array}
 */
export function shuffledRange(lo, hi, seed) {
  const a = new Int32Array(hi - lo);
  for (let i = 0; i < a.length; i++) a[i] = lo + i;
  return new MT19937(seed).shuffle(a);
}

/**
 * First `count` raw outputs of `RandomState(seed)` (conformance vector `mt19937.json`).
 * @param {number} seed
 * @param {number} count
 * @returns {number[]}
 */
export function rawOutputs(seed, count) {
  const mt = new MT19937(seed);
  const out = [];
  for (let i = 0; i < count; i++) out.push(mt.nextUint32());
  return out;
}
