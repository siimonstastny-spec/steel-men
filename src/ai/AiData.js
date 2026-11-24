// Steel Men AI – data of the computer player (data/ai/*.json) and "roles": generic names (@power, @crew…) that are
// resolved from stats.json for a race, so neither the code nor the data name factions or race-specific buildings.
import { getStats, loadStats, canProduce } from '../data/Stats.js';
import { AI, AIR } from '../config.js';

const FILES = ['difficulty', 'buildOrders', 'armies', 'defense', 'research'];
let dataPromise = null;

/** Loads data/ai/*.json once: { difficulty, buildOrders, armies, defense } */
export function loadAiData() {
  dataPromise ??= Promise.all([
    loadStats(),
    ...FILES.map((name) => fetch(`${AI.dataPath}${name}.json`).then((res) => {
      if (!res.ok) throw new Error(`AI data ${name}.json: HTTP ${res.status}`);
      return res.json();
    })),
  ]).then(([, ...files]) => Object.fromEntries(FILES.map((name, i) => [name, files[i]])));
  return dataPromise;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Recursive merge of plain objects (arrays and values are replaced) */
export function merge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra ?? {})) out[k] = isObject(v) && isObject(out[k]) ? merge(out[k], v) : v;
  return out;
}

/** Difficulty settings (unknown id → 'normal') */
export function difficultyOf(data, id) {
  const all = data.difficulty;
  return { id: all[id] ? id : 'normal', ...(all[id] ?? all.normal) };
}

/** Build order list for a race and a build order name */
export function buildOrderOf(data, race, name) {
  const b = data.buildOrders;
  return b.races?.[race]?.[name] ?? b.default?.[name] ?? b.default?.normal ?? [];
}

/** Army settings with the race override merged in */
export function armiesOf(data, race) {
  return merge(data.armies.default, data.armies.races?.[race]);
}

/** Defence plan by name */
export function defensePlanOf(data, name) {
  return data.defense[name] ?? data.defense.none ?? { items: [] };
}

/** Research plan by name (research.json); { enabled: false } when missing */
export function researchPlanOf(data, name) {
  return data.research?.[name] ?? data.research?.none ?? { enabled: false };
}

// ---------- research roles ----------

const asList = (v) => (v === undefined || v === null ? [] : [].concat(v));

/**
 * Roles of a research from its stats.json effects (research.json _doc): a Set of
 * 'unlock' | 'weapons' | 'armor' | 'vehicles' | 'mobility' | 'repair' | 'economy' | 'crew' | 'salvage'.
 * `unlocks` = world.research.unlocksOf(id) (items it unlocks). Pending effects do not count.
 */
export function researchRolesOf(def, unlocks = []) {
  const roles = new Set();
  if (unlocks.length) roles.add('unlock');
  for (const e of def?.effects ?? []) {
    if (e.pending) continue;
    if (e.type === 'unlock') { roles.add('unlock'); continue; }
    if (e.type === 'rule') {
      const path = String(e.path ?? '');
      if (path.startsWith('repair.')) roles.add('repair');
      else if (path.startsWith('crew.')) roles.add('crew');
      else if (path.startsWith('salvage')) roles.add('salvage');
      else if (path.startsWith('combat.')) roles.add('armor');
      continue;
    }
    if (e.type !== 'modify') continue;
    const cat = e.target?.category;
    const stat = String(e.stat ?? '');
    if (cat === 'weapon') roles.add('weapons');
    else if (cat === 'ability' && asList(e.target.abilityType).includes('harvest')) roles.add('economy');
    else if (cat === 'crew') roles.add('crew');
    else if (cat === 'vehicle') roles.add('vehicles');
    else if (stat.startsWith('mobility.')) roles.add('mobility');
    else if (cat === 'part' && (stat === 'hp' || stat.startsWith('armor.'))) roles.add('armor');
  }
  return roles;
}

/**
 * Weapon effects of a research only help when the team uses that weapon: does any effect target one of these
 * classes / weapon ids? (effects without a class / id filter help every weapon)
 */
export function researchFitsWeapons(def, classes, ids) {
  const weaponEffects = (def?.effects ?? []).filter((e) => !e.pending && e.type === 'modify' && e.target?.category === 'weapon');
  if (!weaponEffects.length) return true;
  return weaponEffects.some((e) => {
    const cls = asList(e.target.weaponClass);
    const wid = asList(e.target.weaponId);
    if (!cls.length && !wid.length) return true;
    return cls.some((c) => classes.has(c)) || wid.some((w) => ids.has(w));
  });
}

// ---------- roles ----------

const crewProducedAt = () => [].concat(getStats().crew?.producedAt ?? []);
const weaponsOf = (s) => s.weapons ?? [];
const abilityOf = (s, type) => (s.abilities ?? []).some((a) => a.type === type);
/** [R3] Flying unit (stats mobility.movementType) */
export const isAirStats = (v) => v?.mobility?.movementType === AIR.movementType;
/** [R3] Does a weapon definition hit aircraft (targets "air")? */
export const hitsAir = (w) => (w?.targets ?? []).includes('air');
/** [R3] Does a structure id produce flying vehicles (some vehicle with producedAt = id flies)? */
function makesAircraft(id) {
  return Object.values(getStats().vehicles ?? {}).some((v) => isAirStats(v) && [].concat(v.producedAt ?? []).includes(id));
}

/** Predicates of structure roles (raw stats.json entries) */
export const STRUCTURE_ROLES = {
  power: (s) => (s.income?.energy ?? 0) > 0 && !s.hq,
  supply: (s) => (s.supplyProvided ?? 0) > 0 && !s.hq,
  crew: (s, id) => (s.produces ?? []).includes('crew') && crewProducedAt().includes(id),
  parts: (s) => (s.produces ?? []).includes('part'),
  assembly: (s) => (s.produces ?? []).includes('mech'),
  // [R3 / N7-7] ground vehicle factory only – a hangar also produces "vehicle" but makes aircraft
  vehicles: (s, id) => (s.produces ?? []).includes('vehicle') && !makesAircraft(id),
  aircraft: (s, id) => (s.produces ?? []).includes('vehicle') && makesAircraft(id),
  research: (s) => (s.produces ?? []).includes('research'),
  storage: (s) => (s.storage?.energy ?? 0) > 0,
  tower: (s) => weaponsOf(s).length > 0 && !s.placement,
  antiAir: (s) => !s.placement && weaponsOf(s).some(hitsAir), // [R3] tower that shoots aircraft
  wallPost: (s) => s.placement === 'wall',
  turret: (s) => s.placement === 'post',
  hq: (s) => Boolean(s.hq),
  // [H5] building that produces ore endlessly (oreDeepExtractor, stats.deepExtraction); placed like other buildings
  deepMining: (s) => Boolean(s.deepExtraction),
};

/** Predicates of vehicle roles */
export const VEHICLE_ROLES = {
  harvester: (v) => abilityOf(v, 'harvest'),
  builder: (v) => abilityOf(v, 'construct'),
  combatVehicle: (v) => weaponsOf(v).length > 0 && !isAirStats(v),
  aircraft: (v) => weaponsOf(v).length > 0 && isAirStats(v), // [R3]
};

const costOf = (s) => (s.cost?.ore ?? 0) + (s.cost?.energy ?? 0);

/** Structure ids this race may build (buildable, faction / research allowed), data order */
export function buildableStructures(race, unlocks) {
  return Object.entries(getStats().structures ?? {})
    .filter(([id, s]) => s.buildable !== false && canProduce(race, 'structures', id, unlocks))
    .map(([id]) => id);
}

/** Vehicle ids this race may produce */
export function producibleVehicles(race, unlocks) {
  return Object.entries(getStats().vehicles ?? {})
    .filter(([id, v]) => v.buildable !== false && canProduce(race, 'vehicles', id, unlocks))
    .map(([id]) => id);
}

const isRole = (value) => typeof value === 'string' && value.startsWith('@');
const roleName = (value) => value.slice(1);

/** Does a structure id answer a role / id? ('@power' or 'solarPanel') */
export function structureMatches(value, id) {
  if (!isRole(value)) return value === id;
  const s = getStats().structures?.[id];
  const pred = STRUCTURE_ROLES[roleName(value)];
  return Boolean(s && pred && pred(s, id));
}

/** Does a vehicle id answer a role / id? */
export function vehicleMatches(value, id) {
  if (!isRole(value)) return value === id;
  const v = getStats().vehicles?.[id];
  const pred = VEHICLE_ROLES[roleName(value)];
  return Boolean(v && pred && pred(v, id));
}

/**
 * Structure id to build for a role (cheapest buildable candidate, data order on ties) or a literal id when the race
 * may build it. null = nothing fits this race.
 */
export function resolveStructure(value, race, unlocks) {
  const ids = buildableStructures(race, unlocks);
  if (!isRole(value)) return ids.includes(value) ? value : null;
  const all = getStats().structures;
  const fits = ids.filter((id) => structureMatches(value, id));
  fits.sort((a, b) => costOf(all[a]) - costOf(all[b]));
  return fits[0] ?? null;
}

/** All vehicle ids answering a role / id for this race */
export function resolveVehicles(value, race, unlocks) {
  return producibleVehicles(race, unlocks).filter((id) => vehicleMatches(value, id));
}

/** Cheapest vehicle answering a role / id, or null */
export function resolveVehicle(value, race, unlocks) {
  const all = getStats().vehicles;
  const fits = resolveVehicles(value, race, unlocks);
  fits.sort((a, b) => costOf(all[a]) - costOf(all[b]));
  return fits[0] ?? null;
}

/** Does the race get its whole population at the start (no supply buildings needed)? */
export function fullPopulation(race) {
  return Boolean(getStats().races?.[race]?.population?.fullFromStart);
}
