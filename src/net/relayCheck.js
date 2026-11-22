// Steel Mans – console check of the signalling relays (NET.p2p.relayUrls). Not used by the game.
//   const { checkRelays } = await import('./src/net/relayCheck.js');
//   console.table(await checkRelays());   // [{ url, ok, ms, note }]
// A relay is OK when its WebSocket opens and it answers a REQ with EOSE within NET.p2p.relayCheckTimeoutMs.
import { NET } from '../config.js';

const SUB_ID = 'sm-relay-check';

function checkOne(url, timeoutMs) {
  return new Promise((resolve) => {
    const started = performance.now();
    let ws;
    let done = false;
    const finish = (ok, note) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closed */ }
      resolve({ url, ok, ms: Math.round(performance.now() - started), note });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    try { ws = new WebSocket(url); } catch (e) { finish(false, `bad url: ${e?.message ?? e}`); return; }
    ws.onerror = () => finish(false, 'socket error');
    ws.onclose = () => finish(false, 'closed');
    ws.onopen = () => ws.send(JSON.stringify(['REQ', SUB_ID, { kinds: [NET.p2p.relayCheckKind], limit: 1 }]));
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg?.[0] === 'EOSE') finish(true, 'ok');
      else if (msg?.[0] === 'CLOSED') finish(false, `CLOSED: ${msg[2] ?? ''}`);
    };
  });
}

/** Checks all relays in parallel; `urls` defaults to NET.p2p.relayUrls */
export function checkRelays(urls = NET.p2p.relayUrls, timeoutMs = NET.p2p.relayCheckTimeoutMs) {
  return Promise.all(urls.map((u) => checkOne(u, timeoutMs)));
}
