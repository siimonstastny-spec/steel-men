// Steel Men – animator of a mech drawn as a procedural robot (ProcRobot) – [proc-robot], docs/notes/proc-robot-wire.md.
// Wraps the mech's MechAnimator (`inner`) and forwards EVERY call to it, returning exactly what it returns: the GLB
// clips keep driving the hidden GLB body (muzzle points, Combat.clipHitType of the clip name), so the simulation is the
// same whether the procedural robot is drawn or not. On top of that it drives the robot (walk from the mech's speed /
// yaw rate, attacks, hit jolt, power-down, turret aim) – visual only, never writes simulation state, update allocates
// nothing. The robot may change (part swap → new combination) or vanish (GLB drawn): setRobot(robot | null).
// Without `inner` it works stand-alone as before (attack() returns a pseudo clip name 'proc:<slot>').

const TAU = Math.PI * 2;
const ATTACK_SLOT = { left: 'leftArm', right: 'rightArm' };   // MechAnimator side → arm slot (null = torso)
const ARM_SLOTS = ['leftArm', 'rightArm'];
const wrapAngle = (a) => (a > Math.PI ? a - TAU : a < -Math.PI ? a + TAU : a);

// [A16] Hop-run clip (speed legs with the 'hopRun' ability: HighSpeed / SprintLegs). DISPLAY ONLY: the simulation moves the mech
// along the hop arc (mech.hopping, position.y above the terrain); this overlay only poses the legs on top of the walk cycle.
// Rising: a leap (leading leg forward and stretched, trailing leg back and tucked); falling: both legs reach forward for the
// landing. Angles in rad (hip − = forward, knee + = bent), weights ease with `blend` (1/s).
const HOP_POSE = {
  blend: 10, minWeight: 0.01, lean: 0.2, toe: 0.45,
  rise: { frontHip: -0.9, frontKnee: 0.3, backHip: 0.6, backKnee: 1.05 },
  fall: { hip: -0.6, knee: 0.8 },
  forcePeriod: 1.2, forceRiseShare: 0.5, forceHeight: 5,   // forceHop (console test): cycle length s and its rising share
};
const lerpAngle = (a, b, k) => a + (b - a) * k;

/**
 * Poses the robot's legs / chest for a hop at weight k (0 = walk cycle untouched … 1 = full pose). Call after robot.tick().
 * Legs without chains (never) are skipped. Allocation free.
 */
export function applyHopPose(robot, k, rising) {
  const chains = robot?.chains;
  if (!chains || k <= 0) return;
  const P = HOP_POSE;
  for (let i = 0; i < chains.length; i++) {
    const c = chains[i];
    const front = i === 0;   // chains[0] = phase 0 leg: leads the leap
    const hip = rising ? (front ? P.rise.frontHip : P.rise.backHip) : P.fall.hip;
    const knee = rising ? (front ? P.rise.frontKnee : P.rise.backKnee) : P.fall.knee;
    c.thigh.rotation.x = lerpAngle(c.thigh.rotation.x, hip, k);
    c.shin.rotation.x = lerpAngle(c.shin.rotation.x, knee, k);
    c.foot.rotation.x = lerpAngle(c.foot.rotation.x, -(hip + knee) + P.toe, k);
  }
  if (robot.chest && !robot.clipDriven) robot.chest.rotation.x += P.lean * k;   // #body rewrites the chest every tick (no accumulation)
}

export class ProcRobotAnimator {
  /**
   * @param {THREE.Object3D} mech   owner (ModularMech): reads .speed, .rotation.y, .parts, .order, .aimHeight
   * @param {import('./RobotKit.js').ProcRobot|null} robot
   * @param {import('../../anim/MechAnimator.js').MechAnimator|null} [inner]  GLB animator every call is forwarded to
   */
  constructor(mech, robot, inner = null) {
    this.mech = mech;
    this.robot = null;
    this.inner = inner;
    this.moving = false;
    this.walkRate = 1;
    this.crewed = false;
    this.isDead = false;
    this.ownOneShot = null;     // stand-alone MechAnimator compatibility (ModularMech.#rebuildAnimation)
    this.ownAttackAction = null;
    this.lastYaw = mech.rotation.y;
    this.hopW = 0;              // [A16] weight of the hop-run pose (display only)
    this.hopLift = 0;           // last height above the terrain (rising / falling)
    this.forceHop = false;      // [A16] console test: `mech.animator.forceHop = true` plays the hop pose without a rift
    this.forceT = 0;
    this.setRobot(robot);
  }

  // MechAnimator state ModularMech reads / writes (#rebuildAnimation) – the inner animator's when there is one
  get dead() { return this.inner ? this.inner.dead : this.isDead; }
  get oneShot() { return this.inner ? this.inner.oneShot : this.ownOneShot; }
  set oneShot(v) { if (this.inner) this.inner.oneShot = v; else this.ownOneShot = v; }
  get attackAction() { return this.inner ? this.inner.attackAction : this.ownAttackAction; }
  set attackAction(v) { if (this.inner) this.inner.attackAction = v; else this.ownAttackAction = v; }

  /** New robot (part combination changed) or null (GLB drawn): it takes over the current crew / death state */
  setRobot(robot) {
    this.robot = robot;
    if (!robot) return;
    this.#arms();
    robot.setPowered(this.crewed && !this.isDead);
    if (this.isDead) robot.setGait(0, 0);
  }

  /** Arms changed (lost / mounted): hide the empty slots */
  rebuild() {
    this.inner?.rebuild();
    this.#arms();
    if (this.isDead) this.robot?.setPowered(false);
  }

  setMoving(moving) { this.inner?.setMoving(moving); this.moving = moving; }
  setWalkRate(rate) { this.inner?.setWalkRate(rate); this.walkRate = rate; }
  setWalkClip(name) { this.inner?.setWalkClip(name); }
  setAirClip(name, opts) { this.inner?.setAirClip(name, opts); }
  setCrewed(crewed) {
    this.inner?.setCrewed(crewed);
    this.crewed = crewed;
    if (!this.isDead) this.robot?.setPowered(crewed);
  }
  hit(direction) {
    this.inner?.hit(direction);
    if (!this.isDead) this.robot?.hit(direction);
  }

  /**
   * Attack of the weapon's side. With `inner`: returns its clip name (simulation reads it – Combat.clipHitType) and
   * leaves the robot to visualAttack(); stand-alone: plays the robot and returns 'proc:<slot>' or null.
   */
  attack(set, side = null, duration = null) {
    if (this.inner) return this.inner.attack(set, side, duration);
    const slot = ATTACK_SLOT[side] ?? 'torso';
    return this.robot?.playAttack(slot, duration ?? undefined) ? `proc:${slot}` : null;
  }

  /**
   * Robot attack animation of a weapon's slot (ModularMech.#fireWeapon) – visual only.
   * @param {string} slot  'leftArm' | 'rightArm' | 'torso' (others have no attack animation)
   * @param {number} duration  weapon attackTime (s)
   * @param {number} [shots]   weapon burst – shots of the turret / gun arm (a fist ignores it)
   */
  visualAttack(slot, duration, shots = 0) {
    if (this.isDead || !this.robot) return;
    this.robot.playAttack(slot, duration, shots);
  }

  playOnce(name, fade, duration) { return this.inner ? this.inner.playOnce(name, fade, duration) : false; }

  die() {
    this.inner?.die();
    this.isDead = true;
    this.robot?.setGait(0, 0);
    this.robot?.setPowered(false);
  }

  /** Called by ModularMech.update every step: GLB clips, then the robot's walk drive, turret aim and animation */
  update(dt) {
    this.inner?.update(dt);
    const m = this.mech;
    const d = wrapAngle(m.rotation.y - this.lastYaw);
    this.lastYaw = m.rotation.y;
    const r = this.robot;
    if (!r) { m.procVisual?.tickSkin(); return; } // [W-skin] hand-made GLB skin follows the GLB rig just animated by inner
    const turn = dt > 0 ? d / dt : 0;
    r.setGait(this.moving && !this.isDead ? m.speed : 0, this.isDead ? 0 : turn);
    if (r.turret) this.#aim(r, m);
    m.procVisual?.keepHidden();
    r.tick(dt);
    this.#hop(r, m, dt);
  }

  // [A16] hop-run overlay: weight follows mech.hopping (or forceHop); rising / falling from the height above the terrain
  #hop(r, m, dt) {
    const P = HOP_POSE;
    const on = (m.hopping || this.forceHop) && !this.isDead;
    this.hopW += ((on ? 1 : 0) - this.hopW) * Math.min(1, dt * P.blend);
    if (this.hopW < P.minWeight) { this.hopW = 0; this.hopLift = 0; this.forceT = 0; r.position.y = 0; return; }
    let rising;
    if (this.forceHop) {
      // console test: no sim arc exists, so the robot (child of the mech) rises itself along a sine arc
      this.forceT += dt;
      const u = (this.forceT % P.forcePeriod) / P.forcePeriod;
      rising = u < P.forceRiseShare;
      this.hopLift = P.forceHeight * Math.sin(Math.PI * u);
      r.position.y = this.hopLift * this.hopW;
    } else {
      r.position.y = 0;
      const lift = m.position.y - (m.world?.heightAt ? m.world.heightAt(m.position.x, m.position.z) : 0);
      rising = lift >= this.hopLift;
      this.hopLift = lift;
    }
    applyHopPose(r, this.hopW, rising);
  }

  // Turret follows the attack target (yaw relative to the mech's facing, pitch to the target's aim height)
  #aim(r, m) {
    const t = m.order?.type === 'attack' && !this.isDead ? m.order.target : null;
    if (!t?.position || t.destroyed || t.dead || t.removed) { r.clearAim(); return; }
    const dx = t.position.x - m.position.x;
    const dz = t.position.z - m.position.z;
    const dy = t.position.y + (t.aimHeight ?? 0) - m.position.y - (m.aimHeight ?? 0);
    r.setAim(wrapAngle(Math.atan2(dx, dz) - m.rotation.y), Math.atan2(dy, Math.hypot(dx, dz)));
  }

  #arms() {
    const r = this.robot;
    if (!r) return;
    for (let i = 0; i < ARM_SLOTS.length; i++) r.setPartVisible(ARM_SLOTS[i], !!this.mech.parts[ARM_SLOTS[i]]);
  }
}
