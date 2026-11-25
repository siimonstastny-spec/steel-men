// Steel Men – multiplayer lobby (docs/MULTIPLAYER.md, "Lobby"). The host creates a game with a short code; the
// code is the room name. Everyone keeps their own wishes in PRESENCE (seat, nickname, race, colour, ready) – presence
// is absolute state, re-sent by the platform and handed to newcomers, so nothing gets lost. The host is the
// authority: it turns everybody's presence into the seat list and publishes it (its own presence field `lobby`
// + a 'lobby' message on every change and every NET.lobbyResendMs). Clients only display the host's state.
//
//   const lobby = new Lobby(transport)
//   await lobby.create({ name, avatarImg, gameName, visibility, password }) / await lobby.join(code, { name, avatarImg, password })
//   [LOBBY_LIST] gameName = shown name of the game (state.name), visibility 'public' (announced in the game list,
//   P2P only, src/net/LobbyDirectory.js) | 'code'; password = Trystero room password (P2P only, never stored or
//   published). Host only: setVisibility(v), kick(playerId) (the id goes to state.kicked; that client leaves with
//   lobby.error.kicked and cannot sit down again). lobby.visibility / lobby.locked / lobby.directoryActive() (host)
//   lobby.state  { code, name, kicked?: [playerId], hostId, seats: [{ team, controller: 'human'|'ai'|'open', playerId, nickname, race, color, ready,
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
//                             superweapons [A9-F3]: true / false (SUPERWEAPON.options), else dropped (missing = on),
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
// [A2-net] Continue lobby (saved multiplayer game, docs/notes/a2-net.md, contract docs/blocks/A2-contract.md §2):
//   await lobby.create({ ..., continueFrom: save })   host; save = SaveStore.get() object (kept locally, only a summary is published)
//   lobby.isContinue; lobby.state.continue = null | { name, mapId, mapName, durationTicks, simVersion,
//     seats: [{ team, race, color, alliance, originalController: 'human'|'ai', originalName, start }] }
//   Settings, race / colour / alliance / open of the seats are locked (the setters do nothing); AI seats of the
//   original match start filled with their AI. lobby.moveSeat(fromTeam, toTeam) (host, any player): swaps the occupants.
//   start(): every unoccupied seat gets an AI, the save is transferred to the seated humans (src/net/SaveTransfer.js),
//   then 'start' (payload.continue = { id, tick }); onStart info.continue = { save, tick }.
//   lobby.onContinueProgress(fn({ phase: 'send'|'receive', ratio, error?: i18n key })) -> unsubscribe
// [A2-net] state.simVersion = the host's SIM_VERSION; a client of another version leaves join() with lobby.error.simVersion
// and the host never seats a peer whose presence `sim` differs (every lobby, not only continue).
// [A4-SIM] up to MAX_PLAYERS (8) seats. Spectators (peers without a seat) are limited to SPECTATORS.max: the host lists
// the extra ones in state.full; such a joiner leaves join() with lobby.error.full when no open seat is free, and the
// host cannot start while more than SPECTATORS.max peers sit without a seat (lobby.status.tooManySpectators).
// More playing seats than the map has starts: startProblem() 'lobby.status.mapTooSmall', start() throws
// lobby.error.mapTooSmall, a client ignores such a start (its map catalogue loaded). lobby.mapSeatLimit() = starts of
// the chosen map (Random: the most of any map), null while the catalogue loads. Seats travel compacted (default fields
// left out, wireLobbyState / unwireLobbyState); lobby.state always holds full seats.
import { NET_SECURITY } from './netSecurity.js'; // [MP-SEC]
import { NET, TEAMS, LOBBY, PROFILE, AIMENU, GAME_SPEED, PLAYERS_UI, AI_PLAYERS, PREBUILD, UI_SMALL, MENU, ORE_MULTIPLIER, START_MULTIPLIER, START_RESEARCH, ECONOMY, SIM_VERSION, NET_CONTINUE, MAP_MODES, SUPERWEAPON, SPECTATORS } from '../config.js';
import { ensureFingerprint, isCompatible } from '../core/SaveStore.js'; // [A2-net]
import { SaveSender, SaveReceiver, encodeSave } from './SaveTransfer.js'; // [A2-net]
import { loadMapCatalog, validMapChoice, isRandomMap, pickRandomMap, maxMapPlayers } from '../game/MapCatalog.js'; // [W5a] Random map
import { colorsTooSimilar, firstDistinctColor } from '../core/ColorCheck.js'; // [MP-POLISH]
import { aiIdentity, cleanAiIdentity, hashSeed, pickAiIndex, usedNameIndices } from '../ai/AiProfiles.js'; // [N6]
import { hasEnoughAlliances, isAllianceId, normalizeAlliances } from '../core/AllianceSetup.js';
import { cleanAvatarImage } from '../core/PlayerLabels.js'; // [UISMALL] picture of a human player (small data URL)
import { LobbyAnnouncer } from './LobbyDirectory.js'; // [LOBBY_LIST]
import { supportsDirectory } from './transports/index.js';
import { cleanText } from './textClean.js';

// [UISMALL] A message / presence of the room is at most NET.maxMessageBytes, and the lobby state already travels in the
// host's presence, so pictures are NOT part of the state: everybody publishes a tiny thumbnail (UI_SMALL.humanAvatar.netMaxLength)
// in the own presence field `img`, and the others read it from the peer list (lobby.avatarOf).
const netImage = (value) => cleanAvatarImage(value, UI_SMALL.humanAvatar.netMaxLength);
import { validStartSet } from '../game/StartSets.js'; // [N15]
import { getStats } from '../data/Stats.js';
import { validConditionForSet } from '../game/Victory.js';
import { t } from '../i18n/i18n.js';

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const NICK_MAX = PROFILE.nicknameMaxLength; // [LOBBY_LIST] same limit as the profile and the game list
const RACE_MAX = 32;
// [A2-net] start settings that belong to the seats or to one client: not shown as locked lobby settings of a continue lobby
const CONTINUE_SEAT_KEYS = new Set(['races', 'colors', 'seats', 'aiDifficulty', 'aiNames', 'avatars', 'avatarImgs', 'seed', 'localTeam', 'isHost', 'multiplayer', 'playerCount', 'alliances']);

/** [LOBBY_LIST] Game name as shown / published: no control or bidi characters, trimmed, at most LOBBY.nameMaxLength */
export function cleanGameName(name) {
  return cleanText(name, LOBBY.nameMaxLength); // only invisible characters → '' → the caller uses the default name
}

/** [LOBBY_LIST] Password as handed to the transport ('' = none) */
const cleanPassword = (pw) => (typeof pw === 'string' ? pw.slice(0, LOBBY.passwordMaxLength) : '');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const utf8 = typeof TextEncoder === 'function' ? new TextEncoder() : null;
/** [A4-SIM] UTF-8 bytes of a value's JSON (upper bound without TextEncoder) */
export const jsonSize = (v) => { const s = JSON.stringify(v); return utf8 ? utf8.encode(s).length : s.length * 3; };

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

// [A4-SIM] seat fields left out on the wire while they hold their default (8 seats + continue summary must fit
// NET.maxMessageBytes); unwireLobbyState puts them back, so lobby.state seats always have every field
const SEAT_WIRE_DEFAULTS = { playerId: null, nickname: '', race: null, color: null, ready: false };

/** [A4-SIM] Lobby state as sent (host presence + 'lobby' message): seats without default-valued fields (a copy) */
export function wireLobbyState(state) {
  const st = clone(state);
  if (Array.isArray(st?.seats)) {
    st.seats = st.seats.map((s) => {
      const out = { ...s };
      for (const [k, v] of Object.entries(SEAT_WIRE_DEFAULTS)) if (out[k] === v) delete out[k];
      return out;
    });
  }
  return st;
}

/** [A4-SIM] Received lobby state → full seats (missing default fields restored; a copy) */
export function unwireLobbyState(st) {
  const out = clone(st);
  if (Array.isArray(out?.seats)) out.seats = out.seats.map((s) => (s && typeof s === 'object' ? { ...SEAT_WIRE_DEFAULTS, ...s } : s));
  return out;
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
 * [A4-SIM] opts.mapPlayers = starts of the chosen map (null = unknown, not checked); opts.spectators = peers without a
 * seat (more than SPECTATORS.max block the start).
 */
export function lobbyStartProblem(seats, { mapPlayers = null, spectators = 0 } = {}) {
  // [MP-POLISH] open seats nobody sits at are ignored (closed at the start) as long as enough seats are filled
  const open = playingSeats(seats);
  const humans = open.filter((s) => s.controller === 'human' && s.playerId);
  // [B1] rule: at least PLAYERS_UI.minPlayers sides (humans + computers), so host + computer may start alone.
  // One human is enough as long as another side (human or AI) plays.
  if (humans.length < 1) return 'lobby.status.waiting';
  if (open.length < PLAYERS_UI.minPlayers) return 'lobby.status.waiting'; // only one filled seat: waiting for a second side
  if (!humans.every((s) => s.ready)) return 'lobby.status.notReady';
  if (!hasEnoughAlliances(open.map((s) => s.alliance))) return 'lobby.status.oneAlliance';
  if (Number.isInteger(mapPlayers) && open.length > mapPlayers) return 'lobby.status.mapTooSmall'; // [A4-SIM]
  if (spectators > SPECTATORS.max) return 'lobby.status.tooManySpectators'; // [A4-SIM]
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
    // [MP-SEC] client: the host is pinned by the first valid state; a later claim of another peer is ignored
    this.hostPin = null;
    this.hostConflict = false;   // true once another peer claimed to be the host (UI may warn)
    this.code = null;            // code this client joined with (a state with another code is ignored)
    this.lastHelloAt = -Infinity;
    // [LOBBY_LIST]
    this.visibility = 'code';    // host: 'public' = announced in the game list (P2P only)
    this.locked = false;         // host: the game has a password
    this.announcer = null;       // host: LobbyAnnouncer while public
    this.announcerPending = false;
    this.banned = new Set();     // host: kicked player ids (in kick order; published as state.kicked)
    this.kicked = false;         // client: the host kicked us
    // [A2-net]
    this.simMismatch = false;    // client: the host runs another SIM_VERSION
    this.continueSave = null;    // host: the save of a continue lobby
    this.continuePayload = null; // host: its encoded form (encodeSave, cached between start attempts)
    this.contOrig = [];          // host: original AI identity per team { difficulty, aiName, avatar } | null
    this.overrides = new Map();  // host: playerId -> { team, from } seat set by moveSeat until the player's presence follows
    this.moveSeq = 0;            // host: counter of state.moves entries
    this.lastMoveN = 0;          // client: last applied state.moves entry
    this.transferring = false;   // host: the save is being sent (start() in progress)
    this.sender = null;          // host: SaveSender
    this.receiver = null;        // client: SaveReceiver
    this.progressListeners = new Set();
    this.continueProgress = null; // last onContinueProgress event
    this.missingSaveReported = false;
    // [A4-SIM]
    this.mapCatalog = null;      // GameMaps of the multiplayer maps (start counts), loaded on create / join
    this.oversizeWarned = false; // a state message over NET.maxMessageBytes was reported once in the console
    this.fullRefused = false;    // client: no seat free and the spectator places taken (join fails with lobby.error.full)
  }

  /** [A4-SIM] Start positions of the chosen map (Random: the most of any map); null while the catalogue loads */
  mapSeatLimit(settings = this.state?.settings) {
    if (!this.mapCatalog) return null;
    const id = validMapChoice(settings?.map, MAP_MODES.multiplayer);
    if (isRandomMap(id)) return maxMapPlayers(this.mapCatalog) || null;
    const m = this.mapCatalog.find((x) => x.id === id);
    return m ? m.players : null;
  }

  /** [A4-SIM] Peers in the room without a seat (spectators), the host included when it left its seat */
  spectatorCount() {
    if (!this.state || !this.channel) return 0;
    const seated = new Set(this.state.seats.filter((s) => s.playerId).map((s) => s.playerId));
    const kicked = new Set(this.state.kicked ?? []);
    // [A4] peers of another SIM_VERSION never get a seat: they take no spectator place
    return this.channel.peers().filter((p) => !seated.has(p.id) && !kicked.has(p.id) && (p.id === this.selfId || p.presence?.sim === SIM_VERSION)).length;
  }

  /** [A4-SIM] loads the map catalogue once (start counts for the seat limit); a change refreshes the start problem */
  #loadMaps() {
    loadMapCatalog(MAP_MODES.multiplayer).then((maps) => {
      if (this.closed) return;
      this.mapCatalog = maps;
      this.#notify();
    }).catch((err) => console.warn('[lobby] map catalogue failed', err));
  }

  /** [A2-net] Is this a continue lobby (saved game)? */
  get isContinue() { return !!this.state?.continue; }

  /** [A2-net] fn({ phase: 'send'|'receive', ratio 0..1, error?: i18n key }) – transfer of the save. Returns unsubscribe. */
  onContinueProgress(fn) { this.progressListeners.add(fn); return () => this.progressListeners.delete(fn); }

  #progress(ev) {
    this.continueProgress = ev;
    for (const fn of [...this.progressListeners]) { try { fn(ev); } catch (err) { console.error('[lobby] onContinueProgress failed', err); } }
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
  async create({ name, avatarImg, gameName, visibility, password, continueFrom = null } = {}) {
    const cont = continueFrom ? await this.#prepareContinue(continueFrom) : null; // [A2-net] throws before any room is joined
    this.mine.nick = String(name ?? '').slice(0, NICK_MAX);
    this.mine.img = netImage(avatarImg); // [UISMALL] own thumbnail, shown to the others in the seat list
    const pw = cleanPassword(password); // [LOBBY_LIST] kept only inside the transport's room, never in the state
    this.locked = !!pw && supportsDirectory(this.transport);
    // only P2P has the game list: elsewhere the game is always 'code'
    this.visibility = !supportsDirectory(this.transport) ? 'code' : LOBBY.visibilities.includes(visibility) ? visibility : LOBBY.defaultVisibility;
    const title = cleanGameName(gameName) || cleanGameName(t('lobby.defaultName', { name: this.mine.nick || t('common.player') }));
    let code = null;
    for (let attempt = 0; attempt < 4 && !code; attempt++) {
      const candidate = randomCode();
      const ch = await this.transport.join(roomName(candidate), { password: pw });
      await sleep(NET.createProbeMs); // someone already in a room of this name? (codes are random, but be safe)
      if (ch.peers().some((p) => !p.isMe)) { await ch.leave(); continue; }
      this.channel = ch;
      code = candidate;
    }
    if (!code) throw new Error(t('lobby.error.generic'));
    this.isHost = true;
    this.state = { code, name: title, hostId: this.selfId, seats: TEAMS.map((_, team) => newSeat(team)), settings: {}, v: 0, simVersion: SIM_VERSION };
    this.#subscribe();
    this.mine.seat = 0;
    if (cont) this.#applyContinue(cont); // [A2-net] locked settings, fixed seats, original AI seats filled
    await this.#pushPresence();
    this.#recompute(true);
    this.resendTimer = setInterval(() => this.#publish(), NET.lobbyResendMs);
    this.#syncAnnouncer();
    this.#loadMaps(); // [A4-SIM]
  }

  /** Client: joins the game of a code; resolves once the host's lobby state arrived */
  async join(code, { name, avatarImg, password } = {}) {
    const norm = normalizeCode(code);
    if (!norm || norm.length > LOBBY.codeMaxLength) throw new Error(t('lobby.error.badCode'));
    this.mine.nick = String(name ?? '').slice(0, NICK_MAX);
    this.mine.img = netImage(avatarImg); // [UISMALL]
    const pw = cleanPassword(password);
    // watchPassword: P2P also detects a mismatch that Trystero reports only to the host (P2PSignalWatch)
    this.channel = await this.transport.join(roomName(norm), { password: pw, watchPassword: true });
    this.isHost = false;
    this.code = norm;
    this.#loadMaps(); // [A4-SIM] the client checks a start against the map too
    const got = new Promise((resolve) => { this.stateWaiter = resolve; });
    // [LOBBY_LIST] P2P: a peer used another password. Another joiner with a wrong password causes the same signal, so
    // the host's state still has LOBBY.passwordGraceMs to arrive before we give up.
    let pwTimer = null;
    let unsubPw = null;
    const wrongPw = new Promise((resolve) => {
      const arm = () => { pwTimer ??= setTimeout(() => resolve(false), LOBBY.passwordGraceMs); };
      unsubPw = this.transport?.onPasswordError?.(arm) ?? null;
      if (this.transport?.passwordErrors > 0) arm(); // reported while transport.join still waited for a relay
    });
    this.#subscribe();
    // [A2-net] continue lobby: the save arrives in chunks from the pinned host once it starts
    this.receiver = new SaveReceiver({
      channel: this.channel,
      hostId: () => this.hostPin,
      onProgress: (ratio) => this.#progress({ phase: 'receive', ratio }),
      onError: (key) => this.#progress({ phase: 'receive', ratio: 0, error: key }),
    });
    await this.#pushPresence();
    this.channel.send('lobby', { op: 'hello' });
    this.#scanPeers(this.channel.peers());
    const ok = await Promise.race([got, wrongPw, sleep(this.transport?.joinTimeoutMs ?? NET.joinTimeoutMs).then(() => false)]);
    clearTimeout(pwTimer);
    unsubPw?.();
    this.channel?.stopPasswordWatch?.(); // [LOBBY_LIST] host state arrived (or we give up): stop the P2P watch
    this.stateWaiter = null;
    if (!ok || this.closed) {
      // P2P: relays down / wrong password / strict NAT / no host
      let key = this.kicked ? 'lobby.error.kicked' : this.simMismatch ? 'lobby.error.simVersion' : this.fullRefused ? 'lobby.error.full' : this.closed ? null : this.transport?.joinFailureKey?.(); // [A2-net] [A4-SIM]
      // [LOBBY_LIST] fallback: with a password typed, "nobody answered" may still be a password mismatch we did not see
      if (key === 'net.p2p.error.hostNotFound' && pw && supportsDirectory(this.transport)) key = 'lobby.error.passwordOrGone';
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
    if (this.isContinue) return Promise.resolve(); // [A2-net] fixed by the save
    this.mine.race = race == null ? null : String(race).slice(0, RACE_MAX);
    return this.#pushPresence();
  }

  setColor(color) {
    if (this.isContinue) return Promise.resolve(); // [A2-net] fixed by the save
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
    if (this.isContinue) return; // [A2-net] settings of the saved match are locked
    const next = { ...(patch ?? {}) };
    if ('speed' in next && !GAME_SPEED.options.includes(next.speed)) delete next.speed; // [N4] only listed game speeds
    if ('prebuild' in next && !PREBUILD.options.includes(next.prebuild)) delete next.prebuild; // [N8] only listed minutes
    if ('startSet' in next) next.startSet = validStartSet(next.startSet, getStats()); // [N15] a listed set id, else the default
    if ('oreMultiplier' in next && !ORE_MULTIPLIER.options.includes(next.oreMultiplier)) delete next.oreMultiplier; // [B1]
    if ('startMultiplier' in next && !START_MULTIPLIER.options.includes(next.startMultiplier)) delete next.startMultiplier; // [D4]
    if ('startResearch' in next && !START_RESEARCH.options.includes(next.startResearch)) delete next.startResearch;
    if ('superweapons' in next && !SUPERWEAPON.options.includes(next.superweapons)) delete next.superweapons; // [A9-F3] true / false only
    if ('energyCap' in next && !ECONOMY.energyCaps.includes(next.energyCap)) delete next.energyCap; // [W5a]
    if ('populationCap' in next && !ECONOMY.populationCaps.includes(next.populationCap)) delete next.populationCap; // [W5a]
    if ('map' in next) next.map = validMapChoice(next.map, MAP_MODES.multiplayer); // [W5a] a map id or 'random'
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
    if (this.isContinue) { // [A2-net] race / colour fixed; an original AI seat gets its own call sign back
      const o = this.contOrig[team];
      this.#applyAiFields(seat, { difficulty: difficulty ?? o?.difficulty ?? AIMENU.defaultDifficulty });
      if (o?.aiName) { seat.aiName = o.aiName; seat.avatar = o.avatar; } else this.#assignAiName(seat);
    } else {
      this.#applyAiFields(seat, { difficulty: difficulty ?? AIMENU.defaultDifficulty, race, color });
      this.#assignAiName(seat);
    }
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
    if (this.isContinue) return; // [A2-net] the seats of the saved match are fixed
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
    if (this.isContinue) return; // [A2-net]
    if (!isAllianceId(alliance, this.state.seats.length)) return;
    seat.alliance = alliance;
    this.#recompute(true);
  }

  /** [N5b] Host only: a whole layout at once, ids[k] for the k-th open seat (quick choices: everybody alone, 2 on 2) */
  async setAllianceLayout(ids) {
    if (!this.isHost || !this.state || this.started) throw new Error(t('lobby.error.hostOnly'));
    if (this.isContinue) return; // [A2-net]
    const open = this.state.seats.filter((s) => s.open);
    open.forEach((seat, k) => { if (isAllianceId(ids?.[k], this.state.seats.length)) seat.alliance = ids[k]; });
    this.#recompute(true);
  }

  /** [N5b] null when the host can start, else the i18n key of the reason */
  startProblem() {
    if (!this.state) return 'lobby.status.waiting';
    return lobbyStartProblem(this.state.seats, { mapPlayers: this.isContinue ? null : this.mapSeatLimit(), spectators: this.spectatorCount() }); // [A4-SIM]
  }

  /** Host only: change of an AI seat. patch = { difficulty?, race?, color? } */
  async setAi(team, patch) {
    const seat = this.#hostSeat(team);
    if (seat.controller !== 'ai') return;
    this.#applyAiFields(seat, this.isContinue ? { difficulty: patch?.difficulty } : (patch ?? {})); // [A2-net] race / colour fixed
    this.#recompute(true);
  }

  /** Host only: every human seat ready (and enough of them; AI seats are always ready) → everybody starts */
  async start() {
    if (!this.isHost || !this.state || this.started) throw new Error(t('lobby.error.hostOnly'));
    if (this.isContinue) return this.#startContinue(); // [A2-net]
    this.#recompute(false);
    if (lobbyStartProblem(this.state.seats)) throw new Error(t('lobby.error.notReady'));
    const settings = clone(this.state.settings);
    const seed = randomSeed();
    // [W5a] Random map: drawn here from the seed among maps with enough starts; clients only get the result (settings.map)
    if (isRandomMap(settings.map)) {
      const players = playingSeats(this.state.seats).length;
      const maps = await loadMapCatalog(MAP_MODES.multiplayer);
      if (this.closed || this.started) return;
      settings.map = pickRandomMap(maps, players, seed);
      settings.startPicks = {}; // picks need a real map; starts then come from the seed
      settings.startPicksByTeam = {};
    }
    this.#recompute(false);
    if (lobbyStartProblem(this.state.seats, { spectators: this.spectatorCount() })) throw new Error(t('lobby.error.notReady'));
    // [A4-SIM] never more players than the map has starts (the map would reuse starts)
    this.mapCatalog ??= await loadMapCatalog(MAP_MODES.multiplayer);
    if (this.closed || this.started) return;
    const starts = this.mapSeatLimit(settings);
    if (Number.isInteger(starts) && playingSeats(this.state.seats).length > starts) throw new Error(t('lobby.error.mapTooSmall'));
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
    this.#announceStart(payload);
  }

  /** Host: the start payload to everybody (state + repeated 'start' messages), then the own start */
  #announceStart(payload) {
    this.state.started = payload;
    this.state.v++;
    this.#publish();
    for (let i = 0; i < NET.startRepeat; i++) {
      setTimeout(() => { if (!this.closed) this.channel?.send('start', payload); }, i * NET.startRepeatMs);
    }
    this.#begin(payload);
  }

  // ---------- [A2-net] continue lobby ----------

  /**
   * Host: swaps the occupants (human / AI / nobody) of two seats; race, colour, team and alliance stay with the seat.
   * Works for any player: the host's choice wins over the player's own seat wish until its presence follows
   * (state.moves tells the client). Ignored while the save is being sent.
   */
  async moveSeat(fromTeam, toTeam) {
    const a = this.#hostSeat(fromTeam);
    const b = this.#hostSeat(toTeam);
    if (a === b || !a.open || !b.open || this.transferring) return;
    const oa = this.#occupant(a);
    const ob = this.#occupant(b);
    this.#place(b, oa);
    this.#place(a, ob);
    this.#recompute(true);
    if ((oa && oa.pid === this.selfId) || (ob && ob.pid === this.selfId)) this.#pushPresence();
  }

  #occupant(seat) {
    if (seat.controller === 'human' && seat.playerId) return { pid: seat.playerId };
    if (seat.controller === 'ai') return { ai: { difficulty: seat.difficulty, aiName: seat.aiName, avatar: seat.avatar } };
    return null;
  }

  #place(seat, occ) {
    clearSeat(seat);
    if (!occ) return;
    if (occ.ai) {
      Object.assign(seat, { controller: 'ai', ready: true });
      for (const k of ['difficulty', 'aiName', 'avatar']) if (occ.ai[k] !== undefined) seat[k] = occ.ai[k];
      return;
    }
    seat.controller = 'human';
    seat.playerId = occ.pid;
    if (occ.pid === this.selfId) { this.mine.seat = seat.team; return; }
    const prev = this.overrides.get(occ.pid);
    const from = prev ? prev.from : (this.channel?.peers().find((p) => p.id === occ.pid)?.presence?.seat ?? null);
    this.overrides.set(occ.pid, { team: seat.team, from });
    this.state.moves = { ...(this.state.moves ?? {}), [occ.pid]: { team: seat.team, n: ++this.moveSeq } };
  }

  /** Host: checks the save and builds the lobby summary (before any room is joined) */
  async #prepareContinue(save) {
    const corrupt = () => new Error(t('net.continue.error.corrupt'));
    if (!save || typeof save !== 'object' || !save.meta || !save.settings || !save.end || !Number.isInteger(save.end.tick)) throw corrupt();
    if (!save.meta.multiplayer || !save.settings.multiplayer) throw new Error(t('net.continue.error.notMultiplayer'));
    await ensureFingerprint([save.meta.map]);
    const compat = isCompatible(save.meta);
    if (!compat.ok) throw new Error(t(compat.reason === 'simVersion' ? 'lobby.error.simVersion' : compat.reason === 'data' ? 'net.continue.error.data' : 'net.continue.error.corrupt'));
    const s = save.settings;
    const count = Math.min(TEAMS.length, Number(save.meta.playerCount ?? s.playerCount ?? s.races?.length ?? 0) | 0);
    if (count < PLAYERS_UI.minPlayers) throw corrupt();
    const players = Array.isArray(save.meta.players) ? save.meta.players : [];
    const seats = [];
    const orig = [];
    for (let team = 0; team < count; team++) {
      const p = players.find((x) => x?.team === team) ?? {};
      const ai = (p.seat ?? s.seats?.[team]) === 'ai';
      const color = [p.color, s.colors?.[team], TEAMS[team].color].find((c) => typeof c === 'string' && COLOR_RE.test(c));
      const pick = s.startPicks?.[team];
      seats.push({
        team,
        race: typeof (p.race ?? s.races?.[team]) === 'string' ? String(p.race ?? s.races[team]).slice(0, RACE_MAX) : null,
        color: color.toLowerCase(),
        alliance: isAllianceId(s.alliances?.[team], TEAMS.length) ? s.alliances[team] : team,
        originalController: ai ? 'ai' : 'human',
        originalName: cleanText(String(p.name ?? ''), NICK_MAX),
        start: Number.isInteger(p.start) ? p.start : Number.isInteger(pick) ? pick : null,
      });
      orig.push(ai ? {
        difficulty: AIMENU.difficulties.includes(s.aiDifficulty?.[team]) ? s.aiDifficulty[team] : AIMENU.defaultDifficulty,
        aiName: s.aiNames?.[team] ?? null, avatar: s.avatars?.[team] ?? null,
      } : null);
    }
    const settings = {};
    for (const [k, v] of Object.entries(s)) if (!CONTINUE_SEAT_KEYS.has(k)) settings[k] = v;
    if (GAME_SPEED.options.includes(save.mp?.speed)) settings.speed = save.mp.speed; // the speed when it was saved
    const summary = {
      name: cleanGameName(String(save.meta.name ?? '')), mapId: String(save.meta.map), mapName: String(save.meta.mapName ?? save.meta.map),
      durationTicks: save.end.tick, simVersion: save.meta.simVersion, seats,
    };
    const humanTeams = seats.filter((x) => x.originalController === 'human').map((x) => x.team);
    const hostTeam = humanTeams.includes(s.localTeam) ? s.localTeam : (humanTeams[0] ?? null);
    return { save, summary, settings: clone(settings), orig, hostTeam };
  }

  /** Host: the new lobby state takes the saved match's seats and settings */
  #applyContinue(cont) {
    this.continueSave = cont.save;
    this.contOrig = cont.orig;
    this.state.continue = cont.summary;
    this.state.settings = cont.settings;
    for (const seat of this.state.seats) {
      const c = cont.summary.seats[seat.team];
      clearSeat(seat);
      seat.open = !!c;
      if (!c) continue;
      seat.alliance = c.alliance;
      const o = cont.orig[seat.team];
      if (o) {
        Object.assign(seat, { controller: 'ai', ready: true, difficulty: o.difficulty });
        if (o.aiName) { seat.aiName = o.aiName; seat.avatar = o.avatar; }
      }
    }
    this.mine.seat = cont.hostTeam;
  }

  /**
   * Host, continue lobby: unoccupied seats get an AI (original AI: its difficulty and call sign, else
   * NET_CONTINUE.aiFallbackDifficulty), the save goes to every seated human, then the normal start.
   * Rejects with an Error (message = translated text, `key` = i18n key) when the transfer fails; the lobby stays open.
   */
  async #startContinue() {
    if (this.transferring) return;
    this.#recompute(false);
    const cont = this.state.continue;
    const seats = clone(this.state.seats);
    for (const s of seats) {
      const c = cont.seats[s.team];
      if (!c || s.controller !== 'open') continue;
      const o = this.contOrig[s.team];
      Object.assign(s, { controller: 'ai', ready: true, playerId: null, nickname: '' });
      s.difficulty = o?.difficulty ?? (AIMENU.difficulties.includes(NET_CONTINUE.aiFallbackDifficulty) ? NET_CONTINUE.aiFallbackDifficulty : AIMENU.defaultDifficulty);
      if (o?.aiName) { s.aiName = o.aiName; s.avatar = o.avatar; } else this.#assignAiName(s, seats);
    }
    if (lobbyStartProblem(seats, { spectators: this.spectatorCount() })) throw new Error(t('lobby.error.notReady')); // [A4-SIM]
    const packed = clone(playingSeats(seats));
    // the saved match's teams must stay what they were (every saved seat is open and now filled, nothing else)
    if (packed.length !== cont.seats.length || packed.some((s, i) => s.team !== i)) throw new Error(t('lobby.error.generic'));
    const save = this.continueSave;
    const id = `${this.state.code}-${randomInt(0x7fffffff).toString(36)}`;
    const payload = {
      code: this.state.code,
      hostId: this.state.hostId,
      seed: save.settings.seed,
      settings: { ...clone(this.state.settings), playerCount: packed.length, alliances: normalizeAlliances(packed.map((s) => s.alliance)) },
      seats: packed,
      continue: { id, tick: save.end.tick },
    };
    const targets = packed.filter((s) => s.controller === 'human' && s.playerId && s.playerId !== this.selfId).map((s) => s.playerId);
    this.transferring = true;
    this.#notify();
    try {
      this.#progress({ phase: 'send', ratio: 0 });
      this.continuePayload ??= await encodeSave(save);
      if (this.closed) return;
      if (targets.length) {
        this.sender = new SaveSender({
          channel: this.channel, id, payload: this.continuePayload, targets,
          onProgress: (ratio) => this.#progress({ phase: 'send', ratio }),
        });
        await this.sender.run();
      }
    } catch (err) {
      const key = typeof err?.key === 'string' ? err.key : 'net.continue.error.generic';
      if (!err?.key) console.error('[lobby] save transfer failed', err);
      if (!this.closed) this.channel?.send(NET_CONTINUE.topic, { op: 'x', id, key }); // clients drop the partial save
      this.#progress({ phase: 'send', ratio: 0, error: key });
      throw Object.assign(new Error(t(key)), { key });
    } finally {
      this.transferring = false;
      this.sender = null;
      if (!this.closed && !this.started) this.#recompute(true);
    }
    if (this.closed || this.started) return;
    payload.startAtMs = Date.now() + NET.startDelayMs;
    this.#progress({ phase: 'send', ratio: 1 });
    this.#announceStart(payload);
  }

  /** [LOBBY_LIST] Host only: 'public' (in the game list, P2P only) or 'code' (join by code only) */
  setVisibility(visibility) {
    if (!this.isHost || !this.state || this.started) throw new Error(t('lobby.error.hostOnly'));
    if (!LOBBY.visibilities.includes(visibility) || visibility === this.visibility) return;
    if (visibility === 'public' && !supportsDirectory(this.transport)) return; // no game list outside P2P
    this.visibility = visibility;
    this.#syncAnnouncer();
    this.#notify();
  }

  /** [LOBBY_LIST] Host: is the game being announced in the public list right now (or about to be)? */
  directoryActive() { return !!(this.announcer || this.announcerPending); }

  /**
   * [LOBBY_LIST] Host only: removes a human player. The id goes to state.kicked (reliable through the host presence):
   * that client leaves with lobby.error.kicked; its later seat claims are ignored for the rest of this lobby.
   */
  kick(playerId) {
    if (!this.isHost || !this.state || this.started) throw new Error(t('lobby.error.hostOnly'));
    if (typeof playerId !== 'string' || !playerId || playerId === this.selfId || playerId.length > NET_SECURITY.maxPeerIdLength) return;
    this.banned.delete(playerId);
    this.banned.add(playerId);
    while (this.banned.size > LOBBY.kickedMax) this.banned.delete(this.banned.values().next().value);
    this.state.kicked = [...this.banned];
    this.#recompute(true);
  }

  /** Leaves the lobby and the room (not after start: the match keeps the channel) */
  async leave() {
    const ch = this.channel;
    this.#stopListening();
    this.#stopAnnouncer(); // [LOBBY_LIST] 'closed' to the game list
    this.closed = true;
    this.sender?.cancel(); // [A2-net]
    this.receiver?.dispose();
    this.receiver = null;
    this.continueSave = null; // [A2-net]
    this.continuePayload = null;
    this.progressListeners.clear();
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
        if (data.op === 'hello') { // [MP-SEC] rate limited: a flood of hellos must not flood the room with full states
          const now = Date.now();
          if (now - this.lastHelloAt >= NET_SECURITY.helloMinIntervalMs) { this.lastHelloAt = now; this.#publish(); }
        }
      } else if (data.op === 'state' && data.state && typeof data.state === 'object' && from === data.state.hostId) {
        this.#applyState(data.state);
      }
    }));
    this.unsubs.push(ch.on('start', ({ from, data }) => {
      // [MP-SEC] only from the pinned host, and only once a valid state of that host was accepted
      if (!this.isHost && this.state && this.hostPin !== null && from === this.hostPin) this.#begin(data);
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
          if (this.receiver?.active) this.#progress({ phase: 'receive', ratio: 0, error: 'net.continue.error.hostLeft' }); // [A2-net]
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

  // ---- [LOBBY_LIST] public game list (host) ----

  #wantsAnnouncer() {
    return this.isHost && !!this.state && !this.started && !this.closed && this.visibility === 'public' && supportsDirectory(this.transport);
  }

  /** Starts / stops the announcer to match the visibility (creation is async: re-checked when it resolves) */
  #syncAnnouncer() {
    if (!this.#wantsAnnouncer()) { this.#stopAnnouncer(); return; }
    if (this.announcer || this.announcerPending) return;
    this.announcerPending = true;
    LobbyAnnouncer.create(() => this.#directoryInfo()).then((a) => {
      this.announcerPending = false;
      if (!a) return;
      if (this.announcer || !this.#wantsAnnouncer()) { a.dispose(); return; }
      this.announcer = a;
    });
  }

  #stopAnnouncer() {
    const a = this.announcer;
    this.announcer = null;
    if (a) a.close().catch(() => a.dispose());
  }

  /** What the game list shows about our game */
  #directoryInfo() {
    const st = this.state;
    if (!st) return null;
    const open = st.seats.filter((s) => s.open);
    return {
      code: st.code,
      name: st.name,
      host: this.mine.nick,
      map: validMapChoice(st.settings?.map, MAP_MODES.multiplayer),
      n: open.filter((s) => s.controller !== 'open').length,
      max: open.length,
      lock: this.locked,
    };
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
    if (!this.#validState(st)) return;
    st = unwireLobbyState(st); // [A4-SIM] compacted seats → full seats
    // [MP-SEC] the host is whoever sent the first valid state; a different claimant later (hijack attempt) is ignored
    if (this.hostPin === null) this.hostPin = st.hostId;
    else if (st.hostId !== this.hostPin) {
      if (!this.hostConflict) console.warn('[lobby] another peer claims to be the host – ignored', st.hostId);
      this.hostConflict = true;
      return;
    }
    if (this.state && (st.v ?? 0) < (this.state.v ?? 0)) return; // older copy
    // [A2-net] another simulation version cannot play with us: join() fails with lobby.error.simVersion
    if (st.simVersion !== SIM_VERSION) {
      if (!this.simMismatch) console.warn(`[lobby] host runs simulation version ${st.simVersion}, this client ${SIM_VERSION}`);
      this.simMismatch = true;
      if (this.stateWaiter) { this.stateWaiter(false); this.stateWaiter = null; }
      return;
    }
    // [A2-net] the host moved us to another seat (moveSeat): our presence follows, so the seat stays ours
    const mv = st.moves && typeof st.moves === 'object' ? st.moves[this.selfId] : null;
    if (mv && Number.isInteger(mv.n) && mv.n > this.lastMoveN && Number.isInteger(mv.team) && mv.team >= 0 && mv.team < TEAMS.length) {
      this.lastMoveN = mv.n;
      if (this.mine.seat !== mv.team) { this.mine.seat = mv.team; this.#pushPresence(); }
    }
    // [LOBBY_LIST] the host kicked us: join() fails with lobby.error.kicked, a joined client sees state.kicked
    if (Array.isArray(st.kicked) && st.kicked.includes(this.selfId)) {
      if (this.kicked) return;
      this.kicked = true;
      if (this.stateWaiter) { this.stateWaiter(false); this.stateWaiter = null; return; }
      this.state = { ...(this.state ?? clone(st)), kicked: true };
      this.#notify();
      return;
    }
    // [A4-SIM] joining while every seat is taken and the spectator places are full: join() fails with lobby.error.full
    if (this.stateWaiter && !st.started && Array.isArray(st.full) && st.full.includes(this.selfId)
      && !st.seats.some((s) => s.open && s.controller === 'open' && !s.playerId)) {
      this.fullRefused = true;
      this.stateWaiter(false);
      this.stateWaiter = null;
      return;
    }
    const changed = JSON.stringify(st) !== JSON.stringify(this.state);
    this.state = clone(st);
    if (this.stateWaiter) { this.stateWaiter(true); this.stateWaiter = null; }
    if (st.started) { this.#begin(st.started); return; }
    if (changed) this.#notify();
  }

  /** [MP-SEC] Is this a plausible lobby state of OUR game (code), claimed by someone else than us? */
  #validState(st) {
    if (!st || typeof st !== 'object' || !Array.isArray(st.seats) || st.seats.length !== TEAMS.length) return false;
    if (typeof st.code !== 'string' || (this.code && normalizeCode(st.code) !== this.code)) return false;
    if (typeof st.hostId !== 'string' || !st.hostId || st.hostId.length > NET_SECURITY.maxPeerIdLength || st.hostId === this.selfId) return false;
    if (st.v !== undefined && !Number.isFinite(st.v)) return false;
    if (st.settings !== undefined && (typeof st.settings !== 'object' || st.settings === null || Array.isArray(st.settings))) return false;
    if (st.name !== undefined && typeof st.name !== 'string') return false; // [LOBBY_LIST] (shown cut + escaped)
    if (st.kicked !== undefined && (!Array.isArray(st.kicked) || st.kicked.length > LOBBY.kickedMax)) return false;
    // [A2-net] continue summary / seat moves: plain objects
    if (st.continue != null && (typeof st.continue !== 'object' || !Array.isArray(st.continue.seats) || st.continue.seats.length > TEAMS.length)) return false;
    if (st.moves != null && (typeof st.moves !== 'object' || Array.isArray(st.moves))) return false;
    if (st.full !== undefined && (!Array.isArray(st.full) || st.full.length > LOBBY.kickedMax)) return false; // [A4-SIM] same bound as the kick list
    return st.seats.every((s) => s && typeof s === 'object');
  }

  /** [MP-SEC] Is this a plausible start payload (seat list sized for the match, bounded ids)? */
  #validStart(p) {
    if (!p || typeof p !== 'object' || !Array.isArray(p.seats) || !Number.isFinite(p.seed)) return false;
    if (p.seats.length < 1 || p.seats.length > TEAMS.length) return false;
    // [A4-SIM] more players than the map has starts (a fresh match; a continued one keeps its saved starts)
    if (!p.continue && this.mapCatalog && p.settings && typeof p.settings === 'object') {
      const starts = this.mapSeatLimit(p.settings);
      if (Number.isInteger(starts) && p.seats.length > starts) { console.warn('[lobby] start ignored: more players than map starts'); return false; }
    }
    if (p.continue != null && (typeof p.continue !== 'object' || typeof p.continue.id !== 'string' || !Number.isInteger(p.continue.tick))) return false; // [A2-net]
    const humans = new Set();
    const teams = new Set();
    for (const s of p.seats) {
      if (!s || typeof s !== 'object' || !Number.isInteger(s.team) || s.team < 0 || s.team >= TEAMS.length || teams.has(s.team)) return false;
      teams.add(s.team);
      if (s.controller === 'human') {
        if (typeof s.playerId !== 'string' || !s.playerId || s.playerId.length > NET_SECURITY.maxPeerIdLength || humans.has(s.playerId)) return false;
        humans.add(s.playerId);
      }
    }
    return true;
  }

  #pushPresence() {
    if (!this.channel) return Promise.resolve();
    const m = this.mine;
    const p = this.channel.setPresence({ nick: m.nick, img: m.img, seat: m.seat, race: m.race, color: m.color, ready: m.ready, sim: SIM_VERSION }); // [A2-net] sim
    return Promise.resolve(p).then(() => { if (this.isHost) this.#recompute(true); });
  }

  /** Host: everybody's presence → seat list. Publishes when something changed (or when forced). */
  #recompute(force) {
    if (!this.isHost || !this.state || this.started) return;
    const peers = new Map(this.channel.peers().map((p) => [p.id, p]));
    const seats = this.state.seats.map((s) => ({ ...s }));
    // [A2-net] a seat set by moveSeat wins until the player's presence follows (or the player wishes something else)
    let movesChanged = false;
    for (const [pid, o] of this.overrides) {
      const seatWish = peers.get(pid)?.presence?.seat ?? null;
      if (!peers.has(pid) || seatWish === o.team || seatWish !== o.from) {
        this.overrides.delete(pid);
        if (this.state.moves?.[pid]) { delete this.state.moves[pid]; movesChanged = true; }
      }
    }
    const seatOf = (pid) => (pid === this.selfId ? this.mine.seat : this.overrides.has(pid) ? this.overrides.get(pid).team : peers.get(pid)?.presence?.seat);
    // [A2-net] a peer of another simulation version is never seated (its own join() fails with lobby.error.simVersion)
    const compatible = (pid) => pid === this.selfId || peers.get(pid)?.presence?.sim === SIM_VERSION;
    const wants = (pid, team) => seatOf(pid) === team && compatible(pid);
    // 1. seats whose player left, moved or was kicked [LOBBY_LIST] become free
    for (const s of seats) {
      if (s.controller === 'human' && !(s.open && s.playerId && wants(s.playerId, s.team) && !this.banned.has(s.playerId))) clearSeat(s);
    }
    // 2. new claims, first come first served (peer list order)
    const seated = new Set(seats.filter((s) => s.playerId).map((s) => s.playerId));
    for (const p of peers.values()) {
      const team = seatOf(p.id);
      if (seated.has(p.id) || this.banned.has(p.id) || !compatible(p.id) || !Number.isInteger(team) || !seats[team]) continue;
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
    const cont = this.state.continue;
    if (cont) {
      // [A2-net] race, colour, alliance and open come from the saved match, whoever sits there
      for (const s of seats) {
        const c = cont.seats[s.team];
        s.open = !!c;
        if (!c) continue;
        s.race = c.race;
        s.color = c.color;
        s.alliance = c.alliance;
      }
    } else this.#uniqueColors(seats);
    const changed = JSON.stringify(seats) !== JSON.stringify(this.state.seats);
    if (changed) this.state.seats = seats;
    const fullChanged = this.#updateFull(peers, seats); // [A4-SIM]
    if (changed || force || movesChanged || fullChanged) {
      this.state.v++;
      this.#publish();
      this.#notify();
      this.announcer?.update(); // [LOBBY_LIST] players / map changed: refresh the game list entry (rate limited)
    }
  }

  /**
   * [A4-SIM] Host: peers without a seat beyond SPECTATORS.max (peer list order = first come first served; the host
   * itself, when it left its seat, takes one of the places) → state.full. Returns true when the list changed.
   */
  #updateFull(peers, seats) {
    const seated = new Set(seats.filter((s) => s.playerId).map((s) => s.playerId));
    const unseated = [...peers.values()].filter((p) => p.id !== this.selfId && !seated.has(p.id) && !this.banned.has(p.id) && p.presence?.sim === SIM_VERSION).map((p) => p.id);
    const places = Math.max(0, SPECTATORS.max - (seated.has(this.selfId) ? 0 : 1));
    const full = unseated.slice(places);
    const before = JSON.stringify(this.state.full ?? []);
    if (full.length) this.state.full = full; else delete this.state.full;
    return before !== JSON.stringify(full);
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
    // [A4-SIM] default = the palette colour of the seat position (TEAMS colours are overwritten by a running match)
    for (const s of active) if (!s.color) give(s, (palette[s.team] ?? TEAMS[s.team]?.color ?? palette[0]).toLowerCase());
  }

  /** Host: state into own presence (late joiners, reliable) + a 'lobby' message (fast) */
  #publish() {
    if (!this.isHost || !this.state || !this.channel || this.closed) return;
    const st = wireLobbyState(this.state); // [A4-SIM] compact seats
    this.channel.setPresence({ lobby: st });
    const msg = { op: 'state', state: st };
    // [A4-SIM] a state over the room limit still reaches everybody through the presence (P2P presence is not limited)
    if (jsonSize(msg) > NET.maxMessageBytes) {
      if (!this.oversizeWarned) console.warn(`[lobby] state of ${jsonSize(msg)} B is over NET.maxMessageBytes – sent in the presence only`);
      this.oversizeWarned = true;
      return;
    }
    this.channel.send('lobby', msg);
  }

  #begin(payload) {
    if (this.started || this.closed || !payload || typeof payload !== 'object') return;
    if (!this.#validStart(payload)) return;
    // [MP-SEC] a client takes the host from its pin, never from the payload (Lockstep gives the host AI / speed rights)
    if (!this.isHost) payload = { ...payload, hostId: this.hostPin };
    // [A2-net] continued match: the save must be here (host: its own; client: transferred before the start)
    let cont = null;
    if (payload.continue) {
      const save = this.isHost ? this.continueSave : this.receiver?.result(payload.continue.id);
      if (!save || save.end?.tick !== payload.continue.tick) {
        if (!this.missingSaveReported) {
          this.missingSaveReported = true;
          console.warn('[lobby] continued match started, but the save did not arrive here');
          this.#progress({ phase: 'receive', ratio: 0, error: 'net.continue.error.transfer' });
        }
        return;
      }
      cont = { save, tick: save.end.tick };
    }
    this.receiver?.dispose();
    this.receiver = null;
    this.started = true;
    this.#stopListening();
    this.#stopAnnouncer(); // [LOBBY_LIST] the game left the list ('closed')
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
      continue: cont, // [A2-net] null | { save, tick } – main.js: continueMultiplayer (src/net/MpContinue.js)
    };
    // [A2-net] the save now lives only in info.continue (main.js drops it after the restore): free the lobby's copies
    this.continueSave = null;
    this.continuePayload = null;
    for (const fn of [...this.startListeners]) { try { fn(info); } catch (err) { console.error('[lobby] onStart failed', err); } }
  }

  #notify() {
    for (const fn of [...this.changeListeners]) { try { fn(this.state); } catch (err) { console.error('[lobby] onChange failed', err); } }
  }
}
