/**
 * Key encodings accepted by the Python reference (`load_secret_key`, `load_public_key`):
 * raw 32 bytes, 64 hex digits, or PEM (PKCS#8 secret, SPKI public).
 * @module keys
 */

import { publicKeyOf } from './ed25519.js';

// DER prefixes of the only Ed25519 encodings OpenSSL writes (RFC 8410).
const PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

const dec = new TextDecoder('latin1');

function asText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return dec.decode(data);
  throw new TypeError('key must be a Uint8Array or a string');
}

function maybeHex(text) {
  const s = text.trim();
  if (s.length !== 64 || /[^0-9a-fA-F]/.test(s)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function pemBody(text, label) {
  const m = text.match(new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`));
  if (!m) return null;
  const bin = atob(m[1].replace(/\s+/g, ''));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function stripPrefix(der, prefix, what) {
  if (der.length !== prefix.length + 32 || prefix.some((v, i) => der[i] !== v)) {
    throw new RangeError(`PEM ${what} is not Ed25519`);
  }
  return der.slice(prefix.length);
}

function load(data, what, label, prefix) {
  if (data instanceof Uint8Array && data.length === 32) return Uint8Array.from(data);
  const text = asText(data);
  if (text.trimStart().startsWith('-----BEGIN')) {
    const der = pemBody(text, label);
    if (!der) throw new RangeError(`not an Ed25519 ${what} PEM (expected BEGIN ${label})`);
    return stripPrefix(der, prefix, what);
  }
  const h = maybeHex(text);
  if (h) return h;
  const n = data instanceof Uint8Array ? data.length : text.length;
  throw new RangeError(`malformed ${what} (${n} ${data instanceof Uint8Array ? 'bytes' : 'characters'}; expected raw 32 B, 64 hex, or PEM)`);
}

/** 32-byte secret seed from raw bytes, 64 hex digits or PKCS#8 PEM. @returns {Uint8Array} */
export function loadSecretKey(data) {
  return load(data, 'secret key', 'PRIVATE KEY', PKCS8_PREFIX);
}

/** 32-byte public key from raw bytes, 64 hex digits or SPKI PEM. @returns {Uint8Array} */
export function loadPublicKey(data) {
  return load(data, 'public key', 'PUBLIC KEY', SPKI_PREFIX);
}

function pem(label, der) {
  const b64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;
}

/** PKCS#8 PEM of a secret key (same text as `cryptography`). @returns {string} */
export function secretPem(secretKey) {
  const sk = loadSecretKey(secretKey);
  const der = new Uint8Array(PKCS8_PREFIX.length + 32);
  der.set(PKCS8_PREFIX);
  der.set(sk, PKCS8_PREFIX.length);
  return pem('PRIVATE KEY', der);
}

/** SPKI PEM of a public key, or of the public key of a secret key object. @returns {string} */
export function publicPem(publicKey) {
  const pk = loadPublicKey(publicKey);
  const der = new Uint8Array(SPKI_PREFIX.length + 32);
  der.set(SPKI_PREFIX);
  der.set(pk, SPKI_PREFIX.length);
  return pem('PUBLIC KEY', der);
}

/** Public key of a secret key in any accepted encoding. */
export function publicKey(secretKey) {
  return publicKeyOf(loadSecretKey(secretKey));
}
