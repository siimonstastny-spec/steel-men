// Steel Men – glue between vehicles (Vehicle / CombatVehicle / Aircraft) and the procedural unit models
// (src/procedural/units, docs/notes/proc-unit-kit.md, proc-units-wire.md). Visual only: nothing here is read by the simulation.
//
// Data (stats.json → vehicles[id]):
//   procModel   id in the procedural unit registry – used instead of `model` (GLB stays the fallback when the procedural
//               models are off or the id is unknown)
//   procLaunch  socket the shots leave from (default 'muzzle'); weapons[].launchSocket / launchSockets[] override it
//   deploys     true → the model anchors (setDeployed) while the vehicle stands still (artillery)
//   abilities   { type: 'cloak', whileMoving } → setCloaked while the vehicle does not attack (visual shimmer)
import * as THREE from 'three';
import { isLocal } from '../core/LocalPlayer.js';
import { proceduralEnabled, loadBuildingStyles } from '../procedural/registry.js';
import { createProceduralUnit, hasProceduralUnit } from '../procedural/units/UnitKit.js';
import '../procedural/units/index.js'; // registers every procedural unit model (side effects only)

export const PROC_VEHICLE = {
  defaultSocket: 'muzzle',
  turretTurnSpeed: 120,  // deg/s – turret turn speed of a procedural vehicle without stats.turret (override: stats.procTurretTurnSpeed)
  aimSocket: 'aim',
  cloakTime: 1.2,        // s from visible to fully cloaked (and back)
  deployTime: 1.4,       // s to anchor / unanchor
  deployedAt: 0.95,      // progress from which the status lamp shows 'deployed'
  moveEpsilon: 0.2,      // units/s – below this the vehicle counts as standing
  artilleryPitchRange: 1, // barrel elevation of an artillery piece = limit × (distance / range) × this
};

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const _v = new THREE.Vector3();

/** Procedural model for a resolved vehicle stats entry, or null (no procModel, models off, unknown id → GLB is used) */
export async function createVehicleProc(stats, race, teamColor) {
  const id = stats.procModel;
  if (!id || !proceduralEnabled() || !hasProceduralUnit(id)) return null;
  await loadBuildingStyles();
  const model = createProceduralUnit(id, race, teamColor);
  model?.enableBatching();
  return model;
}

/** World-space → vehicle-local height of a model socket (one-off, load time) */
export function socketHeight(vehicle, model, name) {
  const s = model.getSocket(name);
  if (!s) return null;
  vehicle.updateMatrixWorld(true);
  return vehicle.worldToLocal(s.getWorldPosition(_v)).y;
}

/** Per-vehicle driver of the visual state of a procedural model (motion, status lamp, cloak, anchoring) */
export class ProcDriver {
  constructor(vehicle) {
    this.v = vehicle;
    this.lastYaw = vehicle.rotation.y;
    this.cloakProgress = 0;
    this.deployProgress = 0;
    this.statusName = '';
    this.air = Boolean(vehicle.airborne);
    const stats = vehicle.stats;
    this.deploys = stats.deploys === true;
    const cloak = stats.abilities?.find((a) => a.type === 'cloak') ?? null;
    this.cloaks = Boolean(cloak);
    this.cloakWhileMoving = cloak?.whileMoving === true;
    this.moveSpeed = stats.mobility?.moveSpeed || 1;
  }

  /** Called once per simulation step after the vehicle logic; dt in seconds */
  update(dt) {
    const v = this.v;
    const m = v.procModel;
    if (!m?.shared) return;
    const yaw = v.rotation.y;
    const turn = dt > 0 ? wrap(yaw - this.lastYaw) / dt : 0;
    this.lastYaw = yaw;
    const speed = v.dead ? 0 : v.speed;
    const standing = speed < PROC_VEHICLE.moveEpsilon;
    m.setMotion(speed, turn);
    if (this.air) m.setThrottle(Math.min(1, speed / this.moveSpeed));

    const attacking = (v.attackLock ?? 0) > 0;
    if (this.cloaks) {
      const want = !attacking && (this.cloakWhileMoving || standing) ? 1 : 0;
      const step = dt / PROC_VEHICLE.cloakTime;
      this.cloakProgress = want > this.cloakProgress ? Math.min(want, this.cloakProgress + step) : Math.max(want, this.cloakProgress - step);
      m.setCloaked(this.cloakProgress);
    }
    if (this.deploys) {
      const want = standing && !v.dead ? 1 : 0;
      const step = dt / PROC_VEHICLE.deployTime;
      this.deployProgress = want > this.deployProgress ? Math.min(want, this.deployProgress + step) : Math.max(want, this.deployProgress - step);
      m.setDeployed(this.deployProgress);
    }
    this.#lamp(m, standing, attacking);
    m.tick(dt);
  }

  // Status lamp: only the local player's own units show their state
  #lamp(m, standing, attacking) {
    const v = this.v;
    let name = 'none';
    if (isLocal(v)) {
      if (v.status?.disabled) name = 'disabled';
      else if (attacking) name = 'attack';
      else if (this.deploys && this.deployProgress >= PROC_VEHICLE.deployedAt) name = 'deployed';
      else if (this.cloaks && this.cloakProgress >= 1) name = 'cloaked';
      else name = standing ? 'idle' : 'move';
    }
    if (name !== this.statusName) { this.statusName = name; m.setStatus(name); }
  }
}
