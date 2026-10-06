// Ed25519 (RFC 8032) with the cofactorless acceptance rule of OpenSSL, as used by the Python reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { edVerify } from '../src/lib/index.js';
import { publicKeyOf, edSign, edVerifyCofactored, CURVE_ORDER } from '../src/lib/ed25519.js';
import { mixedOrderCase, le32, leNum, fromHex, toHex } from './helpers.js';

// RFC 8032 section 7.1, tests 1 to 3: [secret, message, public, signature].
const RFC8032 = [
  ['9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', '',
    'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'],
  ['4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', '72',
    '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c',
    '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'],
  ['c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7', 'af82',
    'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025',
    '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'],
];

test('RFC 8032 section 7.1 tests 1 to 3', () => {
  for (const [sk, msg, pk, sig] of RFC8032) {
    assert.equal(toHex(publicKeyOf(fromHex(sk))), pk);
    assert.equal(toHex(edSign(fromHex(msg), fromHex(sk))), sig);
    assert.equal(edVerify(fromHex(sig), fromHex(msg), fromHex(pk)), true);
    const other = Uint8Array.from(fromHex(msg + '00'));
    assert.equal(edVerify(fromHex(sig), other, fromHex(pk)), false);
  }
});

test('a mixed-order public key: cofactorless rejects, cofactored would accept', async () => {
  const { T, publicKey, message, signature } = await mixedOrderCase();
  assert.ok(T.multiply(8n).is0(), '[8]T is the identity');
  assert.ok(!T.multiply(4n).is0(), '[4]T is not the identity');
  assert.equal(edVerifyCofactored(signature, message, publicKey), true);
  assert.equal(edVerify(signature, message, publicKey), false);
});

test('S >= L and wrong lengths are rejected', () => {
  const [sk, msg, pk] = RFC8032[1];
  const sig = edSign(fromHex(msg), fromHex(sk));
  const mal = Uint8Array.from(sig);
  mal.set(le32(leNum(sig.subarray(32)) + CURVE_ORDER), 32);
  assert.equal(edVerify(mal, fromHex(msg), fromHex(pk)), false);
  assert.equal(edVerify(sig.subarray(0, 63), fromHex(msg), fromHex(pk)), false);
  assert.equal(edVerify(sig, fromHex(msg), fromHex(pk).subarray(1)), false);
});
