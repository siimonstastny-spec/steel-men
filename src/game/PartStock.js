// Steel Men – robot parts as goods: the part catalog (parts.json, what models exist per slot), which parts a
// faction may make (canProduce 'partSets'), and the per-team stock of finished parts that the part factory
// (RobotPartFactory) fills and the assembly bay (RobotAssemblyBay) takes from. One stock lives in
// world.economy.parts. Parts are counted by model path; an arm is universal: left and right models of one type share one stock entry.
// Only the simulation changes the stock (Production.js, Repair.js); the UI reads it.
import { partStats, canProduce, withModelRaceParts, SLOT_KIND } from '../data/Stats.js';
import { ARMS } from '../config.js';

export const MECH_SLOTS = ['legs', 'torso', 'leftArm', 'rightArm'];
/** Slots of the part factory / stock: an arm is ONE universal part (ARMS.slot), mounted on either side */
export const PART_SLOTS = ['legs', 'torso', ARMS.slot];
export const ARM_SLOTS = Object.keys(ARMS.sidePrefix);

/** Catalog slot behind a factory slot ('arm' -> the canonical side's model list) */
export const catalogSlot = (slot) => (slot === ARMS.slot ? ARMS.canonicalSlot : slot);

const SIDE_RE = new RegExp(`(^|/)(?:${Object.values(ARMS.sidePrefix).join('|')})(?=[A-Z])`);

/** Stock key of a part model: an arm model of either side -> the canonical (left) model; other parts unchanged */
export function stockKey(path) {
  return typeof path === 'string' ? path.replace(SIDE_RE, `$1${ARMS.sidePrefix[ARMS.canonicalSlot]}`) : path;
}

/** Model of a stocked arm (any side's path or stock key) for a mech slot ('leftArm' | 'rightArm') */
export function armModel(path, slot) {
  return stockKey(path).replace(SIDE_RE, `$1${ARMS.sidePrefix[slot]}`);
}
const PRODUCTION_KIND = 'partSets'; // races[*].exclusive group that limits part production
const BASE_SET = 'Basic';           // listed first in every slot
const CATALOG_URL = './parts.json';

let catalogPromise = null;

/** parts.json once for the whole game: { legs: [{ path, set, race }], torso: [...], ... } */
export function loadPartCatalog(url = CATALOG_URL) {
  catalogPromise ??= fetch(url).then((res) => {
    if (!res.ok) throw new Error(`Part catalog ${url}: HTTP ${res.status}`);
    return res.json();
  }).then(withModelRaceParts); // factions with stand-in models (stats.json races[*].modelRace) get the model race's parts
  return catalogPromise;
}

/**
 * Parts of a slot a faction may make, Basic first. Models without a race (e.g. Frame) are offered to every
 * faction unless their stats say buildable: false.
 */
export function partOptions(catalog, factorySlot, race, unlocked = null) {
  const slot = catalogSlot(factorySlot); // 'arm' lists the canonical side; its key stands for both sides
  return (catalog?.[slot] ?? [])
    .filter((p) => (p.race === race || (p.race === null && partStats(p.path, slot, race).buildable))
      && canProduce(race, PRODUCTION_KIND, p.set, unlocked, SLOT_KIND[slot])) // research / salvage unlock per part kind
    .sort((a, b) => (a.set === BASE_SET ? -1 : b.set === BASE_SET ? 1 : a.set.localeCompare(b.set)));
}

/** Catalog entry of a model path in a slot, or null (validates paths coming from commands) */
export function catalogEntry(catalog, slot, path) {
  return (catalog?.[slot] ?? []).find((p) => p.path === path) ?? null;
}

/** Frame part of a slot (placeholder shown in the assembly preview for a slot without a part) */
export function framePart(catalog, slot) {
  return (catalog?.[slot] ?? []).find((p) => p.set === 'Frame') ?? null;
}

/**
 * Finished robot parts per team: stockKey(path) -> count. Left and right arm models of one type share one entry
 * (every method accepts a model path of either side).
 */
export class PartStock {
  constructor(teams) {
    this.counts = Array.from({ length: teams }, () => new Map());
  }

  count(team, path) { return this.counts[team]?.get(stockKey(path)) ?? 0; }

  add(team, path, n = 1) {
    const m = this.counts[team];
    const key = stockKey(path);
    if (m && key) m.set(key, (m.get(key) ?? 0) + n);
  }

  /** Takes one part; false when there is none */
  take(team, path) {
    const key = stockKey(path);
    const n = this.count(team, key);
    if (n <= 0) return false;
    if (n === 1) this.counts[team].delete(key); else this.counts[team].set(key, n - 1);
    return true;
  }

  /** Stock keys in stock (count > 0): arms as the canonical (left) model path */
  paths(team) { return [...(this.counts[team]?.keys() ?? [])]; }

  /** Total number of parts in stock */
  total(team) { let n = 0; for (const v of this.counts[team]?.values() ?? []) n += v; return n; }
}
