# Asymmetric Phase Coding Audio Watermarking: JavaScript

**Sign audio with a secret key. Verify it with the public key alone.**

JavaScript implementation of APC audio watermarking (format `apcaw-v1`) for Node 22 and modern
browsers, and the source of the interactive demo site. A signer embeds a message and its Ed25519
signature in the STFT phase and magnitude of an audio clip. Anyone with the public key can check
the mark. The verifier needs no secret, no original and no database.

- **Live demo:** <https://gy19a.github.io/asymmetric-phase-coding-audio-watermarking-js/>
  It runs the whole protocol in your browser, including signing your own voice. Nothing is
  uploaded.
- Paper: [NeurIPS 2026](https://neurips.cc/virtual/2026/loc/atlanta/poster/149813),
  [arXiv:2605.07241](https://arxiv.org/abs/2605.07241)
- Python reference: <https://github.com/GY19A/asymmetric-phase-coding-audio-watermarking>
- Rust library and CLI: <https://github.com/GY19A/asymmetric-phase-coding-audio-watermarking-rs>

Files signed here verify in the Python and Rust implementations, and the reverse.

- ES modules, no build step for the library, no WebCrypto. It also runs on a plain `http://`
  address.
- Two runtime dependencies: `@noble/ed25519` and `@noble/hashes`.
- The API names and the JSON keys match the Python package and the Rust CLI.

## Library

```sh
npm install github:GY19A/asymmetric-phase-coding-audio-watermarking-js   # imports as 'apcaw-js'
```

```js
import { readFile } from 'node:fs/promises';
import { keygen, sign, verify, parseWav, mixToMono } from 'apcaw-js';
const { secretKey, publicKey } = keygen();
const { sampleRate, channels } = parseWav(await readFile('in.wav'));
const signed = sign(mixToMono(channels), sampleRate, secretKey, 'hello');
console.log(verify(signed, sampleRate, publicKey).message); // hello
```

This is the sample shown on the demo page. `npm test` runs it as written.

### Functions

| Function | What it does |
| --- | --- |
| `keygen(seed?)` | New Ed25519 key pair `{secretKey, publicKey}` (32 bytes each). A 32-byte seed gives a fixed pair. |
| `sign(samples, 44100, secretKey, message, {profile, options, trace})` | Signed samples as a `Float64Array` of the same length. They are not quantized; write them with `writeWav` or `quantize(y, 16)`. Throws `TooShortError` when the clip cannot hold the payload. |
| `verify(samples, 44100, publicKey, {profile, resync, options, trace})` | The verdict, see below. Unmarked, damaged or short audio gives `verified: false`. It throws only for another sample rate or a malformed key. |
| `buildPayload(message, secretKey)` / `parsePayload(bytes, publicKey)` | The signed payload bytes, and the check of one candidate. |
| `layout(publicKey, profile)` | The key-derived phase bins and magnitude pairs. |
| `inspect(samples, 44100, publicKey)` | Capacity and soft-value statistics per profile and channel. |
| `parseWav(bytes)` / `writeWav(channels, sampleRate, {format})` | WAV PCM 8/16/24/32 and float 32/64 in, PCM16, PCM24 or float32 out. |
| `mixToMono(channels)`, `resample(x, from, to)`, `quantize(x, bits)` | Input preparation. The format is defined at 44.1 kHz mono only. |
| `loadSecretKey`, `loadPublicKey`, `secretPem`, `publicPem` | Keys as raw bytes, 64 hex digits, or PEM (PKCS#8, SPKI). |
| `toHex`, `fromHex` | Hex helpers. |

Constants: `FORMAT`, `VERSION`, `SAMPLE_RATE`, `N_FFT`, `GROUP`, `HEADER_BITS`, `MAX_MSG_LEN`
(159 bytes), `SIG_LEN`, `NSYM`, and the profiles `WB` and `NB`.

### The verdict

```js
{
  verified: true, message: 'hello', message_hex: '68656c6c6f', message_bytes: Uint8Array,
  channel: 'phase' | 'magnitude', profile: 'wb' | 'nb', path: 'header' | 'search' | 'resync',
  rs_corrected: 0, payload_bits: 808, candidates_tried: 1, rs_passes: 1, sig_checks: 1,
  reason: 'ok',
}
```

When `verified` is false, the message fields are `null` and `reason` says what failed: no
candidate passed Reed-Solomon, or none had a consistent length, or none carried a valid
signature. A result found by resync also has `offset: {delta, f0, samples}`.

### Profiles and options

- `profile: 'wb'` (default): phase bins 60 to 299, magnitude bins 100 to 339.
- `profile: 'nb'`: the same phase bins, and magnitude bins 16 to 167, for audio band-limited to
  8 kHz such as telephone speech.
- `verify` tries both profiles unless one is given.
- `resync: true` also searches for a delay (a sample offset within a frame plus up to 10 whole
  frames).

## Demo site

```sh
npm ci
npm run dev        # http://127.0.0.1:5173
npm run build      # static site in dist/, relative paths
npm run preview    # serves dist/ on http://127.0.0.1:4173
```

The page runs the whole protocol on the real library, in a Web Worker, once on load and again on
each click: key generation, signing, attacks (head crop, tail crop, low-pass), blind verification
and three negative controls (wrong key, unsigned original, impostor). A diagram after Figure 1 of
the paper fills in with each run's numbers, and ten cards show the analysis of every stage.
**Sign your voice** records 20 s from the microphone and signs it the same way. Recording needs a
secure page (https or localhost).

Pushing to `main` builds the site and deploys it to GitHub Pages (`.github/workflows/pages.yml`).

## Tests

```sh
npm test           # unit, conformance-vector, pipeline and page tests
npm run smoke      # the built site in headless Chromium, or the pipeline in Node
npm run sweep      # every attack setting on the page, on every clip, with fresh keys
```

`npm test` needs nothing outside this repository. It covers MT19937, the layout, the FFT,
Reed-Solomon, Ed25519 (including the RFC 8032 vectors and the mixed-order case), the payload,
embedding, erasures, verification, resync, the official conformance vectors in `vectors/`
(a checked copy of the vectors in the Python reference), the demo pipeline and the page text.
`tests/oracle/` holds ground truth from an independent NumPy transcription of the format.

## Layout

```
src/lib/      the library (the package's only published code)
src/demo/     the protocol pipeline, attacks, Web Worker
src/ui/       the page: diagram, cards, charts, recorder, styles
public/       the three LibriSpeech clips and the NeurIPS logo
vectors/      apcaw-v1 conformance vectors
tests/        node:test suites and oracle data
scripts/      smoke.mjs and sweep.mjs
```

## Citation

```bibtex
@inproceedings{yang2026apc,
  title     = {Asymmetric Phase Coding Audio Watermarking},
  author    = {Yang, Guang and Liu, Fengchen and Ghasemian, Amir and Wang, Zhong and
               Mehrabi, Ninareh and Hosseinmardi, Homa},
  booktitle = {Advances in Neural Information Processing Systems (NeurIPS)},
  year      = {2026}
}
```

## Licenses

The code is under the BSD 2-Clause license, see [`LICENSE`](LICENSE). Copyright (c) 2026,
Guang Yang (guangyang19@ucla.edu). The clips come from LibriSpeech under CC BY 4.0, see
`public/media/ATTRIBUTION.txt`. The page bundles D3 (ISC). The library depends on
`@noble/ed25519` and `@noble/hashes` (MIT). The NeurIPS logo belongs to the NeurIPS Foundation.
