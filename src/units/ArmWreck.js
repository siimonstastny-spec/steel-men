// Steel Mans – utržená ruka ležící na zemi (vrak), kterou lze sebrat – SIT
// Při pádu hraje animaci Amputated*ArmSkeleton (ruka se zaškube a lehne si).
import * as THREE from 'three';
import { bindPart, retargetClip } from '../anim/AnimLibrary.js';
import { WRECK } from '../config.js';

const UP = new THREE.Vector3(0, 1, 0);
const _box = new THREE.Box3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class ArmWreck {
  /**
   * @param {import('./MechPart.js').MechPart} part  utržená ruka
   * @param {import('../game/World.js').World} world
   * @param {THREE.Object3D} fromMech  robot, ze kterého ruka upadla
   * @param {object} lib               knihovna animací (AnimLibrary)
   */
  constructor(part, world, fromMech, lib) {
    this.part = part;
    this.object = part.object;
    this.collected = false;
    this.grounded = false;
    this.landed = false;
    this.animDone = !lib;

    const slot = part.slot ?? part.key; // strana, ze které ruka upadla
    part.mech = null;
    part.slot = null;
    part.wreck = this;
    part.setHighlighted(false);

    // Detach z trupu do hlavní scény se zachováním světové pozice (a zrcadlení)
    world.scene.attach(this.object);
    const mirrored = this.object.scale.x < 0;
    // Ponecháme jen natočení robota, polohu „vleže“ určí animace
    this.object.quaternion.setFromAxisAngle(UP, fromMech.rotation.y);

    // Směr odskoku: od středu robota k ruce (vodorovně)
    fromMech.getWorldPosition(_a);
    this.object.getWorldPosition(_b);
    const dir = _b.sub(_a).setY(0);
    // Seeded random direction: where the wreck lands is simulation state (it can be picked up / shot)
    if (dir.lengthSq() < WRECK.minFlingDirection) dir.set(world.rng.next() - 0.5, 0, world.rng.next() - 0.5);
    dir.normalize();
    this.velocity = dir.multiplyScalar(WRECK.flingSpeed).add(new THREE.Vector3(0, WRECK.flingUp, 0));

    // Animace utržené ruky
    this.mixer = new THREE.AnimationMixer(this.object);
    const src = lib?.amputated[slot];
    if (src) {
      const clip = retargetClip(src, bindPart(this.object, slot, lib, mirrored), lib);
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.play();
      this.mixer.addEventListener('finished', () => { this.animDone = true; });
    } else {
      this.animDone = true;
    }
  }

  /** Lze vrak zadat jako cíl sběru (i když ještě padá) */
  get available() { return !this.collected && !this.destroyed; }

  /** Shape for weapon hits (world bounding box; cached once the wreck lies still) */
  bounds() {
    if (this.landed && this._bounds) return this._bounds;
    this.object.updateMatrixWorld(true);
    this._bounds = this.part.worldBounds(this._bounds);
    return this._bounds;
  }

  update(dt, world) {
    if (this.landed || this.collected) return;
    const obj = this.object;
    this.mixer.update(dt);

    if (!this.grounded) {
      this.velocity.y -= WRECK.gravity * dt;
      obj.position.addScaledVector(this.velocity, dt);
    }

    // Dopad: nejnižší bod modelu nesmí jít pod terén (póza se během animace mění)
    obj.updateMatrixWorld(true);
    _box.setFromObject(obj);
    const ground = world.heightAt(obj.position.x, obj.position.z);
    if (this.grounded || _box.min.y <= ground) {
      obj.position.y += ground - _box.min.y;
      this.grounded = true;
      if (this.animDone) this.landed = true;
    }
  }

  /** Vrak sebrán – uvolní animace */
  dispose() {
    this.collected = true;
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.object);
  }
}
