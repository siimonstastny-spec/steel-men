// Steel Men – modulární bojový robot ze 4 GLB dílů – SIT
import * as THREE from 'three';
import { loadModel } from '../core/AssetLoader.js';
import { loadAnimLibrary, resetPose } from '../anim/AnimLibrary.js';
import { MechAnimator } from '../anim/MechAnimator.js';
import { MechPart } from './MechPart.js';
import { ProcRobotAnimator } from '../procedural/robots/ProcRobotAnimator.js'; // [proc-robot]
import { ProcMechVisual, procRobotCandidate, prepareProcRobots } from './ProcMechVisual.js'; // [proc-robot]
import {
  SOCKETS, MECH, MOVEMENT, TEAMS, PLAYER_TEAM, VFX, ORDERS, RINGS, ARRIVE_DISTANCE, BEHAVIOUR, basicLoadout, PING,
  JUMP_JET, MECH_COLLISION,
} from '../config.js';
import { loadStats, getStats, partStats, composeMech, teamRule } from '../data/Stats.js';
import {
  isTargetable, areEnemies, edgeDistance, angleTo, canFireAt, engagementRange, releaseAttack, clipHitType, pickTarget,
} from '../game/Combat.js';
import { fogReaction, retargetAuto, lostTargetOrder, orderExpired } from './UnitCombat.js';
import { blockedOnTheWay, followPath, contactDistance } from '../game/Movement.js';
import { applyTeamColor } from '../core/TeamColor.js';
import { play } from '../audio/Sound.js';
import { approachBay, updateService, activeRepairers, isServiceBay } from '../game/Repair.js';
import { advanceQueue } from './OrderQueue.js';
import { isLocal } from '../core/LocalPlayer.js';

const DEG = Math.PI / 180;

export const ARM_SLOTS = ['leftArm', 'rightArm'];
/**
 * Slot names follow the model files: socket_ArmLeft sits at -x, and a mech faces +z, so the 'leftArm' slot is
 * physically on the PILOT's right (and 'rightArm' on the pilot's left). Presentation maps a pilot-side arm
 * ('leftArm' = the pilot's left hand) to the mech slot that sits there. Simulation keeps the slot names.
 */
export const PILOT_ARM_SLOT = Object.freeze({ leftArm: 'rightArm', rightArm: 'leftArm' });
export const pilotSlot = (side) => PILOT_ARM_SLOT[side] ?? side;
const WEAPON_SLOTS = [...ARM_SLOTS, 'torso', 'legs']; // order of ModularMech.weapons (arms first)
const NO_WEAPONS = Object.freeze([]);

const distXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export class ModularMech extends THREE.Group {
  /**
   * @param {object} loadout  { legs, torso, leftArm, rightArm } – cesty ke GLB
   * @param {object} [opts]   { name, team, race, hp } – hp optionally overrides part HP from stats.json, e.g. { torso: 500 };
   *                           race = owner's stats.json race key, used for parts without a race in the model name (Frame)
   */
  constructor(loadout = basicLoadout(), { name = 'Robot', team = PLAYER_TEAM, race = null, hp = {} } = {}) {
    super();
    this.name = name;
    this.team = team;
    this.race = race;
    this.loadout = loadout;
    this.hpOverride = hp;
    this.stats = null;    // combined stats of the current parts (Stats.composeMech), refreshed on part changes
    this.stance = null;   // 'ranged' | 'melee' – preferred fighting distance (default rules.combat.defaultStance)
    this.behaviour = null; // 'aggressive' | 'defensive' | 'passive' – what an idle mech does (BEHAVIOUR, setBehaviour)
    this.repairing = false; // field repair running (startRepair / stopRepair) – the mech is inactive meanwhile
    this.repairFactor = 1;  // repair speed multiplier of the current repair (a repair building passes its factor)
    this.repairExternal = false; // the running repair is done by vehicles (Repair.js), the mech only stays powered down
    this.bay = null;        // assembly bay the mech is serviced in (Repair.js) – hidden, `inside`, not targetable
    this.speed = 0;       // current move speed (units/s), changes with acceleration/deceleration
    this.attackLock = 0;  // seconds until the current attack ends – one attack at a time
    this.holdTimer = 0;   // seconds the mech must stand still (weapon with stopsToFire)
    this.hitReactTimer = 0;
    this.crew = null;     // Crew operating the mech; without crew the mech is inactive
    this.boardTimer = 0;  // seconds until a boarding crew takes control
    this.parts = {};      // slot -> MechPart (chybějící ruka = slot není)
    this.sockets = {};    // slot ruky -> Object3D kotevního bodu
    this.world = null;    // nastaví World.addMech
    this.order = null;    // { type: 'move', target } | { type: 'collect', wreck } | { type: 'attack', target, auto? }
    this.destroyed = false;
    this.removed = false; // trosky zapadly, World robota odebere
    this.sinkTimer = 0;
    this.radius = 6;      // footprint for ranges and selection; [W7] = shoulder circle (vs mechs and tall things)
    this.footRadius = undefined; // [W7] foot circle (vs crews, vehicles, low buildings) – set in #createRings
    this.shoulderHeight = Infinity; // [W7] units above the feet; lower obstacles / units touch only the foot circle
    this.aimHeight = 14;  // where shots aim at
    this.selectionRing = null;
    this.teamRing = null;
    this.animLib = null;
    this.animator = null;
    // [R2] jet movement (docs/notes/n6-jumpjet.md)
    this.flightAbility = null; // best 'flight' ability of the mounted parts (JetPack torso), crew bonuses applied
    this.flightCooldown = 0;   // s until the next flight is possible
    this.inFlight = false;     // in the air: cannot be stopped, no collisions, no orders / attacks until it lands
    this.hopAbility = null;    // best 'hopRun' ability (JumpJet legs): runs and hops over rifts, never walls / cliffs
    this.moveAnimRef = MECH.walkAnimRefSpeed; // speed at which the move loop plays at normal rate (legs anim.moveRefSpeed)
    this.hopping = false;      // over a rift in a running hop (y follows the hop arc, not the terrain)
    // [proc-robot] display only (ProcMechVisual.js): procedural robot drawn over the hidden GLB parts, or null
    this.procVisual = null;
    this.procModel = null;     // current ProcRobot (Highlight.js, World disposes it with procVisual)
  }

  /** [R2] Current jet flight (reused, no allocation per flight) */
  #flight = { fromX: 0, fromZ: 0, fromY: 0, toX: 0, toZ: 0, toY: 0, t: 0, duration: 1, height: 0, phase: null };
  /** [R2] Current rift hop: the takeoff → landing line, the mech's y follows the arc over its projection on it */
  #hop = { fromX: 0, fromZ: 0, fromY: 0, toX: 0, toZ: 0, toY: 0, height: 0 };

  get isMech() { return true; }
  /** [R2] Has a flight ability and it is recharged */
  get flightReady() { return this.flightAbility !== null && this.flightCooldown <= 0; }

  /**
   * Načte díly a animace, sestaví hierarchii nohy -> trup -> ruce. An arm slot without a model path in the
   * loadout (e.g. a mech assembled without arms) stays empty, the same state as after losing that arm.
   */
  async load() {
    const keys = ['legs', 'torso', ...ARM_SLOTS.filter((s) => this.loadout[s])];
    const [lib, , ...objects] = await Promise.all([
      loadAnimLibrary(),
      loadStats(),
      ...keys.map((k) => loadModel(this.loadout[k])),
    ]);
    this.animLib = lib;
    await prepareProcRobots(this.race); // [proc-robot] style kits for the robot builder (null for other races)
    this.stance ??= getStats().rules.combat.defaultStance;
    this.behaviour ??= getStats().rules.combat.defaultBehaviour;

    // MechPart se vytváří PŘED spojením, aby každý díl evidoval jen své meshe
    const created = {};
    keys.forEach((key, i) => {
      const stats = partStats(this.loadout[key], key, this.race, this.team);
      created[key] = new MechPart(key, objects[i], stats, this.hpOverride[key] ?? stats.hp);
      this.#paint(created[key]);
    });

    const { legs, torso } = created;
    for (const part of [legs, torso]) { part.mech = this; this.parts[part.key] = part; }

    this.add(legs.object);
    this.#socket(legs.object, SOCKETS.torso).add(torso.object);
    this.sockets.leftArm = this.#socket(torso.object, SOCKETS.leftArm);
    this.sockets.rightArm = this.#socket(torso.object, SOCKETS.rightArm);
    for (const slot of ARM_SLOTS) if (created[slot]) this.#mountToSlot(created[slot], slot);

    this.#placeOnGround();
    this.#createRings();
    this.#refreshStats();

    this.animator = new MechAnimator(this, lib);
    // [proc-robot] the procedural display wraps the GLB animator (its clips keep driving the hidden simulation body)
    if (procRobotCandidate(this.race)) {
      this.procVisual = new ProcMechVisual(this);
      this.animator = new ProcRobotAnimator(this, null, this.animator);
    }
    this.animator.setWalkClip(this.parts.legs.stats.anim?.move ?? null); // [R2] legs' own move loop (JumpJet hop run)
    this.animator.rebuild();
    this.procVisual?.sync(); // [proc-robot]
    this.#updateCrewLook();
    return this;
  }

  // ---------- stav ----------

  get alive() { return !this.destroyed; }
  get armCount() { return ARM_SLOTS.filter((s) => this.parts[s]).length; }
  /** Arm slots a picked-up arm can go to: empty ones and ones with a broken (0 HP) arm, which it replaces */
  get freeArmSlots() { return ARM_SLOTS.filter((s) => !this.parts[s]?.alive); }
  /** Arm slots with a broken arm still mounted (0 HP: no weapons, may fall off when hit again) */
  get brokenArmSlots() { return ARM_SLOTS.filter((s) => this.parts[s] && !this.parts[s].alive); }
  get evasion() { return this.stats?.evasion ?? 0; }

  /** Mech obeys orders only with a crew on board (after the boarding delay) and not while being repaired */
  get active() { return !this.destroyed && this.crew !== null && this.boardTimer <= 0 && !this.repairing; }
  /** Some mounted part can be repaired (below max HP, or a broken arm) – missing parts do not count */
  get damaged() { return Object.values(this.parts).some((p) => p.repairable); }
  /** Field repair can start: crewed, active and damaged */
  get canRepair() { return this.active && this.damaged; }
  /**
   * Repair speed as a share of each part's max HP per second:
   * rules.repair.fieldRate × (1 + crew repairSpeed bonus) × repairFactor
   */
  get repairRate() {
    return teamRule(this.team, 'repair.fieldRate') * (1 + (this.crew?.bonuses.repairSpeed ?? 0)) * this.repairFactor;
  }
  get canBoard() { return !this.destroyed && this.crew === null && !this.bay; }
  /** Serviced in an assembly bay: hidden, cannot be selected, targeted or collided with */
  get inside() { return this.bay !== null; }

  /** Všechny meshe robota – pro Raycaster */
  get pickables() {
    return this.destroyed || this.bay ? [] : Object.values(this.parts).flatMap((p) => p.meshes);
  }

  /**
   * Weapons of all mounted parts (arms first), each { def, stats, part, cooldown }
   * def = part data, stats = def with crew experience applied. A broken arm (0 HP, still mounted) has none.
   */
  get weapons() {
    return WEAPON_SLOTS.flatMap((s) => (this.parts[s]?.alive ? this.parts[s].weapons : NO_WEAPONS));
  }

  /** Has both melee and ranged weapons – only then the stance choice matters */
  get hasMixedWeapons() {
    const ws = this.weapons;
    return ws.some((w) => w.def.class === 'melee') && ws.some((w) => w.def.class !== 'melee');
  }

  setSelected(on) {
    if (this.selectionRing) this.selectionRing.visible = on && !this.destroyed;
  }

  // ---------- crew ----------

  /** Crew gets in; the mech becomes active after rules.crew.boardTime (shorter for experienced crews) */
  boardCrew(crew) {
    if (!this.canBoard) return false;
    this.crew = crew;
    this.boardTimer = teamRule(this.team, 'crew.boardTime') / (1 + (crew.bonuses.boardSpeed ?? 0));
    crew.enter(this);
    this.#refreshStats();
    this.#updateCrewLook();
    return true;
  }

  /** Crew gets out next to the mech; the mech stops and becomes inactive */
  ejectCrew() {
    const crew = this.crew;
    if (!crew) return null;
    this.stopRepair(); // repair needs the crew
    this.crew = null;
    this.boardTimer = 0;
    this.order = null;
    this.speed = 0;
    // Step out to the mech's left side
    const side = new THREE.Vector3(1, 0, 0).applyAxisAngle(THREE.Object3D.DEFAULT_UP, this.rotation.y);
    const pos = this.position.clone().addScaledVector(side, getStats().rules.crew.ejectDistance);
    crew.exit(pos, this.rotation.y);
    this.#refreshStats();
    this.#updateCrewLook();
    return crew;
  }

  /** Drops a mounted arm on the ground as a wreck (it keeps its HP and can be picked up again) */
  dropArm(slot) {
    if (!this.active || !this.parts[slot]) return null;
    return this.detachArm(slot, false); // the player's own choice: no "part lost" alert
  }

  /** Called by Crew when its rank changes – experience bonuses apply immediately */
  onCrewRankChanged() { this.#refreshStats(); }

  // ---------- poškození ----------

  /** Volá MechPart po každém zásahu */
  onPartDamaged(part, source, dealt = 0) {
    if (this.destroyed) return;
    // An arm at 0 HP stays mounted, broken (no weapons – see weapons); only later hits may tear it off (Combat)
    if (!part.alive && !part.isArm) { this.destroy(); return; } // trup nebo nohy na 0 HP
    // Hit reaction (the mech staggers) only for heavy hits, now and then, and never while walking, attacking
    // or from damage without a direction (burning) – frequent reactions made the mech look stuck
    const heavy = dealt >= part.maxHp * MECH.hitReactMinDamage;
    if (source && heavy && this.hitReactTimer <= 0 && this.attackLock <= 0 && this.speed <= 0
      && this.world && this.world.rng.next() < MECH.hitReactChance) { // seeded: the stagger delays the mech's next moves
      this.hitReactTimer = MECH.hitReactCooldown;
      this.animator?.hit(this.#hitDirection(source));
    }
  }

  /** Odpojí ruku ze slotu a pustí ji na zem jako vrak */
  detachArm(slot, alert = true) {
    const part = this.parts[slot];
    if (!part) return null;
    delete this.parts[slot];
    play('armDropped', { position: this.position });
    let wreck = null;
    if (this.world) wreck = this.world.spawnWreck(part, this);
    else { part.object.removeFromParent(); part.mech = null; }
    this.#refreshStats(); // lighter mech = faster, one weapon less
    if (!this.destroyed) this.#rebuildAnimation();
    // [N7] UI notice only (HUD alert, badge, minimap marker): reads nothing back, changes nothing in the simulation.
    // Not for the player's own drop (dropArm) and not when the whole mech blows up (destroy).
    if (alert && !this.destroyed && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(PING.partLostEvent, { detail: { mech: this, slot, wreck } }));
    }
    return wreck;
  }

  /** Zničení robota: ruce s HP odpadnou jako vraky, zbytek zčerná, padne a zapadne */
  destroy() {
    if (this.destroyed) return;
    this.stopRepair();
    this.destroyed = true;
    this.hopping = false; // [R2] the wreck sinks from where it is
    play('mechDestroyed', { position: this.position });
    this.order = null;
    this.setSelected(false);
    this.world?.effects.unitDeath(this); // [R9] burns first, explodes after the fall (data/explosions.json)
    if (this.teamRing) this.teamRing.visible = false;
    if (getStats().rules.crew.ejectOnDestroy) {
      // Survivors jump out and run from the enemies their team knows about (and the killer), then walk to their HQ
      // ([N8] evacuate; any player order takes over). Without an HQ they run from the wreck as before.
      const killer = this.lastAttacker;
      this.ejectCrew()?.flee(isTargetable(killer) ? [killer] : [], this.position, { evacuate: true });
    } else {
      this.crew = null; // crew dies with the mech
    }
    for (const slot of ARM_SLOTS) this.detachArm(slot);
    this.#throwOffSalvage();
    for (const part of Object.values(this.parts)) part.setCharred(true);
    this.procVisual?.setCharred(true); // [proc-robot] hides the slots that flew off, darkens the whole robot
    if (!Object.keys(this.parts).length) { this.removed = true; return; } // everything flew off
    this.animator?.rebuild();
    this.animator?.die();
    this.sinkTimer = MECH.hulkSinkDelay;
  }

  /**
   * Destroyed mech: each intact legs / torso may be thrown off as loot (rules.salvageDrop chance).
   * The part that was shot to 0 HP never drops. If the legs fly off but the torso stays, the torso
   * cannot hang in the air – it falls down as charred, non-salvageable debris.
   */
  #throwOffSalvage() {
    if (!this.world) return;
    const chance = getStats().rules.salvageDrop ?? {};
    // The killer's research (e.g. better salvage) decides how often parts survive
    const killerTeam = this.lastAttacker?.team ?? null;
    const dropChance = (k) => (killerTeam === null ? chance[k] : teamRule(killerTeam, `salvageDrop.${k}`)) ?? 0;
    const rng = this.world.rng; // seeded – which loot survives is simulation state
    const drop = ['torso', 'legs'].filter((k) => this.parts[k]?.alive && rng.next() < dropChance(k));
    if (drop.includes('legs') && this.parts.torso && !drop.includes('torso')) {
      const torso = this.parts.torso;
      delete this.parts.torso;
      this.world.spawnSalvage(torso, this, { salvageable: false });
    }
    const left = chance.remainingHp ?? { min: 1, max: 1 };
    for (const key of drop) {
      const part = this.parts[key];
      delete this.parts[key];
      // The explosion leaves the thrown-off part badly damaged – on the edge of breaking
      const fraction = rng.range(left.min, left.max);
      part.hp = Math.max(1, Math.min(part.hp, Math.round(part.maxHp * fraction)));
      this.world.spawnSalvage(part, this);
    }
  }

  // ---------- rozkazy ----------

  moveTo(point) {
    if (!this.active) return false;
    this.order = { type: 'move', target: point.clone() };
    return true;
  }

  /** Attack order: walk into range (per stance), then fight until the target is gone */
  attackUnit(target) {
    if (!this.active || !isTargetable(target) || !areEnemies(this, target) || this.weapons.length === 0) return false;
    this.order = { type: 'attack', target, lastKnown: target.position.clone() };
    return true;
  }

  /** Can this mech's side see the unit (fog of war)? */
  #canSee(unit) { return this.world.canSee(this, unit); }

  /** Attack-move: walk to a point and fight every enemy met on the way, then carry on */
  attackMoveTo(point) {
    if (!this.active) return false;
    this.order = { type: 'attackMove', target: point.clone() };
    return true;
  }

  /**
   * Guard a friendly unit (follow it, fight enemies that come near it) or a point (hold it).
   * @param {THREE.Vector3|object} target  point, or an own mech / crew
   */
  guard(target) {
    if (!this.active || !target || target === this) return false;
    this.order = target.isVector3 ? { type: 'guard', point: target.clone() } : { type: 'guard', unit: target };
    return true;
  }

  /** Patrol between the current position and a point, fighting enemies met on the way */
  patrol(point) {
    if (!this.active) return false;
    this.order = { type: 'patrol', points: [this.position.clone(), point.clone()], index: 1 };
    return true;
  }

  /** Rozkaz dojít k vraku ruky a namontovat ho */
  collect(wreck) {
    // Only arms can be mounted in the field (legs / torso salvage goes to the assembly building later)
    if (!this.active || !wreck.part?.isArm || !wreck.available || this.freeArmSlots.length === 0) return false;
    this.order = { type: 'collect', wreck };
    return true;
  }

  /** Drive into an own assembly bay for service (Repair.js): the crew steps out at the gate, the mech goes in */
  enterBay(bay) {
    if (!this.active || !isServiceBay(bay, this.team)) return false;
    this.order = { type: 'enterBay', bay };
    return true;
  }

  setStance(stance) { this.stance = stance; }

  /**
   * Behaviour of the mech when it has no explicit order (BEHAVIOUR.mechModes). An automatic fight the old
   * mode started (not one inside attack-move / patrol / guard) is dropped, so the new mode applies at once.
   * @returns {boolean} false for an unknown mode
   */
  setBehaviour(mode) {
    if (!BEHAVIOUR.mechModes.includes(mode)) return false;
    this.behaviour = mode;
    const o = this.order;
    if (o?.type === 'attack' && o.auto && !o.resume) this.order = o.home ? this.#returnHome(o.home) : null;
    return true;
  }

  // ---------- field repair ----------

  /**
   * Starts a field repair: the mech stops, powers down (inactive, ignores orders) and slowly restores the HP
   * of its mounted parts; missing parts are not replaced. Ends by itself when fully repaired, or by
   * stopRepair() / ejecting the crew.
   * @param {object} [opts] { factor } – speed multiplier (a repair building passes rules.repair.buildingFactor)
   *                        { external } – repaired by vehicles (Repair.js heals it, also without a crew); replaces
   *                        a running crew repair, ends when no vehicle repairs the mech any more
   * @returns {boolean} false when the mech cannot be repaired now (no crew, boarding, undamaged…)
   */
  startRepair({ factor = 1, external = false } = {}) {
    if (external) {
      if (this.destroyed || this.bay || !this.damaged || (this.repairing && this.repairExternal)) return false;
      this.stopRepair();
    } else if (!this.canRepair) {
      return false;
    }
    this.repairing = true;
    this.repairExternal = external;
    this.repairFactor = factor;
    this.order = null;
    this.speed = 0;
    this.#repairFx = this.world?.effects.attach(VFX.repairIndicator, this) ?? null;
    this.#updateCrewLook();
    return true;
  }

  /** Interrupts a running repair (HP restored so far stay); returns false when no repair was running */
  stopRepair() {
    if (!this.repairing) return false;
    this.repairing = false;
    this.repairExternal = false;
    this.repairFactor = 1;
    this.#repairFx?.dispose();
    this.#repairFx = null;
    this.#updateCrewLook();
    return true;
  }

  #repairFx = null;

  #repair(dt) {
    if (this.repairExternal) { // healed by the repairing vehicles
      if (!this.damaged || !activeRepairers(this).length) this.stopRepair();
      return;
    }
    const amount = this.repairRate * dt;
    for (const part of Object.values(this.parts)) part.heal(part.maxHp * amount); // heal() checks repairable (broken arm too)
    if (!this.damaged) this.stopRepair();
  }

  /**
   * Replaces the part in a slot with a new one from a model path (full HP), or with nothing (path null, arms
   * only) – service in an assembly bay (Repair.js). Legs / torso keep everything mounted on them.
   * In a world the swap happens inside a later simulation tick (World.deferLoad – same tick on every client);
   * pass follow-up simulation changes as `onDone`, which runs inside that tick (a `.then` runs too late).
   * @param {(old: MechPart|null) => void} [onDone]  called synchronously right after the swap
   * @returns {Promise<MechPart|null>} the removed part (detached, not a wreck), or null when the slot was empty
   *   or held a broken (0 HP) arm, which is scrapped
   */
  replacePart(slot, path, onDone = null) {
    const load = () => (path ? loadModel(path) : null);
    const apply = (object) => {
      const old = this.#swapPart(slot, path, object);
      onDone?.(old);
      return old;
    };
    if (this.world) return this.world.deferLoad(load, apply);
    return Promise.resolve().then(load).then(apply);
  }

  #swapPart(slot, path, object) {
    if (this.destroyed) return null;
    const old = this.parts[slot] ?? null;
    // A broken arm (0 HP) is scrap: it is removed but not handed back (Repair would return it to the part stock)
    const returned = old?.alive ? old : null;
    const part = object ? new MechPart(slot, object, partStats(path, slot, this.race, this.team)) : null;
    if (part) this.#paint(part);
    if (old) { old.object.removeFromParent(); old.mech = null; delete this.parts[slot]; }
    if (ARM_SLOTS.includes(slot)) {
      if (part) this.#mountToSlot(part, slot);
    } else if (slot === 'torso') {
      const arms = ARM_SLOTS.map((s) => this.parts[s]).filter(Boolean);
      for (const arm of arms) arm.object.removeFromParent();
      part.mech = this;
      this.parts.torso = part;
      this.#socket(this.parts.legs.object, SOCKETS.torso).add(part.object);
      this.sockets.leftArm = this.#socket(part.object, SOCKETS.leftArm);
      this.sockets.rightArm = this.#socket(part.object, SOCKETS.rightArm);
      for (const arm of arms) this.#mountToSlot(arm, arm.slot);
    } else { // legs: the torso moves onto the new legs' socket
      const torso = this.parts.torso;
      torso.object.removeFromParent();
      part.mech = this;
      this.parts.legs = part;
      this.add(part.object);
      this.#socket(part.object, SOCKETS.torso).add(torso.object);
      this.#placeOnGround();
    }
    if (!ARM_SLOTS.includes(slot)) { // body size changed: new footprint, aim height and rings
      for (const ring of [this.selectionRing, this.teamRing]) ring?.removeFromParent();
      this.teamRing = null;
      this.#createRings();
    }
    this.#refreshStats();
    this.#rebuildAnimation();
    this.#updateCrewLook();
    return returned;
  }

  /**
   * Re-applies the current team colours (after a team's colour changed). A captured part (picked up in the field)
   * keeps the colour of the team that painted it until the mech uses an assembly bay (#paintInBay).
   */
  refreshTeamColor() {
    for (const part of Object.values(this.parts)) this.#paint(part, part.paintTeam ?? this.team);
    this.procModel?.setTeamColor(TEAMS[this.team].color); // [proc-robot] whole robot in the owner's colour
    this.teamRing?.material.color.set(TEAMS[this.team].color);
  }

  // Paints a part in a team's colour (default this mech's; no-op when it already has it). The model never changes.
  #paint(part, team = this.team) {
    const color = TEAMS[team]?.color ?? TEAMS[this.team].color;
    part.paintTeam = team;
    if (part.teamColor === color) return;
    applyTeamColor(part.object, color);
    part.teamColor = color;
  }

  #bayPainted = false;

  // [N1] Using an assembly bay (service, repair, swap) repaints every mounted part in the owner's colour – once per visit
  #paintInBay() {
    if (this.#bayPainted) return;
    this.#bayPainted = true;
    for (const slot of WEAPON_SLOTS) if (this.parts[slot]) this.#paint(this.parts[slot]);
  }

  update(dt) {
    this.animator?.update(dt);
    if (this.inFlight) this.#updateFlight(dt); // [R2] a flight always ends with a landing (even a wreck lands first)
    this.flightCooldown = Math.max(0, this.flightCooldown - dt);
    if (this.destroyed) { if (!this.inFlight) this.#sink(dt); return; }
    if (this.bay) { this.#paintInBay(); this.speed = 0; this.animator?.setMoving(false); updateService(this, dt); return; } // in an assembly bay (Repair.js)
    this.#bayPainted = false;
    if (this.boardTimer > 0 && (this.boardTimer -= dt) <= 0) this.#updateCrewLook();
    this.attackLock = Math.max(0, this.attackLock - dt);
    this.holdTimer = Math.max(0, this.holdTimer - dt);
    this.hitReactTimer = Math.max(0, this.hitReactTimer - dt);
    for (const part of Object.values(this.parts)) part.updateWeapons(dt);
    if (this.repairing) this.#repair(dt);
    if (this.inFlight) return; // [R2] in the air: new orders wait for the landing
    if (!this.active) { this.speed = 0; this.#endHop(); this.animator?.setMoving(false); return; }
    // Stunned or being thrown back (StatusEffects): no moving, turning or new attacks
    if (this.status?.disabled || this.status?.knockedBack) { this.speed = 0; this.#endHop(); this.animator?.setMoving(false); return; }

    advanceQueue(this); // orders given with Shift (OrderQueue.js)
    this.#updateTarget();
    const moving = this.#move(dt);
    if (!moving) { this.speed = 0; this.#endHop(); } // [R2] a stopped hop lands at once (no hanging in the air)
    this.#fire(moving);
    this.animator?.setMoving(moving && this.holdTimer <= 0);
    // Minimum rate keeps the legs moving while the mech turns on the spot
    if (moving) this.animator?.setWalkRate(Math.max(MECH.minWalkAnimRate, this.speed / this.moveAnimRef));
  }

  // ---------- combat ----------

  /**
   * Drops lost targets; attack-move / patrol / guard engage enemies they meet and resume afterwards
   * (whatever the behaviour – explicit orders win); idle mechs react by their behaviour (#idleReaction).
   */
  #updateTarget() {
    if (orderExpired(this)) this.order = null;
    const o = this.order;
    if (o?.type === 'attack' && isTargetable(o.target)) {
      if (this.#canSee(o.target)) o.lastKnown = (o.lastKnown ?? new THREE.Vector3()).copy(o.target.position);
      else {
        // The target vanished into the fog: walk to where it was last seen (attack-move carries on to its goal),
        // then the behaviour / stance applies as for any idle mech
        this.order = lostTargetOrder(this, o);
      }
    } else if (o?.type === 'attack' && this.#targetLost(o)) {
      this.order = o.resume ? this.#resume(o.resume) : o.home ? this.#returnHome(o.home) : null;
    }
    if (this.order?.type === 'guard' && !this.#guardValid(this.order)) this.order = null;
    retargetAuto(this);
    const cur = this.order;
    if (cur && ORDERS.engaging.includes(cur.type)) {
      const enemy = this.weapons.length ? this.#scan(cur) : null;
      if (enemy) this.order = { type: 'attack', target: enemy, auto: true, resume: cur, guard: cur.type === 'guard' ? cur : null };
    } else if (this.weapons.length && (!cur || (cur.type === 'move' && cur.home))) {
      this.#idleReaction(cur);
    }
    this.lastAttacker = null;
  }

  /**
   * What a mech without an explicit order does (behaviour):
   *  aggressive – attacks the nearest enemy in sight (rules.combat.autoAcquire), or whoever shot at it;
   *  defensive  – attacks only whoever shot at it, remembering where it stood (home) to walk back there;
   *               while walking back it turns on a new attacker again;
   *  passive    – nothing.
   * @param {object|null} cur  null, or the walk back home of a defensive fight
   */
  #idleReaction(cur) {
    const attacker = isTargetable(this.lastAttacker) && areEnemies(this, this.lastAttacker) && this.#canSee(this.lastAttacker)
      ? this.lastAttacker : null;
    if (this.behaviour === 'aggressive') {
      if (!cur && getStats().rules.combat.autoAcquire) {
        const enemy = pickTarget(this, this.stats.sightRange);
        if (enemy) this.order = { type: 'attack', target: enemy, auto: true };
        // Fight back against whoever shot at us, even from beyond sight range
        else if (attacker) this.order = { type: 'attack', target: attacker };
      }
    } else if (this.behaviour === 'defensive' && attacker) {
      this.order = { type: 'attack', target: attacker, auto: true, home: cur?.home ?? this.position.clone() };
    }
    fogReaction(this); // [R1] hit from the fog (docs/notes/r1-combat.md)
  }

  // Plain move to the last seen position of a target lost in the fog (null when it is never known)
  #walkToLastKnown(o) {
    return o.lastKnown ? { type: 'move', target: o.lastKnown.clone() } : null;
  }

  // Defensive fight over: walk back to the spot where the mech was attacked
  #returnHome(home) { return { type: 'move', target: home, home }; }

  /**
   * Targets of opportunity (weapons that fire on the move at whatever is in range): an aggressive mech
   * always; otherwise only while carrying out an explicit fight or defending itself.
   */
  #firesAtWill() {
    if (this.behaviour === 'aggressive') return true;
    const o = this.order;
    if (!o) return false;
    if (ORDERS.engaging.includes(o.type)) return true;
    return o.type === 'attack' && (!o.auto || !!o.resume || !!o.home);
  }

  // Target dead / hidden, or chased too far (from the guarded spot while guarding, from home while
  // defending, from us otherwise)
  #targetLost(o) {
    if (!isTargetable(o.target)) return true;
    if (o.guard) return distXZ(this.#guardAnchor(o.guard), o.target.position) > ORDERS.guardChaseRadius;
    if (o.home) return distXZ(o.home, o.target.position) > BEHAVIOUR.defensiveChaseRadius;
    return o.auto && edgeDistance(this, o.target) > this.stats.sightRange * MECH.autoChaseLeash;
  }

  // Enemy to engage during attack-move / patrol (in sight) or guard (near the guarded unit / point)
  #scan(o) {
    if (o.type === 'guard') {
      const anchor = this.#guardAnchor(o);
      const near = pickTarget({ position: anchor, team: this.team }, ORDERS.guardRadius, undefined, this.world);
      if (near) return near;
      // Whoever shoots at us or at the guarded unit, as long as they are not too far from it
      return [this.lastAttacker, o.unit?.lastAttacker]
        .find((u) => isTargetable(u) && this.#canSee(u) && distXZ(anchor, u.position) <= ORDERS.guardChaseRadius) ?? null;
    }
    const attacker = isTargetable(this.lastAttacker) && this.#canSee(this.lastAttacker) ? this.lastAttacker : null;
    return pickTarget(this, this.stats.sightRange) ?? attacker;
  }

  #guardAnchor(o) { return o.unit ? o.unit.position : o.point; }

  // Guarded crew got into a mech -> guard the mech; guarded unit gone -> order ends
  #guardValid(o) {
    if (o.point) return true;
    if (o.unit.inside && o.unit.mech) o.unit = o.unit.mech; // crew boarded (a mech in a bay stays guarded)
    return !o.unit.destroyed && !o.unit.removed;
  }

  // An interrupted order continues: plan the path again from where the fight left us
  #resume(order) {
    order.nav = null;
    order.best = undefined;
    order.stuck = 0;
    return order;
  }

  /**
   * Fires one ready weapon (round robin). Weapons shoot only forward (fireArc).
   * stopsToFire weapons halt the mech for the attack and never interrupt a move order;
   * other weapons fire on the move (e.g. a gun while charging into melee).
   */
  #fire(moving) {
    if (this.attackLock > 0) return;
    const ready = this.weapons.filter((w) => w.cooldown <= 0 && w.stats);
    if (!ready.length) return;
    const primary = this.order?.type === 'attack' ? this.order.target : null;
    const moveOrder = ['move', 'collect', 'enterBay'].includes(this.order?.type);

    for (let k = 0; k < ready.length; k++) {
      const w = ready[(this.#weaponIndex + k) % ready.length];
      const s = w.stats;
      if (moveOrder && s.stopsToFire) continue;
      let target = primary && canFireAt(this, s, primary) ? primary : null;
      // Targets of opportunity only for weapons that do not stop the mech
      if (!target && !s.stopsToFire && this.#firesAtWill()) target = pickTarget(this, s.range, (u) => canFireAt(this, s, u));
      if (!target) continue;
      this.#weaponIndex += k + 1;
      this.#fireWeapon(w, target, moving);
      return;
    }
  }

  #fireWeapon(weapon, target, moving) {
    const s = weapon.stats;
    this.attackLock = s.attackTime;
    weapon.cooldown = s.attackTime + s.cooldown;
    if (s.stopsToFire) { this.holdTimer = s.attackTime; this.speed = 0; }
    // Body attack animation only when standing – shooting on the move keeps the walk cycle
    let clip = null;
    if (s.stopsToFire || !moving) {
      // The arm that physically holds the weapon (a mirrored arm sits on the other side)
      const side = weapon.part.slot === 'leftArm' ? 'left' : weapon.part.slot === 'rightArm' ? 'right' : null;
      clip = this.animator.attack(weapon.part.set, side, s.attackTime);
    }
    // How a melee blow lands depends on the clip just played (side swing, blow into the ground…)
    const hit = clip ? clipHitType(clip) : 'single';
    // [proc-robot] robot attack animation (visual only): the turret fires on the move too, arms only when standing
    if (weapon.part.slot === 'torso' || s.stopsToFire || !moving) this.animator.visualAttack?.(weapon.part.slot, s.attackTime, s.burst);
    this.world.schedule(s.attackTime * s.hitAt, () => {
      if (weapon.part.mech === this) releaseAttack(this.world, this, weapon, target, { hit }); // arm may be gone by now
    });
  }

  // ---------- interní ----------

  // Vrací true, pokud se robot v tomto snímku pohnul
  #move(dt) {
    const o = this.order;
    if (!o) return false;
    if (this.holdTimer > 0) { // firing a heavy / melee weapon – stand, keep facing the target
      if (o.type === 'attack') this.#turnTo(o.target.position, dt);
      return false;
    }

    let target;
    let ignore = [];
    if (o.type === 'collect') {
      const wreck = o.wreck;
      if (!wreck.available || this.freeArmSlots.length === 0) { this.order = null; return false; }
      target = wreck.object.position;
      if (this.#distanceXZ(target) <= MECH.pickupRange) {
        if (wreck.landed) { this.#mountWreck(wreck); this.order = null; }
        return false; // vrak ještě padá – počkat na místě
      }
    } else if (o.type === 'attack') {
      const range = engagementRange(this, this.stance);
      if (range === null) { this.order = null; return false; }
      // In range – or already touching the target (collision radii keep us from getting closer)
      const touching = edgeDistance(this, o.target) <= this.radius + MOVEMENT.contactSlack;
      if (edgeDistance(this, o.target) <= range || touching) {
        o.approachBest = undefined; // made it – the next approach starts its progress check afresh
        this.#turnTo(o.target.position, dt);
        return false;
      }
      // An attack never gives up: when other units block the way, walk to a free spot around the target
      if (this.#approachStuck(o, edgeDistance(this, o.target), dt)) this.#pickApproachSlot(o);
      target = this.#approachPoint(o);
      ignore = [o.target]; // the target itself is never an obstacle on the way to it
    } else if (o.type === 'enterBay') {
      target = approachBay(this, o); // null = got in, waits at the gate, or the bay is gone
      if (!target) return false;
    } else if (o.type === 'guard') {
      const anchor = this.#guardAnchor(o);
      // Stay near the guarded unit (within a tolerance, no need to walk right up to it) / on the guarded spot
      const hold = o.unit ? this.radius + o.unit.radius + ORDERS.guardFollowTolerance : ORDERS.guardHoldDistance;
      if (this.#distanceXZ(anchor) <= hold) { o.nav = null; return false; }
      target = anchor;
      if (o.unit) ignore = [o.unit];
    } else if (o.detour) {
      target = o.detour; // attack-move / patrol stepping aside around units blocking the way
    } else if (o.type === 'patrol') {
      target = o.points[o.index];
    } else {
      target = o.target; // move, attackMove
    }

    // Head for the next waypoint around static obstacles; dist = path length left
    const path = followPath(this, o, target, ignore, dt);
    const dist = path.remaining;
    if (o.detour) {
      if (dist <= ORDERS.detourReach || (o.detourTimer -= dt) <= 0) { o.detour = null; this.#resume(o); return false; }
    } else {
      const arrive = o.arriveDistance ?? (o.home ? BEHAVIOUR.homeArriveDistance : ARRIVE_DISTANCE);
      if (dist <= arrive && (o.type === 'move' || o.type === 'attackMove')) { this.order = null; return false; }
      if (o.type === 'patrol' && dist <= ORDERS.patrolArriveDistance) { this.#nextPatrolPoint(o); return false; }
    }
    const dx = path.point.x - this.position.x;
    const dz = path.point.z - this.position.z;
    const legDist = Math.hypot(dx, dz);
    if (legDist < MOVEMENT.overlapEpsilon) return false;
    // [R2] the path crosses an obstacle here: turn to the landing point, wait for the recharge, fly
    if (path.fly && this.flightAbility) return this.#prepareFlight(o, path.point, legDist, dt);
    // [R2] a rift ahead: hop over it on the run (no stop, no recharge)
    if (path.hop && this.hopAbility && !this.hopping) this.#startHop(path.point);

    const m = this.stats.mobility;
    const diff = this.#turnTo(path.point, dt);
    // Spot taken by another unit (or later a building): a plain move / collect gives up after a while;
    // attack-move and patrol never give up – near the goal it counts as reached, further away they step aside
    if (!o.detour && blockedOnTheWay(o, dist, diff, dt)) {
      if (ORDERS.giveUpWhenBlocked.includes(o.type)) { this.order = null; return false; }
      if (ORDERS.detourWhenBlocked.includes(o.type)) {
        if (dist < MOVEMENT.nearTargetDistance) {
          if (o.type === 'patrol') this.#nextPatrolPoint(o);
          else this.order = null; // attack-move: the area is reached
        } else {
          this.#startDetour(o, path.point);
        }
        return false;
      }
    }

    // Speed: accelerate to moveSpeed, brake in time to stop at the target,
    // and slow down while facing away from it (mechs do not strafe)
    const brakeSpeed = ORDERS.brakeAtGoal.includes(o.type) ? Math.sqrt(2 * m.deceleration * dist) : Infinity;
    const facing = Math.max(0, Math.cos(diff));
    const wantSpeed = Math.min(m.moveSpeed, brakeSpeed) * facing;
    this.speed = this.speed < wantSpeed
      ? Math.min(wantSpeed, this.speed + m.acceleration * dt)
      : Math.max(wantSpeed, this.speed - m.deceleration * dt);

    // Posun
    const step = Math.min(path.final ? legDist : dist, this.speed * dt);
    this.position.x += (dx / legDist) * step;
    this.position.z += (dz / legDist) * step;
    this.position.y = this.world.heightAt(this.position.x, this.position.z);
    if (this.hopping) this.#updateHop();
    return true;
  }

  // ---------- [R2] jet movement: JetPack flight, JumpJet rift hops ----------

  // At the takeoff of a planned flight: stand, face the landing point, take off once recharged. Returns true when it
  // took off. Waiting does not count as being blocked (blockedOnTheWay is not called).
  #prepareFlight(o, point, legDist, dt) {
    this.speed = 0;
    const a = this.flightAbility;
    const F = JUMP_JET.flight;
    // Farther than planned: plan again from here, but only once per flight (otherwise it would loop every tick);
    // the second time the mech flies anyway (duration scales with the distance)
    if (legDist > a.range + F.rangeSlack && !o.flightReplanned) { o.flightReplanned = true; o.nav = null; return false; }
    const diff = this.#turnTo(point, dt);
    if (Math.abs(diff) > F.takeoffFacing * DEG || this.flightCooldown > 0) return false;
    o.flightReplanned = false;
    this.#startFlight(point, legDist);
    return true;
  }

  #startFlight(point, dist) {
    const a = this.flightAbility;
    const F = JUMP_JET.flight;
    const f = this.#flight;
    f.fromX = this.position.x;
    f.fromZ = this.position.z;
    f.fromY = this.position.y;
    f.toX = point.x;
    f.toZ = point.z;
    f.toY = this.world.heightAt(point.x, point.z);
    f.t = 0;
    f.duration = Math.max(F.minDuration, dist / (a.speed ?? F.defaultSpeed));
    f.height = a.height ?? F.defaultHeight;
    f.phase = null;
    this.inFlight = true;
    this.hopping = false;
    this.flightCooldown = a.cooldown ?? 0;
    this.speed = 0;
    this.animator?.setMoving(false);
  }

  // Climb (climbShare of the time) → level cruise at `height` over the takeoff → landing line → descent; never below
  // the terrain. The phase picks the ability's clips (display only).
  #updateFlight(dt) {
    const f = this.#flight;
    const share = JUMP_JET.flight.climbShare;
    f.t = Math.min(1, f.t + dt / f.duration);
    const t = f.t;
    const x = f.fromX + (f.toX - f.fromX) * t;
    const z = f.fromZ + (f.toZ - f.fromZ) * t;
    const ground = this.world.heightAt(x, z);
    const up = THREE.MathUtils.smoothstep(Math.min(t, 1 - t), 0, share); // climb, cruise at 1, descent
    this.position.x = x;
    this.position.z = z;
    this.position.y = Math.max(ground, f.fromY + (f.toY - f.fromY) * t + f.height * up);
    const phase = t >= 1 ? null : t < share ? 'takeOff' : t > 1 - share ? 'land' : 'fly';
    if (phase !== f.phase) {
      f.phase = phase;
      const clip = phase ? this.flightAbility?.clips?.[phase] ?? null : null;
      this.animator?.setAirClip(clip, { loop: phase === 'fly', duration: f.duration * share });
    }
    if (t >= 1) {
      this.inFlight = false;
      this.position.y = ground;
      if (this.order) this.order.nav = null; // plan again from where it really landed
    }
  }

  // Start of a running hop over a rift towards the landing point (the leg the path marks `hop`)
  #startHop(point) {
    const h = this.#hop;
    h.fromX = this.position.x;
    h.fromZ = this.position.z;
    h.fromY = this.position.y;
    h.toX = point.x;
    h.toZ = point.z;
    h.toY = this.world.heightAt(point.x, point.z);
    h.height = this.hopAbility.height ?? JUMP_JET.hop.defaultHeight;
    this.hopping = true;
  }

  // Ends a running hop (if any): back on the terrain
  #endHop() {
    if (!this.hopping) return;
    this.hopping = false;
    this.position.y = this.world.heightAt(this.position.x, this.position.z);
  }

  // y over the hop line: the position projected on takeoff → landing, arc above the straight rim-to-rim line, never
  // below the terrain. Ends at the landing, or when the mech left the line (pushed / re-routed).
  #updateHop() {
    const h = this.#hop;
    const lx = h.toX - h.fromX;
    const lz = h.toZ - h.fromZ;
    const len2 = lx * lx + lz * lz;
    const px = this.position.x - h.fromX;
    const pz = this.position.z - h.fromZ;
    const t = len2 > 0 ? THREE.MathUtils.clamp((px * lx + pz * lz) / len2, 0, 1) : 1;
    const off = Math.hypot(px - lx * t, pz - lz * t);
    const ground = this.world.heightAt(this.position.x, this.position.z);
    if (t >= 1 || off > JUMP_JET.hop.leaveDistance) { this.#endHop(); return; }
    this.position.y = Math.max(ground, h.fromY + (h.toY - h.fromY) * t + 4 * h.height * t * (1 - t));
  }

  /** Turns towards a point at turnSpeed; returns the remaining angle (rad) */
  #turnTo(point, dt) {
    const diff = angleTo(this, point) + MECH.modelYawOffset;
    const maxTurn = this.stats.mobility.turnSpeed * DEG * dt;
    this.rotation.y += THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);
    return diff;
  }

  #nextPatrolPoint(o) {
    o.index = (o.index + 1) % o.points.length;
    this.#resume(o);
  }

  // Attack approach: no progress towards the target (edge distance) for ORDERS.attackRepositionTime.
  // Kept apart from blockedOnTheWay, whose progress is reset by every re-plan towards a moving target.
  #approachStuck(o, edge, dt) {
    if (this.flightAbility && this.flightCooldown > 0) return false; // waiting for the flight recharge is not being stuck
    if (o.approachBest === undefined || edge < o.approachBest - MOVEMENT.progressStep) {
      o.approachBest = edge;
      o.approachStuck = 0;
      return false;
    }
    o.approachStuck += dt;
    return o.approachStuck > ORDERS.attackRepositionTime;
  }

  // Where to walk during an attack: straight at the target, or the chosen free spot around it
  #approachPoint(o) {
    if (o.slot === undefined) return o.target.position;
    const r = o.target.radius + this.radius + ORDERS.approachGap;
    const t = o.target.position;
    o.slotPoint ??= new THREE.Vector3();
    return o.slotPoint.set(t.x + Math.sin(o.slot) * r, 0, t.z + Math.cos(o.slot) * r);
  }

  /**
   * Picks a free spot next to the target (ORDERS.approachSlots directions around it, nearest to our
   * side first, never the direction that just failed). A spot is free when no other unit and no static
   * obstacle stands there. When every spot is taken the direction keeps rotating – the mech never gives up.
   */
  #pickApproachSlot(o) {
    const t = o.target.position;
    const step = (Math.PI * 2) / ORDERS.approachSlots;
    const current = o.slot ?? Math.atan2(this.position.x - t.x, this.position.z - t.z);
    const r = o.target.radius + this.radius + ORDERS.approachGap;
    // [N7-5] aircraft never take a ground spot (and the other way round)
    const others = this.world.units.filter((u) => u !== this && u !== o.target && Boolean(u.airborne) === Boolean(this.airborne));
    const shapes = this.world.nav.shapesFor(this.radius, [this, o.target], false, this); // [W7] per-obstacle circle
    let chosen = current + step;
    for (let k = 1; k < ORDERS.approachSlots; k++) {
      const a = current + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step; // +1, −1, +2, −2… steps from ours
      const p = { x: t.x + Math.sin(a) * r, z: t.z + Math.cos(a) * r };
      if (others.some((u) => distXZ(p, u.position) < contactDistance(this, u))) continue;
      if (shapes.some((s) => (s.radius !== undefined
        ? distXZ(p, s) < s.radius
        : Math.abs(p.x - s.x) < s.halfX && Math.abs(p.z - s.z) < s.halfZ))) continue;
      chosen = a;
      break;
    }
    o.slot = chosen;
    o.approachBest = undefined;
    o.nav = null;
  }

  // Attack-move / patrol blocked far from the goal: step aside (alternating sides) and try again
  #startDetour(o, towards) {
    o.detourSide = -(o.detourSide ?? -1);
    const dx = towards.x - this.position.x;
    const dz = towards.z - this.position.z;
    const len = Math.hypot(dx, dz) || 1;
    const d = ORDERS.detourDistance * o.detourSide;
    o.detour = new THREE.Vector3(this.position.x - (dz / len) * d, 0, this.position.z + (dx / len) * d);
    o.detourTimer = ORDERS.detourTimeout;
    this.#resume(o);
  }

  #mountWreck(wreck) {
    const part = wreck.part;
    // Empty slots first; otherwise the arm replaces a broken one, which drops to the ground as a wreck
    const empty = ARM_SLOTS.filter((s) => !this.parts[s]);
    const free = empty.length ? empty : this.freeArmSlots;
    const slot = free.includes(part.key) ? part.key : free[0];
    if (this.parts[slot]) this.detachArm(slot, false);
    this.world.takeWreck(wreck);
    this.#mountToSlot(part, slot);
    part.setStats(partStats(part.stats.path, part.key, this.race, this.team)); // the new owner's research applies
    part.restore(MECH.pickupHpRatio);
    this.#refreshStats();
    this.#rebuildAnimation();
  }

  #weaponIndex = 0;

  /** The team's research changed: every mounted part re-reads its stats (HP keep their share of max HP) */
  applyResearch() {
    for (const part of Object.values(this.parts)) part.setStats(partStats(part.stats.path, part.key, this.race, this.team));
    this.#refreshStats();
  }

  #refreshStats() {
    const parts = Object.values(this.parts);
    // [R2] the owner's race sets the speed modifier (captured legs move with this mech's race, not the one that made them)
    this.stats = composeMech(Object.fromEntries(Object.entries(this.parts).map(([slot, p]) => [slot, p.stats])), this.crew?.bonuses, this.race);
    // composeMech lists weapons in part order -> link each runtime weapon to its final (crew-boosted) stats
    let i = 0;
    for (const p of parts) for (const w of p.weapons) w.stats = this.stats.weapons[i++];
    // [R2] jet abilities: the longest range of each kind wins (data stay per part)
    this.flightAbility = null;
    this.hopAbility = null;
    for (const a of this.stats.abilities ?? []) {
      if (a.type === 'flight' && (!this.flightAbility || a.range > this.flightAbility.range)) this.flightAbility = a;
      if (a.type === 'hopRun' && (!this.hopAbility || a.range > this.hopAbility.range)) this.hopAbility = a;
    }
    if (!this.hopAbility) this.hopping = false;
    this.animator?.setWalkClip(this.parts.legs?.stats.anim?.move ?? null); // [R2] e.g. the JumpJet run loop
    // Move speed at which the legs' loop plays at normal rate (anim.moveRefSpeed – a run stride differs from the walk)
    this.moveAnimRef = this.parts.legs?.stats.anim?.moveRefSpeed ?? MECH.walkAnimRefSpeed;
  }

  /**
   * Rebuilds the animation bindings after the arms changed. A running attack clip survives it (same clip, same
   * time and rate): the shots of the attack are released on their own timers, so cutting the clip made the mech
   * fire while standing in the idle pose. Display only – nothing in the simulation depends on it.
   */
  #rebuildAnimation() {
    this.procVisual?.sync(); // [proc-robot] part combination changed: new robot / hidden slot / back to GLB
    const an = this.animator;
    if (!an) return;
    const run = an.attackAction;
    const name = run && !an.dead ? run.getClip().name : null;
    const time = run?.time ?? 0;
    const rate = run?.timeScale ?? 1;
    an.rebuild();
    if (!name || !an.playOnce(name, 0)) return;
    an.attackAction = an.oneShot;
    an.oneShot.timeScale = rate;
    an.oneShot.time = time;
  }

  // Crewless mechs power down and show a grey selection ring
  #updateCrewLook() {
    this.animator?.setCrewed(this.active);
    this.selectionRing?.material.color.setHex(this.active ? RINGS.activeColor : RINGS.noCrewColor);
  }

  // Připojí ruku na kotevní bod; na opačnou stranu ji zrcadlí
  #mountToSlot(part, slot) {
    const obj = part.object;
    resetPose(obj);
    obj.position.set(0, 0, 0);
    obj.quaternion.identity();
    obj.scale.set(slot === part.key ? 1 : -1, 1, 1);
    this.sockets[slot].add(obj);
    // [N1] no repaint here: an arm picked up in the field keeps its model and colour until an assembly bay (#paintInBay)
    part.mech = this;
    part.wreck = null;
    part.slot = slot;
    this.parts[slot] = part;
  }

  // Ze které strany přišel zásah (model se dívá po +Z, ArmRight je na +X)
  #hitDirection(source) {
    if (!source) return 'front';
    const local = this.worldToLocal(source.clone());
    const angle = Math.atan2(local.x, local.z);
    const a = Math.abs(angle);
    if (a < Math.PI / 4) return 'front';
    if (a > (3 * Math.PI) / 4) return 'back';
    return angle > 0 ? 'right' : 'left';
  }

  #socket(parentObject, socketName) {
    const socket = parentObject.getObjectByName(socketName);
    if (socket) return socket;
    console.warn(`[ModularMech] Socket "${socketName}" nenalezen v ${parentObject.name}, používám kořen.`);
    return parentObject;
  }

  // Počátek nohou je v pánvi – posuneme model, aby stál chodidly na y = 0 skupiny
  #placeOnGround() {
    const root = this.parts.legs.object;
    root.position.y = 0;
    this.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    root.position.y = this.position.y - box.min.y;
  }

  // Selection ring (own units) + always visible team ring for other teams (than the local player's – display
  // only, the simulation never reads it); also sets radius / aim height
  #createRings() {
    // Body = legs + torso only; long weapons (katana…) must not inflate the footprint
    this.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const meshBox = new THREE.Box3();
    for (const mesh of [...this.parts.legs.meshes, ...this.parts.torso.meshes]) {
      // Geometry only – expandByObject would include child nodes (arms hang under torso nodes)
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      box.union(meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
    }
    box.min.sub(this.position);
    box.max.sub(this.position);
    const bodyRadius = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * MOVEMENT.bodyRadiusFactor;
    // Arms stick out sideways – without them neighbouring mechs would walk through each other's arms
    // [H2] the body is capped too (wide JetPack torso): a mech never exceeds MOVEMENT.maxMechRadius
    this.radius = Math.min(Math.max(bodyRadius, this.#armRadius()), MOVEMENT.maxMechRadius);
    // Ring a bit outside the footprint
    const r = Math.max(this.radius * MOVEMENT.ringRadiusFactor, this.radius + MOVEMENT.ringMinMargin);
    this.bodyHeight = box.max.y - box.min.y; // body = cylinder of radius × bodyHeight for 3D splash / pellets
    this.aimHeight = this.bodyHeight * MECH.aimHeightFactor;
    this.#measureCollision(box.min.y); // [W7] foot circle + shoulder height
    const ring = (inner, outer, color, opacity) => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(inner, outer, RINGS.mechSegments),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = RINGS.height;
      this.add(m);
      return m;
    };
    this.selectionRing = ring(r - RINGS.selectionWidth, r, RINGS.activeColor, RINGS.selectionOpacity);
    this.selectionRing.visible = false;
    const t = RINGS.mechTeamRing;
    if (!isLocal(this.team)) this.teamRing = ring(r - t.inset - t.width, r - t.inset, TEAMS[this.team].color, t.opacity);
  }

  /**
   * [W7] Second collision circle (docs/notes/w7-crew-collision.md): `footRadius` = the legs alone (larger side of
   * their bounding box × MECH_COLLISION.footRadiusFactor), touching everything lower than the shoulders (crews,
   * vehicles, low buildings / walls, rifts); `shoulderHeight` = arm-socket height above the feet. `radius` (shoulders)
   * stays for mechs and tall things. Data overrides: legs `collision.footRadius`, torso `collision.shoulderHeight`.
   * Measured from the bind pose like `radius`, so it is the same on every client.
   * @param {number} feetY  lowest point of the legs + torso box relative to the mech's position
   */
  #measureCollision(feetY) {
    const box = new THREE.Box3();
    const meshBox = new THREE.Box3();
    for (const mesh of this.parts.legs.meshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      box.union(meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
    }
    const measured = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * MECH_COLLISION.footRadiusFactor;
    const foot = this.parts.legs.stats.collision?.footRadius ?? Math.max(measured, MECH_COLLISION.minFootRadius);
    this.footRadius = Math.min(foot, this.radius); // the legs never reach further than the shoulders
    const socket = this.sockets.leftArm ?? this.sockets.rightArm;
    const socketY = socket ? socket.getWorldPosition(new THREE.Vector3()).y - this.position.y - feetY : this.bodyHeight;
    this.shoulderHeight = this.parts.torso.stats.collision?.shoulderHeight
      ?? socketY * MECH_COLLISION.shoulderHeightFactor;
  }

  /**
   * Footprint of the arms (bind pose): (half the distance between the arm sockets + arm thickness)
   * × MOVEMENT.armRadiusFactor. Thickness = how far the arm geometry reaches sideways past its socket
   * (capped, so a blade held sideways does not blow up the footprint). Uses the sockets even when an
   * arm is missing – the radius stays the same for the mech's whole life.
   */
  #armRadius() {
    const inv = this.matrixWorld.clone().invert();
    const l = this.sockets.leftArm.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const rt = this.sockets.rightArm.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
    const halfSockets = Math.hypot(l.x - rt.x, l.z - rt.z) / 2;
    let thickness = 0;
    const meshBox = new THREE.Box3();
    for (const slot of ARM_SLOTS) {
      const part = this.parts[slot];
      if (!part) continue;
      const socketX = Math.abs((slot === 'leftArm' ? l : rt).x);
      for (const mesh of part.meshes) {
        if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
        meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld).applyMatrix4(inv);
        thickness = Math.max(thickness, Math.max(Math.abs(meshBox.min.x), Math.abs(meshBox.max.x)) - socketX);
      }
    }
    thickness = THREE.MathUtils.clamp(thickness, 0, MOVEMENT.maxArmThickness);
    return (halfSockets + thickness) * MOVEMENT.armRadiusFactor;
  }

  #sink(dt) {
    if (this.removed) return;
    this.sinkTimer -= dt;
    if (this.sinkTimer > 0) return;
    this.position.y -= MECH.sinkSpeed * dt;
    if (this.position.y < this.world.heightAt(this.position.x, this.position.z) - MECH.sinkDepth) this.removed = true;
  }

  #distanceXZ(p) { return Math.hypot(p.x - this.position.x, p.z - this.position.z); }
}
