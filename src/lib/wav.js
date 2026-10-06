/**
 * Minimal RIFF/WAVE reader and writer.
 *
 * Reads PCM 8/16/24/32-bit integer and IEEE float 32/64 (plain and WAVE_FORMAT_EXTENSIBLE).
 * Writes PCM16, PCM24 or float32. The PCM quantizer is the one the reference tools use:
 * clip to [-1, (2^(b-1) - 1) / 2^(b-1)], scale by 2^(b-1), round half to even.
 * @module wav
 */

import { roundHalfEven } from './stft.js';

/**
 * @typedef {object} WavData
 * @property {number} sampleRate
 * @property {Float64Array[]} channels one array per channel, samples in [-1, 1)
 * @property {number} bitsPerSample
 * @property {'pcm'|'float'} format
 */

/**
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {WavData}
 */
export function parseWav(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (u8.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let fmt = null;
  let data = null;
  let o = 12;
  while (o + 8 <= u8.length) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      let code = dv.getUint16(body, true);
      const channels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const blockAlign = dv.getUint16(body + 12, true);
      const bits = dv.getUint16(body + 14, true);
      if (code === 0xfffe && size >= 40) code = dv.getUint16(body + 24, true);
      fmt = { code, channels, sampleRate, blockAlign, bits };
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, u8.length - body) };
    }
    o = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV has no fmt chunk');
  if (!data) throw new Error('WAV has no data chunk');
  const { code, channels: nc, sampleRate, bits } = fmt;
  if (nc < 1) throw new Error('WAV has no channels');
  const bps = bits >> 3;
  const block = fmt.blockAlign || bps * nc;
  const n = Math.floor(data.size / block);
  const chans = Array.from({ length: nc }, () => new Float64Array(n));
  let read;
  if (code === 1) {
    if (bits === 8) read = (p) => (u8[p] - 128) / 128;
    else if (bits === 16) read = (p) => dv.getInt16(p, true) / 32768;
    else if (bits === 24) read = (p) => (((u8[p + 2] << 24) | (u8[p + 1] << 16) | (u8[p] << 8)) >> 8) / 8388608;
    else if (bits === 32) read = (p) => dv.getInt32(p, true) / 2147483648;
    else throw new Error(`unsupported PCM bit depth ${bits}`);
  } else if (code === 3) {
    if (bits === 32) read = (p) => dv.getFloat32(p, true);
    else if (bits === 64) read = (p) => dv.getFloat64(p, true);
    else throw new Error(`unsupported float bit depth ${bits}`);
  } else {
    throw new Error(`unsupported WAV format code ${code} (only PCM and IEEE float)`);
  }
  for (let i = 0; i < n; i++) {
    const p = data.start + i * block;
    for (let c = 0; c < nc; c++) chans[c][i] = read(p + c * bps);
  }
  return { sampleRate, channels: chans, bitsPerSample: bits, format: code === 3 ? 'float' : 'pcm' };
}

/** Average of all channels. @param {Float64Array[]} channels @returns {Float64Array} */
export function mixToMono(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float64Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  for (let i = 0; i < n; i++) out[i] /= channels.length;
  return out;
}

/**
 * Integer PCM code of a float sample for `bits` bits (reference quantizer).
 * @param {number} v
 * @param {number} bits 8..32
 */
export function quantizeSample(v, bits) {
  const scale = 2 ** (bits - 1);
  const hi = (scale - 1) / scale;
  const c = v < -1 ? -1 : v > hi ? hi : v !== v ? 0 : v;
  return roundHalfEven(c * scale);
}

/**
 * Round-trip samples through `bits`-bit PCM (what writing then reading a WAV does).
 * @param {ArrayLike<number>} x
 * @param {number} [bits]
 * @returns {Float64Array}
 */
export function quantize(x, bits = 16) {
  const scale = 2 ** (bits - 1);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = quantizeSample(x[i], bits) / scale;
  return out;
}

/**
 * @param {Float64Array|Float64Array[]} channels mono array or one array per channel
 * @param {number} sampleRate
 * @param {{format?: 'pcm16'|'pcm24'|'float32'}} [o]
 * @returns {Uint8Array} complete WAV file
 */
export function writeWav(channels, sampleRate, { format = 'pcm16' } = {}) {
  const chans = Array.isArray(channels) ? channels : [channels];
  const nc = chans.length;
  const n = chans[0].length;
  const bits = format === 'pcm16' ? 16 : format === 'pcm24' ? 24 : format === 'float32' ? 32 : 0;
  if (!bits) throw new RangeError(`unknown WAV format ${format}`);
  const code = format === 'float32' ? 3 : 1;
  const bps = bits >> 3;
  const dataSize = n * nc * bps;
  const u8 = new Uint8Array(44 + dataSize + (dataSize & 1));
  const dv = new DataView(u8.buffer);
  const put = (o, s) => { for (let i = 0; i < 4; i++) u8[o + i] = s.charCodeAt(i); };
  put(0, 'RIFF');
  dv.setUint32(4, u8.length - 8, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, code, true);
  dv.setUint16(22, nc, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nc * bps, true);
  dv.setUint16(32, nc * bps, true);
  dv.setUint16(34, bits, true);
  put(36, 'data');
  dv.setUint32(40, dataSize, true);
  let p = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const v = chans[c][i];
      if (bits === 16) dv.setInt16(p, quantizeSample(v, 16), true);
      else if (bits === 24) {
        const q = quantizeSample(v, 24);
        u8[p] = q & 0xff;
        u8[p + 1] = (q >> 8) & 0xff;
        u8[p + 2] = (q >> 16) & 0xff;
      } else dv.setFloat32(p, v, true);
      p += bps;
    }
  }
  return u8;
}
