// Steel Men – determinism harness for the browser console: steelMen.det [I1] (docs/notes/i1-determinism.md).
// Runs a match with a fixed seed, ticks it itself (world.paused stops the game loop) or lets the game loop tick it,
// records world.stateHash() and the subsystem hashes after every tick, the 24 checkpoints and entity snapshots, saves
// the run in IndexedDB and compares it LIVE (every tick) with the previous run of the same configuration: at the first
// differing tick it keeps the rows of tick N - 1 and N and stops after the next snapshots. Reload before every run.
//   await steelMen.det.human()                                   – human/human, 24 points × 300 ticks, attackMove at tick 90
//   await steelMen.det.ai({ races: ['X', 'Y'], difficulty: 'hard', startResearch: 3, seconds: 1800 })
//   await steelMen.det.ai({ ..., loop: true, delayMs: 400 })     – the game loop ticks, model loads delayed artificially
//   await steelMen.det.compare('keyA', 'keyB'); await steelMen.det.list(); steelMen.det.parts(); await steelMen.det.step(30)
// Debug code only: it reads the simulation, never changes it except through commandBus (attackMove) and the AI.
// Wall-clock time is read for the printout (run duration) and the artificial load delay only.
import { SIM, DETERMINISM, GAME_SPEED } from '../config.js';
import { updateAis, aiPlayers } from '../ai/index.js';
import { startAiVsAi } from '../ai/aiVsAi.js';
import { getStats, loadStats } from '../data/Stats.js';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const EVENT_TIME_SCALE = 10000; // world.events: delays rounded to 1/10000 s
const PROGRESS_SCALE = 10000;   // structure progress 0..1
const MAX_LISTED = 20;          // compare(): differing entities / types printed at most
const LOCAL_CMD_FIELDS = new Set(['origin', 'ticket']); // client-local command fields, not part of the simulation
/** Subsystems of hashParts(), in a fixed order (per-tick arrays use it) */
export const PART_NAMES = ['core', 'rng', 'units.mech', 'units.crew', 'units.vehicle', 'units.aircraft', 'units.structure',
  'wrecks', 'economy', 'production', 'research', 'projectiles', 'ai', 'commands'];
const KINDS = ['mech', 'crew', 'vehicle', 'aircraft', 'structure'];
/** Columns of a compact entity row (Int32Array, ROW_FIELDS.length ints per unit) */
export const ROW_FIELDS = ['eid', 'kind', 'team', 'type', 'x', 'y', 'z', 'yaw', 'hp', 'order', 'target', 'flags', 'progress'];
const ROW = ROW_FIELDS.length;
const FLAG_DEAD = 1;
const FLAG_REMOVED = 2;
const FLAG_COMPLETE = 4;
const FLAG_INSIDE = 8;
const STORE = 'runs';

const handle = () => {
  const h = window.steelMen;
  if (!h?.world || !h?.commandBus || !h?.startGame) throw new Error('[det] steelMen debug handle missing');
  return h;
};

// ---------- hashing ----------

class Hasher {
  constructor() { this.h = FNV_OFFSET; }
  mix(v) { this.h = Math.imul(this.h ^ (v | 0), FNV_PRIME); }
  text(s) { const str = String(s ?? ''); for (let i = 0; i < str.length; i++) this.mix(str.charCodeAt(i)); this.mix(str.length); }
  pos(v) { this.mix(Math.round((v ?? 0) * SIM.hashPositionScale)); }
  val(v) { this.mix(Math.round((v ?? 0) * SIM.hashValueScale)); }
  ang(v) { this.mix(Math.round((v ?? 0) * SIM.hashAngleScale)); }
  any(v) {
    if (v == null) this.mix(-1);
    else if (typeof v === 'number') this.val(v);
    else if (typeof v === 'string') this.text(v);
    else if (typeof v === 'boolean') this.mix(v ? 1 : 0);
    else if (v.eid != null) this.mix(v.eid);
    else if (v.x != null && v.z != null) { this.pos(v.x); this.pos(v.z); }
    else this.mix(-2);
  }
  get value() { return this.h >>> 0; }
}

/** 'mech' | 'crew' | 'vehicle' | 'aircraft' | 'structure' */
function kindOf(u) {
  if (u.isMech) return 'mech';
  if (u.isStructure) return 'structure';
  if (u.isVehicle) return 'altitude' in u ? 'aircraft' : 'vehicle';
  return 'crew';
}

const typeOf = (u) => u.unitId ?? (u.isMech ? 'mech' : `crew:${u.race ?? ''}`);
const hpOf = (u) => (u.isMech ? Object.values(u.parts ?? {}).reduce((sum, p) => sum + (p?.hp ?? 0), 0) : u.hp);

function mixUnit(hs, u) {
  hs.mix(u.eid ?? -1);
  hs.mix(u.team ?? -1);
  hs.text(typeOf(u));
  hs.pos(u.position.x);
  hs.pos(u.position.y);
  hs.pos(u.position.z);
  hs.ang(u.rotation.y);
  if (u.isMech) for (const p of Object.values(u.parts ?? {})) hs.val(p?.hp);
  else hs.val(u.hp);
  hs.mix(u.destroyed ? 1 : 0);
  hs.mix(u.dead ? 1 : 0);
  hs.mix(u.removed ? 1 : 0);
  const o = u.order;
  hs.text(o?.type ?? '');
  hs.any(o?.target ?? null);
  if (u.isStructure) { hs.mix(Math.round((u.progress ?? 0) * PROGRESS_SCALE)); hs.mix(u.complete ? 1 : 0); }
  if ('mech' in u && !u.isMech) hs.mix(u.mech?.eid ?? -1); // crew operating a mech
}

/**
 * Hash of every simulation subsystem separately (uint32 each) plus one hash per unit type.
 * @returns {{ parts: Object<string, number>, types: Object<string, number> }}
 */
export function hashParts(world = handle().world, withTypes = true) {
  const parts = {};
  let hs = new Hasher();
  hs.mix(world.tick);
  hs.mix(world.nextEid);
  for (const e of world.events) hs.mix(Math.round(e.time * EVENT_TIME_SCALE));
  hs.mix(world.events.length);
  for (const e of world.pendingSpawns) { hs.mix(e.eid ?? -1); hs.mix(e.due); hs.mix(e.team ?? -1); hs.val(e.supply ?? 0); }
  parts.core = hs.value;

  hs = new Hasher();
  hs.mix(world.rng.state);
  for (const ai of aiPlayers) { hs.mix(ai.team); hs.mix(ai.rng?.state ?? 0); }
  parts.rng = hs.value;

  const byKind = { mech: new Hasher(), crew: new Hasher(), vehicle: new Hasher(), aircraft: new Hasher(), structure: new Hasher() };
  const byType = new Map();
  for (const u of world.allUnits) {
    mixUnit(byKind[kindOf(u)], u);
    if (!withTypes) continue;
    const key = typeOf(u);
    let th = byType.get(key);
    if (!th) byType.set(key, th = new Hasher());
    mixUnit(th, u);
  }
  for (const [k, v] of Object.entries(byKind)) parts[`units.${k}`] = v.value;

  hs = new Hasher();
  for (const w of [...world.wrecks, ...world.salvage]) {
    hs.mix(w.eid ?? -1);
    hs.pos(w.object?.position.x);
    hs.pos(w.object?.position.z);
    hs.val(w.part?.hp);
    hs.mix(w.collected ? 1 : 0);
  }
  parts.wrecks = hs.value;

  hs = new Hasher();
  const eco = world.economy;
  if (eco?.accounts) {
    for (let team = 0; team < eco.accounts.length; team++) {
      for (const r of eco.resources ?? []) hs.val(eco.amount(team, r));
      hs.mix(eco.populationUsed?.(team) ?? 0);
      hs.mix(eco.populationCap?.(team) ?? 0);
    }
    for (const d of eco.deposits ?? []) { hs.pos(d.x); hs.pos(d.z); hs.val(d.amount); }
  }
  parts.economy = hs.value;

  hs = new Hasher();
  const prod = world.production;
  if (prod?.queues) {
    for (const eid of [...prod.queues.keys()].sort((a, b) => a - b)) {
      hs.mix(eid);
      for (const it of prod.queues.get(eid)) {
        hs.mix(it.id); hs.mix(it.team); hs.text(it.kind); hs.text(it.unitId ?? it.researchId ?? it.path ?? '');
        hs.mix(Math.round((it.elapsed ?? 0) * EVENT_TIME_SCALE));
      }
    }
    hs.mix(prod.nextItemId ?? 0);
  }
  parts.production = hs.value;

  hs = new Hasher();
  for (const [team, r] of (world.research?.teams ?? []).entries()) {
    hs.mix(team);
    for (const id of [...r.completed].sort()) hs.text(id);
    for (const key of [...r.active.keys()].map(String).sort()) { hs.text(key); hs.any(r.active.get(key) ?? r.active.get(Number(key))); }
    for (const key of [...r.analysed].map(String).sort()) hs.text(key);
  }
  parts.research = hs.value;

  hs = new Hasher();
  const live = world.effects?.projectiles?.live ?? [];
  hs.mix(live.length);
  for (const rec of live) { hs.pos(rec.pos.x); hs.pos(rec.pos.y); hs.pos(rec.pos.z); hs.val(rec.life); }
  parts.projectiles = hs.value;

  hs = new Hasher();
  for (const ai of aiPlayers) {
    hs.mix(ai.team);
    hs.text(ai.bb?.state ?? '');
    hs.val(ai.now);
    hs.mix(Math.round((ai.tokens ?? 0) * SIM.hashValueScale));
    hs.mix(ai.queue?.length ?? 0);
    hs.mix(ai.stats?.commands ?? 0);
    hs.mix(ai.stats?.dropped ?? 0);
    hs.mix(ai.construction?.step ?? 0);
    hs.text(ai.bb?.wave?.phase ?? '');
  }
  parts.ai = hs.value;

  const types = {};
  for (const key of [...byType.keys()].sort()) types[key] = byType.get(key).value;
  return { parts, types };
}

const textHashes = new Map(); // memo: rows are built every tick in live-compare mode
const textHash = (s) => {
  let v = textHashes.get(s);
  if (v === undefined) { const hs = new Hasher(); hs.text(s); v = hs.value | 0; textHashes.set(s, v); }
  return v;
};

/**
 * Compact entity rows: ROW_FIELDS ints per unit into `buf` (grown when needed). `names` collects type / order hash →
 * text for decodeRows. @returns {Int32Array} the filled part (a view – copy it with .slice() to keep it)
 */
export function compactRows(world, buf = null, names = null) {
  const units = world.allUnits;
  if (!buf || buf.length < units.length * ROW) buf = new Int32Array(Math.max(64, units.length * 2) * ROW);
  const r = (v, s) => Math.round((v ?? 0) * s);
  let o = 0;
  for (const u of units) {
    const type = typeOf(u);
    const order = u.order?.type ?? '';
    const th = textHash(type);
    const oh = textHash(order);
    if (names) { names[th] ??= type; names[oh] ??= order; }
    const tgt = u.order?.target;
    buf[o] = u.eid ?? -1;
    buf[o + 1] = KINDS.indexOf(kindOf(u));
    buf[o + 2] = u.team ?? -1;
    buf[o + 3] = th;
    buf[o + 4] = r(u.position.x, SIM.hashPositionScale);
    buf[o + 5] = r(u.position.y, SIM.hashPositionScale);
    buf[o + 6] = r(u.position.z, SIM.hashPositionScale);
    buf[o + 7] = r(u.rotation.y, SIM.hashAngleScale);
    buf[o + 8] = r(hpOf(u), SIM.hashValueScale);
    buf[o + 9] = oh;
    buf[o + 10] = tgt?.eid ?? (tgt?.x != null ? r(tgt.x, 1) * 100000 + r(tgt.z, 1) : -1);
    buf[o + 11] = (u.destroyed || u.dead ? FLAG_DEAD : 0) | (u.removed ? FLAG_REMOVED : 0)
      | (u.complete ? FLAG_COMPLETE : 0) | (u.inside ? FLAG_INSIDE : 0);
    buf[o + 12] = r(u.progress, PROGRESS_SCALE);
    o += ROW;
  }
  return buf.subarray(0, o);
}

/** Compact rows → objects (eid, kind, type, team, x, y, z, yaw, hp, order, target, flags, progress) */
export function decodeRows(rows, names = {}) {
  const out = [];
  for (let o = 0; o + ROW <= rows.length; o += ROW) {
    const row = {};
    for (let k = 0; k < ROW; k++) row[ROW_FIELDS[k]] = rows[o + k];
    row.kind = KINDS[row.kind] ?? row.kind;
    row.type = names[row.type] ?? row.type;
    row.order = names[row.order] ?? row.order;
    out.push(row);
  }
  return out;
}

/** Rounded per-entity rows of the current state (console) */
export function entityRows(world = handle().world) {
  const names = {};
  return decodeRows(compactRows(world, null, names), names);
}

// Units of two row sets that differ: [{ eid, a, b }] (a / b = decoded row or null when missing), at most MAX_LISTED
function diffRows(rowsA, rowsB, namesA, namesB) {
  const a = new Map(decodeRows(rowsA, namesA).map((r) => [r.eid, r]));
  const out = [];
  for (const rb of decodeRows(rowsB, namesB)) {
    const ra = a.get(rb.eid) ?? null;
    a.delete(rb.eid);
    if (ra && JSON.stringify(ra) === JSON.stringify(rb)) continue;
    out.push({ eid: rb.eid, a: ra, b: rb });
  }
  for (const ra of a.values()) out.push({ eid: ra.eid, a: ra, b: null });
  out.sort((x, y) => x.eid - y.eid);
  return out.slice(0, MAX_LISTED);
}

// ---------- a run ----------

let runsThisPage = 0;

/**
 * @param {object} ref  reference run for the live compare (or null); kept out of the saved record (#saveable)
 */
function newRun(config, endTick, interval, ref = null) {
  return {
    config, endTick, interval, lastTick: -1, points: [], details: {}, snapshots: [], names: {},
    tickHashes: new Uint32Array(endTick + 1),
    partTicks: config.perTickParts ? Object.fromEntries(PART_NAMES.map((n) => [n, new Uint32Array(endTick + 1)])) : null,
    commands: { count: 0, hash: FNV_OFFSET }, ms: 0, result: null, stopped: false,
    live: null, // first split against the reference: { tick, parts, refParts, partsDiff, before, at }
    ref, bufs: [null, null], views: [null, null], flip: 0, // live compare: rows of the last two ticks (not saved)
  };
}

const partsAt = (run, t) => (run?.partTicks ? Object.fromEntries(PART_NAMES.map((n) => [n, run.partTicks[n][t]])) : null);
const diffParts = (a, b) => (a && b ? PART_NAMES.filter((n) => a[n] !== b[n]) : []);

function record(run, world) {
  const t = world.tick;
  if (t > run.endTick || t <= run.lastTick) return false;
  const total = world.stateHash();
  run.tickHashes[t] = total;
  run.lastTick = t;
  const cfg = run.config;
  const isPoint = t > 0 && t % run.interval === 0;
  const isSnap = t % cfg.snapshotEvery === 0;
  const detail = cfg.detailAt?.includes(t);
  const ref = run.ref;
  const split = Boolean(ref) && !run.live && t <= ref.lastTick && ref.tickHashes[t] !== total;
  let hp = null;
  if (run.partTicks || isPoint || isSnap || detail || split) {
    hp = hashParts(world, isPoint || detail || split);
    hp.parts.commands = run.commands.hash >>> 0;
    if (run.partTicks) for (const n of PART_NAMES) run.partTicks[n][t] = hp.parts[n] ?? 0;
  }
  // Live compare: rows of this tick and the previous one (the state of t - 1 still matched the reference)
  let rows = null;
  if (ref && !run.live) {
    const i = run.flip = 1 - run.flip;
    rows = compactRows(world, run.bufs[i], run.names);
    if (run.bufs[i]?.buffer !== rows.buffer) run.bufs[i] = new Int32Array(rows.buffer);
    run.views[i] = rows;
  }
  if (split) {
    const before = run.views[1 - run.flip];
    const refParts = partsAt(ref, t);
    run.live = {
      tick: t, parts: hp.parts, refParts, partsDiff: diffParts(refParts, hp.parts), types: hp.types,
      before: before && t > 0 ? { tick: t - 1, rows: before.slice(), parts: partsAt(run, t - 1) } : null,
      at: { tick: t, rows: rows.slice(), parts: hp.parts },
      snapshotsLeft: cfg.stopAfterSnapshots,
    };
    console.warn(`[det] LIVE: tick ${t} differs from the reference${run.live.partsDiff.length ? ` – subsystems: ${run.live.partsDiff.join(', ')}` : ''}`);
  }
  if (isPoint || detail) {
    const point = { tick: t, total, parts: hp.parts, types: hp.types };
    if (isPoint) run.points.push(point);
    if (detail) run.details[t] = { ...point, rows: (rows ?? compactRows(world, null, run.names)).slice() };
  }
  if (isSnap) {
    run.snapshots.push({ tick: t, parts: hp.parts, rows: (rows ?? compactRows(world, null, run.names)).slice() });
    if (run.live && t > run.live.tick && cfg.stopOnDiff && --run.live.snapshotsLeft <= 0) run.stopped = true;
  }
  return true;
}

function watchCommands(h, run) {
  return h.commandBus.onExecuted((cmd, tick) => {
    const hs = new Hasher();
    hs.h = run.commands.hash;
    hs.mix(tick);
    hs.text(JSON.stringify(cmd, (k, v) => (LOCAL_CMD_FIELDS.has(k) ? undefined : v)));
    run.commands.hash = hs.value;
    run.commands.count++;
  });
}

const nextTask = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One tick exactly like main.js simTick (minus the visual-only parts) */
function stepOnce(h) {
  const { world, commandBus, game } = h;
  const dt = 1 / SIM.tickRate;
  commandBus.executeTick(world, world.tick + 1);
  world.update(dt);
  game.match?.update(dt);
  updateAis(world.tick / SIM.tickRate);
}

const loopTickedError = () => new Error('[det] the game loop ticked while world.paused – wire world.paused in main.js advanceSimulation (docs/notes/i1-determinism.md)');

// The harness ticks by itself; the game loop must stay still (world.paused)
async function tickOwn(h, run, onTick) {
  const { world, game } = h;
  let sinceYield = 0;
  while (world.tick < run.endTick && !game.match?.result && !run.stopped) {
    if (!world.readyForTick()) {
      const before = world.tick;
      await nextTask();
      if (world.tick !== before) throw loopTickedError();
      continue;
    }
    stepOnce(h);
    record(run, world);
    onTick(world.tick);
    if (++sinceYield >= DETERMINISM.chunkTicks) {
      sinceYield = 0;
      const before = world.tick;
      await nextTask();
      if (world.tick !== before) throw loopTickedError();
    }
  }
}

// The game loop ticks (single-player path, readyForTick in main.js); the state after tick N is recorded right
// before tick N + 1 executes
async function tickLoop(h, run, onTick, speed) {
  const { world, commandBus, game, gameSpeed } = h;
  const bus = commandBus;
  const original = bus.executeTick;
  bus.executeTick = function hooked(w, tick) {
    if (w === world && record(run, world)) onTick(world.tick);
    return original.call(this, w, tick);
  };
  const prevSpeed = gameSpeed?.value;
  try {
    if (speed != null) gameSpeed?.set(speed);
    world.paused = false;
    while (run.lastTick < run.endTick && !game.match?.result && !run.stopped) await sleep(DETERMINISM.spPollMs);
  } finally {
    world.paused = true;
    delete bus.executeTick; // back to the prototype method
    if (prevSpeed != null) gameSpeed?.set(prevSpeed);
  }
}

/**
 * Artificial, uneven delay of every simulation-relevant async load (spawns, part swaps, trackLoad): the run must give
 * the same hashes with and without it. @returns {() => void} removes the delay
 */
export function delayLoads(ms, world = handle().world) {
  if (!(ms > 0)) return () => {};
  let n = 0;
  const steps = DETERMINISM.delayJitterSteps;
  const wait = () => sleep((ms * (1 + (n++ % steps))) / steps);
  const proto = Object.getPrototypeOf(world);
  world.spawnDeferred = (create, place) => proto.spawnDeferred.call(world, () => wait().then(create), place);
  world.deferLoad = (load, apply) => proto.deferLoad.call(world, () => wait().then(load), apply);
  world.trackLoad = (promise) => proto.trackLoad.call(world, wait().then(() => promise));
  return () => { delete world.spawnDeferred; delete world.deferLoad; delete world.trackLoad; };
}

/** First `count` playable races of stats.json, repeated in order when there are fewer races than seats ([A4-SIM]) */
async function defaultRaces(count = 2) {
  await loadStats();
  const all = Object.keys(getStats().races ?? {});
  return Array.from({ length: count }, (_, i) => all[i % all.length]);
}

// Starts a match frozen at tick 0 (world.paused): nothing ticks before the harness says so
async function startMatch(h, settings) {
  if (runsThisPage > 0) console.warn('[det] a run already happened on this page – reload before a measured run');
  runsThisPage++;
  h.world.paused = true;
  const clean = Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined && v !== null));
  await h.startGame(clean);
  if (h.world.tick !== 0) throw loopTickedError();
}

async function execute(h, run, onTick) {
  const { config } = run;
  const unsub = watchCommands(h, run);
  const undoDelay = delayLoads(config.delayMs, h.world);
  const t0 = performance.now(); // printout only
  try {
    record(run, h.world); // tick 0
    onTick(h.world.tick);
    if (config.loop) await tickLoop(h, run, onTick, config.speed);
    else await tickOwn(h, run, onTick);
  } finally {
    undoDelay();
    unsub();
  }
  run.ms = Math.round(performance.now() - t0);
  run.result = h.game.match?.result ? { ...h.game.match.result } : null;
  if (run.stopped) console.warn(`[det] stopped at tick ${run.lastTick}: ${DETERMINISM.stopAfterSnapshots} snapshot(s) after the split at tick ${run.live.tick}`);
  else if (run.lastTick < run.endTick) console.warn(`[det] run ended at tick ${run.lastTick} of ${run.endTick}`, run.result ?? '');
}

// What is saved / compared: everything except the live-compare scratch (reference run, row buffers)
function saveable(run) {
  const { ref, bufs, views, flip, ...rest } = run;
  return rest;
}

const autoKey = (c) => (c.mode === 'human'
  ? `human:${c.races.join('-')}:${c.startSet ?? 'default'}${c.loop ? ':loop' : ''}`
  : `ai:${c.races.join('-')}:${[].concat(c.difficulty).join('-')}:t${c.startResearch ?? 0}:${c.startSet ?? 'default'}:${c.seconds}${c.loop ? ':loop' : ''}${c.races.length > 2 && c.map ? `:${c.map}` : ''}${c.alliances ? `:a${c.alliances.join('')}` : ''}`); // [A4-SIM] map (3+ seats) / alliances: old 2-seat keys unchanged

// Save key and reference key of a run (opts.save / opts.compareWith / opts.compare)
function keysOf(config, opts) {
  const key = opts.save === false ? null : (opts.save ?? autoKey(config));
  const against = opts.compareWith ?? (opts.compare === false ? null : key);
  return { key, against };
}

// The reference is loaded BEFORE the run: the live compare checks every tick against it
async function loadReference(against) {
  if (!against) return null;
  const ref = await loadRun(against);
  if (ref) console.info(`[det] live compare against '${against}' (${ref.lastTick} ticks${ref.partTicks ? ', per-tick subsystems' : ''})`);
  return ref;
}

async function finish(run, opts, keys) {
  const { key, against } = keys;
  const ref = run.ref;
  const data = saveable(run);
  const cmp = ref ? compareRuns(ref, data, { label: `${against} vs this run` }) : null;
  // A run stopped by the live compare is not saved over its reference (it would cut the reference short)
  if (key && !(run.stopped && key === against)) await saveRun(key, data);
  console.info(`[det] ${key ?? 'run'}: ${run.lastTick} ticks in ${(run.ms / 1000).toFixed(1)} s, ${run.commands.count} commands`);
  console.info('[det] totals:', totals(data).join(', '));
  if (!ref && key) console.info(`[det] saved as '${key}' – reload and run the same call again to compare`);
  return { key, run: data, compare: cmp };
}

/**
 * Human/human reference run (HANDOFF procedure): seed 42, seats human/human, attackMove of every side's living
 * units to the other base executing in tick `attackTick`, stateHash every `interval` ticks.
 * @param {object} [opts] races, startSet, map, seed, points, interval, attackTick, loop, delayMs, speed, detailAt,
 *   save (key | false), compare (false = do not compare), compareWith (key)
 */
export async function runHuman(opts = {}) {
  const h = handle();
  const config = {
    mode: 'human', races: opts.races ?? await defaultRaces(), seed: opts.seed ?? DETERMINISM.seed,
    startSet: opts.startSet ?? null, map: opts.map ?? null,
    points: opts.points ?? DETERMINISM.humanPoints, interval: opts.interval ?? DETERMINISM.humanInterval,
    attackTick: opts.attackTick ?? DETERMINISM.attackTick, loop: Boolean(opts.loop), delayMs: opts.delayMs ?? 0,
    speed: opts.speed ?? Math.max(...GAME_SPEED.options), detailAt: opts.detailAt ?? [], ...fineOptions(opts),
  };
  const keys = keysOf(config, opts);
  const ref = await loadReference(keys.against);
  await startMatch(h, {
    playerCount: 2, races: config.races, seats: ['human', 'human'], seed: config.seed, startSet: config.startSet, map: config.map,
  });
  const run = newRun(config, config.points * config.interval, config.interval, ref);
  const onTick = (tick) => { if (tick === config.attackTick - 1) submitAttackMoves(h); };
  await execute(h, run, onTick);
  return finish(run, opts, keys);
}

// Options shared by both runs: per-tick subsystem hashes, snapshot interval, stop after a live split
function fineOptions(opts) {
  return {
    perTickParts: opts.perTickParts ?? DETERMINISM.perTickParts,
    snapshotEvery: Math.max(1, opts.snapshotEvery ?? DETERMINISM.snapshotEvery),
    stopOnDiff: opts.stopOnDiff ?? true,
  };
}

// Executes in the next tick (offline bus: currentTick + 1)
function submitAttackMoves(h) {
  const { world, commandBus, game } = h;
  for (let team = 0; team < 2; team++) {
    const other = game.bases?.[1 - team];
    if (!other) continue;
    const units = [...world.mechs, ...world.crews, ...world.vehicles]
      .filter((u) => u.team === team && !u.destroyed && !u.dead && !u.removed).map((u) => u.eid);
    commandBus.submit({ type: 'attackMove', team, units, point: { x: other.x, z: other.z }, queued: false });
  }
}

/**
 * AI vs AI run: seats human/human, then an AI on every team at tick 0 (steelMen.ai.start), `seconds` of game time.
 * @param {object} [opts] races, difficulty (id or one per team), startResearch (0–3 = starting tier), startSet, map,
 *   seed, seconds, points, loop (game loop ticks), delayMs (artificial load delay), speed (loop mode), detailAt,
 *   save, compare, compareWith
 *   [A4-SIM] 2–8 players: players = seat count when races is missing (races repeat), races.length = seat count,
 *   alliances = alliance id per seat (missing = everybody alone), e.g.
 *   det.ai({ players: 8, map: 'Map8_01', alliances: [0, 0, 0, 0, 1, 1, 1, 1], seconds: 600 })
 */
export async function runAi(opts = {}) {
  const h = handle();
  const races = opts.races ?? await defaultRaces(opts.players ?? 2);
  const config = {
    mode: 'ai', races, difficulty: opts.difficulty ?? 'normal',
    alliances: Array.isArray(opts.alliances) ? opts.alliances.slice(0, races.length) : null, // [A4-SIM]
    startResearch: opts.startResearch ?? 0, startSet: opts.startSet ?? null, map: opts.map ?? null,
    seed: opts.seed ?? DETERMINISM.seed, seconds: opts.seconds ?? DETERMINISM.aiSeconds,
    points: opts.points ?? DETERMINISM.aiPoints, loop: Boolean(opts.loop), delayMs: opts.delayMs ?? 0,
    speed: opts.speed ?? Math.max(...GAME_SPEED.options), detailAt: opts.detailAt ?? [], ...fineOptions(opts),
  };
  const keys = keysOf(config, opts);
  const ref = await loadReference(keys.against);
  await startMatch(h, {
    playerCount: config.races.length, races: config.races, seats: config.races.map(() => 'human'), seed: config.seed, // [A4-SIM] 2–8 seats
    startSet: config.startSet, map: config.map, startResearch: config.startResearch, alliances: config.alliances,
  });
  await startAiVsAi({ difficulty: config.difficulty }); // AI data loaded, tick still 0 (world.paused)
  if (h.world.tick !== 0) throw loopTickedError();
  const endTick = Math.round(config.seconds * SIM.tickRate);
  const run = newRun(config, endTick, Math.max(1, Math.floor(endTick / config.points)), ref);
  await execute(h, run, () => {});
  return finish(run, opts, keys);
}

// ---------- saving / comparing ----------

// Runs live in IndexedDB (DETERMINISM.dbName): per-tick hashes, per-tick subsystems and entity snapshots of a 1800 s run
// are several MB (typed arrays are stored as they are)
let dbPromise = null;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DETERMINISM.dbName, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      // K2-2: another tab upgrades / the browser closes the connection → drop the cached one, the next call reopens
      db.onversionchange = () => { db.close(); dbPromise = null; };
      db.onclose = () => { dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function withStore(mode, fn) {
  let db = await openDb();
  let tx;
  try { tx = db.transaction(STORE, mode); } catch { // closed meanwhile (InvalidStateError): reopen once
    dbPromise = null;
    db = await openDb();
    tx = db.transaction(STORE, mode);
  }
  return new Promise((resolve, reject) => {
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Saves a run under `key` (overwrites) */
export async function saveRun(key, run) {
  try { await withStore('readwrite', (s) => s.put(saveable(run.run ?? run), key)); } catch (err) { console.error(`[det] save '${key}' failed`, err); }
}

/** A saved run, or null */
export async function loadRun(key) {
  try { return (await withStore('readonly', (s) => s.get(key))) ?? null; } catch (err) { console.error(`[det] load '${key}' failed`, err); return null; }
}

/** Keys of the saved runs */
export async function listRuns() {
  try { return ((await withStore('readonly', (s) => s.getAllKeys())) ?? []).map(String).sort(); } catch { return []; }
}

/** Deletes one saved run, or all of them */
export async function clearRuns(key = null) {
  try { await withStore('readwrite', (s) => (key == null ? s.clear() : s.delete(key))); } catch (err) { console.error(err); }
}

const asRun = async (r) => (typeof r === 'string' ? loadRun(r) : r?.run ?? r);

/** Checkpoint totals (stateHash) of a run object – the reference list for docs (async variant: det.totals) */
export function totals(r) { return (r?.run ?? r)?.points?.map((p) => p.total) ?? []; }

/** Console: compare two runs given as saved keys or objects */
export async function compareSaved(a, b, opts) {
  const A = await asRun(a);
  const B = await asRun(b);
  if (!A || !B) throw new Error('[det] compare: run not found');
  return compareRuns(A, B, { label: `${typeof a === 'string' ? a : 'A'} vs ${typeof b === 'string' ? b : 'B'}`, ...opts });
}

/**
 * Compares two run objects:
 * - firstTick: first tick whose stateHash differs (per-tick hashes) and tickParts: the subsystems differing in exactly
 *   that tick (per-tick subsystem hashes);
 * - firstPoint / parts / types: first of the 24 checkpoints that differs. A split that heals before the next checkpoint
 *   (e.g. a shot landing one tick earlier with the same damage) gives firstTick with firstPoint null – the per-tick hash
 *   holds nothing the checkpoints lack, the checkpoints only sample every `interval` ticks;
 * - snapshot: the first common entity snapshot from firstTick on that differs, with the units that differ there;
 * - live (when B stopped on a live split): subsystems at the split tick and the units that changed in that tick in B
 *   (its state of tick - 1 still equalled A);
 * - entities: differing units at common detailAt ticks.
 */
export function compareRuns(A, B, { label = 'compare', print = true } = {}) {
  const out = {
    same: true, firstTick: null, tickParts: [], firstPoint: null, parts: [], types: [], snapshot: null, live: null,
    entities: [], lastTick: [A.lastTick, B.lastTick], stopped: Boolean(B.stopped),
  };
  if (A.tickHashes && B.tickHashes) {
    const n = Math.min(A.lastTick, B.lastTick);
    for (let t = 0; t <= n; t++) if (A.tickHashes[t] !== B.tickHashes[t]) { out.firstTick = t; break; }
  }
  if (out.firstTick != null) out.tickParts = diffParts(partsAt(A, out.firstTick), partsAt(B, out.firstTick));
  if (out.firstTick != null && A.snapshots?.length && B.snapshots?.length) {
    const bSnap = new Map(B.snapshots.map((s) => [s.tick, s]));
    for (const sa of A.snapshots) {
      if (sa.tick < out.firstTick) continue;
      const sb = bSnap.get(sa.tick);
      if (!sb) continue;
      const entities = diffRows(sa.rows, sb.rows, A.names, B.names);
      const parts = diffParts(sa.parts, sb.parts);
      if (!entities.length && !parts.length) continue;
      out.snapshot = { tick: sa.tick, parts, entities };
      break;
    }
  }
  if (B.live) {
    out.live = {
      tick: B.live.tick, parts: B.live.partsDiff, types: B.live.types,
      changedInTick: B.live.before ? diffRows(B.live.before.rows, B.live.at.rows, B.names, B.names) : [],
    };
  }
  const bTick = new Map(B.points.map((p) => [p.tick, p]));
  for (const pa of A.points) {
    const pb = bTick.get(pa.tick);
    if (!pb) continue;
    const parts = Object.keys({ ...pa.parts, ...pb.parts }).filter((k) => pa.parts[k] !== pb.parts[k]);
    if (pa.total === pb.total && !parts.length) continue;
    out.firstPoint = pa.tick;
    out.parts = parts;
    out.types = Object.keys({ ...pa.types, ...pb.types }).filter((k) => pa.types[k] !== pb.types[k]).slice(0, MAX_LISTED);
    break;
  }
  for (const tick of Object.keys(A.details ?? {})) {
    const db = B.details?.[tick];
    if (!db) continue;
    for (const e of diffRows(A.details[tick].rows, db.rows, A.names, B.names)) out.entities.push({ tick: Number(tick), ...e });
  }
  out.entities = out.entities.slice(0, MAX_LISTED);
  const lengthOk = A.lastTick === B.lastTick || (B.stopped && out.firstTick == null);
  out.same = out.firstTick === null && out.firstPoint === null && lengthOk && !out.entities.length && !out.snapshot;
  if (print) printCompare(label, A, B, out);
  return out;
}

const rowText = (r) => (r ? `${r.kind} ${r.type} t${r.team} x${r.x} z${r.z} yaw${r.yaw} hp${r.hp} ${r.order}→${r.target} f${r.flags}` : '-');
const entityTable = (list) => console.table(list.map((e) => ({ tick: e.tick, eid: e.eid, a: rowText(e.a), b: rowText(e.b) })));

function printCompare(label, A, B, out) {
  if (out.same) { console.info(`[det] ${label}: IDENTICAL (${A.points.length} checkpoints, ${A.lastTick} ticks)`); return; }
  console.warn(`[det] ${label}: DIFFERENT – first tick ${out.firstTick ?? '?'} (subsystems in that tick: ${out.tickParts.join(', ') || '-'}),`
    + ` first checkpoint ${out.firstPoint ?? '- (split healed before the next checkpoint)'}, ticks ${A.lastTick}/${B.lastTick}${out.stopped ? ' (B stopped)' : ''}`);
  if (out.parts.length) console.warn('[det] checkpoint subsystems:', out.parts.join(', '), '| unit types:', out.types.join(', ') || '-');
  if (out.live) {
    console.warn(`[det] live split at tick ${out.live.tick}: ${out.live.parts.join(', ') || '-'}; units that changed in that tick (B):`);
    entityTable(out.live.changedInTick.map((e) => ({ ...e, tick: out.live.tick })));
  }
  if (out.snapshot) {
    console.warn(`[det] first differing snapshot tick ${out.snapshot.tick}: ${out.snapshot.parts.join(', ') || 'units only'}; units A vs B:`);
    entityTable(out.snapshot.entities.map((e) => ({ ...e, tick: out.snapshot.tick })));
  }
  if (out.entities.length) entityTable(out.entities);
}

// ---------- manual control ----------

/** Runs n ticks with the game loop paused (honours readyForTick) */
export async function step(n = 1) {
  const h = handle();
  h.world.paused = true;
  for (let i = 0; i < n;) {
    if (!h.world.readyForTick()) { await nextTask(); continue; }
    stepOnce(h);
    i++;
  }
  return h.world.tick;
}

/** Puts the console helpers on window.steelMen.det (call once from main.js) */
export function installDeterminismConsole() {
  if (typeof window === 'undefined') return;
  window.steelMen ??= {};
  window.steelMen.det = {
    human: runHuman, ai: runAi, compare: compareSaved, totals: async (r) => totals(await asRun(r)),
    save: saveRun, load: loadRun, list: listRuns, clear: clearRuns,
    parts: () => hashParts(), rows: () => entityRows(), step, delayLoads,
    pause: () => { handle().world.paused = true; },
    resume: () => { handle().world.paused = false; },
  };
}
