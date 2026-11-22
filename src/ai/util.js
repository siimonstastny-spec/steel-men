// Steel Mans AI – small helpers shared by the managers (geometry, unit state, strength). Read-only: nothing here
// changes the simulation.
import { weaponDps } from '../data/Stats.js';
import { playerOrder } from '../units/OrderQueue.js';
import { AI } from '../config.js';

/** Priorities of the AI's command rate limiter (higher is sent first) */
export const PRIORITY = { low: 1, normal: 2, high: 3, urgent: 4 };

export const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const posOf = (u) => ({ x: u.position.x, z: u.position.z });
export const pointOf = (p) => ({ x: Number(p.x), z: Number(p.z) });

/** Unit vector from a to b (fallback when they coincide) */
export function dirTo(a, b, fallback = { x: 0, z: 1 }) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  return len < 1e-6 ? { ...fallback } : { x: dx / len, z: dz / len };
}

/** Turns a direction by `angle` rad (counter-clockwise seen from above with x right, z down) */
export function rotate(d, angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return { x: d.x * c - d.z * s, z: d.x * s + d.z * c };
}

export const add = (p, d, k = 1) => ({ x: p.x + d.x * k, z: p.z + d.z * k });

/** Centroid of units / points */
export function centroid(list) {
  if (!list.length) return null;
  let x = 0;
  let z = 0;
  for (const u of list) { const p = u.position ?? u; x += p.x; z += p.z; }
  return { x: x / list.length, z: z / list.length };
}

/** Nearest item of a list to a point (item.position or item.x/z), or null */
export function nearest(list, p, posFn = (o) => o.position ?? o) {
  let best = null;
  let bestD = Infinity;
  for (const o of list) {
    const d = dist(posFn(o), p);
    if (d < bestD) { best = o; bestD = d; }
  }
  return best;
}

/** The unit has no order from its player and nothing queued (an automatic fight does not count) */
export const isIdle = (u) => !playerOrder(u) && !(u.orderQueue?.length);

export const alive = (u) => Boolean(u) && !u.destroyed && !u.removed;

/** Current and max HP of any unit (mechs: sum of their parts) */
export function hpOf(u) {
  if (u.isMech) {
    const parts = Object.values(u.parts ?? {});
    return { hp: parts.reduce((s, p) => s + Math.max(0, p.hp ?? 0), 0), max: u.stats?.hp ?? parts.reduce((s, p) => s + (p.maxHp ?? 0), 0) };
  }
  return { hp: Math.max(0, u.hp ?? 0), max: u.maxHp ?? u.hp ?? 0 };
}

/** Damage per second of a unit against ground targets (0 for unarmed units, crewless mechs count their parts) */
export function dpsOf(u) {
  if (u.isMech) return u.stats?.dps ?? 0;
  const weapons = u.stats?.weapons ?? [];
  return weapons.filter((w) => (w.targets ?? ['ground']).includes('ground')).reduce((s, w) => s + weaponDps(w), 0);
}

/**
 * Fighting strength = √(HP × DPS) – grows linearly with the number of units, so army strengths can be summed and
 * compared (a unit with no weapons is 0). Crewless mechs are 0 (they cannot fight).
 */
export function strengthOf(u) {
  if (u.isMech && !u.crew) return 0;
  const dps = dpsOf(u);
  if (dps <= 0) return 0;
  const hp = Math.min(hpOf(u).hp, AI.strengthHpCap);
  return Math.sqrt(hp * dps);
}

/** Weapon definitions of a unit (mech parts, combat vehicles, towers): stats.json weapon objects */
export function weaponDefsOf(u) {
  if (u.weapons?.length) return u.weapons.map((w) => w.def ?? w.stats).filter(Boolean);
  return u.stats?.weapons ?? [];
}

/**
 * Role of a unit from its weapon classes (armies.json roleClasses): 'artillery' if any weapon is artillery,
 * 'melee' if all are melee, else 'ranged'; null without weapons.
 */
export function roleOfClasses(classes, roleClasses = {}) {
  if (!classes.length) return null;
  if (classes.some((c) => (roleClasses.artillery ?? []).includes(c))) return 'artillery';
  if (classes.every((c) => (roleClasses.melee ?? []).includes(c))) return 'melee';
  return 'ranged';
}

/** Longest ground weapon range of a unit (0 when unarmed) */
export function rangeOf(u) {
  return weaponDefsOf(u).filter((w) => (w.targets ?? ['ground']).includes('ground'))
    .reduce((m, w) => Math.max(m, w.range ?? 0), 0);
}

/** Armour of a unit per damage type (mechs: HP-weighted mean of their mounted parts) */
export function armorOf(u) {
  if (u.isMech) {
    const parts = Object.values(u.parts ?? {}).filter((p) => p && p.alive !== false && p.stats);
    const total = parts.reduce((s, p) => s + (p.maxHp ?? p.stats.hp ?? 0), 0);
    const out = {};
    for (const p of parts) {
      const w = (p.maxHp ?? p.stats.hp ?? 0) / Math.max(1, total);
      for (const [t, v] of Object.entries(p.stats.armor ?? {})) out[t] = (out[t] ?? 0) + v * w;
    }
    return out;
  }
  return { ...(u.stats?.armor ?? {}) };
}

/** Is a mech missing an arm (empty or destroyed arm slot)? */
export function missingArmSlots(mech) {
  if (!mech?.isMech) return [];
  return ['leftArm', 'rightArm'].filter((slot) => {
    const p = mech.parts?.[slot];
    return !p || p.alive === false;
  });
}

/** Total of a cost object's resources (ore + energy…) */
export const costTotal = (cost = {}) => Object.values(cost).reduce((s, v) => s + (v ?? 0), 0);

/** Adds cost objects */
export function sumCost(...costs) {
  const out = {};
  for (const c of costs) for (const [r, v] of Object.entries(c ?? {})) out[r] = (out[r] ?? 0) + (v ?? 0);
  return out;
}

/**
 * D3: can the team pay `cost` and still keep `keepA` + `keepB` (reserves / minimums, cost objects or null)?
 * Infinite resources (startMultiplier 'infinite'): always (economy.canAfford). No allocation.
 */
export function affordsAbove(eco, team, cost, keepA = null, keepB = null) {
  if (eco.infiniteResources) return eco.canAfford(team, cost);
  for (const r in cost) {
    if (eco.amount(team, r) - (keepA?.[r] ?? 0) - (keepB?.[r] ?? 0) < (cost[r] ?? 0)) return false;
  }
  return true;
}

/** Picks a key of a { key: weight } object at random (own randomness – the AI may be non-deterministic) */
export function weightedPick(weights) {
  const entries = Object.entries(weights ?? {}).filter(([, w]) => w > 0);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  if (!total) return null;
  let r = Math.random() * total;
  for (const [k, w] of entries) { if ((r -= w) <= 0) return k; }
  return entries.at(-1)[0];
}

/** Rounds a yaw to the nearest quarter turn (axis-aligned pathfinding boxes are tightest there) */
export const quarterYaw = (yaw) => Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);

/** Yaw that faces along a direction (same convention as the start positions: forward = (sin yaw, cos yaw)) */
export const yawOf = (d) => Math.atan2(d.x, d.z);
