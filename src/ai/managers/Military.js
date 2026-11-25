// Steel Men AI – army: crews board empty robots, new robots get their stance / behaviour, the army waits at the
// rally point in front of the base, defends the base when Strategy says so and attacks in waves:
//   gather at the rally point → attack-move to the target → new target when it is reached → retreat when the wave
//   lost too much strength (retreatRatio). Target: the best known enemy building (threat and distance, any number
//   of enemy teams, allies never), else the super node, else unexplored start positions.
// Micro on higher difficulties: focus fire on the weakest visible enemy, damaged robots pull back, field repair at
// the rally point.
// v3 (docs/notes/ai-v3.md): assembly bays get bb.rally as their rally point and free crews go into bay crew queues
// (joinBay) – a new robot is crewed and walks to the rally point by itself; home units help an ally whose base is
// attacked (bb.allyHelp); a small squad holds the super node; allied AIs prefer the same enemy team (allyBoard.js);
// with nothing known the wave explores the start most likely held by an enemy first (map symmetry).
import { AI, AI_RESUME, BAY_CREW } from '../../config.js';
import { resolve } from '../../game/commands/CommandBus.js';
import { PRODUCES } from '../../game/Production.js';
import { canEngage } from '../../game/Combat.js';
import { PRIORITY, dist, posOf, centroid, add, dirTo, isIdle, strengthOf, nearest, hpOf, alive, weaponDefsOf, roleOfClasses, rangeOf } from '../util.js';
import { shareIntent, intentOf } from '../allyBoard.js';
import { techOf } from './Tech.js';

/** Re-issue the same order to a busy unit only after this long (s) */
const ORDER_REFRESH = 20;
/** Two order points closer than this are the same order */
const SAME_POINT = 12;
/** Radius (units) around the wave where focus fire picks its target */
const FOCUS_RADIUS = 80;
/** A visited super node / scouting point is not chosen again for this long (s) */
const REVISIT_SECONDS = 120;

const hpRatio = (u) => { const { hp, max } = hpOf(u); return max > 0 ? hp / max : 1; };

export class MilitaryManager {
  constructor(ai) {
    this.ai = ai;
    this.promised = new Map();   // mech eid -> { crew eid, until }
    this.configured = new Set(); // robot eids that got stance / behaviour
    this.lastOrder = new Map();  // unit eid -> { type, x, z, target, time }
    this.visited = new Map();    // target key -> sim time
    this.artyBusy = new Set();   // artillery eids that got their own order this think (others leave them alone)
    this.harass = null;          // harass squad (v2)
    this.node = null;            // super node squad (v3): { units: [eid], nextAt }
    this.rallySet = new Map();   // bay eid -> { x, z, time } last setRally sent (v3)
    this.joining = new Map();    // crew eid -> { bay: eid, until } joinBay sent, order not seen yet (v3)
    this.stats = { bayJoins: 0, rallySets: 0, allyHelps: 0 };
  }

  get own() { return this.ai.perception.own; }

  /**
   * Army units that take orders now (crewed robots after boarding, combat vehicles), without the scout and without
   * robots Maintenance sends to a bay / repairs (bb.maintaining)
   */
  get army() {
    const bb = this.ai.bb;
    const scout = bb.scoutEid;
    const busy = bb.maintaining ?? new Set();
    const evac = bb.evacuating; // [A9-F4b] running from a superweapon strike
    return this.own.army.filter((u) => (u.isMech ? u.active : true) && u.eid !== scout && !busy.has(u.eid) && !evac?.has(u.eid));
  }

  /** Units in the attack wave (gathering or going) and in the harass squad */
  #awayIds() {
    const bb = this.ai.bb;
    const ids = new Set(bb.wave && !bb.wave.ended ? bb.wave.units : []);
    for (const eid of this.harass?.units ?? []) ids.add(eid);
    for (const eid of this.node?.units ?? []) ids.add(eid);
    return ids;
  }

  /** Units of the separate squads (harass, super node): never part of an attack wave */
  #squadIds() {
    return new Set([...(this.harass?.units ?? []), ...(this.node?.units ?? [])]);
  }

  /** Units in the super node squad now (Strategy: they do not join waves) */
  get nodeCount() { return this.node?.units.length ?? 0; }

  /** Army units at home (not in the wave, not harassing) */
  homeUnits() {
    const away = this.#awayIds();
    return this.army.filter((u) => !away.has(u.eid));
  }

  /** Strength of the units at home (Strategy: can they handle a threat while the wave goes on?) */
  homeStrength() { return this.homeUnits().reduce((s, u) => s + strengthOf(u), 0); }

  think(now) {
    const bb = this.ai.bb;
    const p = this.ai.perception;
    bb.rally = add(this.own.anchor, p.frontDir(), AI.rallyDistance);
    techOf(this.ai).evacuate(now); // [A9-F4b] first: units in a strike circle run (bb.evacuating)
    this.#board(now);
    this.#bays(now);
    this.#configure();
    if (bb.state === 'defend') {
      if (bb.wave) bb.wave = null; // the attack is called off
      this.#endHarass('defend');
      this.#endNode('defend');
    }
    this.#artillery(now); // first: artillery with something in range keeps that order this think
    if (bb.state === 'defend') this.#defend(now);
    else if (bb.state === 'attack') {
      this.#attack(now);
      if (bb.homeDefense) this.#defendHome(now);
    } else if (bb.allyHelp) this.#helpAlly(now);
    if (bb.state !== 'defend') { this.#harass(now); this.#holdNode(now); }
    this.#rest(now);
  }

  // ---------- takeover of a game in progress (A2-ai) ----------

  /**
   * [A2-ai] The AI took over the team (src/ai/Resume.js). Army units far from the base on an attack order (a wave of
   * the previous owner) become this AI's wave in its 'go' phase when there are at least minWave of them – Strategy
   * goes to 'attack' and the wave picks its target / retreats as usual. Home units on orders this AI never gives
   * (AI_RESUME.releaseOrders: patrol, guard) or with an order queue are sent to the rally point; others finish their
   * current order and #rest brings them home once idle.
   * @returns {{ wave: number, recalled: number }} units adopted into the wave / sent to the rally point
   */
  resume(now) {
    const ai = this.ai;
    const bb = ai.bb;
    const anchor = this.own.anchor;
    if (!anchor) return { wave: 0, recalled: 0 };
    const R = AI_RESUME.military;
    bb.rally = add(anchor, ai.perception.frontDir(), AI.rallyDistance);
    const away = [];
    const stray = [];
    for (const u of this.army) {
      const type = u.order?.type ?? null;
      const far = dist(posOf(u), anchor) > AI.baseRadius * R.awayRadiusFactor;
      if (far && (type === 'attackMove' || type === 'attack')) away.push(u);
      else if (R.releaseOrders.includes(type) || u.orderQueue?.length) stray.push(u);
    }
    let wave = 0;
    if (away.length >= ai.diff.attack.minWave) {
      const initial = away.reduce((s, u) => s + strengthOf(u), 0);
      this.homeGuard = new Set();
      bb.wave = { units: new Set(away.map((u) => u.eid)), phase: 'go', since: now, initial, target: null, ended: null, reorderAt: 0 };
      bb.state = 'attack';
      ai.stats.wavesSent++;
      ai.stats.firstAttackAt ??= now;
      ai.note(`wave of ${away.length} taken over on its way (strength ${Math.round(initial)})`);
      wave = away.length;
    } else stray.push(...away.filter((u) => R.releaseOrders.includes(u.order?.type) || u.orderQueue?.length));
    if (stray.length) this.order(stray, 'attackMove', bb.rally, now, PRIORITY.low, true);
    return { wave, recalled: stray.length };
  }

  // ---------- assembly bays (v3) ----------

  /**
   * Bays (finished own assembly bays): the rally point follows bb.rally – a new robot walks there on its own, also
   * when its crew comes later (Production.heldRally) – and free crews go into the crew queue of bays that assemble
   * (or will soon assemble) a robot: it takes the first crew and is active at once (BAY_CREW.boardInstantly).
   * Saves a board and a move command per robot. difficulty.bays { rally, crewQueue } switch the two parts.
   */
  #bays(now) {
    const ai = this.ai;
    const prod = ai.world.production;
    const cfg = ai.diff.bays ?? {};
    if (!prod || (cfg.rally === false && cfg.crewQueue === false)) return;
    const bays = prod.producersOf(ai.team, PRODUCES.mech).filter((s) => s.complete && alive(s));
    if (!bays.length) return;
    if (cfg.rally !== false) this.#bayRally(bays, now);
    if (cfg.crewQueue !== false) this.#bayCrews(bays, now);
  }

  #bayRally(bays, now) {
    const rally = this.ai.bb.rally;
    if (!rally || !Number.isFinite(rally.x) || !Number.isFinite(rally.z)) return;
    const near = (a) => a && Math.hypot(a.x - rally.x, a.z - rally.z) < AI.bays.rallyMove;
    for (const bay of bays) {
      if (bay.rally?.length === 1 && near(bay.rally[0])) continue; // already there
      const sent = this.rallySet.get(bay.eid);
      if (sent && near(sent) && now - sent.time < AI.bays.resendSeconds) continue; // command still on its way
      this.rallySet.set(bay.eid, { x: rally.x, z: rally.z, time: now });
      this.stats.rallySets++;
      this.ai.issue({ type: 'setRally', structure: bay.eid, points: [{ x: rally.x, z: rally.z }] },
        { priority: PRIORITY.low, key: `rally:${bay.eid}` });
    }
  }

  /** Crews waiting in a bay, counted without touching the game's queue (BayCrew.bayCrews would prune it) */
  static #queued(bay) { return (bay.crewQueue ?? []).filter((c) => !c.dead && c.bay === bay).length; }

  #bayCrews(bays, now) {
    const ai = this.ai;
    const prod = ai.world.production;
    for (const [eid, j] of this.joining) if (j.until <= now) this.joining.delete(eid);
    // crews on their way to a bay (order seen, or command just sent)
    const enRoute = new Map();
    for (const c of this.own.crews) {
      const bayEid = c.order?.type === 'joinBay' ? c.order.bay?.eid : this.joining.get(c.eid)?.bay;
      if (c.inside || bayEid === undefined || bayEid === null) continue;
      enRoute.set(bayEid, (enRoute.get(bayEid) ?? 0) + 1);
    }
    const promisedCrews = new Set([...this.promised.values()].map((pr) => pr.crew));
    const crews = this.own.freeCrews.filter((c) => (!c.order || c.order.type === 'move')
      && !promisedCrews.has(c.eid) && !this.joining.has(c.eid));
    if (!crews.length) return;
    const lookahead = Math.min(1, ai.production?.plans.length ?? 0); // the next robot's crew waits already
    for (const bay of bays) {
      const items = prod.itemsOf(bay.eid).filter((i) => i.kind === 'mech').length;
      const want = Math.min(BAY_CREW.capacity, items + lookahead);
      let have = MilitaryManager.#queued(bay) + (enRoute.get(bay.eid) ?? 0);
      while (have < want && crews.length) {
        const crew = nearest(crews, posOf(bay));
        crews.splice(crews.indexOf(crew), 1);
        this.joining.set(crew.eid, { bay: bay.eid, until: now + AI.bays.joinSeconds });
        ai.issue({ type: 'joinBay', units: [crew.eid], bay: bay.eid, queued: false }, { priority: PRIORITY.normal, key: `crew:${crew.eid}` });
        this.stats.bayJoins++;
        have++;
      }
      if (!crews.length) return;
    }
  }

  // ---------- allies (v3) ----------

  /** Home units (minus a share nearest our HQ) fight the enemies at an attacked ally's base (Strategy sets bb.allyHelp) */
  #helpAlly(now) {
    const point = this.ai.bb.allyHelp;
    const anchor = this.own.anchor;
    const home = this.homeUnits().sort((a, b) => dist(posOf(a), anchor) - dist(posOf(b), anchor));
    const keep = Math.floor(home.length * AI.allyHelp.keepHome);
    this.order(home.slice(keep), 'attackMove', point, now, PRIORITY.high);
  }

  // ---------- super node squad (v3) ----------

  /**
   * difficulty.squads.superNode { enabled, startAt, minArmy, size, cooldown }: a few home units stand at the super
   * node (the side facing our base) – they guard our trucks there and chase enemy trucks away. They leave when the
   * known enemy army near the node is much stronger (AI.superNodeHold.maxDangerRatio), then wait `cooldown` s.
   */
  #holdNode(now) {
    const ai = this.ai;
    const cfg = ai.diff.squads?.superNode;
    const node = ai.world.map?.superNode;
    if (!cfg?.enabled || !node || !ai.diff.useSuperNode) return;
    const n = this.node ??= { units: [], nextAt: 0 };
    let units = n.units.map((eid) => resolve(ai.world, eid))
      .filter((u) => alive(u) && (u.isMech ? u.active : true) && !ai.bb.maintaining?.has(u.eid) && u.eid !== ai.bb.scoutEid);
    const strength = units.reduce((s, u) => s + strengthOf(u), 0);
    const danger = ai.perception.known()
      .filter((m) => !m.isStructure && m.armed && dist(m, node) < AI.superNodeSafeRadius)
      .reduce((s, m) => s + m.strength, 0);
    if (units.length && danger > strength * AI.superNodeHold.maxDangerRatio) {
      this.order(units, 'move', ai.bb.rally, now, PRIORITY.high, true);
      this.#endNode(`enemy ${Math.round(danger)} at the node`);
      return;
    }
    if (now >= cfg.startAt && now >= n.nextAt && units.length < cfg.size && this.army.length >= cfg.minArmy
      && ai.bb.wave?.phase !== 'gather' && !ai.bb.allyHelp && danger <= 0) {
      const taken = new Set(units.map((u) => u.eid));
      const pool = this.homeUnits().filter((u) => !taken.has(u.eid)).sort((a, b) => dist(posOf(a), node) - dist(posOf(b), node));
      const added = pool.slice(0, cfg.size - units.length);
      if (added.length && !units.length) ai.note(`super node squad of ${added.length} sent`);
      units = units.concat(added);
    }
    n.units = units.map((u) => u.eid);
    if (!units.length) return;
    const hold = add(node, dirTo(node, this.own.anchor), (node.radius ?? 0) * AI.superNodeHold.offset);
    this.order(units, 'attackMove', hold, now, PRIORITY.low);
  }

  #endNode(why) {
    const n = this.node;
    if (!n?.units.length) return;
    n.units = [];
    n.nextAt = this.ai.now + (this.ai.diff.squads?.superNode?.cooldown ?? 0);
    this.ai.note(`super node squad back (${why})`);
  }

  // ---------- home squad / harass / artillery (v2) ----------

  /** Home units fight a threat at the base while the wave goes on */
  #defendHome(now) {
    const point = this.ai.perception.threat.point;
    if (point) this.order(this.homeUnits(), 'attackMove', point, now, PRIORITY.urgent);
  }

  /** Hard: a small fast squad hunts the enemy harvesters it knows about, retreats when it lost too much */
  #harass(now) {
    const ai = this.ai;
    const cfg = ai.diff.squads?.harass;
    if (!cfg?.enabled) return;
    const h = this.harass ??= { units: [], target: null, initial: 0, nextAt: 0, retargetAt: 0 };
    const p = ai.perception;
    if (h.units.length) {
      const units = h.units.map((eid) => resolve(ai.world, eid)).filter((u) => alive(u) && (u.isMech ? u.active : true));
      h.units = units.map((u) => u.eid);
      const strength = units.reduce((s, u) => s + strengthOf(u), 0);
      if (!units.length) { this.#endHarass('lost'); return; }
      if (strength < h.initial * cfg.retreatRatio) {
        this.order(units, 'move', ai.bb.rally, now, PRIORITY.high);
        this.#endHarass('retreat');
        return;
      }
      const centre = centroid(units);
      if (!h.target || now >= h.retargetAt || dist(centre, h.target) < AI.harassArrival) {
        const targets = p.knownHarvesters();
        const pick = nearest(targets, centre, (m) => m);
        h.retargetAt = now + AI.harassRetarget;
        if (!pick) {
          // Nothing known: mining spots near known enemy buildings
          const deposits = (ai.world.economy?.deposits ?? []).filter((d) => !d.depleted && !d.superNode
            && p.knownStructures().some((m) => dist(m, d) < AI.baseRadius));
          const d = nearest(deposits, centre, (o) => o);
          if (!d) { this.order(units, 'move', ai.bb.rally, now, PRIORITY.normal); this.#endHarass('no target'); return; }
          h.target = { x: d.x, z: d.z };
        } else h.target = { x: pick.x, z: pick.z };
      }
      const visible = p.visibleEnemies.filter((e) => e.harvester && dist(posOf(e), centre) < FOCUS_RADIUS);
      if (visible.length) this.#attackUnit(units, nearest(visible, centre), now);
      else this.order(units, 'attackMove', h.target, now);
      return;
    }
    // Form a squad: fastest ranged units at home, only with a big enough army and something to hunt
    if (now < cfg.startAt || now < h.nextAt || ai.bb.wave?.phase === 'gather') return;
    if (this.army.length < cfg.minArmy) return;
    if (!p.knownHarvesters().length && !p.knownStructures().length) return;
    const speed = (u) => u.stats?.mobility?.moveSpeed ?? 0;
    const pool = this.homeUnits().filter((u) => !u.isMech || this.#roleOf(u) === 'ranged').sort((a, b) => speed(b) - speed(a));
    if (pool.length < cfg.size) return;
    const squad = pool.slice(0, cfg.size);
    Object.assign(h, { units: squad.map((u) => u.eid), initial: squad.reduce((s, u) => s + strengthOf(u), 0), target: null, retargetAt: 0 });
    ai.stats.harassRuns = (ai.stats.harassRuns ?? 0) + 1;
    ai.note(`harass squad of ${squad.length} sent`);
  }

  #endHarass(why) {
    const h = this.harass;
    if (!h?.units.length) return;
    h.units = [];
    h.target = null;
    h.nextAt = this.ai.now + (this.ai.diff.squads?.harass?.cooldown ?? 0);
    this.ai.note(`harass over (${why})`);
  }

  /**
   * Artillery shells from range: a visible enemy within range × artilleryReach is attacked (buildings / towers
   * first); otherwise artillery of a going wave stays artilleryStandoff × range behind the wave centre.
   */
  #artillery(now) {
    const ai = this.ai;
    this.artyBusy = new Set();
    if (!ai.diff.squads?.artillery) return;
    const harass = new Set(this.harass?.units ?? []);
    const arty = this.army.filter((u) => u.isMech && !harass.has(u.eid) && this.#roleOf(u) === 'artillery');
    if (!arty.length) return;
    const wave = ai.bb.wave && !ai.bb.wave.ended && ai.bb.wave.phase === 'go' ? ai.bb.wave : null;
    const enemies = ai.perception.visibleEnemies;
    const others = wave ? [...wave.units].map((eid) => resolve(ai.world, eid)).filter((u) => alive(u) && !arty.includes(u)) : [];
    const front = centroid(others);
    for (const u of arty) {
      const range = rangeOf(u);
      if (range <= 0) continue;
      const inRange = enemies.filter((e) => dist(posOf(e), posOf(u)) <= range * AI.artilleryReach && canEngage(u, e)); // [NQ3]
      if (inRange.length) {
        const target = inRange.find((e) => e.isStructure && strengthOf(e) > 0) ?? inRange.find((e) => e.isStructure)
          ?? nearest(inRange, posOf(u));
        this.#attackUnit([u], target, now, true);
        this.artyBusy.add(u.eid);
        continue;
      }
      if (wave && wave.units.has(u.eid) && front && wave.target) {
        this.artyBusy.add(u.eid);
        const last = this.lastOrder.get(u.eid);
        if (last?.type === 'move' && now - last.time < AI.waveReorderInterval / 2 && !isIdle(u)) continue; // saves APM
        const back = dirTo(wave.target.point, front);
        this.order([u], 'move', add(front, back, range * AI.artilleryStandoff), now, PRIORITY.normal, true);
      }
    }
  }

  // ---------- orders ----------

  /**
   * Gives units an order point (attackMove / move) unless they are already busy with the same order. Idle units
   * always get it again (an order a unit could not take is retried).
   */
  order(units, type, point, now, priority = PRIORITY.normal, force = false) {
    // [A9-F4b] never into a circle where a superweapon is about to hit; evacuating units keep their escape move
    const sw = this.ai.world.superweapons;
    if (sw?.activeStrikes?.().length && sw.threatAt(point.x, point.z, this.ai.diff.tech?.evacuate?.margin ?? 0)) return;
    const evac = this.ai.bb.evacuating;
    const send = units.filter((u) => {
      if (evac?.has(u.eid)) return false;
      if (!force && this.artyBusy.has(u.eid)) return false; // artillery shelling from range keeps its own orders
      const last = this.lastOrder.get(u.eid);
      const same = last && last.type === type && Math.hypot(last.x - point.x, last.z - point.z) < SAME_POINT;
      return !same || isIdle(u) || now - last.time > ORDER_REFRESH;
    });
    if (!send.length) return;
    for (const u of send) this.lastOrder.set(u.eid, { type, x: point.x, z: point.z, time: now });
    this.ai.issue({ type, units: send.map((u) => u.eid), point: { x: point.x, z: point.z }, queued: false }, { priority });
  }

  #attackUnit(units, target, now, force = false) {
    const evac = this.ai.bb.evacuating; // [A9-F4b]
    const send = units.filter((u) => {
      if (evac?.has(u.eid)) return false;
      if (!force && this.artyBusy.has(u.eid)) return false;
      const last = this.lastOrder.get(u.eid);
      return !(last?.type === 'attack' && last.target === target.eid) || isIdle(u);
    });
    if (!send.length) return;
    for (const u of send) this.lastOrder.set(u.eid, { type: 'attack', x: target.position.x, z: target.position.z, target: target.eid, time: now });
    this.ai.issue({ type: 'attack', units: send.map((u) => u.eid), target: target.eid, queued: false }, { priority: PRIORITY.high });
  }

  // ---------- crews ----------

  #board(now) {
    for (const [eid, pr] of this.promised) {
      const m = resolve(this.ai.world, eid);
      if (pr.until <= now || !m || m.crew || (!m.isMech && !m.crewless)) this.promised.delete(eid); // [A9-F4b] vehicles: crewed again
    }
    this.#boardStuck(now);
    const promisedCrews = new Set([...this.promised.values()].map((pr) => pr.crew));
    const crews = this.own.freeCrews.filter((c) => c.order?.type !== 'board' && !promisedCrews.has(c.eid));
    const empty = this.own.uncrewedMechs.filter((m) => m.canBoard && !this.promised.has(m.eid) && !this.mechBad?.has(m.eid));
    // [A9-F4b] vehicles left without a crew (neutron bomb) are boarded like empty robots (board command, field `mech`)
    for (const v of this.own.crewlessVehicles) if (v.canBoard && !this.promised.has(v.eid) && !this.mechBad?.has(v.eid)) empty.push(v);
    for (const crew of crews) {
      const reachable = empty.filter((m) => !((this.boardBad.get(`${crew.eid}:${m.eid}`) ?? -Infinity) > now));
      const mech = nearest(reachable, crew.position);
      if (!mech) continue;
      empty.splice(empty.indexOf(mech), 1);
      this.promised.set(mech.eid, { crew: crew.eid, until: now + AI.boardReserveSeconds });
      this.joining.delete(crew.eid); // v3: an empty robot beats a bay queue (same key: a waiting joinBay is replaced)
      this.stats.boardSent = (this.stats.boardSent ?? 0) + 1;
      this.ai.issue({ type: 'board', units: [crew.eid], mech: mech.eid, queued: false }, { priority: PRIORITY.high, key: `crew:${crew.eid}` });
    }
  }

  /**
   * [v20] Crews walking to a robot (board order) that get no closer by AI.boardStuck.progress within
   * AI.boardStuck.seconds are stopped and that crew + robot pair is not tried again for AI.boardStuck.avoidSeconds
   * (hard v20: 11 free crews, 8 empty robots – the crews never arrived). status().boardStuck counts them.
   */
  #boardStuck(now) {
    const cfg = AI.boardStuck;
    this.boardWatch ??= new Map(); // crew eid -> { mech eid, since, best }
    this.boardBad ??= new Map();   // "crew:mech" -> sim time until the pair is avoided
    for (const [key, until] of this.boardBad) if (until <= now) this.boardBad.delete(key);
    const seen = new Set();
    for (const c of this.own.crews) {
      const mech = c.order?.type === 'board' ? c.order.mech : null;
      if (!mech || c.inside) continue;
      seen.add(c.eid);
      const d = dist(posOf(c), posOf(mech));
      let w = this.boardWatch.get(c.eid);
      if (!w || w.mech !== mech.eid) { w = { mech: mech.eid, since: now, best: d }; this.boardWatch.set(c.eid, w); }
      if (d < w.best - cfg.progress) { w.best = d; w.since = now; continue; }
      if (now - w.since < cfg.seconds) continue;
      this.boardWatch.delete(c.eid);
      this.boardBad.set(`${c.eid}:${mech.eid}`, now + cfg.avoidSeconds);
      this.promised.delete(mech.eid);
      this.stats.boardStuck = (this.stats.boardStuck ?? 0) + 1;
      if (this.stats.boardStuck === 1 || this.stats.boardStuck % AI.boardStuck.noteEvery === 0) {
        this.ai.note(`crew cannot reach robot (${Math.round(d)} u) – ${this.stats.boardStuck}× so far`);
      }
      this.ai.issue({ type: 'stop', units: [c.eid] }, { priority: PRIORITY.high, key: `crew:${c.eid}` });
      this.#mechUnreachable(c, mech, d, now);
    }
    for (const eid of this.boardWatch.keys()) if (!seen.has(eid)) this.boardWatch.delete(eid);
    for (const [eid, until] of this.mechBad ?? []) {
      if (until <= now) { this.mechBad.delete(eid); this.mechFails?.delete(eid); }
    }
    // [E1 QA] robots that got a crew, died or were removed leave both maps (records stay only for empty robots)
    for (const eid of this.mechFails?.keys() ?? []) {
      const m = resolve(this.ai.world, eid);
      if (!m || !alive(m) || m.crew || (!m.isMech && !m.crewless)) { this.mechFails.delete(eid); this.mechBad?.delete(eid); }
    }
    // Production reads it: no crews are queued for these robots and they do not hold robot assembly back
    this.mechBad ??= new Map();
    this.ai.bb.unreachableMechs = this.mechBad; // mech eid -> until (Production only asks .has)
  }

  /**
   * [E1] A robot `AI.boardStuck.mechFails` different crews could not reach is avoided by every crew for
   * avoidSeconds (wave E: hard 28 stuck boards for 3 robots – the crews took turns on the same robots). The last
   * cases are kept in this.stuckSpots for the console (crew / robot position, distance left, robot's neighbours).
   */
  #mechUnreachable(crew, mech, d, now) {
    const cfg = AI.boardStuck;
    this.mechFails ??= new Map(); // mech eid -> Set of crew eids that failed
    this.mechBad ??= new Map();   // mech eid -> sim time until no crew is sent
    const fails = this.mechFails.get(mech.eid) ?? new Set();
    fails.add(crew.eid);
    this.mechFails.set(mech.eid, fails);
    if (fails.size >= cfg.mechFails) this.mechBad.set(mech.eid, now + cfg.avoidSeconds);
    this.stuckSpots ??= [];
    const near = (u) => u !== mech && dist(posOf(u), posOf(mech)) < cfg.spotRadius;
    const nearCrew = (s) => dist(posOf(s), posOf(crew)) < cfg.crewSpotRadius;
    this.stuckSpots.push({
      time: Math.round(now), crew: crew.eid, mech: mech.eid, left: Math.round(d),
      crewAt: { x: Math.round(posOf(crew).x), z: Math.round(posOf(crew).z) },
      mechAt: { x: Math.round(posOf(mech).x), z: Math.round(posOf(mech).z) },
      nearMechs: this.own.mechs.filter(near).length,
      nearStructures: this.own.structures.filter(near).map((s) => s.unitId),
      // [E1] the crew's side too: a crew walled in by own buildings (wave E2) shows here, not around the robot
      crewNearStructures: this.own.structures.filter(nearCrew).map((s) => `${s.unitId}@${Math.round(posOf(s).x)},${Math.round(posOf(s).z)}`),
    });
    if (this.stuckSpots.length > cfg.keepSpots) this.stuckSpots.shift();
  }

  /** Role of a robot from its weapons (armies.json roleClasses) */
  #roleOf(mech) {
    const classes = weaponDefsOf(mech).map((w) => w.class).filter(Boolean);
    return roleOfClasses(classes, this.ai.armies.roleClasses) ?? 'ranged';
  }

  #configure() {
    const armies = this.ai.armies;
    for (const m of this.own.crewedMechs) {
      if (!m.active || this.configured.has(m.eid)) continue;
      this.configured.add(m.eid);
      const role = this.#roleOf(m);
      const stance = armies.stance?.[role];
      const mode = armies.behaviour?.[role];
      // [A2-ai] after a takeover the whole army is configured at once: a command the rate limiter drops is sent again
      // (at the match start no drop handler – the same commands as before)
      const onDrop = this.ai.resumed ? () => this.configured.delete(m.eid) : null;
      if (stance && m.stance !== stance) this.ai.issue({ type: 'stance', units: [m.eid], stance }, { priority: PRIORITY.low, onDrop });
      if (mode && m.behaviour !== mode) this.ai.issue({ type: 'behaviour', units: [m.eid], mode }, { priority: PRIORITY.low, onDrop });
    }
  }

  // ---------- defence ----------

  #defend(now) {
    const p = this.ai.perception;
    const point = p.threat.point;
    if (!point) return;
    const anchor = this.own.anchor;
    const units = this.ai.diff.defend?.pullAll ? this.army
      : this.army.filter((u) => dist(posOf(u), anchor) < AI.baseRadius * 1.5);
    this.order(units, 'attackMove', point, now, PRIORITY.urgent);
  }

  // ---------- attack waves ----------

  #attack(now) {
    const ai = this.ai;
    const bb = ai.bb;
    const diff = ai.diff;
    const rally = bb.rally;
    if (!bb.wave) {
      // v2: a share of the army (difficulty.squads.homeGuard, nearest to the base) stays home; the harass squad too
      // (v3: and the super node squad)
      const squads = this.#squadIds();
      const pool = this.army.filter((u) => !squads.has(u.eid));
      const anchor = this.own.anchor;
      const guards = Math.floor(pool.length * (diff.squads?.homeGuard ?? 0));
      pool.sort((a, b) => dist(posOf(a), anchor) - dist(posOf(b), anchor));
      this.homeGuard = new Set(pool.slice(0, guards).map((u) => u.eid));
      bb.wave = { units: new Set(pool.slice(guards).map((u) => u.eid)), phase: 'gather', since: now, initial: 0, target: null, ended: null, reorderAt: 0 };
      ai.note(`wave of ${bb.wave.units.size} gathering (${guards} stay home)`);
    }
    const wave = bb.wave;
    if (wave.ended) return;
    if (wave.phase === 'gather') {
      // late arrivals join while gathering (not the home guard / harass / super node squad)
      const squads = this.#squadIds();
      for (const u of this.army) if (!this.homeGuard?.has(u.eid) && !squads.has(u.eid)) wave.units.add(u.eid);
    }
    const units = [...wave.units].map((eid) => resolve(ai.world, eid))
      .filter((u) => alive(u) && (u.isMech ? u.active : true) && !bb.maintaining?.has(u.eid));
    wave.units = new Set(units.map((u) => u.eid));
    if (!units.length) { wave.ended = 'destroyed'; return; }
    const strength = units.reduce((s, u) => s + strengthOf(u), 0);

    if (wave.phase === 'gather') {
      this.order(units.filter((u) => dist(posOf(u), rally) > AI.gatherRadius), 'attackMove', rally, now);
      const gathered = units.filter((u) => dist(posOf(u), rally) <= AI.gatherRadius).length;
      if (gathered / units.length >= diff.attack.gatherFraction || now - wave.since > AI.gatherTimeout) {
        wave.phase = 'go';
        wave.initial = strength;
        wave.target = null;
        ai.stats.wavesSent++; // counted when it leaves (v1 counted only ended waves, so `waves` stayed 0)
        ai.note(`wave of ${units.length} attacks (strength ${Math.round(strength)})`);
      }
      return;
    }

    // Attacking
    if (diff.attack.retreatRatio > 0 && strength < wave.initial * diff.attack.retreatRatio) {
      this.order(units, 'move', rally, now, PRIORITY.urgent, true); // artillery retreats too
      wave.ended = 'retreat';
      return;
    }
    const centre = centroid(units);
    if (wave.target && dist(centre, wave.target.point) < AI.arrivalRadius && wave.target.kind !== 'structure') {
      this.visited.set(wave.target.key, now);
      wave.target = null;
    }
    if (wave.target?.kind === 'structure' && !ai.perception.memory.has(wave.target.eid)) wave.target = null;
    if (!wave.target || now >= wave.reorderAt) {
      wave.target = this.chooseTarget(centre) ?? wave.target;
      wave.reorderAt = now + AI.waveReorderInterval;
      // v3: allied AIs read which enemy team we go for (allyBoard.js)
      if (wave.target?.kind === 'structure') shareIntent(ai.team, { targetTeam: wave.target.team, point: wave.target.point, time: now });
    }
    if (!wave.target) return;
    let fighters = units;
    if (diff.micro?.pullBackDamaged) {
      const hurt = units.filter((u) => hpRatio(u) < diff.micro.damagedHpRatio);
      if (hurt.length) {
        this.order(hurt, 'move', rally, now, PRIORITY.high);
        for (const u of hurt) wave.units.delete(u.eid);
        fighters = units.filter((u) => !hurt.includes(u));
      }
    }
    fighters = this.#escort(fighters, wave.target.point, now);
    if (diff.micro?.focusFire && this.#focus(fighters, centre, now)) return;
    this.order(fighters, 'attackMove', wave.target.point, now);
  }

  /**
   * R3: aircraft are much faster than the ground units – they escort them (attack-move AI.air.escortLead ahead of
   * the ground centre towards the target) until the ground units are within AI.air.escortRelease of the target.
   * @returns the units that still take the wave's orders (the ground units while escorting, else all)
   */
  #escort(units, target, now) {
    const ground = units.filter((u) => !u.airborne);
    if (!ground.length || ground.length === units.length) return units;
    const centre = centroid(ground);
    if (dist(centre, target) <= AI.air.escortRelease) return units;
    const air = units.filter((u) => u.airborne);
    this.order(air, 'attackMove', add(centre, dirTo(centre, target), AI.air.escortLead), now);
    return ground;
  }

  /** Hard micro: ranged robots shoot the weakest armed enemy near the wave. @returns {boolean} gave orders */
  #focus(units, centre, now) {
    const enemies = this.ai.perception.visibleEnemies
      .filter((e) => !e.isStructure && strengthOf(e) > 0 && dist(posOf(e), centre) < FOCUS_RADIUS);
    if (!enemies.length) return false;
    const ranged = units.filter((u) => !u.isMech || this.#roleOf(u) !== 'melee');
    // [NQ3] only targets someone can hit (an aircraft without anti-air would stall the wave: attack refused)
    const hitters = ranged.length ? ranged : units;
    const pool = enemies.filter((e) => hitters.some((u) => canEngage(u, e)));
    if (!pool.length) return false;
    const target = pool.reduce((best, e) => (hpOf(e).hp < hpOf(best).hp ? e : best));
    const shoot = ranged.filter((u) => canEngage(u, target));
    const rest = units.filter((u) => !shoot.includes(u));
    if (shoot.length) this.#attackUnit(shoot, target, now);
    if (rest.length) this.order(rest, 'attackMove', posOf(target), now);
    return true;
  }

  /**
   * Where to attack: { kind: 'structure' | 'superNode' | 'explore', point, key, eid?, team? }.
   * [N5] The nearest known building of any enemy team (allies are never enemy teams): the closest enemy base is
   * attacked first; with one enemy team this is the same pick as before.
   * v3: a team an allied AI attacks right now counts as nearer (distance × AI.allyFocus.factor) – allies gang up on
   * one enemy. With nothing known: the super node, then unexplored starts in the order of
   * Perception.enemyStartGuesses (map symmetry: the most likely enemy start first).
   */
  chooseTarget(from) {
    const ai = this.ai;
    const p = ai.perception;
    const now = ai.now;
    const focus = this.#allyTargets(now);
    let best = null;
    for (const team of p.enemyTeams) { // ascending team order: a tie keeps the lower team
      const buildings = p.knownStructures(team);
      if (!buildings.length) continue;
      const b = nearest(buildings, from, (m) => m);
      const d = dist(from, b) * (focus.has(team) ? AI.allyFocus.factor : 1);
      if (!best || d < best.dist) best = { dist: d, kind: 'structure', point: { x: b.x, z: b.z }, eid: b.eid, team, key: `s${b.eid}` };
    }
    if (best) return best;
    const fresh = (key) => now - (this.visited.get(key) ?? -Infinity) > REVISIT_SECONDS;
    const starts = p.enemyStartGuesses().map((s) => ({ s, key: `start${Math.round(s.x)},${Math.round(s.z)}` }));
    // v5 (difficulty.attack.guessBase): the most likely enemy start before the super node – the wave went to the node,
    // then explored, and met the defended base late and spread out
    if (ai.diff.attack?.guessBase) {
      const guess = starts.find(({ s, key }) => !p.isExplored(s) && fresh(key));
      if (guess) return { kind: 'explore', point: guess.s, key: guess.key };
    }
    const node = ai.world.map?.superNode;
    if (node && fresh('superNode')) return { kind: 'superNode', point: { x: node.x, z: node.z }, key: 'superNode' };
    const unexplored = starts.filter(({ s, key }) => !p.isExplored(s) && fresh(key));
    const pool = unexplored.length ? unexplored : starts.filter(({ key }) => fresh(key));
    const pick = pool[0] ?? null; // most likely enemy start first
    if (pick) return { kind: 'explore', point: pick.s, key: pick.key };
    this.visited.clear(); // everything visited recently: start over
    return null;
  }

  /** v3: enemy teams allied AIs attack now (fresh allyBoard entries) */
  #allyTargets(now) {
    const out = new Set();
    const p = this.ai.perception;
    for (let t = 0; t < (this.ai.world.economy?.accounts?.length ?? 0); t++) {
      if (!p.isAllyTeam(t)) continue;
      const it = intentOf(t);
      if (it && it.time <= now && now - it.time <= AI.allyFocus.seconds && p.isEnemyTeam(it.targetTeam)) out.add(it.targetTeam);
    }
    return out;
  }

  // ---------- army at home ----------

  #rest(now) {
    const bb = this.ai.bb;
    if (bb.state === 'defend' || bb.homeDefense || (bb.state === 'build' && bb.allyHelp)) return;
    const home = this.homeUnits();
    const rally = bb.rally;
    const away = home.filter((u) => isIdle(u) && dist(posOf(u), rally) > AI.gatherRadius);
    this.order(away, 'attackMove', rally, now, PRIORITY.low);
    const below = this.ai.diff.micro?.repairBelow ?? 0;
    if (below <= 0) return;
    const repair = home.filter((u) => u.isMech && isIdle(u) && u.canRepair && !u.repairing && hpRatio(u) < below
      && dist(posOf(u), rally) <= AI.gatherRadius);
    if (repair.length) this.ai.issue({ type: 'repair', units: repair.map((u) => u.eid), start: true }, { priority: PRIORITY.low });
  }
}
