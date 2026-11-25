// Steel Men – building (stats.json → structures). A finished or unfinished building is a pathfinding obstacle
// (axis-aligned box, World registers world.structures as an obstacle source). Construction is driven by builder
// vehicles that call addBuilder() every frame they work on it; the rate comes from Construction.buildRate
// (more builders = faster with diminishing returns, races[*].construction.continuesWithoutBuilder = goes on alone).
// Finished buildings give population (supplyProvided), income (Economy) and produce (stats.produces, BuildMenu).
import * as THREE from 'three';
import { loadModel, loadGltf } from '../core/AssetLoader.js';
import { loadStats, getStats, unitStats, applyArmor } from '../data/Stats.js';
import { getRenderClock } from '../core/Graphics.js';
import { TEAMS, RINGS, STRUCTURE, VFX, PATHFINDING, SPAWN_SPOT, GENERATOR_BLAST } from '../config.js';
import { structureBlast } from '../game/Combat.js';

// Scratch objects for sun-tracking buildings (Structure.#trackSun)
const _sunAxis = new THREE.Vector3(0, 1, 0);
const _sunYaw = new THREE.Quaternion();
const _sunQ = new THREE.Quaternion();
import { isLocal } from '../core/LocalPlayer.js';
import { applyTeamColor } from '../core/TeamColor.js';
import { structureBuildRate, markConstructionStarted } from '../game/Construction.js';
import { useProceduralModel, createProceduralStructure, loadBuildingStyles } from '../procedural/registry.js';
import { createChargeState } from '../game/Superweapons.js'; // [A9-F3]

const QUARTER_TURNS = 4;

// Spawn spots (Structure.findSpawnPoint)
const _spawnUp = new THREE.Vector3(0, 1, 0);

/**
 * Point on the perimeter of a rectangle (half sizes hx, hz, local axes) at arc length `s` from its front centre
 * (0, hz), positive towards +X, wrapping around. Returns [x, z].
 */
function perimeterPoint(s, hx, hz) {
  const p = 4 * (hx + hz);
  let t = ((s % p) + p) % p;
  if (t < hx) return [t, hz];
  t -= hx;
  if (t < 2 * hz) return [hx, hz - t];
  t -= 2 * hz;
  if (t < 2 * hx) return [hx - t, -hz];
  t -= 2 * hx;
  if (t < 2 * hz) return [-hx, -hz + t];
  t -= 2 * hz;
  return [-hx + t, hz];
}

/** Rounds a yaw to the allowed building rotations (STRUCTURE.yawStep) */
export const snapYaw = (yaw) => Math.round(yaw / STRUCTURE.yawStep) * STRUCTURE.yawStep;

/** True when the yaw turns the building sideways (footprint half sizes swap) */
const sideways = (yaw) => {
  const k = ((Math.round(yaw / (Math.PI / 2)) % QUARTER_TURNS) + QUARTER_TURNS) % QUARTER_TURNS;
  return k % 2 === 1;
};

/** Model scale of a building: STRUCTURE.modelScale × its own stats.modelScale (data, default 1) */
export const structureScale = (stats) => STRUCTURE.modelScale * (stats.modelScale ?? 1);

// Race whose model a building shows (same rule as Stats.resolveUnit; W → X) – picks the simBody.byRace entry
function modelRaceOf(stats, race) {
  const own = getStats().races?.[race]?.modelRace;
  const list = stats.races;
  if (!list) return own ?? race;
  return list.includes(race) ? race : (list.includes(own) ? own : list[0]);
}

/**
 * [A1-6] Simulation body of a building from data (stats.json → structures[id].simBody, measured from the GLB with
 * procedural models off – docs/notes/a1-structure-dims.md): { halfX, halfZ, bodyHeight, turretHeight?, muzzles? }.
 * halfX / halfZ = model box half sizes at yaw 0 without STRUCTURE.footprintPadding. byRace[race] overrides fields
 * (muzzles as a whole). null when the building has no simBody.
 */
export function structureSimBody(stats, race) {
  const base = stats?.simBody;
  if (!base) return null;
  const over = base.byRace?.[race] ?? base.byRace?.[modelRaceOf(stats, race)] ?? null;
  return over ? { ...base, ...over } : base;
}

/**
 * Footprint of a structure at yaw 0: { halfX, halfZ, bodyHeight, offsetX, offsetZ }. Sizes come from stats simBody
 * (simulation – never from the shown model); offset = GLB model box centre, visual only (centres the GLB model on the
 * building origin). Loads the GLB once (cached by AssetLoader); without simBody the GLB box gives the sizes too.
 */
export async function modelFootprint(id, race) {
  const cached = footprintCache.get(footprintKey(id, race));
  if (cached) return cached;
  await loadStats();
  const stats = unitStats('structures', id, race);
  const gltf = await loadGltf(stats.model);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const s = structureScale(stats);
  const size = box.getSize(new THREE.Vector3()).multiplyScalar(s);
  const centre = box.getCenter(new THREE.Vector3()).multiplyScalar(s);
  const body = structureSimBody(stats, race);
  if (!body) console.warn(`[Structure] ${id}: no stats.simBody – footprint measured from the GLB model`);
  const fp = {
    halfX: (body ? body.halfX : size.x / 2) + STRUCTURE.footprintPadding,
    halfZ: (body ? body.halfZ : size.z / 2) + STRUCTURE.footprintPadding,
    bodyHeight: body ? body.bodyHeight : box.max.y * s, // top of the model (part of it may be sunk into the ground)
    offsetX: centre.x, offsetZ: centre.z,
  };
  footprintCache.set(footprintKey(id, race), fp);
  return fp;
}

// Footprints once computed. The simulation (build commands) reads them synchronously via cachedFootprint(), so every
// client must have loaded them before a build command can run (buildCommands.preloadFootprints).
const footprintCache = new Map();
const footprintKey = (id, race) => `${id}:${race}`;

/** Footprint already computed by modelFootprint, or undefined (synchronous – for command validation) */
export const cachedFootprint = (id, race) => footprintCache.get(footprintKey(id, race));

/** Footprint box at a position and yaw (world axes) */
export function footprintAt(fp, x, z, yaw) {
  const swap = sideways(yaw);
  return { x, z, halfX: swap ? fp.halfZ : fp.halfX, halfZ: swap ? fp.halfX : fp.halfZ };
}

export class Structure extends THREE.Group {
  /**
   * @param {string} id     stats.json → structures key, e.g. 'outpost'
   * @param {string} race   owner faction
   * @param {object} [opts] { team, complete (finished at once, e.g. the starting Outpost), yaw, name }
   */
  constructor(id, race, { team, complete = false, yaw = 0, name = id } = {}) {
    super();
    this.unitId = id;
    this.race = race;
    this.team = team;
    this.name = name;
    this.rotation.y = snapYaw(yaw);
    this.complete = complete;
    this.progress = complete ? 1 : 0; // construction 0..1
    this.stats = null;
    this.hp = 0;
    this.maxHp = 0;
    this.radius = 10;
    this.footprint = null;    // { halfX, halfZ } in world axes
    this.simBody = null;      // [A1-6] resolved stats simBody (structureSimBody), set by setup()
    this.world = null;
    this.dead = false;
    this.removed = false;
    this.speed = 0;
    this.model = null;
    this.procModel = null;      // procedural model (src/procedural/registry.js; off with window.steelMen.procedural = false), visual only
    this.mixer = null;
    this.builders = new Set();  // vehicles that built it during the last frame (HUD, rate)
    this._working = new Set();
    this.constructionStarted = false; // a builder has already worked on it (Construction.markConstructionStarted)
    this.spawnCount = 0;       // produced units so far (spreads their spawn spots)
    // [R4] rally chain of produced units [{ x, z }] and the stance they get on creation (null = unit default).
    // Changed only by the setRally / setSpawnStance commands (Production), read by Production at spawn and by the UI.
    this.rally = [];
    this.spawnBehaviour = null;
    // [D1] false = the team has low energy and this building uses energy (stats.energyUse): a tower is off,
    // production / research / service runs slowed. Set every tick by Economy.update; read by towers and the UI.
    this.powered = true;
  }

  /**
   * Synchronous part of loading: stats, HP, footprint (needs loadStats() done and the footprint computed). Build
   * commands call it before world.addStructure so the building exists as an obstacle with a valid entity id at once;
   * the model is attached later by load(). Safe to call twice.
   */
  setup(fp) {
    if (this.stats) return;
    this.stats = unitStats('structures', this.unitId, this.race, this.team);
    const startHp = getStats().rules.construction?.startHpFraction ?? 1;
    this.maxHp = this.stats.hp;
    this.hp = this.complete ? this.maxHp : Math.max(1, Math.round(this.maxHp * startHp));
    this.fp = fp;
    const box = footprintAt(fp, 0, 0, this.rotation.y);
    this.footprint = { halfX: box.halfX, halfZ: box.halfZ };
    this.radius = (box.halfX + box.halfZ) / 2;   // targets use a circle (Combat.edgeDistance)
    this.bodyHeight = fp.bodyHeight;             // [A1-6] from data (modelFootprint), not from the shown model
    this.aimHeight = this.bodyHeight * STRUCTURE.aimHeightFactor;
    this.simBody = structureSimBody(this.stats, this.race); // [A1-6] turretHeight (wall posts), muzzles (towers)
    // [A9-F3] superweapon charge { charge, ratio, state } – changed only by Superweapons (simulation)
    if (this.stats.superweapon) this.superweapon = createChargeState();
  }

  /** [A9-F3] Superweapons.launch: the procedural model plays its launch animation (visual only) */
  onSuperweaponLaunch() { this.procModel?.launch?.(); }

  async load() {
    await loadStats();
    const fp = await modelFootprint(this.unitId, this.race);
    this.setup(fp);
    // Procedural model instead of the GLB when the id has one (PROC_BUILDINGS, docs/notes/proc-style-kit.md);
    // footprint and simulation body stay from stats simBody (A1-6)
    const proc = useProceduralModel(this.unitId);
    if (proc) await loadBuildingStyles();
    const model = proc
      ? createProceduralStructure(this.unitId, this.race, TEAMS[this.team].color)
      : await loadModel(this.stats.model);
    this.procModel = proc ? model : null;
    try {
      this.#attachModel(model, fp, proc ? null : (await loadGltf(this.stats.model)).animations[STRUCTURE.animClipIndex]);
    } catch (err) {
      this.#dropProcModel();
      throw err;
    }
    // Removed while loading (World already ran its removal without this model): release the procedural model
    if (this.removed) this.#dropProcModel();
    return this;
  }

  #dropProcModel() {
    this.procModel?.dispose();
    this.procModel = null;
  }

  #attachModel(model, fp, clip) {
    model.scale.setScalar(structureScale(this.stats));
    // GLB: centre the model box on the origin. Procedural models are built around the footprint origin already,
    // unless they declare `glbCentre` (built in GLB coordinates, e.g. the aircraft hangar): centre that point instead.
    const c = this.procModel?.glbCentre;
    if (this.procModel) model.position.set(c ? -c.x * model.scale.x : 0, 0, c ? -c.z * model.scale.x : 0);
    else model.position.set(-fp.offsetX, 0, -fp.offsetZ);
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
    });
    model.userData.unit = this;
    this.model = model;
    this.holder = new THREE.Group(); // scaled vertically while the building goes up
    this.holder.add(model);
    this.add(this.holder);
    if (clip) {
      this.mixer = new THREE.AnimationMixer(model);
      this.idleAction = this.mixer.clipAction(clip);
      this.idleAction.timeScale = this.stats.animSpeed ?? 1;
    }
    this.#createOutline();
    this.refreshTeamColor();
    this.#refreshVisual();
    if (this.complete) {
      this.idleAction?.play();
      this.procModel?.enableBatching();   // finished: static body goes to the instanced groups (BuildingBatcher)
    }
  }

  // ---------- state ----------

  /** The team's research changed: stats are resolved again, HP keep their share of max HP */
  applyResearch() {
    if (!this.stats || this.dead) return;
    const ratio = this.maxHp > 0 ? this.hp / this.maxHp : 1;
    this.stats = unitStats('structures', this.unitId, this.race, this.team);
    this.maxHp = this.stats.hp;
    this.hp = ratio * this.maxHp;
  }

  get isMech() { return false; }
  get isStructure() { return true; }
  get alive() { return !this.dead; }
  get destroyed() { return this.dead; }
  get inside() { return false; }
  get underConstruction() { return !this.complete && !this.dead; }
  get pickables() {
    const out = [];
    if (!this.dead) this.model?.traverse((o) => { if (o.isMesh) out.push(o); });
    return out;
  }

  /** Pathfinding / placement box { x, z, halfX, halfZ, owner } */
  get obstacle() {
    const f = this.footprint ?? { halfX: this.radius, halfZ: this.radius };
    return { x: this.position.x, z: this.position.z, halfX: f.halfX, halfZ: f.halfZ, owner: this };
  }

  /** What this building produces (stats.produces, e.g. ['crew'], ['vehicle']) – only when finished */
  get produces() { return this.complete && !this.dead ? (this.stats.produces ?? []) : []; }

  setSelected(on) { if (this.outline) this.outline.visible = on && !this.dead; }

  refreshTeamColor() {
    const color = TEAMS[this.team].color;
    if (this.procModel) this.procModel.setTeamColor(color);
    else if (this.model) applyTeamColor(this.model, color);
    this.teamOutline?.material.color.set(color);
  }

  // ---------- construction ----------

  /** A builder vehicle works on this building during this frame */
  addBuilder(vehicle) { if (!this.complete) this._working.add(vehicle); }

  /** Current construction speed (1 = one builder, buildTime seconds for the whole building) */
  get buildRate() { return structureBuildRate(this); }

  /** Finishes the building at once (starting Outpost, or construction reached 100 %) */
  finish() {
    if (this.complete) return;
    this.complete = true;
    this.progress = 1;
    this.builders = new Set();
    this.#refreshVisual();
    this.idleAction?.play();
    this.procModel?.enableBatching();
  }

  // ---------- damage ----------

  takeDamage(damage) {
    if (this.dead) return 0;
    const dealt = Math.min(applyArmor(damage, this.stats.armor).total, this.hp);
    this.hp -= dealt;
    if (this.hp <= 0) this.destroy();
    return dealt;
  }

  destroy({ explode = true } = {}) {
    if (this.dead) return;
    this.dead = true;
    this.setSelected(false);
    if (explode) this.world?.effects.burst(VFX.mechExplosion, this.position.clone(), { size: STRUCTURE.explosionSize, sound: 'explosionBuilding' }); // [A6]
    this.removed = true; // World removes it (and its pathfinding box)
    // Death blast (stats.explosion, a finished power generator): origin read now, blast after GENERATOR_BLAST.delay
    const ex = this.stats?.explosion;
    if (explode && ex && this.complete && this.world) {
      const origin = this.position.clone();
      origin.y += this.aimHeight ?? 0; // [A1-6] simulation point only (no procedural reactor centre: lockstep)
      const world = this.world;
      world.schedule(GENERATOR_BLAST.delay, () => structureBlast(world, this, origin, ex));
    }
  }

  // ---------- production ----------

  /**
   * Where the next produced unit appears (preview for the UI, nothing reserved): the free spot findSpawnPoint picks,
   * or – when there is none – the old spot in front of the building, marked `blocked: true`.
   */
  spawnPoint(opts) {
    return this.findSpawnPoint(opts) ?? { ...this.#frontPoint(), blocked: true };
  }

  /**
   * Takes the next spawn spot (Production, at the tick the unit is finished – deterministic) and reserves it for
   * SPAWN_SPOT.reserveTicks, so units appearing a few ticks later (SIM.spawnDelayTicks) do not land on each other.
   * When no spot around the building is free it returns the old front spot with `blocked: true` (callers that do not
   * check keep working; Production should check findSpawnPoint() first and hold the item – docs/notes/r1-combat.md).
   * @param {object} [opts] { radius, ignore } – see findSpawnPoint
   */
  nextSpawnPoint(opts) {
    const p = this.spawnPoint(opts);
    this.spawnCount++;
    if (!p.blocked) {
      const radius = opts?.radius ?? SPAWN_SPOT.defaultRadius;
      const tick = this.world?.tick ?? 0;
      this.spawnReserved = (this.spawnReserved ?? []).filter((r) => r.until >= tick);
      this.spawnReserved.push({ x: p.x, z: p.z, radius, until: tick + SPAWN_SPOT.reserveTicks });
    }
    return p;
  }

  /**
   * First free spot around the building where a unit of `radius` can stand and walk away: outside every pathfinding
   * obstacle inflated by its radius (this building, other buildings, walls, crewless mechs – world.nav), not on another
   * unit, not on a spot reserved for a unit about to appear, inside the map. Tries the front first (spread like before
   * by spawnCount), then around the whole building, ring after ring (SPAWN_SPOT). Deterministic (world state only).
   * Also meant for a mech leaving the assembly bay after service (Repair.releaseMech).
   * @param {object} [opts]
   * @param {number} [opts.radius]  radius of the unit (default SPAWN_SPOT.defaultRadius – fits any unit)
   * @param {Array}  [opts.ignore]  units / obstacle owners not counted (e.g. the mech that leaves the bay)
   * @returns {{x:number, z:number, yaw:number}|null}  null = no free spot around the building
   */
  findSpawnPoint({ radius = SPAWN_SPOT.defaultRadius, ignore = [] } = {}) {
    const world = this.world;
    if (!world?.nav) return this.#frontPoint();
    const shapes = world.nav.shapesFor(radius, ignore);
    const others = world.units.filter((u) => !u.isStructure && !u.airborne && !ignore.includes(u)); // [N7] aircraft overhead do not block
    const tick = world.tick ?? 0;
    const reserved = (this.spawnReserved ?? []).filter((r) => r.until >= tick);
    const limit = (world.nav.half ?? Infinity) - SPAWN_SPOT.mapMargin - radius;
    const free = (p) => Math.abs(p.x) <= limit && Math.abs(p.z) <= limit
      && !shapes.some((s) => (s.radius !== undefined
        ? Math.hypot(p.x - s.x, p.z - s.z) < s.radius
        : Math.abs(p.x - s.x) < s.halfX && Math.abs(p.z - s.z) < s.halfZ))
      && !others.some((u) => Math.hypot(p.x - u.position.x, p.z - u.position.z) < radius + (u.radius ?? 0))
      && !reserved.some((r) => Math.hypot(p.x - r.x, p.z - r.z) < radius + r.radius);
    for (const p of this.#spawnCandidates(radius)) if (free(p)) return p;
    return null;
  }

  // The old spawn spot: in front of the building (+Z of its rotation), spread sideways by spawnCount
  #frontPoint() {
    const f = this.fp ?? { halfX: this.radius, halfZ: this.radius };
    return this.#toWorld(this.#frontSide(f), f.halfZ + STRUCTURE.spawnGap);
  }

  // Sideways offset of the next front slot (STRUCTURE.spawnGap apart along the front)
  #frontSide(f) {
    const spread = STRUCTURE.spawnGap;
    const slots = Math.max(1, Math.floor((f.halfX * 2) / spread));
    return ((this.spawnCount % slots) - (slots - 1) / 2) * spread;
  }

  #toWorld(lx, lz) {
    const local = new THREE.Vector3(lx, 0, lz).applyAxisAngle(_spawnUp, this.rotation.y);
    return { x: this.position.x + local.x, z: this.position.z + local.z, yaw: this.rotation.y };
  }

  /**
   * Candidate spots, best first: rings around the footprint (local axes, front = +Z), each ring walked along its
   * perimeter from the next front slot outwards to both sides alternately, SPAWN_SPOT.sampleStep apart.
   * The first ring keeps the unit's radius + pathfinding clearance from the building (STRUCTURE.spawnGap at least).
   */
  #spawnCandidates(radius) {
    const f = this.fp ?? { halfX: this.radius, halfZ: this.radius };
    const first = Math.max(STRUCTURE.spawnGap, radius + PATHFINDING.clearance + SPAWN_SPOT.edgeGap);
    const start = this.#frontSide(f);
    const out = [];
    for (let k = 0; k < SPAWN_SPOT.rings; k++) {
      const d = first + k * SPAWN_SPOT.ringStep;
      const hx = f.halfX + d;
      const hz = f.halfZ + d;
      const perimeter = 4 * (hx + hz);
      const count = Math.max(1, Math.ceil(perimeter / SPAWN_SPOT.sampleStep));
      const step = perimeter / count;
      out.push(this.#toWorld(...perimeterPoint(start, hx, hz)));
      for (let j = 1; j <= Math.floor(count / 2); j++) {
        out.push(this.#toWorld(...perimeterPoint(start + j * step, hx, hz)));
        if (j * 2 < count) out.push(this.#toWorld(...perimeterPoint(start - j * step, hx, hz)));
      }
    }
    return out;
  }

  /**
   * Sun-tracking idle clip (solar panels): clip time comes from a shared real-time clock, not from this building's
   * own playback, and is offset by the building yaw, so all panels face the same world direction. Visual only:
   * nothing in the simulation or the state hash reads it.
   */
  #trackSun() {
    const clip = this.idleAction.getClip();
    if (!(clip.duration > 0)) return;
    if (!this.sunNodes) this.sunNodes = this.#findSunNodes(clip);
    // Same clip time on every panel…
    this.idleAction.time = ((performance.now() / 1000) * STRUCTURE.sunTrackingSpeed) % clip.duration;
    this.mixer.update(0);
    // …and the building yaw taken out of each turning part: world = Ry(yaw)·P·q  →  q' = P⁻¹·Ry(−yaw)·P·q
    _sunYaw.setFromAxisAngle(_sunAxis, -this.rotation.y);
    for (const { node, rel, relInv } of this.sunNodes) {
      _sunQ.copy(relInv).multiply(_sunYaw).multiply(rel);
      node.quaternion.premultiply(_sunQ);
    }
  }

  /** Parts whose rotation the idle clip animates, with their parent's rotation relative to this building */
  #findSunNodes(clip) {
    const nodes = [];
    for (const track of clip.tracks) {
      if (!track.name.endsWith('.quaternion')) continue;
      const v = track.values;
      if (v.every((x, i) => x === v[i % 4])) continue; // constant: not a turning part
      const node = this.model.getObjectByName(track.name.slice(0, -'.quaternion'.length));
      if (!node) continue;
      const rel = new THREE.Quaternion();
      for (let o = node.parent; o && o !== this; o = o.parent) rel.premultiply(o.quaternion);
      nodes.push({ node, rel, relInv: rel.clone().invert() });
    }
    return nodes;
  }

  update(dt) {
    if (this.dead) return;
    // [I1] Construction below never waits for the model (build commands add the building before it loads and
    // World.trackLoad holds the next tick until it is there); only the visuals need it
    if (this.holder) {
      if (this.stats?.sunTracking && this.idleAction) this.#trackSun();
      else this.mixer?.update(dt);
    }
    // Visual only (does not change state): crane / door / beacons while the building produces. tick() = batching
    // bookkeeping (fog of war, LOD) + update(); a far or hidden building is not animated.
    // (sunClock: the shared real-time sun clock – visual only, same as #trackSun – for a procedural solar panel)
    this.procModel?.setPowered(this.powered);
    this.procModel?.setDamage(this.complete && this.maxHp > 0 ? this.hp / this.maxHp : 1);
    if (this.superweapon) this.procModel?.setCharge?.(this.superweapon.ratio, this.superweapon.state); // [A9-F3] B3 API
    this.procModel?.tick(dt, this.complete && this.powered && (this.world?.production?.itemsOf(this.eid).length ?? 0) > 0,
      this.stats?.sunTracking && getRenderClock() > 0 ? getRenderClock() * STRUCTURE.sunTrackingSpeed : undefined);
    // Swap the two builder sets instead of allocating a new one every tick
    const last = this.builders;
    this.builders = this._working;
    this._working = last;
    last.clear();
    markConstructionStarted(this);
    if (this.complete) return;
    const rate = this.buildRate;
    if (rate <= 0) return; // paused: no builder and the faction needs one
    const before = this.progress;
    this.progress = Math.min(1, this.progress + (rate * dt) / Math.max(this.stats.buildTime, Number.EPSILON));
    const startHp = getStats().rules.construction?.startHpFraction ?? 1;
    this.hp = Math.min(this.maxHp, this.hp + this.maxHp * (1 - startHp) * (this.progress - before));
    this.#refreshVisual();
    if (this.progress >= 1) this.finish();
  }

  // ---------- internal ----------

  #refreshVisual() {
    if (!this.holder) return;
    const min = STRUCTURE.constructionMinHeight;
    this.holder.scale.y = this.complete ? 1 : min + (1 - min) * this.progress;
  }

  // Rectangle outline on the ground: selection (own, when selected) and team colour (other teams, always)
  #createOutline() {
    const f = this.fp; // yaw-0 footprint in local axes – the building's rotation turns it with the model
    const make = (inset, width, color, opacity) => {
      const shape = new THREE.Shape();
      const ox = f.halfX - inset;
      const oz = f.halfZ - inset;
      shape.moveTo(-ox, -oz); shape.lineTo(ox, -oz); shape.lineTo(ox, oz); shape.lineTo(-ox, oz); shape.closePath();
      const hole = new THREE.Path();
      const ix = ox - width;
      const iz = oz - width;
      hole.moveTo(-ix, -iz); hole.lineTo(-ix, iz); hole.lineTo(ix, iz); hole.lineTo(ix, -iz); hole.closePath();
      shape.holes.push(hole);
      const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = RINGS.height;
      this.add(mesh);
      return mesh;
    };
    this.outline = make(0, STRUCTURE.ringWidth, RINGS.activeColor, RINGS.selectionOpacity);
    this.outline.visible = false;
    const t = RINGS.mechTeamRing;
    if (!isLocal(this.team)) this.teamOutline = make(t.inset, t.width, TEAMS[this.team].color, t.opacity);
  }
}
