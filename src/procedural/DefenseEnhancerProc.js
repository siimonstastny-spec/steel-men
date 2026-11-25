// Steel Men – procedural Defense Enhancer (T2 aura building: −damage taken in a radius; data by A9 / F2, docs/notes/a9-content.md).
// A low dome on a wide plinth inside a shield ring, shield-blue glow (role tint mixed into the style's neon colour):
//   • pad + team plinth (EnhancerKit), central dome by style.silhouette (rounded hemisphere on a drum · angular faceted
//     cone · round orb · faceted crystal prism), four pylons at the corners (EnhancerKit.shaft) with glowing nodes and
//     light links to the dome apex
//   • two gyroscope hoops round the dome (horizontal + vertical, turning in opposite directions), a slowly pulsing translucent
//     shield bubble (one hemisphere glow layer, very dim) and the decent aura ring on the ground
// Size follows stats.structures.defenseEnhancer.simBody (halfX = halfZ ≈ 21.2, height ≈ 30): pad half PAD_HALF, pylons 26 high.
// Visual only, no allocations in update().
import * as THREE from 'three';
import { createSharedCache, pulseWave } from './ProcModules.js';
import {
  ENH, enhancerContext, finishShared, pedestal, shaft, auraRing, cornerBeacons, haloRingGeometry, EnhancerModel,
} from './EnhancerKit.js';

const TAU = Math.PI * 2;

export const DEFENSE_DIM = {
  padHalf: 20,
  pylon: { at: 0.62, h: 24, w: 3.4, topW: 2.0 },          // at = share of the pad half
  dome: { r: 8.5, drumH: 2.2, apex: 8.5, seg: [18, 8] },   // seg = dome sphere segments (width, height)
  hoop: { r: 11.5, tube: 0.28, lift: 0.55, lugs: 6, lug: [1.5, 0.9, 0.9] },   // lift = share of the dome radius above the plinth
  bubble: { r: 18.5, wSeg: 20, hSeg: 8 },
  pylonSeg: 8,            // radial segments of the small pylons (triangle budget, LOD0 ≤ 8 000 in every style)
  link: 0.2,              // thickness of the light links pylon top → dome apex
};

export const DEFENSE_ANIM = {
  hoopSpeed: [0.5, -0.8], hoopIdle: 0.5,          // rad/s (× style.anim.spin), idle share
  bubbleIdle: 0.07, bubbleWork: 0.15, bubbleBreath: 0.025, bubbleHz: 0.18,
  nodeIdle: 0.5,
};

// dome by silhouette: returns the y of the dome centre / apex
const DOMES = {
  rounded: (c, y, D) => {
    const { b, S } = c;
    b.cylinder(D.r, D.r * 1.08, D.drumH, 20, S.hullDark, { y: y + D.drumH / 2 });
    b.cylinder(D.r + 0.05, D.r * 1.08 + 0.05, D.drumH * 0.4, 20, S.teamPaint, { y: y + D.drumH * 0.2, detail: ENH.detail });
    b.add(new THREE.SphereGeometry(D.r, D.seg[0], D.seg[1], 0, TAU, 0, Math.PI / 2), S.hull, { y: y + D.drumH });
    return { mid: y + D.drumH + D.r * 0.5, apex: y + D.drumH + D.r };
  },
  angular: (c, y, D) => {
    const { b, S } = c;
    b.cylinder(D.r * 0.7, D.r * 1.1, D.apex + D.drumH, 8, S.hull, { y: y + (D.apex + D.drumH) / 2 });
    b.cylinder(D.r * 0.8, D.r * 1.1, D.drumH, 8, S.teamPaint, { y: y + D.drumH / 2, detail: ENH.detail });
    b.cylinder(0, D.r * 0.3, 2.2, 4, S.frame, { y: y + D.apex + D.drumH + 1.1 });
    return { mid: y + (D.apex + D.drumH) * 0.55, apex: y + D.apex + D.drumH + 2.2 };
  },
  round: (c, y, D) => {
    const { b, S, kit } = c;
    b.cylinder(D.r * 0.9, D.r * 1.1, D.drumH, 20, S.hullDark, { y: y + D.drumH / 2 });
    b.sphere(D.r, D.seg[0], D.seg[1], S.hull, { y: y + D.drumH + D.r * 0.45, sy: 0.9 });
    b.sphere(D.r * 0.45, 12, 8, S.plasma, { y: y + D.drumH + D.r * 0.5 });
    if (kit.rich) b.torus(D.r * 1.0, 0.1, 4, 24, TAU, S.neon, { rx: Math.PI / 2, y: y + D.drumH + D.r * 0.45 });
    return { mid: y + D.drumH + D.r * 0.5, apex: y + D.drumH + D.r * 1.3 };
  },
  faceted: (c, y, D) => {
    const { b, S } = c;
    b.box(D.r * 1.6, D.drumH, D.r * 1.6, S.teamPaint, { base: true, y, ry: Math.PI / 4, detail: ENH.detail });
    const g = new THREE.OctahedronGeometry(D.r * 1.05, 0);
    g.scale(1, 1.15, 1);
    b.add(g, S.hull, { y: y + D.drumH + D.r * 0.9 });
    const g2 = new THREE.OctahedronGeometry(D.r * 0.4, 0);
    g2.scale(1, 1.6, 1);
    b.add(g2, S.plasma, { y: y + D.drumH + D.r * 0.9 });
    return { mid: y + D.drumH + D.r * 0.9, apex: y + D.drumH + D.r * 2.0 };
  },
};

function buildShared(kit) {
  const c = enhancerContext(kit);
  const D = DEFENSE_DIM;
  const ped = pedestal(c, D.padHalf);
  const dome = DOMES[c.sil](c, ped.y, D.dome);
  const node = c.glows.get('node');
  const apex = [0, dome.apex, 0];
  const pylonAt = D.padHalf * D.pylon.at;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * pylonAt;
      const z = sz * pylonAt;
      const top = shaft(c, { x, z, y: ENH.padH, seg: D.pylonSeg, ...D.pylon });
      node.sphere(D.pylon.topW * 0.9, 10, 8, { x, y: top + 0.6, z });
      node.segment([x, top + 0.6, z], apex, D.link);
    }
  }
  node.sphere(D.dome.r * 0.35, 10, 8, { y: dome.apex });
  cornerBeacons(c, D.padHalf);
  auraRing(c, D.padHalf);
  // shield bubble: hemisphere over the whole building (additive, kept very dim by update())
  c.glows.get('bubble').add(new THREE.SphereGeometry(D.bubble.r, D.bubble.wSeg, D.bubble.hSeg, 0, TAU, 0, Math.PI / 2), { y: ENH.padH });
  const H = D.hoop;
  const hy = ped.y + D.dome.r * H.lift;
  return finishShared(c, {
    hoopY: hy,
    hoopH: haloRingGeometry(kit, { r: H.r, tube: H.tube, lugs: H.lugs, lug: H.lug, plane: 'h' }),
    hoopV: haloRingGeometry(kit, { r: H.r * 0.9, tube: H.tube, lugs: H.lugs, lug: H.lug, plane: 'v', phase: Math.PI / H.lugs }),
  });
}

const CACHE = createSharedCache(buildShared);

export class DefenseEnhancerProc extends EnhancerModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, name: 'DefenseEnhancerProc', role: 'defense' });
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
    this.hoops = [sh.hoopH, sh.hoopV].map((g, i) => {
      const m = this.paintMesh(g, this, { far: true });
      m.position.y = sh.hoopY;
      m.rotation.y = this.seq * 0.7 + i;
      return m;
    });
    this.nodeGlow = this.layerOf('node');
    this.bubble = this.layerOf('bubble', this.glowTint, { opacity: 0.6 });
  }

  /** @param {number} delta seconds (× power fade) @param {boolean} active */
  update(delta, active = false) {
    if (!this.shared) return;
    const A = DEFENSE_ANIM;
    const an = this.kit.style.anim;
    this.beginUpdate(delta, active);
    const k = A.hoopIdle + (1 - A.hoopIdle) * this.work;
    for (let i = 0; i < this.hoops.length; i++) this.hoops[i].rotation.y = (this.hoops[i].rotation.y + delta * A.hoopSpeed[i] * an.spin * k) % TAU;
    // slowly pulsing shield bubble: brighter and "breathing" while active
    const wave = 0.5 + 0.5 * Math.sin(TAU * A.bubbleHz * this.time);
    this.bubble?.setIntensity((A.bubbleIdle + (A.bubbleWork - A.bubbleIdle) * this.work) * (0.65 + 0.35 * wave));
    if (this.bubble) {
      const s = 1 + A.bubbleBreath * this.work * wave;
      this.bubble.mesh.scale.set(s, s, s);
    }
    this.nodeGlow?.setIntensity(pulseWave(this.time, an.pulse) * (A.nodeIdle + (1 - A.nodeIdle) * this.work));
  }
}
