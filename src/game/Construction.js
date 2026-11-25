// Steel Men – construction rules: where a building may stand, starting / cancelling a construction (cost paid
// in full at the start, a part refunded on cancel), the construction speed of N builders and the placement
// preview that follows the cursor (CommandInput.placement).
//
// Balance (stats.json → rules.construction):
//   cancelRefund        share of the cost returned when an unfinished building is cancelled
//   extraBuilderFactor  each further builder adds factor^k of one builder: rate(n) = Σ_{k<n} factor^k
//   unattendedRate      rate without any builder for races with construction.continuesWithoutBuilder – [N1] only
//                       after a builder started the building (markConstructionStarted); the builder may then leave
//   builderRange        units between a builder's edge and the building's footprint while it works
//   startHpFraction     HP share of a just-started building (grows with progress)
import * as THREE from 'three';
import { getStats, unitStats } from '../data/Stats.js';
import { PlacementHologram, createPreviewSource } from './PlacementHologram.js'; // [hologram]
import { PLACEMENT, CMD_BUILD, TERRAIN_FLATTEN } from '../config.js';
import { localTeam } from '../core/LocalPlayer.js';
import { modelFootprint } from '../units/Structure.js';
import { commandBus } from './commands/CommandBus.js';
import { newTicket, eidsOf, quantizeYaw } from './commands/buildCommands.js'; // also registers the build commands
import { buildFactor } from './Auras.js'; // [A9-buildings]

/**
 * Ground box (world axes) of a footprint turned to ANY yaw: the bounding box of the turned rectangle (pathfinding
 * boxes are axis-aligned, so a turned building blocks a little more than its model). At quarter turns it is exact.
 */
export function placementBox(fp, x, z, yaw) {
  const c = Math.abs(Math.cos(yaw));
  const s = Math.abs(Math.sin(yaw));
  return { x, z, halfX: fp.halfX * c + fp.halfZ * s, halfZ: fp.halfX * s + fp.halfZ * c };
}

/** [H1] Rate of a stats.selfBuild building: the speed of one builder, i.e. finished in stats.buildTime seconds */
const SELF_BUILD_RATE = 1;

/** Does a building of this race go on without builders once started (races[*].construction.continuesWithoutBuilder)? */
export const continuesAlone = (race) => Boolean(getStats().races?.[race]?.construction?.continuesWithoutBuilder);

/**
 * Construction speed of a building of this race with n builders (1 = one builder).
 * @param {boolean} [started]  a builder has already worked on it ([N1] markConstructionStarted): only then a building
 *   of a continuesWithoutBuilder race goes on alone – until a builder arrives it waits like any other
 */
export function buildRate(race, builders, started = true) {
  const rules = getStats().rules.construction ?? {};
  if (builders <= 0) {
    return started && continuesAlone(race) ? (rules.unattendedRate ?? 1) : 0;
  }
  const f = rules.extraBuilderFactor ?? 1;
  let rate = 0;
  for (let k = 0; k < builders; k++) rate += f ** k;
  return rate;
}

/**
 * [N1] Simulation step of an unfinished building (Structure.update, right after it takes this tick's builders):
 * the first tick with a builder marks it started (structure.constructionStarted) – the builder "gives the first HP".
 */
export function markConstructionStarted(structure) {
  if (!structure.constructionStarted && structure.builders.size > 0) structure.constructionStarted = true;
  // [W5b] the real start: the deferred part of the cost (energy, structure.constructionDue) is paid now; until the
  // team has it the building does not grow (structureBuildRate 0)
  const due = structure.constructionDue;
  if (due && structure.constructionStarted && !structure.complete) {
    const eco = structure.world?.economy;
    if (!eco || !eco.hasDue(due) || eco.payDue(structure.team, due, structure.constructionPaid)) structure.constructionDue = null;
  }
}

/** [N1] Current construction speed of a building (Structure.buildRate): its builders and whether it was started */
export function structureBuildRate(structure) {
  if (structure.stats?.selfBuild) return SELF_BUILD_RATE * buildFactor(structure); // [H1] builds itself (wall gate), any race, no builder
  if (structure.constructionDue) return 0; // [W5b] waits for the deferred part of its cost
  // [A9-buildings] × construction enhancer aura (Auras.js; 1 outside any aura)
  return buildRate(structure.race, structure.builders.size, structure.constructionStarted === true) * buildFactor(structure);
}

/**
 * [W5b] A just placed unfinished building: the deferred part of its cost (Economy.dueOf, energy) is due when the first
 * builder starts it (markConstructionStarted). Call after economy.payUpfront(team, cost) in the placing command.
 */
export function setConstructionDue(economy, structure, cost = {}) {
  structure.constructionDue = economy?.dueOf(cost) ?? null;
  structure.constructionPaid = structure.constructionDue ? {} : null;
}

/**
 * [W5b] Refund of a cancelled unfinished building: factor × (its cost without the deferred part + what of the
 * deferred part was paid). Buildings placed without setConstructionDue refund their whole cost as before.
 */
export function refundConstruction(economy, structure, factor) {
  if (!economy) return;
  const cost = structure.stats?.cost ?? {};
  if (structure.constructionPaid === undefined) economy.refund(structure.team, cost, factor);
  else economy.refundPaid(structure.team, cost, structure.constructionPaid, factor);
}

/** Box (x, z, halfX, halfZ) against a NavGrid shape (circle or box) */
function overlaps(box, s) {
  if (s.radius !== undefined) {
    const dx = Math.max(Math.abs(s.x - box.x) - box.halfX, 0);
    const dz = Math.max(Math.abs(s.z - box.z) - box.halfZ, 0);
    return Math.hypot(dx, dz) < s.radius;
  }
  return Math.abs(s.x - box.x) < s.halfX + box.halfX && Math.abs(s.z - box.z) < s.halfZ + box.halfZ;
}

/**
 * Can a building with this footprint box stand here? Inside the map, off obstacles (map, buildings, deposits,
 * crewless mechs), off the super node platform, not on top of a unit.
 * @param {object} box      { x, z, halfX, halfZ }
 * @param {Array} [ignore]  units allowed to stand inside (the builders – they step out by pathfinding)
 * @param {number} [margin] distance kept from the map edge (walls pass CMD_WALL.edgeMargin to reach it)
 * @returns {boolean}
 */
export function canPlace(world, box, ignore = [], margin = PLACEMENT.mapMargin) {
  const map = world.map;
  const lim = (map?.half ?? world.nav.half) - margin;
  if (Math.abs(box.x) + box.halfX > lim || Math.abs(box.z) + box.halfZ > lim) return false;
  for (const s of world.nav.obstacles()) if (!ignore.includes(s.owner) && overlaps(box, s)) return false;
  for (const d of world.economy?.deposits ?? []) {
    const keep = (d.superNode ? map?.superNode?.radius ?? d.radius : d.radius) + PLACEMENT.depositClearance;
    if (overlaps(box, { x: d.x, z: d.z, radius: keep })) return false;
  }
  for (const u of [...world.mechs, ...world.crews, ...world.vehicles]) {
    if (u.destroyed || u.removed || u.inside || u.airborne || ignore.includes(u)) continue; // [NQ3] aircraft fly over
    if (overlaps(box, { x: u.position.x, z: u.position.z, radius: u.radius })) return false;
  }
  return true;
}

// ---------- terrain under a building (reminder 18) ----------

/**
 * Terrain under a footprint box: samples its heights (grid over the box, edges and corners included) and returns the
 * level a building would stand on (middle of the range, rounded) and whether the slope is acceptable.
 * Deterministic: only reads the height field (same on every client, see flattenTerrain).
 * @returns {{ level: number, delta: number, ok: boolean }}
 */
export function terrainFit(world, box) {
  const step = TERRAIN_FLATTEN.sampleStep;
  const nx = Math.max(1, Math.ceil((box.halfX * 2) / step));
  const nz = Math.max(1, Math.ceil((box.halfZ * 2) / step));
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i <= nx; i++) {
    for (let j = 0; j <= nz; j++) {
      const h = world.heightAt(box.x - box.halfX + (i / nx) * box.halfX * 2, box.z - box.halfZ + (j / nz) * box.halfZ * 2);
      if (h < low) low = h;
      if (h > high) high = h;
    }
  }
  const res = TERRAIN_FLATTEN.heightResolution;
  const level = Math.round(((low + high) / 2) * res) / res;
  const delta = high - low;
  // The limit grows with the footprint: a slope (height per unit of the longest side) is what matters, so a big
  // building is not refused where a small one fits; small buildings keep the flat maxHeightDelta
  const allowed = Math.max(TERRAIN_FLATTEN.maxHeightDelta, TERRAIN_FLATTEN.maxSlope * 2 * Math.max(box.halfX, box.halfZ));
  return { level, delta, ok: delta <= allowed };
}

/**
 * Levels the terrain under a building: every height-field vertex inside the footprint box (plus TERRAIN_FLATTEN.margin)
 * gets `level`, except vertices under another building (their ground stays). Changes the height field (heightAt for
 * units, line of sight) and the terrain mesh. Call it from a command executor only, on every client in the same order.
 */
export function flattenTerrain(world, box, level) {
  const geo = world.ground?.geometry;
  const field = geo?.userData?.heightField;
  if (!field) return;
  const { size, segments, heights } = field;
  const cell = size / segments;
  const row = segments + 1;
  const m = TERRAIN_FLATTEN.margin;
  const half = size / 2;
  const toIndex = (v) => (v + half) / cell;
  const ix0 = Math.max(0, Math.ceil(toIndex(box.x - box.halfX - m)));
  const ix1 = Math.min(segments, Math.floor(toIndex(box.x + box.halfX + m)));
  const iz0 = Math.max(0, Math.ceil(toIndex(box.z - box.halfZ - m)));
  const iz1 = Math.min(segments, Math.floor(toIndex(box.z + box.halfZ + m)));
  const others = (world.structures ?? []).filter((s) => !s.destroyed && !s.removed && s.obstacle);
  const pos = geo.attributes.position;
  let changed = false;
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const x = ix * cell - half;
      const z = iz * cell - half;
      if (others.some((s) => Math.abs(x - s.obstacle.x) <= s.obstacle.halfX && Math.abs(z - s.obstacle.z) <= s.obstacle.halfZ)) continue;
      const i = iz * row + ix;
      heights[i] = level;
      pos.setY(i, level);
      changed = true;
    }
  }
  if (!changed) return;
  pos.needsUpdate = true;
  geo.computeVertexNormals();
}

/**
 * Orders a new building as a `placeStructure` command: the simulation checks the spot, pays the full cost, creates the
 * unfinished building and sends the builders (queued = behind their current orders). The result arrives later:
 * `onResult({ structure } | { error: 'resources'|'blocked'|'limit'|'invalid' })`.
 */
export function orderConstruction({ team = localTeam(), race, id, x, z, yaw = 0, builders = [], queued = false, onResult }) {
  const ticket = newTicket(team, (res) => onResult?.(res));
  commandBus.submit({ type: 'placeStructure', team, race, unitId: id, x, z, yaw: quantizeYaw(yaw), builders: eidsOf(builders), queued, ticket });
}

/** Cancels an unfinished building (command): the simulation returns rules.construction.cancelRefund of its cost */
export function cancelConstruction(world, structure) {
  if (structure.complete || structure.destroyed) return false;
  commandBus.submit({ type: 'cancelConstruction', team: structure.team, structure: structure.eid });
  return true;
}

/**
 * Transparent copy of a building that follows the cursor (green = can be placed, red = blocked).
 * CommandInput calls move(point) / confirm(point) / cancel() while it is set as input.placement.
 */
export class PlacementGhost {
  /**
   * @param {object} opts { world, team, race, id, yaw (any angle – the building turns smoothly), builders, onPlaced(result), onEnd(),
   *   blockedReason() – '' or why another building may not be placed now (e.g. per-team limit),
   *   onStart() – a construction was just ordered (it exists only after the placeStructure command ran;
   *   onPlaced(res) follows then, also with an error) }
   */
  constructor({ world, team = localTeam(), race, id, yaw = 0, builders = [], onPlaced, onEnd, blockedReason, onStart }) {
    Object.assign(this, { world, team, race, id, builders, onPlaced, onEnd, blockedReason, onStart });
    this.yaw = yaw;
    this.object = null;
    this.fp = null;
    this.valid = false;
    this.point = null;
    this.ended = false;
    this.placedCount = 0;            // buildings ordered by this placement (Shift keeps placing)
    this.chain = Promise.resolve();  // constructions start one after another, in placement order
  }

  async init() {
    const stats = unitStats('structures', this.id, this.race);
    const fp = await modelFootprint(this.id, this.race);
    const source = await createPreviewSource({ id: this.id, race: this.race, team: this.team, stats, fp }); // [hologram]
    if (this.ended) return this;
    this.fp = fp;
    this.hologram = new PlacementHologram(this.team);
    this.source = source;
    const model = source.create();
    this.hologram.apply(model, source.proc ? model : null);
    this.model = model;
    const object = new THREE.Group();
    object.add(model);
    object.rotation.y = this.yaw;
    object.visible = false;
    this.world.scene.add(object);
    this.object = object;
    if (this.point) this.move(this.point);
    return this;
  }

  get box() { return this.point && this.fp ? placementBox(this.fp, this.point.x, this.point.z, this.yaw) : null; }

  /** Turns the preview by CMD_BUILD.keyRotateStep (dir 1 / -1; holding the key keeps turning) and re-checks the spot */
  rotate(dir = 1) { this.setYaw(this.yaw + dir * CMD_BUILD.keyRotateStep); }

  /** Sets the rotation (any angle) and re-checks the spot */
  setYaw(yaw) {
    this.yaw = yaw;
    if (this.object) this.object.rotation.y = this.yaw;
    if (this.point) this.move(this.point);
  }

  move(point) {
    this.point = point;
    if (!point) { // [I2] pointer off the map (the ground raycast misses): the ghost stays where it was, but red and unplaceable
      this.valid = false;
      if (this.object && this.model) this.hologram.setValid(this.model, false);
      return;
    }
    if (!this.object) return;
    this.object.visible = true;
    const fit = this.fp ? terrainFit(this.world, this.box) : null; // [R6] the building stands on levelled ground
    this.object.position.set(point.x, fit ? fit.level : this.world.heightAt(point.x, point.z), point.z);
    this.valid = canPlace(this.world, this.box, this.builders) && (fit?.ok ?? true);
    this.hologram.setValid(this.model, this.valid);
  }

  /**
   * Left click: starts the construction when the spot is free. With `keep` (Shift held) the preview stays for
   * the next building of the same type, unless blockedReason() says no more may be placed.
   * @returns {boolean} true when placement is over
   */
  confirm(point, keep = false) {
    this.move(point);
    if (!this.valid || !this.object) return false;
    const reason = this.blockedReason?.() ?? '';
    if (reason) { this.onPlaced?.({ error: 'limit', reason }); this.cancel(); return true; }
    const { x, z } = point;
    this.onStart?.();
    // The first building of this placement is a new order for the builders – unless Shift is held, then it
    // waits behind their current orders (OrderQueue.js); the next ones join their queue. Commands run in
    // submission order, so the buildings are created – and queued – in placement order
    const queued = this.placedCount > 0 || keep;
    this.placedCount += 1;
    orderConstruction({
      team: this.team, race: this.race, id: this.id, x, z, yaw: this.yaw, builders: this.builders, queued,
      onResult: (res) => this.#placed(res),
    });
    if (keep && !this.blockedReason?.()) return false;
    this.cancel();
    return true;
  }

  // Result of a command: the sim's limit / requirement errors are reported as a plain blocked spot
  #placed(res) {
    this.onPlaced?.(res.error === 'limit' || res.error === 'invalid' ? { error: 'blocked' } : res);
  }

  cancel() {
    if (this.ended) return;
    this.ended = true;
    if (this.object) {
      this.world.scene.remove(this.object);
      this.source.release(this.model);  // [hologram] procedural model: dispose(); GLB: just detached (shared geometry)
      this.hologram.dispose();
      this.model = null;
    }
    this.onEnd?.();
  }
}
