/**
 * The full protocol of the demonstration, stage by stage, on the real library.
 *
 * DOM-free: the browser worker and the Node smoke test run the same code. Each stage
 * reports its wall-clock time and the data its card draws. The secret key never leaves
 * this module; stages only report the public key and what a verifier could see.
 * Analysis fields that use the ground truth (true bits, true layout) are for display;
 * the verifier itself only gets the attacked samples and the public key.
 * @module demo/pipeline
 */

import {
  keygen, sign, verify, buildPayload, splitPayload, parseWav, mixToMono, resample, quantize, readSoft, analyze,
  embedPayload, getProfile, makeLayout, seedFromPublicKey, bodySums, headerBits, toHex, HEADER_BITS, GROUP, N_FFT,
  SAMPLE_RATE, TooShortError, publicPem,
} from '../lib/index.js';
import { sha256 } from '../lib/ed25519.js';
import { meanLog } from '../lib/embed.js';
import { rsDecode } from '../lib/rs.js';
import { applyAttacks, snrDb } from './attacks.js';
import { STAGES, CANDIDATE_CODES as CODE } from './stages.js';

export { STAGES };

/** Longest clip the demonstration processes (seconds at 44.1 kHz). */
export const MAX_SECONDS = 30;
/** Spectrogram rows sent to the page: bins 0..512, 0 to 11.025 kHz. */
export const SPEC_BINS = 513;
const N_BINS = N_FFT / 2 + 1;
const now = () => performance.now();

/** Magnitude in dBFS: a full-scale sine peaks at 0 dB with the 2048-point rectangular window. */
function dbfs(a) {
  return 20 * Math.log10(a / (N_FFT / 2) + 1e-12);
}

function spectrogram(an) {
  const out = new Float32Array(an.frames * SPEC_BINS);
  for (let t = 0; t < an.frames; t++) {
    for (let k = 0; k < SPEC_BINS; k++) out[t * SPEC_BINS + k] = dbfs(an.A[t * N_BINS + k]);
  }
  return { frames: an.frames, bins: SPEC_BINS, db: out };
}

/** Mean power spectrum over frames, in dBFS, all 1025 bins. */
function meanSpectrum(an) {
  const out = new Float32Array(N_BINS);
  if (!an.frames) return out.fill(-140);
  for (let k = 0; k < N_BINS; k++) {
    let p = 0;
    for (let t = 0; t < an.frames; t++) p += an.A[t * N_BINS + k] ** 2;
    out[k] = 10 * Math.log10(p / an.frames / (N_FFT / 2) ** 2 + 1e-14);
  }
  return out;
}

/** Decode the source to mono 44.1 kHz, capped at MAX_SECONDS. */
async function loadSource(src, fetchImpl) {
  let sampleRate;
  let channels;
  if (src.kind === 'url' || src.kind === 'wav') {
    const bytes = src.kind === 'url' ? new Uint8Array(await (await fetchOk(fetchImpl, src.url)).arrayBuffer()) : src.bytes;
    const w = parseWav(bytes);
    sampleRate = w.sampleRate;
    channels = w.channels;
  } else if (src.kind === 'pcm') {
    sampleRate = src.sampleRate;
    channels = src.channels.map((c) => Float64Array.from(c));
  } else {
    throw new TypeError(`unknown source kind ${src.kind}`);
  }
  let x = mixToMono(channels);
  const resampled = sampleRate !== SAMPLE_RATE;
  if (resampled) x = resample(x, sampleRate, SAMPLE_RATE);
  const cap = MAX_SECONDS * SAMPLE_RATE;
  const truncated = x.length > cap;
  if (truncated) x = x.slice(0, cap);
  // Store as the 16-bit file a user would hand in; bundled clips are already PCM16 (no-op).
  x = quantize(x, 16);
  return { x, sampleRate, nChannels: channels.length, resampled, truncated };
}

async function fetchOk(fetchImpl, url) {
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`could not load ${url}: HTTP ${r.status}`);
  return r;
}

function residual(x, y) {
  const r = new Float64Array(y.length);
  for (let i = 0; i < y.length; i++) r[i] = y[i] - (x[i] ?? 0);
  return r;
}

/** Magnitude-pair statistic d = mean8 log A[k1] - mean8 log A[k2] of stream position i. */
function qimStat(A, lay, bm, i) {
  const scratch = new Float64Array(GROUP);
  const g = (i / bm) | 0;
  const s = i - g * bm;
  const base = g * GROUP * N_BINS;
  return meanLog(A, base + lay.pairs[2 * s], scratch) - meanLog(A, base + lay.pairs[2 * s + 1], scratch);
}

/** Histogram of soft values times (2b - 1) over [-1, 1]: correct bits land on the right. */
function signedHistogram(soft, truth, n, nb = 40) {
  const h = new Uint32Array(nb);
  let erased = 0;
  for (let i = 0; i < n; i++) {
    const v = soft[i] * (truth[i] ? 1 : -1);
    if (soft[i] === 0) erased++;
    h[Math.min(nb - 1, Math.max(0, Math.floor(((v + 1) / 2) * nb)))]++;
  }
  return { counts: h, erased, n };
}

/** Raw bit errors of a channel over the positions both the stream and the capacity cover. */
function rawErrors(soft, truth) {
  const n = Math.min(soft.length, truth.length);
  let e = 0;
  for (let i = 0; i < n; i++) if ((soft[i] > 0 ? 1 : 0) !== truth[i]) e++;
  return { errors: e, n };
}

/** Body sums, hard decisions and byte errors of a channel at the true payload length. */
function combined(soft, body, maxReplicas) {
  if (soft.length - HEADER_BITS < body.length) return null;
  const { replicas, sums } = bodySums(soft, body.length, maxReplicas);
  let bitErrors = 0;
  const badBytes = new Set();
  for (let j = 0; j < body.length; j++) {
    if ((sums[j] > 0 ? 1 : 0) !== body[j]) {
      bitErrors++;
      badBytes.add(j >> 3);
    }
  }
  return { replicas, sums: Float32Array.from(sums), bitErrors, byteErrors: badBytes.size, bits: body.length };
}

function transport(soft, streams, body, prof) {
  const out = {};
  for (const ch of ['phase', 'magnitude']) {
    const s = soft[ch];
    const truth = streams[ch];
    const n = Math.min(s.length, truth.length);
    out[ch] = {
      capacity: s.length,
      hist: signedHistogram(s, truth, n),
      raw: rawErrors(s, truth),
      combined: combined(s, body, ch === 'phase' ? prof.rp : prof.rm),
    };
  }
  return out;
}

/** Verify trace attempts in a compact form: one code per candidate. */
function summarizeAttempts(trace) {
  return trace.attempts.map((a) => {
    const codes = new Uint8Array(a.candidates.length);
    const ms = new Int16Array(a.candidates.length);
    let headerFirst = false;
    a.candidates.forEach((c, i) => {
      ms[i] = c.m === null ? -1 : c.m;
      if (i === 0 && c.path === 'header') headerFirst = true;
      if (c.duplicate) codes[i] = CODE.duplicate;
      else if (c.ok) codes[i] = CODE.accepted;
      else if (c.sig_checked) codes[i] = CODE.sig_fail;
      else if (c.rs_ok) codes[i] = CODE.length;
      else codes[i] = CODE.rs_fail;
    });
    return {
      profile: a.profile,
      channel: a.channel,
      alignment: a.alignment,
      capacity: a.capacity,
      header_length: a.header_length,
      header_sums: a.header_sums ? Float32Array.from(a.header_sums) : null,
      headerFirst,
      codes,
      ms,
      accepted: a.accepted ? acceptedView(a.accepted) : null,
    };
  });
}

/** The accepted candidate: the word as read, the word after Reed-Solomon, and where they differ. */
function acceptedView(acc) {
  const read = Uint8Array.from(acc.payload);
  const repaired = rsDecode(read).full;
  const fixed = [];
  for (let i = 0; i < read.length; i++) if (read[i] !== repaired[i]) fixed.push(i);
  return {
    path: acc.path, m: acc.m, bits: acc.bits, replicas: acc.replicas,
    payload: read, repaired, fixed, signature: Uint8Array.from(acc.signature),
  };
}

function publicResult(r) {
  const { message_bytes: _drop, ...rest } = r;
  return rest;
}

/**
 * Run the protocol.
 * @param {object} cfg
 * @param {{kind: 'url', url: string, name?: string}|{kind: 'wav', bytes: Uint8Array, name?: string}|
 *   {kind: 'pcm', channels: Float32Array[], sampleRate: number, name?: string}} cfg.source
 * @param {string} cfg.message
 * @param {'wb'|'nb'} cfg.profile
 * @param {object} cfg.attacks see DEFAULT_ATTACKS
 * @param {boolean} cfg.resync
 * @param {object} [env]
 * @param {(id: string, state: 'start'|'done', data?: object) => void} [env.onStage]
 * @param {Function} [env.codec] async lossy round trip (browser WebCodecs)
 * @param {Function} [env.fetch]
 * @returns {Promise<object>} every stage's data plus the verify result
 */
export async function runProtocol(cfg, env = {}) {
  const onStage = env.onStage ?? (() => {});
  const report = { stages: {} };
  const stage = async (id, f) => {
    onStage(id, 'start');
    const t0 = now();
    const data = await f();
    data.ms = now() - t0;
    report.stages[id] = data;
    onStage(id, 'done', data);
    return data;
  };
  const prof = getProfile(cfg.profile ?? 'wb');
  const resync = !!cfg.resync;

  // 1. Identity: the secret key stays in this scope.
  let sk;
  let pk;
  await stage('identity', () => {
    ({ secretKey: sk, publicKey: pk } = keygen());
    return { publicKey: toHex(pk), pem: publicPem(pk), fingerprint: sha256(pk), seed: seedFromPublicKey(pk) };
  });
  const seed = seedFromPublicKey(pk);
  const lay = makeLayout(seed, prof);

  // 2. Load.
  let x;
  await stage('load', async () => {
    const src = await loadSource(cfg.source, env.fetch ?? globalThis.fetch);
    x = src.x;
    return {
      name: cfg.source.name ?? 'clip', sampleRate: src.sampleRate, channels: src.nChannels, resampled: src.resampled,
      truncated: src.truncated, samples: x.length, seconds: x.length / SAMPLE_RATE, audio: Float32Array.from(x),
    };
  });

  // 3. Payload: RS(be16 len || M || Ed25519(sk, M)).
  let payload;
  await stage('payload', () => {
    payload = buildPayload(cfg.message, sk);
    const parts = splitPayload(payload);
    return {
      message: cfg.message,
      payload: Uint8Array.from(payload),
      parts: {
        length: parts.length, message: Uint8Array.from(parts.message), signature: Uint8Array.from(parts.signature),
        parity: Uint8Array.from(parts.parity),
      },
      bits: 8 * payload.length,
      header: headerBits(8 * payload.length),
      profile: prof.name,
      band: { p_lo: prof.p_lo, p_hi: prof.p_hi, m_lo: prof.m_lo, m_hi: prof.m_hi, bp: prof.bp, bm: prof.bm, rp: prof.rp, rm: prof.rm, delta: prof.delta },
      kp: Int32Array.from(lay.kp),
      pairs: Int32Array.from(lay.pairs),
    };
  });

  // 4. Embed with the public API, then write the 16-bit file a user would download.
  let y16;
  let signTrace;
  await stage('embed', () => {
    signTrace = {};
    let y;
    try {
      y = sign(x, SAMPLE_RATE, sk, cfg.message, { profile: prof.name, trace: signTrace });
    } catch (e) {
      if (e instanceof TooShortError) e.message += '. Use a longer clip or a shorter message.';
      throw e;
    }
    if (toHex(signTrace.payload) !== toHex(payload)) throw new Error('internal: sign() built a different payload');
    y16 = quantize(y, 16);
    const a0 = analyze(x);
    const a1 = analyze(y16);
    const ps = signTrace.phase.stream;
    const ms = signTrace.magnitude.stream;
    const bp = prof.bp;
    const phaseBefore = new Float32Array(ps.length);
    const phaseAfter = new Float32Array(ps.length);
    for (let i = 0; i < ps.length; i++) {
      const g = (i / bp) | 0;
      const idx = g * GROUP * N_BINS + lay.kp[i - g * bp];
      phaseBefore[i] = a0.P[idx];
      phaseAfter[i] = a1.P[idx];
    }
    const dAfter = new Float32Array(ms.length);
    for (let i = 0; i < ms.length; i++) dAfter[i] = qimStat(a1.A, lay, prof.bm, i);
    return {
      profile: prof.name,
      frames: signTrace.frames,
      groups: signTrace.groups,
      capacity: { phase: signTrace.phase.capacity, magnitude: signTrace.magnitude.capacity },
      replicas: { phase: signTrace.phase.replicas, magnitude: signTrace.magnitude.replicas },
      streams: { phase: Uint8Array.from(ps), magnitude: Uint8Array.from(ms) },
      phase: { before: phaseBefore, after: phaseAfter },
      qim: {
        before: Float32Array.from(signTrace.magnitude.d_before), target: Float32Array.from(signTrace.magnitude.d_after),
        after: dAfter, cell: Int32Array.from(signTrace.magnitude.cell), shift: Float32Array.from(signTrace.magnitude.shift),
      },
      snr: snrDb(x, y16),
      spec: { before: spectrogram(a0), after: spectrogram(a1), residual: spectrogram(analyze(residual(x, y16))) },
      audio: Float32Array.from(y16),
    };
  });

  // 5. Attacks on the signed file (and, for the control, on the unsigned original).
  let z;
  const noiseSeed = cfg.noiseSeed ?? globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  const attackEnv = { codec: env.codec, seed: noiseSeed };
  await stage('attack', async () => {
    const r = await applyAttacks(y16, cfg.attacks, attackEnv);
    z = quantize(r.samples, 16);
    return {
      steps: r.steps,
      noiseSeed,
      samples: z.length,
      snr: r.steps.length ? snrDb(y16, z) : Infinity,
      spectrum: { signed: meanSpectrum(analyze(y16)), attacked: meanSpectrum(analyze(z)) },
      audio: Float32Array.from(z),
    };
  });

  // 6. Blind verification: attacked samples and the public key, nothing else.
  let result;
  await stage('verify', () => {
    const trace = {};
    const t0 = now();
    result = verify(z, SAMPLE_RATE, pk, { profile: null, resync, trace });
    const verifyMs = now() - t0;
    const body = signTrace.body_bits;
    const streams = { phase: signTrace.phase.stream, magnitude: signTrace.magnitude.stream };
    const offset = result.offset?.samples ?? 0;
    const clean = readSoft(y16, seed, prof);
    const attacked = readSoft(z.subarray(offset), seed, prof);
    return {
      verifyMs,
      result: publicResult(result),
      resync,
      attempts: summarizeAttempts(trace),
      resyncTrace: trace.resync
        ? { order: trace.resync.order, tried: trace.resync.tried.length, best: trace.resync.best }
        : null,
      transport: {
        profile: prof.name,
        offset,
        clean: transport(clean, streams, body, prof),
        attacked: transport(attacked, streams, body, prof),
      },
    };
  });

  // 7. Negative controls under the same attacks and verifier settings.
  await stage('controls', async () => {
    const run = (samples, key) => {
      const t0 = now();
      const r = verify(samples, SAMPLE_RATE, key, { profile: null, resync });
      return { ...publicResult(r), ms: now() - t0 };
    };
    const other = keygen();
    const wrongKey = { publicKey: toHex(other.publicKey), ...run(z, other.publicKey) };
    const xa = quantize((await applyAttacks(x, cfg.attacks, attackEnv)).samples, 16);
    const unsigned = run(xa, pk);
    // An impostor signs the same message with their own key and copies this key's layout.
    const impostorPayload = buildPayload(cfg.message, other.secretKey);
    const yi = quantize(embedPayload(x, impostorPayload, seed, prof), 16);
    const zi = quantize((await applyAttacks(yi, cfg.attacks, attackEnv)).samples, 16);
    const impostor = run(zi, pk);
    return { wrongKey, unsigned, impostor };
  });

  report.result = publicResult(result);
  return report;
}

export { CODE as CANDIDATE_CODES };
