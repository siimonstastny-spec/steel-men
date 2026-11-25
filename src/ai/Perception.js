// Steel Men AI – what one team knows. Own units are read freely (the player sees them too); foreign units only
// while the team's fog of war shows them (fog.canTeamSee). Enemies that drop out of sight are remembered where
// they were last seen; a memory is dropped when the team looks at that spot again and the unit is not there.
// No other knowledge of the enemy is used (no cheating on any difficulty).
import { AI } from '../config.js';
import { resolve } from '../game/commands/CommandBus.js';
import { areAllies } from '../game/Alliances.js';
import { dist, posOf, centroid, dirTo, strengthOf, hpOf, alive, nearest, weaponDefsOf, roleOfClasses, armorOf } from './util.js';

export class Perception {
  /**
   * @param {object} ai  AiPlayer (world, team, allies)
   */
  constructor(ai) {
    this.ai = ai;
    this.world = ai.world;
    this.team = ai.team;
    this.timer = 0;
    /** eid -> { eid, team, isStructure, unitId, hq, x, z, seen, strength } */
    this.memory = new Map();
    /** eid -> { role, strength, armor, seen } of enemy combat units seen within AI.compositionSeconds (counters) */
    this.composition = new Map();
    this.visibleEnemies = [];
    this.threat = { active: false, strength: 0, point: null, units: [], since: null, lastSeen: -Infinity };
    /** v3: enemies at an allied base (allies share the fog, so we see their buildings and who attacks them) */
    this.allyThreat = { active: false, strength: 0, point: null, team: null, since: null, lastSeen: -Infinity };
    this.lastHp = new Map(); // own structure eid -> hp (damage by unseen attackers, e.g. artillery)
    this.attackedAt = null;  // { point, time } – an own building lost HP recently
    this.startAnchor = null; // own base position at the first update
    this.own = emptyOwn();
    // v5: enemy army intel – when an armed enemy unit was last seen, the biggest known army (grows while unseen)
    this.lastArmySeen = -Infinity;
    this.peak = { strength: 0, time: 0 };
    // R3: enemy aircraft intel – when one was last seen and the most seen at once since (anti-air wishes)
    this.air = { lastSeen: -Infinity, peak: 0 };
    // [A9-F4b] sim time a cloaked or cloak-capable enemy was last seen (detection buildings, Tech.js)
    this.cloakLastSeen = -Infinity;
  }

  // ---------- refresh ----------

  update(now, dt) {
    this.timer -= dt;
    if (this.timer > 0) return false;
    this.timer = AI.perceptionInterval;
    this.#readOwn();
    this.#readEnemies(now);
    this.#readThreat(now);
    return true;
  }

  /** Teams that may be attacked: not own, not allied (match alliances or opts.allies), not out of the match */
  get enemyTeams() {
    const n = this.world.economy?.accounts?.length ?? 2;
    const out = [];
    for (let t = 0; t < n; t++) {
      if (!this.isEnemyTeam(t)) continue;
      if (this.world.match?.eliminated?.has(t)) continue;
      out.push(t);
    }
    return out;
  }

  isEnemyTeam(t) { return Number.isInteger(t) && !areAllies(t, this.team) && !this.ai.allies.includes(t); }

  /** v3: another team on our side (match alliance or opts.allies) */
  isAllyTeam(t) { return Number.isInteger(t) && t !== this.team && (areAllies(t, this.team) || this.ai.allies.includes(t)); }

  #readOwn() {
    const w = this.world;
    const team = this.team;
    const own = emptyOwn();
    const servicedCrews = new Set();
    for (const s of w.structures) {
      if (s.team !== team && alive(s) && s.stats && this.isAllyTeam(s.team)) { own.allyStructures.push(s); continue; }
      if (s.team !== team || !alive(s) || !s.stats) continue;
      own.structures.push(s);
      (s.complete ? own.complete : own.building).push(s);
      if (s.stats.hq) own.hq = own.hq && own.hq.complete ? own.hq : s;
      if (s.service?.mech) {
        own.serviced.push(s.service.mech);
        if (s.service.crew) servicedCrews.add(s.service.crew);
      }
    }
    for (const v of w.vehicles) {
      if (v.team !== team || !alive(v) || !v.stats) continue;
      own.vehicles.push(v);
      if (v.crewless) { own.crewlessVehicles.push(v); continue; } // [A9-F4b] neutron bomb: stands until a crew boards
      if (v.canConstruct) own.builders.push(v);
      else if (v.harvester) own.harvesters.push(v);
      else if ((v.stats.weapons ?? []).length) own.combatVehicles.push(v);
    }
    for (const m of w.mechs) {
      if (m.team !== team || !alive(m) || !m.stats) continue;
      own.mechs.push(m);
      if (m.crew) own.crewedMechs.push(m); else own.uncrewedMechs.push(m);
    }
    for (const c of w.crews) {
      if (c.team !== team || c.dead || c.removed) continue;
      own.crews.push(c);
      // A crew waiting next to a bay boards its serviced mech again on release: not free for other robots
      if (!c.inside && !servicedCrews.has(c)) own.freeCrews.push(c);
      if (c.inside && c.bay) own.bayCrews.push(c); // v3: waiting in an assembly bay's crew queue (N2)
    }
    own.army = [...own.crewedMechs.filter((m) => !m.inside), ...own.combatVehicles];
    own.armyStrength = own.army.reduce((s, u) => s + strengthOf(u), 0);
    own.anchor = own.hq ? posOf(own.hq) : (centroid(own.structures) ?? centroid(own.vehicles) ?? this.startAnchor);
    this.startAnchor ??= own.anchor;
    this.own = own;
  }

  #canSee(u) { return !this.world.fog || this.world.fog.canTeamSee(this.team, u); }

  isVisible(p) { return !this.world.fog || this.world.fog.isPointVisibleTo(this.team, p.x, p.z); }

  isExplored(p) { return !this.world.fog || this.world.fog.isPointExploredBy(this.team, p.x, p.z); }

  #readEnemies(now) {
    const seen = [];
    const enemies = new Set(this.enemyTeams);
    for (const u of this.world.allUnits) {
      if (!enemies.has(u.team) || !alive(u) || u.inside || !u.world || !u.stats) continue;
      if (!this.#canSee(u)) continue;
      seen.push(u);
      const strength = strengthOf(u);
      if (u.cloaked || this.world.stealth?.canCloak?.(u)) this.cloakLastSeen = now; // [A9-F4b]
      this.memory.set(u.eid, {
        eid: u.eid, team: u.team, isStructure: Boolean(u.isStructure), unitId: u.unitId ?? null,
        hq: Boolean(u.isStructure && u.stats.hq), armed: strength > 0, harvester: Boolean(u.harvester),
        x: u.position.x, z: u.position.z, seen: now, strength, air: Boolean(u.airborne),
      });
      if (!u.isStructure && strength > 0) {
        const classes = weaponDefsOf(u).map((w) => w.class).filter(Boolean);
        this.composition.set(u.eid, {
          role: roleOfClasses(classes, this.ai.armies?.roleClasses) ?? 'ranged', strength, armor: armorOf(u), seen: now,
        });
      }
    }
    for (const [eid, c] of this.composition) if (now - c.seen > AI.compositionSeconds) this.composition.delete(eid);
    if (seen.some((u) => !u.isStructure && strengthOf(u) > 0)) this.lastArmySeen = now;
    // R3: enemy aircraft (seen now) – the peak is kept while they keep showing up, reset after a long quiet time
    const airNow = seen.filter((u) => u.airborne).length;
    if (airNow) {
      if (now - this.air.lastSeen > AI.air.forgetSeconds) this.air.peak = 0;
      this.air.lastSeen = now;
      this.air.peak = Math.max(this.air.peak, airNow);
    }
    this.visibleEnemies = seen;
    const seenIds = new Set(seen.map((u) => u.eid));
    for (const [eid, m] of this.memory) {
      if (seenIds.has(eid)) continue;
      // We look at the remembered spot and it is not there (moved away, destroyed) – or the team is gone
      if (this.isVisible(m) || !enemies.has(m.team)) { this.memory.delete(eid); continue; }
      if (!m.isStructure && now - m.seen > AI.memorySeconds) this.memory.delete(eid);
    }
  }

  #readThreat(now) {
    const own = this.own;
    const threats = this.visibleEnemies.filter((u) => !u.isStructure && strengthOf(u) > 0
      && own.structures.some((s) => dist(posOf(u), posOf(s)) < AI.baseRadius));
    // Buildings losing HP to something we cannot see (artillery, units out of sight)
    for (const s of own.structures) {
      const before = this.lastHp.get(s.eid);
      if (before !== undefined && s.hp < before - 1 && s.complete) this.attackedAt = { point: posOf(s), time: now };
      this.lastHp.set(s.eid, s.hp);
    }
    const t = this.threat;
    if (threats.length) {
      t.units = threats;
      t.strength = threats.reduce((sum, u) => sum + strengthOf(u), 0);
      t.point = centroid(threats);
      t.lastSeen = now;
      if (!t.active) { t.active = true; t.since = now; }
    } else if (this.attackedAt && now - this.attackedAt.time < AI.threatForgetSeconds) {
      t.units = [];
      t.point = this.attackedAt.point;
      t.lastSeen = now;
      if (!t.active) { t.active = true; t.since = now; t.strength = 1; }
    } else if (t.active && now - t.lastSeen > AI.threatForgetSeconds) {
      Object.assign(t, { active: false, strength: 0, point: null, units: [], since: null });
    }
    this.#readAllyThreat(now);
  }

  /** v3: armed enemies next to an allied building (the base of the most threatened ally) */
  #readAllyThreat(now) {
    const allies = this.own.allyStructures;
    const a = this.allyThreat;
    const units = allies.length ? this.visibleEnemies.filter((u) => !u.isStructure && strengthOf(u) > 0
      && allies.some((s) => dist(posOf(u), posOf(s)) < AI.baseRadius)) : [];
    if (units.length) {
      a.strength = units.reduce((sum, u) => sum + strengthOf(u), 0);
      a.point = centroid(units);
      a.team = nearest(allies, a.point)?.team ?? null;
      a.lastSeen = now;
      if (!a.active) { a.active = true; a.since = now; }
    } else if (a.active && now - a.lastSeen > AI.threatForgetSeconds) {
      Object.assign(a, { active: false, strength: 0, point: null, team: null, since: null });
    }
  }

  // ---------- questions ----------

  /** Own structures matching a role predicate / id (finished and unfinished) */
  ownStructures(match) { return this.own.structures.filter((s) => match(s.unitId)); }

  /** Remembered enemy entries (optionally of one team) */
  known(team = null) {
    return [...this.memory.values()].filter((m) => team === null || m.team === team);
  }

  knownStructures(team = null) { return this.known(team).filter((m) => m.isStructure); }

  /** Known enemy army strength (mobile armed units seen within memorySeconds) */
  knownEnemyStrength(team = null) {
    return this.known(team).filter((m) => !m.isStructure).reduce((s, m) => s + m.strength, 0);
  }

  /**
   * v5: estimated enemy army for attack decisions (difficulty.estimate; without it = knownEnemyStrength).
   * Memory only shrinks: units out of sight are forgotten after memorySeconds and a glimpse shows a part of the army,
   * so old knowledge used to LOWER the estimate (hard attacked "935 vs known 235" into a real ~700 + defences).
   * Now: the biggest army ever known grows by growthPerMinute (share per minute) while it is not seen again, the
   * estimate is the larger of that and what is known now, plus known armed enemy buildings × defenseWeight.
   * Uses only what the team saw (no cheating).
   */
  enemyEstimate(now = this.ai.now) {
    const known = this.knownEnemyStrength();
    const cfg = this.ai.diff?.estimate;
    if (!cfg) return known;
    const p = this.peak;
    const growth = Math.min(cfg.maxGrowth ?? Infinity, (cfg.growthPerMinute ?? 0) * Math.max(0, now - p.time) / 60);
    const grown = p.strength * (1 + growth);
    if (known >= grown) { p.strength = known; p.time = now; }
    const defense = this.knownStructures().filter((m) => m.armed).reduce((s, m) => s + m.strength, 0) * (cfg.defenseWeight ?? 0);
    return Math.max(known, grown) + defense;
  }

  /** v5: a fresh look at the enemy base (scout recon) replaces the grown peak with what is known now */
  refreshPeak(now = this.ai.now) { this.peak = { strength: this.knownEnemyStrength(), time: now }; }

  /** v5: seconds since an armed enemy unit was last seen (Infinity = never) */
  intelAge(now = this.ai.now) { return now - this.lastArmySeen; }

  /** Front direction of the base: towards the nearest known enemy building, else the map centre */
  frontDir() {
    const anchor = this.own.anchor ?? { x: 0, z: 0 };
    const enemy = nearest(this.knownStructures(), anchor, (m) => m);
    const centre = this.world.map?.superNode ?? { x: 0, z: 0 };
    return dirTo(anchor, enemy ?? centre);
  }

  /**
   * Map start positions where an unknown enemy may be: not our own one. [N5] When main.js published the start of
   * every team (world.teamStarts[team] = start position object), our own and our allies' starts are left out
   * (allies' bases are never scouted or attacked); empty starts stay in (an enemy might be there).
   */
  otherStarts() {
    const starts = this.world.map?.startPositions ?? [];
    const teamStarts = this.world.teamStarts;
    if (Array.isArray(teamStarts) && teamStarts[this.team]) {
      const friendly = new Set(teamStarts.filter((p, t) => p && areAllies(t, this.team)));
      return starts.filter((p) => !friendly.has(p)).map((p) => ({ x: p.x, z: p.z }));
    }
    const home = this.startAnchor ?? this.own.anchor;
    if (!home) return starts.map((p) => ({ x: p.x, z: p.z }));
    const mine = nearest(starts, home, (p) => p);
    return starts.filter((p) => p !== mine).map((p) => ({ x: p.x, z: p.z }));
  }

  /**
   * v3: otherStarts() ordered by how likely an enemy base is there – maps are symmetric around their centre (0, 0;
   * Map.js rotates obstacles around it and starts face it), and Alliances.startOrder puts a 1v1 enemy on the opposite
   * start and allies on neighbouring ones. So the start nearest our own start mirrored through the centre comes first.
   * Uses only the map layout (public), never where enemies really are.
   */
  enemyStartGuesses() {
    const starts = this.otherStarts();
    const home = this.startAnchor ?? this.own.anchor;
    if (!home) return starts;
    const mirror = { x: -home.x, z: -home.z };
    return starts.sort((a, b) => dist(a, mirror) - dist(b, mirror) || a.x - b.x || a.z - b.z);
  }

  /**
   * Seen enemy army make-up: { count, shares: { role: share of strength }, armor: strength-weighted mean per damage
   * type } or null when nothing was seen
   */
  enemyComposition() {
    const list = [...this.composition.values()];
    if (!list.length) return null;
    const total = list.reduce((s, c) => s + c.strength, 0) || 1;
    const shares = {};
    const armor = {};
    for (const c of list) {
      const w = c.strength / total;
      shares[c.role] = (shares[c.role] ?? 0) + w;
      for (const [t, v] of Object.entries(c.armor ?? {})) armor[t] = (armor[t] ?? 0) + v * w;
    }
    return { count: list.length, shares, armor };
  }

  /**
   * R3: enemy aircraft the team should defend against: the most seen at once (or known in memory now), 0 when none
   * was seen for AI.air.forgetSeconds.
   */
  enemyAir(now = this.ai.now) {
    if (now - this.air.lastSeen > AI.air.forgetSeconds) return 0;
    let known = 0;
    for (const m of this.memory.values()) if (m.air) known++;
    return Math.max(known, this.air.peak);
  }

  /** [A9-F4b] Was a cloaked / cloak-capable enemy seen within AI.air.forgetSeconds (same memory as enemy aircraft)? */
  cloakSeen(now = this.ai.now) { return now - this.cloakLastSeen <= AI.air.forgetSeconds; }

  /** Remembered enemy harvesters (memory entries) */
  knownHarvesters() { return this.known().filter((m) => m.harvester); }

  /** Live object of a remembered entry only when the team sees it now (else null) */
  visibleObject(entry) {
    const u = resolve(this.world, entry.eid);
    return u && alive(u) && this.#canSee(u) ? u : null;
  }

  /** HP share 0..1 of an own unit */
  static hpRatio(u) { const { hp, max } = hpOf(u); return max > 0 ? hp / max : 1; }
}

function emptyOwn() {
  return {
    structures: [], complete: [], building: [], hq: null,
    vehicles: [], builders: [], harvesters: [], combatVehicles: [],
    mechs: [], crewedMechs: [], uncrewedMechs: [], crews: [], freeCrews: [], serviced: [],
    army: [], armyStrength: 0, anchor: null,
    bayCrews: [],       // v3: own crews waiting in a bay queue
    allyStructures: [], // v3: buildings of allied teams (allies are seen anyway: shared fog)
    crewlessVehicles: [], // [A9-F4b] own vehicles without a crew (Military boards them, Production makes crews)
  };
}
