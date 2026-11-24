// Steel Men – starting robot loadouts of a faction (test scene and match start, ROADMAP 12).
// Pure and deterministic: the same race + the same data always give the same loadouts, so every client of a
// lockstep match builds the same robots. The code knows no faction names: LOADOUT.templates (config.js) list, per
// slot, part sets in order of preference; the first set the race may produce (canProduce) and has a model of
// (catalog entry of its own race) wins, Basic is the fallback. Raceless parts (Frame, Alien) are never picked.
// Legs are chosen last: the first candidate whose loadCapacity carries the chosen torso and arms (no overload).
import { LOADOUT, START_SETS } from '../config.js';
import { partStats, canProduce, SLOT_KIND } from '../data/Stats.js';

const PRODUCTION_KIND = 'partSets'; // races[*].exclusive group that limits part production

/** Catalog entry of a set in a slot for this race, or null (raceless parts never match) */
function entryOf(catalog, slot, set, race) {
  return (catalog?.[slot] ?? []).find((p) => p.set === set && p.race === race) ?? null;
}

/** Candidate sets of a slot that the race may produce (no research / salvage unlock assumed) and has a model of */
function allowed(catalog, slot, race, candidates) {
  return candidates
    .filter((set) => canProduce(race, PRODUCTION_KIND, set, null, SLOT_KIND[slot]))
    .map((set) => entryOf(catalog, slot, set, race))
    .filter(Boolean);
}

/**
 * One loadout from a template: { legs, torso, leftArm, rightArm } model paths (relative to models/).
 * @param {object} catalog  loadPartCatalog() result
 * @param {string} race     stats.json race key
 * @param {object} template LOADOUT.templates[id]: { legs: [set…], torso: [set…], leftArm: [set…], rightArm: [set…] }
 */
export function loadoutFromTemplate(catalog, race, template) {
  const pick = (slot) => {
    const list = allowed(catalog, slot, race, [...(template[slot] ?? []), LOADOUT.fallbackSet]);
    return list[0];
  };
  const chosen = { torso: pick('torso'), leftArm: pick('leftArm'), rightArm: pick('rightArm') };
  const carried = ['torso', 'leftArm', 'rightArm']
    .reduce((sum, slot) => sum + partStats(chosen[slot].path, slot, race).mass, 0);
  // Legs: first candidate that carries everything; none does = the strongest one (a slight overload at worst)
  const legs = allowed(catalog, 'legs', race, [...(template.legs ?? []), LOADOUT.fallbackSet])
    .map((entry) => ({ entry, capacity: partStats(entry.path, 'legs', race).loadCapacity }));
  const best = legs.find((l) => l.capacity >= carried)
    ?? legs.reduce((a, b) => (b.capacity > a.capacity ? b : a));
  return {
    legs: best.entry.path,
    torso: chosen.torso.path,
    leftArm: chosen.leftArm.path,
    rightArm: chosen.rightArm.path,
  };
}

/**
 * [N15a] The mech of a start set (stats.json → rules.economy.startSets.<id>.mech): { legs, torso, leftArm, rightArm } set
 * ids; START_SETS.armPlaceholder in a slot = the race's own `startArm` (stats.json races.<race>.startArm).
 * A set the race cannot produce falls back to Basic (loadoutFromTemplate), so the result is always valid.
 * @returns {{legs, torso, leftArm, rightArm}|null} model paths, or null when the set has no mech
 */
export function startSetLoadout(catalog, race, mech, raceData) {
  if (!mech) return null;
  const template = {};
  for (const slot of START_SETS.mechSlots) {
    const set = mech[slot] === START_SETS.armPlaceholder ? raceData?.startArm : mech[slot];
    template[slot] = set ? [set] : [];
  }
  return loadoutFromTemplate(catalog, race, template);
}

/**
 * Starting robots of a faction.
 * @param {string} race     stats.json race key (Stats.raceKeys())
 * @param {object} catalog  loadPartCatalog() result
 * @returns {{player: object[], enemy: object[]}} loadouts in the order of LOADOUT.player / LOADOUT.enemy
 *   (the enemy list is for a squad of the same faction)
 */
export function startLoadouts(race, catalog) {
  const build = (ids) => ids.map((id) => loadoutFromTemplate(catalog, race, LOADOUT.templates[id]));
  return { player: build(LOADOUT.player), enemy: build(LOADOUT.enemy) };
}
