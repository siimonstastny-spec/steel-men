// Steel Men – armed vehicle (stats.json → vehicles entry with weapons): a Vehicle that fights like a mech –
// attack, attack-move, guard, patrol and the aggressive / defensive / passive behaviours (shared logic in
// UnitCombat.js), weapons fired through Combat.releaseAttack, experience of its own (vehicles have no crew).
//
// Data (stats.json → vehicles[id]):
//   turret { socket, launchSocket, turnSpeed, models { race: path } } – a separate turret model mounted on the
//     chassis socket; it turns towards the target on its own (turnSpeed °/s). Races without their own turret
//     model use the first one listed.
//   weapons[].mount – 'turret' (aims with the turret, fireArc measured from the turret) or 'hull' (default:
//     fires forward within fireArc, the vehicle turns towards its target).
//   clips { move } – animation clip played while moving (e.g. the alien tank's legs).
// Procedural model (stats.procModel, ProcVehicle.js): the turret is its 'turret' bone, shots leave from model sockets –
//   weapons[].launchSockets[] (burst shot i uses socket i % n) / launchSocket, else vehicle.procLaunch, else 'muzzle'.
import * as THREE from 'three';
import { loadModel, loadGltf } from '../core/AssetLoader.js';
import { loadStats, getStats, unitStats, rankFor, applyExperience } from '../data/Stats.js';
import { VEHICLE } from '../config.js';
import { Vehicle } from './Vehicle.js';
import { isTargetable, areEnemies, angleTo, inWeaponRange, inFireArc, releaseAttack, pickTarget } from '../game/Combat.js';
import * as UnitCombat from './UnitCombat.js';
import { advanceQueue, clearQueue } from './OrderQueue.js';
import { PROC_VEHICLE } from './ProcVehicle.js';

const DEG = Math.PI / 180;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const COMBAT_PROFILE = { yawOffset: 0, chaseLeash: VEHICLE.combat.autoChaseLeash };

/** Creates and loads the right vehicle class for a stats.json vehicle id (armed vehicles fight) */
export async function loadVehicle(id, race, opts) {
  await loadStats();
  const armed = (getStats().vehicles?.[id]?.weapons?.length ?? 0) > 0;
  return (armed ? new CombatVehicle(id, race, opts) : new Vehicle(id, race, opts)).load();
}

export class CombatVehicle extends Vehicle {
  #weaponIndex = 0;
  #aimTarget = null;
  #aimTimer = 0;
  #artillery = null; // first artillery-class weapon (barrel elevation of a procedural model follows the distance)

  constructor(id, race, opts) {
    super(id, race, opts);
    this.behaviour = null;   // 'aggressive' | 'defensive' | 'passive' (BEHAVIOUR.mechModes)
    this.stance = 'ranged';  // engagement range = longest weapon range (UnitCombat / Combat.engagementRange)
    this.weapons = [];       // runtime weapons { part: muzzle holder, stats, def, mount, cooldown }
    this.attackLock = 0;     // s until the current attack ends – one attack at a time
    this.holdTimer = 0;      // s the vehicle must stand still (weapon with stopsToFire)
    this.lastAttacker = null;
    this.xp = 0;
    this.rank = null;        // Stats.rankFor(xp)
    this.turret = null;      // pivot group of the turret model (turns around the vehicle's up axis)
    this.turretYaw = 0;      // rad, relative to the hull
    this.launch = null;      // launch socket of the turret (muzzle)
    this.mixer = null;
    this.moveAction = null;
  }

  async load() {
    await super.load();
    this.behaviour = getStats().rules.combat.defaultBehaviour;
    this.rank = rankFor(this.xp);
    this.stats = this.#resolveStats();
    if (this.procModel) this.#attachProcTurret();
    else {
      await this.#loadTurret();
      await this.#setupAnimation();
    }
    this.#buildWeapons();
    this.refreshTeamColor(); // the turret came after Vehicle.load painted the chassis
    return this;
  }

  get canAttack() { return this.weapons.length > 0; }
  get combatProfile() { return COMBAT_PROFILE; }
  /** Hull weapons need the vehicle to face the target; turret weapons do not */
  get turnsHullToTarget() { return this.weapons.some((w) => w.mount !== 'turret' || !this.turret); }
  get evasion() { return this.rank?.bonuses?.evasion ?? 0; }

  // ---------- experience / research ----------

  /** Experience from damage dealt and kills (Combat.awardXp); a new rank improves the weapons and mobility */
  addXp(amount) {
    if (this.dead || !(amount > 0)) return;
    this.xp += amount;
    const rank = rankFor(this.xp);
    const changed = rank.index !== this.rank?.index;
    this.rank = rank;
    if (changed) { this.stats = this.#resolveStats(); this.#buildWeapons(); }
  }

  applyResearch() {
    if (!this.stats || this.dead) return;
    const ratio = this.maxHp > 0 ? this.hp / this.maxHp : 1;
    this.stats = this.#resolveStats();
    this.maxHp = this.stats.hp;
    this.hp = ratio * this.maxHp;
    this.#buildWeapons();
  }

  // Race + research (Stats.unitStats) + rank bonuses (experience never changes HP or armour)
  #resolveStats() {
    const s = unitStats('vehicles', this.unitId, this.race, this.team);
    applyExperience({ mobility: s.mobility, weapons: s.weapons }, this.rank?.bonuses ?? {});
    return s;
  }

  // Runtime weapons from the current stats; running cooldowns are kept
  #buildWeapons() {
    const old = this.weapons;
    this.weapons = this.stats.weapons.map((stats, i) => {
      const mount = stats.mount === 'turret' && this.turret ? 'turret' : 'hull';
      const w = { stats, def: stats, mount, cooldown: old[i]?.cooldown ?? 0, sockets: this.#procSockets(stats), part: null };
      w.part = { muzzlePoint: (k = 0) => this.#muzzle(w, k) };
      return w;
    });
    this.#artillery = this.weapons.find((w) => w.stats.class === 'artillery') ?? null;
  }

  // Model sockets a procedural weapon fires from (names → Object3D); null for GLB vehicles / unknown names
  #procSockets(stats) {
    const m = this.procModel;
    if (!m) return null;
    const names = stats.launchSockets ?? [stats.launchSocket ?? this.stats.procLaunch ?? PROC_VEHICLE.defaultSocket];
    const out = names.map((n) => m.getSocket(n)).filter(Boolean);
    return out.length ? out : null;
  }

  // Where shots leave: the weapon's model socket (procedural), the turret's launch socket, or the front of the hull at aim height
  #muzzle(w, k = 0) {
    if (w.sockets) {
      const i = k % w.sockets.length;
      const m = this.procModel;
      if (m) { // flash + recoil / bomb bay from the very socket the shot leaves (visual only)
        m.fire(w.sockets[i].name);
        m.dropBomb?.(i);
      }
      return w.sockets[i].getWorldPosition(new THREE.Vector3());
    }
    if (w.mount === 'turret' && this.launch) return this.launch.getWorldPosition(new THREE.Vector3());
    return this.localToWorld(new THREE.Vector3(0, this.aimHeight, this.radius));
  }

  // ---------- orders ----------

  /** Attack order: drive into range, then fight until the target is gone (never gives up) */
  attackUnit(target) {
    if (this.dead || !isTargetable(target) || !areEnemies(this, target) || !this.weapons.length) return false;
    clearQueue(this);
    this.order = { type: 'attack', target, lastKnown: target.position.clone() };
    return true;
  }

  /** Attack-move: drive to a point and fight every enemy met on the way, then carry on */
  attackMoveTo(point) {
    if (this.dead) return false;
    clearQueue(this);
    this.order = { type: 'attackMove', target: point.clone() };
    return true;
  }

  /** Guard an own unit (follow it, fight enemies near it) or a point */
  guard(target) {
    if (this.dead || !target || target === this) return false;
    clearQueue(this);
    this.order = target.isVector3 ? { type: 'guard', point: target.clone() } : { type: 'guard', unit: target };
    return true;
  }

  /** Patrol between the current position and a point, fighting enemies met on the way */
  patrol(point) {
    if (this.dead) return false;
    clearQueue(this);
    this.order = { type: 'patrol', points: [this.position.clone(), point.clone()], index: 1 };
    return true;
  }

  setBehaviour(mode) { return UnitCombat.setBehaviour(this, mode); }

  // ---------- update ----------

  update(dt) {
    if (this.dead) return;
    this.attackLock = Math.max(0, this.attackLock - dt);
    this.holdTimer = Math.max(0, this.holdTimer - dt);
    for (const w of this.weapons) w.cooldown = Math.max(0, w.cooldown - dt);
    if (this.status?.disabled || this.status?.knockedBack) { this.speed = 0; this.activity = null; this.#animate(false, dt); return; }
    advanceQueue(this);
    UnitCombat.updateTarget(this);
    let moving;
    if (!this.order || UnitCombat.COMBAT_ORDERS.includes(this.order.type)) {
      this.activity = null;
      moving = UnitCombat.moveByOrder(this, dt);
      if (!moving) this.speed = 0;
    } else {
      super.stepOrders(dt); // other orders of the base vehicle (e.g. being sent to a repair)
      moving = this.speed > 0;
    }
    this.#aimTurret(dt);
    this.#fire(moving);
    this.#animate(moving, dt);
  }

  // ---------- procedural model ----------

  // The turret is the model's 'turret' bone (rotation.y = yaw, the aiming code stays the same); no bone → hull weapons
  #attachProcTurret() {
    const bone = this.procModel.getBone('turret');
    if (!bone) return;
    this.turret = bone;
    this.launch = this.procModel.getSocket(this.stats.procLaunch ?? PROC_VEHICLE.defaultSocket);
  }

  // Barrel elevation towards the target (artillery: by distance); the model clamps it to its own limits
  #pitchBarrel(target) {
    const m = this.procModel;
    if (!m?.barrelBone) return;
    let pitch = 0;
    if (target) {
      const dx = target.position.x - this.position.x;
      const dz = target.position.z - this.position.z;
      const dist = Math.hypot(dx, dz);
      const arty = this.#artillery;
      if (arty) pitch = (m.pitchLimits?.[1] ?? 0) * Math.min(1, dist / (arty.stats.range || 1)) * PROC_VEHICLE.artilleryPitchRange;
      else pitch = Math.atan2(target.position.y + (target.aimHeight ?? 0) - this.position.y - this.aimHeight, dist);
    }
    m.setBarrelPitch(pitch);
  }

  // ---------- turret ----------

  async #loadTurret() {
    const cfg = this.stats.turret;
    if (!cfg?.models) return;
    const key = cfg.models[this.race] ? this.race : Object.keys(cfg.models)[0];
    const socket = this.model.getObjectByName(cfg.socket);
    if (!key || !socket) { console.warn(`[CombatVehicle] ${this.unitId}: no turret model / socket ${cfg.socket}`); return; }
    const obj = await loadModel(cfg.models[key]);
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    socket.add(obj);
    this.updateMatrixWorld(true);
    // The turret turns around a vertical axis through its own centre (sockets sit off-centre in the models)
    const box = new THREE.Box3().setFromObject(obj);
    const centre = box.getCenter(new THREE.Vector3());
    const pivot = new THREE.Group();
    this.model.add(pivot);
    pivot.position.copy(this.model.worldToLocal(centre.setY(box.min.y)));
    pivot.updateMatrixWorld(true);
    pivot.attach(obj);
    this.turret = pivot;
    this.launch = obj.getObjectByName(cfg.launchSocket) ?? null;
    // Body height now includes the turret (3D splash / pellet hits, aim point)
    const full = new THREE.Box3().setFromObject(this.model);
    this.bodyHeight = full.max.y - this.position.y;
    this.aimHeight = this.bodyHeight * VEHICLE.aimHeightFactor;
  }

  // The turret follows the attack target, else a target of opportunity in range, else turns back forward
  #aimTurret(dt) {
    if (!this.turret) return;
    const target = this.#turretTarget(dt);
    const want = target ? angleTo(this, target.position) : 0;
    const diff = wrapAngle(want - this.turretYaw);
    const max = (this.stats.turret?.turnSpeed ?? this.stats.procTurretTurnSpeed ?? PROC_VEHICLE.turretTurnSpeed) * DEG * dt;
    this.turretYaw = wrapAngle(this.turretYaw + THREE.MathUtils.clamp(diff, -max, max));
    this.turret.rotation.y = this.turretYaw;
    if (this.procModel) { this.procModel.turretYaw = this.turretYaw; this.#pitchBarrel(target); }
  }

  #turretTarget(dt) {
    const o = this.order;
    if (o?.type === 'attack' && isTargetable(o.target)) return o.target;
    this.#aimTimer -= dt;
    const list = this.#fillTurretList();
    const valid = isTargetable(this.#aimTarget) && this.#anyCanFireAt(list, this.#aimTarget, false);
    if (!valid || this.#aimTimer <= 0) {
      this.#aimTimer = VEHICLE.combat.turretRetargetInterval;
      this.#aimTarget = UnitCombat.firesAtWill(this) ? this.#nearestFor(list, false) : null;
    }
    return this.#aimTarget;
  }

  // Turret weapons into the recycled list (no array per tick)
  #fillTurretList() {
    const list = this.#turretList;
    list.length = 0;
    for (let i = 0; i < this.weapons.length; i++) if (this.weapons[i].mount === 'turret') list.push(this.weapons[i]);
    return list;
  }

  #anyCanFireAt(weapons, target, arc) {
    for (let i = 0; i < weapons.length; i++) if (this.#canFireAt(weapons[i], target, arc)) return true;
    return false;
  }

  // Nearest enemy any of the weapons could shoot at (arc ignored when the turret can still turn to it)
  #nearestFor(weapons, arc) {
    let range = 0;
    for (let i = 0; i < weapons.length; i++) range = Math.max(range, weapons[i].stats.range);
    if (!range) return null;
    this.#pickWeapons = weapons;
    this.#pickArc = arc;
    return pickTarget(this, range, this.#pickAny);
  }

  // Predicates created once (pickTarget takes a callback; their inputs are the #pick* fields)
  #pickWeapons = null;
  #pickArc = false;
  #pickWeapon = null;
  #pickAny = (u) => this.#anyCanFireAt(this.#pickWeapons, u, this.#pickArc);
  #pickOne = (u) => this.#canFireAt(this.#pickWeapon, u);
  #ready = [];
  #turretList = [];

  // ---------- firing ----------

  #inArc(w, target) {
    if (w.mount !== 'turret') return inFireArc(this, w.stats, target);
    return Math.abs(wrapAngle(angleTo(this, target.position) - this.turretYaw)) <= (w.stats.fireArc * DEG) / 2;
  }

  #canFireAt(w, target, arc = true) {
    return isTargetable(target) && areEnemies(this, target) && inWeaponRange(this, w.stats, target)
      && (!arc || this.#inArc(w, target));
  }

  /**
   * Fires one ready weapon (round robin), like ModularMech: the attack target first, else (when the behaviour
   * allows) a target of opportunity; stopsToFire weapons halt the vehicle and never interrupt a move order.
   */
  #fire() {
    if (this.attackLock > 0) return;
    const ready = this.#ready;
    ready.length = 0;
    for (let i = 0; i < this.weapons.length; i++) if (this.weapons[i].cooldown <= 0) ready.push(this.weapons[i]);
    if (!ready.length) return;
    const primary = this.order?.type === 'attack' ? this.order.target : null;
    const moveOrder = this.order?.type === 'move';
    for (let k = 0; k < ready.length; k++) {
      const w = ready[(this.#weaponIndex + k) % ready.length];
      const s = w.stats;
      if (moveOrder && s.stopsToFire) continue;
      let target = primary && this.#canFireAt(w, primary) ? primary : null;
      if (!target && !s.stopsToFire && UnitCombat.firesAtWill(this)) {
        this.#pickWeapon = w;
        target = pickTarget(this, s.range, this.#pickOne);
      }
      if (!target) continue;
      this.#weaponIndex += k + 1;
      this.#fireWeapon(w, target);
      return;
    }
  }

  #fireWeapon(w, target) {
    const s = w.stats;
    this.attackLock = s.attackTime;
    w.cooldown = s.attackTime + s.cooldown;
    if (s.stopsToFire) { this.holdTimer = s.attackTime; this.speed = 0; }
    this.world.schedule(s.attackTime * s.hitAt, () => {
      if (this.dead) return;
      releaseAttack(this.world, this, w, target);
    });
  }

  // ---------- animation ----------

  async #setupAnimation() {
    const name = this.stats.clips?.move;
    if (!name) return;
    const animations = (await loadGltf(this.stats.model)).animations;
    // [W8] a clip is also looked up by its position when the name differs (renamed export); a miss is reported
    const clip = animations.find((a) => a.name === name) ?? (animations.length === 1 ? animations[0] : null);
    if (!clip) {
      console.warn(`[CombatVehicle] ${this.unitId}: clip "${name}" not found, model has: ${animations.map((a) => a.name).join(', ') || 'none'}`);
      return;
    }
    const missing = clip.tracks.filter((tr) => !THREE.PropertyBinding.findNode(this.model, THREE.PropertyBinding.parseTrackName(tr.name).nodeName));
    if (missing.length) console.warn(`[CombatVehicle] ${this.unitId}: ${missing.length} of ${clip.tracks.length} clip tracks have no node`, missing[0].name);
    this.mixer = new THREE.AnimationMixer(this.model);
    this.moveAction = this.mixer.clipAction(clip);
  }

  // Move clip while driving / walking, at a rate following the speed; stopped otherwise
  #animate(moving, dt) {
    this.tickProc(dt); // procedural model (no-op for GLB vehicles)
    if (!this.mixer) return;
    const a = this.moveAction;
    if (moving) {
      if (!a.isRunning()) a.play();
      a.paused = false;
      a.timeScale = Math.max(VEHICLE.combat.minMoveAnimRate, this.speed / this.stats.mobility.moveSpeed);
    } else if (a.isRunning()) {
      a.paused = true;
    }
    this.mixer.update(dt);
  }
}
