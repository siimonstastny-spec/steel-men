// Steel Mans – multiplayer transport factory (docs/MULTIPLAYER.md, "Transport").
//   const t = await createTransport()   // RoomTransport inside a claude.ai artifact, else P2PTransport (WebRTC)
//   t.kind ('room' | 'p2p' | 'broadcast'), t.selfId, await t.join(name) -> channel
//   channel: selfId, send(topic, data), on(topic, fn({from, data})) -> unsubscribe, peers() -> [{id, presence, isMe}],
//            onPeers(fn({peers, joined, left, updated})) -> unsubscribe, setPresence(obj), leave()
// URL ?net=broadcast forces the local transport (two tabs), ?net=p2p forces WebRTC (also inside an artifact / on
// localhost), ?net=room refuses any fallback. Without a parameter: room when available, else broadcast on
// localhost (dev), else p2p, else broadcast. Inside a claude.ai artifact without `room` there is NO fallback (null +
// getNetDiagnosis()); only ?net=p2p / ?net=broadcast force another transport there.
import { RoomTransport } from './RoomTransport.js';
import { BroadcastTransport } from './BroadcastTransport.js';
import { P2PTransport } from './P2PTransport.js';

export { RoomTransport, BroadcastTransport, P2PTransport };

function preferred() {
  try { return new URLSearchParams(globalThis.location?.search ?? '').get('net'); } catch { return null; }
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isLocalDev = () => LOCAL_HOSTS.has(globalThis.location?.hostname ?? '');

const broadcast = () => (BroadcastTransport.available() ? new BroadcastTransport() : null);

/** true inside a claude.ai artifact (the platform's `claude` runtime is present) */
export const inArtifact = () => typeof globalThis.claude?.use === 'function';

let lastDiagnosis = null;

/**
 * Diagnosis of the last createTransport() call (also on transport.diag):
 *   { inArtifact, room: 'ok'|'none'|'timeout'|'error:<code>'|'skipped', selfIdKnown, chosen: 'room'|'p2p'|'broadcast'|null,
 *     prefer, reason: null|'room-unavailable'|'artifact-no-room'|'no-transport',
 *     connected?, roomError? (RoomTransport, live), lastLeave?: {room, peers}, joinError? }
 * @returns {object|null}
 */
export function getNetDiagnosis() { return lastDiagnosis; }

/** Records what a join found: peers (others) seen in the room when we left it, and the join error code. */
function instrument(transport, diag) {
  const join = transport.join.bind(transport);
  transport.join = async (name) => {
    let ch;
    try { ch = await join(name); } catch (e) { diag.joinError = String(e?.code ?? e?.message ?? e); throw e; }
    if (!ch.diagWrapped) {
      ch.diagWrapped = true;
      const leave = ch.leave.bind(ch);
      ch.leave = () => {
        let peers = 0;
        try { peers = ch.peers().filter((p) => !p.isMe).length; } catch { /* already gone */ }
        diag.lastLeave = { room: name, peers };
        return leave();
      };
    }
    return ch;
  };
}

async function pickTransport(prefer, diag) {
  if (prefer === 'broadcast') { diag.room = 'skipped'; return broadcast(); }
  if (prefer === 'p2p') { diag.room = 'skipped'; return P2PTransport.create(); }
  const room = await RoomTransport.probe(diag);
  if (room) return room;
  // Inside a claude.ai artifact there is no silent fallback: WebRTC / BroadcastChannel would never meet a host that is on `room`
  if (prefer === 'room') { diag.reason = 'room-unavailable'; return null; }
  if (diag.inArtifact) { diag.reason = 'artifact-no-room'; return null; }
  if (isLocalDev()) return broadcast(); // dev/QA two-tab tests stay offline; ?net=p2p tests WebRTC
  return (await P2PTransport.create()) ?? broadcast();
}

/**
 * @param {{prefer?: 'room'|'p2p'|'broadcast'}} [opts]
 * @returns {Promise<RoomTransport|P2PTransport|BroadcastTransport|null>}  null = no multiplayer possible here
 *          (getNetDiagnosis() says why)
 */
export async function createTransport(opts = {}) {
  const prefer = opts.prefer ?? preferred();
  const diag = { inArtifact: inArtifact(), room: 'none', selfIdKnown: false, chosen: null, prefer: prefer ?? null, reason: null };
  lastDiagnosis = diag;
  let transport = null;
  try { transport = await pickTransport(prefer, diag); } catch (e) { diag.reason = `error:${e?.code ?? e?.message ?? e}`; }
  diag.chosen = transport?.kind ?? null;
  if (!transport && !diag.reason && prefer === 'p2p') { diag.reason = 'p2p-unavailable'; diag.p2pError = P2PTransport.lastError; }
  if (!transport && !diag.reason) diag.reason = 'no-transport';
  if (transport) { transport.diag = diag; instrument(transport, diag); }
  console.info('[net] transport', JSON.stringify(diag));
  return transport;
}
