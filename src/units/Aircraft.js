// Steel Men – aircraft (stats.json → vehicles entry with mobility.movementType AIR.movementType): a CombatVehicle
// that flies. No pathfinding (Movement.followPath goes straight for `airborne` units), flies AIR.flightHeight above
// the terrain, collides only with other aircraft, can be hit only by weapons with "air" in targets (Combat.hitsLayer).
// v1: no fuel, no landing – it hovers in place when idle (docs/notes/n7-air.md).
import { loadStats, getStats } from '../data/Stats.js';
import * as THREE from 'three';
import { AIR, RINGS, VFX, VEHICLE } from '../config.js';
import { CombatVehicle, loadVehicle as loadGroundVehicle } from './CombatVehicle.js';

const DEG = Math.PI / 180;

// Frees the per-model cloned materials (TeamColor marks them userData.unique); shared ones and geometries stay
function disposeUniqueMaterials(model) {
  model.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m?.userData?.unique) m.dispose();
  });
}

/** Is a stats.json vehicles entry an aircraft? */
export const isAircraftId = (id) => getStats().vehicles?.[id]?.mobility?.movementType === AIR.movementType;

/**
 * Drop-in replacement of CombatVehicle.loadVehicle: aircraft get the Aircraft class, every other vehicle the old one.
 * Same signature, so main.js only swaps the import.
 */
export async function loadVehicle(id, race, opts) {
  await loadStats();
  if (!isAircraftId(id)) return loadGroundVehicle(id, race, opts);
  return new Aircraft(id, race, opts).load();
}

export class Aircraft extends CombatVehicle {
  constructor(id, race, opts) {
    super(id, race, opts);
    this.altitude = 0;     // units above the terrain (climbs to AIR.flightHeight after spawning)
    this.groundY = 0;      // terrain height under the aircraft (rings sit there)
  }

  get airborne() { return true; }
  get hover() { return false; }

  update(dt) {
    if (this.dead) return;
    super.update(dt);
    this.#fly(dt);
  }

  /** Called by the movement code after each step and by World.addVehicle: keeps the current altitude over the terrain */
  snapToGround() {
    if (!this.world) return;
    this.groundY = this.world.heightAt(this.position.x, this.position.z);
    this.position.y = this.groundY + this.altitude;
  }

  /**
   * Destroyed: the simulation state is exactly the Vehicle one (dead, removed), only the visual differs – the model
   * moves to a standalone group that falls, tilts and rolls (Effects.custom, render time) and explodes on the ground.
   * Variation derives from the eid, no randomness.
   */
  destroy() {
    const world = this.world;
    const cfg = AIR.crash;
    // With cargo (never the case for aircraft today) the old path drops it exactly as Vehicle.destroy does
    if (this.dead || !world?.effects || !this.model || this.altitude < cfg.minAltitude || this.cargo.length) { super.destroy(); return; }
    this.dead = true;
    this.order = null;
    this.setSelected(false);
    this.removed = true;
    const ghost = new THREE.Group();
    ghost.rotation.order = 'YXZ';
    ghost.position.copy(this.position);
    ghost.rotation.y = this.rotation.y;
    ghost.add(this.model); // keeps the model's local transform, leaves the unit (which World removes)
    // A procedural model falls with the ghost: World must not dispose it with the unit, it is released when the fall ends
    const proc = this.procModel;
    this.procModel = null;
    world.scene.add(ghost);
    const sign = (this.eid ?? 0) & 1 ? 1 : -1;
    const heading = this.rotation.y;
    const dx = Math.sin(heading) * cfg.driftSpeed;
    const dz = Math.cos(heading) * cfg.driftSpeed;
    const fallTime = Math.sqrt((2 * this.altitude) / cfg.gravity);
    const y0 = ghost.position.y;
    let t = 0;
    const fire = world.effects.burn(this, ghost, cfg.maxTime); // [R9] burning while it falls
    world.effects.custom(cfg.maxTime, (dt, item) => {
      t += dt;
      const k = Math.min(1, t / fallTime);
      ghost.position.x += dx * dt;
      ghost.position.z += dz * dt;
      ghost.position.y = y0 - 0.5 * cfg.gravity * t * t;
      ghost.rotation.x = k * cfg.pitchDeg * DEG;
      ghost.rotation.z = sign * k * cfg.rollDeg * DEG;
      if (ghost.position.y <= world.heightAt(ghost.position.x, ghost.position.z)) item.life = 0;
    }, () => {
      // Also runs from Effects.dispose() (it drains every live item), so the ghost and the model are released when the match ends
      world.scene.remove(ghost);
      if (proc) proc.dispose();
      else {
        ghost.remove(this.model);
        disposeUniqueMaterials(this.model);
      }
      const ground = new THREE.Vector3(ghost.position.x, world.heightAt(ghost.position.x, ghost.position.z), ghost.position.z);
      fire.stop();
      world.effects.explodeUnit(this, { position: ground, fallbackSize: VEHICLE.explosionSize * cfg.explosionSize }); // [R9]
    });
  }

  // Climb towards the flight height, follow the terrain, keep the rings on the ground under the aircraft
  #fly(dt) {
    if (this.altitude < AIR.flightHeight) this.altitude = Math.min(AIR.flightHeight, this.altitude + AIR.climbRate * dt);
    this.snapToGround();
    const ringY = RINGS.height - this.altitude;
    if (this.selectionRing) this.selectionRing.position.y = ringY;
    if (this.teamRing) this.teamRing.position.y = ringY;
  }
}
