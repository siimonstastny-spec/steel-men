// Steel Men – saved games as replays [J1] (docs/notes/j1-save-core.md). A save = match settings + seed + every
// non-AI command from tick 0 (commandBus.recorded) + checkpoints; restoring starts the same match on a fresh page and
// re-runs the simulation headless (no effects, sounds, drawing of projectiles) up to the saved tick. Computer players
// run live during the replay (they are deterministic, ai.rng): their inner state comes back by itself and only the
// checkpoint hashes (incl. the command hash) prove they decided the same.
//   noteMatchStart(settings, seed)  – main.js startGame, right before startSimulation(seed)
//   await buildSave(name)           – save object of the running single-player match
//   await restore(save, { onProgress(fraction), signal, paused })  – fresh page only (canRestoreHere())
//   startAutosave(intervalSec?) / stopAutosave() / await autosaveNow()
// [A2-net] Multiplayer (docs/notes/a2-net.md): the host saves (canSave / buildSave, meta.multiplayer, every team's commands,
// AI included, no live teams); a continue lobby restores on every client with restoreMultiplayer(save, { info }) –
// no live AI during the replay, checkpoint parts hash without the AI subsystems (partsHashMp).
import { SAVE, SIM_VERSION, GAME_VERSION, SIM, SEATS, PLAYER_TEAM, MAP_MODE_ANY } from '../config.js';
import { commandBus, recordable } from './commands/CommandBus.js';
import { updateAis } from '../ai/index.js';
import { hashParts, PART_NAMES } from '../debug/DeterminismHarness.js';
import { setSoundMuted } from '../audio/Sound.js';
import { currentFingerprint, ensureFingerprint, isCompatible, put } from '../core/SaveStore.js';
import { validMapId } from './MapCatalog.js';
import { raceName } from '../data/Stats.js';
import { playerLabel } from '../core/PlayerLabels.js';
import { getSettings } from '../core/Profile.js';
import { t } from '../i18n/i18n.js';
import { gameSpeed } from './GameSpeed.js'; // [A2-net] speed of a saved multiplayer match (not simulation state)

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const DT = 1 / SIM.tickRate;
const MS_PER_SECOND = 1000;
const LOCAL_SETTINGS = new Set(['avatarImgs']); // client-local / bulky start settings that never reach the simulation
const NUMBER_TAG = '$num';                      // JSON-safe form of ±Infinity / NaN inside the settings

const handle = () => {
  const h = window.steelMen;
  if (!h?.world || !h?.commandBus || !h?.startGame) throw saveError('noHandle', 'steelMen debug handle missing (main.js not ready)');
  return h;
};

/** Error with a code for the UI: 'hash' (state differs), 'incompatible', 'reloadRequired', 'cancelled', … */
function saveError(code, message, details = undefined) {
  return Object.assign(new Error(message), { code, details, cancelled: code === 'cancelled' });
}

// ---------- match start (main.js) ----------

let match = null;        // { settings, liveTeams, multiplayer, testScene } of the running match
let matchesStarted = 0;  // matches set up on this page (restore needs a fresh page)
let restoring = false;

const seatOf = (settings, team) => settings.seats?.[team] ?? SEATS.defaults[team] ?? SEATS.defaultOther;

function cleanSettings(settings) {
  const text = JSON.stringify(settings ?? {}, (key, value) => {
    if (LOCAL_SETTINGS.has(key) || typeof value === 'function') return undefined;
    if (typeof value === 'number' && !Number.isFinite(value)) return { [NUMBER_TAG]: String(value) };
    return value;
  });
  return JSON.parse(text);
}

function reviveSettings(settings) {
  return JSON.parse(JSON.stringify(settings), (key, value) => (
    value && typeof value === 'object' && Object.keys(value).length === 1 && typeof value[NUMBER_TAG] === 'string'
      ? Number(value[NUMBER_TAG]) : value));
}

/**
 * main.js startGame calls this right before startSimulation(seed), with the settings it was given and the seed it
 * resolved. Sets which teams the record leaves out (AI seats, re-run live on restore) and the checkpoint hash.
 */
export function noteMatchStart(settings, seed) {
  matchesStarted++;
  const clean = cleanSettings(settings);
  clean.seed = seed;
  clean.localTeam = settings?.localTeam ?? PLAYER_TEAM;
  const count = window.steelMen?.game?.playerCount || settings?.races?.length || SEATS.defaults.length;
  const multiplayer = Boolean(settings?.multiplayer);
  // [A2-net] Multiplayer: AI commands travel like a player's and are recorded with everything else (no live teams);
  // the checkpoint hash leaves out the AI subsystems (only the host has AI objects, a restore replays without them)
  const liveTeams = multiplayer ? [] : Array.from({ length: count }, (_, team) => team).filter((team) => seatOf(clean, team) === 'ai');
  commandBus.liveTeams = liveTeams;
  commandBus.checkpointHash = multiplayer ? partsHashMp : partsHash;
  let testScene = false;
  try { testScene = new URLSearchParams(window.location.search).get('test') === '1'; } catch { /* no location */ }
  if (multiplayer) testScene = false; // the test scene is never built in multiplayer
  commandBus.recording = !testScene; // [A2-net] multiplayer records too (the host saves); ?test=1: only the command hash runs
  match = { settings: clean, liveTeams, multiplayer, testScene, isHost: multiplayer && Boolean(settings?.isHost) };
  ensureFingerprint([validMapId(clean.map, MAP_MODE_ANY)]).catch((err) => console.warn('[SaveGame] fingerprint', err));
}

/** One number over the determinism subsystems (core, rng, units, economy, production, research, projectiles, ai) */
function partsHash(world) {
  const { parts } = hashParts(world, false);
  let h = FNV_OFFSET;
  for (const name of PART_NAMES) h = Math.imul(h ^ (parts[name] ?? 0), FNV_PRIME);
  return h >>> 0;
}

// [A2-net] Subsystems that depend on live AI objects (only the multiplayer host has them; a multiplayer restore replays
// the AI's recorded commands without AI objects): left out of the multiplayer checkpoint hash, world.rng mixed in instead
const AI_PARTS = new Set(['ai', 'rng']);
const MP_PART_NAMES = PART_NAMES.filter((name) => !AI_PARTS.has(name));

/** [A2-net] partsHash without the AI subsystems – the same on the host, the clients and a restore */
function partsHashMp(world) {
  const { parts } = hashParts(world, false);
  let h = Math.imul(FNV_OFFSET ^ (world.rng?.state ?? 0), FNV_PRIME);
  for (const name of MP_PART_NAMES) h = Math.imul(h ^ (parts[name] ?? 0), FNV_PRIME);
  return h >>> 0;
}

/** Checkpoint hash of the running match (the one noteMatchStart installed in the bus) */
const matchPartsHash = (world) => (match?.multiplayer ? partsHashMp(world) : partsHash(world));

export const isRestoring = () => restoring;
/** Settings of the running / restored match as noteMatchStart kept them (seed, map, seats…; a copy), null before any */
export const matchSettings = () => (match ? JSON.parse(JSON.stringify(match.settings)) : null);
/** Display name of the running match's map (map file "name", else the id), '' before any match */
export function matchMapName() {
  const h = window.steelMen;
  return h?.world?.map?.name ?? (match ? validMapId(match.settings.map, MAP_MODE_ANY) : '');
}
/** Can restore() run on this page? (false once any match was set up – then scheduleRestore + reload) */
export const canRestoreHere = () => matchesStarted === 0 && (window.steelMen?.world?.tick ?? 0) === 0;
/**
 * Can the running match be saved? (single player or [A2-net] the multiplayer host; not while restoring, not the
 * ?test=1 scene, not over, not after the host ended a stuck match)
 */
export function canSave() {
  const h = window.steelMen;
  if (match?.multiplayer && (!match.isHost || h?.net?.status?.ended)) return false;
  return Boolean(match && !match.testScene && !restoring && h?.world && !h.game?.match?.result);
}

// ---------- building a save ----------

/** [A2-net] Index into map.startPositions of each team's start (game.bases holds the very objects; else by position) */
function startIndices(h, count) {
  const starts = h.world?.map?.startPositions ?? [];
  return Array.from({ length: count }, (_, team) => {
    const base = h.game?.bases?.[team];
    if (!base) return null;
    let i = starts.indexOf(base);
    if (i < 0) i = starts.findIndex((p) => p && p.x === base.x && p.z === base.z);
    return i >= 0 ? i : null;
  });
}

function playersMeta(settings, count, h = window.steelMen) {
  const me = settings.localTeam ?? PLAYER_TEAM;
  const multiplayer = Boolean(settings.multiplayer);
  const starts = startIndices(h ?? {}, count);
  return Array.from({ length: count }, (_, team) => {
    const race = settings.races?.[team] ?? settings.races?.[0] ?? null;
    let seat = seatOf(settings, team);
    // [A2-net] multiplayer: the original controller only ('remote' = another human); name = lobby nickname
    if (multiplayer) seat = seat === 'ai' ? 'ai' : 'human';
    const lobbyName = multiplayer && seat === 'human' ? (h?.net?.nameOf?.(team) ?? '') : '';
    const name = lobbyName || playerLabel(team) || (team === me ? (getSettings().nickname || t('common.player')) : t('ping.player', { n: team + 1 }));
    return { team, name, race, raceName: race ? raceName(race) : '', seat, color: settings.colors?.[team] ?? null, start: starts[team] };
  });
}

/**
 * Save object of the running single-player match or [A2-net] multiplayer match (host only; every team's commands, AI
 * included) – the record is copied synchronously, before any await.
 * @param {string} name
 * @param {{ auto?: boolean }} [opts]
 */
export async function buildSave(name, { auto = false } = {}) {
  const { world, game } = handle();
  if (!match) throw saveError('noMatch', 'no match is running');
  if (match.multiplayer && !match.isHost) throw saveError('multiplayer', 'only the host saves a multiplayer match');
  if (match.testScene) throw saveError('testScene', 'the ?test=1 scene cannot be saved');
  if (restoring) throw saveError('restoring', 'a saved game is being restored');
  if (game?.match?.result) throw saveError('ended', 'the match is over');
  const live = match.liveTeams;
  const tick = world.tick;
  const commands = commandBus.recorded.slice();
  const checkpoints = commandBus.checkpoints.slice();
  const pending = commandBus.pending
    .filter((p) => !live.includes(p.cmd.team))
    .map((p) => [p.tick, p.cmd.team, JSON.parse(JSON.stringify(recordable(p.cmd)))]);
  const { parts } = hashParts(world, false);
  const end = { tick, stateHash: world.stateHash(), partsHash: matchPartsHash(world), commandHash: commandBus.commandHash >>> 0, parts };
  const settings = JSON.parse(JSON.stringify(match.settings));
  const mapId = validMapId(settings.map, MAP_MODE_ANY);
  const count = game?.playerCount || settings.races?.length || SEATS.defaults.length;
  const players = playersMeta(settings, count);
  const multiplayer = Boolean(match.multiplayer);
  const mp = multiplayer ? { speed: gameSpeed.value } : undefined; // [A2-net] the continued match starts at this speed
  const fingerprint = await currentFingerprint(mapId);
  return {
    format: SAVE.format,
    formatVersion: SAVE.formatVersion,
    meta: {
      name: String(name ?? ''), date: new Date().toISOString(), auto: Boolean(auto),
      map: mapId, mapName: matchMapName() || mapId, players, playerCount: count,
      durationTicks: tick, durationSec: Math.floor(tick / SIM.tickRate), tickRate: SIM.tickRate,
      simVersion: SIM_VERSION, gameVersion: GAME_VERSION, fingerprint,
      commandCount: commands.length, thumbnail: null,
      ...(multiplayer ? { multiplayer: true } : {}), // [A2-net] SaveLoadView filter 'mp'
    },
    settings, liveTeams: [...live], commands, pending, checkpoints, end,
    ...(mp ? { mp } : {}),
  };
}

// ---------- restoring ----------

// Fast yield (no 4 ms timer clamp): the browser handles loads / input / painting between chunks
let yieldChannel = null;
const yieldWaiters = [];
function nextTask() {
  if (typeof MessageChannel !== 'function') return new Promise((r) => setTimeout(r, 0));
  if (!yieldChannel) {
    yieldChannel = new MessageChannel();
    yieldChannel.port1.onmessage = () => yieldWaiters.shift()?.();
  }
  return new Promise((r) => { yieldWaiters.push(r); yieldChannel.port2.postMessage(0); });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** One tick exactly like main.js simTick without its visual-only parts (interpolation, HQ beams, damage smoke) */
function stepOnce(h) {
  const { world, game } = h;
  h.commandBus.executeTick(world, world.tick + 1);
  world.update(DT);
  game.match?.update(DT);
  updateAis(world.tick / SIM.tickRate);
}

function checkCheckpoint(expected, actual) {
  if (expected[0] !== actual[0]) return null; // different ticks: compared when the matching one arrives
  if (expected[1] !== actual[1]) return 'state';
  if (expected[2] !== actual[2]) return 'parts';
  if (expected[3] !== actual[3]) return 'commands';
  return '';
}

function validateSave(save) {
  const ok = save && save.format === SAVE.format && Number.isInteger(save.formatVersion) && save.formatVersion <= SAVE.formatVersion
    && save.settings && Array.isArray(save.commands) && Array.isArray(save.checkpoints) && save.end && Number.isInteger(save.end.tick);
  if (!ok) throw saveError('incompatible', 'not a valid save', { reason: 'corrupt' });
}

const setHeadless = (world, on) => { world.effects?.setHeadless?.(on); setSoundMuted(on); };

/**
 * Restores a save on a fresh page: starts the same match (main.js startGame, world.paused), replays the record
 * headless as fast as possible in chunks (yield every SAVE.replayChunkMs), checks every checkpoint and the final
 * hashes, and ends at the saved tick, paused (world.paused stays true unless `paused: false`).
 * Throws an Error with `code`: 'incompatible' (details.reason), 'reloadRequired', 'multiplayer', 'cancelled',
 * 'hash' (details: { tick, kind: 'state' | 'parts' | 'commands' | 'ended', parts? }). After a failure the page holds
 * a half-replayed match: reload it.
 * @returns {Promise<{ tick: number, stateHash: number, ms: number }>}
 */
export async function restore(save, { onProgress = null, signal = null, paused = true } = {}) {
  validateSave(save);
  if (save.settings.multiplayer) throw saveError('multiplayer', 'a multiplayer save continues through the lobby (Lobby continueFrom)');
  await checkLoadable(save);
  return replaySave(save, reviveSettings(save.settings), { onProgress, signal, paused });
}

// [A2-net] start settings that describe who sits where now (taken from the continue lobby, never from the save)
const SEAT_SETTINGS = ['seats', 'aiDifficulty', 'aiNames', 'avatars', 'avatarImgs', 'localTeam', 'isHost'];

/**
 * [A2-net] Start settings of a continued multiplayer match: everything the simulation reads comes from the save
 * (seed, map, starts, races, colours, alliances, rules), who sits where from the continue lobby's start info.
 * isHost is false here on purpose: no live AI is created during the replay (main.js creates it afterwards on the host).
 */
function continueSettings(save, info) {
  const base = reviveSettings(save.settings);
  for (const k of SEAT_SETTINGS) delete base[k];
  const count = base.playerCount ?? base.races?.length ?? 0;
  const byTeam = Array.from({ length: count }, (_, team) => info.seats?.find((s) => s?.team === team) ?? {});
  return {
    ...base,
    multiplayer: true,
    isHost: false,
    localTeam: info.localTeam ?? PLAYER_TEAM,
    seats: byTeam.map((s) => (s.playerId && s.playerId === info.selfId ? 'human' : s.controller === 'human' ? 'remote' : 'ai')),
    aiDifficulty: byTeam.map((s) => (s.controller === 'ai' ? s.difficulty ?? null : null)),
    aiNames: byTeam.map((s) => s.aiName ?? null),
    avatars: byTeam.map((s) => s.avatar ?? null),
    avatarImgs: byTeam.map((_, team) => info.avatarImgs?.[team] ?? ''),
    speed: save.mp?.speed ?? base.speed,
  };
}

/**
 * [A2-net] Restores a saved multiplayer match on every client of a continue lobby (fresh page): starts the match with
 * continueSettings, replays every team's record headless WITHOUT live AI, checks the checkpoints (state + the
 * multiplayer parts hash without AI subsystems + command hash) and the end hashes. The lockstep is not involved
 * (it must not be started yet; Lockstep({ startTick: tick }) goes on from here). Ends at the saved tick with
 * world.paused = `paused` (default false: the not-yet-started lockstep holds the loop).
 * Errors like restore() ('multiplayer' = not a multiplayer save).
 * @param {object} save
 * @param {{ info: object, onProgress?: Function, signal?: AbortSignal, paused?: boolean, onStall?: Function, stallMs?: number }} o
 *   info = Lobby onStart info (seats, localTeam, selfId, hostId, avatarImgs)
 * @returns {Promise<{ tick, stateHash, partsHash, commandHash, ms }>}
 */
export async function restoreMultiplayer(save, { info, onProgress = null, signal = null, paused = false, onStall = null, stallMs = Infinity } = {}) {
  validateSave(save);
  if (!save.settings.multiplayer) throw saveError('multiplayer', 'not a multiplayer save');
  if ((save.liveTeams ?? []).length) throw saveError('incompatible', 'multiplayer save with live teams', { reason: 'corrupt' });
  await checkLoadable(save);
  const isHost = Boolean(info?.selfId) && info.selfId === info.hostId;
  const res = await replaySave(save, continueSettings(save, info ?? {}), { onProgress, signal, paused, onStall, stallMs });
  if (match) {
    match.isHost = isHost; // from now on the host may save the continued match again
    match.settings.isHost = isHost;
  }
  const { world } = handle();
  return { ...res, partsHash: matchPartsHash(world), commandHash: commandBus.commandHash >>> 0 };
}

/** Compatible (SIM_VERSION, data fingerprint) and a fresh page, else throws */
async function checkLoadable(save) {
  await ensureFingerprint([save.meta?.map]);
  const compat = isCompatible(save.meta);
  if (!compat.ok) throw saveError('incompatible', `save not compatible (${compat.reason})`, { reason: compat.reason });
  if (!canRestoreHere()) throw saveError('reloadRequired', 'restore needs a fresh page (scheduleRestore + reload)');
}

/**
 * Starts the match with `startSettings` and replays the save to its end tick (shared by restore and
 * [A2-net] restoreMultiplayer). onStall(): a load held the replay for stallMs of real time (multiplayer offers the host to end).
 */
async function replaySave(save, startSettings, { onProgress = null, signal = null, paused = true, onStall = null, stallMs = Infinity } = {}) {
  const h = handle();
  const { world } = h;
  const endTick = save.end.tick;
  const t0 = performance.now(); // progress / report only, never read by the simulation
  const report = (fraction) => { try { onProgress?.(fraction); } catch (err) { console.error(err); } };
  const cancelled = () => saveError('cancelled', 'restore cancelled');
  restoring = true;
  world.paused = true;
  setHeadless(world, true);
  commandBus.beginReplay(save.commands);
  try {
    report(0);
    await h.startGame(startSettings);
    if (world.tick !== 0) throw saveError('loopTicked', 'the game loop ticked during the restore (world.paused not wired in main.js)');
    if (!sameTeams(commandBus.liveTeams, save.liveTeams ?? [])) throw saveError('hash', 'AI seats differ from the save', { tick: 0, kind: 'seats' });
    const startShare = SAVE.progressStartShare;
    report(startShare);
    const expected = save.checkpoints;
    let nextExpected = 0;
    let chunkStart = performance.now();
    let heldSince = null; // [A2-net] real time a load holds the replay (stall notice only)
    let stallReported = false;
    while (world.tick < endTick) {
      if (signal?.aborted) throw cancelled();
      if (h.game.match?.result) throw saveError('hash', `the match ended at tick ${world.tick}, the save is at ${endTick}`, { tick: world.tick, kind: 'ended' });
      if (!world.readyForTick()) { // a produced unit's model is still loading
        heldSince ??= performance.now();
        if (!stallReported && performance.now() - heldSince >= stallMs) { stallReported = true; try { onStall?.(); } catch (err) { console.error(err); } }
        await wait(SAVE.replayWaitMs);
        continue;
      }
      heldSince = null;
      stepOnce(h);
      // the bus recorded a new checkpoint at the start of this tick: compare it with the saved one
      const got = commandBus.checkpoints;
      while (nextExpected < expected.length && got.length && expected[nextExpected][0] <= got[got.length - 1][0]) {
        const exp = expected[nextExpected++];
        const act = got.find((c) => c[0] === exp[0]);
        const kind = act ? checkCheckpoint(exp, act) : 'state';
        if (kind) throw saveError('hash', `saved game differs at tick ${exp[0]} (${kind})`, { tick: exp[0], kind });
      }
      if (performance.now() - chunkStart >= SAVE.replayChunkMs) {
        report(startShare + (1 - startShare) * (world.tick / Math.max(1, endTick)));
        const before = world.tick;
        await nextTask();
        if (world.tick !== before) throw saveError('loopTicked', 'the game loop ticked during the restore (world.paused not wired in main.js)');
        chunkStart = performance.now();
      }
    }
    const now = { stateHash: world.stateHash(), partsHash: matchPartsHash(world), commandHash: commandBus.commandHash >>> 0 };
    if (now.stateHash !== save.end.stateHash || now.partsHash !== save.end.partsHash || now.commandHash !== save.end.commandHash) {
      const { parts } = hashParts(world, false);
      const names = match?.multiplayer ? MP_PART_NAMES : PART_NAMES; // [A2-net] the host's AI parts are not comparable
      const diff = save.end.parts ? names.filter((n) => parts[n] !== save.end.parts[n]) : [];
      const kind = now.stateHash !== save.end.stateHash ? 'state' : now.partsHash !== save.end.partsHash ? 'parts' : 'commands';
      throw saveError('hash', `saved game differs at its end tick ${endTick} (${kind}${diff.length ? `: ${diff.join(', ')}` : ''})`, { tick: endTick, kind, parts: diff });
    }
    if (commandBus.replayLeft > 0) throw saveError('hash', `${commandBus.replayLeft} recorded commands after the end tick`, { tick: endTick, kind: 'commands' });
  } finally {
    commandBus.endReplay();
    setHeadless(world, false);
    restoring = false;
  }
  // Commands the player had issued for the next tick when saving
  for (const [tick, team, rec] of save.pending ?? []) commandBus.enqueue(tick, { ...rec, team, origin: rec.origin === null ? null : 'replay' });
  world.paused = Boolean(paused);
  report(1);
  const ms = Math.round(performance.now() - t0);
  console.info(`[SaveGame] restored tick ${world.tick} in ${ms} ms (${Math.round(world.tick / Math.max(1, ms / MS_PER_SECOND))} ticks/s)`);
  return { tick: world.tick, stateHash: world.stateHash(), ms };
}

function sameTeams(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------- autosave ----------

const auto = { timer: 0, everyTicks: 0, nextTick: 0, busy: false };

/**
 * Autosave into the single slot every `intervalSec` of game time (checked every SAVE.autosaveCheckMs of real time;
 * nothing happens while the game is paused / restoring / over / multiplayer). Call after a single-player match started.
 */
export function startAutosave(intervalSec = SAVE.autosaveSeconds) {
  stopAutosave();
  const { world } = handle();
  auto.everyTicks = Math.max(1, Math.round(intervalSec * SIM.tickRate));
  auto.nextTick = world.tick + auto.everyTicks;
  auto.timer = setInterval(autosaveCheck, SAVE.autosaveCheckMs);
}

export function stopAutosave() {
  if (auto.timer) clearInterval(auto.timer);
  auto.timer = 0;
}

function autosaveCheck() {
  const h = window.steelMen;
  if (!h?.world || auto.busy || !canSave() || h.world.tick < auto.nextTick) return;
  auto.nextTick = h.world.tick + auto.everyTicks;
  autosaveNow().catch((err) => console.error('[SaveGame] autosave', err));
}

/** Autosave right now (also when leaving the match: await it before the page reloads). Resolves the id or null. */
export async function autosaveNow() {
  if (auto.busy || !canSave() || match?.multiplayer) return null; // [A2-net] the single autosave slot stays single player
  if ((window.steelMen?.world?.tick ?? 0) < SAVE.minAutosaveTicks) return null; // a just-started match never replaces the autosave
  auto.busy = true;
  try {
    const save = await buildSave(t('save.autosave'), { auto: true });
    return await put(save, { slot: SAVE.autoSlot });
  } finally {
    auto.busy = false;
  }
}

/** The whole API as one object (main.js: new SaveLoadView({ saveGame, … })) */
export const saveGame = {
  noteMatchStart, buildSave, restore, startAutosave, stopAutosave, autosaveNow, isRestoring, canRestoreHere, canSave,
  matchSettings, matchMapName, restoreMultiplayer,
};
