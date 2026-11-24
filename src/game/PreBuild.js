// Steel Men – [N8] optional pre-build phase (docs/notes/n8-flee-prebuild.md).
// For the first N minutes of a match every team is held in a square around its start (world.teamStarts[team]):
// units cannot leave it, nobody can attack, buildings can only be placed inside the own square. Afterwards the
// limits are gone. The phase is pure simulation state: it depends only on world.tick and world.prebuild, which
// every client sets from the same host settings, so it is deterministic and never reads the local player.
//
//   startPrebuild(world, minutes)       Match constructor; 0 / invalid = no phase (world.prebuild = null)
//   isPrebuild(world)                   true while the phase runs
//   prebuildSecondsLeft(world)          0 when no phase runs (HUD countdown)
//   attacksAllowed(world)               false during the phase (Combat gate)
//   prebuildArea(world, team)           { x, z, half } of the team's square, or null when nothing is limited
//   clampToArea(world, unit, point, out) point moved inside the unit's square (minus radius); null = no limit
//   boxInArea(world, team, box)         building footprint box { x, z, halfX, halfZ } fully inside (true = allowed)
//   confineUnits(world, units)          pushes units back inside their squares (Movement.resolveCollisions)
//   validPrebuild(v) / prebuildLabel(v) menu helpers (PREBUILD.options minutes, 0 = off)
import { PREBUILD, SIM } from '../config.js';
import { t } from '../i18n/i18n.js';

export { PREBUILD };

/** Minutes of the pre-build phase from a settings value: one of PREBUILD.options, anything else = PREBUILD.default */
export function validPrebuild(v) {
  return PREBUILD.options.includes(v) ? v : PREBUILD.default;
}

/** Button text of a minutes option */
export function prebuildLabel(v) {
  return v > 0 ? t('setup.prebuild.minutes', { n: v }) : t('setup.prebuild.off');
}

/**
 * Sets the phase for a new match. The tick counter starts at 0 with world.startSimulation (after the Match is
 * created), so the end is an absolute tick: minutes × 60 × SIM.tickRate.
 */
export function startPrebuild(world, minutes) {
  const m = validPrebuild(minutes);
  world.prebuild = m > 0 ? { endTick: Math.round(m * 60 * SIM.tickRate), minutes: m } : null;
  return world.prebuild;
}

export function isPrebuild(world) {
  const p = world?.prebuild;
  return !!p && world.tick < p.endTick;
}

export function prebuildTicksLeft(world) {
  return isPrebuild(world) ? world.prebuild.endTick - world.tick : 0;
}

export function prebuildSecondsLeft(world) {
  return prebuildTicksLeft(world) / SIM.tickRate;
}

export function attacksAllowed(world) {
  return !isPrebuild(world);
}

/** Square of a team while the phase runs (centred on its start), null outside the phase or for a team without a start */
export function prebuildArea(world, team) {
  if (!isPrebuild(world)) return null;
  const start = world.teamStarts?.[team];
  if (!start) return null;
  return { x: start.x, z: start.z, half: PREBUILD.halfSize };
}

/**
 * The point moved inside the unit's square, kept radius + PREBUILD.edgeMargin from the edge.
 * @returns {{x:number, z:number}|null} `out` (a fresh object if not given), or null when the unit is not limited
 */
export function clampToArea(world, unit, point, out = null) {
  const a = prebuildArea(world, unit.team);
  if (!a) return null;
  const lim = Math.max(0, a.half - (unit.radius ?? 0) - PREBUILD.edgeMargin);
  const res = out ?? { x: 0, z: 0 };
  res.x = Math.min(a.x + lim, Math.max(a.x - lim, point.x));
  res.z = Math.min(a.z + lim, Math.max(a.z - lim, point.z));
  return res;
}

/** A building footprint box lies fully inside the team's square (always true outside the phase) */
export function boxInArea(world, team, box) {
  const a = prebuildArea(world, team);
  if (!a) return true;
  return Math.abs(box.x - a.x) + box.halfX <= a.half && Math.abs(box.z - a.z) + box.halfZ <= a.half;
}

/**
 * Pushes every limited unit back inside its square (positions only; structures never move). Called once per tick
 * after collisions, so knockback or crowding cannot carry a unit out either.
 * @returns {Set<object>} units that were moved (their y needs the terrain height again)
 */
export function confineUnits(world, units) {
  const moved = new Set();
  if (!isPrebuild(world)) return moved;
  const p = { x: 0, z: 0 };
  for (const u of units) {
    if (u.isStructure || u.inside) continue;
    if (!clampToArea(world, u, u.position, p)) continue;
    if (p.x === u.position.x && p.z === u.position.z) continue;
    u.position.x = p.x;
    u.position.z = p.z;
    moved.add(u);
  }
  return moved;
}
