// Steel Men – debug probe: do the procedural muzzles sit on the simulation shot points (stats.json simBody)?
// Console only, never imported by the game:
//   const P = await import('./src/procedural/debug/MuzzleProbe.js'); await P.runMuzzleProbe()
// For every armed vehicle with a procModel and every armed structure with a procedural model, in every style of
// PROC_MUZZLE.probeRaces, the model is built and placed like the game does (Vehicle.load / Structure.#attachModel /
// DefenseStructure.load), the launch sockets are measured in unit-local space at aim 0 (ProcUnit.simSocketPosition =
// rest pose) and compared with the data shot point:
//   vehicles   simBody.muzzle { height, forward, pivotZ } (byRace) → (0, height, pivotZ + forward); pivot (0, ·, pivotZ)
//              vs the model's turret bone; defaults as CombatVehicle.#muzzle (aimHeight / radius / 0)
//   structures simBody.muzzles[i % n] (byRace) at aim 0; turning models stand at the origin; turret node x/z vs (0, 0)
//   wall post  simBody.turretHeight vs the seat socket (and the model box top, info)
// Reads data only, changes no game state; every model is disposed after measuring. Returns { rows, summary }.
import * as THREE from 'three';
import { loadStats, getStats, unitStats } from '../../data/Stats.js';
import { VEHICLE, STRUCTURE, PROC_MUZZLE } from '../../config.js';
import { structureSimBody, structureScale } from '../../units/Structure.js';
import { createProceduralUnit, hasProceduralUnit } from '../units/UnitKit.js';
import '../units/index.js';
import { loadBuildingStyles, hasProceduralModel, createProceduralStructure } from '../registry.js';
import { POST_SOCKET } from '../MobileWallProc.js';

const DEFAULT_SOCKET = 'muzzle';   // = PROC_VEHICLE.defaultSocket (not imported: ProcVehicle pulls WorkEffects)
const WALL_POST_ID = 'mobileWall';

const _sim = new THREE.Vector3();
const _mod = new THREE.Vector3();
const _box = new THREE.Box3();

const round = (v) => (v == null || Number.isNaN(v) ? null : Number(v.toFixed(PROC_MUZZLE.digits)));

// Race whose model / simBody.byRace entry a unit of `race` uses (same rule as Vehicle / Structure modelRaceOf)
function modelRaceOf(stats, race) {
  const own = getStats().races?.[race]?.modelRace;
  const list = stats.races;
  if (!list) return own ?? race;
  return list.includes(race) ? race : (list.includes(own) ? own : list[0]);
}

// Vehicle simBody with byRace applied (Vehicle.#applySimBody)
function vehicleSimBody(stats, race) {
  const base = stats.simBody;
  if (!base) return null;
  const over = base.byRace?.[race] ?? base.byRace?.[modelRaceOf(stats, race)] ?? null;
  return over ? { ...base, ...over, muzzle: over.muzzle ?? base.muzzle } : base;
}

function row(type, style, weapon, socket, sim, model, extra = {}) {
  const r = { type, style, weapon, socket, simX: round(sim.x), simY: round(sim.y), simZ: round(sim.z) };
  if (model) {
    const dx = model.x - sim.x;
    const dy = model.y - sim.y;
    const dz = model.z - sim.z;
    const dist = Math.hypot(dx, dy, dz);
    Object.assign(r, {
      modelX: round(model.x), modelY: round(model.y), modelZ: round(model.z),
      dx: round(dx), dy: round(dy), dz: round(dz), dist: round(dist), ok: dist <= PROC_MUZZLE.tolerance,
    });
  } else {
    Object.assign(r, { modelX: null, modelY: null, modelZ: null, dx: null, dy: null, dz: null, dist: null, ok: false });
  }
  return Object.assign(r, extra);
}

// ---------------------------------------------------------------- vehicles

function probeVehicle(id, race, rows) {
  const stats = unitStats('vehicles', id, race);
  if (!stats.weapons?.length) return;
  const model = createProceduralUnit(stats.procModel, race, PROC_MUZZLE.teamColor);   // stats key → registered proc id
  if (!model) { rows.push(row(id, race, '-', '(no model)', _sim.set(0, 0, 0), null)); return; }
  const unit = new THREE.Group();
  try {
    model.scale.setScalar(VEHICLE.modelScale * (stats.procScale ?? stats.modelScale ?? 1));
    unit.add(model);
    unit.updateMatrixWorld(true);
    const d = model.dims;
    const body = vehicleSimBody(stats, race);
    const height = (d.minY + d.height) * model.scale.x;
    const radius = body?.radius ?? Math.max(d.length, d.width) * model.scale.x * VEHICLE.radiusFactor;
    const aimHeight = body ? (body.aimHeight ?? body.bodyHeight * VEHICLE.aimHeightFactor) : height * VEHICLE.aimHeightFactor;
    const mz = body?.muzzle;
    const mHeight = mz?.height ?? aimHeight;
    const forward = mz?.forward ?? radius;
    const pivotZ = mz?.pivotZ ?? 0;
    // turret pivot (bone origin) – the simulation turns the barrel around (0, ·, pivotZ)
    const bone = model.getBone('turret');
    const pivot = bone ? bone.getWorldPosition(new THREE.Vector3()) : null;
    const pivotCols = {
      pivotSimZ: mz ? round(pivotZ) : null,
      pivotModelX: pivot ? round(pivot.x) : null, pivotModelY: pivot ? round(pivot.y) : null, pivotModelZ: pivot ? round(pivot.z) : null,
      pivotDZ: pivot && mz ? round(pivot.z - pivotZ) : null,
      muzzleData: mz ? 'simBody.muzzle' : (body ? 'default (aimHeight / radius)' : 'no simBody'),
    };
    stats.weapons.forEach((w, wi) => {
      const names = w.launchSockets ?? [w.launchSocket ?? stats.procLaunch ?? DEFAULT_SOCKET];
      _sim.set(0, mHeight, pivotZ + forward);
      const centre = new THREE.Vector3();
      let found = 0;
      // the first weapon decides (the simulation has one shot point per vehicle); a multi-socket weapon counts by its centre
      const counts = (multi) => wi === 0 && !multi;
      for (const n of names) {
        const s = model.getSocket(n);
        const m = s ? model.simSocketPosition(s, _mod) : null;
        if (m) { centre.add(m); found++; }
        rows.push(row(id, race, w.id, s ? n : `${n} (missing)`, _sim, m, { mount: w.mount ?? 'hull', counts: counts(names.length > 1), ...pivotCols }));
      }
      const last = names.length > 1 ? row(id, race, w.id, '(centre)', _sim, found ? centre.divideScalar(found) : null, { mount: w.mount ?? 'hull', counts: wi === 0, ...pivotCols }) : rows[rows.length - 1];
      if (names.length > 1) rows.push(last);
      // proposal for stats simBody.muzzle measured from this model (first weapon): pivot = turret bone (hull weapons: 0)
      if (wi === 0 && last.modelY != null) {
        const pz = bone && (w.mount === 'turret') ? pivot.z : 0;
        Object.assign(last, { propHeight: round(last.modelY), propForward: round(last.modelZ - pz), propPivotZ: round(pz) });
      }
    });
  } finally {
    unit.remove(model);
    model.dispose();
  }
}

// ---------------------------------------------------------------- structures

function probeStructure(id, race, rows) {
  const stats = unitStats('structures', id, race);
  const body = structureSimBody(stats, race);
  const model = createProceduralStructure(id, race, PROC_MUZZLE.teamColor);
  if (!model) return;
  const root = new THREE.Group();
  const holder = new THREE.Group();
  try {
    model.scale.setScalar(structureScale(stats));
    const turns = (stats.turnSpeed ?? 0) > 0;
    const c = model.glbCentre;
    model.position.set(!turns && c ? -c.x * model.scale.x : 0, 0, !turns && c ? -c.z * model.scale.x : 0);
    holder.add(model);
    root.add(holder);
    model.setAim?.(0);
    root.updateMatrixWorld(true);

    if (id === WALL_POST_ID) {
      const s = model.getObjectByName(POST_SOCKET);
      _sim.set(0, body?.turretHeight ?? 0, 0);
      _box.setFromObject(model);
      rows.push(row(id, race, 'turretSeat', POST_SOCKET, _sim, s ? s.getWorldPosition(_mod) : null,
        { boxTop: round(_box.max.y), muzzleData: 'simBody.turretHeight' }));
      return;
    }
    if (!stats.weapons?.length) return;
    const muzzles = body?.muzzles ?? [];
    const aimHeight = (body?.bodyHeight ?? 0) * STRUCTURE.aimHeightFactor;
    const turret = model.turret ?? null;
    const tp = turret ? turret.getWorldPosition(new THREE.Vector3()) : null;
    const extra = {
      mount: turns ? 'turns' : 'fixed',
      pivotModelX: tp ? round(tp.x) : null, pivotModelY: tp ? round(tp.y) : null, pivotModelZ: tp ? round(tp.z) : null,
      muzzleData: muzzles.length ? 'simBody.muzzles' : 'default (0, aimHeight, 0)',
    };
    const names = stats.launchSockets ?? (model.sockets ?? []).map((o) => o.name);
    names.forEach((n, i) => {
      const m = muzzles.length ? muzzles[i % muzzles.length] : null;
      if (m) _sim.set(m[0], m[1], m[2]); else _sim.set(0, aimHeight, 0);
      const s = model.getObjectByName(n);
      rows.push(row(id, race, stats.weapons[0].id, s ? n : `${n} (missing)`, _sim, s ? s.getWorldPosition(_mod) : null, extra));
    });
  } finally {
    holder.remove(model);
    model.dispose();
  }
}

// ---------------------------------------------------------------- entry

/**
 * Builds every armed procedural vehicle / structure in every probe style and prints the muzzle deviations.
 * @param {object} [o]
 * @param {string[]} [o.ids]     only these stats ids
 * @param {string[]} [o.races]   styles (default PROC_MUZZLE.probeRaces)
 * @param {boolean} [o.print]    console.table output (default true)
 * @returns {Promise<{rows: object[], summary: object[]}>}
 */
export async function runMuzzleProbe({ ids = null, races = PROC_MUZZLE.probeRaces, print = true } = {}) {
  await loadStats();
  await loadBuildingStyles();
  const st = getStats();
  const rows = [];
  const want = (id) => !ids || ids.includes(id);
  for (const [id, v] of Object.entries(st.vehicles ?? {})) {
    if (!want(id) || !v.procModel || !v.weapons?.length || !hasProceduralUnit(v.procModel)) continue;
    for (const race of races) {
      try { probeVehicle(id, race, rows); } catch (err) { console.warn(`[MuzzleProbe] ${id} ${race}:`, err); }
    }
  }
  for (const [id, s] of Object.entries(st.structures ?? {})) {
    if (!want(id) || !hasProceduralModel(id) || !(s.weapons?.length || id === WALL_POST_ID)) continue;
    for (const race of races) {
      try { probeStructure(id, race, rows); } catch (err) { console.warn(`[MuzzleProbe] ${id} ${race}:`, err); }
    }
  }
  // worst deviation per type + style
  const worst = new Map();
  for (const r of rows) {
    if (r.counts === false) continue;   // vehicle: other weapons / single sockets of a salvo (centre row counts)
    const k = `${r.type}|${r.style}`;
    const w = worst.get(k);
    if (!w || (r.dist ?? Infinity) > (w.maxDist ?? -1)) {
      worst.set(k, {
        type: r.type, style: r.style, socket: r.socket, maxDist: r.dist ?? Infinity, dx: r.dx, dy: r.dy, dz: r.dz, pivotDZ: r.pivotDZ ?? null,
        propHeight: r.propHeight ?? null, propForward: r.propForward ?? null, propPivotZ: r.propPivotZ ?? null,
      });
    }
  }
  const summary = [...worst.values()].map((w) => ({ ...w, ok: w.maxDist <= PROC_MUZZLE.tolerance }));
  if (print) {
    console.log(`[MuzzleProbe] ${rows.length} sockets, tolerance ${PROC_MUZZLE.tolerance}; failing: ${summary.filter((s) => !s.ok).length}/${summary.length}`);
    console.table(rows);
    console.table(summary);
  }
  return { rows, summary };
}

/** Tab-separated table of the rows (paste into the notes / a spreadsheet): copy(P.toTsv(result.rows)) */
export function toTsv(list) {
  if (!list.length) return '';
  const keys = Object.keys(list.reduce((a, r) => Object.assign(a, r), {}));
  return [keys.join('\t'), ...list.map((r) => keys.map((k) => r[k] ?? '').join('\t'))].join('\n');
}
