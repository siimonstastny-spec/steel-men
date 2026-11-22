// Steel Mans – crew squad: N small figures (crew.squadSize) that operate one mech together.
// The squad shares one HP pool and is always complete – a mech needs all of them, so the squad
// never shrinks; it dies as a whole at 0 HP. Experience belongs to the squad, not the mech.
import * as THREE from 'three';
import { loadModel, loadGltf } from '../core/AssetLoader.js';
import { loadStats, getStats, crewStats, rankFor, applyArmor } from '../data/Stats.js';
import { TEAMS, PLAYER_TEAM, MOVEMENT, RINGS, CREW, ARRIVE_DISTANCE, BEHAVIOUR, CREW_EVAC } from '../config.js';
import { isLocal } from '../core/LocalPlayer.js';
import { blockedOnTheWay, followPath } from '../game/Movement.js';
import { isTargetable, areEnemies, edgeDistance } from '../game/Combat.js';
import { applyTeamColor } from '../core/TeamColor.js';
import { play } from '../audio/Sound.js';
import { advanceQueue, clearQueue } from './OrderQueue.js';
import { isCrewBay, approachCrewBay } from '../game/BayCrew.js';

const DEG = Math.PI / 180;

/** Local offsets of n members in rows (front row towards +Z), centred on the squad origin */
function formation(n, spacing) {
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const out = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = row === rows - 1 ? n - row * cols : cols; // last row may be shorter
    const col = i % cols;
    out.push(new THREE.Vector3((col - (inRow - 1) / 2) * spacing, 0, ((rows - 1) / 2 - row) * spacing));
  }
  return out;
}

export class Crew extends THREE.Group {
  constructor(race, { name = 'Posádka', team = PLAYER_TEAM } = {}) {
    super();
    this.name = name;
    this.race = race;
    this.team = team;
    this.radius = 3;       // set from the formation in load()
    this.aimHeight = 1.5;
    this.stats = null;     // squad stats from Stats.crewStats (race applied, totals for the whole squad)
    this.hp = 0;
    this.maxHp = 0;
    this.xp = 0;
    this.rank = null;      // Stats.rankFor(xp)
    this.mech = null;      // mech this squad is operating (squad is hidden while inside)
    this.bay = null;       // [N2] assembly bay this squad waits in (hidden too, BayCrew.js)
    this.order = null;     // { type: 'move', target, home? } | { type: 'board', mech } | { type: 'joinBay', bay } | { type: 'flee', … }
    this.behaviour = null; // 'defensive' (runs from attackers, then returns) | 'passive' (stays) – BEHAVIOUR.crewModes
    this.speed = 0;
    this.dead = false;
    this.removed = false;
    this.world = null;
    this.members = [];     // { object, mixer, actions, current }
    this.selectionRing = null;
    this.teamRing = null;
    this.state = 'idle';
  }

  async load() {
    await loadStats();
    this.stats = crewStats(this.race, this.team);
    this.behaviour ??= getStats().rules.crew.defaultBehaviour;
    const n = this.stats.squadSize;
    const [animSource, ...objects] = await Promise.all([
      loadGltf(this.stats.animationSource),
      ...Array.from({ length: n }, () => loadModel(this.stats.model)),
    ]);
    this.maxHp = this.hp = this.stats.hp;
    this.rank = rankFor(this.xp);

    const offsets = formation(n, this.stats.formationSpacing);
    for (const object of objects) object.scale.setScalar(this.stats.modelScale ?? 1);
    const lift = this.#groundOffset(objects[0]);
    objects.forEach((object, i) => {
      object.userData.crew = this;
      object.position.copy(offsets[i]).setY(lift);
      object.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        o.receiveShadow = true;
      });
      this.add(object);
      // Crew models of all races share node names, so clips from the X model drive every variant
      const mixer = new THREE.AnimationMixer(object);
      const actions = {};
      for (const [key, clipName] of Object.entries(this.stats.clips)) {
        const clip = animSource.animations.find((c) => c.name === clipName);
        if (clip) actions[key] = mixer.clipAction(clip);
        else if (i === 0) console.warn(`[Crew] Clip "${clipName}" not found in ${this.stats.animationSource}`);
      }
      this.members.push({ object, mixer, actions, current: null, phase: Math.random() });
    });
    this.#play('idle');
    this.refreshTeamColor();

    this.#createSelectionRing(offsets);
    const box = new THREE.Box3().setFromObject(objects[0]);
    this.bodyHeight = box.max.y - box.min.y; // body height for 3D splash / pellet hits
    this.aimHeight = this.bodyHeight * CREW.aimHeightFactor;
    return this;
  }

  // ---------- state ----------

  /** The team's research changed: squad stats are resolved again, HP keep their share of max HP */
  applyResearch() {
    if (!this.stats || this.dead) return;
    const ratio = this.maxHp > 0 ? this.hp / this.maxHp : 1;
    this.stats = crewStats(this.race, this.team);
    this.maxHp = this.stats.hp;
    this.hp = ratio * this.maxHp;
  }

  get isMech() { return false; }
  get alive() { return !this.dead; }
  get destroyed() { return this.dead; }   // same interface as ModularMech for selection code
  get evasion() { return this.bonuses.evasion ?? 0; }
  get inside() { return this.mech !== null || this.bay !== null; }
  get bonuses() { return this.rank?.bonuses ?? {}; }
  get size() { return this.stats.squadSize; }
  get supply() { return this.stats.supply; }
  get pickables() {
    if (this.dead || this.inside) return [];
    return this.members.flatMap((m) => meshesOf(m.object));
  }

  setSelected(on) {
    if (this.selectionRing) this.selectionRing.visible = on && !this.dead && !this.inside;
  }

  /** Paints the figures (and team ring) in the team's current colour */
  refreshTeamColor() {
    const color = TEAMS[this.team].color;
    for (const m of this.members) applyTeamColor(m.object, color);
    this.teamRing?.material.color.set(color);
  }

  // ---------- experience ----------

  /** Adds XP; the mech this squad operates refreshes its stats on rank-up */
  addXp(amount) {
    if (this.dead || amount <= 0) return;
    this.xp += amount;
    const rank = rankFor(this.xp);
    const changed = rank.index !== this.rank.index;
    this.rank = rank;
    if (changed) this.mech?.onCrewRankChanged();
  }

  /** XP for damage dealt / kills – call from combat code once weapons hit targets */
  onDamageDealt(amount, killed = false) {
    const e = getStats().experience;
    this.addXp(amount * e.xpPerDamage + (killed ? e.xpPerKill : 0));
  }

  // ---------- damage ----------

  takeDamage(damage) {
    if (this.dead || this.inside) return 0;
    const dealt = Math.min(applyArmor(damage, this.stats.armor).total, this.hp);
    this.hp -= dealt;
    if (this.hp <= 0) this.#die();
    return dealt;
  }

  // ---------- orders ----------

  moveTo(point) {
    if (this.dead || this.inside) return false;
    this.order = { type: 'move', target: point.clone() };
    return true;
  }

  /** Walk to a mech and board it */
  board(mech) {
    if (this.dead || this.inside || !mech.canBoard || mech.team !== this.team) return false;
    this.order = { type: 'board', mech };
    return true;
  }

  /** [N2] Walk to an own assembly bay and wait inside it for a new mech (BayCrew.js) */
  joinBay(bay) {
    if (this.dead || this.inside || !isCrewBay(bay, this.team)) return false;
    this.order = { type: 'joinBay', bay };
    return true;
  }

  /**
   * Behaviour when the squad has no order (BEHAVIOUR.crewModes). Switching to passive stops a defensive run.
   * @returns {boolean} false for an unknown mode
   */
  setBehaviour(mode) {
    if (!BEHAVIOUR.crewModes.includes(mode)) return false;
    this.behaviour = mode;
    if (mode === 'passive' && this.order?.defensive) this.order = null;
    return true;
  }

  /**
   * Runs away from the enemies the squad can see (sightRange) plus the given threats, until none of them
   * is closer than CREW.flee.safeDistance (or CREW.flee.maxTime runs out). Then walks back to `home`, if given.
   * @param {object[]} [threats]  units to run from even when out of sight (e.g. the attacker)
   * @param {THREE.Vector3} [origin]  a point to run from when no enemy is known (the exploding mech)
   * @param {object} [opts] { home, defensive, evacuate } – defensive marks a run of the defensive behaviour;
   *   [N8] evacuate = the squad jumped out of a destroyed mech: it runs from every enemy its team knows about
   *   (fog, CREW_EVAC.awareRange), leaning towards its own HQ, and then walks to the HQ (an order of its own, so any
   *   player order replaces it). Without known enemies it heads straight for the HQ.
   */
  flee(threats = [], origin = null, { home = null, defensive = false, evacuate = false } = {}) {
    if (this.dead || this.inside) return false;
    this.order = {
      type: 'flee', threats, origin: origin?.clone() ?? null, home, defensive, evacuate,
      time: 0, replan: 0, target: this.position.clone(),
    };
    return true;
  }

  /**
   * [N8] Enemies this squad's team knows about near it: armed (a crewed mech, a vehicle or building with weapons),
   * in sight of the team (shared fog, allies included) and within CREW_EVAC.awareRange. Sim-safe: fog.canTeamSee.
   */
  #knownThreats() {
    const fog = this.world.fog;
    return this.world.units.filter((u) => areEnemies(this, u) && !u.inside
      && (u.weapons?.length ?? 0) > 0 && !(u.isMech && !u.crew)
      && (!fog || fog.canTeamSee(this.team, u))
      && edgeDistance(this, u) <= CREW_EVAC.awareRange);
  }

  /** [N8] Nearest finished own HQ (hq in stats), ties = earlier in world.structures; null when there is none */
  #ownHq() {
    let best = null;
    let bestD = Infinity;
    for (const s of this.world.structures) {
      if (s.team !== this.team || !s.stats?.hq || !s.complete || s.destroyed || s.removed) continue;
      const d = Math.hypot(s.position.x - this.position.x, s.position.z - this.position.z);
      if (d < bestD) { best = s; bestD = d; }
    }
    return best;
  }

  /** [N8] Spot next to the HQ on the squad's side (outside the building, CREW_EVAC.hqStandOff from its radius) */
  #hqSpot(hq) {
    let dx = this.position.x - hq.position.x;
    let dz = this.position.z - hq.position.z;
    const len = Math.hypot(dx, dz);
    if (len < MOVEMENT.overlapEpsilon) { dx = 0; dz = 1; } else { dx /= len; dz /= len; }
    const r = (hq.radius ?? 0) + this.radius + CREW_EVAC.hqStandOff;
    return new THREE.Vector3(hq.position.x + dx * r, 0, hq.position.z + dz * r);
  }

  /** [N8] After an evacuation run: walk to the own HQ (a 'move' with home, so it is not a player order); null if none */
  #retreatOrder() {
    const hq = this.#ownHq();
    if (!hq) return null;
    const spot = this.#hqSpot(hq);
    return { type: 'move', target: spot, home: spot, evacuate: true, alarm: CREW_EVAC.alarmInterval };
  }

  /** Called by ModularMech when the squad gets in */
  enter(mech) {
    this.mech = mech;
    this.order = null;
    clearQueue(this); // orders queued after boarding are dropped (the mech has its own)
    this.speed = 0;
    this.setSelected(false);
    this.removeFromParent();
  }

  /** Called by ModularMech when the squad gets out (eject or mech destroyed) */
  exit(position, yaw) {
    this.mech = null;
    this.position.copy(position);
    this.position.y = this.world.heightAt(position.x, position.z);
    this.rotation.y = yaw;
    this.world.scene.add(this);
    this.#play('idle');
  }

  /** [N2] Called by BayCrew when the squad goes into an assembly bay's queue */
  stepIntoBay(bay) { // not named enterBay: that is the mech's service order (unitCommands would call it)
    this.bay = bay;
    this.order = null;
    clearQueue(this);
    this.speed = 0;
    this.setSelected(false);
    this.removeFromParent();
  }

  /** [N2] Called by BayCrew when the squad leaves the bay queue on foot (release, bay lost) */
  leaveBay(position, yaw) {
    this.bay = null;
    this.exit(position, yaw);
  }

  update(dt) {
    if (this.dead || this.inside) return;
    for (const m of this.members) m.mixer.update(dt);
    // Stunned or being thrown back (StatusEffects): the squad stands
    if (this.status?.disabled || this.status?.knockedBack) { this.speed = 0; this.#play('idle'); return; }
    advanceQueue(this); // orders given with Shift (OrderQueue.js)
    this.#react(dt);
    const moving = this.#move(dt);
    if (!moving) this.speed = 0;
    this.#play(moving ? 'run' : 'idle');
    if (moving) {
      const rate = Math.max(CREW.minRunAnimRate, this.speed / this.stats.runAnimRefSpeed);
      for (const m of this.members) if (m.actions.run) m.actions.run.timeScale = rate;
    }
  }

  // ---------- internal ----------

  // Defensive squad without an order (or walking back home) runs from whoever shot at it
  #react(dt) {
    const attacker = this.lastAttacker;
    this.lastAttacker = null;
    this.#evacAlarm(dt);
    if (this.behaviour !== 'defensive' || !isTargetable(attacker) || !areEnemies(this, attacker)) return;
    const o = this.order;
    if (o && !(o.type === 'move' && o.home)) return; // explicit orders win; a run in progress goes on
    this.flee([attacker], null, { home: o?.home ?? this.position.clone(), defensive: true, evacuate: !!o?.evacuate });
  }

  // [N8] Evacuated squad walking to its HQ: a known enemy close by (CREW_EVAC.alarmDistance) starts a new run
  // (any behaviour – the walk is not a player order; a player order replaces the walk and ends this check)
  #evacAlarm(dt) {
    const o = this.order;
    if (o?.type !== 'move' || !o.evacuate || (o.alarm -= dt) > 0) return;
    o.alarm = CREW_EVAC.alarmInterval;
    const near = this.#knownThreats().filter((u) => edgeDistance(this, u) <= CREW_EVAC.alarmDistance);
    if (near.length) this.flee(near, null, { evacuate: true });
  }

  /**
   * Updates a flee order: every CREW.flee.replanInterval picks a point CREW.flee.step away from the threats
   * (enemies in sight, the given threats and origin – nearer ones push harder). Returns false when the run
   * is over: safe, out of time or nowhere to run.
   */
  #updateFlee(o, dt) {
    const cfg = CREW.flee;
    if ((o.time += dt) > cfg.maxTime) return false;
    if ((o.replan -= dt) > 0) return true;
    o.replan = cfg.replanInterval;
    // [N8] An evacuated squad runs from every enemy its team knows about (fog), others from what they see themselves
    const seen = o.evacuate
      ? this.#knownThreats()
      : this.world.units.filter((u) => areEnemies(this, u) && edgeDistance(this, u) <= this.stats.sightRange);
    const points = [...new Set([...seen, ...o.threats.filter(isTargetable)])].map((u) => u.position);
    // [N8] Evacuation without a known enemy: no run at all, the squad heads for its HQ (#move turns the order into
    // the walk there); only without an HQ it runs from the wreck as before
    const hq = o.evacuate ? this.#ownHq() : null;
    if (hq && !points.length) return false;
    // The exploding mech only gives the direction when no enemy is known – being close, it would otherwise
    // outweigh the real threats and could send the squad straight at them
    if (o.origin && !points.length) points.push(o.origin);
    let dx = 0;
    let dz = 0;
    let nearest = Infinity;
    for (const p of points) {
      const x = this.position.x - p.x;
      const z = this.position.z - p.z;
      const d = Math.max(Math.hypot(x, z), MOVEMENT.overlapEpsilon);
      nearest = Math.min(nearest, d);
      dx += x / (d * d);
      dz += z / (d * d);
    }
    let len = Math.hypot(dx, dz);
    if (nearest >= cfg.safeDistance || len < MOVEMENT.overlapEpsilon) return false;
    // [N8] Lean towards the own HQ when it lies roughly away from the threats (never towards them)
    if (hq && CREW_EVAC.hqBias > 0) {
      const hx = hq.position.x - this.position.x;
      const hz = hq.position.z - this.position.z;
      const hl = Math.hypot(hx, hz);
      if (hl > MOVEMENT.overlapEpsilon && (dx * hx + dz * hz) / (len * hl) >= CREW_EVAC.hqMinDot) {
        dx = dx / len + (hx / hl) * CREW_EVAC.hqBias;
        dz = dz / len + (hz / hl) * CREW_EVAC.hqBias;
        len = Math.hypot(dx, dz);
      }
    }
    const lim = this.world.nav.half - cfg.mapMargin;
    o.target.set(
      THREE.MathUtils.clamp(this.position.x + (dx / len) * cfg.step, -lim, lim),
      0,
      THREE.MathUtils.clamp(this.position.z + (dz / len) * cfg.step, -lim, lim),
    );
    o.nav = null;
    return true;
  }

  #move(dt) {
    if (!this.order) return false;
    let target;
    let ignore = [];
    if (this.order.type === 'flee') {
      const o = this.order;
      if (!this.#updateFlee(o, dt)) {
        // [N8] an evacuation run ends with the walk to the own HQ (or nothing when the team has no HQ)
        this.order = o.evacuate ? this.#retreatOrder()
          : o.home ? { type: 'move', target: o.home, home: o.home } : null;
        return false;
      }
      target = o.target;
    } else if (this.order.type === 'board') {
      const mech = this.order.mech;
      if (!mech.canBoard) { this.order = null; return false; }
      target = mech.position;
      ignore = [mech]; // a crewless mech is an obstacle – except for the crew boarding it
      if (Math.hypot(target.x - this.position.x, target.z - this.position.z) <= getStats().rules.crew.boardRange) {
        play('crewBoard', { position: mech.position });
        mech.boardCrew(this);
        return false;
      }
    } else if (this.order.type === 'joinBay') {
      const bay = this.order.bay;
      target = approachCrewBay(this, this.order); // [N2] null = went in / bay full or gone (order ended)
      if (!target) return false;
      ignore = [bay]; // the path may end at the building itself
    } else {
      target = this.order.target;
    }

    // Head for the next waypoint around static obstacles; dist = path length left
    const path = followPath(this, this.order, target, ignore, dt);
    const dist = path.remaining;
    const arrive = this.order.home ? BEHAVIOUR.homeArriveDistance : ARRIVE_DISTANCE;
    if (dist <= arrive && this.order.type === 'move') { this.order = null; return false; }
    // The walk to a mech ended at the nearest free spot (mech hemmed in by a building / wall): board when the
    // mech's edge is in reach (CREW.board)
    if (this.order.type === 'board' && path.final && dist <= CREW.board.pathEndReach) {
      const mech = this.order.mech;
      const edge = Math.hypot(target.x - this.position.x, target.z - this.position.z) - (mech.radius ?? 0);
      if (edge <= getStats().rules.crew.boardRange + CREW.board.edgeBuffer) {
        play('crewBoard', { position: mech.position });
        mech.boardCrew(this);
        return false;
      }
    }
    const dx = path.point.x - this.position.x;
    const dz = path.point.z - this.position.z;
    const legDist = Math.hypot(dx, dz);
    if (legDist < MOVEMENT.overlapEpsilon) return false;

    const m = this.stats.mobility;
    let diff = Math.atan2(dx, dz) - this.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    if (this.order.type === 'move' && blockedOnTheWay(this.order, dist, diff, dt)) { this.order = null; return false; }
    const maxTurn = m.turnSpeed * DEG * dt;
    this.rotation.y += THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);

    const brakeSpeed = this.order.type === 'move' ? Math.sqrt(2 * m.deceleration * dist) : Infinity;
    const wantSpeed = Math.min(m.moveSpeed, brakeSpeed) * Math.max(0, Math.cos(diff));
    this.speed = this.speed < wantSpeed
      ? Math.min(wantSpeed, this.speed + m.acceleration * dt)
      : Math.max(wantSpeed, this.speed - m.deceleration * dt);

    const step = Math.min(path.final ? legDist : dist, this.speed * dt);
    this.position.x += (dx / legDist) * step;
    this.position.z += (dz / legDist) * step;
    this.position.y = this.world.heightAt(this.position.x, this.position.z);
    return true;
  }

  #play(state) {
    if (state === this.state && this.members[0]?.current) return;
    this.state = state;
    for (const m of this.members) {
      const action = m.actions[state];
      if (!action || action === m.current) continue;
      action.reset().play();
      // Random phase so the squad does not move in perfect lockstep
      action.time = m.phase * action.getClip().duration;
      if (m.current) m.current.crossFadeTo(action, CREW.animFadeTime, false);
      m.current = action;
    }
  }

  #die() {
    this.dead = true;
    this.order = null;
    this.setSelected(false);
    this.removed = true; // World removes the unit
  }

  // Model origin may not be at the feet – how much to lift it so the feet stand on y = 0
  #groundOffset(object) {
    object.updateMatrixWorld(true);
    return -new THREE.Box3().setFromObject(object).min.y;
  }

  #createSelectionRing(offsets) {
    const r = Math.max(...offsets.map((o) => Math.hypot(o.x, o.z))) + CREW.ringMargin;
    this.radius = r;
    const make = (inner, outer, color, opacity) => {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(inner, outer, RINGS.crewSegments),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = RINGS.height;
      this.add(ring);
      return ring;
    };
    this.selectionRing = make(r - RINGS.selectionWidth, r, RINGS.activeColor, RINGS.selectionOpacity);
    this.selectionRing.visible = false;
    const t = RINGS.crewTeamRing;
    if (!isLocal(this)) this.teamRing = make(r - t.inset - t.width, r - t.inset, TEAMS[this.team].color, t.opacity);
  }
}

function meshesOf(object) {
  const out = [];
  object.traverse((o) => { if (o.isMesh) out.push(o); });
  return out;
}
