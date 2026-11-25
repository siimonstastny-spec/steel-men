// Steel Men – procedural Phase Charge (superweapon of Z: crystal / phase generator). Built from the style modules:
//   • footprint 20 × 22.7 (stats.structures.phaseCharge.simBody halfX 10, halfZ 11.36, bodyHeight ≈ 15.8; structureScale = 1)
//   • four pylons round a cradle by style.silhouette (rounded: columns · angular: tapered pylons, faceted core · round: columns
//     with orbs · faceted: blades, crystal core); a blue-violet core hangs between two precessing gyro rings
//   • the core (plasma surface) and its halo grow with the charge, the rings spin up and widen, energy beams link the pylon
//     tips to the core; ready = strong pulse, stalled = blink, launch = flare (core swells, halo and rings burst, then settle)
//   • static body = one merged mesh (LODs) + emblem decals + glow layers (beacons, beams, halo) + core and 2 rings (3 meshes)
// Visual only: nothing here is read by the simulation. No allocations in update(). API: setCharge(ratio, state) / launch().
import * as THREE from 'three';
import { PartBuilder, GlowBuilder } from './ProcKit.js';
import { createSharedCache, beacon, laserLink, emblemDecalGeometry } from './ProcModules.js';
import {
  SuperweaponProc, newContext, silhouetteOf, plinth, SW_TEAM_DETAIL,
} from './SuperweaponKit.js';

const TAU = Math.PI * 2;

/** Footprint ground box = stats.structures.phaseCharge.simBody (halfX / halfZ); model units = world units */
const BODY = { halfX: 10, halfZ: 11.36 };

/** Animation tuning (visual only; style.anim.spin multiplies the ring speeds) */
export const PHASE_ANIM = {
  core: { r: 1.4, min: 0.35, flare: 0.45, spin: 0.6 },                     // core radius; scale min..1, extra scale at launch; rad/s
  halo: { r: 3.4, min: 0.3, flare: 0.9, base: 0.25 },
  rings: [
    { r: 4.9, tube: 0.22, tilt: 0.35, speedIdle: 0.3, speedFull: 2.2, dir: 1 },
    { r: 3.9, tube: 0.2, tilt: -1.1, speedIdle: 0.4, speedFull: 3.0, dir: -1 },
  ],
  ringMin: 0.75, ringFlare: 0.35,                                          // ring scale 0.75..1 with energy, +0.5 at launch
  beams: { base: 0.15 },
};

/** Shared layout (model units; plinth top = 2.5) */
const LAYOUT = {
  orbY: 9.0, pylonTop: 14.2, podR: 0.45, thick: 0.07, stemTopGap: 2.2,
  cradle: { r: 1.7, tube: 0.18 },
};

/** Dimensions by style.silhouette (unknown → rounded) */
const DIM = {
  rounded: { at: 6.0, pylon: { kind: 'column', rTop: 0.45, rBottom: 0.7, seg: 12 }, ring: { radial: 8, seg: 40 }, core: 'sphere', stemSeg: 16 },
  angular: { at: 6.0, pylon: { kind: 'taper', w: 1.4, topW: 0.7 }, ring: { radial: 4, seg: 8 }, core: 'ico', stemSeg: 6 },
  round: { at: 5.2, pylon: { kind: 'column', rTop: 0.4, rBottom: 0.6, seg: 18, ball: 0.8 }, ring: { radial: 8, seg: 48 }, core: 'sphere', stemSeg: 20 },
  faceted: { at: 5.2, pylon: { kind: 'blade', w: 0.6, topW: 0.2, d: 1.6, topD: 0.5 }, ring: { radial: 4, seg: 6 }, core: 'octa', stemSeg: 8 },
};

const BODIES = {};

function pylon(c, D, x, z, y0) {
  const { b, S } = c;
  const K = D.pylon;
  const h = LAYOUT.pylonTop - y0;
  if (K.kind === 'taper') {
    b.taperedBox(K.w, K.topW, h, K.w, S.hull, { x, y: y0, z }, K.topW);
    b.box(K.w + 0.2, 1.2, K.w + 0.2, S.teamPaint, { base: true, x, y: y0, z, detail: SW_TEAM_DETAIL });
  } else if (K.kind === 'blade') {
    b.taperedBox(K.w, K.topW, h, K.d, S.hull, { x, y: y0, z, ry: Math.atan2(Math.sign(x), Math.sign(z)) }, K.topD);
    b.box(K.d, 1.2, K.d, S.teamPaint, { base: true, x, y: y0, z, ry: Math.PI / 4, detail: SW_TEAM_DETAIL });
  } else {
    b.cylinder(K.rTop, K.rBottom, h, K.seg, S.hull, { x, y: y0 + h / 2, z });
    b.cylinder(K.rBottom + 0.12, K.rBottom + 0.12, 1.2, K.seg, S.teamPaint, { x, y: y0 + 0.6, z, detail: SW_TEAM_DETAIL });
  }
  b.sphere(K.ball ?? LAYOUT.podR, 10, 8, S.lens, { x, y: LAYOUT.pylonTop + LAYOUT.podR * 0.4, z });
}

function generator(c, sil, D) {
  const { b, S, kit, glows } = c;
  const y0 = plinth(c, sil, BODY.halfX, BODY.halfZ);
  const L = LAYOUT;
  const laser = glows.get('laser');
  const stemTop = L.orbY - L.stemTopGap;
  const sh = stemTop - y0;
  b.cylinder(1.0, 2.0, sh, D.stemSeg, S.hullDark, { y: y0 + sh / 2 });
  b.cylinder(1.0, 1.0, 0.3, D.stemSeg, S.teamPaint, { y: stemTop - 0.15, detail: SW_TEAM_DETAIL });
  b.torus(L.cradle.r, L.cradle.tube, 5, D.stemSeg * 2, TAU, S.trim, { rx: Math.PI / 2, y: stemTop + 0.2 });
  if (kit.rich) b.torus(L.cradle.r * 0.7, 0.07, 4, 24, TAU, S.neon, { rx: Math.PI / 2, y: stemTop + 0.5 });
  const tipY = L.pylonTop + L.podR * 0.4;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * D.at;
      const z = sz * D.at;
      pylon(c, D, x, z, y0);
      laserLink(b, laser, kit, [x, tipY, z], [x * 0.18, L.orbY, z * 0.18]);
    }
  }
  beacon(b, glows.get('beaconA'), kit, [D.at, tipY + L.podR, D.at]);
  beacon(b, glows.get('beaconA'), kit, [-D.at, tipY + L.podR, -D.at]);
  c.spec.ground = y0;
}

for (const sil of Object.keys(DIM)) BODIES[sil] = (c) => generator(c, sil, DIM[sil]);

// ---------------------------------------------------------------- moving parts (origin = core centre)

function coreGeometry(kit, kind) {
  const R = PHASE_ANIM.core.r;
  const b = new PartBuilder();
  const g = kind === 'octa' ? new THREE.OctahedronGeometry(R * 1.2, 0)
    : kind === 'ico' ? new THREE.IcosahedronGeometry(R, 0)
      : new THREE.SphereGeometry(R, 20, 14);
  b.add(g, kit.S.plasma);
  return b.build();
}

/** Gyro ring lying horizontally (the model tilts and turns it), a quarter of it in the team paint */
function ringGeometry(kit, ring, R) {
  const S = kit.S;
  const b = new PartBuilder();
  b.torus(R.r, R.tube, ring.radial, ring.seg, TAU, S.trim, { rx: Math.PI / 2 });
  b.torus(R.r, R.tube * 1.2, ring.radial, ring.seg, Math.PI / 2, S.teamPaint, { rx: Math.PI / 2, rz: 0 });
  return b.build();
}

function haloGeometry() {
  const g = new GlowBuilder();
  g.sphere(PHASE_ANIM.halo.r, 16, 12, {});
  return g.build();
}

function buildShared(kit) {
  const sil = silhouetteOf(kit, BODIES);
  const D = DIM[sil];
  const c = newContext(kit);
  BODIES[sil](c);
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    core: coreGeometry(kit, D.core),
    rings: PHASE_ANIM.rings.map((R) => ringGeometry(kit, D.ring, R)),
    halo: haloGeometry(),
  };
}

const CACHE = createSharedCache(buildShared);

export class PhaseChargeProc extends SuperweaponProc {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, name: 'PhaseChargeProc' });
    try {
      this.#build();
    } catch (err) {
      this.dispose();
      throw err;
    }
  }

  #build() {
    const sh = this.shared;
    const gc = this.kit.glowColors;
    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    this.beacons = sh.glow.beaconA ? this.glowLayer(sh.glow.beaconA, gc.beacon, { visible: true }) : null;
    this.beams = sh.glow.laser ? this.glowLayer(sh.glow.laser, gc.laser, { visible: false }) : null;
    // far LOD: the moving parts are drawn instanced, frozen in their last pose
    this.core = this.paintMesh(sh.core, this, { far: true });
    this.core.position.set(0, LAYOUT.orbY, 0);
    this.rings = sh.rings.map((geometry, i) => {
      const mesh = this.paintMesh(geometry, this, { far: true });
      mesh.position.set(0, LAYOUT.orbY, 0);
      mesh.rotation.order = 'YXZ';   // tilt first, then turn about the vertical: the ring precesses like a gyroscope
      mesh.rotation.x = PHASE_ANIM.rings[i].tilt;
      mesh.rotation.y = this.seq * 0.8 + i * 2.1;
      return mesh;
    });
    this.halo = this.glowLayer(sh.halo, gc.pulse, { visible: false });
    this.halo.mesh.position.set(0, LAYOUT.orbY, 0);
  }

  animate(delta, sw) {
    const A = PHASE_ANIM;
    const an = this.kit.style.anim;
    const e = sw.energy;
    const env = sw.env;
    const cs = (A.core.min + (1 - A.core.min) * e) * (1 + A.core.flare * env);
    this.core.scale.setScalar(cs);
    this.core.rotation.y += delta * A.core.spin * (0.5 + e) * an.spin;
    const rs = (A.ringMin + (1 - A.ringMin) * e) * (1 + A.ringFlare * env);
    for (let i = 0; i < this.rings.length; i++) {
      const R = A.rings[i];
      const mesh = this.rings[i];
      mesh.rotation.y += delta * R.dir * (R.speedIdle + (R.speedFull - R.speedIdle) * e) * an.spin;
      mesh.scale.setScalar(rs);
    }
    const H = A.halo;
    this.halo.mesh.scale.setScalar((H.min + (1 - H.min) * e) * (1 + H.flare * env));
    this.halo.setIntensity(sw.flash * (H.base + (1 - H.base) * e));
    this.beams?.setIntensity(sw.flash * (A.beams.base + (1 - A.beams.base) * e));
  }
}
