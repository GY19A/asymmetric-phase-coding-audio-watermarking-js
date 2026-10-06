/**
 * Opus round trip through the browser's WebCodecs AudioEncoder and AudioDecoder.
 *
 * Opus runs at 48 kHz, so the signed 44.1 kHz samples are resampled up, encoded, decoded
 * and resampled back. The encoder's algorithmic delay (the OpusHead pre-skip) is not audio
 * content and a player drops it. Some decoders drop it themselves when given the OpusHead
 * (Chrome does) and some do not, so the delay left in the output is measured on a synthetic
 * click sent through the same path, never on the audio under test. The label names the
 * codec, the bitrate and the compensation actually applied.
 * @module demo/codec
 */

import { resample } from '../lib/index.js';

const OPUS_RATE = 48000;
const CHUNK = 960; // 20 ms at 48 kHz

/** True when this context can encode and decode mono Opus at `bitrate`. */
export async function opusSupported(bitrate = 128000) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined' || typeof AudioData === 'undefined') {
    return false;
  }
  try {
    const cfg = { codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 1 };
    const [e, d] = await Promise.all([
      AudioEncoder.isConfigSupported({ ...cfg, bitrate }),
      AudioDecoder.isConfigSupported(cfg),
    ]);
    return !!(e.supported && d.supported);
  } catch {
    return false;
  }
}

/** Pre-skip (samples at 48 kHz) of an OpusHead description, or null. */
function preSkip(description) {
  if (!description) return null;
  const b = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  const magic = String.fromCharCode(...b.subarray(0, 8));
  if (b.length < 12 || magic !== 'OpusHead') return null;
  return b[10] | (b[11] << 8);
}

/** Encode then decode 48 kHz mono samples; returns the decoded samples and the pre-skip. */
async function roundTrip48(x, bitrate) {
  const packets = [];
  let decoderConfig = null;
  let failure = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig) decoderConfig = meta.decoderConfig;
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      packets.push({ type: chunk.type, timestamp: chunk.timestamp, duration: chunk.duration ?? undefined, data });
    },
    error: (e) => {
      failure = e;
    },
  });
  enc.configure({ codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 1, bitrate });
  for (let i = 0; i < x.length; i += CHUNK) {
    const n = Math.min(CHUNK, x.length - i);
    const f = new Float32Array(n);
    for (let j = 0; j < n; j++) f[j] = x[i + j];
    const ad = new AudioData({
      format: 'f32-planar', sampleRate: OPUS_RATE, numberOfFrames: n, numberOfChannels: 1,
      timestamp: Math.round((i * 1e6) / OPUS_RATE), data: f,
    });
    enc.encode(ad);
    ad.close();
  }
  await enc.flush();
  enc.close();
  if (failure) throw failure;

  const pieces = [];
  let total = 0;
  const dec = new AudioDecoder({
    output: (ad) => {
      const f = new Float32Array(ad.numberOfFrames);
      ad.copyTo(f, { planeIndex: 0, format: 'f32-planar' });
      pieces.push(f);
      total += f.length;
      ad.close();
    },
    error: (e) => {
      failure = e;
    },
  });
  dec.configure({
    codec: 'opus', sampleRate: OPUS_RATE, numberOfChannels: 1,
    ...(decoderConfig?.description ? { description: decoderConfig.description } : {}),
  });
  for (const p of packets) dec.decode(new EncodedAudioChunk(p));
  await dec.flush();
  dec.close();
  if (failure) throw failure;
  const out = new Float32Array(total);
  let o = 0;
  for (const f of pieces) {
    out.set(f, o);
    o += f.length;
  }
  return { samples: out, preSkip: preSkip(decoderConfig?.description) };
}

const measured = new Map();
/** Delay left by this browser's Opus path, from a click in silence (not from the audio under test). */
async function probeDelay(bitrate) {
  if (measured.has(bitrate)) return measured.get(bitrate);
  const probe = new Float32Array(OPUS_RATE / 2);
  const at = 4800;
  probe[at] = 0.9;
  const { samples } = await roundTrip48(probe, bitrate);
  let best = 0;
  let arg = at;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]) > best) {
      best = Math.abs(samples[i]);
      arg = i;
    }
  }
  const delay = Math.max(0, arg - at);
  measured.set(bitrate, delay);
  return delay;
}

/**
 * Lossy Opus round trip of 44.1 kHz samples, same length out (zero padded if short).
 * @param {Float64Array} x
 * @param {{bitrate?: number}} [s]
 * @returns {Promise<{samples: Float64Array, label: string}>}
 */
export async function opusRoundTrip(x, { bitrate = 128000 } = {}) {
  const up = resample(x, 44100, OPUS_RATE);
  const { samples, preSkip: skip } = await roundTrip48(up, bitrate);
  const delay = await probeDelay(bitrate);
  const how = delay === 0 && skip !== null ? `pre-skip of ${skip} applied by the decoder` : `measured delay of ${delay} samples removed`;
  const trimmed = samples.subarray(Math.min(delay, samples.length));
  const down = resample(trimmed, OPUS_RATE, 44100);
  const out = new Float64Array(x.length);
  out.set(down.subarray(0, Math.min(down.length, x.length)));
  return {
    samples: out,
    label: `Opus ${Math.round(bitrate / 1000)} kb/s, mono (WebCodecs, 48 kHz round trip, ${how})`,
  };
}
