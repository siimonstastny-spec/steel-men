// Steel Mans – herní svět: roboti, posádky, vraky, výška terénu, časovače a efekty boje – SIT
import * as THREE from 'three';
import { ArmWreck } from '../units/ArmWreck.js';
import { SalvageWreck } from '../units/SalvageWreck.js';
import { Effects } from './Effects.js';
import { isTargetable, areEnemies, edgeDistance, dealDamage } from './Combat.js';
import { updateStatusEffects } from './StatusEffects.js';
import { resolveCollisions, isStatic } from './Movement.js';
import { NavGrid } from './Pathfinding.js';
import { GameMap } from './Map.js';
import { FogOfWar } from './FogOfWar.js';
import { buildTerrainGeometry, sampleHeightField } from '../core/SceneSetup.js';
import { Rng } from '../core/Rng.js';
import { TEAMS, VFX, FOG, SIM } from '../config.js';

const DOWN = new THREE.Vector3(0, -1, 0);

export class World {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.Mesh} ground  mesh terénu (pro výšku a klikání na zem)
   */
  constructor(scene, ground) {
    this.scene = scene;
    this.ground = ground;
    this.mechs = [];
    this.crews = [];   // all crews, including those inside mechs (they are not in the scene then)
    this.wrecks = [];
    this.salvage = []; // SalvageWreck – legs / torso loot and falling debris of destroyed mechs
    this.vehicles = [];   // Vehicle (src/units/Vehicle.js) – trucks
    this.structures = []; // Structure (src/units/Structure.js) – finished and unfinished buildings
    this.economy = null;  // Economy (src/game/Economy.js) – resources, population, ore deposits; set by main.js
    this.effects = new Effects(scene);
    this.effects.preload(); // explosion models; effects requested before they load are skipped
    this.events = [];  // { time, fn } – delayed actions (weapon hits, bursts)
    // Settings of this game (main.js writes the choices of the start menu here)
    this.settings = {
      // Friendly fire: enabled = own units take splash / sweep / stray pellets; artilleryOnly = only from
      // class 'artillery' weapons; reduced = × rules.friendlyFire.reducedFactor (see Combat.sideFactor)
      friendlyFire: { enabled: false, artilleryOnly: false, reduced: false },
      // Fog of war: 'unexplored' | 'explored' | 'off' (see FOG in config.js, src/game/FogOfWar.js)
      fogOfWar: FOG.defaultMode,
    };
    // Entity ids (commands reference units by id, never by object – src/game/commands/CommandBus.js).
    // Ids are handed out in creation order, so they match on every client as long as creation is deterministic.
    this.entities = new Map(); // eid -> object
    this.nextEid = 1;
    // Deterministic simulation (src/config.js SIM): tick counter, the ONLY random generator the simulation may
    // use, and units whose models are still loading (spawnDeferred)
    this.tick = 0;             // ticks simulated so far; during update() = the number of the running tick
    this.rng = new Rng(SIM.defaultSeed);
    this.pendingSpawns = [];   // spawnDeferred / deferLoad entries { eid, due, ready, result, failed, apply… }, request order
    // Lockstep: a due spawn whose model is not loaded yet stalls the simulation (readyForTick) instead of
    // appearing later on this client only. Single player keeps going and spawns it as soon as it is loaded.
    this.waitForSpawns = false;
    this.production = null;    // production system ticked with the simulation (Production.js, agent PROD)
    this._ray = new THREE.Raycaster();
    this._origin = new THREE.Vector3();
    this.map = null;   // GameMap after loadMap (start positions, super node, obstacles)
    this.fog = null;   // FogOfWar after loadMap
    ground.geometry.computeBoundingBox();
    const box = ground.geometry.boundingBox;
    this.#createNav(Math.max(box.max.x - box.min.x, box.max.z - box.min.z));
  }

  // Pathfinding grid over the whole terrain; static units and map obstacles block it (buildings: add a source)
  #createNav(size) {
    this.nav = new NavGrid({ size });
    this.nav.addObstacleSource(() => this.mechs
      .filter(isStatic)
      .map((m) => ({ x: m.position.x, z: m.position.z, radius: m.radius, owner: m })));
    // Buildings (finished or not) and ore deposit cores
    // (a building may give several shapes in navShapes, e.g. a diagonal wall segment = a chain of circles)
    this.nav.addObstacleSource(() => this.structures.filter((s) => !s.removed).flatMap((s) => s.navShapes ?? s.obstacle));
    this.nav.addObstacleSource(() => (this.economy?.deposits ?? []).map((d) => d.obstacle).filter(Boolean));
    if (this.map) {
      const shapes = this.map.obstacleShapes(); // map obstacles never move
      this.nav.addObstacleSource(() => shapes);
    }
  }

  /**
   * Loads data/maps/<name>.json: reshapes the terrain, builds rocks / super node, re-creates the
   * pathfinding grid for the map size and starts the fog of war. Call before spawning units.
   * @returns {Promise<GameMap>}  also available as world.map (world.map.startPositions)
   */
  async loadMap(name) {
    const map = await GameMap.load(name);
    this.map?.dispose();
    this.map = map;
    this.ground.geometry.dispose();
    this.ground.geometry = buildTerrainGeometry(map.terrainOptions);
    map.build(this.scene, (x, z) => this.heightAt(x, z));
    this.#createNav(map.size);
    this.fog = new FogOfWar(this, map.size, { teamCount: this.settings.playerCount }); // [N5] missing = TEAMS.length
    for (const m of [this.ground.material, ...map.materials]) this.fog.patchMaterial(m);
    return map;
  }

  /**
   * Gives an object (unit, structure, wreck, deposit) its entity id `eid` once; commands refer to it by that id.
   * @returns {number} the id
   */
  register(obj) {
    if (obj.eid == null) obj.eid = this.nextEid++;
    if (!this.entities.has(obj.eid)) this.entities.set(obj.eid, obj); // id reserved earlier (spawnDeferred)
    return obj.eid;
  }

  /**
   * New match: seeds the generator and restarts the tick counter. Call once all starting units exist, right
   * before the first tick (every client with the same seed then rolls the same numbers).
   * @param {number|string} seed
   */
  startSimulation(seed) {
    this.rng.seed(seed);
    this.tick = 0;
  }

  /**
   * Deterministic spawn of a unit whose model loads asynchronously (production). The entity id is reserved
   * now, in request order, and the unit enters the world at the start of tick (now + SIM.spawnDelayTicks)
   * – or, in single player, at the first tick after its model finished loading. Call it from simulation code
   * (a command executor, a production update), never straight from UI events, or the ids differ between clients.
   * @param {() => Promise<object>} create  creates and loads the unit, e.g. () => new Crew(race, opts).load()
   * @param {(obj: object) => object} place  adds it to the world inside the tick, e.g. (c) => world.addCrew(c, x, z)
   * @returns {Promise<object>} resolves with what `place` returned (rejects when loading failed); `.eid` = reserved id
   */
  spawnDeferred(create, place) {
    return this.#defer(create, place, this.nextEid++);
  }

  /**
   * Same timing as spawnDeferred for any change that needs an async load first (e.g. ModularMech.replacePart):
   * `apply(result)` runs inside the tick (now + SIM.spawnDelayTicks), in request order. Put follow-up state
   * changes into `apply` (or a callback it calls) – a `.then` on the returned promise runs after the frame's
   * ticks, at a time that differs between clients.
   * @param {() => Promise<any>} load
   * @param {(result: any) => any} apply
   * @returns {Promise<any>} resolves with what `apply` returned
   */
  deferLoad(load, apply) {
    return this.#defer(load, apply, null);
  }

  /**
   * Population of a produced unit that is not in the world yet: the pending spawn with this reserved id counts
   * `supply` for `team` (pendingSupply → Economy.populationUsed) until it is applied (the unit is then counted as
   * a unit) or fails (the population is free again). Both happen only in #applySpawns, inside the tick.
   * @returns {boolean} false when no pending spawn has this id
   */
  holdSupply(eid, team, supply) {
    const entry = this.pendingSpawns.find((e) => e.eid === eid);
    if (!entry || !(supply > 0)) return false;
    entry.team = team;
    entry.supply = supply;
    return true;
  }

  /** Population held by a team's pending spawns (holdSupply); no allocation */
  pendingSupply(team) {
    let sum = 0;
    for (const e of this.pendingSpawns) if (e.team === team && e.supply > 0) sum += e.supply;
    return sum;
  }

  #defer(load, apply, eid) {
    const entry = { eid, due: this.tick + SIM.spawnDelayTicks, ready: false, result: null, failed: false, error: null, apply };
    const done = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    if (eid != null) done.eid = eid;
    this.pendingSpawns.push(entry);
    Promise.resolve().then(load).then(
      (result) => { entry.result = result; entry.ready = true; },
      (err) => { entry.error = err; entry.failed = true; entry.ready = true; },
    );
    return done;
  }

  /** false while a lockstep match must wait for a spawn model due in the next tick (see waitForSpawns) */
  readyForTick() {
    if (!this.waitForSpawns) return true;
    const next = this.tick + 1;
    return !this.pendingSpawns.some((e) => e.due <= next && !e.ready);
  }

  // Due deferred spawns / loads are applied in request order; one still loading holds back the ones after it
  #applySpawns() {
    while (this.pendingSpawns.length) {
      const e = this.pendingSpawns[0];
      if (e.due > this.tick || !e.ready) break;
      this.pendingSpawns.shift();
      if (e.failed) {
        console.error('[World] deferred load failed', e.error); // lockstep: a load failing on one client desyncs
        e.reject(e.error);
        continue;
      }
      if (e.eid != null && e.result) e.result.eid = e.eid; // world.register keeps the reserved id
      try { e.resolve(e.apply(e.result)); } catch (err) { console.error('[World] deferred apply failed', err); e.reject(err); }
    }
  }

  /** The object with this entity id, or null (it may be destroyed / removed – check its flags) */
  entityById(eid) { return this.entities.get(eid) ?? null; }

  /** Can the local player see this unit (fog of war)? Own units always */
  isVisible(unit) { return this.fog ? this.fog.isVisible(unit) : true; }

  heightAt(x, z) {
    const h = sampleHeightField(this.ground.geometry.userData.heightField, x, z);
    if (h !== null) return h;
    this._ray.set(this._origin.set(x, 1000, z), DOWN);
    const hit = this._ray.intersectObject(this.ground, false)[0];
    return hit ? hit.point.y : 0;
  }

  addMech(mech, x, z, yaw = 0) {
    mech.world = this;
    mech.position.set(x, this.heightAt(x, z), z);
    mech.rotation.y = yaw;
    this.register(mech);
    this.scene.add(mech);
    this.mechs.push(mech);
    return mech;
  }

  addCrew(crew, x, z, yaw = 0) {
    crew.world = this;
    crew.position.set(x, this.heightAt(x, z), z);
    crew.rotation.y = yaw;
    this.register(crew);
    this.scene.add(crew);
    this.crews.push(crew);
    return crew;
  }

  addVehicle(vehicle, x, z, yaw = 0) {
    vehicle.world = this;
    vehicle.position.set(x, 0, z);
    vehicle.snapToGround();
    vehicle.rotation.y = yaw;
    this.register(vehicle);
    this.scene.add(vehicle);
    this.vehicles.push(vehicle);
    return vehicle;
  }

  addStructure(structure, x, z) {
    structure.world = this;
    structure.position.set(x, this.heightAt(x, z), z);
    this.register(structure);
    this.scene.add(structure);
    this.structures.push(structure);
    return structure;
  }

  /** Every unit kind in the world (mechs, crews, vehicles, structures), alive or not – for HUD / fog / minimap */
  get allUnits() {
    return [...this.mechs, ...this.crews, ...this.vehicles, ...this.structures];
  }

  spawnWreck(part, fromMech) {
    const wreck = new ArmWreck(part, this, fromMech, fromMech.animLib);
    this.register(wreck);
    this.wrecks.push(wreck);
    return wreck;
  }

  /** Legs / torso thrown off a destroyed mech (loot, or charred debris with salvageable: false) */
  spawnSalvage(part, fromMech, opts) {
    const wreck = new SalvageWreck(part, this, fromMech, opts);
    this.register(wreck);
    this.salvage.push(wreck);
    return wreck;
  }

  /**
   * Picks up a salvage wreck (for the future builder unit that carries it to the assembly building,
   * where enemy-exclusive parts can be researched – rules.salvageResearch).
   * @returns {object|null} wreck.info { path, set, kind, race, hp, maxHp, team } or null if not available
   */
  takeSalvage(wreck) {
    if (!wreck.available) return null;
    wreck.dispose();
    this.scene.remove(wreck.object);
    this.salvage = this.salvage.filter((w) => w !== wreck);
    return wreck.info;
  }

  /** Wrecks weapons can hit: arms and salvageable legs / torsos on the ground (not charred debris) */
  get damageableWrecks() {
    return [...this.wrecks, ...this.salvage.filter((w) => w.salvageable)].filter((w) => !w.collected && !w.destroyed);
  }

  /**
   * A wreck shot to 0 HP: it explodes (VFX.wreckExplosion, sized by part kind) and disappears from the world.
   * A mech walking to collect it drops the order on its next update (wreck.available becomes false).
   */
  destroyWreck(wreck) {
    if (wreck.destroyed) return;
    wreck.destroyed = true;
    const box = wreck.bounds();
    const centre = box.getCenter(new THREE.Vector3());
    centre.y = this.heightAt(centre.x, centre.z);
    const kind = wreck.part.isArm ? 'arm' : wreck.part.stats.kind;
    this.effects.burst(VFX.wreckExplosion, centre, { size: VFX.wreckExplosionSize[kind] ?? 1 });
    wreck.dispose();
    wreck.part.setHighlighted(false);
    this.scene.remove(wreck.object);
    this.wrecks = this.wrecks.filter((w) => w !== wreck);
    this.salvage = this.salvage.filter((w) => w !== wreck);
  }

  /** Vrak sebral robot – vyřadí ho ze seznamu (objekt přesune socket.add) */
  takeWreck(wreck) {
    wreck.dispose();
    wreck.part.wreck = null;
    this.wrecks = this.wrecks.filter((w) => w !== wreck);
  }

  /**
   * Changes a team's colour and repaints all its units (robots, crews – later vehicles and buildings).
   * @param {number} team
   * @param {THREE.ColorRepresentation} color  the colour the player picked, e.g. '#d33'
   */
  setTeamColor(team, color) {
    TEAMS[team].color = `#${new THREE.Color(color).getHexString()}`;
    for (const unit of this.allUnits) if (unit.team === team) unit.refreshTeamColor();
  }

  /** Damage from a non-weapon source (burning…) – see Combat.dealDamage */
  dealDamage(attacker, unit, damage, source) { return dealDamage(attacker, unit, damage, source); }

  /** Runs fn after delay seconds of game time */
  schedule(delay, fn) {
    if (delay <= 0) fn();
    else this.events.push({ time: delay, fn });
  }

  /** All units that can take part in combat right now (mechs, crews outside mechs, vehicles, structures) */
  get units() {
    return this.allUnits.filter(isTargetable);
  }

  /**
   * Can `viewer` see `target`? Only the fog-of-war team is limited by sight (the opponent has no fog).
   * Every team has its own fog (FogOfWar keeps grids per team; allies share one), so the answer is the same on every client and
   * the AI sees only what its team sees. Never ask "can the local player see it" in simulation code.
   */
  canSee(viewer, target) {
    return !this.fog || this.fog.canTeamSee(viewer.team, target);
  }

  /** Nearest enemy of a unit within range (edge distance) it can see, optionally filtered */
  nearestEnemy(unit, range, filter = () => true) {
    let best = null;
    let bestDist = Infinity;
    for (const other of this.units) {
      if (!areEnemies(unit, other) || !filter(other) || !this.canSee(unit, other)) continue;
      const d = edgeDistance(unit, other);
      if (d <= range && d < bestDist) { best = other; bestDist = d; }
    }
    return best;
  }

  /** Meshe, na které lze kliknout: díly živých robotů + posádky venku + ležící vraky */
  get pickables() {
    return [
      ...this.mechs.filter((m) => this.isVisible(m)).flatMap((m) => m.pickables), // enemies in fog: not clickable
      ...this.crews.filter((c) => this.isVisible(c)).flatMap((c) => c.pickables),
      ...[...this.vehicles, ...this.structures].filter((u) => this.isVisible(u)).flatMap((u) => u.pickables),
      ...this.wrecks.flatMap((w) => w.part.meshes),
      ...this.salvage.filter((w) => w.salvageable).flatMap((w) => w.part.meshes),
    ];
  }

  /**
   * One simulation tick (main.js calls it with SIM_DT after commandBus.executeTick). Everything in here must be
   * deterministic: no Math.random (use this.rng), no wall-clock time, no reading the local player.
   */
  update(dt) {
    this.tick++;
    // Fresh world matrices: rendering (and its interpolation in main.js) leaves them at a between-ticks pose,
    // and code reading matrixWorld must see the same values on every client however often it renders
    this.scene.updateMatrixWorld();
    this.#applySpawns(); // produced units whose time has come (spawnDeferred)
    // Delayed actions first (they may damage units updated below)
    if (this.events.length) {
      const due = [];
      for (const e of this.events) if ((e.time -= dt) <= 0) due.push(e);
      this.events = this.events.filter((e) => e.time > 0);
      for (const e of due) e.fn();
    }
    this.nav.refresh(); // obstacle layout changed (crew boarded / left a mech) -> units re-plan
    for (const mech of this.mechs) mech.update(dt);
    for (const mech of this.mechs.filter((m) => m.removed)) this.scene.remove(mech);
    this.mechs = this.mechs.filter((m) => !m.removed);
    for (const crew of this.crews) crew.update(dt);
    for (const crew of this.crews.filter((c) => c.removed)) this.scene.remove(crew);
    this.crews = this.crews.filter((c) => !c.removed);
    for (const v of this.vehicles) v.update(dt);
    for (const s of this.structures) s.update(dt); // after the vehicles: builders registered this frame
    for (const u of [...this.vehicles, ...this.structures].filter((x) => x.removed)) { this.scene.remove(u); u.procModel?.dispose(); }
    this.vehicles = this.vehicles.filter((v) => !v.removed);
    this.structures = this.structures.filter((s) => !s.removed);
    this.economy?.update(dt); // income, deposit slots
    this.production?.update(dt); // production queues (Production.js) – part of the simulation, not the UI
    this.research?.update(dt); // captured parts delivered to research facilities (Research.js)
    updateStatusEffects(this, [...this.mechs, ...this.crews, ...this.vehicles], dt); // stun, knockback slide, burning
    resolveCollisions(this.units.filter((u) => !u.isStructure), this); // buildings block by pathfinding instead
    this.fog?.update(dt); // visibility grid, a few times per second
    for (const wreck of this.wrecks) wreck.update(dt, this);
    for (const wreck of this.salvage) wreck.update(dt, this);
    for (const wreck of this.salvage.filter((w) => w.removed)) this.scene.remove(wreck.object);
    this.salvage = this.salvage.filter((w) => !w.removed);
    // Stays in the tick: projectiles call back into the simulation when they arrive (Combat.resolveShot)
    this.effects.update(dt);
  }

  /**
   * Cheap hash of the simulation state for desync detection (compare between clients every N ticks):
   * tick, generator state, every unit (id, team, rounded position / facing, HP, order type, destroyed),
   * wrecks and every team's resources. Rounding (SIM.hash*Scale) keeps it robust to the last float bits.
   * @returns {number} uint32
   */
  stateHash() {
    let h = 0x811c9dc5; // FNV-1a offset basis
    const mix = (v) => { h = Math.imul(h ^ (v | 0), 0x01000193); };
    const mixText = (s) => { for (let i = 0; i < s.length; i++) mix(s.charCodeAt(i)); mix(s.length); };
    const pos = (v) => Math.round(v * SIM.hashPositionScale);
    const val = (v) => Math.round((v ?? 0) * SIM.hashValueScale);
    mix(this.tick);
    mix(this.rng.state);
    mix(this.nextEid);
    for (const u of this.allUnits) {
      mix(u.eid ?? -1);
      mix(u.team ?? -1);
      mix(pos(u.position.x));
      mix(pos(u.position.z));
      mix(Math.round(u.rotation.y * SIM.hashAngleScale));
      mix(val(u.isMech ? Object.values(u.parts).reduce((sum, p) => sum + p.hp, 0) : u.hp));
      mix(u.destroyed ? 1 : 0);
      mixText(u.order?.type ?? '');
    }
    for (const w of [...this.wrecks, ...this.salvage]) {
      mix(w.eid ?? -1);
      mix(pos(w.object.position.x));
      mix(pos(w.object.position.z));
      mix(val(w.part?.hp));
    }
    const eco = this.economy;
    if (eco?.accounts) {
      eco.accounts.forEach((_, team) => { for (const r of eco.resources ?? []) mix(val(eco.amount(team, r))); });
    }
    return h >>> 0;
  }
}
