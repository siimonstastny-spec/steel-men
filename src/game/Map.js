// Steel Mans – game map loaded from data/maps/<name>.json: size, start positions, super node, obstacles.
//
// File format (see data/maps/basic.json, described in data/README.md):
//   size             – width = depth of the square map (units), centred on 0,0
//   startPositions   – [{ x, z, yaw? }] one per player; yaw defaults to facing the map centre
//   superNode        – { x, z, radius, coreRadius } central resource node (radius = platform, core = obstacle)
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
import { MAP, MAPS, MAP_PLANETS } from '../config.js';
import { applyPlanetLook } from '../core/SceneSetup.js';
import { parseAsciiMap, cellAt, CELL } from './AsciiMap.js';
import { applyMapEdgeFade } from './MapEdgeFade.js'; // [W9]

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
    this.group = null;
    this.materials = []; // map materials the fog of war darkens (FogOfWar.patchMaterial)
  }

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
    applyMapEdgeFade(ground?.material, this.half);      // [W9] per-pixel shader fade at the border (before the fog patch)
    const group = new THREE.Group();
    group.name = 'map';
    const rockMat = this.#material(new THREE.MeshStandardMaterial({ color: MAP.rock.color, roughness: MAP.rock.roughness, flatShading: true }));
    const ridgeMat = this.#material(new THREE.MeshStandardMaterial({ color: this.planet?.ridge ?? MAP.ridge.color, roughness: MAP.ridge.roughness, flatShading: true }));
    applyMapEdgeFade(rockMat, this.half); // [W9] rocks / ridges in the border band fade too (per-material uniforms, freed with the material)
    applyMapEdgeFade(ridgeMat, this.half);

    this.obstacles.forEach((o, i) => {
      const mesh = o.type === 'ridge' || o.radius === undefined
        ? this.#ridge(o, ridgeMat, heightAt)
        : this.#rock(o, rockMat, heightAt, i);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    });
    if (this.superNode) group.add(this.#superNode(this.superNode, heightAt));
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
    this.group = null;
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

  #rock(o, material, heightAt, index) {
    const cfg = MAP.rock;
    const geo = new THREE.IcosahedronGeometry(o.radius, cfg.detail);
    const rand = seededRandom(index + 1);
    const pos = geo.attributes.position;
    // Jitter shared vertices identically (icosahedron vertices are duplicated per face)
    const offsets = new Map();
    for (let i = 0; i < pos.count; i++) {
      const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
      if (!offsets.has(key)) offsets.set(key, 1 + (rand() * 2 - 1) * cfg.jitter);
      const f = offsets.get(key);
      pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f, pos.getZ(i) * f);
    }
    geo.scale(1, o.height / o.radius, 1);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(o.x, heightAt(o.x, o.z) - o.height * cfg.sink, o.z);
    mesh.rotation.y = rand() * Math.PI * 2;
    return mesh;
  }

  #ridge(o, material, heightAt) {
    // Base at the lowest terrain point under the footprint so no gap shows on a slope
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => heightAt(o.x + sx * o.halfX, o.z + sz * o.halfZ));
    const base = Math.min(...corners, heightAt(o.x, o.z));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(o.halfX * 2, o.height, o.halfZ * 2), material);
    mesh.position.set(o.x, base + o.height / 2, o.z);
    return mesh;
  }

  #superNode(node, heightAt) {
    const cfg = MAP.superNode;
    const group = new THREE.Group();
    group.name = 'superNode';
    group.position.set(node.x, heightAt(node.x, node.z), node.z);

    const platform = new THREE.Mesh(
      new THREE.CylinderGeometry(node.radius, node.radius, cfg.platformHeight, cfg.platformSegments),
      this.#material(new THREE.MeshStandardMaterial({ color: cfg.platformColor, roughness: 0.8 })),
    );
    platform.position.y = cfg.platformHeight / 2;
    platform.receiveShadow = true;
    group.add(platform);

    const crystalMat = this.#material(new THREE.MeshStandardMaterial({
      color: cfg.crystalColor, emissive: cfg.crystalEmissive, emissiveIntensity: cfg.crystalEmissiveIntensity,
      roughness: 0.3, metalness: 0.1, flatShading: true,
    }));
    const crystal = (height, width) => {
      const geo = new THREE.OctahedronGeometry(1, 0);
      geo.scale(width, height / 2, width);
      geo.translate(0, height / 2, 0);
      const mesh = new THREE.Mesh(geo, crystalMat);
      mesh.castShadow = true;
      return mesh;
    };
    const centre = crystal(cfg.crystalHeight, cfg.crystalWidth);
    centre.position.y = cfg.platformHeight;
    group.add(centre);
    const ring = (node.coreRadius ?? node.radius) * cfg.crystalRingFactor;
    for (let i = 0; i < cfg.crystalCount; i++) {
      const a = (i / cfg.crystalCount) * Math.PI * 2;
      const scale = i % 2 ? cfg.smallCrystalScale : cfg.largeCrystalScale;
      const c = crystal(cfg.crystalHeight * scale, cfg.crystalWidth * scale);
      c.position.set(Math.sin(a) * ring, cfg.platformHeight, Math.cos(a) * ring);
      c.rotation.set(Math.cos(a) * cfg.crystalTilt, 0, -Math.sin(a) * cfg.crystalTilt);
      group.add(c);
    }

    const glow = new THREE.Mesh(
      new THREE.RingGeometry(node.radius - cfg.glowWidth, node.radius, cfg.platformSegments),
      this.#material(new THREE.MeshBasicMaterial({ color: cfg.glowColor, transparent: true, opacity: cfg.glowOpacity, side: THREE.DoubleSide, depthWrite: false })),
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = cfg.platformHeight + MAP.startMarker.height;
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
