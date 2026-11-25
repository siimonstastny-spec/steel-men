// Steel Men – procedural Orbital Bomb (superweapon of X / W: launch + targeting tower). Built from the style modules:
//   • footprint 20 × 20 (stats.structures.orbitalBomb.simBody halfX / halfZ 10, bodyHeight ≈ 16; structureScale = 1), front = +Z
//   • tower by style.silhouette (rounded: column with neon rings, railed platform, radar dish · angular: armoured pillar with
//     buttresses and spikes, lance antenna · round: stem with saucers, gyroscope head · faceted: blade mast, floating crystal)
//   • the head (targeting dish / lance / gyro / crystal) points at the sky: it climbs up and spins faster with the charge; a
//     light column grows out of its tip (length ~ energy², pulses when ready, blinks when stalled, flares wide at launch)
//   • static body = one merged mesh (LODs) + emblem decals + glow layers (beacons, column, halo) + the head (1 animated mesh)
// Visual only: nothing here is read by the simulation. No allocations in update(). API: setCharge(ratio, state) / launch()
// (SuperweaponKit.js, docs/notes/b3-common.md).
import * as THREE from 'three';
import { PartBuilder, GlowBuilder } from './ProcKit.js';
import { createSharedCache, beacon, pipeRun, spike, emblemDecalGeometry } from './ProcModules.js';
import {
  SuperweaponProc, StepTurn, newContext, silhouetteOf, plinth, capacitor, SW_TEAM_DETAIL,
} from './SuperweaponKit.js';

const TAU = Math.PI * 2;

/** Footprint ground box = stats.structures.orbitalBomb.simBody (halfX / halfZ); model units = world units */
const BODY = { halfX: 10, halfZ: 10 };

/** Animation tuning (visual only; style.anim multiplies the speeds) */
export const ORBITAL_ANIM = {
  lift: 0,                // the head stays seated on the tower (a lift tore it off the mount; 0 = none)
  spinIdle: 0.25,         // rad/s at zero energy
  spinFull: 2.2,          // rad/s at full energy (× style.anim.spin)
  jerkTicks: 12,          // stepped turning of jerky styles: ticks per revolution
  column: { minLength: 0.001, length: 28, radius: 0.6, outer: 0.5, core: 0.2, power: 2, flare: 1.6, base: 0.35, segments: 10 },
  halo: { r: 1.6, min: 0.4, max: 1.3, flare: 0.6, base: 0.3 },
  bobFreq: 0.35,          // Hz of the head float (amplitude per silhouette in DIM.head.levitate × style.anim.levitate)
};

/** Dimensions by style.silhouette (code knows shapes, the style data picks one; unknown → rounded) */
const DIM = {
  rounded: {
    column: { rTop: 2.0, rBottom: 3.0, h: 7.5, seg: 16 }, teamShare: 0.35,
    neonRings: [0.3, 0.7], platform: { r: 3.2, skirtR: 1.6, skirtH: 0.9, h: 0.5 },
    caps: { at: 6.5, h: 3.0, r: 0.9, seg: 14 }, beacons: 2.7,
    head: { kind: 'dish', tip: 4.6, levitate: 0 },
  },
  angular: {
    pillar: { w: 5.0, topW: 3.0, h: 7.5 }, buttress: { w: 1.4, topW: 0.7, h: 5.0, d: 2.0, topD: 1.0, at: 2.4 },
    platform: { w: 6.4, h: 0.5 }, spikes: { at: 2.8, h: 1.2, r: 0.3 },
    caps: { at: 6.5, h: 3.0, r: 0.9, seg: 6 }, beacons: 2.9,
    head: { kind: 'lance', tip: 4.5, levitate: 0 },
  },
  round: {
    stem: { rTop: 0.9, rBottom: 1.5, h: 7.5, seg: 20 }, teamShare: 0.6, saucers: { ys: [2.0, 4.5, 6.8], r: 1.9, flat: 0.28 },
    cradle: { rTop: 1.4, rBottom: 0.9, h: 0.5 },
    caps: { at: 5.2, h: 3.0, r: 0.9, seg: 16 }, beacons: 3.4,
    head: { kind: 'gyro', tip: 4.4, r: 1.9, tube: 0.12, core: 0.9, center: 2.3, levitate: 0 },
  },
  faceted: {
    mast: { w: 2.8, topW: 1.0, h: 7.5 }, blades: { r: 1.8, w: 0.3, topW: 0.1, h: 5.5, d: 2.4, topD: 0.8 }, cap: { w: 3.2, h: 0.5 },
    caps: { at: 5.8, h: 3.0, r: 0.8, seg: 8 },
    head: { kind: 'crystal', tip: 4.6, size: 1.0, stretch: 2, center: 2.6, discR: 2.2, discH: 0.12, discDy: 1.5, levitate: 0 },
  },
};

const BODIES = {};   // silhouette → body builder (c = construction context)

// ---------------------------------------------------------------- bodies

/** Four corner capacitors with pipes to the tower foot (industrial styles) */
function capacitors(c, D, y0) {
  const K = D.caps;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * K.at;
      const z = sz * K.at;
      capacitor(c, { x, y: y0, z, h: K.h, r: K.r, segments: K.seg });
      pipeRun(c.b, c.kit, [[x, y0 + K.h * 0.6, z], [x * 0.6, y0 + K.h * 0.6, z * 0.6], [x * 0.35, y0 + K.h * 0.6, z * 0.35]], 0.16);
    }
  }
}

BODIES.rounded = (c) => {
  const D = DIM.rounded;
  const { b, S, kit, glows } = c;
  const y0 = plinth(c, 'rounded', BODY.halfX, BODY.halfZ);
  const K = D.column;
  const y1 = y0 + K.h;
  const kt = D.teamShare;
  const rSplit = K.rBottom + (K.rTop - K.rBottom) * kt;
  b.cylinder(rSplit, K.rBottom, K.h * kt, K.seg, S.teamPaint, { y: y0 + (K.h * kt) / 2, detail: SW_TEAM_DETAIL });
  b.cylinder(K.rTop, rSplit, K.h * (1 - kt), K.seg, S.hull, { y: y0 + K.h * kt + (K.h * (1 - kt)) / 2 });
  if (kit.style.neon >= 0.3) {
    for (const k of D.neonRings) b.torus(K.rBottom + (K.rTop - K.rBottom) * k + 0.04, 0.06, 4, 24, TAU, S.neon, { rx: Math.PI / 2, y: y0 + K.h * k });
  }
  const P = D.platform;
  b.cylinder(P.r, P.skirtR, P.skirtH, 16, S.hullDark, { y: y1 - P.skirtH / 2 });
  b.cylinder(P.r, P.r, P.h, 24, S.frame, { y: y1 + P.h / 2 });
  capacitors(c, D, y0);
  for (const e of [-1, 1]) beacon(b, glows.get('beaconA'), kit, [e * D.beacons, y1 + P.h, 0]);
  c.spec.mount = y1 + P.h;
};

BODIES.angular = (c) => {
  const D = DIM.angular;
  const { b, S, kit, glows } = c;
  const y0 = plinth(c, 'angular', BODY.halfX, BODY.halfZ);
  const Pi = D.pillar;
  b.taperedBox(Pi.w, Pi.topW, Pi.h, Pi.w, S.hull, { y: y0 }, Pi.topW);
  const y1 = y0 + Pi.h;
  const Bt = D.buttress;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.taperedBox(Bt.w, Bt.topW, Bt.h, Bt.d, S.hullDark, { x: sx * Bt.at, y: y0, z: sz * Bt.at, ry: Math.atan2(sx, sz) }, Bt.topD);
      spike(b, kit, { x: sx * D.spikes.at, y: y1 + D.platform.h, z: sz * D.spikes.at, h: D.spikes.h, r: D.spikes.r });
    }
  }
  b.box(D.platform.w, D.platform.h, D.platform.w, S.hullDark, { base: true, y: y1 });
  capacitors(c, D, y0);
  for (const e of [-1, 1]) beacon(b, glows.get('beaconA'), kit, [0, y1 + D.platform.h, e * D.beacons]);
  c.spec.mount = y1 + D.platform.h;
};

BODIES.round = (c) => {
  const D = DIM.round;
  const { b, S, kit, glows } = c;
  const y0 = plinth(c, 'round', BODY.halfX, BODY.halfZ);
  const St = D.stem;
  const y1 = y0 + St.h;
  const kt = D.teamShare;
  const rSplit = St.rBottom + (St.rTop - St.rBottom) * kt;
  b.cylinder(rSplit, St.rBottom, St.h * kt, St.seg, S.teamPaint, { y: y0 + (St.h * kt) / 2, detail: SW_TEAM_DETAIL });
  b.cylinder(St.rTop, rSplit, St.h * (1 - kt), St.seg, S.hull, { y: y0 + St.h * kt + (St.h * (1 - kt)) / 2 });
  const Sa = D.saucers;
  Sa.ys.forEach((y, i) => {
    b.sphere(Sa.r, 20, 10, i === 0 ? S.teamPaint : S.hullDark, { y: y0 + y, sy: Sa.flat, ...(i === 0 ? { detail: SW_TEAM_DETAIL } : {}) });
    if (kit.rich) b.torus(Sa.r, 0.07, 4, 28, TAU, S.neon, { rx: Math.PI / 2, y: y0 + y });
  });
  b.cylinder(D.cradle.rTop, D.cradle.rBottom, D.cradle.h, 20, S.hullDark, { y: y1 + D.cradle.h / 2 });
  capacitors(c, D, y0);
  for (const a of [Math.PI / 4, (Math.PI * 3) / 4, (Math.PI * 5) / 4, (Math.PI * 7) / 4]) beacon(b, glows.get('beaconA'), kit, [Math.cos(a) * D.beacons, y0, Math.sin(a) * D.beacons]);
  c.spec.mount = y1 + D.cradle.h;
};

BODIES.faceted = (c) => {
  const D = DIM.faceted;
  const { b, S, kit, glows } = c;
  const y0 = plinth(c, 'faceted', BODY.halfX, BODY.halfZ);
  const M = D.mast;
  const y1 = y0 + M.h;
  b.taperedBox(M.w, M.topW, M.h, M.w, S.hullDark, { y: y0, ry: Math.PI / 4 }, M.topW);
  const Bl = D.blades;
  for (let k = 0; k < 4; k++) {
    const ry = (k * Math.PI) / 2;
    b.taperedBox(Bl.w, Bl.topW, Bl.h, Bl.d, S.hull, { x: Math.round(Math.sin(ry)) * Bl.r, y: y0, z: Math.round(Math.cos(ry)) * Bl.r, ry }, Bl.topD);
  }
  b.cylinder(D.cap.w * 0.5, D.cap.w * 0.5, D.cap.h, 8, S.frame, { y: y1 + D.cap.h / 2, ry: Math.PI / 8 });
  capacitors(c, D, y0);
  beacon(b, glows.get('beaconA'), kit, [0, y1 + D.cap.h, 0]);
  c.spec.mount = y1 + D.cap.h;
};

// ---------------------------------------------------------------- heads (origin = mount point, tip at spec.tip above it)

function dishHead(kit, H) {
  const S = kit.S;
  const b = new PartBuilder();
  b.cylinder(0.9, 1.0, 0.5, 14, S.frame, { y: 0.25 });
  b.cylinder(0.45, 0.55, 1.4, 10, S.hullDark, { y: 1.2 });
  b.cylinder(2.7, 0.7, 0.9, 20, S.trim, { y: 2.2 });
  b.torus(2.7, 0.12, 4, 28, TAU, S.teamPaint, { rx: Math.PI / 2, y: 2.65 });
  b.cylinder(0.06, 0.06, H.tip - 3.1, 6, S.frame, { y: 2.65 + (H.tip - 3.1) / 2 });
  b.sphere(0.3, 8, 6, S.lens, { y: H.tip - 0.3 });
  return b.build();
}

function lanceHead(kit, H) {
  const S = kit.S;
  const b = new PartBuilder();
  b.cylinder(1.2, 1.4, 0.6, 8, S.hullDark, { y: 0.3 });
  b.box(2.4, 0.2, 2.4, S.teamPaint, { y: 0.9, ry: Math.PI / 4, detail: SW_TEAM_DETAIL });
  b.cylinder(0.25, 0.6, 3.2, 6, S.frame, { y: 0.6 + 1.6 });
  for (let i = 0; i < 4; i++) {
    const a = (i * TAU) / 4 + Math.PI / 4;
    spike(b, kit, { x: Math.cos(a) * 1.1, y: 1.0, z: Math.sin(a) * 1.1, h: 2.4, r: 0.28 });
  }
  spike(b, kit, { x: 0, y: 3.4, z: 0, h: H.tip - 3.7, r: 0.3 });
  b.sphere(0.28, 8, 6, S.lens, { y: H.tip - 0.28 });
  return b.build();
}

function gyroHead(kit, H) {
  const S = kit.S;
  const b = new PartBuilder();
  b.cylinder(0.5, 0.8, H.center - H.r - 0.1, 10, S.hullDark, { y: (H.center - H.r - 0.1) / 2 });
  b.sphere(H.core, 16, 10, S.plasma, { y: H.center });
  b.torus(H.r, H.tube, 6, 28, TAU, S.trim, { rx: Math.PI / 2, y: H.center });
  b.torus(H.r, H.tube, 6, 28, TAU, S.teamPaint, { y: H.center });
  b.torus(H.r, H.tube, 6, 28, TAU, S.trim, { ry: Math.PI / 2, y: H.center });
  return b.build();
}

function crystalHead(kit, H) {
  const S = kit.S;
  const b = new PartBuilder();
  const g = new THREE.OctahedronGeometry(H.size, 0);
  g.scale(1, H.stretch, 1);
  b.add(g, S.plasma, { y: H.center });
  for (const s of [-1, 1]) b.box(H.discR * 2, H.discH, H.discR * 2, S.teamPaint, { y: H.center + s * H.discDy, ry: Math.PI / 4 });
  b.cylinder(0.12, 0.12, H.tip - H.center - H.size * H.stretch, 6, S.frame, { y: H.center + H.size * H.stretch + (H.tip - H.center - H.size * H.stretch) / 2 });
  return b.build();
}

const HEADS = { dish: dishHead, lance: lanceHead, gyro: gyroHead, crystal: crystalHead };

/** Unit-height light column (base at y = 0, scaled by update()): wide halo tube + thin core */
function columnGeometry() {
  const C = ORBITAL_ANIM.column;
  const g = new GlowBuilder();
  g.cylinder(C.outer, C.outer, 1, C.segments, { y: 0.5 });
  g.cylinder(C.core, C.core, 1, C.segments, { y: 0.5 });
  return g.build();
}

function haloGeometry() {
  const g = new GlowBuilder();
  g.sphere(ORBITAL_ANIM.halo.r, 14, 10, {});
  return g.build();
}

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sil = silhouetteOf(kit, BODIES);
  const c = newContext(kit);
  BODIES[sil](c);
  const H = DIM[sil].head;
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    head: HEADS[H.kind](kit, H),
    column: columnGeometry(),
    halo: haloGeometry(),
    mount: c.spec.mount,
    tip: H.tip,
    levitate: H.levitate,
  };
}

const CACHE = createSharedCache(buildShared);

// ---------------------------------------------------------------- the model

export class OrbitalBombProc extends SuperweaponProc {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, name: 'OrbitalBombProc' });
    try {
      this.#build();
    } catch (err) {
      this.dispose();
      throw err;
    }
  }

  #build() {
    const sh = this.shared;
    const kit = this.kit;
    const an = kit.style.anim;
    const A = ORBITAL_ANIM;
    const gc = kit.glowColors;
    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    this.beacons = sh.glow.beaconA ? this.glowLayer(sh.glow.beaconA, gc.beacon, { visible: true }) : null;

    this.head = this.paintMesh(sh.head, this, { far: true });   // far LOD: instanced, frozen in its last pose
    this.head.position.set(0, sh.mount, 0);
    this.baseY = sh.mount;
    this.bobAmp = sh.levitate * an.levitate;   // 0 = no float (silhouettes that stay on their mount)
    this.turn = new StepTurn(this.head, { step: an.jerk > 0 ? TAU / A.jerkTicks : 0, phase: this.seq * 0.9 });
    this.column = this.glowLayer(sh.column, gc.beam, { visible: false });
    this.halo = this.glowLayer(sh.halo, gc.pulse, { visible: false });
    this.tipY = sh.tip;
  }

  animate(delta, sw) {
    const A = ORBITAL_ANIM;
    const an = this.kit.style.anim;
    const e = sw.energy;
    const spin = (A.spinIdle + (A.spinFull - A.spinIdle) * e) * an.spin;
    const lift = A.lift * e + this.bobAmp * Math.sin(TAU * A.bobFreq * sw.time);
    this.turn.update(delta, spin);
    this.head.position.y = this.baseY + lift;
    const y = this.baseY + lift + this.tipY;
    const C = A.column;
    const flare = 1 + C.flare * sw.env;
    this.column.mesh.position.set(0, y, 0);
    this.column.mesh.scale.set(C.radius * 2 * flare, Math.max(C.minLength, C.length * Math.pow(e, C.power)), C.radius * 2 * flare);
    this.column.setIntensity(sw.flash * (C.base + (1 - C.base) * e));
    const Hh = A.halo;
    const hs = (Hh.min + (Hh.max - Hh.min) * e) * (1 + Hh.flare * sw.env);
    this.halo.mesh.position.set(0, y, 0);
    this.halo.mesh.scale.setScalar(hs);
    this.halo.setIntensity(sw.flash * (Hh.base + (1 - Hh.base) * e));
  }
}
