// Steel Men – procedural Recon Enhancer (T2 aura building: sight range +25 %, cloak detection in a radius; data by A9 / F2).
// A big sensor mast, clearly larger than the Recon Tower (ReconTowerProc): a tall column with TWO turning arrays, sensor-green
// glow (role tint mixed into the style's neon colour):
//   • pad + team plinth + column (EnhancerKit), on top the main array turning slowly (stepped when the style is jerky) with
//     a sweeping scan beam: rounded = two parabolic dishes on a boom · angular = lattice bar with two plates and spikes ·
//     round = gyroscope hoops round a plasma orb · faceted = crystal with phased-array wings
//   • half way up a ring with three small dishes / plates / orbs turning the other way, glowing dish feeds, decent aura ring
// Size follows stats.structures.reconEnhancer.simBody (halfX ≈ 24.8, halfZ ≈ 25.0, height ≈ 31.6): pad half PAD_HALF.
// Visual only, no allocations in update().
import * as THREE from 'three';
import { PartBuilder, GlowBuilder } from './ProcKit.js';
import { createSharedCache, pulseWave, spike } from './ProcModules.js';
import {
  ENH, enhancerContext, finishShared, pedestal, shaft, auraRing, cornerBeacons, silhouetteOf, EnhancerModel,
} from './EnhancerKit.js';

const TAU = Math.PI * 2;

export const RECON_ENH_DIM = {
  padHalf: 23.5,
  shaft: { h: 15, w: 7, topW: 4.5 },   // total height ≤ 31.5 (simBody 9.47 / modelScale 0.3); worst style = angular ≈ 31.2
  head: { y: 4.4, beamFrom: 2.6, beamLen: 21, beamT: 0.22, beamHalo: 1.3 },     // y = array centre above its mount
  ring: { share: 0.5, r: 7.4, tube: 0.3, dishes: 3, armT: [3.8, 0.45, 0.55], feedR: 0.55 },
};

export const RECON_ENH_ANIM = {
  headSpeed: 0.55, headIdle: 0.45, ringSpeed: -0.9, ringIdle: 0.4, speedEase: 1.4,   // rad/s (× style.anim.spin)
  jerkTicks: 14,                                                                     // steps per turn when style.anim.jerk > 0
  glowIdle: 0.45, beamIdle: 0.35,
};

// ---------------------------------------------------------------- main array by silhouette (origin = mount, centre at head.y)

const ARRAYS = {
  rounded: (kit, H) => {
    const S = kit.S;
    const b = new PartBuilder();
    b.cylinder(2.4, 2.8, 1.2, 16, S.hullDark, { y: 0.6 });
    b.box(1.6, 2.8, 1.6, S.frame, { y: 1.2 + 1.4 });
    b.box(12, 0.8, 1.0, S.hullDark, { y: H.y - 0.3 });
    b.box(4, 0.9, 1.2, S.teamPaint, { y: H.y - 0.3, detail: ENH.detail });
    const tilt = Math.PI / 2 - 0.35;
    for (const s of [-1, 1]) {
      b.cylinder(5.2, 1.0, 1.4, 20, S.trim, { x: s * 5.6, y: H.y + 0.8, rz: -s * tilt });
      b.cylinder(0.12, 0.12, 3.6, 6, S.frame, { x: s * (5.6 + Math.sin(tilt) * 1.8), y: H.y + 0.8 + Math.cos(tilt) * 1.8, rz: -s * tilt });
      b.sphere(0.35, 8, 6, S.lens, { x: s * (5.6 + Math.sin(tilt) * 3.6), y: H.y + 0.8 + Math.cos(tilt) * 3.6 });
      b.cylinder(1.2, 1.6, 1.0, 12, S.teamPaint, { x: s * 4.7, y: H.y - 0.2, rz: -s * tilt, detail: ENH.detail });
    }
    return b.build();
  },
  angular: (kit, H) => {
    const S = kit.S;
    const b = new PartBuilder();
    b.cylinder(2.4, 3.0, 1.4, 8, S.hullDark, { y: 0.7 });
    b.box(1.8, 2.6, 1.8, S.frame, { y: 1.4 + 1.3 });
    b.box(18, 0.9, 1.2, S.hullDark, { y: H.y });
    b.box(7, 1.0, 1.4, S.teamPaint, { y: H.y, detail: ENH.detail });
    for (const s of [-1, 1]) {
      b.box(0.8, 4.4, 0.8, S.frame, { x: s * 7.6, y: H.y + 2.2 });
      b.box(0.5, 4.6, 6.4, S.dark, { x: s * 8.0, y: H.y + 2.4 });
      b.box(0.3, 3.2, 4.6, S.teamShade, { x: s * 8.3, y: H.y + 2.4, detail: ENH.detail });
      spike(b, kit, { x: s * 7.6, y: H.y + 3.6, z: 0, h: 1.6, r: 0.4 });
      const dx = 7.6;
      const dy = H.y - 2.6;
      b.box(Math.hypot(dx, dy), 0.35, 0.35, S.frame, { x: (s * dx) / 2, y: 2.6 + dy / 2, rz: -s * Math.atan2(dy, dx) });
    }
    return b.build();
  },
  round: (kit, H) => {
    const S = kit.S;
    const b = new PartBuilder();
    b.cylinder(1.6, 2.2, 1.2, 20, S.hullDark, { y: 0.6 });
    b.sphere(1.7, 16, 10, S.plasma, { y: H.y });
    b.torus(5.2, 0.26, 6, 32, TAU, S.trim, { rx: Math.PI / 2, y: H.y });
    b.torus(5.2, 0.26, 6, 32, TAU, S.teamPaint, { y: H.y, detail: ENH.detail });
    b.torus(5.2, 0.26, 6, 32, TAU, S.trim, { ry: Math.PI / 2, y: H.y });
    for (const s of [-1, 1]) b.sphere(0.7, 10, 8, S.lens, { x: s * 5.2, y: H.y });
    return b.build();
  },
  faceted: (kit, H) => {
    const S = kit.S;
    const b = new PartBuilder();
    b.box(2.6, 1.0, 2.6, S.hullDark, { base: true, ry: Math.PI / 4 });
    const g = new THREE.OctahedronGeometry(1.7, 0);
    g.scale(1, 2.5, 1);
    b.add(g, S.plasma, { y: H.y });
    for (const s of [-1, 1]) {
      b.taperedBox(0.5, 0.2, 8, 3.6, S.teamShade, { x: s * 1.8, y: H.y - 1.6, rz: -s * (Math.PI / 2 - 0.25), detail: ENH.detail }, 1.6);
      b.cylinder(0.3, 0.3, 0.8, 8, S.lens, { x: s * 9.6, y: H.y - 1.6 + 0.0, rz: Math.PI / 2 });
    }
    for (const s of [-1, 1]) b.box(5.0, 0.2, 5.0, S.teamPaint, { y: H.y + s * 2.6, ry: Math.PI / 4, detail: ENH.detail });
    return b.build();
  },
};

// ---------------------------------------------------------------- dish ring by silhouette (origin = ring centre)

function ringGeometry(kit, R) {
  const S = kit.S;
  const sil = silhouetteOf(kit);
  const b = new PartBuilder();
  b.torus(R.r, R.tube, 6, 36, TAU, S.trim, { rx: Math.PI / 2 });
  for (let i = 0; i < R.dishes; i++) {
    const a = (i / R.dishes) * TAU;
    const cx = Math.cos(a);
    const sz = Math.sin(a);
    b.box(R.armT[0], R.armT[1], R.armT[2], S.teamPaint, { x: cx * (R.r - R.armT[0] / 2), z: sz * (R.r - R.armT[0] / 2), ry: -a, detail: ENH.detail });
    const x = cx * R.r;
    const z = sz * R.r;
    if (sil === 'angular') b.box(0.4, 2.4, 2.4, S.dark, { x, y: 1.3, z, ry: -a });
    else if (sil === 'round') b.sphere(1.1, 12, 8, S.plasma, { x, y: 1.1, z });
    else if (sil === 'faceted') { const g = new THREE.OctahedronGeometry(1.0, 0); g.scale(1, 1.8, 1); b.add(g, S.plasma, { x, y: 1.3, z }); }
    else b.cylinder(1.9, 0.4, 0.7, 14, S.trim, { x, y: 0.9, z });
  }
  return b.build();
}

function buildShared(kit) {
  const c = enhancerContext(kit);
  const D = RECON_ENH_DIM;
  const ped = pedestal(c, D.padHalf);
  const top = shaft(c, { y: ped.y, ...D.shaft });
  cornerBeacons(c, D.padHalf);
  auraRing(c, D.padHalf);
  const H = D.head;
  const R = D.ring;
  // scan beam (child of the array, along +X) and glowing dish feeds (children of the ring)
  const beam = new GlowBuilder();
  beam.segment([H.beamFrom, H.y, 0], [H.beamLen, H.y, 0], H.beamT);
  beam.point([0, H.y, 0], H.beamHalo * 1.3);
  const feeds = new GlowBuilder();
  for (let i = 0; i < R.dishes; i++) {
    const a = (i / R.dishes) * TAU;
    feeds.point([Math.cos(a) * R.r, 1.4, Math.sin(a) * R.r], R.feedR);
  }
  return finishShared(c, {
    top, ringY: ped.y + D.shaft.h * R.share,
    array: ARRAYS[c.sil](kit, H), ring: ringGeometry(kit, R), beam: beam.build(), feeds: feeds.build(),
  });
}

const CACHE = createSharedCache(buildShared);

export class ReconEnhancerProc extends EnhancerModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, name: 'ReconEnhancerProc', role: 'recon' });
    try {
      this.#build();
    } catch (err) {
      this.dispose();   // give back the references super() took
      throw err;
    }
  }

  #build() {
    const sh = this.shared;
    const A = RECON_ENH_ANIM;
    const an = this.kit.style.anim;
    this.enhancerLayers();
    this.array = this.paintMesh(sh.array, this, { far: true });
    this.array.position.y = sh.top;
    this.ringMesh = this.paintMesh(sh.ring, this, { far: true });
    this.ringMesh.position.y = sh.ringY;
    this.headAngle = this.seq * 0.9;
    this.ringAngle = this.seq * 1.7;
    this.headSpeed = A.headSpeed * A.headIdle;
    this.ringSpeed = A.ringSpeed * A.ringIdle;
    this.step = an.jerk > 0 ? TAU / A.jerkTicks : 0;
    this.beamGlow = sh.beam ? this.glowLayer(sh.beam, this.glowTint, { parent: this.array, visible: false }) : null;
    this.feedGlow = sh.feeds ? this.glowLayer(sh.feeds, this.glowTint, { parent: this.ringMesh, visible: false }) : null;
  }

  /** @param {number} delta seconds (× power fade) @param {boolean} active */
  update(delta, active = false) {
    if (!this.shared) return;
    const A = RECON_ENH_ANIM;
    const an = this.kit.style.anim;
    this.beginUpdate(delta, active);
    const ease = Math.min(1, delta * A.speedEase);
    const w = active ? 1 : 0;
    this.headSpeed += (A.headSpeed * (A.headIdle + (1 - A.headIdle) * w) - this.headSpeed) * ease;
    this.ringSpeed += (A.ringSpeed * (A.ringIdle + (1 - A.ringIdle) * w) - this.ringSpeed) * ease;
    this.headAngle = (this.headAngle + delta * this.headSpeed * an.spin) % TAU;
    this.ringAngle = (this.ringAngle + delta * this.ringSpeed * an.spin) % TAU;
    this.array.rotation.y = this.step > 0 ? Math.round(this.headAngle / this.step) * this.step : this.headAngle;
    this.ringMesh.rotation.y = this.ringAngle;
    const glow = pulseWave(this.time, an.pulse) * (A.glowIdle + (1 - A.glowIdle) * this.work);
    this.beamGlow?.setIntensity(glow * (A.beamIdle + (1 - A.beamIdle) * this.work));
    this.feedGlow?.setIntensity(glow);
  }
}
