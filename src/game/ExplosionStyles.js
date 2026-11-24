// Steel Men – unit death explosions: data (data/explosions.json) resolved per unit kind x race, plus a batched
// particle field (three InstancedMeshes: glow / smoke / debris). Visual only: uses its own seeded generator,
// never world.rng, never touches the simulation. Played by Effects (unitDeath / explodeUnit / burn).
import * as THREE from 'three';
import { VFX } from '../config.js';

const DATA_URL = './data/explosions.json';
const DEFAULT_RACE = 'default';
const POOL_NAMES = ['glow', 'smoke', 'debris'];
const ALL_POOLS = [...POOL_NAMES, 'damage']; // + persistent damage smoke (own pool so explosions never starve it)
const MODE = { glow: 0, smoke: 1, debris: 2 };

let data = null;
let promise = null;
const plans = new Map();   // "kind|race" -> resolved plan
const _color = new THREE.Color();

/** Loads data/explosions.json once (Effects.preload) */
export function loadExplosionData(url = DATA_URL) {
  promise ??= fetch(url)
    .then((res) => { if (!res.ok) throw new Error(`Explosions ${url}: HTTP ${res.status}`); return res.json(); })
    .then((d) => { data = d; plans.clear(); damagePlans.clear(); return d; });
  return promise;
}

export const explosionData = () => data;

/** Unit kind from data: unitKinds[unitId] ?? mech (has parts) ?? aircraft (airborne) ?? vehicle */
export function kindOf(unit) {
  const byId = unit?.unitId ? data.unitKinds?.[unit.unitId] : null;
  return byId ?? (unit?.parts ? 'mech' : unit?.airborne ? 'aircraft' : 'vehicle');
}

/**
 * Resolved effect of a unit (cached per kind x race) or null when the data is missing (callers fall back to
 * VFX.mechExplosion). { size, heightByAim, delay, layers[], burn|null, pools: { glow, smoke, debris } }
 */
export function explosionPlan(unit) {
  if (!data) return null;
  const kind = kindOf(unit);
  const race = data.races[unit.race] ? unit.race : DEFAULT_RACE;
  const key = `${kind}|${race}`;
  if (!plans.has(key)) plans.set(key, buildPlan(data.kinds[kind], data.races[race], kind));
  return plans.get(key);
}

const damagePlans = new Map(); // target kind ('unit' | 'building') -> resolved damage smoke spec

/**
 * Damage smoke spec for 'unit' | 'building' (data.damage) or null when the data / section is missing.
 * { threshold, rateMin, rateMax, sizeFrom, sizeTo, sizeGain, lifeMin, lifeMax, rise, drift, height, spread, c: Float32Array[light rgb, dark rgb] }
 */
export function damagePlan(kind) {
  const d = data?.damage;
  const s = d?.[kind];
  if (!s) return null;
  if (!damagePlans.has(kind)) {
    damagePlans.set(kind, {
      threshold: s.threshold, rateMin: s.rateMin, rateMax: s.rateMax, sizeFrom: s.sizeFrom, sizeTo: s.sizeTo, sizeGain: s.sizeGain,
      lifeMin: s.life[0], lifeMax: s.life[1], rise: s.rise, drift: s.drift, height: s.height, spread: s.spread,
      c: new Float32Array([...colorOf({}, d.lightColor), ...colorOf({}, d.darkColor)]),
    });
  }
  return damagePlans.get(kind);
}

function colorOf(palette, name) {
  _color.set(palette[name] ?? name);
  return [_color.r, _color.g, _color.b];
}

function buildPlan(kind, race, kindKey) {
  if (!kind || !race) return null;
  const rs = race.size ?? 1;
  const sp = race.speed ?? 1;
  const mix = race.mix ?? {};
  const pools = {};
  for (const name of POOL_NAMES) {
    const s = kind.pools?.[name];
    const count = s ? Math.round(s.count * (mix[name] ?? 1)) : 0;
    if (count <= 0) { pools[name] = null; continue; }
    pools[name] = {
      count,
      speedMin: s.speed[0] * sp, speedMax: s.speed[1] * sp, up: s.up, ring: name === 'smoke' ? 0 : (race.ring ?? 0),
      sizeFrom: s.size[0] * rs, sizeTo: s.size[1] * rs, lifeMin: s.life[0], lifeMax: s.life[1],
      gravity: s.gravity, drag: s.drag,
      c: new Float32Array([...colorOf(race.palette, s.color[0]), ...colorOf(race.palette, s.color[1])]),
    };
  }
  let burn = null;
  if (kind.burn) {
    const b = kind.burn;
    burn = {
      flameRate: b.flameRate * (mix.glow ?? 1), smokeRate: b.smokeRate * (mix.smoke ?? 1), height: b.height, spread: b.spread,
      flameFrom: b.flameSize[0] * rs, flameTo: b.flameSize[1] * rs, smokeFrom: b.smokeSize[0] * rs, smokeTo: b.smokeSize[1] * rs,
      flameLifeMin: b.flameLife[0], flameLifeMax: b.flameLife[1], smokeLifeMin: b.smokeLife[0], smokeLifeMax: b.smokeLife[1],
      rise: b.rise, smokeRise: b.smokeRise,
      flameC: new Float32Array([...colorOf(race.palette, 'core'), ...colorOf(race.palette, 'fire')]),
      smokeC: new Float32Array([...colorOf(race.palette, 'smoke'), ...colorOf(race.palette, 'smoke')]),
    };
  }
  const layers = race.layers
    .filter((l) => !l.kinds || l.kinds.includes(kindKey))
    .map((l) => ({ ...l, color: typeof l.color === 'string' && l.color[0] === '$' ? race.palette[l.color.slice(1)] : l.color }));
  return { size: kind.size * rs, heightByAim: !!kind.heightByAim, delay: kind.delay ?? 0, layers, burn, pools };
}

// ---------- batched particles ----------

class Pool {
  constructor(scene, geo, material, max, mode, engine) {
    this.mode = mode;
    this.engine = engine;
    this.max = max;
    this.n = 0;
    this.mesh = new THREE.InstancedMesh(geo, material, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _color.set(0xffffff)); // allocates instanceColor
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = this.mesh.receiveShadow = false;
    this.mesh.raycast = () => {};
    this.mesh.renderOrder = VFX.renderOrder;
    scene.add(this.mesh);
    this.scene = scene;
    // Structure of arrays, allocated once
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 's0', 's1', 'r', 'g', 'b', 'grav', 'drag', 'gy']) this[k] = new Float32Array(max);
    this.grounded = new Uint8Array(max);
  }

  add(x, y, z, vx, vy, vz, life, s0, s1, r, g, b, grav, drag, gy) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.x[i] = x; this.y[i] = y; this.z[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.age[i] = 0; this.life[i] = life; this.s0[i] = s0; this.s1[i] = s1; this.r[i] = r; this.g[i] = g; this.b[i] = b;
    this.grav[i] = grav; this.drag[i] = drag; this.gy[i] = gy; this.grounded[i] = 0;
  }

  #move(dst, src) {
    for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz', 'age', 'life', 's0', 's1', 'r', 'g', 'b', 'grav', 'drag', 'gy']) this[k][dst] = this[k][src];
    this.grounded[dst] = this.grounded[src];
  }

  update(dt) {
    const e = this.engine;
    // Integrate + remove finished (swap with the last, which has already been processed)
    for (let i = this.n - 1; i >= 0; i--) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this.#move(i, --this.n); continue; }
      const damp = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= damp; this.vz[i] *= damp; this.vy[i] = this.vy[i] * damp - this.grav[i] * dt;
      this.x[i] += this.vx[i] * dt; this.y[i] += this.vy[i] * dt; this.z[i] += this.vz[i] * dt;
      if (this.mode === MODE.debris && this.y[i] <= this.gy[i]) {
        this.y[i] = this.gy[i]; this.vy[i] = 0;
        const f = Math.max(0, 1 - e.groundFriction * dt);
        this.vx[i] *= f; this.vz[i] *= f;
      }
    }
    // Write the instance buffers
    const mat = this.mesh.instanceMatrix.array;
    const col = this.mesh.instanceColor.array;
    for (let i = 0; i < this.n; i++) {
      const k = this.age[i] / this.life[i];
      let s = this.s0[i] + (this.s1[i] - this.s0[i]) * k;
      let c = 1;
      if (this.mode === MODE.glow) c = (1 - k) ** e.glowFadePower;
      else if (this.mode === MODE.smoke && k > e.smokeFadeStart) s *= 1 - (k - e.smokeFadeStart) / (1 - e.smokeFadeStart);
      else if (this.mode === MODE.debris && k > e.debrisLingerFade) s *= 1 - (k - e.debrisLingerFade) / (1 - e.debrisLingerFade);
      const o = i * 16;
      mat[o] = s; mat[o + 1] = 0; mat[o + 2] = 0; mat[o + 3] = 0;
      mat[o + 4] = 0; mat[o + 5] = s; mat[o + 6] = 0; mat[o + 7] = 0;
      mat[o + 8] = 0; mat[o + 9] = 0; mat[o + 10] = s; mat[o + 11] = 0;
      mat[o + 12] = this.x[i]; mat[o + 13] = this.y[i]; mat[o + 14] = this.z[i]; mat[o + 15] = 1;
      const q = i * 3;
      col[q] = this.r[i] * c; col[q + 1] = this.g[i] * c; col[q + 2] = this.b[i] * c;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.mesh.material.dispose();
  }
}

/** Shared particle field of one Effects instance (created on first use) */
export class ParticleField {
  constructor(scene) {
    const e = data.engine;
    this.rngState = e.seed >>> 0;
    this.geo = new THREE.IcosahedronGeometry(1, e.sphereDetail);
    const base = { vertexColors: false, fog: false };
    this.pools = {
      glow: new Pool(scene, this.geo, new THREE.MeshBasicMaterial({ ...base, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), e.glowMax, MODE.glow, e),
      smoke: new Pool(scene, this.geo, new THREE.MeshBasicMaterial({ ...base, transparent: true, opacity: e.smokeOpacity, depthWrite: false }), e.smokeMax, MODE.smoke, e),
      debris: new Pool(scene, this.geo, new THREE.MeshBasicMaterial({ ...base }), e.debrisMax, MODE.debris, e),
    };
    const dmg = data.damage;
    if (dmg) this.pools.damage = new Pool(scene, this.geo, new THREE.MeshBasicMaterial({ ...base, transparent: true, opacity: dmg.opacity, depthWrite: false }), dmg.max, MODE.smoke, e);
  }

  /** One damage smoke puff; severity 0..1 (more = bigger and darker), spec = damagePlan(kind), sizeScale = per-target multiplier */
  damagePuff(spec, severity, sizeScale, x, y, z) {
    const pool = this.pools.damage;
    if (!pool) return;
    const a = this.rand() * Math.PI * 2;
    const m = Math.min(1, Math.max(0, severity + (this.rand() - 0.5) * 0.3)); // light -> dark with a little per-puff variation
    const c = spec.c;
    const grow = (1 + (spec.sizeGain - 1) * severity) * sizeScale;
    pool.add(x, y, z, Math.cos(a) * spec.drift, spec.rise * (0.7 + this.rand() * 0.6), Math.sin(a) * spec.drift,
      spec.lifeMin + this.rand() * (spec.lifeMax - spec.lifeMin), spec.sizeFrom * grow, spec.sizeTo * grow,
      c[0] + (c[3] - c[0]) * m, c[1] + (c[4] - c[1]) * m, c[2] + (c[5] - c[2]) * m, 0, 0.5, y);
  }

  /** Own mulberry32 – visual randomness must never touch world.rng */
  rand() {
    let t = (this.rngState = (this.rngState + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** One explosion burst of a pool spec (plan.pools[name]) at a point; gy = ground height under it */
  spray(name, spec, x, y, z, gy) {
    if (!spec) return;
    const pool = this.pools[name];
    for (let n = 0; n < spec.count; n++) {
      const u = this.rand() * 2 - 1;
      const a = this.rand() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      const dy = spec.up > 0 ? (Math.abs(u) * spec.up + (1 - spec.up) * u) * (1 - spec.ring) : u * (1 - spec.ring);
      const sp = spec.speedMin + this.rand() * (spec.speedMax - spec.speedMin);
      const m = this.rand();
      const c = spec.c;
      pool.add(x, y, z, Math.cos(a) * r * sp, dy * sp, Math.sin(a) * r * sp,
        spec.lifeMin + this.rand() * (spec.lifeMax - spec.lifeMin), spec.sizeFrom, spec.sizeTo,
        c[0] + (c[3] - c[0]) * m, c[1] + (c[4] - c[1]) * m, c[2] + (c[5] - c[2]) * m, spec.gravity, spec.drag, gy);
    }
  }

  /** One flame (glow) or smoke puff of a burning unit */
  puff(smoke, b, x, y, z) {
    const pool = smoke ? this.pools.smoke : this.pools.glow;
    const a = this.rand() * Math.PI * 2;
    const c = smoke ? b.smokeC : b.flameC;
    const m = this.rand();
    const rise = smoke ? b.smokeRise : b.rise;
    pool.add(x, y, z, Math.cos(a) * 3, rise * (0.6 + this.rand() * 0.8), Math.sin(a) * 3,
      smoke ? b.smokeLifeMin + this.rand() * (b.smokeLifeMax - b.smokeLifeMin) : b.flameLifeMin + this.rand() * (b.flameLifeMax - b.flameLifeMin),
      smoke ? b.smokeFrom : b.flameFrom, smoke ? b.smokeTo : b.flameTo,
      c[0] + (c[3] - c[0]) * m, c[1] + (c[4] - c[1]) * m, c[2] + (c[5] - c[2]) * m, 0, 0.5, y);
  }

  update(dt) {
    for (const name of ALL_POOLS) this.pools[name]?.update(dt);
  }

  dispose() {
    for (const name of ALL_POOLS) this.pools[name]?.dispose();
    this.geo.dispose();
  }
}
