// Steel Mans – multiplayer lobby (docs/MULTIPLAYER.md, "Lobby"). The host creates a game with a short code; the
// code is the room name. Everyone keeps their own wishes in PRESENCE (seat, nickname, race, colour, ready) – presence
// is absolute state, re-sent by the platform and handed to newcomers, so nothing gets lost. The host is the
// authority: it turns everybody's presence into the seat list and publishes it (its own presence field `lobby`
// + a 'lobby' message on every change and every NET.lobbyResendMs). Clients only display the host's state.
//
//   const lobby = new Lobby(transport)
//   await lobby.create({ name }) / await lobby.join(code, { name })
//   lobby.state  { code, hostId, seats: [{ team, controller: 'human'|'ai'|'open', playerId, nickname, race, color, ready,
//                  open (false = the seat is not in the game), alliance (id, equal = allies),
//                  difficulty (AI seats only: 'easy'|'normal'|'hard'),
//                  aiName + avatar (AI seats only [N6]: call sign and avatar index, chosen by the host) }],     [N5b] TEAMS.length seats
//                  settings, v, hostLeft? }
//   [N5b] host only: setSeatOpen(team, bool) / setSeatAlliance(team, id) / setAllianceLayout(ids) (ids in order of the open seats)
//   lobby.startProblem() -> null | i18n key why the host cannot start yet (also exported as lobbyStartProblem(seats))
//   start(): the open seats are packed (seat index = order of the open seats), payload.seats are the packed seats and
//   payload.settings.playerCount / .alliances (normalised, one entry per packed seat) are added
//   lobby.onChange(fn) / onStart(fn)  -> unsubscribe
//   lobby.takeSeat(team) / leaveSeat() / setRace(race) / setColor(color) / setReady(bool)   own seat only
//   lobby.setSettings(patch)  host only (fogOfWar, victory, energyCap, friendlyFire,
//                             startMultiplier [D4]: one of START_MULTIPLIER.options (number or 'infinite'), else dropped,
//                             startResearch: one of START_RESEARCH.options (0 = none, 1..3 = tier), else dropped,
//                             oreMultiplier [B1]: one of ORE_MULTIPLIER.options (number or 'infinite'), anything else is dropped,
//                             speed [N4]: one of GAME_SPEED.options, anything else is dropped,
//                             prebuild [N8]: minutes, one of PREBUILD.options (0 = off), anything else is dropped,
//                             startSet [N15]: start set id of stats.json (unknown = the default set))
//   lobby.addAi(team, {difficulty, race, color}) / removeAi(team) / setAi(team, {difficulty?, race?, color?})  host only
//   lobby.start()             host only, all human seats ready (AI seats count as ready) → 'start' to everyone
//   onStart payload: { settings, seats, seed, localTeam, startAtMs, hostId, code, players: [{team, playerId, name}],
//                      aiSeats: [{team, difficulty}],
//                      channel, transport, selfId }   – channel stays open for the Lockstep
//   lobby.leave()
import { NET, TEAMS, LOBBY, AIMENU, GAME_SPEED, PLAYERS_UI, AI_PLAYERS, PREBUILD, UI_SMALL, MENU, ORE_MULTIPLIER, START_MULTIPLIER, START_RESEARCH, ECONOMY } from '../config.js';
import { loadMapCatalog, validMapChoice, isRandomMap, pickRandomMap } from '../game/MapCatalog.js'; // [W5a] Random map
import { colorsTooSimilar, firstDistinctColor } from '../core/ColorCheck.js'; // [MP-POLISH]
import { aiIdentity, cleanAiIdentity, hashSeed, pickAiIndex, usedNameIndices } from '../ai/AiProfiles.js'; // [N6]
import { hasEnoughAlliances, isAllianceId, normalizeAlliances } from '../core/AllianceSetup.js';
import { cleanAvatarImage } from '../core/PlayerLabels.js'; // [UISMALL] picture of a human player (small data URL)

// [UISMALL] A message / presence of the room is at most NET.maxMessageBytes, and the lobby state already travels in the
// host's presence, so pictures are NOT part of the state: everybody publishes a tiny thumbnail (UI_SMALL.humanAvatar.netMaxLength)
// in the own presence field `img`, and the others read it from the peer list (lobby.avatarOf).
const netImage = (value) => cleanAvatarImage(value, UI_SMALL.humanAvatar.netMaxLength);
import { validStartSet } from '../game/StartSets.js'; // [N15]
import { getStats } from '../data/Stats.js';
import { validConditionForSet } from '../game/Victory.js';
import { t } from '../i18n/i18n.js';

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const NICK_MAX = 32;
const RACE_MAX = 32;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));

function randomInt(max) {
  if (globalThis.crypto?.getRandomValues) {
    const a = new Uint32Array(1);
    globalThis.crypto.getRandomValues(a);
    return a[0] % max;
  }
  return Math.floor(Math.random() * max);
}

function randomCode() {
  let s = '';
  for (let i = 0; i < NET.codeLength; i++) s += NET.codeAlphabet[randomInt(NET.codeAlphabet.length)];
  return s;
}

/** Seed of the match simulation (32-bit unsigned; world.startSimulation accepts it) */
function randomSeed() {
  return randomInt(0x100000000);
}

/** What a user typed → canonical code (upper case, letters and digits only) */
export function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Room name of a game code (room grammar: lower case) */
export function roomName(code) {
  return NET.roomPrefix + normalizeCode(code).toLowerCase();
}

/** A fresh seat; only the first PLAYERS_UI.defaultOpenSeats seats are open, alliance = own index (everybody alone) */
const newSeat = (team) => ({
  team, controller: 'open', playerId: null, nickname: '', race: null, color: null, ready: false,
  open: team < PLAYERS_UI.defaultOpenSeats, alliance: team,
});

/** Frees the person of a seat but keeps the seat's own settings (open, alliance) */
function clearSeat(seat) {
  Object.assign(seat, { controller: 'open', playerId: null, nickname: '', race: null, color: null, ready: false });
  delete seat.difficulty;
  delete seat.aiName; // [N6]
  delete seat.avatar;
  return seat;
}

/** [MP-POLISH] Seats that take part in the game: open and filled (human or computer); empty open seats are dropped */
export function playingSeats(seats) {
  return (seats ?? []).filter((s) => s.open && s.controller !== 'open');
}

/**
 * Why the game cannot start yet, as an i18n key, or null. At least PLAYERS_UI.minPlayers open seats must be filled
 * (human or computer; empty open seats are ignored), every human ready, and the alliances
 * must leave at least two sides.
 */
export function lobbyStartProblem(seats) {
  // [MP-POLISH] open seats nobody sits at are ignored (closed at the start) as long as enough seats are filled
  const open = playingSeats(seats);
  const humans = open.filter((s) => s.controller === 'human' && s.playerId);
  // [B1] rule: at least PLAYERS_UI.minPlayers sides (humans + computers), so host + computer may start alone.
  // One human is enough as long as another side (human or AI) plays.
  if (humans.length < 1) return 'lobby.status.waiting';
  if (open.length < PLAYERS_UI.minPlayers) return 'lobby.status.waiting'; // only one filled seat: waiting for a second side
  if (!humans.every((s) => s.ready)) return 'lobby.status.notReady';
  if (!hasEnoughAlliances(open.map((s) => s.alliance))) return 'lobby.status.oneAlliance';
  return null;
}

export class Lobby {
  constructor(transport) {
    this.transport = transport;
    this.channel = null;
    this.state = null;
    this.isHost = false;
    this.started = false;
    this.closed = false;
    this.mine = { nick: '', img: '', seat: null, race: null, color: null, ready: false };
    this.changeListeners = new Set();
    this.startListeners = new Set();
    this.unsubs = [];
    this.resendTimer = null;
    this.stateWaiter = null;
  }

  get selfId() { return this.transport?.selfId ?? null; }

  /** [UISMALL] Thumbnail (validated data URL) of a human player by player id, '' = none (the UI shows a silhouette) */
  avatarOf(playerId) {
    if (!playerId) return '';
    if (playerId === this.selfId) return this.mine.img;
    const peer = this.channel?.peers().find((p) => p.id === playerId);
    return netImage(peer?.presence?.img);
  }

  // ---------- public API ----------

  onChange(fn) { this.changeListeners.add(fn); return () => this.changeListeners.delete(fn); }
  onStart(fn) { this.startListeners.add(fn); return () => this.startListeners.delete(fn); }

  /** Host: opens a new game under a fresh random code */
  async create({ name, avatarImg } = {}) {
    this.mine.nick = String(name ?? '').slice(0, NICK_MAX);
    this.mine.img = netImage(avatarImg); // [UISMALL] own thumbnail, shown to the others in the seat list
    let code = null;
    for (let attempt = 0; attempt < 4 && !code; attempt++) {
      const candidate = randomCode();
      const ch = await this.transport.join(roomName(candidate));
      await sleep(NET.createProbeMs); // someone already in a room of this name? (codes are random, but be safe)
      if (ch.peers().some((p) => !p.isMe)) { await ch.leave(); continue; }
      this.channel = ch;
      code = candidate;
    }
    if (!code) throw new Error(t('lobby.error.generic'));
    this.isHost = true;
    this.state = { code, hostId: this.selfId, seats: TEAMS.map((_, team) => newSeat(team)), settings: {}, v: 0 };
    this.#subscribe();
    this.mine.seat = 0;
    await this.#pushPresence();
    this.#recompute(true);
    this.resendTimer = setInterval(() => this.#publish(), NET.lobbyResendMs);
  }

  /** Client: joins the game of a code; resolves once the host's lobby state arrived */
  async join(code, { name, avatarImg } = {}) {
    const norm = normalizeCode(code);
    if (!norm || norm.length > LOBBY.codeMaxLength) throw new Error(t('lobby.error.badCode'));
    this.mine.nick = String(name ?? '').slice(0, NICK_MAX);
    this.mine.img = netImage(avatarImg); // [UISMALL]
    this.channel = await this.transport.join(roomName(norm));
    this.isHost = false;
    const got = new Promise((resolve) => { this.stateWaiter = resolve; });
    this.#subscribe();
    await this.#pushPresence();
    this.channel.send('lobby', { op: 'hello' });
    this.#scanPeers(this.channel.peers());
    const ok = await Promise.race([got, sleep(this.transport?.joinTimeoutMs ?? NET.joinTimeoutMs).then(() => false)]);
    this.stateWaiter = null;
    if (!ok || this.closed) {
      const key = this.closed ? null : this.transport?.joinFailureKey?.(); // P2P: relays down / strict NAT / no host
      await this.leave();
      throw new Error(t(key ?? 'lobby.error.notFound'));
    }
    // Convenience: sit down at the first free seat (the player can still switch)
    const free = this.state.seats.find((s) => s.open && s.controller === 'open' && !s.playerId);
    if (free && !this.started) await this.takeSeat(free.team);
  }

  takeSeat(team) {
    if (!Number.isInteger(team) || team < 0 || team >= TEAMS.length) return Promise.resolve();
    this.mine.seat = team;
    this.mine.ready = false;
    return this.#pushPresence();
  }

  leaveSeat() {
    this.mine.seat = null;
    this.mine.ready = false;
    return this.#pushPresence();
  }

  setRace(race) {
    this.mine.race = race == null ? null : String(race).slice(0, RACE_MAX);
    return this.#pushPresence();
  }

  setColor(color) {
    if (color != null && !COLOR_RE.test(String(color))) return Promise.resolve();
    this.mine.color = color == null ? null : String(color).toLowerCase();
    return this.#pushPresence();
  }

  setReady(ready) {
    this.mine.ready = !!ready;
    return this.#pushPresence();
  }

  /** Host only: merges game settings (plain JSON) */
  async setSettings(patch) {
    if (!this.isHost || !this.state) throw new Error(t('lobby.error.hostOnly'));
    const next = { ...(patch ?? {}) };
    if ('speed' in next && !GAME_SPEED.options.includes(next.speed)) delete next.speed; // [N4] only listed game speeds
    if ('prebuild' in next && !PREBUILD.options.includes(next.prebuild)) delete next.prebuild; // [N8] only listed minutes
    if ('startSet' in next) next.startSet = validStartSet(next.startSet, getStats()); // [N15] a listed set id, else the default
    if ('oreMultiplier' in next && !ORE_MULTIPLIER.options.includes(next.oreMultiplier)) delete next.oreMultiplier; // [B1]
    if ('startMultiplier' in next && !START_MULTIPLIER.options.includes(next.startMultiplier)) delete next.startMultiplier; // [D4]
    if ('startResearch' in next && !START_RESEARCH.options.includes(next.startResearch)) delete next.startResearch;
    if ('energyCap' in next && !ECONOMY.energyCaps.includes(next.energyCap)) delete next.energyCap; // [W5a]
    if ('populationCap' in next && !ECONOMY.populationCaps.includes(next.populationCap)) delete next.populationCap; // [W5a]
    if ('map' in next) next.map = validMapChoice(next.map); // [W5a] a map id or 'random'
    if ('infiniteDeposits' in next) delete next.infiniteDeposits; // [B1] replaced by oreMultiplier
    this.state.settings = clone({ ...this.state.settings, ...next });
    delete this.state.settings.infiniteDeposits;
    // A victory condition the start set cannot play (main building without one) falls back to the default condition
    this.state.settings.victory = validConditionForSet(this.state.settings.victory, this.state.settings.startSet, getStats());
    this.#recompute(true);
  }

  /** Host only: a free seat becomes a computer player { difficulty, race, color } (all optional, validated) */
  async addAi(team, { difficulty, race, color } = {}) {
    const seat = this.#hostSeat(team);
    if (seat.controller !== 'open' || !seat.open) return;
    Object.assign(clearSeat(seat), { controller: 'ai', ready: true });
    this.#applyAiFields(seat, { difficulty: difficulty ?? AIMENU.defaultDifficulty, race, color });
    this.#assignAiName(seat);
    this.#recompute(true);
  }

  /** Host only: the computer player leaves, the seat is free again */
  async removeAi(team) {
    const seat = this.#hostSeat(team);
    if (seat.controller !== 'ai') return;
    clearSeat(seat);
    this.#recompute(true);
  }

  /**
   * [N5b] Host only: opens / closes a seat (a closed seat is not in the game). Closing removes a computer player and
   * is refused for a seat with a human and when it would leave fewer than PLAYERS_UI.minPlayers open seats.
   */
  async setSeatOpen(team, open) {
    const seat = this.#hostSeat(team);
    const want = !!open;
    if (seat.open === want) return;
    if (!want) {
      if (seat.controller === 'human') throw new Error(t('lobby.error.seatTaken'));
      if (this.state.seats.filter((s) => s.open).length <= PLAYERS_UI.minPlayers) throw new Error(t('lobby.error.minSeats'));
      if (seat.controller === 'ai') clearSeat(seat);
    }
    seat.open = want;
    this.#recompute(true);
  }

  /** [N5b] Host only: alliance id of a seat (equal ids = allies; the id is a whole number below the seat count) */
  async setSeatAlliance(team, alliance) {
    const seat = this.#hostSeat(team);
    if (!isAllianceId(alliance, this.state.seats.length)) return;
    seat.alliance = alliance;
    this.#recompute(true);
  }

  /** [N5b] Host only: a whole layout at once, ids[k] for the k-th open seat (quick choices: everybody alone, 2 on 2) */
  async setAllianceLayout(ids) {
    if (!this.isHost || !this.state || this.started) throw new Error(t('lobby.error.hostOnly'));
    const open = this.state.seats.filter((s) => s.open);
    open.forEach((seat, k) => { if (isAllianceId(ids?.[k], this.state.seats.length)) seat.alliance = ids[k]; });
    this.#recompute(true);
  }

  /** [N5b] null when the host can start, else the i18n key of the reason */
  startProblem() { return this.state ? lobbyStartProblem(this.state.seats) : 'lobby.status.waiting'; }

  /** Host only: change of an AI seat. patch = { difficulty?, race?, color? } */
  async setAi(team, patch) {
    const seat = this.#hostSeat(team);
    if (seat.controller !== 'ai') return;
    this.#applyAiFields(seat, patch ?? {});
    this.#recompute(true);
  }

  /** Host only: every human seat ready (and enough of them; AI seats are always ready) → everybody starts */
  async start() {
    if (!this.isHost || !this.state || this.started) throw new Error(t('lobby.error.hostOnly'));
    this.#recompute(false);
    if (lobbyStartProblem(this.state.seats)) throw new Error(t('lobby.error.notReady'));
    const settings = clone(this.state.settings);
    const seed = randomSeed();
    // [W5a] Random map: drawn here from the seed among maps with enough starts; clients only get the result (settings.map)
    if (isRandomMap(settings.map)) {
      const players = playingSeats(this.state.seats).length;
      const maps = await loadMapCatalog();
      if (this.closed || this.started) return;
      settings.map = pickRandomMap(maps, players, seed);
      settings.startPicks = {}; // picks need a real map; starts then come from the seed
      settings.startPicksByTeam = {};
    }
    this.#recompute(false);
    if (lobbyStartProblem(this.state.seats)) throw new Error(t('lobby.error.notReady'));
    // [N5b] Pack the open seats: seat index (= team) is the order of the open seats; closed seats are not in the game
    const packed = clone(playingSeats(this.state.seats)).map((s, team) => ({ ...s, team })); // [MP-POLISH] empty seats dropped
    const payload = {
      code: this.state.code,
      hostId: this.state.hostId,
      seed,
      settings: {
        ...settings,
        playerCount: packed.length,
        alliances: normalizeAlliances(packed.map((s) => s.alliance)),
      },
      seats: packed,
      startAtMs: Date.now() + NET.startDelayMs,
    };
    this.state.started = payload;
    this.state.v++;
    this.#publish();
    for (let i = 0; i < NET.startRepeat; i++) {
      setTimeout(() => { if (!this.closed) this.channel?.send('start', payload); }, i * NET.startRepeatMs);
    }
    this.#begin(payload);
  }

  /** Leaves the lobby and the room (not after start: the match keeps the channel) */
  async leave() {
    const ch = this.channel;
    this.#stopListening();
    this.closed = true;
    this.changeListeners.clear();
    this.startListeners.clear();
    this.channel = null;
    if (ch && !this.started) await ch.leave();
  }

  // ---------- internals ----------

  #hostSeat(team) {
    if (!this.isHost || !this.state || this.started) throw new Error(t('lobby.error.hostOnly'));
    const seat = this.state.seats[team];
    if (!Number.isInteger(team) || !seat) throw new Error(t('lobby.error.generic'));
    return seat;
  }

  /**
   * [N6] Host: call sign + avatar of a computer seat. Deterministic from the game code and the seat index, skipping the
   * names of the other computer seats, so a name never repeats in one lobby. The result travels in the lobby state
   * (seat.aiName / seat.avatar): every player sees the same, nobody picks locally.
   */
  #assignAiName(seat, seats = this.state.seats) {
    const others = seats.filter((s) => s.team !== seat.team && s.controller === 'ai');
    const seed = hashSeed(this.state.code) + Math.imul(seat.team, AI_PLAYERS.seedStep);
    const id = aiIdentity(pickAiIndex(seed, usedNameIndices(others)));
    seat.aiName = id.name;
    seat.avatar = id.avatar;
  }

  #applyAiFields(seat, { difficulty, race, color }) {
    if (AIMENU.difficulties.includes(difficulty)) seat.difficulty = difficulty;
    if (typeof race === 'string' && race) seat.race = race.slice(0, RACE_MAX);
    if (typeof color === 'string' && COLOR_RE.test(color)) seat.color = color.toLowerCase();
  }

  #subscribe() {
    const ch = this.channel;
    this.unsubs.push(ch.on('lobby', ({ from, data }) => {
      if (!data || typeof data !== 'object') return;
      if (this.isHost) {
        if (data.op === 'hello') this.#publish();
      } else if (data.op === 'state' && data.state && from === data.state.hostId) {
        this.#applyState(data.state);
      }
    }));
    this.unsubs.push(ch.on('start', ({ from, data }) => {
      if (!this.isHost && this.state && from === this.state.hostId) this.#begin(data);
    }));
    this.unsubs.push(ch.onPeers((change) => {
      if (this.isHost) {
        this.#recompute(false);
        if (change.joined?.length) this.#publish();
      } else {
        this.#scanPeers(change.peers);
        const hostId = this.state?.hostId;
        if (hostId && (change.left ?? []).some((p) => p.id === hostId) && !this.started) {
          this.state = { ...this.state, hostLeft: true };
          this.#notify();
        }
      }
    }));
  }

  #stopListening() {
    for (const u of this.unsubs) { try { u(); } catch { /* gone */ } }
    this.unsubs = [];
    if (this.resendTimer) clearInterval(this.resendTimer);
    this.resendTimer = null;
  }

  /** Client: the host's state from its presence (field `lobby`, published by a peer about itself) */
  #scanPeers(peers) {
    for (const p of peers ?? []) {
      const st = p.presence?.lobby;
      if (!p.isMe && st && typeof st === 'object' && st.hostId === p.id) this.#applyState(st);
    }
  }

  #applyState(st) {
    if (this.isHost || this.started || this.closed) return;
    if (!Array.isArray(st.seats) || typeof st.code !== 'string') return;
    if (this.state && this.state.hostId === st.hostId && (st.v ?? 0) < (this.state.v ?? 0)) return; // older copy
    const changed = JSON.stringify(st) !== JSON.stringify(this.state);
    this.state = clone(st);
    if (this.stateWaiter) { this.stateWaiter(true); this.stateWaiter = null; }
    if (st.started) { this.#begin(st.started); return; }
    if (changed) this.#notify();
  }

  #pushPresence() {
    if (!this.channel) return Promise.resolve();
    const m = this.mine;
    const p = this.channel.setPresence({ nick: m.nick, img: m.img, seat: m.seat, race: m.race, color: m.color, ready: m.ready });
    return Promise.resolve(p).then(() => { if (this.isHost) this.#recompute(true); });
  }

  /** Host: everybody's presence → seat list. Publishes when something changed (or when forced). */
  #recompute(force) {
    if (!this.isHost || !this.state || this.started) return;
    const peers = new Map(this.channel.peers().map((p) => [p.id, p]));
    const seats = this.state.seats.map((s) => ({ ...s }));
    const wants = (pid, team) => peers.get(pid)?.presence?.seat === team;
    // 1. seats whose player left or moved become free
    for (const s of seats) {
      if (s.controller === 'human' && !(s.open && s.playerId && wants(s.playerId, s.team))) clearSeat(s);
    }
    // 2. new claims, first come first served (peer list order)
    const seated = new Set(seats.filter((s) => s.playerId).map((s) => s.playerId));
    for (const p of peers.values()) {
      const team = p.presence?.seat;
      if (seated.has(p.id) || !Number.isInteger(team) || !seats[team]) continue;
      if (seats[team].controller !== 'open' || !seats[team].open) continue; // AI and closed seats are never claimed
      seats[team].controller = 'human';
      seats[team].playerId = p.id;
      seated.add(p.id);
    }
    // 3. seat details from the owner's presence; AI seats from the settings
    for (const s of seats) {
      if (s.controller === 'human') {
        const pr = peers.get(s.playerId)?.presence ?? {};
        s.nickname = String(pr.nick ?? '').slice(0, NICK_MAX);
        s.race = typeof pr.race === 'string' ? pr.race.slice(0, RACE_MAX) : null;
        s.color = typeof pr.color === 'string' && COLOR_RE.test(pr.color) ? pr.color.toLowerCase() : null;
        s.ready = !!pr.ready;
      } else if (s.controller === 'ai') {
        // AI seat: set by the host (addAi / setAi); always ready, no player behind it
        s.playerId = null;
        s.nickname = '';
        s.ready = true;
        if (!AIMENU.difficulties.includes(s.difficulty)) s.difficulty = AIMENU.defaultDifficulty;
        const id = cleanAiIdentity(s);
        if (id) { s.aiName = id.name; s.avatar = id.avatar; } else this.#assignAiName(s, seats); // [N6] never without a call sign
      }
    }
    this.#uniqueColors(seats);
    const changed = JSON.stringify(seats) !== JSON.stringify(this.state.seats);
    if (changed) this.state.seats = seats;
    if (changed || force) {
      this.state.v++;
      this.#publish();
      this.#notify();
    }
  }

  /**
   * [MP-POLISH] Every open seat gets its own colour in the published state. Chosen colours win (team order); a pick
   * too similar to an earlier one, or a seat without a pick (default = its team colour), takes the first free palette
   * colour. Deterministic from the seat list, so repeated recomputes do not flip colours.
   */
  #uniqueColors(seats) {
    const palette = MENU.teamPalette.map((p) => p.color);
    const taken = [];
    const give = (s, want) => {
      const c = taken.every((o) => !colorsTooSimilar(o, want)) ? want : (firstDistinctColor(palette, taken) ?? want);
      s.color = c;
      taken.push(c);
    };
    const active = seats.filter((s) => s.open && s.controller !== 'open');
    for (const s of active) if (s.color) give(s, s.color);
    for (const s of active) if (!s.color) give(s, (TEAMS[s.team]?.color ?? palette[0]).toLowerCase());
  }

  /** Host: state into own presence (late joiners, reliable) + a 'lobby' message (fast) */
  #publish() {
    if (!this.isHost || !this.state || !this.channel || this.closed) return;
    const st = clone(this.state);
    this.channel.setPresence({ lobby: st });
    this.channel.send('lobby', { op: 'state', state: st });
  }

  #begin(payload) {
    if (this.started || this.closed || !payload || typeof payload !== 'object') return;
    if (!Array.isArray(payload.seats) || !Number.isFinite(payload.seed)) return;
    this.started = true;
    this.#stopListening();
    const seats = clone(payload.seats);
    const me = this.selfId;
    const mySeat = seats.find((s) => s.controller === 'human' && s.playerId && s.playerId === me);
    const info = {
      ...clone(payload),
      seats,
      localTeam: mySeat ? mySeat.team : null, // null = spectator (joined but had no seat)
      // [MP-LEAVE] name = lobby nickname (Lockstep.nameOf: "player X left" messages)
      players: seats.filter((s) => s.controller === 'human' && s.playerId).map((s) => ({ team: s.team, playerId: s.playerId, name: s.nickname ?? '' })),
      // computer players (main.js creates the AI only on the host: info.hostId === info.selfId)
      aiSeats: seats.filter((s) => s.controller === 'ai').map((s) => ({ team: s.team, difficulty: s.difficulty ?? AIMENU.defaultDifficulty, aiName: s.aiName ?? null, avatar: s.avatar ?? null })),
      // [UISMALL] thumbnail of each seat's human ('' = silhouette), same order as seats; read now, while the peers are known
      avatarImgs: seats.map((s) => (s.controller === 'human' ? this.avatarOf(s.playerId) : '')),
      channel: this.channel,
      transport: this.transport,
      selfId: me,
    };
    for (const fn of [...this.startListeners]) { try { fn(info); } catch (err) { console.error('[lobby] onStart failed', err); } }
  }

  #notify() {
    for (const fn of [...this.changeListeners]) { try { fn(this.state); } catch (err) { console.error('[lobby] onChange failed', err); } }
  }
}
