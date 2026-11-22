// Steel Mans – armed building (stats.json → structures entry with weapons): point defense, turrets on wall posts.
// Always aggressive: once finished it fires at the nearest enemy in range that its team can see (fog of war via
// World.nearestEnemy), weapons through Combat.releaseAttack like mechs and vehicles. No experience, no orders.
//
// Data (stats.json → structures[id]):
//   weapons[]       usual weapon fields; fireArc is measured from the turret when the building turns (turnSpeed)
//   turnSpeed       °/s – the whole model turns towards the target (turret on a wall post); 0 / missing = fixed,
//                   fires all around (fireArc ignored)
//   launchSockets[] model nodes the shots leave from (burst shots alternate between them)
//   mountOn         structure id it stands on (a wall post – src/game/Walls.js places it on the post's socket)
import * as THREE from 'three';
import { unitStats } from '../data/Stats.js';
import { WALL, R2 } from '../config.js';
import { Structure } from './Structure.js';
import { registerStructureClass } from './structureClasses.js';
import { isTargetable, areEnemies, inWeaponRange, releaseAttack, pickTarget } from '../game/Combat.js';

const DEG = Math.PI / 180;
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class DefenseStructure extends Structure {
  #target = null;
  #retarget = 0;
  #weaponIndex = 0;

  constructor(id, race, opts) {
    super(id, race, opts);
    this.weapons = [];      // runtime weapons { stats, def, cooldown, part: { muzzlePoint(i) } }
    this.attackLock = 0;    // s until the current attack ends – one attack at a time
    this.aimYaw = 0;        // rad, turret relative to the building
    this.sockets = [];      // launch socket nodes
    this.post = null;       // wall post it stands on (Walls.js)
    this.lastAttacker = null;
    this.idleOffset = 0;    // rad, VISUAL only: idle look-around added to aimYaw (never read by the simulation)
    this.idleTime = 0;
  }

  async load() {
    await super.load();
    // A turning model turns around its own origin (the turret's pivot), not around its box centre
    if (this.turns) this.model.position.set(0, 0, 0);
    this.sockets = (this.stats.launchSockets ?? []).map((n) => this.model.getObjectByName(n)).filter(Boolean);
    this.#buildWeapons();
    return this;
  }

  get turns() { return (this.stats?.turnSpeed ?? 0) > 0; }
  get canAttack() { return this.weapons.length > 0; }

  /** Turrets do not block pathfinding on their own – the post under them does */
  get navShapes() { return this.post ? [] : undefined; }

  /** Builder / repair distance: the post's box for a turret */
  get obstacle() { return this.post && !this.post.removed ? { ...this.post.obstacle, owner: this } : super.obstacle; }

  applyResearch() {
    super.applyResearch();
    if (this.stats && !this.dead) this.#buildWeapons();
  }

  #buildWeapons() {
    const old = this.weapons;
    this.stats = unitStats('structures', this.unitId, this.race, this.team);
    this.weapons = this.stats.weapons.map((stats, i) => ({
      stats, def: stats, cooldown: old[i]?.cooldown ?? 0, part: { muzzlePoint: (k = 0) => this.#muzzle(k) },
    }));
  }

  #muzzle(k) {
    const socket = this.sockets.length ? this.sockets[k % this.sockets.length] : null;
    if (socket) return socket.getWorldPosition(new THREE.Vector3());
    return new THREE.Vector3(this.position.x, this.position.y + this.aimHeight, this.position.z);
  }

  update(dt) {
    super.update(dt);
    if (this.dead || !this.complete || !this.world) return;
    this.attackLock = Math.max(0, this.attackLock - dt);
    for (const w of this.weapons) w.cooldown = Math.max(0, w.cooldown - dt);
    // [D1] towers draw their full energy all the time; with low energy (powered false, Economy.update) they are off
    this.world.economy?.drawPower(this, dt, true);
    if (this.powered === false) { this.#target = null; return; }
    const target = this.#pickTarget(dt);
    if (this.turns) this.#aim(target, dt);
    this.#idleLook(target, dt);
    if (target) this.#fire(target);
  }

  // Idle look-around: without a target the model slowly sweeps left and right; with a target the offset is wound
  // back to 0 at the turret's turn speed and the usual aiming (aimYaw) applies. Only holder.rotation changes –
  // aimYaw, fire arcs and targeting are untouched.
  #idleLook(target, dt) {
    if (!this.holder) return;
    const cfg = R2.idleLook;
    let want = 0;
    let maxStep;
    if (target) {
      maxStep = (this.turns ? this.stats.turnSpeed : cfg.speedDeg * 4) * DEG * dt;
    } else {
      this.idleTime += dt;
      const phase = (this.eid ?? 0) * 2.4; // buildings do not sweep in sync
      want = Math.sin((this.idleTime / cfg.periodSeconds) * Math.PI * 2 + phase) * cfg.amplitudeDeg * DEG;
      maxStep = cfg.speedDeg * DEG * dt;
    }
    this.idleOffset += THREE.MathUtils.clamp(want - this.idleOffset, -maxStep, maxStep);
    this.holder.rotation.y = wrapAngle((this.turns ? this.aimYaw : 0) + this.idleOffset);
  }

  // Keeps the current target while it stays in range and visible, else the nearest enemy (checked periodically)
  #pickTarget(dt) {
    this.#retarget -= dt;
    const valid = this.#canHit(this.#target);
    if (!valid || this.#retarget <= 0) {
      this.#retarget = WALL.turretRetargetInterval;
      if (!valid) {
        const range = Math.max(0, ...this.weapons.map((w) => w.stats.range));
        this.#target = range ? pickTarget(this, range, (u) => this.#canHit(u)) : null;
      }
    }
    return this.#target;
  }

  #canHit(u) {
    return isTargetable(u) && areEnemies(this, u) && this.world.canSee(this, u)
      && this.weapons.some((w) => inWeaponRange(this, w.stats, u));
  }

  // Building-relative angle to a unit
  #angleTo(u) {
    const want = Math.atan2(u.position.x - this.position.x, u.position.z - this.position.z);
    return wrapAngle(want - this.rotation.y);
  }

  #aim(target, dt) {
    if (!target) return;
    const diff = wrapAngle(this.#angleTo(target) - this.aimYaw);
    const max = this.stats.turnSpeed * DEG * dt;
    this.aimYaw = wrapAngle(this.aimYaw + THREE.MathUtils.clamp(diff, -max, max));
    this.holder.rotation.y = this.aimYaw;
  }

  #inArc(w, target) {
    if (!this.turns) return true;
    return Math.abs(wrapAngle(this.#angleTo(target) - this.aimYaw)) <= (w.stats.fireArc * DEG) / 2;
  }

  #fire(target) {
    if (this.attackLock > 0) return;
    const ready = this.weapons.filter((w) => w.cooldown <= 0 && inWeaponRange(this, w.stats, target) && this.#inArc(w, target));
    if (!ready.length) return;
    const w = ready[this.#weaponIndex++ % ready.length];
    const s = w.stats;
    this.attackLock = s.attackTime;
    w.cooldown = s.attackTime + s.cooldown;
    this.world.schedule(s.attackTime * s.hitAt, () => {
      if (!this.dead) releaseAttack(this.world, this, w, target);
    });
  }
}

registerStructureClass((stats) => ((stats.weapons?.length ?? 0) > 0 ? DefenseStructure : null));
