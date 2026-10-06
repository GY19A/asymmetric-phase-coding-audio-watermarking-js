/**
 * The seven stages of the demonstration, in run order. Shared by the worker pipeline and
 * the page, which only needs the ids, labels and defaults (so it does not load the library).
 * @module demo/stages
 */

export const STAGES = Object.freeze([
  { id: 'identity', label: 'Generate an Ed25519 identity', kind: 'crypto' },
  { id: 'load', label: 'Load the clip', kind: 'signal' },
  { id: 'payload', label: 'Build the signed payload', kind: 'crypto' },
  { id: 'embed', label: 'Embed in phase and magnitude', kind: 'signal' },
  { id: 'attack', label: 'Attack the signed file', kind: 'signal' },
  { id: 'verify', label: 'Blind verification', kind: 'crypto' },
  { id: 'controls', label: 'Negative controls', kind: 'crypto' },
]);

/** Message the page signs by default. The library's shared test vectors keep the paper's message. */
export const DEFAULT_MESSAGE = 'Authenticity Deepfake Defense Test: I love Orie.';

/** Bundled clips, served from media/ next to the page. */
export const CLIPS = Object.freeze([
  { file: '0000_librispeech_5639-40744-0030.wav', name: 'LibriSpeech 5639-40744-0030' },
  { file: '0001_librispeech_8555-284447-0010.wav', name: 'LibriSpeech 8555-284447-0010' },
  { file: '0002_librispeech_3570-5695-0012.wav', name: 'LibriSpeech 3570-5695-0012' },
]);

/** Candidate outcome codes in the verify summary (see pipeline.summarizeAttempts). */
export const CANDIDATE_CODES = Object.freeze({ duplicate: 0, rs_fail: 1, length: 2, sig_fail: 3, accepted: 4 });

/**
 * Defaults of the demonstration. The three enabled attacks verify on every bundled clip with
 * fresh keys: the head crop erases the phase channel's header and first body bits, so the
 * magnitude channel's length search and Reed-Solomon do the work. The paper makes no noise
 * claim; below about 50 dB SNR the watermark is expected to break.
 */
export const DEFAULT_ATTACKS = Object.freeze({
  shift: { on: false, samples: 5000 },
  cropHead: { on: true, pct: 10 },
  cropTail: { on: true, pct: 20 },
  lowpass: { on: true, hz: 8000 },
  noise: { on: false, snr: 50, color: 'white' },
  codec: { on: false, bitrate: 128000 },
  requant: { on: false, bits: 12 },
});

/** Attack options on the page; every combination verifies on the bundled clips (see the pipeline test). */
export const PAGE_OPTIONS = Object.freeze({
  cropHead: [[0, 'off'], [10, '10%'], [20, '20%'], [30, '30%']],
  cropTail: [[0, 'off'], [10, '10%'], [20, '20%']],
  lowpass: [[0, 'off'], [12000, '12 kHz'], [10000, '10 kHz'], [8000, '8 kHz']],
});

/** Longest message the page accepts, in UTF-8 bytes. */
export const PAGE_MSG_MAX = 52;

/**
 * Microphone recordings: fixed length and the largest head crop offered. On 165 speech clips
 * of this length from six corpora, every page combination with this head crop verified.
 */
export const VOICE_SECONDS = 20;
export const VOICE_HEAD_MAX = 10;
