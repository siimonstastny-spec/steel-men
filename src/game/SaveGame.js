// Steel Men – saved games as replays [J1] (docs/notes/j1-save-core.md). A save = match settings + seed + every
// non-AI command from tick 0 (commandBus.recorded) + checkpoints; restoring starts the same match on a fresh page and
// re-runs the simulation headless (no effects, sounds, drawing of projectiles) up to the saved tick. Computer players
// run live during the replay (they are deterministic, ai.rng): their inner state comes back by itself and only the
// checkpoint hashes (incl. the command hash) prove they decided the same.
//   noteMatchStart(settings, seed)  – main.js startGame, right before startSimulation(seed)
//   await buildSave(name)           – save object of the running single-player match
//   await restore(save, { onProgress(fraction), signal, paused })  – fresh page only (canRestoreHere())
//   startAutosave(intervalSec?) / stopAutosave() / await autosaveNow()
import { SAVE, SIM_VERSION, GAME_VERSION, SIM, SEATS, PLAYER_TEAM } from '../config.js';
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
  // Multiplayer (S3, later): AI commands travel like a player's and are recorded with everything else
  const liveTeams = multiplayer ? [] : Array.from({ length: count }, (_, team) => team).filter((team) => seatOf(clean, team) === 'ai');
  commandBus.liveTeams = liveTeams;
  commandBus.checkpointHash = partsHash;
  let testScene = false;
  try { testScene = new URLSearchParams(window.location.search).get('test') === '1'; } catch { /* no location */ }
  commandBus.recording = !multiplayer && !testScene; // no save possible there: only the command hash runs
  match = { settings: clean, liveTeams, multiplayer, testScene };
  ensureFingerprint([validMapId(clean.map)]).catch((err) => console.warn('[SaveGame] fingerprint', err));
}

/** One number over the determinism subsystems (core, rng, units, economy, production, research, projectiles, ai) */
function partsHash(world) {
  const { parts } = hashParts(world, false);
  let h = FNV_OFFSET;
  for (const name of PART_NAMES) h = Math.imul(h ^ (parts[name] ?? 0), FNV_PRIME);
  return h >>> 0;
}

export const isRestoring = () => restoring;
/** Settings of the running / restored match as noteMatchStart kept them (seed, map, seats…; a copy), null before any */
export const matchSettings = () => (match ? JSON.parse(JSON.stringify(match.settings)) : null);
/** Display name of the running match's map (map file "name", else the id), '' before any match */
export function matchMapName() {
  const h = window.steelMen;
  return h?.world?.map?.name ?? (match ? validMapId(match.settings.map) : '');
}
/** Can restore() run on this page? (false once any match was set up – then scheduleRestore + reload) */
export const canRestoreHere = () => matchesStarted === 0 && (window.steelMen?.world?.tick ?? 0) === 0;
/** Can the running match be saved? (single player, not while restoring, not the ?test=1 scene, not over) */
export function canSave() {
  const h = window.steelMen;
  return Boolean(match && !match.multiplayer && !match.testScene && !restoring && h?.world && !h.game?.match?.result);
}

// ---------- building a save ----------

function playersMeta(settings, count) {
  const me = settings.localTeam ?? PLAYER_TEAM;
  return Array.from({ length: count }, (_, team) => {
    const race = settings.races?.[team] ?? settings.races?.[0] ?? null;
    const seat = seatOf(settings, team);
    const name = playerLabel(team) || (team === me ? (getSettings().nickname || t('common.player')) : t('ping.player', { n: team + 1 }));
    return { team, name, race, raceName: race ? raceName(race) : '', seat, color: settings.colors?.[team] ?? null };
  });
}

/**
 * Save object of the running single-player match (the record is copied synchronously, before any await).
 * @param {string} name
 * @param {{ auto?: boolean }} [opts]
 */
export async function buildSave(name, { auto = false } = {}) {
  const { world, game } = handle();
  if (!match) throw saveError('noMatch', 'no match is running');
  if (match.multiplayer) throw saveError('multiplayer', 'multiplayer matches cannot be saved yet');
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
  const end = { tick, stateHash: world.stateHash(), partsHash: partsHash(world), commandHash: commandBus.commandHash >>> 0, parts };
  const settings = JSON.parse(JSON.stringify(match.settings));
  const mapId = validMapId(settings.map);
  const count = game?.playerCount || settings.races?.length || SEATS.defaults.length;
  const fingerprint = await currentFingerprint(mapId);
  return {
    format: SAVE.format,
    formatVersion: SAVE.formatVersion,
    meta: {
      name: String(name ?? ''), date: new Date().toISOString(), auto: Boolean(auto),
      map: mapId, mapName: matchMapName() || mapId, players: playersMeta(settings, count), playerCount: count,
      durationTicks: tick, durationSec: Math.floor(tick / SIM.tickRate), tickRate: SIM.tickRate,
      simVersion: SIM_VERSION, gameVersion: GAME_VERSION, fingerprint,
      commandCount: commands.length, thumbnail: null,
    },
    settings, liveTeams: [...live], commands, pending, checkpoints, end,
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
  if (save.settings.multiplayer) throw saveError('multiplayer', 'multiplayer saves cannot be restored yet');
  await ensureFingerprint([save.meta?.map]);
  const compat = isCompatible(save.meta);
  if (!compat.ok) throw saveError('incompatible', `save not compatible (${compat.reason})`, { reason: compat.reason });
  if (!canRestoreHere()) throw saveError('reloadRequired', 'restore needs a fresh page (scheduleRestore + reload)');
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
    await h.startGame(reviveSettings(save.settings));
    if (world.tick !== 0) throw saveError('loopTicked', 'the game loop ticked during the restore (world.paused not wired in main.js)');
    if (!sameTeams(commandBus.liveTeams, save.liveTeams ?? [])) throw saveError('hash', 'AI seats differ from the save', { tick: 0, kind: 'seats' });
    const startShare = SAVE.progressStartShare;
    report(startShare);
    const expected = save.checkpoints;
    let nextExpected = 0;
    let chunkStart = performance.now();
    while (world.tick < endTick) {
      if (signal?.aborted) throw cancelled();
      if (h.game.match?.result) throw saveError('hash', `the match ended at tick ${world.tick}, the save is at ${endTick}`, { tick: world.tick, kind: 'ended' });
      if (!world.readyForTick()) { await wait(SAVE.replayWaitMs); continue; } // a produced unit's model is still loading
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
    const now = { stateHash: world.stateHash(), partsHash: partsHash(world), commandHash: commandBus.commandHash >>> 0 };
    if (now.stateHash !== save.end.stateHash || now.partsHash !== save.end.partsHash || now.commandHash !== save.end.commandHash) {
      const { parts } = hashParts(world, false);
      const diff = save.end.parts ? PART_NAMES.filter((n) => parts[n] !== save.end.parts[n]) : [];
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
  if (auto.busy || !canSave()) return null;
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
  matchSettings, matchMapName,
};
