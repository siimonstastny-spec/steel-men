// Steel Mans – lockstep multiplayer (docs/MULTIPLAYER.md, "Lockstep"). Only commands travel; every client runs
// the same deterministic simulation.
//
// Turns: turn T = ticks T*NET.turnTicks + 1 … (T+1)*NET.turnTicks. A command submitted while the next tick to
// simulate belongs to turn C is scheduled for turn C + NET.inputDelayTurns (D). At the end of turn T this client
// closes ("finalizes") its turn T + D and sends it – even empty. A client may simulate turn T only when it has turn T
// from every player (canAdvance); the first D turns are empty by definition.
// Loss / reordering: every turn message carries ALL of this client's turns the others have not acknowledged yet
// (`a` = highest turn received contiguously from each team), so a lost message is repaired by the next one.
// Messages stay ≤ NET.maxMessageBytes; a backlog goes out in several messages (at most NET.maxChunksPerSend per
// send, rotating), a turn too big for one message is split into parts. One send per turn (+ a resend every
// NET.resendMs while nothing else goes out, e.g. while waiting).
// Order: a complete turn is enqueued into the CommandBus in team order, then each sender's own order; the bus
// sorts by cmd.team then enqueue order – identical on every client.
// Desync: every NET.hashEveryTurns turns each client sends world.stateHash() of the end of that turn (piggybacked
// on the turn messages + topic 'hash'); a mismatch sets status.desync and logs desyncReport().
//
// Wire format, topic 'turn' (compact keys):
//   { a: { [team]: lastContiguousTurn }, t: [[n, cmds?, part?, parts?], …], p: sentAtMs, e: { [team]: [theirP, heldMs] },
//     h: [[n, hash], …] }
// topic 'hash': { n, h }
//
// Pause [R5] (docs/notes/r5-pause.md): a pause request is a control entry { type: PAUSE.commandType, team, name }
// inside the requester's next open turn n – it travels, is acknowledged and resent like any command, so every client
// knows it before it may simulate turn n. canAdvance() then stops before the first tick of turn n on every client
// (status.paused) – the same tick everywhere. Control entries never reach the CommandBus. Resume: the header field
// `r` = the highest pause turn this client knows was resumed (a max over everyone, sent in every message, so a lost
// message is repaired). Any player may resume. When each client resumes does not matter: no tick runs while paused,
// and a client that resumes first simply waits for the others' turns as usual.
//
// Game speed [N4] (docs/notes/n4-clock.md): the host asks with requestSpeed(v) – a control entry
// { type: GAME_SPEED.commandType, team, speed } in its next open turn, like a pause. Every client applies it when it
// hands that turn to the CommandBus (#enqueueTurn), i.e. before the same tick, by calling gameSpeed.set (the main loop
// only reads gameSpeed.value). Entries from anybody but the host, or with a speed outside GAME_SPEED.options, are
// ignored; control entries never reach the CommandBus. status.speed mirrors the applied value.
//
// Leaving players [MP-LEAVE] (docs/notes/mp-leave.md). Lockstep needs every team's turn, so a vanished player stalls
// everybody. Two ways out, both decided by a turn number K that is the same on every client:
//  - Drop: the coordinator (the host; when the host itself is gone, the present player with the lowest team) waits
//    NET_LEAVE.graceMs, then – if at least NET_LEAVE_WIN.minPlayingHumans (1) still-playing connected human stays
//    ([B6]; observers do not count) – picks
//    K = 1 + the leaver's highest turn it holds, once no other client reports (ack header `a`) more of it. Header
//    field `k: { [team]: K }` (repeated by everybody in every message, first value wins). From turn K on the team's
//    turns are not needed and ignored; in turn K every client enqueues { type: NET_LEAVE.commandType, team, teams }
//    (team + the host's AI teams when the host left), and Match.markDisconnected defeats those teams like a surrender
//    ([MP-LEAVE2]); a single side left (humans + AI while the host stays) wins in that tick. No playing human left
//    (e.g. an observer host + its AI) = no drop: the match waits as before (status.left / waitingFor).
//  - Relay: a client still missing some of the leaver's turns below K gets them from the others: everybody sends the
//    leaver's turns it holds (received or already executed: history) above the lowest ack of the present players,
//    header field `x: [[team, n, cmds?], …]` in an extra message.
//  - Retire: a team that is out of the match (world.match.eliminated: surrendered / eliminated observer) is not
//    needed from turn K = (turn it was seen out at a turn boundary) + D + 1 – sim state, same tick everywhere – so
//    an observer closing its tab never stops the match. Its pause requests no longer count.
import { NET, NET_LEAVE, NET_LEAVE_WIN, SIM, PAUSE, GAME_SPEED } from '../config.js';
import { gameSpeed } from '../game/GameSpeed.js';

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
/** UTF-8 byte length of a string (upper bound without TextEncoder) */
const byteLength = (s) => (encoder ? encoder.encode(s).length : s.length * 3);
const jsonBytes = (v) => byteLength(JSON.stringify(v));
const MAX_ENTRIES_PER_MESSAGE = 256;
/** [R5] nickname carried by a pause request: plain string, trimmed to PAUSE.maxNameLength */
const clipName = (s) => (typeof s === 'string' ? s.trim().slice(0, PAUSE.maxNameLength) : '');

export class Lockstep {
  /**
   * @param {object} o
   * @param {object} o.channel      transport channel of the match room (Lobby onStart `channel`)
   * @param {object} o.world        World (tick, stateHash, waitForSpawns)
   * @param {object} o.commandBus   the CommandBus (schedule, enqueue, clientId, log)
   * @param {{team: number, playerId: string}[]} o.players  human seats (Lobby onStart `players`)
   * @param {number|null} o.localTeam  this client's team (null = spectator: receives, never sends)
   * @param {string|null} [o.hostId]  the host may also command teams without a human player (AI)
   * @param {boolean} [o.timers]      false = no setInterval; the owner calls pump() (selftest)
   * @param {() => number} [o.now]    clock in ms (default performance.now)
   * @param {object} [o.config]       overrides of NET (selftest)
   * @param {number[]} [o.aiTeams]    [MP-LEAVE] computer teams (commanded by the host; idle when the host is dropped)
   * @param {object} [o.leaveConfig]  [MP-LEAVE] overrides of NET_LEAVE (selftest)
   * @param {object} [o.leaveWinConfig] [B6] overrides of NET_LEAVE_WIN (selftest)
   * players[].name = lobby nickname (optional, nameOf)
   */
  constructor({ channel, world, commandBus, players, localTeam, hostId = null, timers = true, now = null, config = null, aiTeams = [], leaveConfig = null, leaveWinConfig = null }) {
    this.cfg = { ...NET, ...(config ?? {}) };
    this.lcfg = { ...NET_LEAVE, ...(leaveConfig ?? {}) };
    this.wcfg = { ...NET_LEAVE_WIN, ...(leaveWinConfig ?? {}) }; // [B6]
    this.TT = Math.max(1, this.cfg.turnTicks | 0);
    this.D = Math.max(1, this.cfg.inputDelayTurns | 0);
    this.channel = channel;
    this.world = world;
    this.bus = commandBus;
    this.selfId = channel.selfId;
    this.hostId = hostId;
    this.localTeam = Number.isInteger(localTeam) ? localTeam : null;
    this.timers = timers;
    this.now = now ?? (() => (globalThis.performance?.now ? globalThis.performance.now() : Date.now()));

    // players: one per team, sorted by team (= the deterministic enqueue order)
    const byTeam = new Map();
    const names = new Map(); // [MP-LEAVE] team -> lobby nickname
    for (const p of players ?? []) {
      if (!Number.isInteger(p?.team) || !p.playerId || byTeam.has(p.team)) continue;
      byTeam.set(p.team, String(p.playerId));
      names.set(p.team, typeof p.name === 'string' ? p.name.trim().slice(0, this.lcfg.maxNameLength) : '');
    }
    this.teams = [...byTeam.keys()].sort((a, b) => a - b);
    this.players = this.teams.map((team) => ({ team, playerId: byTeam.get(team) }));
    this.names = names;
    this.teamByPeer = new Map(this.players.map((p) => [p.playerId, p.team]));
    this.peerOfTeam = new Map(this.players.map((p) => [p.team, p.playerId]));
    this.aiTeams = (aiTeams ?? []).filter((team) => Number.isInteger(team) && !byTeam.has(team)).sort((a, b) => a - b);
    this.isPlayer = this.localTeam !== null && byTeam.has(this.localTeam);
    this.remoteTeams = this.teams.filter((team) => team !== this.localTeam);

    const D = this.D;
    this.localPending = new Map();  // turn -> [cmd]  still open (commands being collected)
    this.localTurns = new Map();    // turn -> [cmd]  finalized, kept until acknowledged by all AND enqueued
    this.finalizedUpTo = D - 1;     // turns 0..D-1 are empty by definition
    this.recv = new Map(this.remoteTeams.map((team) => [team, new Map()]));      // team -> turn -> [cmd]
    this.recvContig = new Map(this.remoteTeams.map((team) => [team, D - 1]));    // highest contiguous turn received
    this.partials = new Map(this.remoteTeams.map((team) => [team, new Map()]));  // team -> turn -> { parts, got[] }
    this.ackFrom = new Map(this.remoteTeams.map((team) => [team, D - 1]));       // highest of OUR turns they have
    this.echo = new Map();          // team -> { ts, at }  their last send time, our receive time (ping)
    this.enqueuedUpTo = D - 1;      // highest turn handed to the CommandBus
    this.history = [];              // [{ n, cmds: [[team, cmd]…] }] executed turns (desyncReport)
    this.hashes = new Map();        // turn -> Map(team -> hash)
    this.ownHashes = [];            // our recent [turn, hash] (piggybacked)
    this.lastSendAt = -Infinity;
    this.sendRotation = 0;
    this.stalledSince = null;
    this.started = false;
    this.stopped = false;
    this.timer = null;
    this.desyncListeners = new Set();
    this.pauseResumedUpTo = -1;     // [R5] pauses at turns <= this are over (max over all clients' `r`)
    // [MP-LEAVE]
    this.dropFrom = new Map();      // team -> K: dropped player, its turns >= K are not needed (playerLeft runs in turn K)
    this.retiredFrom = new Map();   // team -> K: out of the match (observer), its turns >= K are not needed
    this.peerAcks = new Map();      // sender team -> its last ack header `a` ({ [team]: highest contiguous turn })
    this.goneSince = new Map();     // team -> ms when this client first missed the player in the peer list
    this.announced = new Set();     // teams whose leaving was reported to onPlayerLeft listeners
    this.leftListeners = new Set();
    this.pendingDesync = null;      // [MP-LEAVE QA] { n, at } first hash mismatch waiting for confirmation
    /**
     * Read by main.js every frame (same object for the whole match).
     * paused: null | { turn, team, name } – the match stands before the first tick of `turn` ([R5])
     * [MP-LEAVE] left: teams whose player is gone from the room; leaving: of those, the ones the match will go on
     * without (drop pending, or an observer); dropped: teams dropped (their units idle); selfDropped: the others
     * dropped THIS client (its commands are ignored from then on); lastLeft: null | { team, name, continues, at (now()) }
     * = the latest player who vanished (notice)
     */
    this.status = { waitingFor: [], ping: null, desync: false, stalledMs: 0, left: [], leaving: [], dropped: [], selfDropped: false, lastLeft: null, paused: null, speed: gameSpeed.value };

    // Listen right away: turns that arrive while this client is still loading the match are kept
    this.unsubs = [
      channel.on('turn', (m) => this.#onTurnMessage(m)),
      channel.on('hash', (m) => this.#onHashMessage(m)),
      channel.onPeers?.(() => this.#updateLeft()) ?? (() => {}),
    ];
  }

  // ---------- turn arithmetic ----------
  turnOf(tick) { return Math.floor((tick - 1) / this.TT); }
  firstTick(turn) { return turn * this.TT + 1; }
  lastTick(turn) { return (turn + 1) * this.TT; }

  // ---------- public API ----------

  /** Takes over the CommandBus (call right after world.startSimulation(seed): tick 0, empty bus) */
  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.prevSchedule = this.bus.schedule;
    this.prevClientId = this.bus.clientId;
    this.bus.clientId = this.selfId;
    this.bus.schedule = (cmd) => this.#schedule(cmd);
    this.world.waitForSpawns = true;
    if (SIM.spawnDelayTicks < this.TT * this.D) {
      console.warn(`[net] SIM.spawnDelayTicks (${SIM.spawnDelayTicks}) < turnTicks × inputDelayTurns (${this.TT * this.D}): produced units may stall the game while their model loads`);
    }
    if (this.timers) this.timer = setInterval(() => this.pump(), Math.max(NET.minPumpMs, this.cfg.resendMs / 2));
    this.#updateLeft();
    this.#send();
  }

  /** Gives the CommandBus back (offline schedule) and stops sending. The channel stays open (caller leaves it). */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const u of this.unsubs) { try { u(); } catch { /* gone */ } }
    this.unsubs = [];
    this.leftListeners.clear();
    if (this.started) {
      this.bus.schedule = this.prevSchedule;
      this.bus.clientId = this.prevClientId;
      this.world.waitForSpawns = false;
    }
    this.started = false;
  }

  /**
   * May the main loop simulate this tick? True when every player's turn of this tick is here; the turn is then
   * handed to the CommandBus (once). Call it with world.tick + 1 right before each simulation tick.
   */
  canAdvance(tick) {
    if (!this.started || this.stopped) return false;
    const turn = this.turnOf(tick);
    while (this.enqueuedUpTo < turn) {
      const n = this.enqueuedUpTo + 1;
      const missing = this.teams.filter((team) => !this.#hasTurn(team, n));
      if (missing.length) {
        const now = this.now();
        if (this.stalledSince === null) this.stalledSince = now;
        this.status.waitingFor = missing;
        this.status.stalledMs = now - this.stalledSince;
        return false;
      }
      // [R5] somebody paused at this turn: stand before its first tick until anyone resumes (not "waiting")
      const pause = n > this.pauseResumedUpTo ? this.#pauseAt(n) : null;
      if (pause) {
        if (this.status.paused?.turn !== n) this.status.paused = pause;
        if (this.status.waitingFor.length) this.status.waitingFor = [];
        this.stalledSince = null;
        this.status.stalledMs = 0;
        return false;
      }
      this.#enqueueTurn(n);
      this.enqueuedUpTo = n;
    }
    if (this.status.waitingFor.length) this.status.waitingFor = [];
    if (this.status.paused) this.status.paused = null;
    this.stalledSince = null;
    this.status.stalledMs = 0;
    return true;
  }

  // ---------- pause [R5] ----------

  /** May this client pause / resume? (players only; a spectator never sends) */
  get canPause() { return this.started && !this.stopped && this.isPlayer && this.#exemptFrom(this.localTeam) === undefined; } // [MP-LEAVE] not an observer / dropped

  /**
   * Asks every client to pause before our next open turn. `name` = the requester's nickname shown to everybody.
   * Returns false when nothing was requested (not a player, already paused, or our own request is on its way).
   */
  requestPause(name = '') {
    if (!this.canPause || this.status.paused) return false;
    for (const store of [this.localPending, this.localTurns]) {
      for (const [n, cmds] of store) if (n > this.pauseResumedUpTo && cmds.some((c) => c.type === PAUSE.commandType)) return false;
    }
    const turn = Math.max(this.turnOf(this.world.tick + 1) + this.D, this.finalizedUpTo + 1);
    if (!this.localPending.has(turn)) this.localPending.set(turn, []);
    this.localPending.get(turn).push({ type: PAUSE.commandType, team: this.localTeam, name: clipName(name) });
    return true;
  }

  /** Ends the current pause (and every pause request already known) for everybody. */
  resume() {
    if (!this.canPause || !this.status.paused) return false;
    let upTo = this.status.paused.turn;
    const consider = (store) => {
      for (const [n, cmds] of store) if (n > upTo && cmds.some((c) => c?.type === PAUSE.commandType)) upTo = n;
    };
    consider(this.localPending);
    consider(this.localTurns);
    for (const store of this.recv.values()) consider(store);
    this.#setResumed(upTo);
    this.#send(); // tell the others right away (repeated in every later message)
    return true;
  }

  // ---------- game speed [N4] ----------

  /** May this client change the game speed? Only the host (a player) may. */
  get canChangeSpeed() { return this.canPause && this.hostId !== null && this.selfId === this.hostId; }

  /** Host: asks every client to switch to `speed` before our next open turn. Returns false when refused. */
  requestSpeed(speed) {
    const v = Number(speed);
    if (!this.canChangeSpeed || !GAME_SPEED.options.includes(v)) return false;
    const turn = Math.max(this.turnOf(this.world.tick + 1) + this.D, this.finalizedUpTo + 1);
    if (!this.localPending.has(turn)) this.localPending.set(turn, []);
    this.localPending.get(turn).push({ type: GAME_SPEED.commandType, team: this.localTeam, speed: v });
    return true;
  }

  /** Is this entry a valid speed change, sent by the host's team? */
  #isHostSpeed(team, cmd) {
    return cmd.type === GAME_SPEED.commandType && GAME_SPEED.options.includes(cmd.speed)
      && this.hostId !== null && this.players.find((p) => p.team === team)?.playerId === this.hostId;
  }

  #setResumed(upTo) {
    if (upTo <= this.pauseResumedUpTo) return;
    this.pauseResumedUpTo = upTo;
    if (this.status.paused && this.status.paused.turn <= upTo) this.status.paused = null;
  }

  /** The first pause request in turn n (team order), or null. Every team's turn n is here when this is called. */
  #pauseAt(n) {
    if (n < this.D) return null;
    for (const team of this.teams) {
      if (this.#isExempt(team, n)) continue; // [MP-LEAVE] dropped / observer
      const cmds = team === this.localTeam ? this.localTurns.get(n) : this.recv.get(team)?.get(n);
      const c = cmds?.find((x) => x?.type === PAUSE.commandType);
      if (c) return { turn: n, team, name: clipName(c.name) };
    }
    return null;
  }

  /** Call after every simulated tick: on a turn boundary closes our turn, sends it and records the state hash */
  onTick(tick) {
    if (!this.started || this.stopped || tick % this.TT !== 0) return;
    const turn = tick / this.TT - 1; // the turn that just ended
    this.#retireEliminated(turn); // [MP-LEAVE]
    if ((turn + 1) % this.cfg.hashEveryTurns === 0) this.#recordOwnHash(turn, this.world.stateHash());
    if (this.isPlayer) {
      while (this.finalizedUpTo < turn + this.D) {
        const n = ++this.finalizedUpTo;
        this.localTurns.set(n, this.localPending.get(n) ?? []);
        this.localPending.delete(n);
      }
    }
    this.#send();
  }

  /** Resend timer (setInterval when timers are on; the selftest calls it by hand) */
  pump(now = this.now()) {
    if (!this.started || this.stopped) return;
    if (this.stalledSince !== null) this.status.stalledMs = now - this.stalledSince;
    this.#updateLeft(now); // [MP-LEAVE] also polled: a missed peer event must not stall the match for ever
    this.#maybeDrop(now);
    this.#confirmDesync(now); // [MP-LEAVE QA]
    if (now - this.lastSendAt >= this.cfg.resendMs) this.#send(now);
  }

  /** fn(status.desync) once a hash mismatch is found. Returns unsubscribe. */
  onDesync(fn) { this.desyncListeners.add(fn); return () => this.desyncListeners.delete(fn); }

  /** [MP-LEAVE] Lobby nickname of a human team ('' = none / unknown; the UI falls back to "Seat N") */
  nameOf(team) { return this.names.get(team) ?? ''; }

  /**
   * [MP-LEAVE] fn({ team, name, continues }) once per team when its player vanishes from the room during the match
   * (local event for a notice; continues = the match will go on without it). Returns unsubscribe.
   */
  onPlayerLeft(fn) { this.leftListeners.add(fn); return () => this.leftListeners.delete(fn); }

  /** Everything needed to find a desync: hashes, executed turns, CommandBus log. Also printed to the console. */
  desyncReport() {
    const report = {
      selfId: this.selfId,
      localTeam: this.localTeam,
      players: this.players,
      dropFrom: Object.fromEntries(this.dropFrom),       // [MP-LEAVE]
      retiredFrom: Object.fromEntries(this.retiredFrom),
      tick: this.world.tick,
      desync: this.status.desync,
      config: { turnTicks: this.TT, inputDelayTurns: this.D, hashEveryTurns: this.cfg.hashEveryTurns },
      hashes: [...this.hashes.entries()].sort((a, b) => a[0] - b[0]).map(([n, m]) => ({ turn: n, tick: this.lastTick(n), hashes: Object.fromEntries(m) })),
      turns: this.history.filter((h) => h.cmds.length),
      busLog: (this.bus.log ?? []).slice(-500),
    };
    console.log('[net] desync report (copy the JSON below from both clients and compare):');
    try { console.log(JSON.stringify(report)); } catch { console.log(report); }
    return report;
  }

  // ---------- local commands ----------

  #schedule(cmd) {
    if (this.stopped) return;
    if (!this.isPlayer) { console.warn('[net] spectator command dropped', cmd?.type); return; }
    if (cmd?.type === this.lcfg.commandType) return; // [MP-LEAVE] only the lockstep itself injects it
    if (!this.#mayCommand(this.selfId, this.localTeam, cmd.team)) { console.warn('[net] command for a foreign team dropped', cmd); return; }
    let text;
    try { text = JSON.stringify(cmd); } catch { console.warn('[net] command is not JSON', cmd); return; }
    if (byteLength(text) > this.cfg.maxCommandBytes) { console.warn(`[net] command '${cmd.type}' too big (> ${this.cfg.maxCommandBytes} B), dropped`); return; }
    // JSON round trip: this client executes exactly what the others receive (no undefined, -0, Vector3…)
    const plain = JSON.parse(text);
    const turn = Math.max(this.turnOf(this.world.tick + 1) + this.D, this.finalizedUpTo + 1);
    if (!this.localPending.has(turn)) this.localPending.set(turn, []);
    this.localPending.get(turn).push(plain);
  }

  /** Same rule on sender and receivers: own team, or the host commanding a team nobody plays (AI) */
  #mayCommand(peerId, senderTeam, cmdTeam) {
    if (cmdTeam === senderTeam) return true;
    return this.hostId !== null && peerId === this.hostId && Number.isInteger(cmdTeam) && !this.teams.includes(cmdTeam);
  }

  // ---------- turn bookkeeping ----------

  #hasTurn(team, n) {
    if (n < this.D) return true;
    if (this.#isExempt(team, n)) return true; // [MP-LEAVE] dropped / observer: not needed any more
    if (team === this.localTeam) return n <= this.finalizedUpTo;
    return this.recv.get(team)?.has(n) ?? false;
  }

  #enqueueTurn(n) {
    const tick = this.firstTick(n);
    const entry = { n, cmds: [] };
    if (n >= this.D) {
      for (const team of this.teams) {
        if (this.dropFrom.get(team) === n) this.#enqueueLeave(team, tick, entry); // [MP-LEAVE] same tick everywhere
        if (this.#isExempt(team, n)) { if (team !== this.localTeam) this.recv.get(team).delete(n); continue; }
        const cmds = team === this.localTeam ? (this.localTurns.get(n) ?? []) : (this.recv.get(team).get(n) ?? []);
        for (const cmd of cmds) {
          if (cmd.type === GAME_SPEED.commandType) { // [N4] speed = lockstep control only, applied before this turn's first tick
            if (this.#isHostSpeed(team, cmd)) { gameSpeed.set(cmd.speed); this.status.speed = gameSpeed.value; }
          } else if (cmd.type !== PAUSE.commandType) this.bus.enqueue(tick, cmd); // [R5] pause = lockstep control only
          entry.cmds.push([team, cmd]);
        }
        if (team !== this.localTeam) this.recv.get(team).delete(n);
      }
    }
    this.history.push(entry);
    if (this.history.length > this.cfg.historyTurns) this.history.splice(0, this.history.length - this.cfg.historyTurns);
    this.#pruneLocal();
  }

  #minAck() {
    let min = Infinity;
    for (const [team, v] of this.ackFrom) {
      // [MP-LEAVE] a dropped player, or an observer that left, never acknowledges again
      if (this.dropFrom.has(team) || (this.retiredFrom.has(team) && this.status.left.includes(team))) continue;
      min = Math.min(min, v);
    }
    return min;
  }

  /** Our turns everybody has and we executed are not needed any more */
  #pruneLocal() {
    const limit = Math.min(this.#minAck(), this.enqueuedUpTo);
    for (const n of this.localTurns.keys()) if (n <= limit) this.localTurns.delete(n);
  }

  // ---------- sending ----------

  #send(now = this.now()) {
    if (!this.isPlayer || this.stopped) return;
    const header = { a: {}, p: Math.round(now), e: {} };
    if (this.pauseResumedUpTo >= 0) header.r = this.pauseResumedUpTo; // [R5]
    if (this.dropFrom.size) header.k = Object.fromEntries(this.dropFrom); // [MP-LEAVE] repeated by everybody
    for (const team of this.remoteTeams) header.a[team] = this.recvContig.get(team);
    for (const [team, ec] of this.echo) header.e[team] = [ec.ts, Math.round(now - ec.at)];
    if (this.ownHashes.length) header.h = this.ownHashes.slice(-this.cfg.hashCarry);

    const minAck = this.#minAck();
    const unacked = [...this.localTurns.keys()].filter((n) => n > minAck).sort((a, b) => a - b);
    const limit = this.cfg.maxMessageBytes - this.cfg.messageHeadroomBytes;
    const entries = [];
    for (const n of unacked) {
      const cmds = this.localTurns.get(n);
      const whole = cmds.length ? [n, cmds] : [n];
      if (jsonBytes(whole) <= limit) { entries.push(whole); continue; }
      // too big for one message: parts of whole commands
      const parts = [];
      let cur = [];
      for (const cmd of cmds) {
        if (cur.length && jsonBytes([n, [...cur, cmd], 0, 0]) > limit) { parts.push(cur); cur = []; }
        cur.push(cmd);
      }
      if (cur.length) parts.push(cur);
      parts.forEach((p, i) => entries.push([n, p, i, parts.length]));
    }

    // pack entries into messages
    const messages = [];
    let batch = [];
    let size = 2;
    for (const e of entries) {
      const b = jsonBytes(e) + 1;
      if (batch.length && (size + b > limit || batch.length >= MAX_ENTRIES_PER_MESSAGE)) { messages.push(batch); batch = []; size = 2; }
      batch.push(e);
      size += b;
    }
    if (batch.length || !messages.length) messages.push(batch); // header-only message = acks / heartbeat

    // a backlog bigger than one send rotates, so every part eventually goes out
    let outgoing = messages;
    if (messages.length > this.cfg.maxChunksPerSend) {
      const start = this.sendRotation % messages.length;
      outgoing = [];
      for (let i = 0; i < this.cfg.maxChunksPerSend; i++) outgoing.push(messages[(start + i) % messages.length]);
      this.sendRotation = start + this.cfg.maxChunksPerSend;
    } else {
      this.sendRotation = 0;
    }
    for (const t of outgoing) {
      let msg = { ...header, t };
      if (jsonBytes(msg) > this.cfg.maxMessageBytes) { // drop extras
        msg = { a: header.a, p: header.p, t };
        if ('r' in header) msg.r = header.r;
        if ('k' in header) msg.k = header.k;
      }
      if (jsonBytes(msg) > this.cfg.maxMessageBytes) { console.error('[net] turn message too big, not sent'); continue; }
      this.channel.send('turn', msg);
    }
    this.#sendRelay(header); // [MP-LEAVE]
    this.lastSendAt = now;
  }

  // ---------- leaving players [MP-LEAVE] ----------

  /** First turn from which the team's turns are not needed (dropped or retired), undefined = still needed */
  #exemptFrom(team) {
    const d = this.dropFrom.get(team);
    const r = this.retiredFrom.get(team);
    if (d === undefined) return r;
    return r === undefined ? d : Math.min(d, r);
  }

  #isExempt(team, n) {
    const k = this.#exemptFrom(team);
    return k !== undefined && n >= k;
  }

  /** The dropped team's units go idle in this tick (Match.markDisconnected); a host takes its AI teams along */
  #enqueueLeave(team, tick, entry) {
    const teams = [team];
    if (this.#isHostTeam(team)) teams.push(...this.aiTeams);
    const cmd = { type: this.lcfg.commandType, team, teams, origin: null };
    this.bus.enqueue(tick, cmd);
    entry.cmds.push([team, cmd]);
    if (team === this.localTeam) this.status.selfDropped = true;
  }

  /** A team out of the match (sim state, read at a turn boundary = same tick everywhere) stops being needed */
  #retireEliminated(turn) {
    const out = this.world.match?.eliminated;
    if (!out?.size) return;
    for (const team of this.teams) {
      if (!this.retiredFrom.has(team) && out.has(team)) this.retiredFrom.set(team, turn + this.D + 1);
    }
  }

  /** Peer list → status.left / leaving, onPlayerLeft notices */
  #updateLeft(now = this.now()) {
    let present;
    try { present = new Set(this.channel.peers().map((p) => p.id)); } catch { return; }
    const left = this.players.filter((p) => p.team !== this.localTeam && !present.has(p.playerId)).map((p) => p.team);
    this.status.left = left;
    this.#updateLeaving();
    if (!this.started) return; // the grace time counts from the match start (peers may still be loading before)
    for (const team of left) if (!this.goneSince.has(team)) this.goneSince.set(team, now);
    for (const team of [...this.goneSince.keys()]) if (!left.includes(team)) this.goneSince.delete(team);
    for (const team of left) {
      if (this.announced.has(team)) continue;
      this.announced.add(team);
      const info = { team, name: this.nameOf(team), continues: this.status.leaving.includes(team) };
      this.status.lastLeft = { ...info, at: now }; // main.js: short notice for NET_LEAVE.noticeMs
      for (const fn of [...this.leftListeners]) { try { fn(info); } catch (err) { console.error(err); } }
    }
  }

  #updateLeaving() {
    const gone = new Set(this.status.left);
    this.status.leaving = this.status.left.filter((team) => !this.dropFrom.has(team) && this.#continuesWithout(team, gone));
  }

  /**
   * Does the match go on without this (gone) team? An observer: always. A player: [B6] at least
   * NET_LEAVE_WIN.minPlayingHumans (1) still-playing connected human stays (observers never count). The leaver (with a
   * host's AI teams) is then defeated by 'playerLeft'; if a single side is left (humans + the AI teams while the host
   * stays), Match ends with its win in that tick. No playing human left (e.g. an observer host + its AI) = wait.
   */
  #continuesWithout(team, gone) {
    if (this.retiredFrom.has(team)) return true;
    let playing = 0;
    for (const p of this.players) {
      if (p.team === team || gone.has(p.team) || this.dropFrom.has(p.team) || this.retiredFrom.has(p.team)) continue;
      playing++;
    }
    return playing >= this.wcfg.minPlayingHumans;
  }

  /** [B6] Is this the host's team? */
  #isHostTeam(team) { return this.hostId !== null && this.peerOfTeam.get(team) === this.hostId; }

  /** Who decides drops: the host while it is here and not dropped, else the present player with the lowest team */
  #coordinatorTeam(gone) {
    const usable = (p) => !this.dropFrom.has(p.team) && (p.team === this.localTeam || !gone.has(p.team));
    const host = this.players.find((p) => p.playerId === this.hostId);
    if (host && usable(host)) return host.team;
    return this.players.find(usable)?.team ?? null; // players are sorted by team
  }

  /** Coordinator: drops a vanished player once the grace time is over and nobody holds more of its turns */
  #maybeDrop(now) {
    if (!this.isPlayer || !this.status.left.length || this.dropFrom.has(this.localTeam)) return;
    const gone = new Set(this.status.left);
    if (this.#coordinatorTeam(gone) !== this.localTeam) return;
    for (const team of this.status.left) {
      if (this.dropFrom.has(team)) continue;
      const since = this.goneSince.get(team);
      if (since === undefined || now - since < this.lcfg.graceMs) continue;
      if (!this.#continuesWithout(team, gone)) continue; // the last playing human stays: wait (paused) as before
      const mine = this.recvContig.get(team);
      const retired = this.retiredFrom.get(team);
      if (retired !== undefined && mine >= retired - 1) continue; // an observer we have every needed turn of never blocks
      let behind = false;
      for (const p of this.players) {
        if (p.team === team || p.team === this.localTeam || gone.has(p.team) || this.dropFrom.has(p.team)) continue;
        const a = this.peerAcks.get(p.team)?.[team];
        if (Number.isInteger(a) && a > mine) behind = true; // they hold more of it: wait for the relay
      }
      if (behind) continue;
      this.#applyDrop(team, mine + 1);
      this.#send(now);
    }
  }

  #applyDrop(team, K) {
    if (K <= this.enqueuedUpTo) console.error(`[net] drop of team ${team} from turn ${K} arrived after turn ${this.enqueuedUpTo} ran – desync likely`);
    this.dropFrom.set(team, K);
    this.status.dropped = [...this.dropFrom.keys()].sort((a, b) => a - b);
    const store = this.recv.get(team);
    if (store) for (const n of [...store.keys()]) if (n >= K) store.delete(n);
    const partials = this.partials.get(team);
    if (partials) for (const n of [...partials.keys()]) if (n >= K) partials.delete(n);
    // its hashes of turns >= K came from a simulation that still had its own turns there: not comparable
    for (const [n, m] of this.hashes) if (n >= K) m.delete(team);
    const d = this.status.desync;
    if (d && d.turn >= K && new Set(this.hashes.get(d.turn)?.values() ?? []).size <= 1) {
      console.warn(`[net] desync at turn ${d.turn} came from the dropped team ${team} – cleared`);
      this.status.desync = false;
    }
    this.#updateLeaving();
    this.#pruneLocal();
  }

  /** Header `k` of any player: drops it decided or repeats (first value wins) */
  #receiveDrops(k) {
    for (const [key, K] of Object.entries(k)) {
      const team = Number(key);
      if (!this.teams.includes(team) || !Number.isInteger(K) || K < this.D) continue;
      const known = this.dropFrom.get(team);
      if (known === undefined) this.#applyDrop(team, K);
      else if (known !== K) console.error(`[net] conflicting drop of team ${team}: turn ${known} vs ${K}`);
    }
  }

  /** The vanished team's turn n as this client holds it (received, or executed: history), or null */
  #heldTurn(team, n) {
    if (n > this.enqueuedUpTo) return this.recv.get(team)?.get(n) ?? null;
    const first = this.history[0]?.n;
    const e = first === undefined ? null : this.history[n - first];
    if (!e || e.n !== n) return null;
    return e.cmds.filter(([tm, c]) => tm === team && c.type !== this.lcfg.commandType).map(([, c]) => c);
  }

  /** Turns of vanished teams some present player still lacks, in one extra message (only while needed) */
  #sendRelay(header) {
    if (!this.status.left.length) return;
    const gone = new Set(this.status.left);
    const present = this.players.filter((p) => p.team !== this.localTeam && !gone.has(p.team) && !this.dropFrom.has(p.team));
    if (!present.length) return;
    const entries = [];
    for (const team of this.status.left) {
      const K = this.#exemptFrom(team);
      const upper = Math.min(this.recvContig.get(team), K === undefined ? Infinity : K - 1);
      let need = Infinity;
      for (const p of present) {
        const a = this.peerAcks.get(p.team)?.[team];
        need = Math.min(need, Number.isInteger(a) ? a : this.D - 1);
      }
      for (let n = Math.max(need, this.D - 1) + 1; n <= upper && entries.length < this.lcfg.maxRelayTurns; n++) {
        const cmds = this.#heldTurn(team, n);
        if (cmds === null) break; // keep it contiguous
        entries.push(cmds.length ? [team, n, cmds.map(({ origin, ...c }) => c)] : [team, n]);
      }
    }
    if (!entries.length) return;
    const msg = { a: header.a, p: header.p, x: [] };
    if ('k' in header) msg.k = header.k;
    let size = jsonBytes(msg);
    for (const e of entries) {
      const b = jsonBytes(e) + 1;
      if (size + b > this.cfg.maxMessageBytes) break;
      msg.x.push(e);
      size += b;
    }
    if (msg.x.length) this.channel.send('turn', msg);
  }

  /** Header `x`: another client's copy of a vanished team's turns (same content the team sent) */
  #receiveRelay(senderTeam, list) {
    const touched = new Set();
    for (const e of list.slice(0, MAX_ENTRIES_PER_MESSAGE)) {
      if (!Array.isArray(e)) continue;
      const team = e[0];
      if (team === senderTeam || team === this.localTeam || !this.recv.has(team)) continue;
      this.#receiveEntry(team, this.peerOfTeam.get(team), [e[1], e[2]]);
      touched.add(team);
    }
    for (const team of touched) this.#advanceContig(team);
  }

  // ---------- receiving ----------

  #onTurnMessage({ from, data }) {
    if (this.stopped || !data || typeof data !== 'object') return;
    const team = this.teamByPeer.get(from);
    if (team === undefined || team === this.localTeam) return; // spectator / stranger / ourselves
    const now = this.now();
    // their acknowledgement of our turns
    const ack = data.a?.[this.localTeam];
    if (Number.isInteger(ack) && ack > this.ackFrom.get(team)) { this.ackFrom.set(team, ack); this.#pruneLocal(); }
    // ping: they echo our send time + how long they held it
    const echo = data.e?.[this.localTeam];
    if (Array.isArray(echo) && Number.isFinite(echo[0]) && Number.isFinite(echo[1])) {
      const rtt = now - echo[0] - echo[1];
      if (rtt >= 0 && rtt < 60000) {
        const s = this.cfg.pingSmoothing;
        this.status.ping = Math.round(this.status.ping === null ? rtt : this.status.ping + (rtt - this.status.ping) * s);
      }
    }
    if (Number.isFinite(data.p)) this.echo.set(team, { ts: data.p, at: now });
    // [MP-LEAVE] their view of everybody's turns (relay / drop decisions), drops, relayed turns of vanished players
    if (data.a && typeof data.a === 'object') this.peerAcks.set(team, data.a);
    if (data.k && typeof data.k === 'object') this.#receiveDrops(data.k);
    if (Array.isArray(data.x)) this.#receiveRelay(team, data.x);
    // [R5] resumed pauses (before the turns: a pause they already resumed never stops us)
    if (Number.isInteger(data.r) && data.r <= this.enqueuedUpTo + this.cfg.maxTurnsAhead) this.#setResumed(data.r);
    // turns
    if (Array.isArray(data.t)) {
      for (const e of data.t.slice(0, MAX_ENTRIES_PER_MESSAGE)) this.#receiveEntry(team, from, e);
      this.#advanceContig(team);
    }
    // piggybacked hashes
    if (Array.isArray(data.h)) for (const pair of data.h) if (Array.isArray(pair)) this.#recordHash(team, pair[0], pair[1]);
  }

  #receiveEntry(team, from, e) {
    if (!Array.isArray(e)) return;
    const n = e[0];
    if (!Number.isInteger(n) || n <= this.enqueuedUpTo || n > this.enqueuedUpTo + this.cfg.maxTurnsAhead) return;
    if (this.#isExempt(team, n)) return; // [MP-LEAVE] dropped / observer: not needed
    const store = this.recv.get(team);
    if (store.has(n)) return; // duplicate (resend)
    const cmds = this.#sanitize(e[1] ?? [], team, from);
    if (cmds === null) return;
    const parts = e[3];
    if (Number.isInteger(parts) && parts > 1) {
      const part = e[2];
      if (!Number.isInteger(part) || part < 0 || part >= parts) return;
      const partials = this.partials.get(team);
      let p = partials.get(n);
      if (!p || p.parts !== parts) { p = { parts, got: new Array(parts).fill(null) }; partials.set(n, p); }
      p.got[part] = cmds;
      if (p.got.some((x) => x === null)) return;
      partials.delete(n);
      store.set(n, p.got.flat());
      return;
    }
    store.set(n, cmds);
  }

  /** Plain, well-formed commands this sender may give; origin = the real sender (CommandBus.isOwn) */
  #sanitize(list, team, from) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const c of list) {
      if (!c || typeof c !== 'object' || typeof c.type !== 'string' || typeof c.team !== 'number') continue;
      if (c.type === this.lcfg.commandType) continue; // [MP-LEAVE] only the lockstep itself injects it
      if (!this.#mayCommand(from, team, c.team)) { console.warn('[net] remote command for a foreign team ignored', c); continue; }
      out.push({ ...c, origin: from });
    }
    return out;
  }

  #advanceContig(team) {
    const store = this.recv.get(team);
    let c = this.recvContig.get(team);
    while (store.has(c + 1)) c++;
    this.recvContig.set(team, c);
    // partial turns that can no longer matter
    const partials = this.partials.get(team);
    for (const n of partials.keys()) if (n <= this.enqueuedUpTo) partials.delete(n);
  }

  // ---------- hashes / desync ----------

  #recordOwnHash(turn, hash) {
    this.ownHashes.push([turn, hash]);
    if (this.ownHashes.length > this.cfg.hashCarry) this.ownHashes.shift();
    if (this.localTeam !== null) this.#recordHash(this.localTeam, turn, hash);
    else this.#recordHash('self', turn, hash); // spectator compares too
    if (this.isPlayer) this.channel.send('hash', { n: turn, h: hash });
  }

  #onHashMessage({ from, data }) {
    const team = this.teamByPeer.get(from);
    if (team === undefined || team === this.localTeam || !data) return;
    this.#recordHash(team, data.n, data.h);
  }

  #recordHash(team, n, h) {
    if (!Number.isInteger(n) || (typeof h !== 'number' && typeof h !== 'string')) return;
    if (typeof team === 'number' && this.dropFrom.has(team) && n >= this.dropFrom.get(team)) return; // [MP-LEAVE] it ran its own turns there
    const newest = this.enqueuedUpTo;
    if (n < newest - this.cfg.hashKeepTurns || n > newest + this.cfg.maxTurnsAhead) return;
    let m = this.hashes.get(n);
    if (!m) { m = new Map(); this.hashes.set(n, m); }
    if (m.has(team)) return;
    m.set(team, h);
    for (const k of this.hashes.keys()) if (k < newest - this.cfg.hashKeepTurns) this.hashes.delete(k);
    const values = new Set(m.values());
    if (values.size > 1) {
      if (!this.status.desync) {
        // [MP-LEAVE QA] not reported at once: a closing tab may send a last hash from a broken simulation. Confirmed in
        // pump() after NET_LEAVE.desyncConfirmMs unless the odd one out has left the room by then.
        if (!this.pendingDesync || n < this.pendingDesync.n) this.pendingDesync = { n, at: this.now() };
      } else if (this.status.desync.turn === n) {
        this.status.desync.hashes = Object.fromEntries(m);
      }
    }
  }

  /** [MP-LEAVE QA] A hash mismatch waited long enough: hashes of players who left meanwhile do not count */
  #confirmDesync(now) {
    const p = this.pendingDesync;
    if (!p || now - p.at < this.lcfg.desyncConfirmMs) return;
    this.pendingDesync = null;
    if (this.status.desync) return;
    const m = this.hashes.get(p.n);
    if (!m) return;
    const counted = [...m].filter(([team]) => !this.status.left.includes(team) && !this.dropFrom.has(team));
    if (new Set(counted.map(([, h]) => h)).size <= 1) {
      console.warn(`[net] hash mismatch at tick ${this.lastTick(p.n)} only from players who left – ignored`, Object.fromEntries(m));
      return;
    }
    this.status.desync = { tick: this.lastTick(p.n), turn: p.n, hashes: Object.fromEntries(m) };
    console.error(`[net] DESYNC at tick ${this.lastTick(p.n)} (turn ${p.n})`, this.status.desync.hashes, '– steelMans.net.desyncReport()');
    for (const fn of [...this.desyncListeners]) { try { fn(this.status.desync); } catch (err) { console.error(err); } }
  }

}
