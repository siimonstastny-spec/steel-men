// Steel Men – drop-in replacement of MechAnimator for a procedural robot (ProcRobot): same public methods that
// ModularMech calls, no clips. Prepared for the integration plan in docs/notes/proc-robot-kit.md – NOT wired anywhere.
// Visual only: reads the mech's speed / yaw, never writes simulation state; update allocates nothing.
// Differences to MechAnimator: attack() returns a pseudo clip name ('proc:<slot>') → Combat.clipHitType gives 'single'
// for every melee blow; jet flight clips (setAirClip / setWalkClip) are ignored; die() only powers the robot down.

const TAU = Math.PI * 2;
const ATTACK_SLOT = { left: 'leftArm', right: 'rightArm' };   // MechAnimator side → arm slot (null = torso)
const ARM_SLOTS = ['leftArm', 'rightArm'];

export class ProcRobotAnimator {
  /**
   * @param {THREE.Object3D} mech   owner (ModularMech): reads .speed, .rotation.y, .parts
   * @param {import('./RobotKit.js').ProcRobot} robot
   */
  constructor(mech, robot) {
    this.mech = mech;
    this.robot = robot;
    this.moving = false;
    this.walkRate = 1;
    this.dead = false;
    this.oneShot = null;        // MechAnimator compatibility (ModularMech.#rebuildAnimation reads these)
    this.attackAction = null;
    this.lastYaw = mech.rotation.y;
  }

  /** Arms changed (lost / mounted): hide the empty slots */
  rebuild() {
    for (let i = 0; i < ARM_SLOTS.length; i++) this.robot.setPartVisible(ARM_SLOTS[i], !!this.mech.parts[ARM_SLOTS[i]]);
    if (this.dead) this.robot.setPowered(false);
  }

  setMoving(moving) { this.moving = moving; }
  setWalkRate(rate) { this.walkRate = rate; }
  setWalkClip() {}
  setAirClip() {}
  setCrewed(crewed) { if (!this.dead) this.robot.setPowered(crewed); }
  hit(direction) { if (!this.dead) this.robot.hit(direction); }

  /** Attack of the weapon's slot; returns a pseudo clip name (see the header) or null */
  attack(set, side = null, duration = null) {
    const slot = ATTACK_SLOT[side] ?? 'torso';
    return this.robot.playAttack(slot, duration ?? undefined) ? `proc:${slot}` : null;
  }

  playOnce() { return false; }

  die() {
    this.dead = true;
    this.robot.setGait(0, 0);
    this.robot.setPowered(false);
  }

  /** Called by ModularMech.update every step: walk drive from the mech's speed and yaw rate, then animate */
  update(dt) {
    const m = this.mech;
    let d = m.rotation.y - this.lastYaw;
    this.lastYaw = m.rotation.y;
    if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
    const turn = dt > 0 ? d / dt : 0;
    this.robot.setGait(this.moving && !this.dead ? m.speed : 0, this.dead ? 0 : turn);
    this.robot.tick(dt);
  }
}
