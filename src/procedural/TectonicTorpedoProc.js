// Steel Men – procedural Tectonic Torpedo (superweapon of Y: derrick over a deep shaft with a giant drill). Built from the style
// modules:
//   • footprint 20 × 22 (stats.structures.tectonicTorpedo.simBody halfX 10, halfZ 11, bodyHeight ≈ 17.4; structureScale = 1)
//   • four-legged derrick by style.silhouette (rounded: column legs and a frame crown · angular: tapered legs with spikes ·
//     round: sphere-jointed legs and a ring crown · faceted: blade legs and an octagonal crown), shaft collar with a dark hole
//   • the drill hangs on a cable under the crown: with the charge it is lowered towards the shaft and spins faster (cable
//     stretches), at launch it plunges into the shaft (glow burst out of the hole) and is winched back up afterwards
//   • static body = one merged mesh (LODs) + emblem decals + glow layers (beacons, shaft, drill tip) + drill + cable (2 meshes)
// Visual only: nothing here is read by the simulation. No allocations in update(). API: setCharge(ratio, state) / launch().
import { PartBuilder, GlowBuilder } from './ProcKit.js';
import { createSharedCache, beacon, spike, emblemDecalGeometry } from './ProcModules.js';
import {
  SuperweaponProc, StepTurn, newContext, silhouetteOf, plinth, SW_TEAM_DETAIL, sub,
} from './SuperweaponKit.js';

const TAU = Math.PI * 2;

/** Footprint ground box = stats.structures.tectonicTorpedo.simBody (halfX / halfZ); model units = world units */
const BODY = { halfX: 10, halfZ: 11 };

/** Animation tuning (visual only; style.anim.spin multiplies the turning speed) */
export const TORPEDO_ANIM = {
  spinIdle: 0.4, spinFull: 7, plungeSpin: 2,   // rad/s at zero / full energy; extra share while plunging
  jerkTicks: 10,
  tipHigh: 9.6,           // drill tip y at zero energy (drill hangs right under the crown)
  tipLow: 3.5,            // tip y with full energy (just above the shaft mouth)
  tipDeep: -9,            // tip y at the bottom of the plunge (below the ground, hidden)
  plunge: { from: 0.15, to: 0.45, backFrom: 0.62, backTo: 0.95 },   // launch progress: down / back up
  shaft: { r: 1.6, height: 1, base: 0.3, grow: 5, flare: 0.8, plungeGrow: 2, chargeShare: 0.5, dimAbove: 4, dimLevel: 0.5 },   // chargeShare: share of grow with charge; dimLevel while the tip is dimAbove above the ground   // light shaft out of the hole
  tip: { r: 1.2, base: 0.2 },
  minScale: 0.001,        // smallest cable length scale (no zero-scale matrix)
};

/** Shared layout (model units; ground = y 0, plinth top = SW_PLINTH.padH + h = 2.5) */
const LAYOUT = {
  legTop: 15.6, crownH: 1.2, beamYs: [6, 11], beamT: 0.35,
  hole: { r: 1.9, rim: 1.95, rimTube: 0.15 },
  drill: { len: 6, collarR: 1.5, collarH: 1, coneR: 1.6, coneH: 5, flutes: 5, fluteT: 0.25, cable: 0.12 },
};

/** Dimensions by style.silhouette (unknown → rounded) */
const DIM = {
  rounded: { at: 5.6, leg: { kind: 'column', rTop: 0.5, rBottom: 0.75, seg: 14 }, crown: 'frame' },
  angular: { at: 5.6, leg: { kind: 'taper', w: 1.6, topW: 0.9 }, crown: 'frame' },
  round: { at: 5.0, leg: { kind: 'column', rTop: 0.45, rBottom: 0.65, seg: 18, ball: 0.85 }, crown: 'ring', ringSeg: 32, ringRadial: 8 },
  faceted: { at: 5.0, leg: { kind: 'blade', w: 0.8, topW: 0.3, d: 1.8, topD: 0.7 }, crown: 'ring', ringSeg: 8, ringRadial: 4 },
};

const BODIES = {};

function leg(c, D, x, z, y0) {
  const { b, S, kit } = c;
  const K = D.leg;
  const h = LAYOUT.legTop - y0;
  if (K.kind === 'taper') {
    b.taperedBox(K.w, K.topW, h, K.w, S.hull, { x, y: y0, z }, K.topW);
    b.box(K.w + 0.2, 1.2, K.w + 0.2, S.teamPaint, { base: true, x, y: y0, z, detail: SW_TEAM_DETAIL });
    spike(b, kit, { x, y: LAYOUT.legTop, z, h: 1.0, r: 0.3 });
  } else if (K.kind === 'blade') {
    b.taperedBox(K.w, K.topW, h, K.d, S.hull, { x, y: y0, z, ry: Math.atan2(Math.sign(x), Math.sign(z)) }, K.topD);
    b.box(K.d, 1.2, K.d, S.teamPaint, { base: true, x, y: y0, z, ry: Math.PI / 4, detail: SW_TEAM_DETAIL });
  } else {
    b.cylinder(K.rTop, K.rBottom, h, K.seg, S.hull, { x, y: y0 + h / 2, z });
    b.cylinder(K.rBottom + 0.12, K.rBottom + 0.12, 1.2, K.seg, S.teamPaint, { x, y: y0 + 0.6, z, detail: SW_TEAM_DETAIL });
    if (K.ball) b.sphere(K.ball, 12, 8, S.hullDark, { x, y: LAYOUT.legTop });
  }
}

/** Common derrick: legs, cross beams, crown (frame or ring), cable guide, shaft collar and hole, beacons */
function derrick(c, sil, D) {
  const { b, S, kit, glows } = c;
  const y0 = plinth(c, sil, BODY.halfX, BODY.halfZ);
  const L = LAYOUT;
  const at = D.at;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) leg(c, D, sx * at, sz * at, y0);
  for (const y of L.beamYs) {
    for (const e of [-1, 1]) {
      b.box(at * 2, L.beamT, L.beamT, S.hullDark, { y, z: e * at });
      b.box(L.beamT, L.beamT, at * 2, S.hullDark, { y, x: e * at });
    }
  }
  const cy = L.legTop + L.crownH / 2;
  if (D.crown === 'frame') {
    for (const e of [-1, 1]) {
      b.box(at * 2 + 1.4, L.crownH, 1.4, S.teamPaint, { y: cy, z: e * at, detail: SW_TEAM_DETAIL });
      b.box(1.4, L.crownH, at * 2 - 1.4, S.teamPaint, { y: cy, x: e * at, detail: SW_TEAM_DETAIL });
    }
  } else {
    b.torus(at * Math.SQRT2, L.crownH / 2, D.ringRadial, D.ringSeg, TAU, S.teamPaint, { rx: Math.PI / 2, ry: Math.PI / 8, y: cy, detail: SW_TEAM_DETAIL });
  }
  b.box(at * 2, 0.6, 0.8, S.hullDark, { y: cy });
  b.box(0.8, 0.6, at * 2, S.hullDark, { y: cy });
  b.box(2.6, L.crownH, 2.6, S.frame, { y: cy });
  const H = L.hole;
  b.cylinder(H.r, H.r, 0.04, 24, S.hole, { y: y0 + 0.02 });
  b.torus(H.rim, H.rimTube, 5, 24, TAU, S.frame, { rx: Math.PI / 2, y: y0 + 0.1 });
  if (kit.rich) b.torus(H.r * 0.95, 0.06, 4, 32, TAU, S.neon, { rx: Math.PI / 2, y: y0 + 0.06 });
  const top = L.legTop + L.crownH;
  beacon(b, glows.get('beaconA'), kit, [at, top, at]);
  beacon(b, glows.get('beaconA'), kit, [-at, top, -at]);
  c.spec.ground = y0;
}

for (const sil of Object.keys(DIM)) BODIES[sil] = (c) => derrick(c, sil, DIM[sil]);

// ---------------------------------------------------------------- drill + cable + glow

/** Drill bit, origin = cable attachment (top), pointing down: collar, fluted cone, team ring */
function drillGeometry(kit) {
  const S = kit.S;
  const D = LAYOUT.drill;
  const b = new PartBuilder();
  b.cylinder(D.collarR, D.collarR, D.collarH, 12, S.frame, { y: -D.collarH / 2 });
  b.torus(D.collarR, 0.14, 5, 20, TAU, S.teamPaint, { rx: Math.PI / 2, y: -D.collarH });
  const cy = -D.collarH - D.coneH / 2;
  b.cylinder(D.coneR, 0, D.coneH, 14, S.hullDark, { y: cy });
  const slope = Math.atan2(D.coneR, D.coneH);
  const len = Math.hypot(D.coneR, D.coneH);
  for (let k = 0; k < D.flutes; k++) {
    const a = (k * TAU) / D.flutes;
    const r = D.coneR / 2;   // flute lies on the cone surface line (Ry · Rz: tilted outwards at the top, then turned by a)
    b.box(D.fluteT, len, D.fluteT, S.trim, { x: Math.cos(a) * r, y: cy, z: -Math.sin(a) * r, ry: a, rz: -slope });
  }
  return b.build();
}

/** Unit cable (y 0..1, scaled by update()) */
function cableGeometry(kit) {
  const b = new PartBuilder();
  b.cylinder(LAYOUT.drill.cable, LAYOUT.drill.cable, 1, 6, kit.S.frame, { y: 0.5 });
  return b.build();
}

/** Unit light shaft (y 0..1, open tube + thin core) and tip halo */
function shaftGeometry() {
  const g = new GlowBuilder();
  const r = TORPEDO_ANIM.shaft.r;
  g.cylinder(r, r * 0.7, 1, 12, { y: 0.5 });
  g.cylinder(r * 0.35, r * 0.25, 1, 8, { y: 0.5 });
  return g.build();
}

function tipGeometry() {
  const g = new GlowBuilder();
  g.sphere(TORPEDO_ANIM.tip.r, 12, 8, {});
  return g.build();
}

function buildShared(kit) {
  const sil = silhouetteOf(kit, BODIES);
  const c = newContext(kit);
  BODIES[sil](c);
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    drill: drillGeometry(kit),
    cable: cableGeometry(kit),
    shaft: shaftGeometry(),
    tip: tipGeometry(),
    ground: c.spec.ground,
  };
}

const CACHE = createSharedCache(buildShared);

export class TectonicTorpedoProc extends SuperweaponProc {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, name: 'TectonicTorpedoProc' });
    try {
      this.#build();
    } catch (err) {
      this.dispose();
      throw err;
    }
  }

  #build() {
    const sh = this.shared;
    const an = this.kit.style.anim;
    const gc = this.kit.glowColors;
    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    this.beacons = sh.glow.beaconA ? this.glowLayer(sh.glow.beaconA, gc.beacon, { visible: true }) : null;
    this.ground = sh.ground;
    this.drill = this.paintMesh(sh.drill, this, { far: true });   // far LOD: instanced, frozen in its last pose
    this.cable = this.paintMesh(sh.cable, this, { far: true });
    this.cable.position.set(0, LAYOUT.legTop, 0);
    this.turn = new StepTurn(this.drill, { step: an.jerk > 0 ? TAU / TORPEDO_ANIM.jerkTicks : 0, phase: this.seq * 0.9 });
    this.shaftGlow = this.glowLayer(sh.shaft, gc.pulse, { visible: false });
    this.shaftGlow.mesh.position.set(0, this.ground, 0);
    this.tipGlow = this.glowLayer(sh.tip, gc.beam, { parent: this.drill, visible: false });
    this.tipGlow.mesh.position.set(0, -LAYOUT.drill.len, 0);
    this.drill.position.set(0, TORPEDO_ANIM.tipHigh + LAYOUT.drill.len, 0);
  }

  animate(delta, sw) {
    const A = TORPEDO_ANIM;
    const an = this.kit.style.anim;
    const e = sw.energy;
    const p = sw.launchP;
    const plunge = sw.launching ? sub(p, A.plunge.from, A.plunge.to) * (1 - sub(p, A.plunge.backFrom, A.plunge.backTo)) : 0;
    const tip = (A.tipHigh + (A.tipLow - A.tipHigh) * e) * (1 - plunge) + A.tipDeep * plunge;
    const top = tip + LAYOUT.drill.len;
    this.drill.position.y = top;
    this.turn.update(delta, (A.spinIdle + (A.spinFull - A.spinIdle) * e) * (1 + A.plungeSpin * plunge) * an.spin);
    this.cable.position.y = top;   // the unit cable stands on the drill and ends in the crown
    this.cable.scale.y = Math.max(A.minScale, LAYOUT.legTop - top);
    const S = A.shaft;
    const f = sw.flash;
    const burst = 1 + S.flare * plunge;
    this.shaftGlow.mesh.scale.set(burst, S.height + S.grow * e * S.chargeShare + S.grow * S.plungeGrow * plunge, burst);
    this.shaftGlow.setIntensity(f * (S.base + (1 - S.base) * e) * (tip > this.ground + S.dimAbove ? S.dimLevel : 1));
    this.tipGlow.setIntensity(f * (A.tip.base + (1 - A.tip.base) * e) * (1 - plunge));
  }
}
