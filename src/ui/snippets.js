/**
 * Code samples of the "Use the library" section. They are the single source for the page
 * and for tests/snippets.test.js, which runs the JavaScript sample as written.
 * @module ui/snippets
 */

export const SNIPPETS = Object.freeze([
  {
    id: 'js',
    title: 'JavaScript',
    note: 'Node 22 or any modern browser.',
    lang: 'js',
    code: `import { readFile } from 'node:fs/promises';
import { keygen, sign, verify, parseWav, mixToMono } from 'apcaw-js';
const { secretKey, publicKey } = keygen();
const { sampleRate, channels } = parseWav(await readFile('in.wav'));
const signed = sign(mixToMono(channels), sampleRate, secretKey, 'hello');
console.log(verify(signed, sampleRate, publicKey).message); // hello`,
  },
  {
    id: 'rust',
    title: 'Rust CLI',
    note: 'The apcaw command line.',
    lang: 'sh',
    code: `apcaw keygen --secret-out sk.key --public-out pk.key
apcaw sign -i in.wav -o signed.wav -k sk.key -m "hello"
apcaw verify -i signed.wav -p pk.key --json
# A copy delayed by padding in front: search time offsets
apcaw verify -i copy.wav -p pk.key --resync
# Exit code 0 means verified, 1 means not verified`,
  },
  {
    id: 'python',
    title: 'Python',
    note: 'The reference implementation.',
    lang: 'py',
    code: `from apcaw import keygen, sign, verify
from apcaw.io import read_audio
x, sr = read_audio("in.wav")
sk, pk = keygen()
y = sign(x, sr, sk, "hello")
print(verify(y, sr, pk).message.decode())  # hello`,
  },
]);
