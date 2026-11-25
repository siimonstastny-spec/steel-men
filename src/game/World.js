// Steel Men – herní svět: roboti, posádky, vraky, výška terénu, časovače a efekty boje – SIT
import * as THREE from 'three';
import { ArmWreck } from '../units/ArmWreck.js';
import { SalvageWreck } from '../units/SalvageWreck.js';
import { Effects } from './Effects.js';
import { isTargetable, areEnemies, edgeDistance, dealDamage } from './Combat.js';
import { updateStatusEffects } from './StatusEffects.js';
import { resolveCollisions, isStatic } from './Movement.js';
import { NavGrid } from './Pathfinding.js';
import { refreshTerrainRules, unitTerrainFactor } from './TerrainTypes.js'; // [A14-terrain]
import { GameMap } from './Map.js';
import { FogOfWar } from './FogOfWar.js';
import { Auras } from './Auras.js'; // [A9-buildings]
import { Stealth } from './Stealth.js'; // [A9-buildings]
import { Superweapons } from './Superweapons.js'; // [A9-superweapons]
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
    // [I1] Lockstep rule everywhere (single player, multiplayer, tests): a due spawn whose model is not loaded yet,
    // or a load registered with trackLoad (building model, AI data, AI footprint), stalls the simulation
    // (readyForTick) – nothing ever enters the world "when its model happens to be loaded".
    this.loadsInFlight = 0;    // trackLoad promises not settled yet
    this.warnedLateSpawn = false; // #applySpawns reported a tick run without readyForTick (once)
    this.networked = false;    // [I1] a lockstep match is running (Lockstep.js start / stop → setNetworked)
    // [A1-3] lockstep only: loads the watchdog saw hanging, or that failed for good, while the match waits for them.
    // > 0 = the match is held on this client (Lockstep.status.loadStall → "loading stuck" notice). Not simulation state.
    this.stalledLoads = 0;
    // [I1] true = the game loop (main.js advanceSimulation) runs no ticks; a harness ticks by itself (world.update,
    // ai.fastForward, steelMen.det). Not part of the simulation state; startSimulation leaves it as it is.
    this.paused = false;
    this.production = null;    // production system ticked with the simulation (Production.js, agent PROD)
    this.superweapons = new Superweapons(this); // [A9-superweapons] charge, strikes, impacts (src/game/Superweapons.js)
    // [A9-buildings] enhancer auras / designation / building self-repair and cloak / detection; their state lives on the
    // units and is recomputed on tick-modulo cadences, so one instance serves every match
    this.auras = new Auras(this);
    this.stealth = new Stealth(this);
    this._ray = new THREE.Raycaster();
    this._origin = new THREE.Vector3();
    this.map = null;   // GameMap after loadMap (start positions, super node, obstacles)
    this.fog = null;   // FogOfWar after loadMap
    this.terrainTypes = null; // [A8-terrain] TerrainTypeGrid after loadMap ([A14-terrain] Movement speed + nav cost grids)
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
   * [A14-terrain] Speed factor of the terrain under a unit for its chassis class (1 = full speed, 0 = impassable;
   * 1 without a terrain layer). For UI / tests; Movement applies it by itself.
   */
  terrainSpeedAt(unit) { return unitTerrainFactor(unit); }

  /**
   * [A14-terrain] Re-reads stats.json rules.terrain (after changing it in memory) and rebuilds the path cost grids;
   * units re-plan (nav.version). Tests / tools only – in a multiplayer match every client would have to do the same.
   */
  applyTerrainRules() {
    refreshTerrainRules();
    this.nav.setTerrain(this.terrainTypes);
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
    this.terrainTypes = map.terrainTypes; // [A8-terrain] TerrainTypeGrid built by GameMap (A14 reads it)
    this.ground.geometry.dispose();
    this.ground.geometry = buildTerrainGeometry(map.terrainOptions);
    map.build(this.scene, (x, z) => this.heightAt(x, z));
    this.#createNav(map.size);
    this.nav.setTerrain(this.terrainTypes); // [A14-terrain] path cost grids per chassis class
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
   * [I1] Every match waits for due spawns (readyForTick). [A1-3] src/net/Lockstep.js calls setNetworked(true) on start
   * and setNetworked(false) on stop: it marks a running lockstep match (read by the load watchdog). Leaving the lockstep
   * also ends `multiplayer` (set by main.js startGame), so the watchdog of a later single-player phase may give up again.
   * @param {boolean} on
   */
  setNetworked(on) {
    this.networked = Boolean(on);
    if (!this.networked) this.multiplayer = false;
  }

  /** [A1-3] Kept for older callers (consoles, old notes): same as setNetworked(v); always reads true */
  get waitForSpawns() { return true; }
  set waitForSpawns(v) { this.setNetworked(v); }

  /**
   * [I1] May the load watchdog give up a load? Only in single player. In a lockstep match a local real-time timeout
   * would drop a spawn on this client only (desync): there the watchdog only reports and the client keeps waiting.
   */
  #watchdogMayGiveUp() { return !this.multiplayer && !this.networked; }

  /** [A1-3] Lockstep watchdog notice; silent once the match has a result (nobody waits for the load any more) */
  #reportStillWaiting(what) {
    if (this.match?.result) return;
    console.error(`[World] ${what} still pending after ${SIM.loadTimeoutMs} ms – lockstep match keeps waiting`);
  }

  /**
   * [I1] An async load the simulation depends on (a building's model, AI data, a footprint the AI asked for):
   * no tick runs until it settles (readyForTick), so its result is there at the same tick on every machine,
   * however fast it loads. Call it from simulation code / AI, never for purely visual loads.
   * [A1-3] holdOnFailure: the simulation differs when the load fails (e.g. a building without its model). In a lockstep
   * match a rejection then keeps the tick held (stalledLoads) instead of going on without it on this client only;
   * single player is unchanged (a rejection releases the tick).
   * @param {Promise<any>} promise
   * @param {{holdOnFailure?: boolean}} [opts]
   * @returns {Promise<any>} the same promise
   */
  trackLoad(promise, { holdOnFailure = false } = {}) {
    this.loadsInFlight++;
    let timer = 0;
    let stalled = false;
    const done = () => {
      if (!timer) return; // settled already (or given up by the watchdog)
      clearTimeout(timer);
      timer = 0;
      this.loadsInFlight--;
      if (stalled) { stalled = false; this.stalledLoads--; }
    };
    const failed = (err) => {
      if (!timer || !holdOnFailure || this.#watchdogMayGiveUp()) { done(); return; }
      clearTimeout(timer);
      timer = 0; // loadsInFlight stays: the lockstep match is held on purpose (going on would desync)
      if (!stalled) { stalled = true; this.stalledLoads++; }
      console.error('[World] tracked load failed – lockstep match held (going on without it would desync)', err);
    };
    // Watchdog (SIM.loadTimeoutMs): in single player a request that never answers must not freeze the match (real time
    // only ends the stall); in a lockstep match it only reports – giving up on one client would desync
    timer = setTimeout(() => {
      if (!this.#watchdogMayGiveUp()) {
        if (!stalled) { stalled = true; this.stalledLoads++; }
        this.#reportStillWaiting('tracked load');
        return;
      }
      console.error(`[World] tracked load still pending after ${SIM.loadTimeoutMs} ms – no longer waiting`);
      done();
    }, SIM.loadTimeoutMs);
    Promise.resolve(promise).then(done, failed);
    return promise;
  }

  /**
   * [A1-3] Runs `load()` now; in a lockstep match a rejection is retried (SIM.lockstepLoadRetries × lockstepLoadRetryMs,
   * real time only), like #defer does. Single player: the first rejection is passed on unchanged. Meant for
   * trackLoad(world.retryLoad(() => x.load()), { holdOnFailure: true }); `load` must be re-runnable.
   * @param {() => Promise<any>} load
   * @returns {Promise<any>}
   */
  retryLoad(load) {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const fail = (err) => {
        if (this.#watchdogMayGiveUp() || attempts >= SIM.lockstepLoadRetries) { reject(err); return; }
        attempts++;
        console.error(`[World] tracked load failed – retry ${attempts}/${SIM.lockstepLoadRetries}, lockstep match waits`, err);
        setTimeout(attempt, SIM.lockstepLoadRetryMs);
      };
      const attempt = () => {
        let p;
        try { p = load(); } catch (err) { fail(err); return; }
        Promise.resolve(p).then(resolve, fail);
      };
      attempt();
    });
  }

  /**
   * Deterministic spawn of a unit whose model loads asynchronously (production). The entity id is reserved
   * now, in request order, and the unit enters the world at the start of tick (now + SIM.spawnDelayTicks),
   * on every client and in single player alike: if its model is not loaded by then, that tick waits for it
   * (readyForTick) – the game loop, ai.fastForward and steelMen.det all check it. Call it from simulation code
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
    const entry = { eid, due: this.tick + SIM.spawnDelayTicks, ready: false, result: null, failed: false, error: null, apply, attempts: 0, stalled: false };
    const done = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    if (eid != null) done.eid = eid;
    this.pendingSpawns.push(entry);
    const stall = () => { if (!entry.stalled) { entry.stalled = true; this.stalledLoads++; } };
    const unstall = () => { if (entry.stalled) { entry.stalled = false; this.stalledLoads--; } };
    // Watchdog (SIM.loadTimeoutMs): single player fails the spawn instead of freezing the match; a lockstep match only
    // reports and keeps waiting (see trackLoad)
    const timer = setTimeout(() => {
      if (entry.ready) return;
      if (!this.#watchdogMayGiveUp()) {
        stall();
        this.#reportStillWaiting('deferred load');
        return;
      }
      entry.error = new Error(`deferred load still pending after ${SIM.loadTimeoutMs} ms`);
      entry.failed = true;
      entry.ready = true;
    }, SIM.loadTimeoutMs);
    // [A1-3] K3-1: a rejected load fails the spawn only in single player. In a lockstep match failing it on this client
    // alone would desync (the others place the unit): the load is retried (SIM.lockstepLoadRetries × lockstepLoadRetryMs,
    // real time only delays it – the spawn still happens in its due tick, which waits), then the match stays held.
    const failed = (err) => {
      if (entry.ready) return;
      if (!this.#watchdogMayGiveUp()) {
        if (entry.attempts < SIM.lockstepLoadRetries) {
          entry.attempts++;
          console.error(`[World] deferred load failed – retry ${entry.attempts}/${SIM.lockstepLoadRetries}, lockstep match waits`, err);
          setTimeout(attempt, SIM.lockstepLoadRetryMs);
          return;
        }
        clearTimeout(timer);
        stall();
        console.error('[World] deferred load failed for good – lockstep match held (dropping the spawn would desync)', err);
        return;
      }
      clearTimeout(timer); entry.error = err; entry.failed = true; entry.ready = true;
    };
    const loaded = (result) => {
      clearTimeout(timer);
      unstall();
      if (entry.ready) { // given up by the watchdog (single player): the late unit never enters the world
        console.error('[World] deferred load finished after the watchdog gave up – result dropped');
        // released like a removed unit in update() (units have no dispose(); GLB clones share the cached assets)
        try {
          if (typeof result?.dispose === 'function') result.dispose();
          else { result?.procVisual?.dispose?.(); result?.procModel?.dispose?.(); }
        } catch (err) { console.error(err); }
        return;
      }
      entry.result = result; entry.ready = true;
    };
    const attempt = () => { Promise.resolve().then(load).then(loaded, failed); };
    attempt();
    return done;
  }

  /**
   * false while the next tick must wait: a spawn due in it whose model is still loading, or a trackLoad in flight.
   * Every caller of world.update checks it first (game loop, ai.fastForward, steelMen.det); no allocation.
   */
  readyForTick() {
    if (this.loadsInFlight > 0) return false;
    const next = this.tick + 1;
    for (const e of this.pendingSpawns) if (e.due <= next && !e.ready) return false;
    return true;
  }

  // Due deferred spawns / loads are applied in request order. One still loading here means the caller ignored
  // readyForTick: it is applied late (desync on this machine) and reported once.
  #applySpawns() {
    while (this.pendingSpawns.length) {
      const e = this.pendingSpawns[0];
      if (e.due > this.tick) break;
      if (!e.ready) {
        if (!this.warnedLateSpawn) console.warn(`[World] tick ${this.tick} ran before a due spawn loaded (readyForTick not checked) – not deterministic`);
        this.warnedLateSpawn = true;
        break;
      }
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
    for (const mech of this.mechs.filter((m) => m.removed)) { this.scene.remove(mech); mech.procVisual?.dispose(); mech.attackFx?.dispose(); } // [proc-robot] [B5 glb-fx]
    this.mechs = this.mechs.filter((m) => !m.removed);
    for (const crew of this.crews) crew.update(dt);
    for (const crew of this.crews.filter((c) => c.removed)) this.scene.remove(crew);
    this.crews = this.crews.filter((c) => !c.removed);
    for (const v of this.vehicles) v.update(dt);
    for (const s of this.structures) s.update(dt); // after the vehicles: builders registered this frame
    this.research?.noteDestroyedVehicles?.(this.vehicles); // [A9-buildings] vehicle wrecks for archeology (before removal)
    for (const u of [...this.vehicles, ...this.structures].filter((x) => x.removed)) { this.scene.remove(u); u.procModel?.dispose(); u.procDriver?.dispose(); }
    this.vehicles = this.vehicles.filter((v) => !v.removed);
    this.structures = this.structures.filter((s) => !s.removed);
    this.economy?.update(dt); // income, deposit slots
    this.superweapons.update(dt); // [A9-superweapons] after Economy: charge energy, phase power-off overrides structure.powered
    this.auras.update(dt); // [A9-buildings] after Economy (structure.powered), before Production (aura production speed)
    this.stealth.update(dt); // [A9-buildings] cloak / detection, before the fog recompute
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
