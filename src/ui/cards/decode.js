/**
 * Card i (blind verification: the search, Reed-Solomon, Ed25519 and the message) and card j
 * (negative controls that must be rejected).
 * @module ui/cards/decode
 */

import { h, fig, readouts, showTip, hideTip } from '../dom.js';
import { C } from '../colors.js';
import { SIG_LEN, NSYM, hex, fmtInt, fmtMs } from '../format.js';

// Mirrors demo/stages.js CANDIDATE_CODES.
const CODES = [
  { name: 'duplicate of an earlier candidate', short: 'duplicate', color: C.line },
  { name: 'Reed-Solomon failed', short: 'RS failed', color: C.line2 },
  { name: 'RS passed, length inconsistent', short: 'length mismatch', color: C.faint },
  { name: 'RS and length passed, signature invalid', short: 'signature invalid', color: C.bad },
  { name: 'signature valid', short: 'accepted', color: C.ok },
];

const channelName = (c) => (c === 'phase' ? 'Phase' : c === 'magnitude' ? 'Magnitude' : String(c));
const profileName = (p) => (p === 'wb' ? 'wideband' : p === 'nb' ? 'narrowband' : String(p));

const check = () =>
  h('svg:svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' },
    h('svg:circle', { cx: 8, cy: 8, r: 7, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }),
    h('svg:path', { d: 'M4.8 8.3 7 10.4l4.3-4.6', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
const cross = () =>
  h('svg:svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': 'true' },
    h('svg:circle', { cx: 8, cy: 8, r: 7, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 }),
    h('svg:path', { d: 'M5.5 5.5l5 5M10.5 5.5l-5 5', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round' }));

function candidateRow(a, i) {
  const n = a.codes.length;
  const squares = h('div', { class: 'cands', role: 'img', 'aria-label': `${n} candidates, ${a.accepted ? 'one accepted' : 'none accepted'}` });
  for (let j = 0; j < n; j++) {
    const code = a.codes[j];
    const sq = h('span', { style: { background: CODES[code].color }, class: code === 4 ? 'win' : null });
    sq.addEventListener('pointermove', (ev) =>
      showTip(ev, `Candidate ${j + 1} of ${n}`, [
        ['message length', a.ms[j] < 0 ? 'none' : `${a.ms[j]} bytes`],
        ['source', j === 0 && a.headerFirst ? 'read from the header' : 'length search'],
        ['result', CODES[code].name],
      ]));
    sq.addEventListener('pointerleave', hideTip);
    squares.append(sq);
  }
  const sub = [
    `${fmtInt(a.capacity)} soft bits`,
    a.header_length ? `header says ${a.header_length} bits` : 'header unreadable',
    a.alignment ? `alignment ${a.alignment}` : null,
  ].filter(Boolean).join(', ');
  return h(
    'div',
    { class: 'attempt-row' },
    h('div', { class: `attempt-name${a.accepted ? ' win' : ''}` }, `${i + 1}. ${profileName(a.profile)}, ${a.channel}`, h('small', { text: sub })),
    squares,
  );
}

/** What the attacks left on each channel, in words: why nothing decoded. */
function whyNot(tr) {
  const parts = ['phase', 'magnitude'].map((id) => {
    const c = tr.attacked[id].combined;
    if (!c) return `the ${id} channel has no full copy of the payload left`;
    return `the ${id} channel is left with ${c.byteErrors} bad byte${c.byteErrors === 1 ? '' : 's'}`;
  });
  return `After the attacks, ${parts.join(' and ')}. Reed-Solomon repairs at most 15, and card h shows where the errors are.`;
}

export function renderDecode(body, run) {
  const v = run.verify;
  const r = v.result;
  const accepted = v.attempts.find((a) => a.accepted)?.accepted ?? null;
  const embedded = run.payload.payload;
  const same = accepted && hex(accepted.repaired) === hex(embedded);
  // Payload layout: be16 length, message, 64-byte signature, 30 parity bytes.
  const msgLen = accepted ? accepted.payload.length - 2 - SIG_LEN - NSYM : 0;
  const region = (i) => (i < 2 ? 'length' : i < 2 + msgLen ? 'message' : i < 2 + msgLen + SIG_LEN ? 'signature' : 'parity');

  body.append(
    h(
      'div',
      { class: 'card-text' },
      h('p', { text: 'Only the attacked audio and the public key go in. A candidate is accepted only if its Ed25519 signature verifies.' }),
    ),
  );
  body.append(
    r.verified
      ? h(
          'div',
          { class: 'verdict' },
          h('span', { class: 'seal' }, check(), 'Verified with the public key only'),
          h('div', { class: 'recovered' }, h('span', { class: 'lbl', text: 'Recovered message' }), h('q', { text: r.message })),
        )
      : h(
          'div',
          { class: 'verdict bad' },
          h('span', { class: 'seal' }, cross(), 'Not verified'),
          h('div', { class: 'recovered' }, h('span', { class: 'lbl', text: 'Reason' }), h('p', { class: 'reason-text', text: r.reason }), h('p', { class: 'reason-why', text: whyNot(v.transport) })),
        ),
  );

  const cols = h('div', { class: 'cols wide-left' });
  const search = fig('Candidates, in the order they were tried');
  for (const [i, a] of v.attempts.entries()) search.plot.append(candidateRow(a, i));
  if (!v.attempts.length) search.plot.append(h('p', { class: 'fig-cap', text: 'The file was too short for any channel to be read.' }));
  search.el.append(
    h('ul', { class: 'legend' }, CODES.map((c) => h('li', {}, h('span', { class: 'sw', style: { background: c.color } }), c.short))),
    h('p', { class: 'fig-cap', text: 'One square per candidate length. Hover for details.' }),
  );
  const side = h('div', {});
  const rs = fig('Reed-Solomon repairs');
  const gauge = h('div', { class: 'rsgauge', role: 'img', 'aria-label': `${r.rs_corrected ?? 0} of 15 correctable bytes used` });
  for (let i = 0; i < 15; i++) gauge.append(h('span', { class: i < (r.rs_corrected ?? 0) ? 'on' : null }));
  rs.plot.append(gauge);
  let rsCap = 'No candidate was accepted.';
  if (accepted) {
    rsCap = `${accepted.fixed.length} of 15 repairable bytes used.`;
  }
  rs.el.append(h('p', { class: 'fig-cap', text: rsCap }));
  side.append(rs.el);
  if (accepted) {
    const sg = fig('Ed25519 signature, recovered');
    const sigAt = 2 + msgLen;
    const fixed = new Set(accepted.fixed);
    sg.plot.append(h('p', { class: 'sighex' }, Array.from(accepted.signature, (b, j) => h('span', { class: fixed.has(sigAt + j) ? 'fix' : null, text: hex([b]) }))));
    sg.el.append(h('p', { class: 'fig-cap', text: same
      ? `Matches the embedded payload exactly.${accepted.fixed.some((i) => region(i) === 'signature') ? ' Highlighted bytes were repaired.' : ''}`
      : 'Still differs from the embedded payload.' }));
    side.append(sg.el);
  }
  cols.append(search.el, side);
  body.append(cols);
  body.append(
    readouts([
      ['Channel', r.verified ? channelName(r.channel) : 'none', r.verified ? 'ok' : 'bad'],
      ['Length from', r.path === 'header' ? 'header' : r.path === 'search' ? 'length search' : 'n/a'],
      ['RS corrected', r.rs_corrected == null ? 'n/a' : `${r.rs_corrected} of 15`],
      ['Payload bits', r.payload_bits == null ? 'n/a' : fmtInt(r.payload_bits)],
      ['Candidates', fmtInt(r.candidates_tried)],
      ['RS passes', fmtInt(r.rs_passes)],
      ['Signature checks', fmtInt(r.sig_checks)],
      ['Verify time', fmtMs(v.verifyMs)],
      v.resync ? ['Offset found', r.offset ? `${r.offset.samples} samples` : 'none'] : null,
    ]),
  );
}

export function renderControls(body, run) {
  const c = run.controls;
  const items = [
    { title: 'Wrong key', what: 'Checked with a key that did not sign it.', r: c.wrongKey },
    { title: 'Unsigned original', what: 'The unsigned original, same attacks.', r: c.unsigned },
    { title: 'Impostor', what: 'Another key signs, using this layout.', r: c.impostor },
  ];
  const rejected = items.filter((it) => !it.r.verified).length;
  body.append(
    h(
      'div',
      { class: 'card-text' },
      h('p', { text: 'Three files that must fail. A false accept would require forging Ed25519.' }),
    ),
  );
  const grid = h('div', { class: 'cols three' });
  for (const it of items) {
    const ok = !it.r.verified;
    grid.append(
      h(
        'div',
        { class: 'control' },
        h('h4', { text: it.title }),
        h('p', { class: 'what', text: it.what }),
        h('span', { class: `v${ok ? '' : ' bad'}` }, ok ? check() : cross(), ok ? 'Rejected' : 'Accepted'),
        h(
          'div',
          { class: 'counts' },
          h('div', {}, h('b', { text: fmtInt(it.r.candidates_tried) }), h('span', { text: 'candidates tried' })),
          h('div', {}, h('b', { text: fmtInt(it.r.rs_passes) }), h('span', { text: 'passed RS' })),
          h('div', {}, h('b', { text: fmtInt(it.r.sig_checks) }), h('span', { text: 'signatures checked' })),
        ),
        h('p', { class: 'reason', text: `${it.r.reason}. ${fmtMs(it.r.ms)}.` }),
      ),
    );
  }
  body.append(grid);
  if (c.unsigned.rs_passes > 0 || c.unsigned.sig_checks > 0) {
    body.append(
      h('p', { class: 'fig-cap note' },
        'Reed-Solomon accepted a word no one signed; the signature check rejected it.'),
    );
  }
  body.append(
    readouts([
      ['Rejected', `${rejected} of 3`, rejected === 3 ? 'ok' : 'bad'],
      ['Wrong key', `${c.wrongKey.publicKey.slice(0, 16)}...`],
      ['False accepts', String(3 - rejected), rejected === 3 ? null : 'bad'],
    ]),
  );
}
