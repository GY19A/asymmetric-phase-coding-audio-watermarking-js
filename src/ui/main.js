/**
 * Page entry: settings, the run button, the protocol diagram, the story cards that unfold as
 * each stage reports, and the code samples. The protocol runs in demo/worker.js; this
 * module never loads the library, only its constants and the shared stage list.
 * @module ui/main
 */

import './style.css';

import { STAGES, DEFAULT_ATTACKS, DEFAULT_MESSAGE, CLIPS, PAGE_OPTIONS, PAGE_MSG_MAX, VOICE_SECONDS, VOICE_HEAD_MAX } from '../demo/stages.js';
import { h, copyButton, reducedMotion, hideTip } from './dom.js';
import { SAMPLE_RATE, fmtMs, utf8Length } from './format.js';
import { SNIPPETS } from './snippets.js';
import { startHero } from './hero.js';
import { createFlow } from './flow.js';
import { micSupported, startRecording, speechActivity } from './recorder.js';
import { renderIdentity } from './cards/identity.js';
import { renderPayload, renderLayout } from './cards/payload.js';
import { renderSpectra } from './cards/spectra.js';
import { renderPhase, renderMagnitude } from './cards/channels.js';
import { renderListen, stopAudio } from './cards/listen.js';
import { renderTransport } from './cards/transport.js';
import { renderDecode, renderControls } from './cards/decode.js';

const $ = (id) => document.getElementById(id);
const MAX_FILE_SECONDS = 30;
const REVEAL_MS = 180;

/**
 * The story, in reading order. `needs` lists the stages whose data the card draws; `ms` is
 * the stage whose worker time the card header shows.
 */
const CARDS = [
  { letter: 'a', stage: 'Identity', title: 'Ed25519 key pair', kind: 'crypto', needs: ['identity'], ms: 'identity', render: renderIdentity },
  { letter: 'b', stage: 'Payload', title: 'Message, signature, parity', kind: 'crypto', needs: ['payload', 'embed'], ms: 'payload', render: renderPayload },
  { letter: 'c', stage: 'Layout', title: 'Where each bit goes', kind: 'signal', needs: ['payload'], render: renderLayout },
  { letter: 'd', stage: 'Embedding', title: 'Spectrum before and after', kind: 'signal', needs: ['embed'], ms: 'embed', render: renderSpectra },
  { letter: 'e', stage: 'Phase channel', title: 'Bits on the phase poles', kind: 'signal', needs: ['embed'], render: renderPhase },
  { letter: 'f', stage: 'Magnitude channel', title: 'Quantization on a 1-nat lattice', kind: 'signal', needs: ['embed'], render: renderMagnitude },
  { letter: 'g', stage: 'Listening', title: 'Original, signed, attacked', kind: 'signal', needs: ['load', 'embed', 'attack'], ms: 'attack', render: renderListen },
  { letter: 'h', stage: 'Transport', title: 'What survives the attacks', kind: 'signal', needs: ['attack', 'verify'], render: renderTransport },
  { letter: 'i', stage: 'Decoding', title: 'Blind verification', kind: 'crypto', needs: ['verify'], ms: 'verify', render: renderDecode },
  { letter: 'j', stage: 'Negative controls', title: 'Three files that must fail', kind: 'crypto', needs: ['controls'], ms: 'controls', render: renderControls },
];

// ---------- worker ----------

let worker = null;
let onWorker = () => {};
let workerFailed = null;

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../demo/worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => onWorker(ev.data);
  worker.onerror = (ev) => {
    ev.preventDefault?.();
    workerFailed = ev.message || 'The worker could not start.';
    onWorker({ type: 'error', stage: null, message: workerFailed, name: 'WorkerError' });
    worker = null;
  };
  return worker;
}

// ---------- settings ----------

const form = $('settings-form');
const els = form.elements;
const field = (name) => els.namedItem(name);
let userFile = null;
let voice = null;
let voicePending = false;

const ATTACK_DEFAULT = {
  cropHead: DEFAULT_ATTACKS.cropHead.pct,
  cropTail: DEFAULT_ATTACKS.cropTail.pct,
  lowpass: DEFAULT_ATTACKS.lowpass.hz,
};

for (const [name, opts] of Object.entries(PAGE_OPTIONS)) {
  field(name).replaceChildren(...opts.map(([v, label]) => h('option', { value: String(v), text: label })));
}
$('msg-max').textContent = String(PAGE_MSG_MAX);

function fillForm() {
  for (const [name, v] of Object.entries(ATTACK_DEFAULT)) field(name).value = String(v);
}

function resetForm() {
  fillForm();
  field('clip').value = '0';
  $('message').value = DEFAULT_MESSAGE;
  syncForm();
}

function readAttacks() {
  const v = (name) => Number(field(name).value) || 0;
  const off = Object.fromEntries(Object.entries(DEFAULT_ATTACKS).map(([k, a]) => [k, { ...a, on: false }]));
  return {
    ...off,
    cropHead: { on: v('cropHead') > 0, pct: v('cropHead') },
    cropTail: { on: v('cropTail') > 0, pct: v('cropTail') },
    lowpass: { on: v('lowpass') > 0, hz: v('lowpass') },
  };
}

function readSource() {
  const v = field('clip').value;
  if (v === 'file' && userFile) return userFile.source;
  if (v === 'voice' && voice) return voice.source;
  const clip = CLIPS[Number(v)] ?? CLIPS[0];
  return { kind: 'url', url: new URL(`media/${clip.file}`, document.baseURI).href, name: clip.name };
}

function describe(a) {
  const out = [];
  if (a.cropHead.on) out.push(`head crop ${a.cropHead.pct}%`);
  if (a.cropTail.on) out.push(`tail crop ${a.cropTail.pct}%`);
  if (a.lowpass.on) out.push(`low-pass ${a.lowpass.hz / 1000} kHz`);
  return out.length ? out.join(', ') : 'none';
}

/** Refresh the summary line and the message counter; returns whether the form can run. */
function syncForm() {
  const v = field('clip').value;
  const isVoice = v === 'voice' && !!voice;
  const head = field('cropHead');
  for (const o of head.options) o.disabled = isVoice && Number(o.value) > VOICE_HEAD_MAX;
  if (isVoice && Number(head.value) > VOICE_HEAD_MAX) head.value = String(VOICE_HEAD_MAX);
  const a = readAttacks();
  const clip = v === 'file' && userFile ? userFile.name : v === 'voice' && voice ? 'your voice' : CLIPS[Number(v)]?.name.replace('LibriSpeech ', 'clip ') ?? 'clip';
  $('settings-summary').textContent = `${clip}; attacks: ${describe(a)}`;
  flow?.attacks(describe(a));
  const n = utf8Length($('message').value);
  const counter = $('msg-bytes');
  counter.textContent = String(n);
  counter.classList.toggle('bad', n > PAGE_MSG_MAX);
  return n <= PAGE_MSG_MAX;
}

form.addEventListener('input', syncForm);
form.addEventListener('change', syncForm);
form.addEventListener('submit', (ev) => ev.preventDefault());
$('reset').addEventListener('click', resetForm);

// ---------- your own file ----------

/** Channels, rate and length from a RIFF/WAVE header, without decoding the samples. */
function wavInfo(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12;
  let fmt = null;
  while (o + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ' && o + 24 <= bytes.length) {
      fmt = { channels: v.getUint16(o + 10, true), rate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    } else if (id === 'data' && fmt) {
      const frames = Math.min(size, bytes.length - o - 8) / ((fmt.bits / 8) * fmt.channels || 1);
      return { ...fmt, seconds: frames / fmt.rate };
    }
    o += 8 + size + (size & 1);
  }
  return null;
}

const isWav = (b) => b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WAVE';

async function loadFile(file) {
  const meta = $('file-meta');
  const name = $('file-name');
  name.textContent = file.name;
  meta.textContent = 'reading';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let info;
    if (isWav(bytes)) {
      const w = wavInfo(bytes);
      if (!w) throw new Error('This WAV file has no readable fmt and data chunks.');
      userFile = { name: file.name, source: { kind: 'wav', bytes, name: file.name } };
      info = `WAV, ${w.seconds.toFixed(1)} s, ${w.rate / 1000} kHz, ${w.channels === 1 ? 'mono' : `${w.channels} channels`}`;
    } else {
      // Decoded by this browser at 44.1 kHz; the worker mixes to mono.
      const ac = new OfflineAudioContext(1, 1, SAMPLE_RATE);
      const ab = await ac.decodeAudioData(bytes.buffer.slice(0));
      const n = Math.min(ab.length, MAX_FILE_SECONDS * ab.sampleRate);
      const channels = Array.from({ length: ab.numberOfChannels }, (_, c) => ab.getChannelData(c).slice(0, n));
      userFile = { name: file.name, source: { kind: 'pcm', channels, sampleRate: ab.sampleRate, name: file.name } };
      info = `decoded, ${ab.duration.toFixed(1)} s, ${ab.numberOfChannels === 1 ? 'mono' : `${ab.numberOfChannels} channels`}`;
    }
    meta.textContent = info;
    const radio = document.querySelector('input[name="clip"][value="file"]');
    radio.disabled = false;
    radio.checked = true;
    syncForm();
  } catch (e) {
    userFile = null;
    meta.textContent = `could not read: ${e?.message ?? e}`;
    const radio = document.querySelector('input[name="clip"][value="file"]');
    radio.disabled = true;
    if (radio.checked) field('clip').value = '0';
    syncForm();
  }
}

const drop = $('drop');
const fileInput = $('file-input');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener('change', () => fileInput.files[0] && loadFile(fileInput.files[0]));
for (const t of ['dragenter', 'dragover']) {
  drop.addEventListener(t, (ev) => {
    ev.preventDefault();
    drop.classList.add('over');
  });
}
for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('over'));
drop.addEventListener('drop', (ev) => {
  ev.preventDefault();
  const f = ev.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// ---------- diagram and status ----------

let flow = null;

function openCard(letter) {
  const c = cards.find((x) => x.letter === letter);
  if (!c?.shown) return;
  c.el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  c.el.querySelector('h3')?.focus({ preventScroll: true });
}

function status(parts, cls) {
  const el = $('tracker-status');
  el.replaceChildren(...parts.map((p) => (typeof p === 'string' ? p : h(p.tag ?? 'strong', { class: p.cls ?? cls, text: p.text }))));
}

const say = (text) => {
  $('live').textContent = text;
};

// ---------- story ----------

let cards = [];
let data = {};
let pumping = false;
let finished = null;

function buildStory() {
  const story = $('story');
  story.replaceChildren();
  cards = CARDS.map((c) => {
    const body = h('div', { class: 'card-body' });
    const ms = h('span', { class: 'card-ms' });
    const el = h(
      'article',
      { class: 'card', dataset: { state: 'idle', kind: c.kind }, 'aria-labelledby': `card-${c.letter}-title` },
      h(
        'header',
        { class: 'card-head' },
        h('span', { class: 'card-letter', 'aria-hidden': 'true', text: c.letter }),
        h('div', {}, h('p', { class: 'card-stage', text: c.stage }), h('h3', { id: `card-${c.letter}-title`, text: c.title, tabindex: '-1' })),
        ms,
      ),
      h('div', { class: 'card-fold' }, body),
    );
    story.append(el);
    return { ...c, el, body, msEl: ms, shown: false };
  });
}

function markPending(stageId) {
  for (const c of cards) if (!c.shown && c.needs.includes(stageId) && c.el.dataset.state === 'idle') c.el.dataset.state = 'pending';
}

/** Open the next card whose data has arrived, in reading order, one every REVEAL_MS. */
function pump() {
  if (pumping) return;
  const next = cards.find((c) => !c.shown);
  if (!next) {
    finished?.();
    return;
  }
  if (!next.needs.every((id) => data[id])) return;
  pumping = true;
  next.shown = true;
  try {
    next.render(next.body, data);
  } catch (e) {
    console.error(e);
    next.body.replaceChildren(h('p', { class: 'fig-cap', text: `This card could not be drawn: ${e?.message ?? e}` }));
  }
  if (next.ms && data[next.ms]) next.msEl.textContent = fmtMs(data[next.ms].ms);
  requestAnimationFrame(() => {
    next.el.dataset.state = 'open';
  });
  setTimeout(() => {
    pumping = false;
    pump();
  }, reducedMotion() ? 0 : REVEAL_MS);
}

// ---------- run ----------

const runBtn = $('run-btn');
const runBtn2 = $('run-btn-2');
const runLabel = runBtn.querySelector('.run-label');
let busy = false;

function showError(stage, message) {
  const box = $('run-error');
  const label = STAGES.find((s) => s.id === stage)?.label;
  box.replaceChildren(h('strong', { text: label ? `${label} failed. ` : 'The run failed. ' }), message);
  box.hidden = false;
}

function endRun() {
  busy = false;
  for (const b of [runBtn, runBtn2]) {
    b.removeAttribute('aria-busy');
    b.removeAttribute('aria-disabled');
  }
  runLabel.textContent = 'Run again';
  runBtn2.textContent = 'Run again';
  if (voicePending) {
    voicePending = false;
    setTimeout(() => run(), 0);
  }
}

function run({ scroll = true } = {}) {
  if (busy) return;
  if (!syncForm()) {
    $('settings').open = true;
    $('message').focus();
    return;
  }
  const cfg = {
    source: readSource(),
    message: $('message').value,
    profile: 'wb',
    attacks: readAttacks(),
    resync: false,
  };
  const fromVoice = field('clip').value === 'voice' && !!voice;
  let w;
  try {
    w = getWorker();
  } catch (e) {
    showError(null, `The worker could not start: ${e?.message ?? e}`);
    return;
  }
  busy = true;
  for (const b of [runBtn, runBtn2]) {
    b.setAttribute('aria-busy', 'true');
    b.setAttribute('aria-disabled', 'true');
  }
  runLabel.textContent = 'Running';
  runBtn2.textContent = 'Running';
  stopAudio();
  hideTip();
  data = {};
  pumping = false;
  finished = null;
  $('run-error').hidden = true;
  flow.reset();
  buildStory();
  status(['Starting.']);
  if (scroll) $('protocol').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  const t0 = performance.now();

  onWorker = (msg) => {
    if (msg.type === 'stage') {
      const label = STAGES.find((s) => s.id === msg.id)?.label ?? msg.id;
      if (msg.state === 'start') {
        flow.start(msg.id);
        markPending(msg.id);
        status([`${label}.`]);
        say(`${label}.`);
      } else {
        flow.done(msg.id, msg.data);
        data[msg.id] = msg.data;
        say(`${label}: done in ${fmtMs(msg.data.ms)}.`);
        pump();
      }
    } else if (msg.type === 'done') {
      const total = performance.now() - t0;
      const r = msg.result;
      status(
        r.verified
          ? [{ text: 'Verified', cls: 'ok' }, ` with the public key alone, from the ${r.channel} channel, in ${fmtMs(total)}.`]
          : [{ text: 'Not verified', cls: 'bad' }, `: ${r.reason}.`],
      );
      say(r.verified ? `Verified with the public key alone. Recovered message: ${r.message}` : `Not verified: ${r.reason}`);
      if (fromVoice) {
        recSay(r.verified
          ? 'Your voice is signed and verified with the public key alone. The diagram and cards below show your recording; card g lets you play and download it.'
          : `This recording did not verify (${r.reason}). Try again in a quieter place, speaking steadily.`, !r.verified);
      }
      finished = () => {
        finished = null;
        endRun();
      };
      pump();
    } else if (msg.type === 'error') {
      if (msg.stage) flow.fail(msg.stage);
      for (const c of cards) if (!c.shown) c.el.dataset.state = 'idle';
      status([{ text: 'Stopped', cls: 'bad' }, ` after ${fmtMs(performance.now() - t0)}.`]);
      say(`The run stopped: ${msg.message}`);
      showError(msg.stage, msg.message);
      endRun();
    }
  };
  w.postMessage({ type: 'run', cfg });
}

runBtn.addEventListener('click', () => run());
runBtn2.addEventListener('click', () => run());

// ---------- sign your voice ----------

const recEl = $('rec');
const recBtn = $('rec-btn');
const recLabel = $('rec-btn-label');
const recStatus = $('rec-status');
const voiceBtn = $('voice-btn');
let recording = null;
$('rec-target').textContent = String(VOICE_SECONDS);

function recSay(text, bad = false) {
  recStatus.textContent = text;
  recStatus.classList.toggle('bad', bad);
}

function setRecState(s) {
  recEl.dataset.state = s;
  recLabel.textContent = s === 'recording' ? 'Cancel' : voice ? 'Record again' : 'Start recording';
  if (s !== 'recording') $('rec-level').style.width = '0';
}

function openRec(open) {
  recEl.hidden = !open;
  voiceBtn.setAttribute('aria-expanded', String(open));
  if (!open) {
    cancelRec();
    return;
  }
  if (!micSupported()) {
    recBtn.disabled = true;
    recSay(window.isSecureContext ? 'This browser cannot record audio.' : 'Recording needs a secure page (https).', true);
  }
  recEl.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
}

async function startRec() {
  recBtn.disabled = true;
  recSay('Allow microphone access when your browser asks.');
  try {
    recording = await startRecording({
      maxSeconds: VOICE_SECONDS,
      onTick: ({ seconds, levelDb }) => {
        $('rec-time').textContent = `${seconds.toFixed(1)} / ${VOICE_SECONDS} s`;
        $('rec-level').style.width = `${Math.max(0, Math.min(100, ((levelDb + 60) / 60) * 100))}%`;
      },
      onAutoStop: finishRec,
    });
  } catch (e) {
    recording = null;
    recBtn.disabled = false;
    const why = {
      NotAllowedError: 'Microphone access was blocked. Allow it from the address bar and try again.',
      NotFoundError: 'No microphone was found.',
      NotReadableError: 'The microphone is in use by another app.',
    }[e?.name] ?? `The microphone could not start: ${e?.message ?? e}`;
    recSay(why, true);
    return;
  }
  recBtn.disabled = false;
  setRecState('recording');
  recSay(`Recording. It stops by itself at ${VOICE_SECONDS} s.`);
}

function cancelRec() {
  if (!recording) return;
  recording.cancel();
  recording = null;
  $('rec-time').textContent = `0.0 / ${VOICE_SECONDS} s`;
  setRecState('idle');
  recSay('Recording cancelled. Nothing was kept.');
}

function finishRec() {
  if (!recording) return;
  const { samples, sampleRate } = recording.stop();
  recording = null;
  const act = speechActivity(samples, sampleRate);
  if (act.levelDb < -45 || act.active < 0.25) {
    setRecState('idle');
    recSay('Not enough speech came through. Check the microphone, move closer and try again.', true);
    return;
  }
  voice = { source: { kind: 'pcm', channels: [samples], sampleRate, name: 'Your voice' } };
  $('voice-meta').textContent = `${Math.round(samples.length / sampleRate)} s from your microphone`;
  $('clip-voice').hidden = false;
  field('clip').value = 'voice';
  syncForm();
  setRecState('done');
  recSay('Recorded. Signing it now with a fresh key, then attacking and verifying it.');
  if (busy) voicePending = true;
  else run();
}

voiceBtn.addEventListener('click', () => openRec(recEl.hidden));
$('rec-close').addEventListener('click', () => openRec(false));
recBtn.addEventListener('click', () => (recording ? cancelRec() : startRec()));
$('rec-time').textContent = `0.0 / ${VOICE_SECONDS} s`;

// ---------- code samples ----------

const RULES = {
  js: [
    [/\/\/.*/y, 'tok-c'],
    [/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/y, 'tok-s'],
    [/\b(?:import|from|const|let|await|async|new|return|export)\b/y, 'tok-k'],
    [/[A-Za-z_$][\w$]*(?=\()/y, 'tok-f'],
    [/[A-Za-z_$][\w$]*/y, null],
  ],
  py: [
    [/#.*/y, 'tok-c'],
    [/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/y, 'tok-s'],
    [/\b(?:import|from|def|return|as)\b/y, 'tok-k'],
    [/[A-Za-z_]\w*(?=\()/y, 'tok-f'],
    [/[A-Za-z_]\w*/y, null],
  ],
  sh: [
    [/#.*/y, 'tok-c'],
    [/'[^']*'|"(?:[^"\\]|\\.)*"/y, 'tok-s'],
    [/(?<=^|\s)--?[A-Za-z][\w-]*/y, 'tok-k'],
    [/^[a-z][\w-]*/y, 'tok-f'],
    [/[^\s'"#-]+/y, null],
  ],
};

/** Syntax coloring as DOM nodes; no innerHTML. */
function highlight(code, lang) {
  const rules = RULES[lang] ?? [];
  const out = [];
  code.split('\n').forEach((line, li) => {
    if (li) out.push('\n');
    let i = 0;
    let plain = '';
    while (i < line.length) {
      let hit = null;
      for (const [re, cls] of rules) {
        re.lastIndex = i;
        const m = re.exec(line);
        if (m && m[0].length) {
          hit = [m[0], cls];
          break;
        }
      }
      if (!hit) {
        plain += line[i++];
        continue;
      }
      if (hit[1]) {
        if (plain) out.push(plain);
        plain = '';
        out.push(h('span', { class: hit[1], text: hit[0] }));
      } else {
        plain += hit[0];
      }
      i += hit[0].length;
    }
    if (plain) out.push(plain);
  });
  return out;
}

function renderSnippets() {
  $('snippets').replaceChildren(
    ...SNIPPETS.map((s) =>
      h(
        'article',
        { class: 'snippet' },
        h('div', { class: 'snippet-head' }, h('h3', { text: s.title }), copyButton(() => s.code)),
        h('pre', {}, h('code', { class: `lang-${s.lang}` }, highlight(s.code, s.lang))),
        h('p', { class: 'note', text: s.note }),
      ),
    ),
  );
}

// ---------- start ----------

$('message').value = DEFAULT_MESSAGE;
fillForm();
flow = createFlow($('flow'), { onOpen: openCard });
renderSnippets();
syncForm();
startHero($('hero-field'));
// One run on every load, so the diagram and cards are filled in before anyone clicks.
requestAnimationFrame(() => run({ scroll: false }));
