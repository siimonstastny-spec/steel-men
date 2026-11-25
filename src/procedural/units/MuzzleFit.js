// Steel Men – [B5-muzzles] where a procedural vehicle's main muzzle should sit: the simulation shot point of stats.json
// (vehicles[id].simBody.muzzle, byRace, defaults as CombatVehicle.#muzzle) in MODEL units (÷ VEHICLE.modelScale ×
// procScale), for the unit builder (UnitModules turret() / weapon() fit within PROC_MUZZLE.fit, docs/notes/b5-muzzles.md).
// Read-only use of the data at model build time; the simulation never reads the model for its shot point.
import { getStats } from '../../data/Stats.js';
import { VEHICLE, AIR, PROC_MUZZLE } from '../../config.js';

const DEFAULT_SOCKET = 'muzzle';   // = PROC_VEHICLE.defaultSocket

// Race whose simBody.byRace entry a unit of `race` uses (same rule as Vehicle modelRaceOf)
function modelRaceOf(entry, race, st) {
  const own = st.races?.[race]?.modelRace;
  const list = entry.races;
  if (!list) return own ?? race;
  return list.includes(race) ? race : (list.includes(own) ? own : list[0]);
}

/** Is stats.json loaded (a model built now gets its muzzle fit)? Caches built earlier keep a separate key (UnitKit, WallTurretProc) */
export function muzzleDataReady() {
  try { return Boolean(getStats()); } catch { return false; }
}

/**
 * Target of the main muzzle of procedural unit `procId` in style `race` (model space, aim 0):
 * { y, z, pivotZ (null without simBody.muzzle), socket (first launch socket of the first weapon), explicit }
 * or null – stats not loaded, no armed vehicle uses the model, aircraft (PROC_MUZZLE.fit.aircraft false), no simBody.
 */
export function muzzleFitTarget(procId, race) {
  if (!PROC_MUZZLE.fit.enabled) return null;
  let st;
  try { st = getStats(); } catch { return null; }
  const entry = Object.values(st?.vehicles ?? {}).find((v) => v.procModel === procId && v.weapons?.length);
  if (!entry?.simBody) return null;
  if (!PROC_MUZZLE.fit.aircraft && entry.mobility?.movementType === AIR.movementType) return null;
  const base = entry.simBody;
  const over = base.byRace?.[race] ?? base.byRace?.[modelRaceOf(entry, race, st)] ?? null;
  const body = over ? { ...base, ...over, muzzle: over.muzzle ?? base.muzzle } : base;
  const scale = VEHICLE.modelScale * (entry.procScale ?? entry.modelScale ?? 1);
  const mz = body.muzzle;
  const aim = body.aimHeight ?? body.bodyHeight * VEHICLE.aimHeightFactor;
  const height = mz?.height ?? aim;
  const forward = mz?.forward ?? body.radius;
  const pivotZ = mz?.pivotZ ?? 0;
  const w = entry.weapons[0];
  return {
    y: height / scale,
    z: (pivotZ + forward) / scale,
    pivotZ: mz ? pivotZ / scale : null,
    socket: w.launchSockets?.[0] ?? w.launchSocket ?? entry.procLaunch ?? DEFAULT_SOCKET,
    explicit: Boolean(mz),
  };
}
