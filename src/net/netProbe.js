// Steel Mans – network self-test for the lobby (diagnostics only, nothing is written anywhere):
//   const probe = startNetProbe({ transport })    // transport: the lobby's transport or null
//   const result = await probe.promise            // never rejects; probe.cancel() stops it and closes everything
// result = {
//   relays: { ok, total, blocked, timeout, other },   // signalling relays (relayCheck.js): open + EOSE; blocked = WebSocket
//                                                     //   could not even be constructed (CSP / security error)
//   webrtc: { state: 'ok'|'missing'|'blocked'|'error', host, srflx, relay, error? },  // srflx > 0 = STUN got through
//   db:     { state: 'ok'|'none'|'timeout'|'error:<code>' },   // claude.use('db') + one read of probe/x (never writes)
//   guest:  true|false|null|'n/a',                    // platform says: invited from outside the org (room only; null = unknown)
// }
// Everything has a timeout; sockets, RTCPeerConnection and timers are cleaned up on finish and on cancel().
import { NET } from '../config.js';
import { checkRelays } from './relayCheck.js';

const errText = (e) => String(e?.code ?? e?.name ?? e?.message ?? e).slice(0, 80);

async function probeRelays() {
  const list = await checkRelays();
  const out = { ok: 0, total: list.length, blocked: 0, timeout: 0, other: 0 };
  for (const r of list) {
    if (r.ok) out.ok++;
    else if (String(r.note).startsWith('bad url')) out.blocked++;
    else if (r.note === 'timeout') out.timeout++;
    else out.other++;
  }
  return out;
}

function probeWebRtc(timeoutMs, isCancelled, hooks) {
  if (typeof globalThis.RTCPeerConnection !== 'function') return Promise.resolve({ state: 'missing', host: 0, srflx: 0, relay: 0 });
  let pc;
  try {
    pc = new RTCPeerConnection({ iceServers: NET.p2p.stunUrls.map((urls) => ({ urls })) });
  } catch (e) {
    return Promise.resolve({ state: 'blocked', host: 0, srflx: 0, relay: 0, error: errText(e) });
  }
  return new Promise((resolve) => {
    const out = { state: 'ok', host: 0, srflx: 0, relay: 0 };
    let timer = null;
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { pc.onicecandidate = null; pc.close(); } catch { /* already closed */ }
      if (error) { out.state = 'error'; out.error = errText(error); }
      resolve(out);
    };
    hooks.push(() => finish()); // cancel() closes the connection at once
    timer = setTimeout(finish, timeoutMs); // gathering may never complete (STUN blocked): what we have is the answer
    pc.onicecandidate = (e) => {
      if (isCancelled()) { finish(); return; }
      if (!e.candidate) { finish(); return; } // gathering complete
      const type = e.candidate.type ?? /\styp\s(\w+)/.exec(e.candidate.candidate ?? '')?.[1];
      if (type === 'host') out.host++;
      else if (type === 'srflx') out.srflx++;
      else if (type === 'relay') out.relay++;
    };
    try {
      pc.createDataChannel('probe');
      pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(finish);
    } catch (e) { finish(e); }
  });
}

async function probeDb(timeoutMs) {
  const use = globalThis.claude?.use;
  if (typeof use !== 'function') return { state: 'none' };
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  try {
    const work = (async () => {
      const db = await use.call(globalThis.claude, 'db');
      if (!db || typeof db.doc !== 'function') return 'none';
      await db.doc('probe/x').get(); // read only; a missing document is not an error
      return 'ok';
    })();
    work.catch(() => {}); // a late rejection after the timeout must not become unhandled
    return { state: await Promise.race([work, timeout]) };
  } catch (e) {
    return { state: `error:${errText(e)}` };
  } finally { clearTimeout(timer); }
}

/** Starts the probe; the three network parts run in parallel */
export function startNetProbe({ transport = null } = {}) {
  let cancelled = false;
  const isCancelled = () => cancelled;
  const hooks = [];
  const guestOf = transport && typeof transport.selfGuest === 'function' ? transport.selfGuest() : 'n/a';
  const promise = Promise.all([
    probeRelays().catch((e) => ({ ok: 0, total: 0, blocked: 0, timeout: 0, other: 0, error: errText(e) })),
    probeWebRtc(NET.probe.iceMs, isCancelled, hooks),
    probeDb(NET.probe.dbMs),
  ]).then(([relays, webrtc, db]) => {
    const result = { relays, webrtc, db, guest: guestOf };
    console.info('[net] probe', JSON.stringify(result));
    return result;
  });
  return { promise, cancel() { cancelled = true; for (const h of hooks) h(); } };
}
