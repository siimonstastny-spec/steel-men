// Steel Men – game map loaded from data/maps/<name>.json: size, start positions, super node, obstacles.
//
// File format (see data/maps/basic.json, described in data/README.md):
//   size             – width = depth of the square map (units), centred on 0,0
//   startPositions   – [{ x, z, yaw? }] one per player; yaw defaults to facing the map centre
//   superNode        – { x, z, radius, coreRadius } central resource node (radius = gravel apron, core = obstacle + mine pit)
//   symmetry         – 'rotate4': every obstacle is copied 3× rotated by 90° around the centre
//                      (an obstacle with "mirror": false is placed once)
//   obstacles        – { type: 'rock', x, z, radius, height } | { type: 'ridge', x, z, halfX, halfZ, height }
//   terrain          – overrides of MAP.terrain (flatRadius, hill amplitude…)
// Obstacles are registered as pathfinding obstacles by World.loadMap (NavGrid shapes).
//
// [MAPS] ASCII maps: a file with "rows" (see src/game/AsciiMap.js, docs/notes/maps.md) – size, starts, walls,
// rifts, ore fields and the super node come from the grid. Map ids go through MAPS.list / MAPS.aliases
// (old id 'basic' = 'gen_01AI').
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAP, MAPS, MAP_PLANETS, MAP_TERRAIN, MAP_STYLE } from '../config.js';
import { applyPlanetLook } from '../core/SceneSetup.js';
import { parseAsciiMap, cellAt, CELL } from './AsciiMap.js';
import { applyMapEdgeFade } from './MapEdgeFade.js'; // [W9]
import { terrainGridForMap, lavaCracksForMap } from './TerrainTypes.js'; // [A8-terrain]
import { MapFx, createWallGeometry, createLavaRibbonGeometry } from '../procedural/maps/MapMaterials.js'; // [A8-style]
import { OreMineVisual, MineBatch, createMineMaterials, createApronGeometry, createApronMaterial, createDrapedRingGeometry } from './OreMineVisual.js'; // [ore-mine-visual]

/** Canonical map id for an id or alias (unknown ids are returned unchanged and loaded as data/maps/<id>.json) */
export function resolveMapId(name) {
  const id = MAPS.aliases[name] ?? name ?? MAPS.defaultMap;
  return MAPS.list.some((m) => m.id === id) ? id : (name ?? MAPS.defaultMap);
}

/** File name (without .json) of a map id or alias */
export function mapFile(name) {
  const id = resolveMapId(name);
  return MAPS.list.find((m) => m.id === id)?.file ?? id;
}

/** Small deterministic random generator (same rocks every game) */
function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotates a map element k × 90° around the centre ((x, z) -> (-z, x)); boxes swap their half sizes */
function rotate(o, k) {
  let r = { ...o };
  for (let i = 0; i < k; i++) {
    r = { ...r, x: -r.z, z: r.x };
    if (r.halfX !== undefined) r = { ...r, halfX: r.halfZ, halfZ: r.halfX };
  }
  return r;
}

const ROTATIONS = 4;

export class GameMap {
  /** Loads data/maps/<name>.json */
  static async load(name = MAP.defaultMap) {
    const id = resolveMapId(name);
    const res = await fetch(`${MAP.path}${mapFile(id)}.json`);
    if (!res.ok) throw new Error(`Map ${name}: HTTP ${res.status}`);
    return new GameMap(await res.json(), id);
  }

  constructor(def, id = def.name) {
    this.id = id;
    this.def = def;
    this.name = def.name ?? id;
    this.description = def.description ?? '';
    // [MAPS] planet look (MAP_PLANETS key in the file's "planet"); null = default look
    this.planetId = MAP_PLANETS[def.planet] ? def.planet : null;
    this.planet = this.planetId ? MAP_PLANETS[this.planetId] : null;
    // [MAPS] ore richness of this map (file key "oreMultiplier", clamped to MAPS.oreMultiplier range); Economy.setupDeposits applies it
    const om = Number(def.oreMultiplier);
    this.oreMultiplier = Number.isFinite(om) && om > 0
      ? Math.min(MAPS.oreMultiplier.max, Math.max(MAPS.oreMultiplier.min, om)) : MAPS.oreMultiplier.default;
    // [MAPS] how seats without a picked start are placed: 'fixed' = Alliances.startOrder as before (gen_01AI,
    // keeps old games identical), 'random' = from the match seed (src/game/MapStarts.js)
    this.startAssignment = def.startAssignment ?? 'random';
    this.ascii = Array.isArray(def.rows) ? parseAsciiMap(def, id) : null;
    const a = this.ascii;
    this.size = a ? a.size : def.size;
    this.half = this.size / 2;
    this.symmetry = a ? null : (def.symmetry ?? null);
    this.terrain = a ? { ...MAPS.ascii.terrain, ...(def.terrain ?? {}) } : (def.terrain ?? {});
    this.superNode = a ? (a.superNode ? { ...a.superNode } : null) : (def.superNode ? { ...def.superNode } : null);
    // Start positions face the centre unless the file says otherwise
    this.startPositions = (a ? a.startPositions : def.startPositions).map((p) => ({
      x: p.x, z: p.z, yaw: p.yaw ?? Math.atan2(-p.x, -p.z),
    }));
    const mirrored = (o) => (this.symmetry !== 'rotate4' || o.mirror === false
      ? [o] : Array.from({ length: ROTATIONS }, (_, k) => rotate(o, k)));
    this.obstacles = a ? a.obstacles : (def.obstacles ?? []).flatMap(mirrored);
    this.rifts = a ? a.rifts : []; // [MAPS] boxes only hover / air units may cross (NavGrid shape flag `rift`)
    // Ore deposits (src/game/OreDeposit.js): listed ones (mirrored like obstacles) + the super node's ore
    this.#listedDeposits = a ? a.deposits(def.seed ?? 0) : (def.oreDeposits ?? []).flatMap(mirrored);
    this.#collectDeposits();
    // [A8-terrain] terrain type layer + flat lava cracks (data only; the visuals are built in build / paintGround)
    this.terrainTypes = terrainGridForMap(this);
    this.lavaCracks = lavaCracksForMap(this);
    this.group = null;
    this.fx = null; // [A8-style] MapFx (stone / lava materials), created by build, freed by dispose
    this.materials = []; // map materials the fog of war darkens (FogOfWar.patchMaterial)
  }

  /** [A8-style] Advances the animated lava / rim (visual time, call once per rendered frame; no allocations) */
  update(dt) { this.fx?.update(dt); }

  #listedDeposits = [];

  #collectDeposits() {
    this.oreDeposits = [...this.#listedDeposits];
    if (this.superNode?.ore) {
      const n = this.superNode;
      this.oreDeposits.push({ ...n.ore, x: n.x, z: n.z, radius: n.coreRadius ?? n.radius, superNode: true });
    }
  }

  /** [MAPS] Number of players the map is made for (= start positions) */
  get players() { return this.startPositions.length; }

  /**
   * [MAPS] ASCII maps: places the ore deposits of the fields for this match seed (same seed = same deposits on every
   * client). Call before Economy.setupDeposits(map). Other maps: nothing changes.
   */
  placeDeposits(seed) {
    if (!this.ascii) return this.oreDeposits;
    this.#listedDeposits = this.ascii.deposits(seed);
    this.#collectDeposits();
    return this.oreDeposits;
  }

  /** [MAPS] Cell type (AsciiMap CELL) at a world point; non-ASCII maps: null */
  cellAt(x, z) { return this.ascii ? cellAt(this.ascii, x, z) : null; }

  /** Flat spots of the terrain: starts and the super node */
  get flats() {
    return [...this.startPositions, ...(this.superNode ? [this.superNode] : [])];
  }

  /** Options for SceneSetup.buildTerrainGeometry */
  get terrainOptions() {
    return { size: this.size, flats: this.flats, terrain: this.terrain, symmetry: this.symmetry };
  }

  /** Index of the start position farthest from start i (the "opposite" base) */
  opposite(i) {
    const a = this.startPositions[i];
    let best = i;
    let bestDist = -1;
    this.startPositions.forEach((b, j) => {
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d > bestDist) { best = j; bestDist = d; }
    });
    return best;
  }

  /** Pathfinding shapes (NavGrid format): obstacles + the super node core */
  obstacleShapes() {
    const shapes = this.obstacles.map((o) => (o.radius !== undefined
      ? { x: o.x, z: o.z, radius: o.radius, owner: this }
      : { x: o.x, z: o.z, halfX: o.halfX, halfZ: o.halfZ, owner: this }));
    if (this.superNode?.coreRadius) {
      shapes.push({ x: this.superNode.x, z: this.superNode.z, radius: this.superNode.coreRadius, owner: this });
    }
    for (const r of this.rifts) shapes.push({ x: r.x, z: r.z, halfX: r.halfX, halfZ: r.halfZ, rift: true, owner: this });
    return shapes;
  }

  /**
   * [N7-los] Tall obstacles for line of sight: { x, z, radius | halfX+halfZ, top } with top = absolute height of the
   * upper edge (terrain at the obstacle + its height). Only obstacles >= minHeight; rifts are not included (open
   * air above them). Cached per map (heights are fixed once the map is built); the first call must come after build.
   * @param {{ heightAt: (x:number, z:number) => number }} world  the World (heightAt)
   */
  losBlockers(world, minHeight) {
    if (this.#blockers && this.#blockersMin === minHeight) return this.#blockers;
    this.#blockersMin = minHeight;
    this.#blockers = this.obstacles.filter((o) => (o.height ?? 0) >= minHeight)
      .map((o) => ({ x: o.x, z: o.z, radius: o.radius, halfX: o.halfX, halfZ: o.halfZ, top: world.heightAt(o.x, o.z) + o.height }));
    return this.#blockers;
  }

  /** [N7-walls] Shapes a wall line stops at: tall obstacles (>= minHeight) and rifts, as { x, z, radius | halfX+halfZ } */
  wallStops(minHeight) {
    if (this.#stops && this.#stopsMin === minHeight) return this.#stops;
    this.#stopsMin = minHeight;
    const tall = this.obstacles.filter((o) => (o.height ?? 0) >= minHeight);
    this.#stops = [...tall, ...this.rifts].map((o) => ({ x: o.x, z: o.z, radius: o.radius, halfX: o.halfX, halfZ: o.halfZ }));
    return this.#stops;
  }

  #stops = null;
  #stopsMin = -1;
  #blockers = null;
  #blockersMin = -1;

  /** True when a point is inside the map square */
  contains(x, z) { return Math.abs(x) <= this.half && Math.abs(z) <= this.half; }

  /**
   * Creates the visuals (rocks, ridges, super node, start markers) and adds them to the scene.
   * @param {THREE.Scene} scene
   * @param {(x:number, z:number) => number} heightAt
   */
  build(scene, heightAt) {
    this.dispose();
    applyPlanetLook(scene, this.planet); // [MAPS] light / fog / background (null = default look)
    const ground = scene.getObjectByName('ground');
    if (this.ascii) this.paintGround(ground?.geometry); // before walls: rifts change heights
    this.#paintTerrainTypes(ground?.geometry);          // [A8-terrain] type tint (maps without a layer: unchanged)
    applyMapEdgeFade(ground?.material, this.half);      // [W9] per-pixel shader fade at the border (before the fog patch)
    const group = new THREE.Group();
    group.name = 'map';
    this.fx = new MapFx();
    // [A8-style] one shared stone material (UV in world units) for walls and rock blocks. The edge fade patches it first,
    // the fog of war (World.loadMap → patchMaterial on map.materials) is assigned later and chains behind it.
    const stoneMat = this.#material(this.fx.getStoneMaterial());
    applyMapEdgeFade(stoneMat, this.half);
    this.#buildStone(group, stoneMat, heightAt);
    this.#buildLava(group, heightAt);
    if (this.superNode) group.add(this.#superNode(this.superNode, heightAt, ground?.geometry ?? null));
    for (const p of this.startPositions) group.add(this.#startMarker(p, heightAt));

    scene.add(group);
    this.group = group;
    return group;
  }

  dispose() {
    if (!this.group) return;
    this.group.parent?.remove(this.group);
    this.group.traverse((o) => o.geometry?.dispose());
    for (const m of this.materials) m.dispose();
    this.materials = [];
    this.fx?.dispose(); // [A8-style] textures + stone / lava / rim materials
    this.fx = null;
    this.group = null;
  }

  /**
   * [A8-terrain] Mixes MAP_TERRAIN.colors[type] into the terrain vertex colours (strength MAP_TERRAIN.tintStrength).
   * Each vertex averages 5 samples (centre + 4 offsets of a quarter cell), so the 7-unit cells blend over the 5-unit
   * vertex grid instead of showing hard steps. `solid` / colourless types leave the colour as it is.
   */
  #paintTerrainTypes(geometry) {
    const grid = this.terrainTypes;
    const col = geometry?.attributes.color;
    if (!grid || !col) return;
    const def = MAP_TERRAIN.types.indexOf(MAP_TERRAIN.defaultType);
    if (!grid.data.some((v) => v !== def)) return; // no layer: look as before
    const tints = MAP_TERRAIN.types.map((n) => (MAP_TERRAIN.colors[n] == null ? null : new THREE.Color(MAP_TERRAIN.colors[n])));
    const pos = geometry.attributes.position;
    const base = new THREE.Color();
    const sum = new THREE.Color();
    const s = grid.cellSize * 0.25;
    const idx = (t) => (typeof t === 'number' ? t : MAP_TERRAIN.types.indexOf(t));
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      base.fromBufferAttribute(col, i);
      sum.setRGB(0, 0, 0);
      for (let k = 0; k < 5; k++) {
        const tint = tints[idx(grid.typeAt(k === 1 ? x - s : k === 2 ? x + s : x, k === 3 ? z - s : k === 4 ? z + s : z))];
        const c = tint ?? base;
        sum.r += c.r; sum.g += c.g; sum.b += c.b;
      }
      sum.multiplyScalar(1 / 5);
      base.lerp(sum, MAP_TERRAIN.tintStrength);
      col.setXYZ(i, base.r, base.g, base.b);
    }
    col.needsUpdate = true;
  }

  /** [A8-style] Lowest terrain point under a footprint (walls stand on it, so no gap shows on a slope) */
  #baseHeight(x, z, hx, hz, heightAt) {
    return Math.min(heightAt(x, z), heightAt(x - hx, z - hz), heightAt(x + hx, z - hz), heightAt(x - hx, z + hz), heightAt(x + hx, z + hz));
  }

  /**
   * [A8-style] Walls (ridge boxes) and rocks (stone blocks) as merged geometry: one mesh per MAP_STYLE.wallChunk square.
   * Heights are the obstacle's `height` from the data (the simulation's LOS uses it); nothing here feeds back into it.
   */
  #buildStone(group, material, heightAt) {
    const chunks = new Map(); // key -> geometries (insertion order = obstacle order: deterministic)
    this.obstacles.forEach((o, i) => {
      const isRidge = o.type === 'ridge' || o.radius === undefined;
      let geo;
      if (isRidge) {
        geo = createWallGeometry({ length: o.halfX * 2, thickness: o.halfZ * 2, height: o.height, seed: MAP_STYLE.wallSeed + i });
        geo.translate(o.x, this.#baseHeight(o.x, o.z, o.halfX, o.halfZ, heightAt) - MAP_STYLE.wallSink, o.z);
      } else {
        const rand = seededRandom(i + 1);
        const w = o.radius * MAP_STYLE.rockWidthFactor * (1 + (rand() * 2 - 1) * MAP.rock.jitter);
        const d = o.radius * MAP_STYLE.rockWidthFactor * (1 + (rand() * 2 - 1) * MAP.rock.jitter);
        geo = createWallGeometry({ length: w, thickness: d, height: o.height, seed: MAP_STYLE.wallSeed + i });
        geo.rotateY(rand() * Math.PI * 2);
        geo.translate(o.x, this.#baseHeight(o.x, o.z, w / 2, d / 2, heightAt) - o.height * MAP.rock.sink, o.z);
      }
      const key = `${Math.floor((o.x + this.half) / MAP_STYLE.wallChunk)},${Math.floor((o.z + this.half) / MAP_STYLE.wallChunk)}`;
      let list = chunks.get(key);
      if (!list) chunks.set(key, list = []);
      list.push(geo);
    });
    for (const list of chunks.values()) {
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (list.length > 1) for (const g of list) g.dispose();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = 'stone';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }

  /**
   * [A8-style] Flat lava in the cracks (no digging): all cracks in one lava + one rim geometry. The ribbons are resampled
   * to MAP_STYLE.lavaStep and every vertex gets y = terrain + lift, so they follow the ground.
   */
  #buildLava(group, heightAt) {
    if (!this.lavaCracks?.length) return;
    const lava = [], rim = [];
    for (const crack of this.lavaCracks) {
      const pts = this.#resample(crack.points, MAP_STYLE.lavaStep);
      if (pts.length < 2) continue;
      lava.push(this.#ribbon(pts, crack.width, MAP_STYLE.lavaLift, heightAt));
      rim.push(this.#ribbon(pts, crack.width * MAP_STYLE.rimWidthFactor, MAP_STYLE.rimLift, heightAt));
    }
    if (!lava.length) return;
    const add = (geos, material, order, name) => {
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (geos.length > 1) for (const g of geos) g.dispose();
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = name;
      mesh.renderOrder = order;
      group.add(mesh);
    };
    const lavaMat = this.#fogAware(this.fx.getLavaMaterial());
    const rimMat = this.#fogAware(this.fx.getRimMaterial());
    add(lava, lavaMat, MAP_STYLE.lavaRenderOrder, 'lava');
    add(rim, rimMat, MAP_STYLE.rimRenderOrder, 'lavaRim');
  }

  /** Polyline resampled to (about) equal steps */
  #resample(points, step) {
    const out = [];
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
      for (let k = 0; k < n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, z: a.z + (b.z - a.z) * k / n });
    }
    if (points.length) out.push({ x: points[points.length - 1].x, z: points[points.length - 1].z });
    return out;
  }

  #ribbon(points, width, lift, heightAt) {
    const geo = createLavaRibbonGeometry(points, width, 0);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, heightAt(pos.getX(i), pos.getZ(i)) + lift);
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * [A8-style] The fog of war (FogOfWar.patchMaterial) patches stock-material shader chunks, which the lava / rim shaders do
   * not have. This registers the material in `materials` (World patches those) and applies the same darkening in a hook:
   * the fog's own function is only called on a probe to take its uniforms (fogMap, fogMapSize).
   */
  #fogAware(material) {
    let fogFn = null;
    const patch = (shader) => {
      if (!fogFn) return;
      const probe = { uniforms: {}, vertexShader: '', fragmentShader: '' };
      fogFn(probe);
      shader.uniforms.fogMap = probe.uniforms.fogMap;
      shader.uniforms.fogMapSize = probe.uniforms.fogMapSize;
      shader.vertexShader = shader.vertexShader
        .replace('varying vec2 vXZ;', 'varying vec2 vXZ;\nuniform float fogMapSize;\nvarying vec2 vFogMapUv;')
        .replace('vXZ = wp.xz;', 'vXZ = wp.xz;\nvFogMapUv = wp.xz / fogMapSize + 0.5;');
      shader.fragmentShader = shader.fragmentShader
        .replace('varying vec2 vXZ;', 'varying vec2 vXZ;\nuniform sampler2D fogMap;\nvarying vec2 vFogMapUv;')
        .replace('#include <fog_fragment>', '#include <fog_fragment>\ngl_FragColor.rgb *= texture2D(fogMap, vFogMapUv).r;');
    };
    Object.defineProperty(material, 'onBeforeCompile', { configurable: true, get: () => patch, set: (fn) => { fogFn = fn; } });
    Object.defineProperty(material, 'customProgramCacheKey', { configurable: true, get: () => () => 'mapFxFog', set: () => {} });
    this.materials.push(material);
    return material;
  }

  /**
   * [MAPS] ASCII maps: tints the terrain vertex colours by cell type (grass / concrete / field / rift) and sinks the
   * terrain under rift cells (also in the height field, so World.heightAt follows). Deterministic (map data only).
   * @param {THREE.BufferGeometry} geometry  terrain from SceneSetup.buildTerrainGeometry (World.loadMap)
   */
  paintGround(geometry) {
    if (!this.ascii || !geometry) return;
    const cfg = MAPS.ascii;
    const pos = geometry.attributes.position;
    const col = geometry.attributes.color;
    const heights = geometry.userData.heightField?.heights;
    const names = Object.keys(CELL);
    const palette = this.planet?.colors ?? cfg.colors;
    const tints = names.map((k) => new THREE.Color(palette[k] ?? palette.grass));
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const type = cellAt(this.ascii, pos.getX(i), pos.getZ(i));
      if (col) {
        c.fromBufferAttribute(col, i).lerp(tints[type], cfg.tintStrength);
        col.setXYZ(i, c.r, c.g, c.b);
      }
      if (type === CELL.rift) {
        const h = pos.getY(i) - cfg.riftDepth;
        pos.setY(i, h);
        if (heights) heights[i] = h;
      }
    }
    if (col) col.needsUpdate = true;
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
  }

  // ---------- visuals ----------

  #material(mat) { this.materials.push(mat); return mat; }

  #superNode(node, heightAt, terrain) {
    // [ore-mine-visual] worked gravel apron + edge glow; the pit itself belongs to the super node's OreDeposit
    // (OreMineVisual, depletes like any deposit). A super node without ore gets a static pit here.
    const cfg = MAP.superNode;
    const group = new THREE.Group();
    group.name = 'superNode';
    group.position.set(node.x, heightAt(node.x, node.z), node.z);
    const core = node.coreRadius ?? node.radius;

    const apron = new THREE.Mesh(
      createApronGeometry({ x: node.x, z: node.z, radius: node.radius, coreRadius: core, heightAt, planet: this.planet }),
      this.#material(createApronMaterial()),
    );
    apron.name = 'superNodeApron';
    apron.receiveShadow = true;
    group.add(apron);

    if (!node.ore) {
      const mats = createMineMaterials();
      mats.ore.dispose(); // regular ore material not needed here
      const superOre = this.#material(mats.superOre);
      // own batch in the super node group's space (origin = group position); geometries freed by Map.dispose
      const batch = new MineBatch({ stone: this.#material(mats.stone), ore: superOre, superOre }, group.position);
      const pit = new OreMineVisual({
        x: node.x, z: node.z, radius: core, superNode: true, heightAt, planet: this.planet, terrain, batch,
      });
      batch.flush();
      pit.group.position.set(0, 0, 0); // pick proxy, local to the super node group
      group.add(pit.group, batch.group);
    }

    const glow = new THREE.Mesh(
      createDrapedRingGeometry({
        x: node.x, z: node.z, inner: node.radius - cfg.glowWidth, outer: node.radius, segments: cfg.glowSegments,
        lift: cfg.apron.lift + MAP.startMarker.height, heightAt,
      }),
      this.#material(new THREE.MeshBasicMaterial({ color: cfg.glowColor, transparent: true, opacity: cfg.glowOpacity, side: THREE.DoubleSide, depthWrite: false })),
    );
    glow.name = 'superNodeGlow';
    group.add(glow);
    return group;
  }

  #startMarker(p, heightAt) {
    const cfg = MAP.startMarker;
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(cfg.radius - cfg.width, cfg.radius, cfg.segments),
      this.#material(new THREE.MeshBasicMaterial({ color: cfg.color, transparent: true, opacity: cfg.opacity, side: THREE.DoubleSide, depthWrite: false })),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(p.x, heightAt(p.x, p.z) + cfg.height, p.z);
    mesh.name = 'startMarker';
    return mesh;
  }
}
