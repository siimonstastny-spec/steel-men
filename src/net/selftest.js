// Steel Mans – lockstep self-test without a browser page, server or real network. Two Lockstep instances talk over
// a fake channel with deterministic loss, latency and reordering and a manual clock; fake world + fake CommandBus.
// Checks: both clients execute the same commands at the same ticks in the same order, no command is lost
// (resends repair dropped messages), big turns are split under the size limit, a corrupted hash is detected.
//
// In the browser console (game page open, any state):
//   (await import('./src/net/selftest.js')).runNetSelftest()
// Returns { ok, results: [...] } and prints a table.
import { NET, NET_LEAVE } from '../config.js';
import { Lockstep } from './Lockstep.js';

const STEP_MS = 1000 / 30;
const encoder = new TextEncoder();

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv(str, h = 0x811c9dc5) {
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** Same ordering contract as src/game/commands/CommandBus.js (team, then enqueue order) */
class FakeBus {
  constructor() {
    this.pending = [];
    this.seq = 0;
    this.log = [];
    this.clientId = 'local';
    this.schedule = (cmd) => this.enqueue(1, cmd);
  }
  submit(cmd) { this.schedule({ ...cmd, origin: this.clientId }); }
  enqueue(tick, cmd) { this.pending.push({ tick, seq: this.seq++, cmd }); }
  executeTick(tick) {
    const due = this.pending.filter((p) => p.tick <= tick);
    this.pending = this.pending.filter((p) => p.tick > tick);
    due.sort((a, b) => a.cmd.team - b.cmd.team || a.seq - b.seq);
    for (const { cmd } of due) this.log.push({ tick, cmd });
    return due.map((d) => d.cmd);
  }
}

class FakeWorld {
  constructor() { this.tick = 0; this.waitForSpawns = false; this.acc = 1; this.corruptFrom = Infinity; this.match = { eliminated: new Set(), disconnected: new Set(), result: null }; }
  stateHash() { return this.tick >= this.corruptFrom ? (this.acc ^ 0xdead) >>> 0 : this.acc; }
}

class FakeNet {
  constructor({ drop, latency, jitter, seed }) {
    this.drop = drop; this.latency = latency; this.jitter = jitter;
    this.rng = mulberry32(seed);
    this.time = 0;
    this.queue = [];
    this.channels = [];
    this.stats = { sent: 0, dropped: 0, oversize: 0, maxBytes: 0 };
    this.blocked = new Set();      // [MP-LEAVE] 'from>to' pairs whose messages are lost
    this.peerListeners = new Set();
  }
  /** [MP-LEAVE] a client closes its tab: gone from every peer list, its later messages are not delivered */
  remove(ch) {
    this.channels = this.channels.filter((c) => c !== ch);
    this.queue = this.queue.filter((m) => m.to !== ch);
    for (const fn of [...this.peerListeners]) fn();
  }
  channel(id) {
    const net = this;
    const handlers = new Map();
    const ch = {
      selfId: id,
      send(topic, data) {
        const text = JSON.stringify(data);
        const bytes = encoder.encode(text).length;
        net.stats.sent++;
        net.stats.maxBytes = Math.max(net.stats.maxBytes, bytes);
        if (bytes > NET.maxMessageBytes) { net.stats.oversize++; return; }
        if (!net.channels.includes(ch)) return; // left
        for (const other of net.channels) {
          if (other === ch) continue;
          if (net.blocked.has(`${id}>${other.selfId}`)) { net.stats.dropped++; continue; }
          if (net.rng() < net.drop) { net.stats.dropped++; continue; }
          const at = net.time + net.latency + net.rng() * net.jitter;
          net.queue.push({ at, to: other, topic, from: id, data: JSON.parse(text) });
        }
      },
      on(topic, fn) {
        if (!handlers.has(topic)) handlers.set(topic, new Set());
        handlers.get(topic).add(fn);
        return () => handlers.get(topic).delete(fn);
      },
      peers() { return net.channels.map((c) => ({ id: c.selfId, presence: {}, isMe: c === ch })); },
      onPeers(fn) { net.peerListeners.add(fn); return () => net.peerListeners.delete(fn); },
      setPresence() { return Promise.resolve(); },
      leave() { return Promise.resolve(); },
      _deliver(m) { for (const fn of [...(handlers.get(m.topic) ?? [])]) fn({ from: m.from, data: m.data }); },
    };
    this.channels.push(ch);
    return ch;
  }
  deliver() {
    const due = this.queue.filter((m) => m.at <= this.time).sort((a, b) => a.at - b.at);
    this.queue = this.queue.filter((m) => m.at > this.time);
    for (const m of due) m.to._deliver(m);
  }
}

/**
 * One scenario: two players, random commands, optional burst (forces split messages), optional corrupted hash.
 * @returns {{name, ok, problems: string[], ...}}
 */
function runScenario({ name, drop = 0, latency = 0, jitter = 0, seed = 1, ticks = 600, burstAtTick = -1, slowB = 1, corruptBAt = Infinity }) {
  const net = new FakeNet({ drop, latency, jitter, seed });
  const rng = mulberry32(seed * 7919);
  const players = [{ team: 0, playerId: 'A' }, { team: 1, playerId: 'B' }];
  const config = { hashEveryTurns: 5 };
  const clients = ['A', 'B'].map((id, team) => {
    const channel = net.channel(id);
    const world = new FakeWorld();
    const bus = new FakeBus();
    const ls = new Lockstep({ channel, world, commandBus: bus, players, localTeam: team, hostId: 'A', timers: false, now: () => net.time, config });
    return { id, team, world, bus, ls, submitted: 0, burstDone: false, stalls: 0 };
  });
  clients[1].world.corruptFrom = corruptBAt;
  for (const c of clients) c.ls.start();

  const stopSubmitAt = ticks - 60; // late commands would run after the end
  const maxSteps = ticks * 20;
  let steps = 0;
  while (clients.some((c) => c.world.tick < ticks) && steps++ < maxSteps) {
    net.time += STEP_MS;
    for (const c of clients) {
      if (c.team === 1 && rng() > slowB) continue; // B is a slower machine: skips frames
      if (c.world.tick < stopSubmitAt) {
        if (rng() < 0.15) { c.bus.submit({ type: 'test', team: c.team, n: c.submitted++ }); }
        if (c.world.tick >= burstAtTick && burstAtTick >= 0 && !c.burstDone) {
          c.burstDone = true;
          const pad = 'x'.repeat(700);
          for (let i = 0; i < 14; i++) c.bus.submit({ type: 'big', team: c.team, n: c.submitted++, pad });
        }
      }
      if (c.world.tick < ticks) {
        if (c.ls.canAdvance(c.world.tick + 1)) {
          const tick = c.world.tick + 1;
          const done = c.bus.executeTick(tick);
          c.world.tick = tick;
          c.world.acc = fnv(`${tick}|${JSON.stringify(done.map((d) => [d.team, d.type, d.n]))}`, c.world.acc);
          c.ls.onTick(tick);
        } else c.stalls++;
      }
      c.ls.pump(net.time);
    }
    net.deliver();
  }

  const problems = [];
  const [A, B] = clients;
  const logOf = (c) => c.bus.log.map((e) => `${e.tick}:${e.cmd.team}:${e.cmd.type}:${e.cmd.n}`);
  const la = logOf(A);
  const lb = logOf(B);
  if (A.world.tick < ticks || B.world.tick < ticks) problems.push(`did not finish: A ${A.world.tick}, B ${B.world.tick} / ${ticks}`);
  if (la.join() !== lb.join()) {
    const i = la.findIndex((x, k) => x !== lb[k]);
    problems.push(`command logs differ at #${i}: A ${la[i]} vs B ${lb[i]}`);
  }
  const executed = (c, team) => c.bus.log.filter((e) => e.cmd.team === team).length;
  for (const c of clients) {
    for (const other of clients) {
      if (executed(other, c.team) !== c.submitted) problems.push(`${other.id} executed ${executed(other, c.team)} of ${c.submitted} commands of team ${c.team}`);
    }
  }
  // order inside a tick: team ascending
  for (let i = 1; i < A.bus.log.length; i++) {
    const p = A.bus.log[i - 1];
    const q = A.bus.log[i];
    if (p.tick === q.tick && p.cmd.team > q.cmd.team) { problems.push(`tick ${q.tick}: team order broken`); break; }
  }
  // origin = the real sender on both sides
  if (B.bus.log.some((e) => e.cmd.team === 0 && e.cmd.origin !== 'A')) problems.push('remote origin not the sender');
  if (net.stats.oversize) problems.push(`${net.stats.oversize} oversize messages`);
  const expectDesync = corruptBAt < ticks;
  const desync = !!(A.ls.status.desync || B.ls.status.desync);
  if (desync !== expectDesync) problems.push(expectDesync ? 'corrupted hash NOT detected' : `false desync ${JSON.stringify(A.ls.status.desync || B.ls.status.desync)}`);
  if (expectDesync) problems.splice(0, problems.length, ...problems.filter((p) => p.startsWith('corrupted'))); // logs equal is all that matters there
  for (const c of clients) c.ls.stop();
  const seconds = net.time / 1000;
  return {
    name,
    ok: problems.length === 0,
    problems,
    ticks: `${A.world.tick}/${B.world.tick}`,
    commands: la.length,
    msgsPerSecPerClient: +(net.stats.sent / 2 / seconds).toFixed(1),
    dropped: net.stats.dropped,
    maxBytes: net.stats.maxBytes,
    realTimeS: +seconds.toFixed(1),
    stallsA: A.stalls,
    stallsB: B.stalls,
    pingA: A.ls.status.ping,
  };
}

/**
 * [MP-LEAVE] A player closes its tab during the match. ids[0] is the host. Options:
 *   leaveId / leaveAtTick   who leaves and when (its own tick)
 *   cutTo                   from cutTicks before leaving, the leaver's messages reach everybody except this client
 *                           (it must get the missing turns relayed by the others); the cut stalls the match, so the
 *                           leaver leaves after cutLeaveMs at the latest
 *   eliminateAt             the leaver is out of the match (world.match.eliminated) from this tick: an observer
 *   expectFinish            the others play on to `ticks` (else they must stand, waiting, with no drop)
 *   expectDrop              a 'playerLeft' command runs (same tick for everyone)
 *   [MP-LEAVE2] aiOutAt     [team, tick]: an AI team is out of the match from this tick (sim state)
 *   [B6] outAt              [[team, tick], …]: any team (e.g. a human observer) is out of the match from this tick
 *   alliances               { [team]: side } for the fake victory check (default: every team its own side)
 *   expectOut               teams that must be out (eliminated by the playerLeft = defeated) on every client that stays
 *   expectWinners           undefined = not checked, null = the match goes on, [teams] = it ended with these winners
 */
function runLeaveScenario({ name, ids = ['A', 'B', 'C'], leaveId = 'C', leaveAtTick = 200, cutTo = null, cutTicks = 12, cutLeaveMs = 600,
  eliminateAt = null, aiTeams = [], drop = 0, latency = 0, jitter = 0, seed = 11, ticks = 450, expectFinish = true, expectDrop = true,
  aiOutAt = null, outAt = [], alliances = {}, expectOut = [], expectWinners = undefined }) {
  const net = new FakeNet({ drop, latency, jitter, seed });
  const rng = mulberry32(seed * 7919);
  const players = ids.map((id, team) => ({ team, playerId: id, name: `Nick${id}` }));
  const leaveTeam = ids.indexOf(leaveId);
  const clients = ids.map((id, team) => {
    const channel = net.channel(id);
    const world = new FakeWorld();
    const bus = new FakeBus();
    const ls = new Lockstep({ channel, world, commandBus: bus, players, localTeam: team, hostId: ids[0], timers: false,
      now: () => net.time, config: { hashEveryTurns: 5 }, aiTeams, leaveConfig: { graceMs: 300 } });
    return { id, team, world, bus, ls, channel, submitted: 0, gone: false, notices: [] };
  });
  for (const c of clients) { c.ls.onPlayerLeft((info) => c.notices.push(info)); c.ls.start(); }
  const stay = clients.filter((c) => c.id !== leaveId);
  const leaver = clients[leaveTeam];
  const allTeams = [...players.map((p) => p.team), ...aiTeams];

  const maxSteps = ticks * 20;
  let steps = 0;
  let cutAt = null; // the cut stalls everybody (cutTo misses the leaver's turns), so the leaver leaves by time then
  while (stay.some((c) => c.world.tick < ticks) && steps++ < maxSteps) {
    net.time += STEP_MS;
    if (!leaver.gone && cutTo && cutAt === null && leaver.world.tick >= leaveAtTick - cutTicks) { net.blocked.add(`${leaveId}>${cutTo}`); cutAt = net.time; }
    const leaveNow = leaver.world.tick >= leaveAtTick || (cutAt !== null && net.time - cutAt >= cutLeaveMs);
    if (!leaver.gone && leaveNow) { leaver.gone = true; leaver.ls.stop(); net.remove(leaver.channel); }
    for (const c of clients) {
      if (c.gone) continue;
      if (c.world.tick < ticks - 60 && rng() < 0.15 && !c.world.match.eliminated.has(c.team)) c.bus.submit({ type: 'test', team: c.team, n: c.submitted++ }); // [B6] an observer gives no orders
      if (c.world.tick < ticks && c.ls.canAdvance(c.world.tick + 1)) {
        const tick = c.world.tick + 1;
        const done = c.bus.executeTick(tick);
        c.world.tick = tick;
        if (tick === eliminateAt) c.world.match.eliminated.add(leaveTeam); // sim state: same tick on every client
        if (aiOutAt && tick === aiOutAt[1]) c.world.match.eliminated.add(aiOutAt[0]);
        for (const [tm, at] of outAt) if (tick === at) c.world.match.eliminated.add(tm); // [B6] any team (human observer)
        for (const d of done) if (d.type === NET_LEAVE.commandType) fakeDisconnect(c.world.match, d.teams, allTeams, alliances); // [MP-LEAVE2]
        c.world.acc = fnv(`${tick}|${JSON.stringify(done.map((d) => [d.team, d.type, d.n, d.teams]))}`, c.world.acc);
        c.ls.onTick(tick);
      }
      c.ls.pump(net.time);
    }
    net.deliver();
  }

  const problems = [];
  const logOf = (c) => c.bus.log.map((e) => `${e.tick}:${e.cmd.team}:${e.cmd.type}:${e.cmd.n ?? (e.cmd.teams ?? []).join('+')}`);
  const [first, ...rest] = stay;
  const minTick = Math.min(...stay.map((c) => c.world.tick));
  const upTo = (c) => logOf(c).filter((s) => +s.split(':')[0] <= minTick).join();
  for (const c of rest) if (upTo(c) !== upTo(first)) problems.push(`command logs of ${first.id} and ${c.id} differ`);
  const leaves = (c) => c.bus.log.filter((e) => e.cmd.type === NET_LEAVE.commandType);
  if (expectFinish) {
    for (const c of stay) if (c.world.tick < ticks) problems.push(`${c.id} stalled at tick ${c.world.tick} / ${ticks}`);
  } else {
    for (const c of stay) {
      if (c.world.tick >= ticks) problems.push(`${c.id} did not stop without the leaver`);
      if (!c.ls.status.waitingFor.includes(leaveTeam)) problems.push(`${c.id} is not waiting for the leaver`);
      if (!c.ls.status.left.includes(leaveTeam)) problems.push(`${c.id}: status.left misses the leaver`);
    }
  }
  for (const c of stay) {
    const l = leaves(c);
    if (expectDrop && (l.length !== 1 || l[0].cmd.team !== leaveTeam)) problems.push(`${c.id}: expected one playerLeft of team ${leaveTeam}, got ${l.length}`);
    if (!expectDrop && l.length) problems.push(`${c.id}: unexpected playerLeft`);
    if (expectDrop && l.length && JSON.stringify(l[0].cmd.teams) !== JSON.stringify(leaveTeam === 0 ? [0, ...aiTeams] : [leaveTeam])) problems.push(`${c.id}: playerLeft teams ${JSON.stringify(l[0].cmd.teams)}`);
    if (!c.notices.some((x) => x.team === leaveTeam && x.name === `Nick${leaveId}`)) problems.push(`${c.id}: no onPlayerLeft notice with the nickname`);
    if (c.ls.status.desync) problems.push(`${c.id}: false desync ${JSON.stringify(c.ls.status.desync)}`);
    // [MP-LEAVE2] the dropped teams (and a leaving host's AI) are defeated; a single side left wins
    const m = c.world.match;
    for (const tm of expectOut) if (!m.eliminated.has(tm) || !m.disconnected.has(tm)) problems.push(`${c.id}: team ${tm} not defeated by playerLeft`);
    if (expectWinners !== undefined) {
      const got = m.result ? JSON.stringify(m.result.winners) : null;
      const want = expectWinners === null ? null : JSON.stringify(expectWinners);
      if (got !== want) problems.push(`${c.id}: result ${got ?? 'none (goes on)'}, expected ${want ?? 'none (goes on)'}`);
    }
  }
  const ticksOfLeave = new Set(stay.map((c) => leaves(c)[0]?.tick ?? null));
  if (ticksOfLeave.size > 1) problems.push(`playerLeft at different ticks: ${[...ticksOfLeave].join(', ')}`);
  // commands of the ones who stay: all executed everywhere (only checkable when they finished)
  const executed = (c, team) => c.bus.log.filter((e) => e.cmd.team === team && e.cmd.type === 'test').length;
  if (expectFinish) for (const c of stay) for (const o of stay) if (executed(o, c.team) !== c.submitted) problems.push(`${o.id} executed ${executed(o, c.team)} of ${c.submitted} commands of ${c.id}`);
  for (const c of rest) if (executed(c, leaveTeam) !== executed(first, leaveTeam)) problems.push(`leaver's commands: ${first.id} ${executed(first, leaveTeam)} vs ${c.id} ${executed(c, leaveTeam)}`);
  for (const c of clients) c.ls.stop();
  return {
    name,
    ok: problems.length === 0,
    problems,
    ticks: stay.map((c) => `${c.id}:${c.world.tick}`).join(' '),
    commands: first.bus.log.length,
    dropTick: [...ticksOfLeave][0],
    dropped: net.stats.dropped,
    realTimeS: +(net.time / 1000).toFixed(1),
  };
}

/**
 * [MP-LEAVE2] Stand-in for Match.markDisconnected: the teams are defeated at once; the match ends when at most one
 * side has a team left (winners = its teams still in, ascending)
 */
function fakeDisconnect(match, teams, allTeams, alliances) {
  for (const tm of teams ?? []) { match.disconnected.add(tm); match.eliminated.add(tm); }
  if (match.result) return;
  const alive = allTeams.filter((tm) => !match.eliminated.has(tm));
  const sides = new Set(alive.map((tm) => alliances[tm] ?? `t${tm}`));
  if (sides.size <= 1) match.result = { winners: alive.sort((a, b) => a - b) };
}

export function runNetSelftest() {
  const scenarios = [
    { name: 'perfect network', seed: 1 },
    { name: 'latency 80±60 ms, 20 % loss', drop: 0.2, latency: 80, jitter: 60, seed: 2 },
    { name: 'latency 150±150 ms, 50 % loss', drop: 0.5, latency: 150, jitter: 150, seed: 3 },
    { name: 'burst 14×700 B (split), 30 % loss', drop: 0.3, latency: 50, jitter: 40, seed: 4, burstAtTick: 120 },
    { name: 'slow client B (skips 40 % frames)', drop: 0.1, latency: 60, jitter: 30, seed: 5, slowB: 0.6 },
    { name: 'corrupted hash detected', latency: 40, seed: 6, corruptBAt: 300 },
    // [MP-LEAVE]
    { leave: true, name: 'leave: 3 players, C leaves → A+B go on', latency: 40, jitter: 20, seed: 11 },
    { leave: true, name: 'leave: C\'s last turns only reach B (relay to A), 10 % loss', drop: 0.1, latency: 60, jitter: 40, seed: 12, cutTo: 'A' },
    { leave: true, name: 'leave: host A leaves → B coordinates, A + AI 3 defeated', latency: 40, seed: 13, leaveId: 'A', aiTeams: [3], expectOut: [0, 3], expectWinners: null },
    { leave: true, name: 'leave: 2 players, B leaves → A wins ([B6])', ids: ['A', 'B'], leaveId: 'B', latency: 40, seed: 14, expectOut: [1], expectWinners: [0] },
    { leave: true, name: 'leave: observer B (out at 120) leaves → A alone goes on', ids: ['A', 'B'], leaveId: 'B', eliminateAt: 120, latency: 40, seed: 15, expectDrop: false },
    // [MP-LEAVE2] points 3–5 of docs/notes/mp-leave2.md
    { leave: true, name: 'leave2: host A + AI 2, B leaves → B defeated, A vs AI go on', ids: ['A', 'B'], leaveId: 'B', aiTeams: [2], latency: 40, jitter: 20, seed: 21, expectOut: [1], expectWinners: null },
    { leave: true, name: 'leave2: host A + AI 2 (out at 100), B leaves → A wins ([B6])', ids: ['A', 'B'], leaveId: 'B', aiTeams: [2], aiOutAt: [2, 100], latency: 40, seed: 22, expectOut: [1], expectWinners: [0] },
    // [B6] the host leaves and a single playing client stays → host + its AI defeated, the client wins at once
    { leave: true, name: 'b6: host A + AI 2 leave, B alone → B wins', ids: ['A', 'B'], leaveId: 'A', aiTeams: [2], latency: 40, seed: 23, expectOut: [0, 2], expectWinners: [1] },
    { leave: true, name: 'b6: host A leaves (no AI), 20 % loss → B wins', ids: ['A', 'B'], leaveId: 'A', drop: 0.2, latency: 60, jitter: 40, seed: 26, expectOut: [0], expectWinners: [1] },
    { leave: true, name: 'b6: host A + AI 3 leave, B observer (out at 100), C alone → C wins', leaveId: 'A', aiTeams: [3], outAt: [[1, 100]], latency: 40, jitter: 20, seed: 27, expectOut: [0, 3], expectWinners: [2] },
    { leave: true, name: 'b6: host A observer (out at 100) + AI 2, B leaves → A waits (no playing human)', ids: ['A', 'B'], leaveId: 'B', aiTeams: [2], outAt: [[0, 100]], latency: 40, seed: 28, ticks: 400, expectFinish: false, expectDrop: false },
    { leave: true, name: 'b6: host A + AI 2 allied with B, A leaves → B\'s side wins', ids: ['A', 'B'], leaveId: 'A', aiTeams: [2], alliances: { 0: 0, 1: 0, 2: 1 }, latency: 40, seed: 29, expectOut: [0, 2], expectWinners: [1] },
    { leave: true, name: 'leave2: A + AI 2 allied vs B, B leaves → A\'s alliance wins', ids: ['A', 'B'], leaveId: 'B', aiTeams: [2], alliances: { 0: 0, 1: 1, 2: 0 }, latency: 40, seed: 24, expectOut: [1], expectWinners: [0, 2] },
    { leave: true, name: 'leave2: 3 players, C leaves (10 % loss) → C defeated, A vs B go on', drop: 0.1, latency: 60, jitter: 40, seed: 25, expectOut: [2], expectWinners: null },
  ];
  const results = scenarios.map(({ leave, ...s }) => {
    try { return leave ? runLeaveScenario(s) : runScenario(s); } catch (err) { return { name: s.name, ok: false, problems: [String(err?.stack ?? err)] }; }
  });
  const ok = results.every((r) => r.ok);
  console.table(results.map(({ problems, ...r }) => ({ ...r, problems: problems.join(' | ') })));
  console.log(ok ? '[net selftest] ALL PASSED' : '[net selftest] FAILED', results.filter((r) => !r.ok));
  return { ok, results };
}
