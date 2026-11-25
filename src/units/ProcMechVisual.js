// Steel Men – [proc-robot] procedural display of a ModularMech (docs/notes/proc-robot-wire.md). DISPLAY ONLY.
// The GLB parts stay the mech's simulation body exactly as without procedural robots (MechPart.object, sockets,
// MechAnimator clips → muzzle points, clip hit types, radius / collision / aim height, wreck physics and bounds);
// only their meshes are hidden (they still take part in picking – Raycaster ignores `visible`). A ProcRobot child of
// the mech draws the robot instead, animated by ProcRobotAnimator from the mech's state. Nothing here is read by the
// simulation, so clients with procedural robots on / off stay in lockstep.
//
// Data: stats.json parts[set][kind].procModel = registered robot part id (RobotLegs / RobotTorsos / RobotArms).
// A mech is drawn procedurally when PROC_ROBOTS is on, its owner's race is listed, every mounted part has a
// registered procModel and was made by a listed race (a captured part of another race → the whole mech is GLB).
import * as THREE from 'three';
import { PROC_ROBOTS, TEAMS, RACE } from '../config.js';
import { loadBuildingStyles } from '../procedural/registry.js';
import * as RobotParts from '../procedural/robots/RobotParts.js'; // side effects: registers every robot part
import * as RobotKit from '../procedural/robots/RobotKit.js';
import { procPartId } from '../procedural/robots/RobotPartMap.js'; // [B6] set → proc id when stats.json has no procModel
import { partStats } from '../data/Stats.js'; // [B3] loadout → standInSet check at candidate time
import { GlbSkin, skinReady, prepareGlbSkins, hasGlbSkins, createSkinPartModel } from './GlbSkinVisual.js'; // [W-skin] hand-made GLB parts win over procedural ones

const SLOTS = ['legs', 'torso', 'leftArm', 'rightArm'];
const KIND = { legs: 'legs', torso: 'torso', leftArm: 'arm', rightArm: 'arm' };
/** MechPart → ProcMechVisual that hid its GLB meshes (a part can move between mechs) */
const HIDDEN_BY = new WeakMap();

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1);

/** Procedural robots may be drawn now (config + console switch window.steelMen.procedural) */
export const procRobotsOn = () => PROC_ROBOTS.enabled && globalThis.window?.steelMen?.procedural !== false;
/** [B3] A part of a data-only set (stats.json standInSet: IonKatana, SprintLegs, BastionTorso …) makes the whole robot procedural */
const hasStandIn = (part) => !!part?.stats?.standInSet;

/** [B3] The loadout { legs, torso, leftArm, rightArm } (model paths) names a part with stats.standInSet (stats must be loaded) */
function loadoutHasStandIn(loadout) {
  if (!loadout) return false;
  for (let i = 0; i < SLOTS.length; i++) {
    const path = loadout[SLOTS[i]];
    if (!path) continue;
    try { if (partStats(path, SLOTS[i]).standInSet) return true; } catch { /* stats not loaded: not a candidate */ }
  }
  return false;
}

/**
 * A mech of this owner race may ever be drawn procedurally (decided once per mech at load). [B3] Pass the loadout too:
 * a robot with a standInSet part is a candidate whatever its race (ModularMech: procRobotCandidate(this.race, this.loadout)).
 */
export const procRobotCandidate = (race, loadout) => PROC_ROBOTS.enabled
  && (PROC_ROBOTS.races.includes(race ?? RACE) || loadoutHasStandIn(loadout));
/** Loads the style kits the robot builder needs (null when this robot never draws procedurally); idempotent */
export const prepareProcRobots = (race, loadout) => (procRobotCandidate(race, loadout)
  ? (hasGlbSkins(race ?? RACE) ? Promise.all([loadBuildingStyles(), prepareGlbSkins(race ?? RACE)]) : loadBuildingStyles())
  : null);

// Optional single-part builder of the robot kit (arm wreck model); undefined until the kit provides it
const partFactory = () => RobotParts.createProcRobotPart ?? RobotKit.createProcRobotPart ?? null;

function setMeshesVisible(part, visible) {
  for (const mesh of part.meshes) mesh.visible = visible;
}

export class ProcMechVisual {
  /** @param {import('./ModularMech.js').ModularMech} mech */
  constructor(mech) {
    this.mech = mech;
    this.robot = null;     // current ProcRobot (also mech.procModel) or null = GLB drawn
    this.skin = null;      // [W-skin] current GlbSkin (also mech.procModel) – hand-made GLB parts; robot and skin never both
    this.key = '';         // part combination of the current robot
    this.charred = false;
    this.hidden = new Set(); // parts whose GLB meshes this visual hid
  }

  /**
   * Re-evaluates the display after any part change (lost / mounted / swapped part, destruction): builds the robot of
   * the current combination (geometry is cached per combination), or drops it and shows the GLB parts again.
   */
  sync() {
    if (this.#syncSkin()) return;
    const combo = this.#combo();
    if (!combo) this.#drop();
    else {
      const key = `${combo.legs}|${combo.torso}|${combo.leftArm}|${combo.rightArm}`;
      if (key !== this.key || !this.robot) this.#build(combo, key);
    }
    const m = this.mech;
    // a missing slot collapses its wrapper bone (legs gone = everything, torso gone = torso and arms)
    if (this.robot) for (const slot of SLOTS) this.robot.setPartVisible(slot, !!m.parts[slot]);
    this.#updateHidden();
  }

  /** Destroyed mech: the whole robot goes dark in every LOD (ProcUnit.setDarkness: own paint + instance attribute) */
  setCharred(on) {
    this.charred = on;
    this.sync();
    this.#darken();
  }

  /** [W-skin] Every step after the GLB mixer (ProcRobotAnimator.update): the skin follows the rig, GLB meshes stay hidden */
  tickSkin() {
    if (!this.skin) return;
    this.skin.tick();
    this.keepHidden();
  }

  // [W-skin] Hand-made GLB skin when every mounted part has one (decided before the procedural robot); true = skin drawn
  #syncSkin() {
    const m = this.mech;
    const race = m.race ?? RACE;
    const want = procRobotsOn() && (m.destroyed ? !!this.skin : skinReady(m, race));
    if (!want) {
      if (this.skin) this.#dropSkin();
      return false;
    }
    this.#drop();
    let key = '';
    for (const slot of SLOTS) key += `${m.parts[slot]?.object.uuid ?? '-'}|`;
    if (!this.skin) {
      this.skin = new GlbSkin(m, race, TEAMS[m.team]?.color);
      this.skin.setHighlighted(!!m.highlighted);
      m.procModel = this.skin;
    }
    if (!m.destroyed && key !== this.skin.key) this.skin.rebuild(key);
    for (const slot of SLOTS) this.skin.setPartVisible(slot, !!m.parts[slot]);
    this.#updateHidden();
    return true;
  }

  #dropSkin() {
    this.skin.dispose();
    this.skin = null;
    if (this.mech.procModel?.isGlbSkin) this.mech.procModel = null;
    this.#updateHidden();
  }

  /** Called every step: mounted parts stay hidden while the robot draws them (something else may show them) */
  keepHidden() {
    if (!this.robot && !this.skin) return;
    if (this.charred) this.#darken(); // no-op unless the robot was rebuilt / reset
    const parts = this.mech.parts;
    for (let i = 0; i < SLOTS.length; i++) {
      const p = parts[SLOTS[i]];
      if (!p || (!this.robot && !this.skin.covers(p))) continue;
      for (let k = 0; k < p.meshes.length; k++) if (p.meshes[k].visible) p.meshes[k].visible = false;
    }
  }

  /** Releases the robot (mech removed from the world); the GLB parts are drawn again */
  dispose() {
    this.#drop();
    if (this.skin) { this.skin.dispose(); this.skin = null; }
    for (const p of this.hidden) if (HIDDEN_BY.get(p) === this && !p.procView) this.#setHidden(p, false);
    this.hidden.clear();
  }

  // Wanted part ids or null (GLB). A missing arm keeps the current robot's arm id (the slot is just hidden).
  #combo() {
    const m = this.mech;
    if (!procRobotsOn() || !PROC_ROBOTS.enabled) return null;
    // [B3] a mounted standInSet part draws the whole robot procedurally even for a race outside PROC_ROBOTS.races
    let standIn = false;
    for (const slot of SLOTS) if (hasStandIn(m.parts[slot])) { standIn = true; break; }
    if (!standIn && !PROC_ROBOTS.races.includes(m.race ?? RACE)) return null;
    if (m.destroyed) return this.robot ? this.robot.combo : null; // the hulk keeps its model, lost slots hide
    const ids = RobotParts.robotPartIds();
    const out = {};
    for (const slot of SLOTS) {
      const part = m.parts[slot];
      if (!part) {
        if (KIND[slot] !== 'arm') return null;
        out[slot] = this.robot?.combo[slot] ?? '';
        continue;
      }
      if (!standIn && !PROC_ROBOTS.races.includes(part.stats.race ?? m.race ?? RACE)) return null;
      const id = procPartId(part.set, KIND[slot], part.stats);
      if (!id || !ids[KIND[slot]].includes(id)) return null;
      out[slot] = id;
    }
    return out;
  }

  #build(combo, key) {
    const m = this.mech;
    let robot;
    try {
      robot = RobotParts.createProcRobot(m.race ?? RACE, TEAMS[m.team]?.color, combo);
    } catch (err) {
      console.warn('[ProcMechVisual] procedural robot failed, drawing GLB parts', err);
      this.#drop();
      return;
    }
    const old = this.robot;
    if (old) {
      robot.setHighlighted(old.highlighted);
      old.dispose();
    }
    robot.name = 'procRobot';
    m.add(robot);
    m.procModel = robot;
    this.robot = robot;
    this.key = key;
    robot.enableBatching();
    m.animator?.setRobot?.(robot);
    if (this.charred) this.#darken();
  }

  #drop() {
    if (!this.robot) return;
    this.robot.dispose();
    this.robot = null;
    this.key = '';
    this.mech.procModel = null;
    this.mech.animator?.setRobot?.(null);
  }

  #updateHidden() {
    const m = this.mech;
    // [W-skin] a skin hides only the parts it draws (an arm without a skin stays a GLB arm)
    for (const slot of SLOTS) {
      const p = m.parts[slot];
      if (p) this.#setHidden(p, !!this.robot || !!this.skin?.covers(p));
    }
    // parts that left this mech (wreck, salvage, swapped out) are drawn as GLB again, unless an arm wreck shows
    // its own procedural model (ArmWreck.procView) or another mech's visual took them over
    for (const p of this.hidden) {
      if (p.mech === m || p.procView || HIDDEN_BY.get(p) !== this) continue;
      this.#setHidden(p, false);
    }
  }

  #setHidden(part, hidden) {
    setMeshesVisible(part, !hidden);
    if (hidden) { HIDDEN_BY.set(part, this); this.hidden.add(part); return; }
    if (HIDDEN_BY.get(part) === this) HIDDEN_BY.delete(part);
    this.hidden.delete(part);
  }

  // Charred = darkness 1 − charredFactor (paint colour × charredFactor, glow off), carried by the ProcUnit itself
  #darken() {
    this.robot?.setDarkness(this.charred ? 1 - PROC_ROBOTS.charredFactor : 0);
    this.skin?.setDarkness(this.charred ? 1 - PROC_ROBOTS.charredFactor : 0); // [W-skin]
  }
}

/**
 * Procedural model of a torn-off arm that the mech drew procedurally (ArmWreck). Follows the GLB arm (hidden, it
 * keeps doing the wreck physics, fall animation, bounds and picking) – sits in the scene on its own, never as a child
 * of the GLB object, so it can never change the GLB box the landing is measured from. Returns null and shows the
 * GLB arm when the mech drew GLB, the kit has no single-part builder yet or the arm has no procModel.
 * @param {import('./MechPart.js').MechPart} part
 * @param {THREE.Object3D} fromMech
 * @param {THREE.Scene} scene
 */
export function createArmWreckView(part, fromMech, scene) {
  const owner = HIDDEN_BY.get(part);
  const make = partFactory();
  let model = null;
  const procId = procPartId(part.set, 'arm', part.stats);
  if (owner?.skin && owner.mech === fromMech && procRobotsOn()) { // [W-skin] the arm falls as the skin part it was drawn as
    model = createSkinPartModel(owner.skin.race, part, TEAMS[part.paintTeam ?? fromMech.team]?.color);
  } else if (owner && owner.mech === fromMech && make && procId && procRobotsOn()) {
    try {
      // built for the arm's own side (part.key); a mirrored GLB arm mirrors the model with it
      model = make(fromMech.race ?? RACE, TEAMS[part.paintTeam ?? fromMech.team]?.color, part.key, procId);
    } catch (err) {
      console.warn('[ProcMechVisual] procedural arm wreck failed, drawing the GLB arm', err);
      model = null;
    }
  }
  if (!model) {
    if (owner) { HIDDEN_BY.delete(part); owner.hidden.delete(part); }
    setMeshesVisible(part, true);
    return null;
  }
  const view = new ArmWreckView(part, model, scene);
  view.update();
  return view;
}

class ArmWreckView {
  constructor(part, model, scene) {
    this.part = part;
    this.model = model;
    part.procView = this;
    model.matrixAutoUpdate = false;
    scene.add(model);
    // the arm's top joint (driven by the fall clip) and its rest transform relative to the arm root
    const root = part.object;
    let joint = null;
    root.traverse((o) => { if (!joint && o !== root && o.userData.gltfNode && !o.name.startsWith('socket_')) joint = o; });
    this.joint = joint ?? root;
    this.restInverse = new THREE.Matrix4();
    for (let o = this.joint; o && o !== root; o = o.parent) {
      const r = o.userData.rest;
      _m.compose(r ? _p.fromArray(r.p) : _p.copy(o.position), r ? _q.fromArray(r.q) : _q.copy(o.quaternion), ONE);
      this.restInverse.premultiply(_m);
    }
    this.restInverse.invert();
  }

  /** Copies the GLB arm's pose (call after the wreck moved; visual only) */
  update() {
    this.part.object.updateMatrixWorld(true);
    this.model.matrix.multiplyMatrices(this.joint.matrixWorld, this.restInverse);
    this.model.matrixWorldNeedsUpdate = true;
  }

  setHighlighted(on) { this.model.setHighlighted?.(on); }

  /** Wreck collected / destroyed: the model goes, the GLB arm is drawn again wherever it ends up (truck, mech) */
  dispose() {
    this.model.removeFromParent();
    this.model.dispose?.();
    if (this.part.procView === this) this.part.procView = null;
    const owner = HIDDEN_BY.get(this.part);
    if (owner) { HIDDEN_BY.delete(this.part); owner.hidden.delete(this.part); }
    setMeshesVisible(this.part, true);
  }
}
