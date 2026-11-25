// Steel Men – game stats: loading data/stats.json, resolving stats per model, composing mechs
import { setFromPath, ACCURACY, RESEARCH_A9, ARMS } from '../config.js';

const STATS_URL = './data/stats.json';
const DAMAGE_TYPES = ['physical', 'energy'];

/** Mech slot -> part kind used in stats.json (left and right arm share one "arm" entry) */
export const SLOT_KIND = { legs: 'legs', torso: 'torso', leftArm: 'arm', rightArm: 'arm' };

let statsPromise = null;
let stats = null;

/** Loads stats.json once for the whole game */
export function loadStats(url = STATS_URL) {
  statsPromise ??= fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`Stats ${url}: HTTP ${res.status}`);
      return res.json();
    })
    .then((data) => (stats = data));
  return statsPromise;
}

export function getStats() {
  if (!stats) throw new Error('Stats are not loaded yet – await loadStats() first');
  return stats;
}

// ---------- races / factions ----------

/** Race keys in data order (stats.json → races) */
export function raceKeys() {
  return Object.keys(getStats().races ?? {});
}

/** Factions for the UI: { key, name, description, modifiers } – name falls back to the key */
export function raceList() {
  return Object.entries(getStats().races ?? {}).map(([key, r]) => ({
    key, name: r.name ?? key, description: r.description ?? '', descriptionKey: r.descriptionKey ?? '', modifiers: r.modifiers ?? {},
  }));
}

/** Display name of a race key (e.g. for unit names) */
export function raceName(race) {
  return getStats().races?.[race]?.name ?? race;
}

/** Exclusive groups used in races[*].exclusive (e.g. 'partSets', 'vehicles'), collected from the data */
function exclusiveKinds() {
  return [...new Set(Object.values(getStats().races ?? {}).flatMap((r) => Object.keys(r.exclusive ?? {})))];
}

/**
 * Empty per-player record of production unlocked from salvage research: { [kind]: Set<id> }.
 * Kinds come from races[*].exclusive, so a new group in the data needs no code change.
 */
export function createUnlocks() {
  return Object.fromEntries(exclusiveKinds().map((kind) => [kind, new Set()]));
}

/** Unlock id of one part kind of a set (salvage analysis and research unlock single kinds): 'Howitzer:torso' */
export const unlockId = (id, sub = null) => (sub ? `${id}${UNLOCK_SEPARATOR}${sub}` : id);
const UNLOCK_SEPARATOR = ':';

/** stats.json section holding the items of an exclusive group (where requiresResearch is read) */
const GROUP_DATA = { partSets: 'parts', vehicles: 'vehicles', structures: 'structures' };

/** Data entry of an item: parts[set][sub] for part sets, vehicles[id] / structures[id] otherwise */
function itemData(kind, id, sub) {
  const section = getStats()[GROUP_DATA[kind]]?.[id];
  return kind === 'partSets' ? section?.[sub] : section;
}

/** Research ids an item needs before it can be produced (stats.json requiresResearch, [] = free) */
export function researchNeeded(kind, id, sub = null) {
  return itemData(kind, id, sub)?.requiresResearch ?? [];
}

/**
 * [A15] Does a race's exclusive list of a group name this item? A part set may be listed whole ('Recon') or for one
 * part kind only ('Recon:torso', unlockId format), so one kind of a set can belong to one faction and the rest to all.
 * @param {object} raceData  stats.json races[race]
 */
export function exclusiveListed(raceData, kind, id, sub = null) {
  const list = raceData?.exclusive?.[kind];
  if (!list) return false;
  return list.includes(id) || (sub !== null && list.includes(unlockId(id, sub)));
}

/**
 * May a race produce this item? The id must be exclusive to no race or to this race, and an item with
 * requiresResearch must be unlocked – or the player unlocked it (research or salvage analysis), which
 * opens both locks. One mechanism for research and loot.
 * @param {string} race      stats.json race key
 * @param {string} kind      exclusive group, e.g. 'partSets' | 'vehicles' | 'structures' | 'research'
 * @param {string} id        part set name or unit id, e.g. 'KatanaSword', 'gunTank'
 * @param {object} [unlocked] { [kind]: Set<id> | id[] } – see createUnlocks()
 * @param {string} [sub]     part kind ('legs' | 'torso' | 'arm') for part sets: unlocks may cover one kind only
 */
export function canProduce(race, kind, id, unlocked, sub = null) {
  return contextAllows(kind, id, unlocked, sub, race) && ownedOrUnlocked(race, kind, id, unlocked, sub);
}

/** canProduce without the match context: faction exclusivity and requiresResearch (or an unlock opening both) */
function ownedOrUnlocked(race, kind, id, unlocked, sub) {
  const extra = unlocked?.[kind];
  const has = (key) => Boolean(extra && (extra instanceof Set ? extra.has(key) : extra.includes(key)));
  const isUnlocked = has(id) || (sub !== null && has(unlockId(id, sub)));
  if (researchNeeded(kind, id, sub).length && !isUnlocked) return false;
  const races = getStats().races ?? {};
  const owners = Object.keys(races).filter((key) => exclusiveListed(races[key], kind, id, sub));
  return owners.length === 0 || owners.includes(race) || isUnlocked;
}

// ---------- [A15] research tier per faction ----------

/** T1: parts / vehicles of this tier (or without requiresTier) are open from the start, no research facility needed */
export const BASE_TIER = 1;

/**
 * [A15] Research tier an item needs for a race. stats requiresTier (parts.<set>.<kind>, vehicles.<id>) is a number
 * (same for every race) or { "<race>": n } (a race missing in the object = BASE_TIER). No field = BASE_TIER.
 * Pure function of the data; canProduce (contextAllows) and the production UI's "requires tier N" reason use it.
 */
export function tierFor(raw, race) {
  if (raw === null || raw === undefined) return BASE_TIER;
  if (typeof raw === 'number') return raw;
  return raw[race] ?? BASE_TIER;
}

/** [A15] Tier of an item of an exclusive group for a race (tierFor of its stats requiresTier); BASE_TIER when unknown */
export function itemTier(kind, id, race, sub = null) {
  return tierFor(rawItem(kind, id, sub)?.requiresTier, race);
}

/**
 * [A15] UI reason "requires tier N": the tier an item still needs when only its research tier blocks it (the race owns
 * it, research / unlock done, superweapons allowed), else 0. Same rules as canProduce; outside a match always 0.
 */
export function tierLocked(race, kind, id, unlocked, sub = null) {
  if (!researchContext || !unlocked || !RESEARCH_A9.tierCheckedGroups.includes(kind)) return 0;
  const raw = rawItem(kind, id, sub);
  if (!raw || (isSuperweaponItem(raw) && !researchContext.superweaponsEnabled())) return 0;
  const tier = tierFor(raw.requiresTier, race);
  if (tier <= BASE_TIER || researchContext.tierOf(unlocked) >= tier) return 0;
  return ownedOrUnlocked(race, kind, id, unlocked, sub) ? tier : 0;
}

// ---------- [A9] research context: open tier per team, match option "superweapons" ----------

/**
 * Set by the running match's Research (src/game/Research.js): { tierOf(unlocked) -> open tier of the team owning that
 * unlock record (Infinity = unknown), superweaponsEnabled() -> bool }. null (menus, no match) = no extra checks.
 */
let researchContext = null;

export function setResearchContext(ctx) { researchContext = ctx ?? null; }

/** Raw stats entry of an item of an exclusive group ('research' reads stats.research) */
function rawItem(kind, id, sub) {
  return kind === 'research' ? getStats().research?.[id] : itemData(kind, id, sub);
}

/** Is the item a superweapon / superweapon program (RESEARCH_A9.superweaponFlags)? */
export function isSuperweaponItem(raw) {
  return Boolean(raw) && RESEARCH_A9.superweaponFlags.some((f) => raw[f]);
}

/** [A9-F3] Superweapon buildings one team may have in total, of any id (stats.json rules.superweapons.maxPerTeam) */
export function superweaponLimit() {
  return getStats().rules?.superweapons?.maxPerTeam ?? 1;
}

/**
 * [A9] Checks of the running match: superweapon items are not available while the option is off; groups in
 * RESEARCH_A9.tierCheckedGroups also need their stats requiresTier open (structures check it in buildCommands /
 * BuildMenu, which show the reason instead of hiding the building). [A15] The tier is per race (tierFor); BASE_TIER
 * needs nothing.
 */
function contextAllows(kind, id, unlocked, sub, race) {
  if (!researchContext) return true;
  const raw = rawItem(kind, id, sub);
  if (!raw) return true;
  if (isSuperweaponItem(raw) && !researchContext.superweaponsEnabled()) return false;
  if (!unlocked || !RESEARCH_A9.tierCheckedGroups.includes(kind)) return true;
  const tier = tierFor(raw.requiresTier, race);
  return tier <= BASE_TIER || researchContext.tierOf(unlocked) >= tier;
}

// ---------- [A9] part sets without own GLB models (stand-in models until a procedural part is registered) ----------

/** Virtual catalog path -> stand-in GLB path (filled by withDataParts) */
const modelAliases = new Map();

/**
 * Adds catalog entries for part sets that exist only in stats.json: one entry per model, with a virtual path of the
 * new set ('RobotPartsKatanaSword/LeftKatanaSwordArmX_Skel.glb' -> 'RobotPartsIonKatana/LeftIonKatanaArmX_Skel.glb'),
 * so setFromPath / raceFromPath / stockKey work unchanged. The model comes from
 *   • parts[set][kind].standInSet – every catalog entry of that (still existing) set in the slot, or
 *   • [A15] parts[set][kind].standInModel – a GLB path template relative to models/ ({side} = ARMS.sidePrefix of the
 *     arm slot, '' for legs / torso; {race} = every race with its own models, i.e. without modelRace). The model is
 *     display only (the simulation body comes from the data), so a hand-made GLB replaces it by editing this path.
 * A set that has its own models in the catalog is left alone. Call before withModelRaceParts. Returns a new catalog;
 * the input is untouched.
 */
export function withDataParts(catalog) {
  const parts = getStats().parts ?? {};
  const modelRaces = raceKeys().filter((r) => !modelRaceOf(r));
  const out = {};
  for (const [slot, list] of Object.entries(catalog ?? {})) {
    if (!Array.isArray(list)) { out[slot] = list; continue; }
    const kind = SLOT_KIND[slot];
    const extra = [];
    for (const [set, kinds] of Object.entries(parts)) {
      const def = kinds?.[kind];
      if (!def || list.some((p) => p.set === set)) continue;
      if (def.standInModel) {
        addModelEntries(extra, set, slot, def.standInModel, modelRaces);
        continue;
      }
      const standIn = def.standInSet;
      if (!standIn) continue;
      const dir = `${PART_DIR_PREFIX}${standIn}`;
      for (const p of list) {
        const [pathDir, file] = p.path.split('/');
        if (p.set !== standIn || pathDir !== dir || !file) continue;
        const path = `${PART_DIR_PREFIX}${set}/${file.replace(standIn, set)}`;
        modelAliases.set(path, p.path);
        extra.push({ ...p, path, set });
      }
    }
    out[slot] = [...list, ...extra];
  }
  return out;
}
const PART_DIR_PREFIX = 'RobotParts';

/** [A15] Catalog entries of a standInModel template: one per race with its own models; virtual path -> real GLB */
function addModelEntries(extra, set, slot, template, races) {
  const side = ARMS.sidePrefix[slot] ?? '';
  for (const race of races) {
    const real = template.replaceAll('{side}', side).replaceAll('{race}', race);
    const [dir, file] = real.split('/');
    if (!file) continue;
    const modelSet = dir.startsWith(PART_DIR_PREFIX) ? dir.slice(PART_DIR_PREFIX.length) : '';
    const path = `${PART_DIR_PREFIX}${set}/${modelSet ? file.replace(modelSet, set) : `${set}${file}`}`;
    modelAliases.set(path, real);
    extra.push({ path, set, race, sockets: [] });
  }
}

/** [A15] Part of a data-only set (stats standInSet / standInModel: no own catalog models; drawn procedurally) */
export const isDataOnlyPart = (stats) => Boolean(stats?.standInSet || stats?.standInModel);

/** GLB to load for a part model path: the stand-in model of a stats-only set, else the path itself */
export function partModelPath(path) {
  return modelAliases.get(path) ?? path;
}

// ---------- research effects (per team) ----------

/** team -> effects of all its completed research (Research.js sets them) */
const teamEffects = new Map();

/** Replaces the effects of a team's completed research; stats resolved afterwards include them */
export function setResearchEffects(team, effects) {
  teamEffects.set(team, effects.filter((e) => !e.pending));
}

const effectsOf = (team, type) => (team === null || team === undefined ? [] : (teamEffects.get(team) ?? []).filter((e) => e.type === type));

/**
 * Value of stats.json rules at a dotted path for a team, with its research 'rule' effects:
 * (base + Σ add) × Π mul, e.g. teamRule(0, 'repair.fieldRate')
 */
export function teamRule(team, path) {
  const base = getPath(getStats().rules, path);
  if (typeof base !== 'number') return base;
  return combine(base, effectsOf(team, 'rule').filter((e) => e.path === path));
}

/** Race multiplier of research time (races[*].modifiers.researchTime, 1 when missing) */
export function researchTimeFactor(race) {
  return getStats().races?.[race]?.modifiers?.researchTime ?? 1;
}

/** 'RobotPartsBasic/BasicLegsY_Skel.glb' -> 'Y'; models without a race suffix -> null */
export function raceFromPath(path) {
  const base = path.split('/').pop().replace(/\.glb$/i, '').replace(/_?(Skel|Anim)$/, '');
  // Longest key first, so a key that ends with another key still wins
  const keys = raceKeys().sort((a, b) => b.length - a.length);
  return keys.find((key) => base.endsWith(key)) ?? null;
}

/** Race whose models a faction borrows (stats.json races[race].modelRace), or null when it has its own */
export const modelRaceOf = (race) => getStats().races?.[race]?.modelRace ?? null;

/**
 * Faction a part belongs to: the race in its model name – except that a faction using stand-in models
 * (races[owner].modelRace === that race) owns parts with these models, so its modifiers apply.
 */
function partRace(path, ownerRace) {
  const pathRace = raceFromPath(path);
  if (pathRace && ownerRace && ownerRace !== pathRace && modelRaceOf(ownerRace) === pathRace) return ownerRace;
  return pathRace ?? ownerRace;
}

/**
 * Adds, for every faction with a modelRace, catalog entries { path, set, race: faction } copied from its model
 * race (the model stays, ownership and modifiers are the faction's). Returns a new catalog; the input is untouched.
 */
export function withModelRaceParts(catalog) {
  const races = getStats().races ?? {};
  const out = {};
  for (const [slot, list] of Object.entries(catalog ?? {})) {
    if (!Array.isArray(list)) { out[slot] = list; continue; }
    const extra = [];
    for (const [key, r] of Object.entries(races)) {
      if (!r.modelRace) continue;
      for (const p of list) if (p.race === r.modelRace) extra.push({ ...p, race: key });
    }
    out[slot] = [...list, ...extra];
  }
  return out;
}

// ---------- parts ----------

/**
 * Final stats of one robot part model: defaults <- parts[set][kind] <- race modifiers <- overrides[path]
 * @param {string} path  model path relative to models/, e.g. 'RobotPartsAxe/LeftAxeArmX_Skel.glb'
 * @param {string} slot  'legs' | 'torso' | 'leftArm' | 'rightArm'
 * @param {string} [ownerRace]  faction producing the part – used for models without a race suffix (e.g. Frame)
 * @param {number} [team]       owner team – its completed research applies last (none without a team)
 */
export function partStats(path, slot, ownerRace = null, team = null) {
  const s = getStats();
  const set = setFromPath(path);
  const kind = SLOT_KIND[slot];
  const race = partRace(path, ownerRace);
  const raw = s.parts[set]?.[kind];
  if (!raw) console.warn(`[Stats] No stats for parts.${set}.${kind} (${path}), using defaults`);

  const part = deepMerge(s.defaults.part, raw ?? {});
  part.set = set;
  part.kind = kind;
  part.path = path;
  part.race = race;
  if (kind === 'legs') {
    part.mobility = deepMerge(s.defaults.mobility, part.mobility ?? {});
    // [R2] speed = base (defaults.mobility.moveSpeed) × the legs' own part modifier; the owner's race applies in composeMech
    part.mobility.moveSpeed *= part.mobility.speedModifier ?? 1;
  }
  part.weapons = part.weapons.map((w) => deepMerge(s.defaults.weapon, w));

  // [R2] mobility race modifiers belong to the mech's owner (composeMech), not to the faction that made the part
  applyRaceModifiers(part, s.races?.[race]?.modifiers, { mobility: false });
  return applyResearch(applyOverride(part, s.overrides?.[path]), 'part', team);
}

/**
 * Combined stats of a mech from its current parts.
 * @param {object} parts     { legs, torso, leftArm?, rightArm? } – resolved part stats (missing arm = absent)
 * @param {object} [bonuses] experience bonuses of the crew operating the mech (see rankFor)
 * @param {string} [ownerRace] [R2] race of the mech's owner – its moveSpeed / turnSpeed / acceleration modifiers apply
 *                             to the mech's mobility (captured legs move with the new owner's race); null = legs' race
 */
export function composeMech(parts, bonuses = {}, ownerRace = null) {
  const s = getStats();
  const list = Object.values(parts).filter(Boolean);
  const legs = parts.legs;

  const carriedMass = sum(list.filter((p) => p.kind !== 'legs'), (p) => p.mass);
  const loadCapacity = legs?.loadCapacity ?? 0;
  const overloaded = carriedMass > loadCapacity;
  const loadFactor = overloaded
    ? Math.max(s.rules.overload.minSpeedFactor, loadCapacity / carriedMass)
    : 1;

  const base = legs?.mobility ?? s.defaults.mobility;
  // [A16] a torso may carry a speed bonus (parts.<set>.torso.mobility.speedModifier, default 1): multiplies the final
  // speed, applied after the overload factor (the overload floor rules.overload.minSpeedFactor limits loadFactor alone)
  const torsoSpeed = parts.torso?.mobility?.speedModifier ?? 1;
  const mobility = {
    ...base,
    moveSpeed: base.moveSpeed * loadFactor * torsoSpeed,
    acceleration: base.acceleration * loadFactor,
  };
  // [R2] base × legs' part modifier (partStats) × owner's race modifier
  applyRaceMobility(mobility, s.races?.[ownerRace ?? legs?.race]?.modifiers);

  // Deep copies – bonuses below modify them and must not leak back into the part stats
  const abilities = list.flatMap((p) => p.abilities.map((a) => ({ ...structuredClone(a), source: p.kind })));
  const weapons = list.flatMap((p) => p.weapons.map((w) => applyDamageBonuses({ ...structuredClone(w), source: p.kind }, abilities)));
  applyExperience({ mobility, weapons, abilities }, bonuses);

  // Assembly belongs to the faction of the chassis (legs, else torso); parts already carry their own modifiers
  const race = legs?.race ?? parts.torso?.race ?? null;
  const assembly = { cost: structuredClone(s.rules.mechAssembly.cost), buildTime: s.rules.mechAssembly.buildTime };
  applyRaceModifiers(assembly, s.races?.[race]?.modifiers);

  return {
    race,
    cost: sumCost([assembly.cost, ...list.map((p) => p.cost)]),
    buildTime: assembly.buildTime + sum(list, (p) => p.buildTime),
    supply: s.rules.mechSupply,
    hp: sum(list, (p) => p.hp),
    mass: carriedMass + (legs?.mass ?? 0),
    carriedMass,
    loadCapacity,
    overloaded,
    mobility,
    sightRange: Math.max(0, ...list.map((p) => p.sightRange)),
    weapons,
    abilities,
    dps: sum(weapons, weaponDps),
    evasion: bonuses.evasion ?? 0,
    bonuses,
    requires: [...new Set(list.flatMap((p) => p.requires))],
    buildable: list.every((p) => p.buildable),
  };
}

/** Cost and time of assembling a mech from finished parts (rules.mechAssembly with the race modifiers) */
export function mechAssemblyStats(race) {
  const s = getStats();
  const assembly = { cost: structuredClone(s.rules.mechAssembly.cost), buildTime: s.rules.mechAssembly.buildTime };
  applyRaceModifiers(assembly, s.races?.[race]?.modifiers);
  return assembly;
}

/**
 * Mech stats straight from a loadout of model paths (assembly preview before anything is built)
 * @param {string} [ownerRace]  producing faction, applied to parts without a race in their model name
 */
export function mechStatsFromLoadout(loadout, ownerRace = null, team = null) {
  // An empty slot (null path, e.g. a mech assembled without an arm) is a missing part
  const parts = Object.fromEntries(Object.entries(loadout).filter(([, path]) => path)
    .map(([slot, path]) => [slot, partStats(path, slot, ownerRace, team)]));
  return composeMech(parts, {}, ownerRace);
}

// ---------- vehicles / structures ----------

/**
 * Final stats of a vehicle or structure for a race.
 * @param {'vehicles'|'structures'} group
 * @param {string} id   e.g. 'gunTank', 'outpost'
 * @param {number} [team]  owner team – its completed research applies last
 */
export function unitStats(group, id, race, team = null) {
  const s = getStats();
  const raw = s[group]?.[id];
  if (!raw) throw new Error(`[Stats] Unknown ${group}.${id}`);
  return applyResearch(resolveUnit(raw, id, race), UNIT_CATEGORY[group] ?? group, team);
}

/** Research target category of a stats.json unit group */
const UNIT_CATEGORY = { vehicles: 'vehicle', structures: 'structure' };

/**
 * Final stats of a crew squad for a race (races without their own crew model use the first available one).
 * Per-member values (costPerMember, hpPerMember, supplyPerMember) are multiplied by squadSize,
 * so changing squadSize rebalances the whole squad. Result: memberHp + hp/cost/supply for the squad.
 */
export function crewStats(race, team = null) {
  const raw = structuredClone(getStats().crew);
  raw.hp = raw.hpPerMember;       // race modifiers work on hp / cost
  raw.cost = raw.costPerMember;
  const crew = resolveUnit(raw, 'crew', race);
  const n = crew.squadSize;
  crew.memberHp = crew.hp;
  crew.memberCost = crew.cost;
  crew.hp = crew.memberHp * n;
  crew.cost = Object.fromEntries(Object.entries(crew.memberCost).map(([r, v]) => [r, v * n]));
  crew.supply = crew.supplyPerMember * n;
  return applyResearch(crew, 'crew', team);
}

// ---------- experience ----------

/**
 * Rank reached with the given XP.
 * @returns {{ index, id, name, xp, bonuses, next }}  next = XP needed for the next rank (null at max)
 */
export function rankFor(xp) {
  const ranks = getStats().experience.ranks;
  let index = 0;
  for (let i = 0; i < ranks.length; i++) if (xp >= ranks[i].xp) index = i;
  return { index, ...ranks[index], next: ranks[index + 1]?.xp ?? null };
}

/**
 * Applies experience bonuses (fractions, 0.1 = +10 %) in place.
 * HP and armor are hardware and never change with experience.
 */
export function applyExperience({ mobility, weapons = [], abilities = [] }, b = {}) {
  if (mobility) {
    mobility.moveSpeed *= 1 + (b.moveSpeed ?? 0);
    mobility.acceleration *= 1 + (b.acceleration ?? 0);
    mobility.turnSpeed *= 1 + (b.turnSpeed ?? 0);
  }
  const speed = 1 + (b.attackSpeed ?? 0);
  for (const w of weapons) {
    for (const t of DAMAGE_TYPES) w.damage[t] = (w.damage[t] ?? 0) * (1 + (b.damage ?? 0));
    w.attackTime /= speed;
    w.cooldown /= speed;
    w.accuracy = Math.min(1, w.accuracy + (b.accuracy ?? 0));
  }
  for (const a of abilities) if (a.cooldown) a.cooldown *= 1 - (b.abilityCooldown ?? 0);
}

// ---------- internal ----------

function resolveUnit(raw, id, race) {
  const s = getStats();
  const unit = structuredClone(raw);
  const variant = raw.byRace?.[race] ?? raw.byRace?.[s.races?.[race]?.modelRace]; // [A9-F2] per-race field overrides (aaTurret weapons)
  if (variant) Object.assign(unit, structuredClone(variant));
  delete unit.byRace;
  unit.id = id;
  unit.race = race;
  // Model of the race: its own when the unit lists it, else the race's modelRace (stand-in models), else the first listed one
  const own = s.races?.[race]?.modelRace;
  const modelRace = raw.races
    ? (raw.races.includes(race) ? race : (raw.races.includes(own) ? own : raw.races[0]))
    : (own ?? race);
  // No race at all (e.g. an empty seat): the model path would contain "null" -> model is null, loaders skip it
  const raceKey = modelRace ?? race;
  unit.model = raceKey == null && raw.model.includes('{race}') ? null : raw.model.replaceAll('{race}', raceKey);
  if (unit.mobility) unit.mobility = deepMerge(s.defaults.mobility, unit.mobility);
  unit.weapons = (unit.weapons ?? []).map((w) => deepMerge(s.defaults.weapon, w));
  unit.abilities ??= [];
  applyRaceModifiers(unit, s.races?.[race]?.modifiers);
  return applyOverride(unit, s.overrides?.[unit.model]);
}

// ---------- combat math ----------

/**
 * Damage left after armor, per damage type and in total.
 * Each type is reduced separately: taken = damage * scale / (scale + armor)
 * @param {number|object} damage  number = pure physical, or { physical, energy }
 */
export function applyArmor(damage, armor = {}) {
  const scale = stats?.rules.armorScale ?? 100;
  const dmg = typeof damage === 'number' ? { physical: damage } : damage;
  const out = { total: 0 };
  for (const type of DAMAGE_TYPES) {
    const raw = dmg[type] ?? 0;
    const value = raw > 0 ? (raw * scale) / (scale + Math.max(0, armor[type] ?? 0)) : 0;
    out[type] = value;
    out.total += value;
  }
  return out;
}

/**
 * [F2] Accuracy profile of a weapon, derived only from rules.combat.accuracy and the weapon data (mirrors
 * Combat.hitChance without target evasion / movement): near / far = hit chance at point blank / at max range,
 * avg = mean over distances 0…range (share `o` of the range at full accuracy, then a linear fall to the long factor).
 * @returns {{ melee: boolean, homing: boolean, near: number, far: number, avg: number, movingPenalty: number }}
 */
export function accuracyProfile(w) {
  const a = stats?.rules?.combat?.accuracy;
  const base = w.accuracy ?? 1;
  if (!a || !ACCURACY.enabled) return { melee: false, homing: false, near: base, far: base, avg: base, movingPenalty: 0 };
  if (w.class === 'melee') {
    const v = base * a.meleeAccuracyFactor;
    return { melee: true, homing: false, near: v, far: v, avg: v, movingPenalty: 0 };
  }
  const o = w.accuracyOptimalRange ?? a.optimalRangeFactor;
  const longFactor = w.accuracyLongFactor ?? a.longRangeFactor;
  const homing = !!(w.homing && a.homingIgnoresMoving);
  const rangeAvg = o + (1 - o) * (1 + longFactor) / 2;
  return {
    melee: false, homing, near: base, far: base * longFactor, avg: base * rangeAvg,
    movingPenalty: w.projectileSpeed > 0 && !homing ? a.movingPenalty : 0,
  };
}

/** Average damage per second of a weapon (no armor); hit chance is the average over distance (accuracyProfile.avg) */
export function weaponDps(w) {
  const perHit = sum(DAMAGE_TYPES, (t) => w.damage[t] ?? 0);
  return (perHit * w.burst * accuracyProfile(w).avg) / (w.attackTime + w.cooldown);
}

// ---------- helpers ----------

// Race modifiers are multipliers: hp, armor, moveSpeed, turnSpeed, acceleration, damage, cost, buildTime
// { mobility: false } = skip moveSpeed / turnSpeed / acceleration ([R2] mech legs: the owner's race applies them)
function applyRaceModifiers(target, mod, { mobility = true } = {}) {
  if (!mod) return;
  if (mod.hp) target.hp = Math.round(target.hp * mod.hp);
  if (mod.armor && target.armor) for (const t of DAMAGE_TYPES) target.armor[t] = Math.round(target.armor[t] * mod.armor);
  if (mod.cost && target.cost) for (const r of Object.keys(target.cost)) target.cost[r] = Math.round(target.cost[r] * mod.cost);
  if (mod.buildTime) target.buildTime *= mod.buildTime;
  if (mobility) applyRaceMobility(target.mobility, mod);
  if (mod.damage) for (const w of target.weapons ?? []) for (const t of DAMAGE_TYPES) w.damage[t] *= mod.damage;
}

function applyRaceMobility(m, mod) {
  if (!m || !mod) return;
  if (mod.moveSpeed) m.moveSpeed *= mod.moveSpeed;
  if (mod.turnSpeed) m.turnSpeed *= mod.turnSpeed;
  if (mod.acceleration) m.acceleration *= mod.acceleration;
}

function applyOverride(target, override) {
  if (!override) return target;
  const merged = deepMerge(target, override);
  if (override.weapons) merged.weapons = override.weapons.map((w) => deepMerge(getStats().defaults.weapon, w));
  return merged;
}

// Abilities of type "damageBonus" multiply damage of weapons of the given class (e.g. HTHupgrade legs -> melee)
function applyDamageBonuses(weapon, abilities) {
  for (const a of abilities) {
    if (a.type !== 'damageBonus' || (a.weaponClass && a.weaponClass !== weapon.class)) continue;
    weapon.damage = Object.fromEntries(Object.entries(weapon.damage).map(([t, v]) => [t, v * a.multiplier]));
  }
  return weapon;
}

// ---------- research 'modify' effects ----------

/**
 * Objects inside a resolved unit that research can target, each with the selector fields it answers to
 * (see data/README.md → research → target): the unit itself, its weapons, the weapons' on-hit effects
 * and its abilities. Fields of the unit (kind, set, id) are inherited by its weapons and abilities.
 */
function researchTargets(unit, category) {
  // [A9] partKind: only robot parts and their weapons / abilities answer it (vehicle / building weapons never match)
  const own = { kind: unit.kind, set: unit.set, id: category === 'part' ? unit.set : unit.id, partKind: category === 'part' ? unit.kind : undefined };
  const out = [{ obj: unit, ctx: { ...own, category } }];
  for (const w of unit.weapons ?? []) {
    const damageType = Object.keys(w.damage ?? {}).filter((t) => w.damage[t] > 0);
    const wctx = { ...own, category: 'weapon', weaponClass: w.class, weaponId: w.id, damageType, targets: w.targets };
    out.push({ obj: w, ctx: wctx });
    for (const e of w.effects ?? []) out.push({ obj: e, ctx: { ...wctx, effectType: e.type } });
  }
  for (const a of unit.abilities ?? []) out.push({ obj: a, ctx: { ...own, category: 'ability', abilityType: a.type } });
  return out;
}

/** Every selector field must match (a list = any of; a field the object does not have = no match) */
function selectorMatches(target = {}, ctx) {
  return Object.entries(target).every(([key, want]) => {
    const have = ctx[key];
    if (have === undefined) return false;
    const wants = [].concat(want);
    return [].concat(have).some((h) => wants.includes(h));
  });
}

/**
 * Applies a team's research 'modify' effects to a resolved unit in place:
 * value = (base + Σ add) × Π mul, then clamped to the lowest `max` of the effects (e.g. accuracy ≤ 1).
 */
function applyResearch(unit, category, team) {
  const effects = effectsOf(team, 'modify');
  if (!effects.length) return unit;
  for (const { obj, ctx } of researchTargets(unit, category)) {
    // Effect-entry targets (weapon on-hit effects) answer only selectors that ask for an effectType
    const byStat = new Map();
    for (const e of effects) {
      if (Boolean(ctx.effectType) !== Boolean(e.target?.effectType) || !selectorMatches(e.target, ctx)) continue;
      if (!byStat.has(e.stat)) byStat.set(e.stat, []);
      byStat.get(e.stat).push(e);
    }
    for (const [stat, list] of byStat) {
      const base = getPath(obj, stat);
      if (typeof base === 'number') setPath(obj, stat, combine(base, list));
    }
  }
  return unit;
}

/** (base + Σ add) × Π mul, capped by the lowest `max` given */
function combine(base, effects) {
  let add = 0;
  let mul = 1;
  let max = Infinity;
  for (const e of effects) {
    if (e.op === 'add') add += e.value; else if (e.op === 'mul') mul *= e.value;
    if (typeof e.max === 'number') max = Math.min(max, e.max);
  }
  return Math.min(max, (base + add) * mul);
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const parent = keys.reduce((o, k) => o?.[k], obj);
  if (parent) parent[last] = value;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Objects merge recursively, arrays and plain values are replaced; inputs are not mutated
function deepMerge(base, extra) {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(extra ?? {})) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

function sum(items, fn) { return items.reduce((acc, x) => acc + (fn(x) ?? 0), 0); }

function sumCost(costs) {
  const out = {};
  for (const c of costs) for (const [r, v] of Object.entries(c ?? {})) out[r] = (out[r] ?? 0) + v;
  return out;
}
