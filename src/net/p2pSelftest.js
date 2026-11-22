// Steel Mans – self-test of the P2PTransport adapter without a network: a fake Trystero library (in-memory rooms,
// data delivered on microtasks) drives two transports. Checks the transport interface of docs/MULTIPLAYER.md:
// selfId / isMe, joined + presence for newcomers, presence updates, no own echo, topic delivery, size limit,
// left on leave(), no handlers after leave(), and the relay timeout ending in a P2PError (no hanging join).
//
// In the browser console (game page open, any state):
//   await (await import('./src/net/p2pSelftest.js')).runP2PSelftest()
// Returns { ok, problems } and prints the result.
import { NET } from '../config.js';
import { P2PTransport, P2PError, P2P_ERROR } from './transports/P2PTransport.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** In-memory stand-in for vendor/trystero/nostr.mjs (only what P2PTransport uses) */
function makeFakeNet() {
  const rooms = new Map(); // roomId -> Map(selfId -> fake room)
  const state = { relayOpen: true };

  function makeLib(selfId) {
    return {
      selfId,
      getRelaySockets: () => (state.relayOpen ? { 'wss://fake': { readyState: 1 } } : {}),
      joinRoom(config, roomId) {
        if (!config?.appId) throw new Error('fake: appId missing');
        const members = rooms.get(roomId) ?? new Map();
        rooms.set(roomId, members);
        const room = {
          actions: new Map(),
          connected: new Set(),
          joinHandler: null,
          onPeerLeave: null,
          left: false,
          makeAction(type) {
            if (room.actions.has(type)) return room.actions.get(type);
            const action = {
              onMessage: null,
              send(data, opts) {
                const json = JSON.stringify(data);
                const targets = opts?.target ? [opts.target] : [...room.connected];
                for (const id of targets) {
                  const other = members.get(id);
                  queueMicrotask(() => {
                    const fn = other?.actions.get(type)?.onMessage;
                    if (fn && !other.left) fn(JSON.parse(json), { peerId: selfId });
                  });
                }
                return Promise.resolve();
              },
            };
            room.actions.set(type, action);
            return action;
          },
          set onPeerJoin(fn) { room.joinHandler = fn; if (fn) for (const id of room.connected) fn(id); },
          get onPeerJoin() { return room.joinHandler; },
          leave() {
            room.left = true;
            members.delete(selfId);
            for (const id of room.connected) {
              const other = members.get(id);
              if (!other) continue;
              other.connected.delete(selfId);
              queueMicrotask(() => other.onPeerLeave?.(selfId));
            }
            room.connected.clear();
            return Promise.resolve();
          },
        };
        for (const [id, other] of members) {
          queueMicrotask(() => {
            if (room.left || other.left) return;
            room.connected.add(id); other.connected.add(selfId);
            room.joinHandler?.(id); other.joinHandler?.(selfId);
          });
        }
        members.set(selfId, room);
        return room;
      },
    };
  }
  return { makeLib, state, rooms };
}

export async function runP2PSelftest() {
  const problems = [];
  const check = (cond, what) => { if (!cond) problems.push(what); };
  const fake = makeFakeNet();
  const ta = new P2PTransport(fake.makeLib('peerA'));
  const tb = new P2PTransport(fake.makeLib('peerB'));
  const name = NET.roomPrefix + 'test1';
  const savedTimeout = NET.p2p.relayTimeoutMs;
  try {
    check(ta.kind === 'p2p' && ta.selfId === 'peerA', 'kind / selfId');

    const a = await ta.join(name);
    check((await ta.join(name)) === a, 'second join of the same name returns the same channel');
    const peerEventsA = [];
    a.onPeers((c) => peerEventsA.push(c));
    await a.setPresence({ nick: 'Alice', seat: 0 });
    const gotA = [];
    a.on('lobby', (m) => gotA.push(m));

    const b = await tb.join(name);
    const gotB = [];
    b.on('lobby', (m) => gotB.push(m));
    await settle();

    const selfA = a.peers().find((p) => p.isMe);
    check(selfA?.id === 'peerA' && selfA.presence.nick === 'Alice', 'own peer listed with isMe and presence');
    check(peerEventsA.some((c) => c.joined.some((p) => p.id === 'peerB')), 'A sees B joined');
    const aSeenByB = b.peers().find((p) => p.id === 'peerA');
    check(aSeenByB && !aSeenByB.isMe && aSeenByB.presence.nick === 'Alice', 'newcomer B receives A\'s presence');

    await b.setPresence({ nick: 'Bob' });
    await settle();
    check(a.peers().find((p) => p.id === 'peerB')?.presence.nick === 'Bob', 'presence update reaches A');
    check(peerEventsA.some((c) => c.updated.some((p) => p.id === 'peerB' && p.presence.nick === 'Bob')), 'A gets updated event');
    await b.setPresence({ nick: null });
    await settle();
    check(!('nick' in (a.peers().find((p) => p.id === 'peerB')?.presence ?? {})), 'presence key deleted with null');

    a.send('lobby', { op: 'hello', n: 1 });
    await settle();
    check(gotB.length === 1 && gotB[0].from === 'peerA' && gotB[0].data.n === 1, 'topic message delivered with from');
    check(gotA.length === 0, 'no echo of own message');

    a.send('lobby', { pad: 'x'.repeat(NET.maxMessageBytes) });
    await settle();
    check(gotB.length === 1, 'message over NET.maxMessageBytes refused');

    check(a.connected() && b.connected(), 'connected()');

    await b.leave();
    await settle();
    check(!a.peers().some((p) => p.id === 'peerB'), 'B removed from A after leave');
    check(peerEventsA.some((c) => c.left.some((p) => p.id === 'peerB')), 'A gets left event');
    check(!tb.rooms.has(name) && !b.connected(), 'B channel closed and forgotten');
    b.send('lobby', { late: true });
    await settle();
    check(gotA.length === 0, 'closed channel sends nothing');

    // relay timeout: join must reject with a P2PError, not hang
    NET.p2p.relayTimeoutMs = 300;
    fake.state.relayOpen = false;
    const tc = new P2PTransport(fake.makeLib('peerC'));
    let err = null;
    try { await tc.join(NET.roomPrefix + 'test2'); } catch (e) { err = e; }
    check(err instanceof P2PError && err.i18nKey === P2P_ERROR.relays && !!err.message, 'relay timeout → P2PError net.p2p.error.relays');
    check(!fake.rooms.get(NET.roomPrefix + 'test2')?.has('peerC'), 'timed-out room left');

    await a.leave();
  } catch (e) {
    problems.push(String(e?.stack ?? e));
  } finally {
    NET.p2p.relayTimeoutMs = savedTimeout;
    fake.state.relayOpen = true;
  }
  const ok = problems.length === 0;
  console.log(ok ? '[p2p selftest] ALL PASSED' : '[p2p selftest] FAILED', problems);
  return { ok, problems };
}
