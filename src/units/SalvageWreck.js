// Steel Mans – legs or torso thrown off a destroyed mech (rules.salvageDrop in stats.json).
// A salvageable wreck stays on the ground as loot: mechs cannot mount it in the field. A future builder
// unit will carry it to the base (the mech assembly building) where it can be researched – see
// rules.salvageResearch and World.takeSalvage. A non-salvageable piece is just charred debris (e.g. a
// torso left hanging after its legs were thrown off) that falls over and sinks like the hulk.
import * as THREE from 'three';
import { WRECK, MECH } from '../config.js';

const _box = new THREE.Box3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _axis = new THREE.Vector3();

export class SalvageWreck {
  /**
   * @param {import('./MechPart.js').MechPart} part  legs or torso, already removed from mech.parts
   * @param {import('../game/World.js').World} world
   * @param {THREE.Object3D} fromMech  destroyed mech
   * @param {object} [opts]  { salvageable = true }
   */
  constructor(part, world, fromMech, { salvageable = true } = {}) {
    this.part = part;
    this.object = part.object;
    this.salvageable = salvageable;
    this.collected = false;
    this.grounded = false;
    this.landed = false;
    this.removed = false;
    this.sinkTimer = MECH.hulkSinkDelay;
    // What a builder delivers to the base (research of enemy-exclusive parts, rules.salvageResearch)
    this.info = {
      path: part.stats.path, set: part.set, kind: part.stats.kind, race: part.stats.race,
      hp: part.hp, maxHp: part.maxHp, team: fromMech.team,
    };

    part.mech = null;
    part.slot = null;
    part.wreck = this;
    part.setHighlighted(false);
    part.setCharred(!salvageable);

    world.scene.attach(this.object); // keeps the world transform
    // Fling away from the hulk and fall over around a random horizontal axis
    fromMech.getWorldPosition(_a);
    this.object.getWorldPosition(_b);
    const dir = _b.sub(_a).setY(0);
    // Seeded random direction: where the loot lands is simulation state
    if (dir.lengthSq() < WRECK.minFlingDirection) dir.set(world.rng.next() - 0.5, 0, world.rng.next() - 0.5);
    dir.normalize();
    this.velocity = dir.clone().multiplyScalar(WRECK.flingSpeed).setY(WRECK.flingUp);
    const tilt = WRECK.salvageTilt[this.info.kind] ?? 0;
    _axis.set(-dir.z, 0, dir.x).normalize(); // falls in the fling direction
    this.startQuat = this.object.quaternion.clone();
    this.endQuat = new THREE.Quaternion().setFromAxisAngle(_axis, tilt).multiply(this.startQuat);
    this.tiltTime = 0;
  }

  /** Can be picked up (by the future builder unit) */
  get available() { return this.salvageable && !this.collected && !this.destroyed && this.landed; }

  /** Shape for weapon hits (world bounding box; cached once the wreck lies still) */
  bounds() {
    if (this.landed && this._bounds) return this._bounds;
    this.object.updateMatrixWorld(true);
    this._bounds = this.part.worldBounds(this._bounds);
    return this._bounds;
  }

  update(dt, world) {
    if (this.collected || this.removed) return;
    const obj = this.object;
    if (this.landed) { if (!this.salvageable) this.#sink(dt, world); return; }

    this.tiltTime = Math.min(WRECK.salvageTiltTime, this.tiltTime + dt);
    obj.quaternion.slerpQuaternions(this.startQuat, this.endQuat, this.tiltTime / WRECK.salvageTiltTime);
    if (!this.grounded) {
      this.velocity.y -= WRECK.gravity * dt;
      obj.position.addScaledVector(this.velocity, dt);
    }
    // The lowest point of the model must not go below the terrain
    obj.updateMatrixWorld(true);
    _box.setFromObject(obj);
    const ground = world.heightAt(obj.position.x, obj.position.z);
    if (this.grounded || _box.min.y <= ground) {
      obj.position.y += ground - _box.min.y;
      this.grounded = true;
      if (this.tiltTime >= WRECK.salvageTiltTime) this.landed = true;
    }
  }

  /** Taken by a carrier – the caller owns the part from now on */
  dispose() { this.collected = true; }

  #sink(dt, world) {
    if ((this.sinkTimer -= dt) > 0) return;
    this.object.position.y -= MECH.sinkSpeed * dt;
    if (this.object.position.y < world.heightAt(this.object.position.x, this.object.position.z) - MECH.sinkDepth) {
      this.removed = true;
    }
  }
}
