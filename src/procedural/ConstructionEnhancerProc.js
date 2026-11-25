// Steel Men – procedural Construction Enhancer (T2 aura building: build / repair ×1.25, production ×1.1 in a radius; data by A9 / F2).
// A tower crane plus a welding arm on the pad, work-amber glow (role tint mixed into the style's neon colour):
//   • pad + team plinth + tower (EnhancerKit); on top a slewing jib (boom, counter-jib with team counterweight, cab, tie rods)
//     whose trolley slides along the boom with a hanging hook and a flickering weld spark; the jib shape follows
//     style.silhouette (rounded box girder · angular tapered boom with teeth · round tube boom with joints · faceted blade boom)
//   • on the pad a two-segment welding arm (turret + shoulder + elbow) with a spark at its tip
//   • while `active` the jib swings, the trolley travels, the arm works and the sparks flicker; idle: almost still
// Size follows stats.structures.constructionEnhancer.simBody (halfX ≈ 24.4, halfZ ≈ 31.1, height ≈ 36.7): pad half X / Z below.
// Visual only, no allocations in update().
import { PartBuilder, GlowBuilder } from './ProcKit.js';
import { createSharedCache } from './ProcModules.js';
import {
  ENH, enhancerContext, finishShared, pedestal, shaft, auraRing, cornerBeacons, EnhancerModel,
} from './EnhancerKit.js';

const TAU = Math.PI * 2;

export const CONSTRUCTION_DIM = {
  padHalfX: 23.5, padHalfZ: 29,
  shaft: { h: 22, w: 8, topW: 6 },
  slew: { r: 4.2, h: 1.2 },
  boom: { from: 2, len: 20, y: 3.2, t: 1.6, d: 2.0 },
  counter: { len: 9, weightW: 3.2, weightH: 2.6 },
  cab: { w: 3.0, h: 2.8, d: 3.4, x: -1.2, y: 2.2, z: 2.6 },
  mastTop: { h: 5.5, w: 1.2 },
  trolley: { x: [6, 21], drop: 0.4, cable: 10, w: 2.4 },   // drop = carriage centre below the boom underside
  arm: { at: [0.66, 0.62], baseR: 2.3, baseH: 2.3, seg1: 7, seg2: 6, t: 1.2, tip: 0.5, spark: 1.1 },
  spark: 1.5,
};

export const CONSTRUCTION_ANIM = {
  // one work phase (advances by delta × speed share); every motion is a sine of it: amplitude × sin(phase × rate)
  phaseSpeed: 1.0, idleShare: 0.1,       // phase rate (1/s) at work; share of it while idle
  swingIdle: 0.25,                       // share of the swing amplitude while idle (the machine only idles)
  slewAmp: 1.1, slewSpeed: 0.38,         // jib swing: rad, rate
  trolleySpeed: 0.55,                    // trolley travel rate
  sway: 0.04, swaySpeed: 1.3,            // load sway: rad, rate
  arm: { yaw: [0.9, 0.35], shoulder: [-0.75, 0.45, 0.85], elbow: [1.25, 0.55, 1.15] },   // yaw [amplitude, rate]; others [centre, amplitude, rate]
  sparkHz: 9, sparkIdle: 0,
  sparkWorkMin: 0.3,                     // work level from which the sparks flicker
  sparkDim: 0.35, armSparkDim: 0.4,      // intensity share of the hook / arm spark in their dim half-period
  phaseWrap: 1e4,                        // s of phase; wraps (sines of different rates: one tiny jump per ~3 h at work)
};

// ---------------------------------------------------------------- jib (origin = top of the tower, turns round Y, boom along +X)

function jibGeometry(kit, sil, D) {
  const S = kit.S;
  const b = new PartBuilder();
  const B = D.boom;
  b.cylinder(D.slew.r * 0.9, D.slew.r, D.slew.h, 20, S.hullDark, { y: D.slew.h / 2 });
  b.box(D.mastTop.w, D.mastTop.h, D.mastTop.w, S.frame, { base: true, y: D.slew.h });
  const topY = D.slew.h + D.mastTop.h;
  // boom + counter jib by silhouette
  if (sil === 'round') {
    b.cylinder(0.5, 0.8, B.len, 10, S.hull, { x: B.from + B.len / 2, y: B.y, rz: -Math.PI / 2 });
    for (let k = 1; k <= 3; k++) b.sphere(0.9, 10, 8, S.trim, { x: B.from + (B.len * k) / 4, y: B.y });
    b.cylinder(0.5, 0.5, D.counter.len, 10, S.hull, { x: -D.counter.len / 2 - 0.5, y: B.y, rz: Math.PI / 2 });
  } else if (sil === 'angular' || sil === 'faceted') {
    b.taperedBox(B.t, B.t * 0.35, B.len, B.d, S.hull, { x: B.from, y: B.y, rz: -Math.PI / 2 }, B.d * 0.55);
    b.box(D.counter.len, B.t * 0.8, B.d, S.hullDark, { x: -D.counter.len / 2 - 0.5, y: B.y });
    if (sil === 'angular') for (let k = 1; k <= 4; k++) b.cylinder(0, 0.35, 1.6, 4, S.frame, { x: B.from + (B.len * k) / 5.5, y: B.y + B.t * 0.5 + 0.8 });
  } else {
    b.box(B.len, B.t, B.d, S.hull, { x: B.from + B.len / 2, y: B.y });
    b.box(B.len * 0.9, B.t * 0.25, B.d + 0.2, S.accent, { x: B.from + B.len / 2, y: B.y - B.t * 0.4 });
    b.box(D.counter.len, B.t * 0.9, B.d, S.hullDark, { x: -D.counter.len / 2 - 0.5, y: B.y });
  }
  // team counterweight + cab
  b.box(D.counter.weightW, D.counter.weightH, B.d + 0.4, S.teamPaint, { x: -D.counter.len - 0.2, y: B.y - 0.3, detail: ENH.detail });
  const C = D.cab;
  b.box(C.w, C.h, C.d, S.hull, { x: C.x, y: C.y + 0.0, z: C.z });
  b.box(C.w * 0.7, C.h * 0.3, 0.1, S.window, { x: C.x, y: C.y + 0.4, z: C.z + C.d / 2 + 0.03 });
  b.box(C.w + 0.05, 0.4, C.d + 0.05, S.teamPaint, { x: C.x, y: C.y + C.h / 2, z: C.z, detail: ENH.detail });
  // tie rods from the mast top to the boom end and the counter jib end
  for (const x of [B.from + B.len, -D.counter.len]) {
    const dx = x;
    const dy = B.y - topY;
    const l = Math.hypot(dx, dy);
    b.box(l, 0.2, 0.2, S.frame, { x: dx / 2, y: topY + dy / 2, rz: Math.atan2(dy, dx) });
  }
  return b.build();
}

// trolley (origin = on the boom): carriage, cable, hook block
function trolleyGeometry(kit, D) {
  const S = kit.S;
  const T = D.trolley;
  const b = new PartBuilder();
  b.box(T.w, 0.8, D.boom.d + 0.6, S.hullDark, {});
  b.box(0.14, T.cable, 0.14, S.frame, { y: -T.cable / 2 - 0.4 });
  b.box(1.4, 1.2, 1.2, S.teamPaint, { y: -T.cable - 1.0, detail: ENH.detail });
  b.torus(0.5, 0.12, 5, 12, Math.PI * 1.5, S.trim, { y: -T.cable - 2.0, rz: Math.PI * 0.75 });
  return b.build();
}

// welding arm: turret (origin at its pivot), lower arm along +Y; the upper arm is a separate child mesh
function armGeometries(kit, D) {
  const S = kit.S;
  const A = D.arm;
  const low = new PartBuilder();
  low.sphere(A.t * 0.9, 12, 8, S.hullDark, {});
  low.box(A.t, A.seg1, A.t, S.hull, { base: true });
  low.box(A.t * 1.15, A.seg1 * 0.3, A.t * 1.15, S.teamPaint, { base: true, y: A.seg1 * 0.15, detail: ENH.detail });
  const up = new PartBuilder();
  up.sphere(A.t * 0.75, 10, 8, S.frame, {});
  up.box(A.t * 0.8, A.seg2, A.t * 0.8, S.hullDark, { base: true });
  up.cylinder(0, A.tip, 1.4, 6, S.trim, { y: A.seg2 + 0.7 });
  return { low: low.build(), up: up.build() };
}

function buildShared(kit) {
  const c = enhancerContext(kit);
  const D = CONSTRUCTION_DIM;
  const ped = pedestal(c, D.padHalfX, D.padHalfZ);
  const top = shaft(c, { y: ped.y, ...D.shaft });
  const A = D.arm;
  const ax = D.padHalfX * A.at[0];
  const az = D.padHalfZ * A.at[1];
  c.b.cylinder(A.baseR * 0.8, A.baseR, A.baseH, 20, c.S.hullDark, { x: ax, y: ENH.padH + A.baseH / 2, z: az });
  c.b.cylinder(A.baseR * 0.82, A.baseR * 0.82, 0.4, 20, c.S.teamPaint, { x: ax, y: ENH.padH + A.baseH * 0.9, z: az, detail: ENH.detail });
  cornerBeacons(c, Math.min(D.padHalfX, D.padHalfZ));
  auraRing(c, D.padHalfX);
  const sparkHook = new GlowBuilder();
  sparkHook.point([0, -D.trolley.cable - 2.4, 0], D.spark);
  const sparkArm = new GlowBuilder();
  sparkArm.point([0, A.seg2 + 1.6, 0], A.spark);
  const arms = armGeometries(kit, D);
  return finishShared(c, {
    top, armPos: [ax, ENH.padH + A.baseH, az],
    jib: jibGeometry(kit, c.sil, D), trolley: trolleyGeometry(kit, D), armLow: arms.low, armUp: arms.up,
    sparkHook: sparkHook.build(), sparkArm: sparkArm.build(),
  });
}

const CACHE = createSharedCache(buildShared);

export class ConstructionEnhancerProc extends EnhancerModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, name: 'ConstructionEnhancerProc', role: 'construction' });
    try {
      this.#build();
    } catch (err) {
      this.dispose();   // give back the references super() took
      throw err;
    }
  }

  #build() {
    const sh = this.shared;
    const D = CONSTRUCTION_DIM;
    this.enhancerLayers();
    this.jib = this.paintMesh(sh.jib, this, { far: true });   // far LOD: drawn frozen in its last pose
    this.jib.position.y = sh.top;
    this.trolley = this.paintMesh(sh.trolley, this.jib, { far: true });
    this.trolley.position.set(D.trolley.x[0], D.boom.y - D.boom.t / 2 - D.trolley.drop, 0);
    this.armBase = this.paintMesh(sh.armLow, this, { far: true });
    this.armBase.rotation.order = 'YZX';
    this.armBase.position.set(sh.armPos[0], sh.armPos[1], sh.armPos[2]);
    this.armUp = this.paintMesh(sh.armUp, this.armBase, { far: true });
    this.armUp.position.y = D.arm.seg1;
    this.hookSpark = sh.sparkHook ? this.glowLayer(sh.sparkHook, this.glowTint, { parent: this.trolley, visible: false }) : null;
    this.armSpark = sh.sparkArm ? this.glowLayer(sh.sparkArm, this.glowTint, { parent: this.armUp, visible: false }) : null;
    this.phase = this.seq * 1.3;   // work phase (advances faster while active)
    this.pose(0);
  }

  // Sets the poses from the work phase (no allocations)
  pose(w) {
    const A = CONSTRUCTION_ANIM;
    const D = CONSTRUCTION_DIM;
    const p = this.phase;
    const k = 0.5 + 0.5 * Math.sin(p * A.trolleySpeed + 1);
    const a = A.arm;
    this.jib.rotation.y = A.slewAmp * Math.sin(p * A.slewSpeed) * (A.swingIdle + (1 - A.swingIdle) * w);
    this.trolley.position.x = D.trolley.x[0] + (D.trolley.x[1] - D.trolley.x[0]) * k;
    this.trolley.rotation.z = A.sway * Math.sin(p * A.swaySpeed) * w;   // slight sway of the load
    this.armBase.rotation.y = a.yaw[0] * Math.sin(p * a.yaw[1]);
    this.armBase.rotation.z = a.shoulder[0] + a.shoulder[1] * Math.sin(p * a.shoulder[2]) * (A.swingIdle + (1 - A.swingIdle) * w);
    this.armUp.rotation.z = a.elbow[0] + a.elbow[1] * Math.sin(p * a.elbow[2]) * (A.swingIdle + (1 - A.swingIdle) * w);
  }

  /** @param {number} delta seconds (× power fade) @param {boolean} active */
  update(delta, active = false) {
    if (!this.shared) return;
    const A = CONSTRUCTION_ANIM;
    this.beginUpdate(delta, active);
    const w = this.work;
    // the phase runs slowly while idle and at full speed while working; unpowered: delta is 0 → everything stops where it is
    this.phase = (this.phase + delta * A.phaseSpeed * (A.idleShare + (1 - A.idleShare) * w)) % A.phaseWrap;
    this.pose(w);
    const on = Math.sin(TAU * A.sparkHz * this.time) > 0;   // flicker: the hook spark and the arm spark alternate
    const working = w > A.sparkWorkMin;
    this.hookSpark?.setIntensity(working ? w * (on ? 1 : A.sparkDim) : A.sparkIdle);
    this.armSpark?.setIntensity(working ? w * (on ? A.armSparkDim : 1) : A.sparkIdle);
  }
}
