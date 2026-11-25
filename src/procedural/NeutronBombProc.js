// Steel Men – procedural Neutron Bomb (superweapon of the super tier, every faction: missile silo with a control bunker). Built
// from the style modules:
//   • footprint 20 × 25.5 (stats.structures.neutronBomb.simBody halfX 10, halfZ 12.75, bodyHeight 15; structureScale = 1),
//     front = +Z; silo mouth towards the front, bunker with a comm mast at the back
//   • silo shape by style.silhouette (rounded: half-disc lids · angular: slab lids · round: half-dome lids · faceted: half-octagon
//     lids); two lids slide apart on a rim round a dark pit; the bomb (hull, team band, nose, fins) waits hidden in the pit
//   • charge: a glow ring round the lids and a glow seam between them grow with the energy (ready = pulse, stalled = blink,
//     lids stay a hair ajar when ready); launch: lids open, the bomb rises, ignites and shoots away upwards, lids close
//   • static body = one merged mesh (LODs) + emblem decals + glow layers (beacons, rim, pit, exhaust) + 2 lids + the bomb
// Visual only: nothing here is read by the simulation. No allocations in update(). API: setCharge(ratio, state) / launch().
import * as THREE from 'three';
import { PartBuilder, GlowBuilder } from './ProcKit.js';
import { createSharedCache, beacon, spike, emblemDecalGeometry, styledBox } from './ProcModules.js';
import {
  SuperweaponProc, newContext, silhouetteOf, plinth, SW_TEAM_DETAIL, sub, ramp,
} from './SuperweaponKit.js';

const TAU = Math.PI * 2;

/** Footprint ground box = stats.structures.neutronBomb.simBody (halfX / halfZ); model units = world units */
const BODY = { halfX: 10, halfZ: 12.75 };

/** Animation tuning (visual only) */
export const NEUTRON_ANIM = {
  ajar: 0.05,             // share of the lid travel kept open while ready
  openAt: [0.05, 0.25],   // launch progress: lids open
  riseAt: [0.18, 0.45],   // the bomb rises out of the pit
  flyAt: [0.45, 0.62],    // ignition and flight away (the bomb is hidden after that)
  closeAt: [0.68, 0.92],  // lids close
  flyDistance: 45,        // model units the bomb travels while it flies (ease-in)
  flameAt: 0.3,           // flame starts here (ramps up until riseAt[1])
  rim: { base: 0.15, closedShare: 0.7 },   // rim / seam glow: base intensity, share lost when the lids are open
  pit: { base: 0.35 },
  alert: { r: 6.0, tube: 0.22, post: 0.3, postH: 3.5, idle: 0.08 },   // ready signal ring + posts; idle = share of the charge glow
  flame: { base: 0.6, grow: 0.8, burnGrow: 0.4 },
  openSignal: 0.5,        // lid opening (share of travel) at which rim / pit glow reach their open state
};

/** Shared layout (model units; plinth top = 2.5) */
const LAYOUT = {
  hole: 4.3, lidR: 4.4, lidH: 0.5, rim: { r: 4.65, tube: 0.3 }, lidLift: 0.3,
  missile: { r: 1.1, body: 5.2, nose: 2.6, bandH: 0.8, fin: [1.2, 1.5, 0.15], restDrop: 8.5, upRise: 1.2 },
};

/** Dimensions by style.silhouette (unknown → rounded): silo z, bunker and mast */
const DIM = {
  rounded: { siloZ: 3.0, lid: 'disc', bunker: { kind: 'box', w: 10, h: 4, d: 5, z: -8.2 }, mast: { x: 3.8, z: -8.2, y: 4, seg: 8, r: 0.3 } },
  angular: { siloZ: 3.0, lid: 'slab', bunker: { kind: 'taper', w: 10, topW: 8, h: 4, d: 5, z: -8.2 }, mast: { x: 3.8, z: -8.2, y: 4, seg: 4, r: 0.35 } },
  round: { siloZ: 2.5, lid: 'dome', bunker: { kind: 'dome', r: 2.6, z: -6.2 }, mast: { x: 0, z: -6.2, y: 2.4, seg: 10, r: 0.28 } },
  faceted: { siloZ: 2.5, lid: 'octagon', bunker: { kind: 'oct', rTop: 2.0, rBottom: 3.0, h: 3.5, z: -6.2 }, mast: { x: 0, z: -6.2, y: 3.5, seg: 4, r: 0.3 } },
};

const BODIES = {};

function silo(c, sil, D) {
  const { b, S, kit, glows } = c;
  const y0 = plinth(c, sil, BODY.halfX, BODY.halfZ);
  const L = LAYOUT;
  const z = D.siloZ;
  b.cylinder(L.hole, L.hole, 0.04, 28, S.hole, { y: y0 + 0.02, z });
  b.torus(L.rim.r, L.rim.tube, 5, 32, TAU, S.frame, { rx: Math.PI / 2, y: y0 + 0.15, z });
  const B = D.bunker;
  let roof = y0;
  if (B.kind === 'box') {
    styledBox(b, kit, B.w, B.h, B.d, S.hull, { base: true, y: y0, z: B.z });
    b.box(B.w + 0.1, 0.5, B.d + 0.1, S.teamPaint, { base: true, y: y0, z: B.z, detail: SW_TEAM_DETAIL });
    roof = y0 + B.h;
  } else if (B.kind === 'taper') {
    b.taperedBox(B.w, B.topW, B.h, B.d, S.hull, { y: y0, z: B.z }, B.d - 2);
    b.box(B.w + 0.1, 0.5, B.d + 0.1, S.teamPaint, { base: true, y: y0, z: B.z, detail: SW_TEAM_DETAIL });
    roof = y0 + B.h;
  } else if (B.kind === 'dome') {
    b.sphere(B.r, 20, 12, S.hull, { y: y0 + 0.2, z: B.z, sy: 0.9 });
    b.torus(B.r * 0.97, 0.18, 4, 28, TAU, S.teamPaint, { rx: Math.PI / 2, y: y0 + 0.6, z: B.z, detail: SW_TEAM_DETAIL });
    roof = y0 + 0.2 + B.r * 0.9;
  } else {
    b.cylinder(B.rTop, B.rBottom, B.h, 8, S.hull, { y: y0 + B.h / 2, z: B.z, ry: Math.PI / 8 });
    b.cylinder(B.rBottom + 0.05, B.rBottom + 0.05, 0.6, 8, S.teamPaint, { y: y0 + 0.3, z: B.z, ry: Math.PI / 8, detail: SW_TEAM_DETAIL });
    roof = y0 + B.h;
  }
  if (kit.rich) b.torus(L.hole * 0.96, 0.06, 4, 36, TAU, S.neon, { rx: Math.PI / 2, y: y0 + 0.06, z });
  // comm mast with a small dish (spike on the angular style), beacon on top
  const M = D.mast;
  const top = 14.4;
  const mh = top - Math.max(roof, y0 + M.y);
  const my = Math.max(roof, y0 + M.y);
  if (sil === 'angular') b.taperedBox(0.9, 0.3, mh, 0.9, S.frame, { x: M.x, y: my, z: M.z }, 0.3);
  else b.cylinder(M.r * 0.7, M.r, mh, M.seg, S.frame, { x: M.x, y: my + mh / 2, z: M.z, ry: sil === 'faceted' ? Math.PI / 4 : 0 });
  if (sil === 'faceted') spike(b, kit, { x: M.x, y: top - 1.5, z: M.z, h: 1.5, r: 0.35, s: S.teamPaint });
  else b.cylinder(1.1, 0.25, 0.3, 14, S.trim, { x: M.x, y: my + mh * 0.6, z: M.z, rx: -Math.PI / 2 + 0.5, ry: 0 });
  beacon(b, glows.get('beaconA'), kit, [M.x, top, M.z]);
  c.spec.ground = y0;
}

for (const sil of Object.keys(DIM)) BODIES[sil] = (c) => silo(c, sil, DIM[sil]);

// ---------------------------------------------------------------- moving parts

/** One lid (the x ≥ 0 half, origin = silo centre; the second lid is the same mesh turned by π) */
function lidGeometry(kit, kind) {
  const S = kit.S;
  const L = LAYOUT;
  const b = new PartBuilder();
  const R = L.lidR;
  if (kind === 'slab') {
    b.box(R, L.lidH, R * 2, S.hull, { x: R / 2 });
  } else if (kind === 'dome') {
    b.add(new THREE.SphereGeometry(R, 20, 8, 0, Math.PI, 0, Math.PI / 2), S.hull, { ry: Math.PI / 2, sy: 0.3, y: -L.lidH / 2 });
  } else {
    b.cylinder(R, R, L.lidH, kind === 'octagon' ? 4 : 14, S.hull, {}, false, 0, Math.PI);
  }
  if (kind !== 'dome') b.box(0.1, L.lidH, R * 2, S.frame, { x: 0.05 });
  const markX = 0.55;   // team marking on the lid, at 0.55 R from the seam (lies on the dome surface there)
  const markY = kind === 'dome' ? -L.lidH / 2 + 0.3 * R * Math.sqrt(1 - markX * markX) : L.lidH / 2 + 0.01;
  b.box(R * 0.5, 0.06, 1.3, S.teamPaint, { x: R * markX, y: markY });
  return b.build();
}

/** Bomb, origin = its base, pointing up (hull, team band, nose cone, four fins, nozzle) */
function missileGeometry(kit) {
  const S = kit.S;
  const M = LAYOUT.missile;
  const b = new PartBuilder();
  b.cylinder(M.r, M.r, M.body, 14, S.hull, { y: M.body / 2 });
  b.cylinder(M.r * 1.03, M.r * 1.03, M.bandH, 14, S.teamPaint, { y: M.body * 0.78 });
  b.cylinder(0, M.r, M.nose, 14, S.hullDark, { y: M.body + M.nose / 2 });
  b.cylinder(M.r * 0.55, M.r * 0.75, 0.4, 10, S.frame, { y: 0.2 });
  for (let k = 0; k < 4; k++) {
    const a = (k * TAU) / 4 + Math.PI / 4;
    b.box(M.fin[0], M.fin[1], M.fin[2], S.frame, { x: Math.cos(a) * (M.r + M.fin[0] / 2), y: M.fin[1] / 2, z: Math.sin(a) * (M.r + M.fin[0] / 2), ry: -a });
  }
  return b.build();
}

/** Glow: ring round the lids + seam between them (rim), flat pit disc, exhaust flame (origin = bomb base, pointing down) */
function rimGeometry() {
  const L = LAYOUT;
  const g = new GlowBuilder();
  g.torus(L.rim.r, 0.14, 4, 40, TAU, { rx: Math.PI / 2, y: 0.1 });
  g.box(0.16, 0.06, L.lidR * 2, { y: 0.1 });
  return g.build();
}

/** Ready signal: wide flat ring round the silo with four tall light posts (pulses only when the weapon is ready) */
function alertGeometry() {
  const A = NEUTRON_ANIM.alert;
  const g = new GlowBuilder();
  g.torus(A.r, A.tube, 4, 48, TAU, { rx: Math.PI / 2, y: 0.1 });
  for (let k = 0; k < 4; k++) {
    const a = (k * TAU) / 4 + Math.PI / 4;
    g.box(A.post, A.postH, A.post, { x: Math.cos(a) * A.r, y: A.postH / 2, z: Math.sin(a) * A.r });
  }
  return g.build();
}

function pitGeometry() {
  const g = new GlowBuilder();
  g.cylinder(LAYOUT.hole * 0.95, LAYOUT.hole * 0.95, 0.05, 24, {}, false);
  return g.build();
}

function flameGeometry() {
  const M = LAYOUT.missile;
  const g = new GlowBuilder();
  g.cylinder(M.r * 0.8, 0.1, 3.5, 10, { y: -1.75 });
  g.sphere(M.r * 0.9, 10, 8, { y: -0.2 });
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
    lid: lidGeometry(kit, D.lid),
    missile: missileGeometry(kit),
    rim: rimGeometry(),
    pit: pitGeometry(),
    alert: alertGeometry(),
    flame: flameGeometry(),
    ground: c.spec.ground,
    siloZ: D.siloZ,
  };
}

const CACHE = createSharedCache(buildShared);

export class NeutronBombProc extends SuperweaponProc {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, name: 'NeutronBombProc' });
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
    const L = LAYOUT;
    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    this.beacons = sh.glow.beaconA ? this.glowLayer(sh.glow.beaconA, gc.beacon, { visible: true }) : null;
    this.siloZ = sh.siloZ;
    this.lidY = sh.ground + L.lidLift;
    this.restY = sh.ground - L.missile.restDrop;
    this.upY = sh.ground + L.missile.upRise;
    // far LOD: the lids are drawn instanced, frozen in their last pose
    this.lidA = this.paintMesh(sh.lid, this, { far: true });
    this.lidB = this.paintMesh(sh.lid, this, { far: true });
    this.lidB.rotation.y = Math.PI;
    this.lidA.position.set(0, this.lidY, this.siloZ);
    this.lidB.position.set(0, this.lidY, this.siloZ);
    this.missile = this.paintMesh(sh.missile, this);
    this.missile.position.set(0, this.restY, this.siloZ);
    this.rim = this.glowLayer(sh.rim, gc.pulse, { visible: false });
    this.rim.mesh.position.set(0, sh.ground + L.lidLift + L.lidH / 2, this.siloZ);
    this.pit = this.glowLayer(sh.pit, gc.pulse, { visible: false });
    this.pit.mesh.position.set(0, sh.ground + 0.04, this.siloZ);
    this.alert = this.glowLayer(sh.alert, gc.beacon, { visible: false });
    this.alert.mesh.position.set(0, sh.ground + 0.2, this.siloZ);
    this.flame = this.glowLayer(sh.flame, gc.beam, { parent: this.missile, visible: false });
  }

  animate(delta, sw) {
    const A = NEUTRON_ANIM;
    const e = sw.energy;
    const p = sw.launchP;
    const launching = sw.launching;
    const open = launching
      ? Math.max(sub(p, A.openAt[0], A.openAt[1]) * (1 - sub(p, A.closeAt[0], A.closeAt[1])), sw.ready ? A.ajar : 0)
      : (sw.ready ? A.ajar : 0);
    const travel = open * LAYOUT.lidR;
    this.lidA.position.x = travel;
    this.lidB.position.x = -travel;

    const gone = launching && p >= A.flyAt[1];
    const rise = launching ? sub(p, A.riseAt[0], A.riseAt[1]) : 0;
    this.missile.visible = launching && !gone && rise > 0;   // never shown at rest (hidden in the pit) – nothing to flash by
    const fly = launching ? ramp(p, A.flyAt[0], A.flyAt[1]) : 0;
    this.missile.position.y = this.restY + (this.upY - this.restY) * rise + A.flyDistance * fly * fly;
    const burn = launching && !gone ? ramp(p, A.flameAt, A.riseAt[1]) : 0;
    this.flame.mesh.scale.set(1, A.flame.base + A.flame.grow * fly + A.flame.burnGrow * burn, 1);
    this.flame.setIntensity(burn);

    const f = sw.flash;
    const openSig = Math.min(1, open / A.openSignal);
    this.rim.setIntensity(f * (A.rim.base + (1 - A.rim.base) * e) * (1 - A.rim.closedShare * openSig));
    this.alert.setIntensity(sw.ready ? f : A.alert.idle * e * e * (sw.stalled ? f : 1));
    this.pit.setIntensity(openSig *(A.pit.base + (1 - A.pit.base) * e) * (launching ? 1 : f));
  }
}
