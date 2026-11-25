// Steel Men – procedural Attack Enhancer (T2 aura building: +damage dealt in a radius; data by A9 / F2, docs/notes/a9-content.md).
// A tall column with an emitter on top and an aggressive red-orange glow (role tint mixed into the style's neon colour):
//   • pad + team plinth + column by style.silhouette (EnhancerKit: rounded cylinder · angular pillar with buttresses ·
//     round stem with saucers · faceted blade mast), emitter by silhouette (collar + lens · claw prongs · plasma orb · crystal)
//   • a turning ring with lugs / spikes round the emitter (spins up while active), core glow that flickers fast while active,
//     two charge rings that climb the column, a faint spire of light, decent aura ring on the ground (EnhancerKit)
// Size follows stats.structures.attackEnhancer.simBody (halfX ≈ 23, halfZ ≈ 26, height ≈ 42): pad half PAD_HALF, height ≈ 40.
// Visual only, no allocations in update().
import * as THREE from 'three';
import { plateau } from './ProcKit.js';
import { createSharedCache, pulseWave } from './ProcModules.js';
import {
  ENH, enhancerContext, finishShared, pedestal, shaft, auraRing, cornerBeacons, haloRingGeometry, unitRingGlow, EnhancerModel,
} from './EnhancerKit.js';

const TAU = Math.PI * 2;

/** Pad half-size (model units, simBody halfX / halfZ ≈ 23.3 / 26.4) and column */
export const ATTACK_DIM = {
  padHalf: 22.5,
  shaft: { h: 22, w: 9, topW: 5.5 },        // total incl. emitter and spire ≤ simBody.bodyHeight 42.1 (≈ 39 in every style)
  halo: { r: 6.8, tube: 0.32, lugs: 6, lug: [1.8, 1.1, 1.1], spikes: { rounded: 0, angular: 2.2, round: 0, faceted: 2.6 }, lift: 0.3 },
  core: { halo: 3.4, spireH: 6, spireR: 0.3, spireBottomR: 1.0 },
  rise: { r: 5.4, tube: 0.07, period: 1.8, y0: 0.25, y1: 0.95 },   // shares of the column height
};

/** Animation tuning */
export const ATTACK_ANIM = {
  haloIdle: 0.45, haloWork: 3.2, haloEase: 1.5,   // rad/s (× style.anim.spin)
  coreIdle: 0.45, flickerHz: 2.6, flickerDepth: 0.45,
  spireShare: 0.5, riseLevel: [0.35, 1], riseIdleRate: 0.4,
  riseCount: 2,            // charge rings climbing the column, evenly spread in phase (1 / riseCount apart)
  riseSeedStep: 0.31,      // phase offset per instance (share of the period)
  riseEdge: 0.3,           // fade in / out share of a climb (ProcKit plateau)
};

// emitter by silhouette: returns the y of its centre (core glow / halo)
const EMITTERS = {
  rounded: (c, y) => {
    const { b, S } = c;
    b.cylinder(3.9, 3.4, 1.2, 20, S.hullDark, { y: y + 0.6 });
    b.cylinder(2.5, 3.2, 4.0, 20, S.hull, { y: y + 1.2 + 2 });
    b.cylinder(3.0, 2.5, 0.6, 20, S.teamPaint, { y: y + 4.9, detail: ENH.detail });
    b.sphere(2.2, 16, 10, S.plasma, { y: y + 6.0 });
    return y + 6.0;
  },
  angular: (c, y) => {
    const { b, S } = c;
    b.box(5.6, 0.8, 5.6, S.hullDark, { base: true, y });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.taperedBox(1.5, 0.5, 8, 1.5, S.hullDark, { x: sx * 2.3, y: y + 0.8, z: sz * 2.3, rz: sx * 0.2, rx: -sz * 0.2 }, 1.5);
        b.cylinder(0, 0.35, 1.8, 4, S.frame, { x: sx * 1.2, y: y + 9.4, z: sz * 1.2 });
      }
    }
    b.sphere(1.7, 8, 6, S.plasma, { y: y + 4.4 });
    return y + 4.4;
  },
  round: (c, y) => {
    const { b, S, kit } = c;
    b.cylinder(3.4, 2.2, 1.2, 24, S.hullDark, { y: y + 0.6 });
    b.sphere(2.8, 20, 14, S.plasma, { y: y + 4.0 });
    if (kit.rich) b.torus(3.3, 0.1, 4, 28, TAU, S.neon, { rx: Math.PI / 2, y: y + 1.4 });
    return y + 4.0;
  },
  faceted: (c, y) => {
    const { b, S } = c;
    b.box(3.4, 1.0, 3.4, S.teamPaint, { base: true, y, ry: Math.PI / 4, detail: ENH.detail });
    const g = new THREE.OctahedronGeometry(2.1, 0);
    g.scale(1, 2.3, 1);
    b.add(g, S.plasma, { y: y + 6.4 });
    for (let k = 0; k < 4; k++) {
      const a = (k * TAU) / 4 + Math.PI / 4;
      b.taperedBox(0.4, 0.15, 5.4, 1.2, S.teamShade, { x: Math.cos(a) * 1.5, y: y + 1.0, z: Math.sin(a) * 1.5, ry: -a + Math.PI / 2, rz: 0.15 }, 0.6);
    }
    return y + 6.4;
  },
};

function buildShared(kit) {
  const c = enhancerContext(kit);
  const D = ATTACK_DIM;
  const ped = pedestal(c, D.padHalf);
  const top = shaft(c, { y: ped.y, ...D.shaft });
  const coreY = EMITTERS[c.sil](c, top);
  cornerBeacons(c, D.padHalf);
  auraRing(c, D.padHalf);
  const core = c.glows.get('core');
  core.sphere(D.core.halo, 14, 10, { y: coreY });
  core.cylinder(D.core.spireR, D.core.spireBottomR, D.core.spireH, 6, { y: coreY + D.core.spireH / 2 });
  c.glows.get('spire').cylinder(D.core.spireR * 2.2, D.core.spireBottomR * 2.2, D.core.spireH * 0.8, 6, { y: coreY + (D.core.spireH * 0.8) / 2 });
  unitRingGlow(c.glows, 'rise');
  const H = D.halo;
  return finishShared(c, {
    coreY, columnY: ped.y, columnH: D.shaft.h,
    halo: haloRingGeometry(kit, { r: H.r, tube: H.tube, lugs: H.lugs, lug: H.lug, spikes: H.spikes[c.sil] }),
  });
}

const CACHE = createSharedCache(buildShared);

export class AttackEnhancerProc extends EnhancerModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, name: 'AttackEnhancerProc', role: 'attack' });
    try {
      this.#build();
    } catch (err) {
      this.dispose();   // give back the references super() took
      throw err;
    }
  }

  #build() {
    const sh = this.shared;
    this.enhancerLayers();
    this.halo = this.paintMesh(sh.halo, this, { far: true });   // far LOD: drawn frozen in its last pose
    this.halo.position.y = sh.coreY + ATTACK_DIM.halo.lift;
    this.halo.rotation.y = this.seq * 0.9;
    this.haloSpeed = ATTACK_ANIM.haloIdle;
    this.coreGlow = this.layerOf('core');
    this.spireGlow = this.layerOf('spire');
    this.rises = Array.from({ length: ATTACK_ANIM.riseCount }, () => this.layerOf('rise'));
    this.riseClock = (this.seq * ATTACK_ANIM.riseSeedStep) % 1;
  }

  /** @param {number} delta seconds (× power fade) @param {boolean} active */
  update(delta, active = false) {
    if (!this.shared) return;
    const A = ATTACK_ANIM;
    const D = ATTACK_DIM;
    const spin = this.kit.style.anim.spin;
    this.beginUpdate(delta, active);
    // turning ring: spins up while active
    this.haloSpeed += ((active ? A.haloWork : A.haloIdle) - this.haloSpeed) * Math.min(1, delta * A.haloEase);
    this.halo.rotation.y = (this.halo.rotation.y + delta * this.haloSpeed * spin) % TAU;
    // aggressive flicker of the core while active (fast pulse on top of the style pulse)
    const flick = 1 - A.flickerDepth * this.work * (0.5 + 0.5 * Math.sin(TAU * A.flickerHz * this.time));
    const glow = pulseWave(this.time, this.kit.style.anim.pulse) * (A.coreIdle + (1 - A.coreIdle) * this.work) * flick;
    this.coreGlow?.setIntensity(glow);
    this.spireGlow?.setIntensity(A.spireShare * this.work * glow);
    // two charge rings climb the column (slowly while idle)
    this.riseClock = (this.riseClock + (delta * (A.riseIdleRate + (1 - A.riseIdleRate) * this.work)) / D.rise.period) % 1;
    const y0 = this.shared.columnY + this.shared.columnH * D.rise.y0;
    const y1 = this.shared.columnY + this.shared.columnH * D.rise.y1;
    const level = A.riseLevel[0] + (A.riseLevel[1] - A.riseLevel[0]) * this.work;
    for (let i = 0; i < this.rises.length; i++) {
      const l = this.rises[i];
      if (!l) continue;
      const t = (this.riseClock + i / A.riseCount) % 1;
      l.mesh.position.y = y0 + (y1 - y0) * t;
      l.mesh.scale.set(D.rise.r, 1, D.rise.r);
      l.setIntensity(plateau(t, A.riseEdge) * level);
    }
  }
}
