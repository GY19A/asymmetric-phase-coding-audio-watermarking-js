/**
 * Reed-Solomon RS(nsym=30) over GF(2^8), a line-by-line port of Python
 * `reedsolo` 1.7.0 (`RSCodec(30)`, prim 0x11d, generator 2, fcr 0).
 *
 * Why a literal port and not a textbook decoder: the verifier counts how many
 * candidate codewords pass RS (`rs_passes`), and that count is part of the
 * published negative-control statistics. A different but "equivalent" decoder
 * can disagree on codewords with more than 15 errors (it may miscorrect where
 * reedsolo gives up, or the reverse), so we reproduce reedsolo's
 * Berlekamp-Massey variant, its Chien search, its Forney step and its final
 * syndrome check exactly, including Python's negative-index and modulo rules.
 * @module rs
 */

export const NSYM = 30;
const NSIZE = 255;
const PRIM = 0x11d;
const FIELD = 255;

export class ReedSolomonError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'ReedSolomonError';
  }
}

const EXP = new Uint8Array(FIELD * 2);
const LOG = new Uint8Array(FIELD + 1);
{
  let x = 1;
  for (let i = 0; i < FIELD; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIM;
  }
  for (let i = FIELD; i < FIELD * 2; i++) EXP[i] = EXP[i - FIELD];
}

/** Python's `a % n` for n > 0 (result has the sign of n). */
const pmod = (a, n) => ((a % n) + n) % n;

function gfMul(x, y) {
  if (x === 0 || y === 0) return 0;
  return EXP[(LOG[x] + LOG[y]) % FIELD];
}
function gfDiv(x, y) {
  if (y === 0) throw new RangeError('ZeroDivisionError');
  if (x === 0) return 0;
  return EXP[(LOG[x] + FIELD - LOG[y]) % FIELD];
}
function gfInverse(x) {
  return EXP[FIELD - LOG[x]];
}
function gfPow(x, power) {
  return EXP[pmod(LOG[x] * power, FIELD)];
}

function polyScale(p, x) {
  const r = new Array(p.length);
  for (let i = 0; i < p.length; i++) r[i] = gfMul(p[i], x);
  return r;
}
function polyAdd(p, q) {
  const n = Math.max(p.length, q.length);
  const r = new Array(n).fill(0);
  for (let i = 0; i < p.length; i++) r[i + n - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + n - q.length] ^= q[i];
  return r;
}
function polyMul(p, q) {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) {
    const qj = q[j];
    if (qj === 0) continue;
    const lq = LOG[qj];
    for (let i = 0; i < p.length; i++) {
      if (p[i] !== 0) r[i + j] ^= EXP[LOG[p[i]] + lq];
    }
  }
  return r;
}
/** Synthetic division, highest degree first. Returns [quotient, remainder]. */
function polyDiv(dividend, divisor) {
  const out = dividend.slice();
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) {
    const coef = out[i];
    if (coef === 0) continue;
    for (let j = 1; j < divisor.length; j++) {
      if (divisor[j] !== 0) out[i + j] ^= gfMul(divisor[j], coef);
    }
  }
  const sep = out.length - (divisor.length - 1);
  return [out.slice(0, sep), out.slice(sep)];
}
function polyEval(poly, x) {
  let y = poly[0];
  for (let i = 1; i < poly.length; i++) y = gfMul(y, x) ^ poly[i];
  return y;
}

function generatorPoly(nsym) {
  let g = [1];
  for (let i = 0; i < nsym; i++) g = polyMul(g, [1, gfPow(2, i)]);
  return g;
}
const GEN = generatorPoly(NSYM);
const LGEN = GEN.map((c) => LOG[c]);

function encodeMsg(msgIn) {
  if (msgIn.length + NSYM > FIELD) {
    throw new RangeError(`Message is too long (${msgIn.length + NSYM} when max is ${FIELD})`);
  }
  const out = new Uint8Array(msgIn.length + NSYM);
  out.set(msgIn);
  for (let i = 0; i < msgIn.length; i++) {
    const coef = out[i];
    if (coef === 0) continue;
    const lcoef = LOG[coef];
    for (let j = 1; j < GEN.length; j++) out[i + j] ^= EXP[lcoef + LGEN[j]];
  }
  out.set(msgIn);
  return out;
}

function calcSyndromes(msg, nsym) {
  const s = new Array(nsym + 1);
  s[0] = 0;
  for (let i = 0; i < nsym; i++) s[i + 1] = polyEval(msg, gfPow(2, i));
  return s;
}

function findErrorLocator(synd, nsym) {
  let errLoc = [1];
  let oldLoc = [1];
  const syndShift = synd.length > nsym ? synd.length - nsym : 0;
  for (let i = 0; i < nsym; i++) {
    const K = i + syndShift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) {
      let idx = K - j;
      if (idx < 0) idx += synd.length; // Python negative indexing
      delta ^= gfMul(errLoc[errLoc.length - (j + 1)], synd[idx]);
    }
    oldLoc = oldLoc.concat([0]);
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, gfInverse(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  let lead = 0;
  while (lead < errLoc.length && errLoc[lead] === 0) lead++;
  errLoc = errLoc.slice(lead);
  const errs = errLoc.length - 1;
  if (errs * 2 > nsym) throw new ReedSolomonError('Too many errors to correct');
  return errLoc;
}

function findErrors(errLocRev, nmess) {
  const errs = errLocRev.length - 1;
  const pos = [];
  for (let i = 0; i < nmess; i++) {
    if (polyEval(errLocRev, gfPow(2, i)) === 0) pos.push(nmess - 1 - i);
  }
  if (pos.length !== errs) {
    throw new ReedSolomonError('Too many (or few) errors found by Chien Search for the errata locator polynomial!');
  }
  return pos;
}

function errataLocator(ePos) {
  let eLoc = [1];
  for (const i of ePos) eLoc = polyMul(eLoc, polyAdd([1], [gfPow(2, i), 0]));
  return eLoc;
}

function errorEvaluator(synd, errLoc, nsym) {
  const div = [1].concat(new Array(nsym + 1).fill(0));
  return polyDiv(polyMul(synd, errLoc), div)[1];
}

function correctErrata(msgIn, synd, errPos) {
  const n = msgIn.length;
  const coefPos = errPos.map((p) => n - 1 - p);
  const errLoc = errataLocator(coefPos);
  const errEval = errorEvaluator(synd.slice().reverse(), errLoc, errLoc.length - 1).reverse();
  const X = coefPos.map((c) => gfPow(2, -(FIELD - c)));
  const E = new Array(n).fill(0);
  const evalRev = errEval.slice().reverse();
  for (let i = 0; i < X.length; i++) {
    const Xi = X[i];
    const XiInv = gfInverse(Xi);
    let prime = 1;
    for (let j = 0; j < X.length; j++) {
      if (j !== i) prime = gfMul(prime, 1 ^ gfMul(XiInv, X[j]));
    }
    if (prime === 0) {
      throw new ReedSolomonError(
        'Decoding failed: Forney algorithm could not properly detect where the errors are located (errata locator prime is 0).');
    }
    let y = polyEval(evalRev, XiInv);
    y = gfMul(gfPow(Xi, 1), y);
    E[errPos[i]] = gfDiv(y, prime);
  }
  return polyAdd(Array.from(msgIn), E);
}

/**
 * `rs_correct_msg` for one chunk (no erasures).
 * @param {Uint8Array} chunk
 * @returns {{data: Uint8Array, ecc: Uint8Array, errata: number[]}}
 */
function correctMsg(chunk, nsym) {
  if (chunk.length > FIELD) throw new RangeError(`Message is too long (${chunk.length} when max is ${FIELD})`);
  let msg = Array.from(chunk);
  let synd = calcSyndromes(msg, nsym);
  const split = (m, errata) => {
    const cut = Math.max(0, m.length - nsym);
    return { data: Uint8Array.from(m.slice(0, cut)), ecc: Uint8Array.from(m.slice(cut)), errata };
  };
  if (Math.max(...synd) === 0) return split(msg, []);
  const fsynd = synd.slice(1);
  const errLoc = findErrorLocator(fsynd, nsym);
  const errPos = findErrors(errLoc.slice().reverse(), msg.length);
  msg = correctErrata(msg, synd, errPos);
  synd = calcSyndromes(msg, nsym);
  if (Math.max(...synd) > 0) throw new ReedSolomonError('Could not correct message');
  return split(msg, errPos);
}

/**
 * `RSCodec(30).encode(data)`: chunks of 225 bytes, 30 parity bytes each.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function rsEncode(data) {
  const parts = [];
  const step = NSIZE - NSYM;
  for (let i = 0; i < data.length; i += step) parts.push(encodeMsg(data.subarray(i, i + step)));
  if (data.length === 0) return new Uint8Array(0);
  return concatBytes(parts);
}

/**
 * `RSCodec(30).decode(data)`. Throws `ReedSolomonError` on failure.
 * @param {Uint8Array} data
 * @returns {{decoded: Uint8Array, full: Uint8Array, errata: number[]}}
 *   `errata` lists the corrected byte positions per chunk, as reedsolo does.
 */
export function rsDecode(data) {
  const dec = [];
  const full = [];
  const errata = [];
  for (let i = 0; i < data.length; i += NSIZE) {
    const r = correctMsg(data.subarray(i, i + NSIZE), NSYM);
    dec.push(r.data);
    full.push(r.data, r.ecc);
    errata.push(...r.errata);
  }
  return { decoded: concatBytes(dec), full: concatBytes(full), errata };
}

/** @param {Uint8Array[]} parts */
export function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
