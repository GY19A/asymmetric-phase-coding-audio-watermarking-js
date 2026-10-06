// Reed-Solomon RS(255,225) against reedsolo 1.7 (tests/oracle/rs.json).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rsEncode, rsDecode, ReedSolomonError, NSYM } from '../src/lib/index.js';
import { oracleJSON, fromHex, toHex } from './helpers.js';

function decodeOrNull(bytes) {
  try {
    const r = rsDecode(bytes);
    return { decodes: true, decoded_hex: toHex(r.decoded), n_corrected: r.errata.length };
  } catch (e) {
    if (!(e instanceof ReedSolomonError)) throw e;
    return { decodes: false, decoded_hex: null, n_corrected: null };
  }
}

test('encode equals reedsolo for 10 lengths (1 to 480 bytes, multi-chunk included)', () => {
  const { cases } = oracleJSON('rs.json');
  for (const c of cases) {
    const msg = fromHex(c.message_hex);
    assert.equal(toHex(rsEncode(msg)), c.codeword_hex, `len ${msg.length}`);
    assert.equal(c.codeword_hex.length / 2, msg.length + NSYM * Math.ceil(msg.length / 225));
  }
});

test('decode accepts exactly what reedsolo accepts: 0 to 60 errors, corrected counts', () => {
  const { cases } = oracleJSON('rs.json');
  let n = 0;
  for (const c of cases) {
    for (const k of c.corrupted) {
      const got = decodeOrNull(fromHex(k.received_hex));
      assert.deepEqual(got, { decodes: k.decodes, decoded_hex: k.decoded_hex, n_corrected: k.n_corrected },
        `len ${c.message_hex.length / 2}, ${k.n_errors} errors`);
      n++;
    }
  }
  assert.equal(n, 160);
});

test('random words and the zero word: same verdicts as reedsolo', () => {
  const { random } = oracleJSON('rs.json');
  for (const k of random) {
    const got = decodeOrNull(fromHex(k.received_hex));
    assert.deepEqual(got, { decodes: k.decodes, decoded_hex: k.decoded_hex, n_corrected: k.n_corrected },
      k.received_hex.slice(0, 16));
  }
  assert.ok(random.some((k) => !k.decodes), 'random words must include rejections');
});

test('the 15/16 error boundary of t = 15', () => {
  const msg = Uint8Array.from({ length: 200 }, (_, i) => (i * 37 + 11) & 0xff);
  const cw = rsEncode(msg);
  for (const [nerr, ok] of [[15, true], [16, false]]) {
    const rx = Uint8Array.from(cw);
    for (let i = 0; i < nerr; i++) rx[i * 13] ^= 0x5a;
    assert.equal(decodeOrNull(rx).decodes, ok, `${nerr} errors`);
  }
});
