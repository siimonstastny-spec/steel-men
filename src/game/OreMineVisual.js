// Steel Men – [ore-mine-visual] look of an ore deposit: a small open-pit mine (docs/notes/ore-mine-visual.md).
// A terraced pit (3 steps, light bench edges, horizontal ore strata) is sunk below the ground: the terrain MESH is lowered
// under it (vertex Y + normals, restored on dispose) while the height field the simulation reads (heightField.heights →
// World.heightAt) is never touched. A collar coloured like the terrain hides the coarse dip of the 5-unit terrain grid,
// small heaps, dug holes and tyre tracks mark the field around. Everything is draped on the terrain (heightAt) per vertex,
// own seeded PRNG from the position (no world.rng, no Math.random).
// The super node uses the same builder with MAP.superNode.mine overrides (bigger, blue glowing ore) and an apron.
// Draw calls: all mines of a map are merged by MineBatch – 1 stone mesh + 1 lump mesh per ore material (regular, super
// node) = max. 3 for any number of deposits; each mine keeps only an invisible pick proxy. Materials shared per world.
import * as THREE from 'three';
import { ORE_DEPOSIT, MAP, MAPS } from '../config.js';

const TAU = Math.PI * 2;
const COORD_HASH_SCALE = 16; // deposit position → seed resolution
const SQRT2 = Math.SQRT2;
const NORMAL_EPS = 0.5;      // share of a terrain cell used for the central-difference normal of draped surfaces
// original terrain normals of vertices lowered by any mine (per terrain geometry: index → [nx, ny, nz]), so overlapping
// mines restore the true original
const terrainOriginals = new WeakMap();
const _n = new THREE.Vector3(); // build-time scratch normal
const APRON_SEED_SALT = 0x5bd1e995; // apron noise differs from the pit noise of the same position

/** Small deterministic random generator (visual only) */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(x, z) {
  let h = Math.imul(Math.round(x * COORD_HASH_SCALE) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(z * COORD_HASH_SCALE) | 0, 0x165667b1);
  h ^= h >>> 15;
  return h >>> 0;
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const angDist = (a, b) => { const d = Math.abs(a - b) % TAU; return d > Math.PI ? TAU - d : d; };
const lerp = (a, b, t) => a + (b - a) * t;

/** Mine settings: ORE_DEPOSIT.mine, overridden by MAP.superNode.mine for the super node (build time only) */
export function mineSettings(superNode) {
  if (!superNode) return ORE_DEPOSIT.mine;
  const out = { ...ORE_DEPOSIT.mine };
  for (const [k, v] of Object.entries(MAP.superNode.mine)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...out[k], ...v } : v;
  }
  return out;
}

/** Largest lip radius of a mine / pit radius (outline + oval at their maximum) – e.g. where the super node apron starts */
export function mineLipFactor(superNode) {
  const cfg = mineSettings(superNode);
  return cfg.rings[0][0] * (1 + cfg.oval + cfg.outline.reduce((s, [, a]) => s + a, 0));
}

/** Ground / stone colours of a planet (MAP_PLANETS entry or null = default look) */
export function mineColors(planet) {
  const pal = planet?.colors ?? MAPS.ascii.colors;
  return {
    stone: new THREE.Color(planet?.ridge ?? MAP.ridge.color),
    field: new THREE.Color(pal.field ?? pal.grass),
    core: new THREE.Color(pal.fieldCore ?? pal.field ?? pal.grass),
    concrete: new THREE.Color(pal.concrete ?? pal.grass),
  };
}

/** New stone (vertex-coloured) + ore materials; the caller owns and disposes them */
export function createMineMaterials() {
  const m = ORE_DEPOSIT.mine;
  const ore = (c) => new THREE.MeshStandardMaterial({
    color: c.oreColor, emissive: c.oreEmissive, emissiveIntensity: c.oreEmissiveIntensity,
    roughness: m.oreRoughness, metalness: m.oreMetalness, flatShading: true,
  });
  return {
    // no flatShading: the faces are non-indexed (own face normals), collar / scars get the terrain's normals
    stone: new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: m.stoneRoughness, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: m.polygonOffset, polygonOffsetUnits: m.polygonOffset,
    }),
    ore: ore(m),
    superOre: ore(mineSettings(true)),
  };
}

// Materials shared by all deposits of one fog of war (= one loaded map); the fog patches them once
const shared = new WeakMap();

/**
 * Shared materials + the MineBatch for a world's deposits (fog-patched, batch group added to world.scene);
 * pair every call with releaseMineMaterials
 */
export function acquireMineMaterials(world) {
  const key = world.fog ?? world;
  let entry = shared.get(key);
  if (!entry) {
    entry = { key, users: 0, ...createMineMaterials() };
    for (const mat of [entry.stone, entry.ore, entry.superOre]) world.fog?.patchMaterial(mat);
    entry.batch = new MineBatch(entry);
    world.scene?.add(entry.batch.group);
    shared.set(key, entry);
  }
  entry.users++;
  return entry;
}

export function releaseMineMaterials(entry) {
  if (!entry || --entry.users > 0) return;
  shared.delete(entry.key);
  entry.batch.dispose();
  entry.stone.dispose();
  entry.ore.dispose();
  entry.superOre.dispose();
}

/**
 * All mines of a map in few draw calls: one merged stone mesh (pits, collars, rubble, scars) + one merged mesh per ore
 * material (regular / super node lumps). Mines register with add / remove; the merged geometry is rebuilt once after the
 * current synchronous work (microtask), e.g. after Economy.setupDeposits created all deposits. Depletion writes only the
 * mine's own vertex range (colours; hidden lumps collapse to their centre) – no rebuild. Vertex positions are in the
 * batch group's space = world space minus `origin`. Materials are not owned.
 */
export class MineBatch {
  /** @param {{ stone, ore, superOre }} materials  @param {THREE.Vector3} [origin] */
  constructor(materials, origin = null) {
    this.materials = materials;
    this.origin = origin ? origin.clone() : new THREE.Vector3();
    this.group = new THREE.Group();
    this.group.name = 'oreMines';
    this.visuals = new Set(); // insertion order = creation order (stable layout)
    this.stone = null;
    this.ores = { ore: null, superOre: null };
    this.pending = false;
    this.disposed = false;
  }

  add(visual) { this.visuals.add(visual); this.#schedule(); }

  remove(visual) {
    if (!this.visuals.delete(visual)) return;
    visual.batchOffset = -1;
    if (this.visuals.size) this.#schedule(); else this.#clear();
  }

  /** Rebuilds the merged geometries now (normally called by the scheduled microtask) */
  flush() {
    this.pending = false;
    if (this.disposed) return;
    this.#clear();
    if (!this.visuals.size) return;
    const list = [...this.visuals];
    this.stone = this.#merged(list, null, this.materials.stone, 'oreMinesStone');
    for (const key of ['ore', 'superOre']) {
      const own = list.filter((v) => v.oreKey === key && v.lumpCount);
      if (own.length) this.ores[key] = this.#merged(own, key, this.materials[key], `oreMines_${key}`);
    }
    for (const v of list) v.applyLumps();
  }

  /** Copies a mine's current colours into the merged stone geometry (after setRemaining) */
  updateColors(v) {
    if (!this.stone || v.batchOffset < 0) return;
    const attr = this.stone.geometry.attributes.color;
    attr.array.set(v.colorsOut, v.batchOffset * 3);
    markRange(attr, v.batchOffset * 3, v.colorsOut.length);
  }

  /** Lump positions of a mine (visible ones in place, the rest collapsed to their centre) */
  updateLumps(v) {
    const mesh = this.ores[v.oreKey];
    if (!mesh || v.lumpOffset < 0) return;
    const attr = mesh.geometry.attributes.position;
    v.writeLumps(attr.array, v.lumpOffset * 3, this.origin);
    markRange(attr, v.lumpOffset * 3, v.lumpPositions.length);
  }

  dispose() {
    this.disposed = true;
    this.#clear();
    this.group.parent?.remove(this.group);
    this.visuals.clear();
  }

  #schedule() {
    if (this.pending || this.disposed) return;
    this.pending = true;
    queueMicrotask(() => { if (this.pending) this.flush(); });
  }

  #clear() {
    for (const mesh of [this.stone, this.ores.ore, this.ores.superOre]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.geometry.dispose();
    }
    this.stone = null;
    this.ores.ore = null;
    this.ores.superOre = null;
  }

  /** One mesh from the stone (key null) or lump arrays of the given mines; stores each mine's vertex offset */
  #merged(list, key, material, name) {
    const o = this.origin;
    let count = 0;
    for (const v of list) count += key ? v.lumpPositions.length / 3 : v.positions.length / 3;
    const pos = new Float32Array(count * 3), nor = new Float32Array(count * 3);
    const col = key ? null : new Float32Array(count * 3);
    let at = 0;
    for (const v of list) {
      const src = key ? v.lumpPositions : v.positions;
      const ox = v.x - o.x, oy = v.baseY - o.y, oz = v.z - o.z;
      for (let i = 0; i < src.length; i += 3) {
        pos[at * 3 + i] = src[i] + ox;
        pos[at * 3 + i + 1] = src[i + 1] + oy;
        pos[at * 3 + i + 2] = src[i + 2] + oz;
      }
      nor.set(key ? v.lumpNormals : v.normals, at * 3);
      if (key) v.lumpOffset = at; else { v.batchOffset = at; col.set(v.colorsOut, at * 3); }
      at += src.length / 3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (col) geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }
}

/** Marks part of an attribute for upload (partial update when the three.js build supports it) */
function markRange(attr, start, count) {
  if (attr.addUpdateRange) attr.addUpdateRange(start, count);
  attr.needsUpdate = true;
}

export class OreMineVisual {
  /**
   * @param {object} o
   * @param {number} o.x @param {number} o.z  centre
   * @param {number} o.radius   pit radius (deposit radius / super node coreRadius)
   * @param {boolean} [o.superNode]
   * @param {(x:number, z:number) => number} o.heightAt
   * @param {object|null} [o.planet]  MAP_PLANETS entry
   * @param {MineBatch} o.batch  draws the mine (merged with the other mines of the map); this object keeps only an
   *   invisible pick proxy of the pit lining in `group` (raycasts ignore `visible`, so right clicks still find the deposit)
   * @param {THREE.BufferGeometry|null} [o.terrain]  terrain mesh geometry (heightField + colour + normal): its mesh is
   *   lowered under the pit (restored by dispose) and its colour sampled for the collar; without it the pit is not sunk
   */
  constructor({ x, z, radius, superNode = false, heightAt, planet = null, batch, terrain = null }) {
    const cfg = mineSettings(superNode);
    this.cfg = cfg;
    this.x = x;
    this.z = z;
    this.r = Math.max(radius || 0, cfg.minRadius);
    this.hs = cfg.heightScale ?? 1;
    this.heightAt = heightAt;
    this.baseY = heightAt(x, z);
    const t = terrain?.attributes;
    this.terrain = terrain?.userData?.heightField && t.color && t.normal ? terrain : null;
    const field = this.terrain?.userData.heightField;
    this.cell = field ? field.size / field.segments : 1 / MAP.segmentsPerUnit;
    this.colors = mineColors(planet);
    this.rand = prng(hashSeed(x, z));
    this.rampAngle = this.rand() * TAU;
    this.ovalAngle = this.rand() * TAU;
    this.outline = cfg.outline.map(([k, a]) => ({ k, a, p: this.rand() * TAU }));
    this.oreColor = new THREE.Color(cfg.oreColor);
    this.sunk = null;
    this.#expandProfile();

    this.oreKey = superNode ? 'superOre' : 'ore';
    this.batch = batch;
    this.batchOffset = -1; // first vertex in the batch's stone mesh (set by MineBatch)
    this.lumpOffset = -1;  // first vertex in the batch's ore mesh
    this.group = new THREE.Group();
    this.group.name = 'oreMine';
    this.group.position.set(x, this.baseY, z);

    this.#buildPit();
    this.#buildChunks();
    // pick proxy: the pit lining only (not the wide collar / scars), never drawn
    const proxyGeo = new THREE.BufferGeometry();
    proxyGeo.setAttribute('position', new THREE.BufferAttribute(this.positions.slice(0, this.pitVerts * 3), 3));
    proxyGeo.computeBoundingSphere();
    this.proxy = new THREE.Mesh(proxyGeo, batch.materials.stone);
    this.proxy.name = 'oreMinePick';
    this.proxy.visible = false;
    this.group.add(this.proxy);
    this.#sinkTerrain();
    this.rand = null;
    this.setRemaining(1, false);
    batch.add(this);
  }

  /** Meshes of the mine (picking) */
  get meshes() { return [this.proxy]; }

  /**
   * Shows how much ore is left: veins fade, stone darkens (pit only, the collar keeps the terrain colour), lumps
   * disappear (wall ones first). No allocations; call only when the share changed noticeably (ORE_DEPOSIT.visualStep).
   */
  setRemaining(ratio, depleted) {
    const cfg = this.cfg;
    const left = depleted ? 0 : clamp01(ratio);
    const shown = depleted ? 0 : cfg.veinMinShown + (1 - cfg.veinMinShown) * left;
    const darken = cfg.depletedDarken * (1 - left);
    const col = this.colorsOut;
    const base = this.baseColors, vein = this.veins, dw = this.darkWeights, ore = this.oreColor;
    for (let v = 0, n = vein.length; v < n; v++) {
      const o = v * 3;
      const dark = 1 - darken * dw[v];
      const br = base[o] * dark, bg = base[o + 1] * dark, bb = base[o + 2] * dark;
      const w = vein[v] * shown;
      col[o] = br + (ore.r - br) * w;
      col[o + 1] = bg + (ore.g - bg) * w;
      col[o + 2] = bb + (ore.b - bb) * w;
    }
    this.batch.updateColors(this);
    const lumps = depleted ? 0 : Math.max(left > 0 ? 1 : 0, Math.ceil(this.lumpCount * left));
    if (lumps !== this.visibleLumps) {
      this.visibleLumps = lumps;
      this.batch.updateLumps(this);
    }
  }

  /** (MineBatch) writes the current lump state into the merged ore mesh after a rebuild */
  applyLumps() { this.batch.updateLumps(this); }

  /**
   * (MineBatch) Lump vertices into a merged position array from `start` (floats): visible lumps in place, hidden ones
   * collapsed to their centre (zero-area triangles). `origin` = batch space origin. No allocations.
   */
  writeLumps(out, start, origin) {
    const ox = this.x - origin.x, oy = this.baseY - origin.y, oz = this.z - origin.z;
    const src = this.lumpPositions, c = this.lumpCentres, per = this.lumpVerts * 3;
    for (let l = 0; l < this.lumpCount; l++) {
      const shown = l < this.visibleLumps;
      for (let i = l * per, end = i + per; i < end; i += 3) {
        out[start + i] = (shown ? src[i] : c[l * 3]) + ox;
        out[start + i + 1] = (shown ? src[i + 1] : c[l * 3 + 1]) + oy;
        out[start + i + 2] = (shown ? src[i + 2] : c[l * 3 + 2]) + oz;
      }
    }
  }

  dispose() {
    this.batch.remove(this);
    this.group.parent?.remove(this.group);
    this.proxy.geometry.dispose();
    this.#restoreTerrain();
  }

  // ---------- build ----------

  /** Profile height (base rings, no noise / ramp) at a radius factor */
  #profileHeight(rf) {
    const rings = this.cfg.rings;
    for (let i = 0; i < rings.length - 1; i++) {
      const [ra, ha] = rings[i], [rb, hb] = rings[i + 1];
      if (rf <= ra && rf >= rb) return lerp(hb, ha, ra === rb ? 0 : (rf - rb) / (ra - rb)) * this.hs;
    }
    return rings[rings.length - 1][1] * this.hs;
  }

  /** Angle moved out of the ramp notch (one full notch width further), unchanged elsewhere */
  #offRamp(theta) {
    const half = this.cfg.ramp.halfAngle;
    return angDist(theta, this.rampAngle) < half ? theta + half * 2 : theta;
  }

  /** Radius factor of the outline at an angle: oval + a few seeded harmonics (irregular, closed) */
  #shape(theta) {
    let s = 1 + this.cfg.oval * Math.cos(2 * (theta - this.ovalAngle));
    for (const o of this.outline) s += o.a * Math.sin(o.k * theta + o.p);
    return s;
  }

  #ovalRadius(rf, theta) { return rf * this.r * this.#shape(theta); }

  /** How much the ramp flattens the profile at an angle (0 … ramp.strength) */
  #rampWeight(theta) {
    const ramp = this.cfg.ramp;
    return (1 - smooth(ramp.halfAngle * ramp.innerFactor, ramp.halfAngle, angDist(theta, this.rampAngle))) * ramp.strength;
  }

  /** Terrain height under a local point, relative to the mine origin */
  #groundY(lx, lz) { return this.heightAt(this.x + lx, this.z + lz) - this.baseY; }

  /** Terrain vertex colour under a local point (bilinear over the terrain grid; no terrain → field colour) */
  #groundColor(lx, lz, out) {
    const geo = this.terrain;
    if (!geo) return out.copy(this.colors.field);
    const { size, segments } = geo.userData.heightField;
    const col = geo.attributes.color, row = segments + 1, cell = this.cell;
    const fx = Math.min(segments, Math.max(0, (this.x + lx + size / 2) / cell));
    const fz = Math.min(segments, Math.max(0, (this.z + lz + size / 2) / cell));
    const ix = Math.min(Math.floor(fx), segments - 1), iz = Math.min(Math.floor(fz), segments - 1);
    const u = fx - ix, v = fz - iz;
    const k00 = iz * row + ix, k10 = k00 + 1, k01 = k00 + row, k11 = k01 + 1;
    const w00 = (1 - u) * (1 - v), w10 = u * (1 - v), w01 = (1 - u) * v, w11 = u * v;
    return out.setRGB(
      col.getX(k00) * w00 + col.getX(k10) * w10 + col.getX(k01) * w01 + col.getX(k11) * w11,
      col.getY(k00) * w00 + col.getY(k10) * w10 + col.getY(k01) * w01 + col.getY(k11) * w11,
      col.getZ(k00) * w00 + col.getZ(k10) * w10 + col.getZ(k01) * w01 + col.getZ(k11) * w11,
    );
  }

  /** Profile rings with wall / floor bands split into rows → this.rings [{ rf, h }], this.kinds (band kind per gap) */
  #expandProfile() {
    const { rings, bands, wallRows, floorRows } = this.cfg;
    const out = [{ rf: rings[0][0], h: rings[0][1] }];
    const kinds = [];
    for (let b = 0; b < rings.length - 1; b++) {
      const kind = bands[b] ?? 'floor';
      const rows = kind === 'wall' ? wallRows : kind === 'floor' ? floorRows : 1;
      const [ra, ha] = rings[b], [rb, hb] = rings[b + 1];
      for (let s = 1; s <= rows; s++) {
        out.push({ rf: lerp(ra, rb, s / rows), h: lerp(ha, hb, s / rows) });
        kinds.push(kind);
      }
    }
    this.rings = out;
    this.kinds = kinds;
  }

  /** Vertex record [x, y, z, r, g, b, vein, dark] (build time only) */
  static #vtx(x, y, z, c, vein = 0, dark = 0) { return [x, y, z, c.r, c.g, c.b, vein, dark]; }

  /** Adds a triangle facing up (winding swapped when needed); smooth = gets the terrain normal later */
  #tri(out, a, b, c, smooth) {
    const e1x = b[0] - a[0], e1z = b[2] - a[2], e2x = c[0] - a[0], e2z = c[2] - a[2];
    if (e1z * e2x - e1x * e2z < 0) { const t = b; b = c; c = t; }
    for (const v of [a, b, c]) {
      out.pos.push(v[0], v[1], v[2]);
      out.col.push(v[3], v[4], v[5]);
      out.vein.push(v[6]);
      out.dark.push(v[7]);
      out.smooth.push(smooth ? 1 : 0);
    }
  }

  #buildPit() {
    const cfg = this.cfg, rand = this.rand, hs = this.hs, colors = this.colors;
    const rings = this.rings, kinds = this.kinds, S = cfg.segments, nR = rings.length;
    const base = cfg.rings;
    const rampTopRf = rings[1].rf;
    const floorRf = base[base.length - 2][0], floorH = base[base.length - 2][1] * hs;
    const topH = rings[1].h * hs;
    const out = { pos: [], col: [], vein: [], dark: [], smooth: [] };
    const V = OreMineVisual.#vtx;

    // pit ring grid (shared by neighbouring faces, so the surface is closed)
    const px = new Float32Array(nR * S), py = new Float32Array(nR * S), pz = new Float32Array(nR * S);
    const lipR = new Float32Array(S);
    let lipMax = 0;
    for (let i = 0; i < nR; i++) {
      for (let j = 0; j < S; j++) {
        const theta = (j / S) * TAU;
        let rf = rings[i].rf;
        let h = rings[i].h * hs;
        if (i === 0) h = lerp(h, cfg.ramp.topHeight * hs, this.#rampWeight(theta)); // lip opens towards the ramp
        else if (rf > 0) {
          if (rf <= rampTopRf) {
            const rampH = lerp(floorH, cfg.ramp.topHeight * hs, clamp01((rf - floorRf) / (rampTopRf - floorRf)));
            h = lerp(h, rampH, this.#rampWeight(theta));
          }
          h += (rand() - 0.5) * cfg.heightJitter * hs;
          rf *= 1 + (rand() - 0.5) * cfg.radiusJitter;
        }
        const R = this.#ovalRadius(rf, theta);
        const lx = Math.cos(theta) * R, lz = Math.sin(theta) * R;
        const k = i * S + j;
        px[k] = lx; pz[k] = lz;
        py[k] = this.#groundY(lx, lz) + h;
        if (i === 0) { lipR[j] = R; lipMax = Math.max(lipMax, R); }
      }
    }

    // pit faces (flat colour per face): terraces = dark walls, light benches, bright bench edges; ore strata in the walls
    const vc = cfg.vein, cc = cfg.colors;
    const phS = rand() * TAU, phW = rand() * TAU, phA = rand() * TAU, phB = rand() * TAU;
    const tint = new THREE.Color();
    const face = (a, b, c, kind, theta) => {
      const cy = (py[a] + py[b] + py[c]) / 3;
      if (kind === 'wall') tint.copy(colors.stone).multiplyScalar(cc.wallShade);
      else if (kind === 'floor') tint.copy(colors.core).multiplyScalar(cc.floorDarken);
      else tint.copy(colors.stone).lerp(colors.core, cc.benchMix).multiplyScalar(kind === 'edge' ? cc.edgeLift : cc.benchLift);
      tint.multiplyScalar((1 + (rand() - 0.5) * cc.jitter) * lerp(cfg.ao, 1, clamp01((cy - floorH) / (topH - floorH))));
      let vein;
      if (kind === 'floor') vein = rand() > vc.floorPatch ? vc.floorFactor : 0; // scattered ore patches, no rays
      else {
        const yn = cy / hs + vc.wave * Math.sin(theta * vc.waveFreq + phW);
        const strata = smooth(vc.threshold, vc.threshold + vc.soft, 0.5 + 0.5 * Math.sin(yn * vc.strataFreq + phS));
        const gap = 0.5 + 0.5 * (vc.breakWeightA * Math.sin(theta * vc.breakFreqA + phA) + vc.breakWeightB * Math.sin(theta * vc.breakFreqB + phB))
          + (rand() - 0.5) * vc.noise;
        const factor = kind === 'wall' ? 1 : kind === 'edge' ? vc.edgeFactor : vc.benchFactor;
        vein = strata * smooth(vc.gapThreshold, vc.gapThreshold + vc.gapSoft, gap) * factor;
      }
      this.#tri(out, V(px[a], py[a], pz[a], tint, vein, 1), V(px[b], py[b], pz[b], tint, vein, 1), V(px[c], py[c], pz[c], tint, vein, 1), false);
    };
    for (let b = 0; b < nR - 1; b++) {
      const toCentre = rings[b + 1].rf === 0;
      for (let j = 0; j < S; j++) {
        const j1 = (j + 1) % S;
        const theta = ((j + 0.5) / S) * TAU;
        const a = b * S + j, bn = b * S + j1, c = (b + 1) * S + j, d = (b + 1) * S + j1;
        face(a, c, bn, kinds[b], theta);
        if (!toCentre) face(bn, c, d, kinds[b], theta);
      }
    }
    this.pitVerts = out.pos.length / 3; // picking range (see constructor)

    // collar: lip → past the lowered terrain, terrain-coloured at the outside, disturbed spoil near the lip
    const col = cfg.collar;
    this.sinkRadius = lipMax + cfg.sink.radiusMargin;
    this.sinkDepth = -Math.min(...base.map((r) => r[1])) * hs + cfg.sink.extraDepth;
    const outerR = this.sinkRadius + this.cell * SQRT2 + col.margin;
    const C = col.rings;
    const spoil = colors.field.clone().multiplyScalar(cc.spoilLift);
    const grid = [];
    for (let k = 0; k <= C; k++) {
      const t = k / C;
      for (let j = 0; j < S; j++) {
        const theta = (j / S) * TAU;
        let lx, ly, lz;
        if (k === 0) { lx = px[j]; ly = py[j]; lz = pz[j]; } else {
          const R = lerp(lipR[j], outerR, t);
          lx = Math.cos(theta) * R; lz = Math.sin(theta) * R;
          ly = this.#groundY(lx, lz) + col.lift + col.mound * hs * (1 - t) * (1 - t) * (1 - this.#rampWeight(theta));
        }
        this.#groundColor(lx, lz, tint).lerp(spoil, col.disturbed * (1 - smooth(0, col.disturbedTo, t)));
        grid.push(V(lx, ly, lz, tint, 0, 1 - t));
      }
    }
    for (let k = 0; k < C; k++) {
      for (let j = 0; j < S; j++) {
        const j1 = (j + 1) % S;
        const a = grid[k * S + j], bn = grid[k * S + j1], c = grid[(k + 1) * S + j], d = grid[(k + 1) * S + j1];
        this.#tri(out, a, c, bn, k > 0);
        this.#tri(out, bn, c, d, k > 0);
      }
    }

    this.#buildRubble(out, tint);
    this.#buildScars(out, tint, spoil, lipR);

    // build-time geometry only to get normals; the batch draws merged copies of the arrays below
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(out.pos, 3));
    geo.computeVertexNormals(); // non-indexed → face normals (faceted rock)
    const p = geo.attributes.position, n = geo.attributes.normal, e = this.cell * NORMAL_EPS;
    for (let v = 0; v < out.smooth.length; v++) { // draped surfaces take the terrain's normal → no visible seam
      if (!out.smooth[v]) continue;
      const lx = p.getX(v), lz = p.getZ(v);
      _n.set(this.#groundY(lx - e, lz) - this.#groundY(lx + e, lz), 2 * e, this.#groundY(lx, lz - e) - this.#groundY(lx, lz + e)).normalize();
      n.setXYZ(v, _n.x, _n.y, _n.z);
    }
    this.positions = p.array;
    this.normals = n.array;
    geo.dispose();
    this.baseColors = new Float32Array(out.col);
    this.colorsOut = new Float32Array(out.col.length);
    this.veins = new Float32Array(out.vein);
    this.darkWeights = new Float32Array(out.dark);
  }

  /** Spoil stones around the lip (polyhedra, own winding, no veins) */
  #buildRubble(out, tint) {
    const cfg = this.cfg, rand = this.rand, rb = cfg.rubble, cc = cfg.colors;
    const tpl = new THREE.DodecahedronGeometry(1, 0);
    const tp = tpl.attributes.position;
    for (let k = 0; k < rb.count; k++) {
      const theta = this.#offRamp(rand() * TAU); // the ramp notch stays clear
      const R = this.#ovalRadius(lerp(rb.rf[0], rb.rf[1], rand()), theta);
      const size = lerp(rb.size[0], rb.size[1], rand()) * this.hs;
      const sx = size * (1 + (rand() - 0.5) * cfg.chunkJitter), sz = size * (1 + (rand() - 0.5) * cfg.chunkJitter);
      const sy = size * rb.flatten;
      const rot = rand() * TAU, cs = Math.cos(rot), sn = Math.sin(rot);
      const cx = Math.cos(theta) * R, cz = Math.sin(theta) * R;
      const cy = this.#groundY(cx, cz) - sy * cfg.chunkSink;
      tint.copy(this.colors.stone).lerp(this.colors.field, rand()).multiplyScalar(1 + (rand() - 0.5) * cc.jitter);
      for (let s = 0; s < tp.count; s++) {
        const vx = tp.getX(s) * sx, vy = tp.getY(s) * sy, vz = tp.getZ(s) * sz;
        out.pos.push(cx + vx * cs - vz * sn, cy + vy, cz + vx * sn + vz * cs);
        out.col.push(tint.r, tint.g, tint.b);
        out.vein.push(0);
        out.dark.push(0);
        out.smooth.push(0);
      }
    }
    tpl.dispose();
  }

  /** Mining scars on the field around the pit: small heaps, dug holes with a spoil rim, tyre tracks out of the ramp */
  #buildScars(out, tint, spoil, lipR) {
    const cfg = this.cfg, rand = this.rand, sc = cfg.scars, cc = cfg.colors, V = OreMineVisual.#vtx;
    const N = sc.sides, lift = sc.lift;
    const spot = () => {
      const theta = this.#offRamp(rand() * TAU);
      const R = this.#ovalRadius(lerp(sc.rf[0], sc.rf[1], rand()), theta);
      return [Math.cos(theta) * R, Math.sin(theta) * R];
    };
    const ring = (cx, cz, radius, yLift) => {
      const pts = [];
      for (let s = 0; s < N; s++) {
        const a = (s / N) * TAU, rr = radius * (1 + (rand() - 0.5) * sc.jitter * 2);
        const lx = cx + Math.cos(a) * rr, lz = cz + Math.sin(a) * rr;
        pts.push([lx, this.#groundY(lx, lz) + yLift, lz]);
      }
      return pts;
    };
    // heaps: low spoil cones
    for (let k = 0; k < sc.heaps; k++) {
      const [cx, cz] = spot();
      const hr = lerp(sc.heapRadius[0], sc.heapRadius[1], rand()) * sc.scale;
      const hh = lerp(sc.heapHeight[0], sc.heapHeight[1], rand()) * sc.scale;
      const ax = cx + (rand() - 0.5) * hr * sc.jitter, az = cz + (rand() - 0.5) * hr * sc.jitter;
      const apex = [ax, this.#groundY(ax, az) + hh, az];
      const pts = ring(cx, cz, hr, lift);
      const heap = spoil.clone().lerp(this.colors.stone, rand() * 0.5);
      for (let s = 0; s < N; s++) {
        const p0 = pts[s], p1 = pts[(s + 1) % N];
        tint.copy(heap).multiplyScalar(1 + (rand() - 0.5) * cc.jitter);
        this.#tri(out, V(p0[0], p0[1], p0[2], tint), V(apex[0], apex[1], apex[2], tint), V(p1[0], p1[1], p1[2], tint), false);
      }
    }
    // dug holes: dark patch inside a low spoil rim
    for (let k = 0; k < sc.digs; k++) {
      const [cx, cz] = spot();
      const dr = lerp(sc.digRadius[0], sc.digRadius[1], rand()) * sc.scale;
      const inner = ring(cx, cz, dr, lift + sc.digRimHeight * sc.scale);
      const outer = inner.map(([lx, , lz]) => {
        const ox = cx + (lx - cx) * sc.digRim, oz = cz + (lz - cz) * sc.digRim;
        return [ox, this.#groundY(ox, oz) + lift, oz];
      });
      const dark = this.#groundColor(cx, cz, new THREE.Color()).multiplyScalar(sc.digDarken);
      const centre = V(cx, this.#groundY(cx, cz) + lift, cz, dark);
      for (let s = 0; s < N; s++) {
        const s1 = (s + 1) % N, i0 = inner[s], i1 = inner[s1], o0 = outer[s], o1 = outer[s1];
        this.#tri(out, V(i0[0], i0[1], i0[2], dark), centre, V(i1[0], i1[1], i1[2], dark), true);
        tint.copy(spoil).multiplyScalar(1 + (rand() - 0.5) * cc.jitter);
        this.#tri(out, V(o0[0], o0[1], o0[2], tint), V(i0[0], i0[1], i0[2], tint), V(o1[0], o1[1], o1[2], tint), false);
        this.#tri(out, V(o1[0], o1[1], o1[2], tint), V(i0[0], i0[1], i0[2], tint), V(i1[0], i1[1], i1[2], tint), false);
      }
    }
    // tyre tracks: two darker strips from the ramp outwards, slightly curving
    const S = cfg.segments;
    const j = Math.round((this.rampAngle / TAU) * S) % S;
    let heading = this.rampAngle;
    const curve = (rand() - 0.5) * 2 * sc.trackCurve;
    const length = sc.trackLength * this.r;
    const steps = Math.max(1, Math.ceil(length / sc.trackStep));
    const step = length / steps;
    const path = [];
    let qx = Math.cos(heading) * lipR[j], qz = Math.sin(heading) * lipR[j];
    for (let i = 0; i <= steps; i++) {
      path.push([qx, qz, heading]);
      heading = this.rampAngle + (curve * (i + 1)) / steps;
      qx += Math.cos(heading) * step;
      qz += Math.sin(heading) * step;
    }
    const half = (sc.trackWidth * sc.scale) / 2;
    for (const side of [-1, 1]) {
      const off = (side * sc.trackGap * sc.scale) / 2;
      const edge = (p, d) => {
        const nx = -Math.sin(p[2]), nz = Math.cos(p[2]);
        const lx = p[0] + nx * (off + d), lz = p[1] + nz * (off + d);
        return V(lx, this.#groundY(lx, lz) + lift, lz, this.#groundColor(lx, lz, tint).multiplyScalar(sc.trackDarken));
      };
      for (let i = 0; i < steps; i++) {
        const a0 = edge(path[i], -half), a1 = edge(path[i], half), b0 = edge(path[i + 1], -half), b1 = edge(path[i + 1], half);
        this.#tri(out, a0, b0, a1, true);
        this.#tri(out, a1, b0, b1, true);
      }
    }
  }

  /**
   * Lowers the terrain MESH under the pit (vertex Y within sinkRadius by sinkDepth below the height field, normals of the
   * touched vertices from the lowered mesh). heightField.heights – what the simulation reads – is never written.
   */
  #sinkTerrain() {
    const geo = this.terrain;
    if (!geo) return;
    const { size, segments, heights } = geo.userData.heightField;
    const cell = this.cell, row = segments + 1, half = size / 2;
    const pos = geo.attributes.position, nor = geo.attributes.normal;
    const R = this.sinkRadius, Rn = R + cell; // normals change one cell further out
    const idx = (v) => (v + half) / cell;
    const ix0 = Math.max(0, Math.floor(idx(this.x - Rn))), ix1 = Math.min(segments, Math.ceil(idx(this.x + Rn)));
    const iz0 = Math.max(0, Math.floor(idx(this.z - Rn))), iz1 = Math.min(segments, Math.ceil(idx(this.z + Rn)));
    let originals = terrainOriginals.get(geo);
    if (!originals) terrainOriginals.set(geo, originals = new Map());
    const touched = [];
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const d = Math.hypot(ix * cell - half - this.x, iz * cell - half - this.z);
        if (d > Rn) continue;
        const k = iz * row + ix;
        touched.push(k);
        if (!originals.has(k)) originals.set(k, [nor.getX(k), nor.getY(k), nor.getZ(k)]);
        if (d < R) pos.setY(k, Math.min(pos.getY(k), heights[k] - this.sinkDepth));
      }
    }
    for (const k of touched) {
      const ix = k % row, iz = (k - ix) / row;
      const l = ix > 0 ? k - 1 : k, r = ix < segments ? k + 1 : k;
      const u = iz > 0 ? k - row : k, d = iz < segments ? k + row : k;
      const gx = (pos.getY(r) - pos.getY(l)) / (((r - l) || 1) * cell);
      const gz = (pos.getY(d) - pos.getY(u)) / ((((d - u) / row) || 1) * cell);
      _n.set(-gx, 1, -gz).normalize();
      nor.setXYZ(k, _n.x, _n.y, _n.z);
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    this.sunk = { geo, touched };
  }

  /** Puts the terrain mesh back (Y from the untouched height field, original normals) */
  #restoreTerrain() {
    if (!this.sunk) return;
    const { geo, touched } = this.sunk;
    const heights = geo.userData.heightField.heights;
    const pos = geo.attributes.position, nor = geo.attributes.normal;
    const originals = terrainOriginals.get(geo);
    for (const k of touched) {
      pos.setY(k, heights[k]);
      const n = originals?.get(k);
      if (n) nor.setXYZ(k, n[0], n[1], n[2]);
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    this.sunk = null;
  }

  #buildChunks() {
    const cfg = this.cfg, rand = this.rand;
    const tpl = new THREE.IcosahedronGeometry(1, 0);
    const tp = tpl.attributes.position;
    this.lumpVerts = tp.count;
    const zones = cfg.chunks.map((zone) => ({ ...zone, count: Math.round(zone.count * cfg.chunkCountScale) }));
    this.lumpCount = zones.reduce((s, zone) => s + zone.count, 0);
    const pos = new Float32Array(this.lumpCount * tp.count * 3);
    const centres = new Float32Array(this.lumpCount * 3);
    let o = 0, l = 0;
    for (const zone of zones) {
      for (let k = 0; k < zone.count; k++) {
        const theta = this.#offRamp(rand() * TAU);
        const rf = lerp(zone.rf[0], zone.rf[1], rand());
        const R = this.#ovalRadius(rf, theta);
        const size = lerp(zone.size[0], zone.size[1], rand()) * cfg.chunkSizeScale;
        const sx = size * (1 + (rand() - 0.5) * cfg.chunkJitter);
        const sy = size * (1 + (rand() - 0.5) * cfg.chunkJitter);
        const sz = size * (1 + (rand() - 0.5) * cfg.chunkJitter);
        const rot = rand() * TAU, cs = Math.cos(rot), sn = Math.sin(rot);
        const cx = Math.cos(theta) * R, cz = Math.sin(theta) * R;
        const cy = this.#groundY(cx, cz) + this.#profileHeight(rf) - sy * cfg.chunkSink;
        centres[l * 3] = cx; centres[l * 3 + 1] = cy; centres[l * 3 + 2] = cz;
        l++;
        for (let s = 0; s < tp.count; s++, o += 3) {
          const vx = tp.getX(s) * sx, vy = tp.getY(s) * sy, vz = tp.getZ(s) * sz;
          pos[o] = cx + vx * cs - vz * sn;
          pos[o + 1] = cy + vy;
          pos[o + 2] = cz + vx * sn + vz * cs;
        }
      }
    }
    tpl.dispose();
    const geo = new THREE.BufferGeometry(); // build-time only (normals)
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    this.lumpPositions = pos;
    this.lumpNormals = geo.attributes.normal.array;
    this.lumpCentres = centres;
    geo.dispose();
  }
}

/**
 * Super node apron: worked gravel ring from the pit edge out to `radius`, draped on the terrain (indexed, vertex colours;
 * the outer edge takes the field colour so it blends into the ground). Local coordinates around (x, baseY, z).
 */
export function createApronGeometry({ x, z, radius, coreRadius, heightAt, planet = null }) {
  const cfg = MAP.superNode.apron;
  const colors = mineColors(planet);
  const rand = prng(hashSeed(x, z) ^ APRON_SEED_SALT);
  const baseY = heightAt(x, z);
  const inner = Math.min(coreRadius * mineLipFactor(true) * cfg.innerFactor, radius * cfg.maxInnerShare);
  const R = cfg.rings + 1, S = cfg.segments;
  const pos = new Float32Array(R * S * 3), col = new Float32Array(R * S * 3);
  const gravel = new THREE.Color().copy(colors.concrete).lerp(colors.core, cfg.coreMix).multiplyScalar(cfg.brightness);
  const c = new THREE.Color();
  for (let i = 0; i < R; i++) {
    const t = i / (R - 1);
    const rr = lerp(inner, radius, t);
    for (let j = 0; j < S; j++) {
      const theta = (j / S) * TAU;
      const lx = Math.cos(theta) * rr, lz = Math.sin(theta) * rr;
      const k = (i * S + j) * 3;
      pos[k] = lx; pos[k + 1] = heightAt(x + lx, z + lz) - baseY + cfg.lift; pos[k + 2] = lz;
      c.copy(gravel).lerp(colors.field, smooth(cfg.fadeStart, 1, t)).multiplyScalar(1 + (rand() - 0.5) * cfg.jitter);
      col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
    }
  }
  const index = [];
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < S; j++) {
      const j1 = (j + 1) % S;
      const a = i * S + j, b = i * S + j1, cc = (i + 1) * S + j, d = (i + 1) * S + j1;
      index.push(a, cc, b, b, cc, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(index);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/** Apron material (vertex colours, drawn over the terrain without z-fighting); caller owns it */
export function createApronMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: MAP.superNode.apron.roughness, metalness: 0,
    polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
  });
}

/** Flat ring draped on the terrain (super node edge glow), local coordinates around (x, baseY, z) */
export function createDrapedRingGeometry({ x, z, inner, outer, segments, lift, heightAt }) {
  const geo = new THREE.RingGeometry(inner, outer, segments);
  geo.rotateX(-Math.PI / 2);
  const baseY = heightAt(x, z);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) p.setY(i, heightAt(x + p.getX(i), z + p.getZ(i)) - baseY + lift);
  p.needsUpdate = true;
  geo.computeBoundingSphere();
  return geo;
}
