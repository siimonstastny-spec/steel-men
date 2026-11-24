// Steel Men – building batcher (roadmap 18, phase P, docs/notes/proc-perf.md). The static body, the emblem decals and
// the frozen "far" parts (e.g. the solar panel) of every finished procedural building are drawn as InstancedMesh:
// one group per (geometry, material) – a group is one draw call whatever the number of buildings, so draw calls grow
// with the number of building types / styles / LOD levels, not with buildings. Animated parts and glow meshes stay
// ordinary meshes of the model and exist only at LOD0 (a few buildings near the camera, BUILDING_LOD.maxFull).
//
//   Per-instance data: the world matrix (written when a building is placed in a group – buildings never move after
//   they are finished) and aInst = (team colour rgb, hover highlight): rewritten only when the team colour or the
//   highlight changes. Both live in the group's InstancedBufferAttributes; nothing is allocated per frame.
//   LOD: every BUILDING_LOD.updateFrames rendered frames (and at once after a quality change) the batcher measures the
//   camera distance of every building and moves it between groups (remove = swap with the last instance, add = append).
//   Hysteresis stops flicker at a limit. All of it runs in scene.onBeforeRender, i.e. before three builds the render list
//   (so a building moved between groups never misses a frame) and only on the render side – never in the simulation.
//   Fog of war: ProcModel.tick() sees `visible = false` on the Structure and calls setVisible(): the building's
//   instances are removed from their groups until it is visible again.
//   Picking: the ProcModel keeps its static mesh as an invisible proxy with the coarsest LOD geometry (Structure.pickables).
import * as THREE from 'three';
import { BUILDING_LOD } from '../config.js';
import { getBuildingQuality, onBuildingQualityChange, noteRenderFrame } from '../core/Graphics.js';
import { setPanelTextureSize } from './ProcKit.js';

const MATRIX_FLOATS = 16;
const INST_FLOATS = 4;
const GROWTH = 2;

const _camPos = new THREE.Vector3();
const noRaycast = () => {};

// Panel texture resolution follows the quality level (also for buildings that are not batched yet)
setPanelTextureSize(getBuildingQuality().textureSize);
onBuildingQualityChange((q) => setPanelTextureSize(q.textureSize));

/** One InstancedMesh: all instances share a geometry and a material */
class BatchGroup {
  constructor(batcher, key, source, item) {
    this.batcher = batcher;
    this.key = key;
    this.source = source;                       // shared geometry (attributes are shared, not copied)
    this.material = item.acquire();
    this.release = item.release;
    this.baseCast = item.castShadow;
    this.receive = item.receiveShadow;
    this.items = [];
    this.capacity = 0;
    this.mesh = null;
    this.emptyFrame = batcher.frame;
    this.#alloc(BUILDING_LOD.initialCapacity);
  }

  // New InstancedMesh with the given capacity (the old one's instances are copied, the old one is disposed)
  #alloc(capacity) {
    const old = this.mesh;
    const geometry = new THREE.BufferGeometry();
    for (const [name, attr] of Object.entries(this.source.attributes)) geometry.setAttribute(name, attr);
    if (this.source.index) geometry.setIndex(this.source.index);
    geometry.setAttribute('aInst', new THREE.InstancedBufferAttribute(new Float32Array(capacity * INST_FLOATS), INST_FLOATS).setUsage(THREE.DynamicDrawUsage));
    const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.name = `BuildingBatch:${this.key}`;
    mesh.frustumCulled = false;   // the instances are spread over the map; the GPU clips them
    mesh.raycast = noRaycast;     // picking goes through the models' proxies
    mesh.castShadow = this.baseCast && this.batcher.shadows;
    mesh.receiveShadow = this.receive;
    mesh.count = this.items.length;
    mesh.visible = mesh.count > 0;
    if (old) {
      mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, this.items.length * MATRIX_FLOATS));
      geometry.attributes.aInst.array.set(old.geometry.attributes.aInst.array.subarray(0, this.items.length * INST_FLOATS));
      this.batcher.scene.remove(old);
      old.dispose();
      this.#freeGeometry(old.geometry);
    }
    this.batcher.scene.add(mesh);
    this.mesh = mesh;
    this.capacity = capacity;
  }

  add(item, matrix, model) {
    if (this.items.length === this.capacity) this.#alloc(this.capacity * GROWTH);
    const i = this.items.length;
    this.items.push(item);
    item.group = this;
    item.slot = i;
    matrix.toArray(this.mesh.instanceMatrix.array, i * MATRIX_FLOATS);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.writeInst(item, model);
    this.mesh.count = i + 1;
    this.mesh.visible = true;
  }

  remove(item) {
    const last = this.items.length - 1;
    const i = item.slot;
    if (i !== last) {   // move the last instance into the gap
      const matrices = this.mesh.instanceMatrix.array;
      const inst = this.mesh.geometry.attributes.aInst.array;
      matrices.copyWithin(i * MATRIX_FLOATS, last * MATRIX_FLOATS, (last + 1) * MATRIX_FLOATS);
      inst.copyWithin(i * INST_FLOATS, last * INST_FLOATS, (last + 1) * INST_FLOATS);
      const moved = this.items[last];
      this.items[i] = moved;
      moved.slot = i;
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.geometry.attributes.aInst.needsUpdate = true;
    }
    this.items.pop();
    item.group = null;
    item.slot = -1;
    this.mesh.count = last;
    this.mesh.visible = last > 0;
    if (last === 0) this.emptyFrame = this.batcher.frame;
  }

  writeInst(item, model) {
    const attr = this.mesh.geometry.attributes.aInst;
    const o = item.slot * INST_FLOATS;
    const b = model.batch;
    attr.array[o] = b.team.r * item.colorScale;
    attr.array[o + 1] = b.team.g * item.colorScale;
    attr.array[o + 2] = b.team.b * item.colorScale;
    attr.array[o + 3] = b.highlight;
    attr.needsUpdate = true;
  }

  setShadows(on) { this.mesh.castShadow = this.baseCast && on; }

  // Detach the attributes shared with the source geometry first, so dispose() frees only this group's own aInst buffer
  #freeGeometry(geometry) {
    for (const name of Object.keys(this.source.attributes)) geometry.deleteAttribute(name);
    geometry.setIndex(null);
    geometry.dispose();
  }

  dispose() {
    this.batcher.scene.remove(this.mesh);
    this.mesh.dispose();
    this.#freeGeometry(this.mesh.geometry);
    this.release(this.material);
    this.mesh = null;
    this.items.length = 0;
  }
}

/** Batcher of one scene (see batcherFor) */
class Batcher {
  constructor(scene) {
    this.scene = scene;
    this.models = [];                 // registered ProcModels (model.batch holds their state)
    this.groups = new Map();          // key -> BatchGroup
    this.frame = 0;                   // rendered frames
    this.dirty = true;                // decide all LODs at the next frame
    this.forceAll = true;             // re-apply every LOD (quality changed)
    this.shadows = getBuildingQuality().shadows;
    this.disposed = false;
    this.candidates = [];             // scratch list of the LOD0 candidates
    this.lastSweep = 0;
    // one persistent hook per scene (sceneHooks): a disposed batcher leaves a pass-through that the next batcher of the
    // scene reuses, so the onBeforeRender chain never grows when batchers come and go (other hooks may chain after it)
    let entry = sceneHooks.get(scene);
    if (!entry) {
      entry = { batcher: null, prev: scene.onBeforeRender, hook: null };
      entry.hook = (renderer, sc, camera, target) => {
        entry.prev.call(sc, renderer, sc, camera, target);
        if (entry.batcher && !entry.batcher.disposed) entry.batcher.renderFrame(camera);
      };
      scene.onBeforeRender = entry.hook;
      sceneHooks.set(scene, entry);
    }
    entry.batcher = this;
    this.hookEntry = entry;
    this.unsubscribe = onBuildingQualityChange(() => { this.dirty = true; this.forceAll = true; });
  }

  register(model) {
    this.models.push(model);
    model.batch.lod = -1;
    this.dirty = true;
  }

  unregister(model) {
    this.#removeItems(model);
    const i = this.models.indexOf(model);
    if (i >= 0) {
      this.models[i] = this.models[this.models.length - 1];
      this.models.pop();
    }
    model.batch.registered = false;
    if (!this.models.length) this.dispose();
  }

  /** Fog of war: hidden buildings leave their groups, visible ones come back */
  setVisible(model, visible) {
    const b = model.batch;
    b.visible = visible;
    if (!visible) this.#removeItems(model);
    else if (b.lod >= 0) this.#placeItems(model);
  }

  /** Team colour / highlight of a model changed: rewrite its instance attributes */
  refreshInst(model) {
    for (const item of model.batch.items ?? []) if (item.group) item.group.writeInst(item, model);
  }

  #removeItems(model) {
    for (const item of model.batch.items ?? []) item.group?.remove(item);
  }

  #group(item, geometry, lod) {
    const key = (item.keys[lod] ??= `${item.key}|${geometry.uuid}`);   // built once per item and LOD
    let group = this.groups.get(key);
    if (!group) {
      group = new BatchGroup(this, key, geometry, item);
      this.groups.set(key, group);
    }
    return group;
  }

  #placeItems(model) {
    const b = model.batch;
    for (const item of b.items) {
      if (b.lod < item.minLod || b.lod > item.maxLod) continue;
      const geometry = item.geos[Math.min(b.lod, item.geos.length - 1)];
      let matrix = b.world;
      if (item.mesh) { item.mesh.updateWorldMatrix(true, false); matrix = item.mesh.matrixWorld; }   // far part: its current pose
      this.#group(item, geometry, b.lod).add(item, matrix, model);
    }
  }

  #setLod(model, lod) {
    const b = model.batch;
    b.lod = lod;
    this.#removeItems(model);
    if (b.visible) this.#placeItems(model);
    model.applyBatchLod(lod, this.shadows);
  }

  // Per rendered frame (scene.onBeforeRender): frame time for the auto level, LOD decisions every few frames
  /** Per rendered frame, from the scene hook (render side only) */
  renderFrame(camera) {
    noteRenderFrame();
    this.frame++;
    if (!this.dirty && this.frame % BUILDING_LOD.updateFrames !== 0) return;
    this.dirty = false;
    camera.getWorldPosition(_camPos);
    this.#updateLods();
  }

  #updateLods() {
    const q = getBuildingQuality();
    const force = this.forceAll;
    this.forceAll = false;
    if (q.shadows !== this.shadows) {
      this.shadows = q.shadows;
      for (const g of this.groups.values()) g.setShadows(q.shadows);
    }
    const models = this.models;
    const n = models.length;
    const hyst = 1 + BUILDING_LOD.hysteresis;
    for (let i = 0; i < n; i++) {
      const b = models[i].batch;
      b.dist2 = b.pos.distanceToSquared(_camPos);
    }
    // rank by distance among the visible buildings that can be LOD0 at all (the nearest maxFull get it): O(c²) in the
    // few candidates near the camera, the others cannot be LOD0 and get a rank beyond the limit
    const cand = this.candidates;
    cand.length = 0;
    const limit2 = q.full * hyst * (q.full * hyst);
    for (let i = 0; i < n; i++) {
      const b = models[i].batch;
      // static-only models (plain wall segments) have no extra meshes at LOD0: they never take a LOD0 slot
      b.rank = b.staticOnly ? 0 : n;
      if (q.full > 0 && !b.staticOnly && b.visible && b.dist2 <= limit2) { b.rank = 0; cand.push(b); }
    }
    for (let i = 0; i < cand.length && cand.length > BUILDING_LOD.maxFull; i++) {   // few candidates: all of them get LOD0, rank stays 0
      const b = cand[i];
      let rank = 0;
      for (let j = 0; j < cand.length; j++) {
        const o = cand[j];
        if (o.dist2 < b.dist2 || (o.dist2 === b.dist2 && j < i)) rank++;
      }
      b.rank = rank;
    }
    for (let i = 0; i < n; i++) {
      const model = models[i];
      const b = model.batch;
      if (!b.visible && b.lod >= 0 && !force) continue;
      const d = Math.sqrt(b.dist2);
      const cur = b.lod;
      let lod;
      if (q.full > 0 && d < q.full * (cur === 0 ? hyst : 1)
        && b.rank < BUILDING_LOD.maxFull + (cur === 0 ? BUILDING_LOD.fullRankSlack : 0)) lod = 0;
      else lod = d < q.mid * (cur === 0 || cur === 1 ? hyst : 1) ? 1 : 2;
      if (force || lod !== cur) this.#setLod(model, lod);
    }
    if (this.frame - this.lastSweep >= BUILDING_LOD.idleFrames) this.#sweep();
  }

  // Release long-empty groups (GPU buffers), now and then
  #sweep() {
    this.lastSweep = this.frame;
    for (const [key, g] of this.groups) {
      if (g.items.length === 0 && this.frame - g.emptyFrame > BUILDING_LOD.idleFrames) {
        g.dispose();
        this.groups.delete(key);
      }
    }
  }

  /** { models, groups, instances, drawCalls (visible groups), lods: [LOD0, LOD1, LOD2 buildings] } – debugging */
  stats() {
    let instances = 0;
    let drawCalls = 0;
    for (const g of this.groups.values()) { instances += g.items.length; if (g.items.length) drawCalls++; }
    const lods = [0, 0, 0];
    for (const m of this.models) if (m.batch.visible && m.batch.lod >= 0) lods[m.batch.lod]++;
    return { models: this.models.length, groups: this.groups.size, instances, drawCalls, lods };
  }

  dispose() {
    this.disposed = true;
    const entry = this.hookEntry;
    if (entry.batcher === this) entry.batcher = null;
    if (this.scene.onBeforeRender === entry.hook) {   // still the last link: unhook completely
      this.scene.onBeforeRender = entry.prev;
      sceneHooks.delete(this.scene);
    }                                                 // else: stays as a pass-through, reused by the next batcher
    this.unsubscribe();
    for (const g of this.groups.values()) g.dispose();
    this.groups.clear();
    for (const m of this.models) if (m.batch) { m.batch.registered = false; m.batch.batcher = null; }
    this.models.length = 0;
    batchers.delete(this.scene);
  }
}

const batchers = new WeakMap();   // scene -> Batcher
const sceneHooks = new WeakMap(); // scene -> { batcher, prev, hook } (persistent onBeforeRender link, see Batcher)

/** The batcher of a scene (created on first use, released when its last building goes) */
export function batcherFor(scene) {
  let batcher = batchers.get(scene);
  if (!batcher) {
    batcher = new Batcher(scene);
    batchers.set(scene, batcher);
  }
  return batcher;
}

/** Console: `(await import('./src/procedural/BuildingBatcher.js')).batchStats(steelMen.scene)` */
export const batchStats = (scene) => batchers.get(scene)?.stats() ?? null;
