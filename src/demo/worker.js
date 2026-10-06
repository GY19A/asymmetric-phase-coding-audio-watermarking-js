/**
 * Web Worker: runs the protocol off the main thread and streams each stage's data back.
 * Messages in: {type: 'run', cfg} and {type: 'probe'}. Messages out: {type: 'stage', id,
 * state, data}, {type: 'done', result}, {type: 'error', stage, message}, {type: 'caps', opus}.
 */

import { runProtocol } from './pipeline.js';
import { opusSupported, opusRoundTrip } from './codec.js';

let current = null;

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'probe') {
    self.postMessage({ type: 'caps', opus: await opusSupported(msg.bitrate) });
    return;
  }
  if (msg.type !== 'run') return;
  current = null;
  try {
    const codec = (await opusSupported(msg.cfg.attacks?.codec?.bitrate)) ? opusRoundTrip : undefined;
    const rep = await runProtocol(msg.cfg, {
      codec,
      onStage: (id, state, data) => {
        current = id;
        self.postMessage({ type: 'stage', id, state, data });
      },
    });
    self.postMessage({ type: 'done', result: rep.result });
  } catch (e) {
    self.postMessage({ type: 'error', stage: current, message: String(e?.message ?? e), name: e?.name ?? 'Error' });
  }
};
