// Steel Men AI – [A9-F4b] advanced technology (docs/notes/a9-f4b-ai.md, docs/roadmap/05-research-t2.md ch. 4).
// Not a manager of its own (AiPlayer's list stays as it is): the managers call it through techOf(ai):
//   Economy.#wishes   → wishes(wants, now)  next tier building (DataRelay), enhancers, imaging poles, detectors,
//                                           railguns, archeology station, superweapon (bb.wantStructures with `near`)
//   Strategy.think    → superweapon(now)    launch at the most valuable known enemy cluster (launchSuperweapon)
//   Military.think    → evacuate(now)       own units inside an active strike circle run out of it (bb.evacuating)
// Settings: difficulty.json `tech` (missing / enabled false = nothing of this). No faction or building names: buildings
// are found by role (AiData STRUCTURE_ROLES) or from rules.research.tiers; only what Perception knows is used.
import { getStats, unitStats } from '../../data/Stats.js';
import { checkRules } from '../../game/commands/buildCommands.js';
import { launchCommand } from '../../game/commands/superweaponCommands.js';
import { PRIORITY, dist, posOf, add, rotate, centroid, affordsAbove, strengthOf } from '../util.js';
import { resolveStructure, structureMatches, buildableStructures } from '../AiData.js';

/** Escape directions per strike: units in the same sector of the circle get one move command (APM) */
const EVAC_SECTORS = 8;
/** Structure roles that count as production buildings (DataRelay condition, enhancer spot) */
const PRODUCTION_ROLES = ['@parts', '@assembly', '@vehicles', '@aircraft'];
/** Enhancer kinds (aura roles) and where they stand: the army rally point or the production buildings */
const ENHANCER_SPOT = { attackAura: 'rally', reconAura: 'rally', defenseAura: 'production', buildAura: 'production' };
const NO_STRIKES = Object.freeze([]);

/** The team's TechManager (created on first use) */
export function techOf(ai) {
  ai.tech ??= new TechManager(ai);
  return ai.tech;
}

export class TechManager {
  constructor(ai) {
    this.ai = ai;
    this.maxTier = 0;          // highest research tier this team had open (a lost tier building is rebuilt urgently)
    this.evac = new Map();     // unit eid -> strike id it runs from (bb.evacuating)
    this.launchedAt = -Infinity;
    this.lastLaunch = null;    // { x, z, value, time } (status)
    this.wished = '';          // ids wished at the last think (status)
    this.evacuations = 0;
  }

  get cfg() { return this.ai.diff?.tech ?? null; }
  get own() { return this.ai.perception.own; }

  /** status(): tier, what is wished, superweapon state */
  status() {
    const sw = this.ai.world.superweapons;
    const b = sw?.buildingOf?.(this.ai.team);
    const state = b ? sw.stateOf(b)?.state ?? '-' : '-';
    return `T${this.ai.world.research?.openTier?.(this.ai.team) ?? 0} ${this.wished || '-'} sw:${state} evac:${this.evacuations}`;
  }

  // ---------- buildings ----------

  /** Pushes the tech building wishes (Economy.#wishes) */
  wishes(wants, now) {
    const cfg = this.cfg;
    const ai = this.ai;
    const bb = ai.bb;
    this.wished = '';
    const research = ai.world.research;
    if (!cfg?.enabled || !research) return;
    const open = research.openTier(ai.team);
    this.maxTier = Math.max(this.maxTier, open);
    const list = [];
    // a lost tier building (DataRelay) comes back like a lost HQ: urgent, also while defending
    this.#tierBuilding(list, open);
    if (!bb.openingDone || bb.econ?.hold || bb.state === 'defend') return this.#push(wants, list);
    this.#superweapon(list);
    this.#enhancers(list, now);
    this.#detectors(list);
    this.#railGuns(list);
    this.#watchPosts(list, now);
    this.#archeology(list);
    this.#push(wants, list);
  }

  #push(wants, list) {
    const max = this.cfg?.maxWishes ?? list.length;
    for (let i = 0; i < list.length && i < max; i++) wants.push(list[i]);
    this.wished = list.slice(0, max).map((w) => w.value).join(',');
  }

  /** Building id for a role / id the team may build now (rules pass), or null */
  #buildable(value) {
    const ai = this.ai;
    const id = resolveStructure(value, ai.race, ai.teamUnlocks);
    if (!id) return null;
    const rule = checkRules(ai.world, ai.team, ai.race, id, unitStats('structures', id, ai.race, ai.team));
    return rule === '' ? id : null;
  }

  #owned(value) { return this.ai.construction?.ownedCount(value) ?? 0; }

  /** The cost of `id` + `minOre` spare ore are there (no allocation after the first call per id / minOre) */
  #spare(id, minOre) {
    const ai = this.ai;
    this.spareNeed ??= new Map();
    const key = `${id}|${minOre}`;
    let need = this.spareNeed.get(key);
    if (!need) {
      const cost = unitStats('structures', id, ai.race, ai.team)?.cost ?? {};
      need = { ore: (cost.ore ?? 0) + (minOre ?? 0), energy: cost.energy ?? 0 };
      this.spareNeed.set(key, need);
    }
    return affordsAbove(ai.world.economy, ai.team, need);
  }

  /**
   * Buildings the next research tier needs (rules.research.tiers[t].requiresStructures – the advanced research
   * facility / DataRelay): once the rules allow it, with `minProducers` finished production buildings and the trucks
   * of the economy guard (the 05 doc: "2 production buildings and income"). Lost after the tier was open: urgent.
   */
  #tierBuilding(list, open) {
    const cfg = this.cfg.advancedFacility;
    const ai = this.ai;
    if (!cfg) return;
    const research = ai.world.research;
    // from tier 2: the research facility (tier 1) is Economy's (research.json plan, also when it is lost)
    for (let tier = 2; tier <= Math.max(open + 1, this.maxTier); tier++) {
      const st = research.tierStatus(ai.team, tier);
      for (const m of st.missing) {
        if (m.type !== 'structure' || this.#owned(m.id) > 0) continue;
        if (!this.#buildable(m.id)) continue; // research facility: Economy wants it; requiresTier not open yet: later
        const rebuild = tier <= this.maxTier;
        if (!rebuild) {
          const producers = this.own.complete.filter((s) => PRODUCTION_ROLES.some((r) => structureMatches(r, s.unitId))).length;
          if (producers < (cfg.minProducers ?? 0) || this.own.harvesters.length < (cfg.minHarvesters ?? 0)) continue;
          if (ai.bb.econ?.hold || ai.bb.state === 'defend') continue;
        }
        const priority = rebuild ? PRIORITY.urgent : PRIORITY[cfg.priority] ?? PRIORITY.normal;
        list.unshift({ value: m.id, count: 1, priority });
        if (!rebuild) this.#noteOnce(`tier:${m.id}`, `tier ${tier} needs ${m.id}`);
        return;
      }
    }
  }

  /** The superweapon building (role @superweapon, one per team): Normal+ (tech.superweapon) and the match option on */
  #superweapon(list) {
    const cfg = this.cfg;
    const sw = this.ai.world.superweapons;
    if (!cfg.superweapon || !sw?.enabled || this.#owned('@superweapon') > 0) return;
    const id = this.#buildable('@superweapon');
    if (!id) return;
    list.push({ value: id, count: 1, priority: PRIORITY[cfg.superweaponPriority] ?? PRIORITY.high });
  }

  /** Point an enhancer kind stands at (rally point / centre of the production buildings), or null */
  #enhancerSpot(kind) {
    if (ENHANCER_SPOT[kind] === 'rally') return this.ai.bb.rally ?? null;
    const prod = this.own.complete.filter((s) => PRODUCTION_ROLES.some((r) => structureMatches(r, s.unitId)));
    return centroid(prod);
  }

  /** Enhancers (aura roles in tech.enhancers.kinds order), at most one of each kind; recon only against cloaking enemies */
  #enhancers(list, now) {
    const cfg = this.cfg.enhancers;
    if (!cfg || now < (cfg.startAt ?? 0)) return;
    for (const kind of cfg.kinds ?? []) {
      const value = `@${kind}`;
      if (this.#owned(value) > 0) continue;
      if (kind === 'reconAura' && !this.#cloakThreat()) continue;
      const id = this.#buildable(value);
      if (!id || !this.#spare(id, cfg.minOre)) continue;
      const near = this.#enhancerSpot(kind);
      if (!near) continue;
      list.push({ value: id, count: 1, priority: PRIORITY[cfg.priority] ?? PRIORITY.normal, near: { x: near.x, z: near.z } });
    }
  }

  /**
   * Could enemies cloak? A cloaked / cloak-capable enemy was seen (Perception.cloak), or an enemy faction's exclusive
   * research changes the stealth rules (a faction built around cloaking) – no faction names.
   */
  #cloakThreat() {
    const p = this.ai.perception;
    if (p.cloakSeen(this.ai.now)) return true;
    const research = this.ai.world.research;
    const races = getStats().races ?? {};
    const defs = research?.defs ?? {};
    for (const team of p.enemyTeams) {
      const race = research?.races?.[team];
      for (const id of races[race]?.exclusive?.research ?? []) {
        if ((defs[id]?.effects ?? []).some((e) => e.type === 'rule' && String(e.path ?? '').startsWith('stealth.'))) return true;
      }
    }
    return false;
  }

  /** Detection buildings (@detector) against cloaking enemies: in front of the HQ, then at the rally point */
  #detectors(list) {
    const cfg = this.cfg.detectors;
    if (!cfg || !(cfg.max > 0) || !this.#cloakThreat()) return;
    const have = this.#owned('@detector');
    if (have >= cfg.max) return;
    const id = this.#buildable('@detector');
    if (!id || !this.#spare(id, cfg.minOre)) return;
    const anchor = this.own.anchor;
    const front = this.ai.perception.frontDir();
    const point = have === 0 ? add(anchor, front, cfg.frontDistance ?? 0) : (this.ai.bb.rally ?? anchor);
    list.push({ value: id, count: have + 1, priority: PRIORITY[cfg.priority] ?? PRIORITY.normal, near: point });
  }

  /**
   * Railguns: the buildable tower with the longest ground range, when it reaches farther than the defence plan's
   * tower (@tower) – at the main approach in front of the base, the second one turned aside.
   */
  #railGuns(list) {
    const cfg = this.cfg.railGuns;
    const ai = this.ai;
    if (!cfg || !(cfg.max > 0)) return;
    const id = this.#longRangeTower();
    if (!id) return;
    const have = this.#owned(id);
    if (have >= cfg.max || !this.#buildable(id) || !this.#spare(id, cfg.minOre)) return;
    const front = rotate(ai.perception.frontDir(), (have % 2 ? -1 : 1) * Math.ceil(have / 2) * (cfg.spread ?? 0));
    list.push({ value: id, count: have + 1, priority: PRIORITY[cfg.priority] ?? PRIORITY.normal,
      near: add(this.own.anchor, front, cfg.frontDistance ?? 0) });
  }

  #longRangeTower() {
    const ai = this.ai;
    this.towerRange ??= new Map(); // id -> longest ground range (base stats: only compared, research changes nothing here)
    const range = (id) => {
      if (!this.towerRange.has(id)) {
        this.towerRange.set(id, (getStats().structures[id]?.weapons ?? [])
          .filter((w) => (w.targets ?? ['ground']).includes('ground')).reduce((m, w) => Math.max(m, w.range ?? 0), 0));
      }
      return this.towerRange.get(id);
    };
    const base = resolveStructure('@tower', ai.race, ai.teamUnlocks);
    if (!base) return null;
    let best = null;
    let bestRange = range(base);
    for (const id of buildableStructures(ai.race, ai.teamUnlocks)) {
      if (!structureMatches('@tower', id)) continue;
      const r = range(id);
      if (r > bestRange) { best = id; bestRange = r; }
    }
    return best;
  }

  /**
   * Imaging poles (@watchPost): on the edges of the base (left, right, front at edgeDistance), then next to the
   * deposits own trucks mine away from the base (nearest first, no super node). One at a time, up to `max`.
   */
  #watchPosts(list, now) {
    const cfg = this.cfg.imagingPoles;
    const ai = this.ai;
    if (!cfg || !(cfg.max > 0) || now < (cfg.startAt ?? 0)) return;
    const have = this.#owned('@watchPost');
    if (have >= cfg.max) return;
    const id = this.#buildable('@watchPost');
    if (!id || !this.#spare(id, cfg.minOre)) return;
    const anchor = this.own.anchor;
    const front = ai.perception.frontDir();
    const edge = cfg.edgeDistance ?? 0;
    const points = [add(anchor, rotate(front, Math.PI / 2), edge), add(anchor, rotate(front, -Math.PI / 2), edge), add(anchor, front, edge)];
    const mined = [];
    for (const v of this.own.harvesters) {
      const d = v.order?.type === 'harvest' ? v.order.deposit : null;
      if (!d || d.superNode || mined.includes(d) || dist(d, anchor) < edge) continue;
      mined.push(d);
    }
    mined.sort((a, b) => dist(a, anchor) - dist(b, anchor) || a.eid - b.eid);
    for (const d of mined) points.push({ x: d.x, z: d.z });
    const point = points[have];
    if (!point) return;
    list.push({ value: id, count: have + 1, priority: PRIORITY[cfg.priority] ?? PRIORITY.low, near: point });
  }

  /** Archeology station (@archeology): faster analysis + enemy vehicle wrecks (Research.#analyse queues them) */
  #archeology(list) {
    const cfg = this.cfg.archeology;
    if (!cfg || !(cfg.max > 0)) return;
    const have = this.#owned('@archeology');
    if (have >= cfg.max) return;
    const id = this.#buildable('@archeology');
    if (!id || !this.#spare(id, cfg.minOre)) return;
    list.push({ value: id, count: have + 1, priority: PRIORITY[cfg.priority] ?? PRIORITY.low });
  }

  // ---------- superweapon launch ----------

  /**
   * Fires a ready superweapon at the most valuable known enemy cluster (Perception memory only): every known enemy
   * building / unit is a candidate centre; its value = the weighted known enemies within the strike radius (HQ,
   * production buildings, other buildings, army strength – tech.launch.weights; the strike's structure factor and
   * crew kill scale them). A circle with an own or allied building is never chosen, own army in it counts against.
   * Candidates in eid order (ties keep the lower eid). Sent through commandBus (launchSuperweapon).
   */
  superweapon(now) {
    const cfg = this.cfg?.launch;
    const ai = this.ai;
    const sw = ai.world.superweapons;
    if (!cfg || !this.cfg.superweapon || !sw?.enabled) return;
    if (now - this.launchedAt < (cfg.resendSeconds ?? 0)) return;
    const b = sw.buildingOf(ai.team);
    if (!b || !sw.canLaunch(b)) return;
    const spec = b.stats?.superweapon ?? {};
    const radius = spec.radius ?? 0;
    if (!(radius > 0)) return;
    const w = cfg.weights ?? {};
    const structureFactor = spec.structureDamageFactor ?? 1;
    const armyFactor = spec.killsCrews ? (cfg.killsCrewsArmyFactor ?? 1) : 1;
    const structures = getStats().structures ?? {};
    const valueOf = (m) => {
      if (!m.isStructure) return (m.strength ?? 0) * (w.army ?? 0) * armyFactor;
      const s = structures[m.unitId];
      const base = m.hq ? (w.hq ?? 0) : (s?.produces?.length ? (w.production ?? 0) : (w.structure ?? 0));
      return base * structureFactor;
    };
    const known = ai.perception.known().sort((a, b2) => a.eid - b2.eid);
    const own = this.own;
    let best = null;
    for (const c of known) {
      let value = 0;
      for (const m of known) if (dist(m, c) <= radius) value += valueOf(m);
      if (value <= (best?.value ?? 0)) continue;
      if (!this.#safeFor(c, radius + (cfg.ownMargin ?? 0), own)) continue;
      let ownArmy = 0;
      for (const u of own.army) if (dist(posOf(u), c) <= radius) ownArmy += strengthOf(u);
      value -= ownArmy * (w.army ?? 0) * (cfg.ownPenalty ?? 0);
      if (value > (best?.value ?? 0)) best = { x: c.x, z: c.z, value };
    }
    if (!best || best.value < (cfg.minValue ?? 0)) return;
    this.launchedAt = now;
    this.lastLaunch = { x: Math.round(best.x), z: Math.round(best.z), value: Math.round(best.value * 10) / 10, time: Math.round(now) };
    ai.issue(launchCommand(ai.team, b, best.x, best.z), { priority: PRIORITY.urgent, key: 'superweapon' });
    ai.note(`superweapon launched at ${this.lastLaunch.x},${this.lastLaunch.z} (value ${this.lastLaunch.value})`);
  }

  /** No own or allied building within `r` of the point */
  #safeFor(p, r, own) {
    for (const s of own.structures) if (dist(posOf(s), p) <= r) return false;
    for (const s of own.allyStructures) if (dist(posOf(s), p) <= r) return false;
    return true;
  }

  // ---------- strike warning ----------

  /**
   * Own units inside an active strike circle (+ tech.evacuate.margin) run out of it: one move per strike sector to
   * the circle edge + `extra` (EVAC_SECTORS directions). They stay in bb.evacuating (Military, Economy and
   * Construction leave them alone) until their strike hit. Strikes of every team count (own strikes hit own units).
   */
  evacuate(now) {
    const ai = this.ai;
    const bb = ai.bb;
    bb.evacuating = this.evac;
    const cfg = this.cfg?.evacuate;
    const sw = ai.world.superweapons;
    const strikes = sw?.activeStrikes?.() ?? NO_STRIKES;
    if (!strikes.length) { if (this.evac.size) this.evac.clear(); return; }
    if (!cfg) return;
    for (const [eid, id] of this.evac) if (!strikes.some((s) => s.id === id)) this.evac.delete(eid);
    const groups = new Map(); // "strike:sector" -> { strike, sector, units: [eid] }
    const own = this.own;
    const visit = (u) => {
      if (this.evac.has(u.eid) || u.inside || u.removed || u.dead || u.destroyed) return;
      const p = u.position;
      const s = sw.threatAt(p.x, p.z, cfg.margin ?? 0);
      if (!s) return;
      let dx = p.x - s.x;
      let dz = p.z - s.z;
      if (Math.hypot(dx, dz) < 1) { const a = own.anchor ?? { x: 0, z: 0 }; dx = a.x - s.x; dz = a.z - s.z; } // at the centre: towards home
      const angle = Math.atan2(dz, dx);
      const sector = ((Math.round((angle / (Math.PI * 2)) * EVAC_SECTORS) % EVAC_SECTORS) + EVAC_SECTORS) % EVAC_SECTORS;
      const key = `${s.id}:${sector}`;
      const g = groups.get(key) ?? { strike: s, sector, units: [] };
      g.units.push(u.eid);
      groups.set(key, g);
    };
    for (const m of own.mechs) if (m.crew) visit(m);
    for (const v of own.vehicles) if (!v.crewless) visit(v);
    for (const c of own.freeCrews) visit(c);
    if (!groups.size) return;
    const half = ai.world.nav?.half ?? Infinity;
    for (const g of groups.values()) {
      const a = (g.sector / EVAC_SECTORS) * Math.PI * 2;
      const r = g.strike.radius + (cfg.margin ?? 0) + (cfg.extra ?? 0);
      const x = Math.max(-half, Math.min(half, g.strike.x + Math.cos(a) * r));
      const z = Math.max(-half, Math.min(half, g.strike.z + Math.sin(a) * r));
      for (const eid of g.units) this.evac.set(eid, g.strike.id);
      ai.issue({ type: 'move', units: g.units, point: { x, z }, queued: false }, { priority: PRIORITY.urgent });
      this.evacuations += g.units.length;
    }
    ai.note(`superweapon warning: ${[...groups.values()].reduce((n, g) => n + g.units.length, 0)} units run`);
  }

  // ---------- helpers ----------

  /** Logs a text once per key (aiReport log) */
  #noteOnce(key, text) {
    this.noted ??= new Set();
    if (this.noted.has(key)) return;
    this.noted.add(key);
    this.ai.note(text);
  }
}

/** [A9-F4b] Structure roles Construction places behind the HQ (superweapon, archeology station) */
export const TECH_BACK_ROLES = ['superweapon', 'archeology'];
