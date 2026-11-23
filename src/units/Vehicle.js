// Steel Mans – vehicle (stats.json → vehicles): moves along world.nav paths, collides with other units, has HP,
// can be selected and ordered (CommandInput). Abilities from the data decide what else it does:
//   { type: 'harvest', resource, ratePerSecond, range } – mines an ore deposit directly into the team account
//   { type: 'construct' }                                – builds structures (Construction.js / Structure.js)
// Armed vehicles (stats.json entries with weapons) are CombatVehicle (src/units/CombatVehicle.js, created by loadVehicle).
import * as THREE from 'three';
import { loadModel } from '../core/AssetLoader.js';
import { loadStats, getStats, unitStats, applyArmor } from '../data/Stats.js';
import { TEAMS, PLAYER_TEAM, MOVEMENT, RINGS, ARRIVE_DISTANCE, VEHICLE, VFX, MISC, SALVAGE_DROP, AUTO_ASSIST, MINOR_FIXES, N2_UI, N1B } from '../config.js';
import { isLocal } from '../core/LocalPlayer.js';
import { blockedOnTheWay, followPath } from '../game/Movement.js';
import { applyTeamColor } from '../core/TeamColor.js';
import { canRepairTarget, vehicleRepairStep } from '../game/Repair.js';
import { issueOrder, advanceQueue, clearQueue } from './OrderQueue.js';
import { continuesAlone } from '../game/Construction.js';

const DEG = Math.PI / 180;

/** Distance from a point to the edge of an axis-aligned box { x, z, halfX, halfZ } (0 inside) */
export function distanceToBox(p, box) {
  const dx = Math.max(Math.abs(p.x - box.x) - box.halfX, 0);
  const dz = Math.max(Math.abs(p.z - box.z) - box.halfZ, 0);
  return Math.hypot(dx, dz);
}

const cargoBox = new THREE.Box3(); // [N2] scratch box for placing a carried part
const cargoQuat = new THREE.Quaternion();       // [W8] ground orientation of the part being loaded
const cargoParentQuat = new THREE.Quaternion(); // [W8] inverse world orientation of the vehicle
// Building ids that take salvage, cached per rules.salvageResearch object (Vehicle.#dropOffIds)
const NO_RULE = Symbol('noRule'); // [B6 QA] never equal to a rules object (or its absence), so the first call fills the cache
const dropOffCache = { rule: NO_RULE, analysis: [], stock: [] };
const DROP_OFF_ORDER = [true, false]; // [B6] research facility (analysis) first, then part stock – no array per call

export class Vehicle extends THREE.Group {
  /**
   * @param {string} id     stats.json → vehicles key, e.g. 'drillTruck'
   * @param {string} race   owner faction (stats.json race key)
   */
  constructor(id, race, { name = id, team = PLAYER_TEAM } = {}) {
    super();
    this.unitId = id;
    this.race = race;
    this.name = name;
    this.team = team;
    this.stats = null;
    this.hp = 0;
    this.maxHp = 0;
    this.radius = 4;
    this.aimHeight = 2;
    this.bodyHeight = 4;
    this.order = null;    // { type: 'move', target } | { type: 'harvest', deposit } | { type: 'build', structure }
    this.speed = 0;
    this.dead = false;
    this.removed = false;
    this.world = null;
    this.model = null;
    this.selectionRing = null;
    this.teamRing = null;
    this.activity = null; // 'harvesting' | 'building' | 'waiting' – what the vehicle does at its target (HUD)
    this.cargo = [];      // carried salvage wrecks: { part (MechPart), info (World.takeSalvage), scale }
    this.orderQueue = []; // orders given with Shift, carried out after the current one (OrderQueue.js)
  }

  async load() {
    await loadStats();
    this.stats = unitStats('vehicles', this.unitId, this.race, this.team);
    this.maxHp = this.hp = this.stats.hp;
    const model = await loadModel(this.stats.model);
    // VEHICLE.modelScale for all vehicles × the vehicle's own stats.modelScale (data, default 1)
    model.scale.setScalar(VEHICLE.modelScale * (this.stats.modelScale ?? 1));
    // Centre the footprint on the origin so the collision circle sits on the model
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const centre = box.getCenter(new THREE.Vector3());
    model.position.set(-centre.x, -box.min.y, -centre.z);
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
    });
    model.userData.unit = this;
    this.model = model;
    this.add(model);
    const size = box.getSize(new THREE.Vector3());
    this.radius = Math.max(size.x, size.z) * VEHICLE.radiusFactor;
    this.bodyHeight = size.y;
    this.aimHeight = size.y * VEHICLE.aimHeightFactor;
    this.#createRings();
    this.refreshTeamColor();
    return this;
  }

  // ---------- state ----------

  /** The team's research changed: stats are resolved again, HP keep their share of max HP */
  applyResearch() {
    if (!this.stats || this.dead) return;
    const ratio = this.maxHp > 0 ? this.hp / this.maxHp : 1;
    this.stats = unitStats('vehicles', this.unitId, this.race, this.team);
    this.maxHp = this.stats.hp;
    this.hp = ratio * this.maxHp;
  }

  get isMech() { return false; }
  get isVehicle() { return true; }
  get alive() { return !this.dead; }
  get destroyed() { return this.dead; }
  get inside() { return false; }
  get supply() { return this.stats?.supply ?? 0; }
  get hover() { return this.stats?.mobility?.movementType === 'hover'; }
  /** Harvest ability from the data, or null */
  get harvester() { return this.stats?.abilities.find((a) => a.type === 'harvest') ?? null; }
  /** Salvage ability { capacity, pickupRange, unloadRange } (carries legs / torso wrecks), or null */
  get salvager() { return this.stats?.abilities.find((a) => a.type === 'salvage') ?? null; }
  /** Repair ability { rate, range, costPerHp } (repairs own mechs, vehicles, buildings – Repair.js), or null */
  get repairer() { return this.stats?.abilities.find((a) => a.type === 'repair') ?? null; }
  get cargoFull() { return this.cargo.length >= (this.salvager?.capacity ?? 0); }
  /** Can this vehicle build structures? */
  get canConstruct() { return Boolean(this.stats?.abilities.some((a) => a.type === 'construct')); }
  get pickables() { return this.dead ? [] : meshesOf(this.model); }

  setSelected(on) { if (this.selectionRing) this.selectionRing.visible = on && !this.dead; }

  refreshTeamColor() {
    const color = TEAMS[this.team].color;
    if (this.model) applyTeamColor(this.model, color);
    this.teamRing?.material.color.set(color);
  }

  // ---------- damage ----------

  takeDamage(damage) {
    if (this.dead) return 0;
    const dealt = Math.min(applyArmor(damage, this.stats.armor).total, this.hp);
    this.hp -= dealt;
    if (this.hp <= 0) this.destroy();
    return dealt;
  }

  /** Explodes and disappears (also the "delete unit" command) */
  destroy() {
    if (this.dead) return;
    this.dead = true;
    this.order = null;
    this.#dropCargo();
    this.setSelected(false);
    this.world?.effects.explodeUnit(this, { fallbackSize: VEHICLE.explosionSize }); // [R9] style by kind x race
    this.removed = true; // World removes the unit
  }

  // ---------- orders ----------

  // Every order method is a new order from the player: it drops the queued orders (orderQueue). Orders given
  // with Shift go through issueOrder (OrderQueue.js), which keeps the rest of the queue while running them.
  moveTo(point) {
    if (this.dead) return false;
    clearQueue(this);
    this.order = { type: 'move', target: point.clone() };
    return true;
  }

  /** Go to an ore deposit and mine it (vehicles with a harvest ability) */
  harvest(deposit) {
    if (this.dead || !this.harvester || !deposit || deposit.depleted) return false;
    clearQueue(this);
    this.order = { type: 'harvest', deposit };
    return true;
  }

  /** Go to an own unfinished structure and build it (vehicles with the construct ability); a new order */
  build(structure) {
    if (!this.canBuild(structure)) return false;
    clearQueue(this);
    this.order = { type: 'build', structure };
    return true;
  }

  /**
   * Adds a building to the order queue (Shift placement): built after the orders before it, in placement
   * order. Starts at once when the vehicle has nothing to do.
   */
  queueBuild(structure) {
    if (!this.canBuild(structure)) return false;
    return issueOrder(this, { type: 'build', ref: { structure }, run: () => this.build(structure) }, true);
  }

  /** Can this vehicle build that structure (own, unfinished, construct ability)? */
  canBuild(s) {
    return !this.dead && this.canConstruct && Boolean(s) && !s.complete && !s.destroyed && s.team === this.team;
  }

  /** Drive to an own damaged mech, vehicle or finished building and repair it (vehicles with the repair ability) */
  repairUnit(target) {
    if (this.dead || !this.repairer || !canRepairTarget(this, target)) return false;
    clearQueue(this);
    this.order = { type: 'repair', target };
    return true;
  }

  /** Drive to a legs / torso wreck and load it (vehicles with the salvage ability, while there is room) */
  collectSalvage(wreck) {
    if (this.dead || !this.salvager || this.cargoFull || !wreck?.available) return false;
    clearQueue(this);
    this.order = { type: 'salvage', wreck };
    return true;
  }

  /** Drive to an own finished building that takes salvage (rules.salvageResearch.deliverTo) and unload there */
  deliverSalvage(structure) {
    if (!this.#canDeliver(structure)) return false;
    clearQueue(this);
    this.order = { type: 'deliver', structure };
    return true;
  }

  #canDeliver(structure) { return !this.dead && this.cargo.length > 0 && this.#takesSalvage(structure); }

  /** Does that building take salvage from this vehicle (cargo not checked – for orders queued before loading)? */
  canDeliverTo(structure) { return !this.dead && Boolean(this.salvager) && this.#takesSalvage(structure); }

  /** Building ids that take salvage: deliverTo (stock + analysis), then stockOnlyTo (part stock only) */
  #dropOffIds(analysis) {
    const rule = getStats().rules.salvageResearch;
    if (rule !== dropOffCache.rule) { // recomputed only when the rules object changes (no allocation per tick)
      dropOffCache.rule = rule;
      dropOffCache.analysis = rule?.deliverTo ?? [];
      // [R3] the assembly bay shares the part stock with the part factory, so it takes carried parts too
      dropOffCache.stock = [...new Set([...(rule?.stockOnlyTo ?? []), ...SALVAGE_DROP.stockBuildings])];
    }
    return analysis ? dropOffCache.analysis : dropOffCache.stock;
  }

  #takesSalvage(s) {
    return Boolean(s) && s.team === this.team && s.complete && !s.destroyed
      && (this.#dropOffIds(true).includes(s.unitId) || this.#dropOffIds(false).includes(s.unitId));
  }

  /** Nearest own building that takes salvage – a research facility first, else a part factory – or null */
  #nearestDropOff() {
    for (const analysis of DROP_OFF_ORDER) {
      const ids = this.#dropOffIds(analysis) ?? [];
      let best = null;
      let bestDist = Infinity;
      for (const s of this.world?.structures ?? []) {
        if (!ids.includes(s.unitId) || !this.#takesSalvage(s)) continue;
        const d = distanceToBox(this.position, s.obstacle);
        if (d < bestDist) { best = s; bestDist = d; }
      }
      if (best) return best;
    }
    return null;
  }

  // Loads a wreck: it rides on the truck (scaled down), its part stays the same object (HP kept)
  #load(wreck) {
    const part = wreck.part;
    let info;
    // [W8] the pose the part had on the ground (a one-off snapshot at pick-up, not per frame): the world
    // orientation of its object plus, for an arm, the bone pose of its fall animation (the wreck's dispose()
    // stops the mixer, which resets the bones to the upright bind pose)
    part.object.getWorldQuaternion(cargoQuat);
    const bonePose = [];
    if (part.isArm) {
      part.object.traverse((n) => {
        if (n.isBone) bonePose.push({ n, p: n.position.clone(), q: n.quaternion.clone(), s: n.scale.clone() });
      });
    }
    if (part.isArm) { // [R3] torn-off arm (ArmWreck): same cargo, the arm stock key is normalised by PartStock
      if (!wreck.available) return false;
      this.world.takeWreck(wreck);
      info = { path: part.stats.path, set: part.set, kind: part.stats.kind, race: part.stats.race, hp: part.hp, maxHp: part.maxHp, team: this.team };
    } else {
      info = this.world.takeSalvage(wreck);
    }
    if (!info) return false;
    const obj = part.object;
    const scale = obj.scale.clone();
    obj.removeFromParent();
    obj.position.set(0, 0, 0);
    for (const b of bonePose) { b.n.position.copy(b.p); b.n.quaternion.copy(b.q); b.n.scale.copy(b.s); }
    // Keep the lying pose: the ground orientation expressed relative to the vehicle (stays flat on the roof)
    this.getWorldQuaternion(cargoParentQuat).invert();
    obj.quaternion.copy(cargoParentQuat).multiply(cargoQuat);
    obj.scale.copy(scale).multiplyScalar(MISC.cargoScale);
    this.add(obj);
    // [N2] the part's own lowest point rests on top of the vehicle (its origin may be mid-part), whatever the model
    this.updateMatrixWorld(true);
    cargoBox.setFromObject(obj);
    const lowest = cargoBox.isEmpty() ? 0 : cargoBox.min.y - this.position.y;
    obj.position.y = this.bodyHeight * N2_UI.cargoRestFactor - lowest;
    this.cargo.push({ part, info, scale });
    return true;
  }

  // Unloads everything: each part goes to the team's part stock and, wherever it was dropped (research
  // facility, part factory, assembly bay), to the team's loot for salvage analysis (Research.addLoot, which
  // keeps only parts the team cannot make). Analysing itself only needs a research facility (Production).
  #unload(structure) {
    for (const { part, info } of this.cargo) {
      part.object.removeFromParent();
      this.world.economy?.parts?.add(this.team, info.path);
      this.world.research?.addLoot(this.team, info);
    }
    this.cargo = [];
  }

  // Destroyed with cargo: the wrecks fall down again where the truck was
  #dropCargo() {
    if (!this.world) { this.cargo = []; return; }
    for (const { part, scale } of this.cargo) {
      part.object.scale.copy(scale);
      part.wreck = null;
      if (part.isArm) this.world.spawnWreck(part, this); // [R3] an arm falls as a collectable arm wreck again
      else this.world.spawnSalvage(part, this);
    }
    this.cargo = [];
  }

  update(dt) {
    if (this.dead) return;
    this.activity = null;
    if (this.status?.disabled || this.status?.knockedBack) { this.speed = 0; return; }
    advanceQueue(this);
    if (!this.order) this.#autoAssist(dt);
    const moving = this.#act(dt);
    if (!moving) this.speed = 0;
  }

  // ---------- auto assist ([R6], reminder 19) ----------

  // An idle builder truck of a team with world.autoAssist[team] (setAutoAssist command) looks every
  // AUTO_ASSIST.scanInterval s for work within AUTO_ASSIST.radius: first the nearest own unfinished building, else the nearest
  // damaged own vehicle / finished building (mechs only with AUTO_ASSIST.repairMechs). Deterministic: fixed sim step,
  // entity arrays in a fixed order, ties go to the first one. Gives a normal order, so the player's next order replaces it.
  #autoAssist(dt) {
    if (!this.canConstruct || !this.world?.autoAssist?.[this.team]) return;
    this.assistTimer = (this.assistTimer ?? 0) - dt;
    if (this.assistTimer > 0) return;
    this.assistTimer = AUTO_ASSIST.scanInterval;
    const world = this.world;
    let best = null;
    let bestDist = AUTO_ASSIST.radius;
    for (const s of world.structures) {
      if (!this.canBuild(s) || s.removed) continue;
      const d = distanceToBox(this.position, s.obstacle);
      if (d < bestDist) { best = s; bestDist = d; }
    }
    if (best) { this.build(best); return; }
    const ability = this.repairer;
    if (!ability || !world.economy?.canAfford(this.team, ability.costPerHp ?? {})) return;
    const dist = (t) => (t.isStructure ? distanceToBox(this.position, t.obstacle) : Math.hypot(t.position.x - this.position.x, t.position.z - this.position.z));
    const candidates = [...world.structures, ...world.vehicles, ...(AUTO_ASSIST.repairMechs ? world.mechs : [])];
    for (const t of candidates) {
      if (!canRepairTarget(this, t)) continue;
      const d = dist(t);
      if (d < bestDist) { best = t; bestDist = d; }
    }
    if (best) this.repairUnit(best);
  }

  // ---------- internal ----------

  // Handles the current order; returns true while the vehicle moves
  #act(dt) {
    const o = this.order;
    if (!o) return false;
    if (o.type === 'harvest') {
      const d = o.deposit;
      if (d.depleted) { this.order = null; return false; }
      const range = this.harvester.range ?? 0;
      // The deposit core is an inflated pathfinding obstacle, so the path can end farther than the range: a truck
      // that stands at the end of its path reaches further (like salvage), and gives up when even that is not enough
      const slack = o.atGoal ? N1B.harvestReachSlack : 0;
      if (this.#edgeTo(d.position, d.radius) <= range + slack) {
        const want = (this.harvester.ratePerSecond ?? 0) * d.rateFactor * dt;
        const ore = d.mine(this, want);
        if (ore > 0) this.world.economy?.add(this.team, this.harvester.resource, ore);
        this.activity = ore > 0 ? 'harvesting' : 'waiting'; // all slots taken: waits for one
        return false;
      }
      const moving = this.#moveTowards(d.position, dt, false);
      if (moving) { o.atGoal = false; o.atGoalTime = 0; return true; }
      o.atGoal = true;
      o.atGoalTime = (o.atGoalTime ?? 0) + dt;
      if (o.atGoalTime > N1B.harvestGiveUpTime) this.order = null;
      return false;
    }
    if (o.type === 'build') {
      const s = o.structure;
      if (s.complete || s.destroyed || s.removed) { this.order = null; advanceQueue(this); return false; }
      if (distanceToBox(this.position, s.obstacle) - this.radius <= getStats().rules.construction.builderRange) {
        s.addBuilder(this);
        this.activity = 'building';
        // Races whose buildings go on alone (continuesWithoutBuilder) only start one and are free for the next task
        if (continuesAlone(s.race)) {
          this.order = null;
          advanceQueue(this);
        }
        return false;
      }
      return this.#moveTowards(s.position, dt, false);
    }
    if (o.type === 'repair') {
      const goal = vehicleRepairStep(this, dt); // null = repairing (activity) or the order ended
      return goal ? this.#moveTowards(goal, dt, false) : false;
    }
    if (o.type === 'salvage') {
      const w = o.wreck;
      if (!w.available || this.cargoFull) { this.order = null; return false; }
      // A wreck beside a wall / building lies inside the inflated obstacle, so the path ends at the nearest free spot
      // (a grid cell centre), which can be farther than pickupRange: once the truck stands there it reaches further
      const slack = o.atGoal ? MINOR_FIXES.salvageReachSlack : 0;
      if (this.#edgeTo(w.object.position, 0) <= this.salvager.pickupRange + slack) {
        if (w.landed === false) return false; // [R3] an arm wreck still falling: wait for it
        this.order = null;
        // Full: carry it straight to the nearest research facility (stays loaded when there is none); the queued
        // orders wait until it is unloaded
        const dropOff = this.#load(w) && this.cargoFull ? this.#nearestDropOff() : null;
        if (this.#canDeliver(dropOff)) this.order = { type: 'deliver', structure: dropOff };
        return false;
      }
      const moving = this.#moveTowards(w.object.position, dt, false);
      if (moving) { o.atGoal = false; o.atGoalTime = 0; return true; }
      // Standing at the end of the path and still out of reach: give up instead of hanging forever
      o.atGoal = true;
      o.atGoalTime = (o.atGoalTime ?? 0) + dt;
      if (o.atGoalTime > MINOR_FIXES.salvageGiveUpTime) this.order = null;
      return false;
    }
    if (o.type === 'deliver') {
      const s = o.structure;
      if (!this.#takesSalvage(s) || !this.cargo.length) { this.order = null; return false; }
      // A big building (assembly bay) has a wide inflated obstacle: the path ends at the nearest free spot, which can be
      // farther than unloadRange. A truck standing at the end of its path reaches further (same slack as for loading).
      const slack = o.atGoal ? MINOR_FIXES.salvageReachSlack : 0;
      if (distanceToBox(this.position, s.obstacle) - this.radius <= this.salvager.unloadRange + slack) {
        this.order = null;
        this.#unload(s);
        return false;
      }
      const moving = this.#moveTowards(s.position, dt, false);
      if (moving) { o.atGoal = false; o.atGoalTime = 0; return true; }
      o.atGoal = true;
      o.atGoalTime = (o.atGoalTime ?? 0) + dt;
      if (o.atGoalTime > MINOR_FIXES.salvageGiveUpTime) this.order = null; // cannot get closer: the cargo stays loaded
      return false;
    }
    return this.#moveTowards(o.target, dt, true);
  }

  #edgeTo(point, radius) {
    return Math.hypot(point.x - this.position.x, point.z - this.position.z) - radius - this.radius;
  }

  // Steers along the planned path (see Crew.#move); brake = slow down to stop exactly at the goal
  #moveTowards(target, dt, brake) {
    const o = this.order;
    const path = followPath(this, o, target, [], dt);
    const dist = path.remaining;
    if (brake && dist <= ARRIVE_DISTANCE) { this.order = null; return false; }
    const dx = path.point.x - this.position.x;
    const dz = path.point.z - this.position.z;
    const legDist = Math.hypot(dx, dz);
    if (legDist < MOVEMENT.overlapEpsilon) return false;

    const m = this.stats.mobility;
    let diff = Math.atan2(dx, dz) - this.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    if (o.type === 'move' && blockedOnTheWay(o, dist, diff, dt)) { this.order = null; return false; }
    const maxTurn = m.turnSpeed * DEG * dt;
    this.rotation.y += THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);

    const brakeSpeed = brake ? Math.sqrt(2 * m.deceleration * dist) : Infinity;
    const wantSpeed = Math.min(m.moveSpeed, brakeSpeed) * Math.max(0, Math.cos(diff));
    this.speed = this.speed < wantSpeed
      ? Math.min(wantSpeed, this.speed + m.acceleration * dt)
      : Math.max(wantSpeed, this.speed - m.deceleration * dt);

    const step = Math.min(path.final ? legDist : dist, this.speed * dt);
    this.position.x += (dx / legDist) * step;
    this.position.z += (dz / legDist) * step;
    this.snapToGround();
    return true;
  }

  /** Puts the vehicle on the terrain (hover vehicles float a bit above it) */
  snapToGround() {
    if (!this.world) return;
    this.position.y = this.world.heightAt(this.position.x, this.position.z) + (this.hover ? VEHICLE.hoverHeight : 0);
  }

  #createRings() {
    const r = this.radius + VEHICLE.ringMargin;
    const make = (inner, outer, color, opacity) => {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(inner, outer, VEHICLE.ringSegments),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = RINGS.height - (this.hover ? VEHICLE.hoverHeight : 0);
      this.add(ring);
      return ring;
    };
    this.selectionRing = make(r - RINGS.selectionWidth, r, RINGS.activeColor, RINGS.selectionOpacity);
    this.selectionRing.visible = false;
    const t = RINGS.mechTeamRing;
    if (!isLocal(this)) this.teamRing = make(r - t.inset - t.width, r - t.inset, TEAMS[this.team].color, t.opacity);
  }
}

function meshesOf(object) {
  const out = [];
  object?.traverse((o) => { if (o.isMesh) out.push(o); });
  return out;
}
