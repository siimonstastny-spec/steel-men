// Steel Mans – procedural rail gun (roadmap 18, defence buildings; `buildable: false`). Drop-in alternative to
// models/3DStructures{race}/RailGun{race}_Anim.glb (the GLB is a placeholder box ±10 × ±10, 14.4 high):
//   • same kit as PointDefenseProc (plinth, tower, turret head, barrel node, sensor, style vent) with ONE long rail pair
//     lying on the head (slightly raised, RAIL_PITCH), coil frames / rings along it, capacitor banks on the back of the head
//   • the coils glow like a capacitor: dark after a shot (fire() → charge 0), refilling at DEFENSE_ANIM.chargeRate
//   • styles by style.silhouette (RAIL_SHAPES): rounded = box rails + team-colour frames, angular = heavy rails + armoured
//     frames, round = round rails + plasma rings, faceted = thin lances + diamond rings joined by laser lines
//   • footprint: plinth ≤ R 8.8 (inside the GLB ±10), barrel tip 8.5 from the axis – also when the building turns
//   • socket: socket_launch_1 (RAIL_SOCKETS) – the data entry lists it in launchSockets
// Visual only, no allocations in update().
import {
  buildDefenseShared, DefenseProcModel, nextDefenseInstance, DEFENSE_DETAIL,
} from './PointDefenseProc.js';
import { createSharedCache } from './ProcModules.js';

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

/** Launch socket names (data: structures.railGun.launchSockets) – the rail pair has one muzzle */
export const RAIL_SOCKETS = ['socket_launch_1'];

/** Rail details (model units; "Share" = share of the related size) */
const RAIL_DETAIL = {
  coilMargin: 0.35,          // frame / ring clearance round the rails
  coilD: 0.5,                // frame depth along the barrel
  coilT: 0.22,               // frame bar thickness
  coilFrom: 0.2, coilTo: 0.85,   // first / last coil as share of the rail length
  ringTube: 0.12, glowTube: 0.28, ringSeg: 24,
  stripT: 0.12,              // glow strip on a frame
  ridge: { rShare: 0.6, hShare: 0.4 },
  cradle: { w: 0.7, h: 1.6, d: 2.0 },
  cap: { r: 0.7, h: 2.2, xShare: 0.3, zShare: -0.28, sink: 0.5, ringTube: 0.05 },
  muzzleFlash: 1.6,          // flash halo (× DEFENSE_DETAIL.flashR)
  accent: { wShare: 0.6, hShare: 0.4, lift: 0.2 },   // accent line on a box rail (share of r)
  seg: { round: 12, cap: 14, capRing: 16, tip: 8, tipV: 6, capDomeU: 12, capDomeV: 6 },
  cap2: { ringOver: 0.03, ringY: 0.3, domeR: 0.9, domeFlat: 0.5 },
  diamondGlow: 0.6,          // glow tube of a diamond ring (share of glowTube)
};

/** Rail gun shapes by style.silhouette (unknown → rounded). barrels.kind picks the rail form, coil the frames. */
export const RAIL_SHAPES = {
  rounded: {
    plinth: { kind: 'box', R: 8.5, h: 2.0, ventX: 5.2, ventZ: -5.2, ventR: 1.1 },
    tower: { seg: 20, rTop: 3.0, rBottom: 3.8, h: 1.6 },
    head: { kind: 'box', w: 5.6, h: 3.0, d: 7.0, ring: 3.2, faceX: 2.8, edge: 1 },
    barrels: { kind: 'box', r: 0.3, len: 10.0, start: -1.5, coils: 5, coil: 'frame', coilSurface: 'team', offsets: [[-0.7, 0.3], [0.7, 0.3]] },
    sensor: { kind: 'dish', mastH: 1.6, z: -2.2 },
    pitch: 0.12,
  },
  angular: {
    plinth: { kind: 'armored', R: 8.8, h: 2.6, baseH: 1.0, ventX: 4.6, ventZ: -4.6, ventR: 1.1 },
    tower: { seg: 4, rTop: 3.2, rBottom: 4.0, h: 1.4 },
    head: { kind: 'wedge', w: 6.4, topW: 5.0, topD: 6.0, h: 3.4, d: 7.4, ring: 3.6, faceX: 3.0 },
    barrels: { kind: 'heavy', r: 0.5, len: 10.0, start: -1.5, coils: 4, coil: 'frame', coilSurface: 'hullDark', offsets: [[-0.95, 0.5], [0.95, 0.5]] },
    sensor: { kind: 'bar', mastH: 1.4, z: -2.4 },
    pitch: 0.1,
  },
  round: {
    plinth: { kind: 'disc', R: 8.0, h: 1.8, ventX: 3.4, ventZ: -3.4, ventR: 1.1 },
    tower: { seg: 24, rTop: 2.6, rBottom: 3.4, h: 1.6 },
    head: { kind: 'dome', r: 3.2, flat: 0.8, ring: 3.0, faceX: 3.2, w: 6.4, d: 6.4 },
    barrels: { kind: 'round', r: 0.38, len: 9.5, start: -1.2, coils: 5, coil: 'ring', coilR: 1.5, offsets: [[-0.8, 0.4], [0.8, 0.4]] },
    sensor: { kind: 'ring', r: 4.2, y: 1.6, z: 0 },
    pitch: 0.12,
  },
  faceted: {
    plinth: { kind: 'faceted', R: 8.0, h: 2.2, ventX: 4.6, ventZ: -4.6, ventR: 0.9 },
    tower: { seg: 4, rTop: 1.4, rBottom: 2.0, h: 2.4 },
    head: { kind: 'box', w: 3.6, h: 2.4, d: 7.4, ring: 2.0, faceX: 1.8, edge: 1 },
    barrels: { kind: 'lance', r: 0.2, len: 10.0, start: -1.5, coils: 5, coil: 'diamond', coilR: 1.1, offsets: [[-0.6, 0.35], [0.6, 0.35]] },
    sensor: { kind: 'crystal', y: 3.2, z: -0.8 },
    pitch: 0.12,
  },
};

const shapeOf = (style) => RAIL_SHAPES[style.silhouette] ?? RAIL_SHAPES.rounded;

// ---------------------------------------------------------------- rails and coils (barrel node space, barrel along +Z)

/** Rail pair + coil frames; the coils' glow goes to the 'charge' layer, the muzzle flash to `flash`. Returns the tip [[x, y, z]]. */
function railBarrels(b, glow, flash, kit, spec, glows) {
  const S = kit.S;
  const D = RAIL_DETAIL;
  const charge = glows.get('charge');
  const { r, len, start } = spec;
  const zEnd = start + len;
  const cy = spec.offsets[0][1];
  const maxX = Math.max(...spec.offsets.map((o) => Math.abs(o[0])));
  for (const [ox, oy] of spec.offsets) {
    const along = { rx: HALF_PI, x: ox, y: oy, z: start + len / 2 };
    switch (spec.kind) {
      case 'heavy':
        b.box(r * 2, r * 2, len, S.frame, { x: ox, y: oy, z: start + len / 2 });
        b.box(r * 2 * D.ridge.rShare, r * 2 * D.ridge.hShare, len, S.hullDark, { x: ox, y: oy + r + r * D.ridge.hShare, z: start + len / 2 });
        break;
      case 'round':
        b.cylinder(r, r, len, D.seg.round, S.hull, along);
        break;
      case 'lance':
        b.cylinder(r, r, len, 4, S.frame, along);
        glow.segment([ox, oy, start], [ox, oy, zEnd], DEFENSE_DETAIL.lance.laserT);
        b.sphere(DEFENSE_DETAIL.lance.tipR, D.seg.tip, D.seg.tipV, S.lens, { x: ox, y: oy, z: zEnd });
        break;
      default:
        b.box(r * 2, r * 2, len, S.frame, { x: ox, y: oy, z: start + len / 2 });
        b.box(r * D.accent.wShare, r * D.accent.hShare, len, S.accent, { x: ox, y: oy + r + r * D.accent.lift, z: start + len / 2 });
    }
  }
  const surface = S[spec.coilSurface] ?? S.neon;
  const halfW = maxX + r + D.coilMargin;
  const halfH = r + D.coilMargin;
  const n = spec.coils;
  for (let k = 0; k < n; k++) {
    const z = start + len * (D.coilFrom + (D.coilTo - D.coilFrom) * (n > 1 ? k / (n - 1) : 0));
    if (spec.coil === 'frame') {   // rectangular frame round both rails
      for (const e of [-1, 1]) {
        b.box(halfW * 2 + D.coilT, D.coilT, D.coilD, surface, { y: cy + e * halfH, z });
        b.box(D.coilT, halfH * 2 + D.coilT, D.coilD, surface, { x: e * halfW, y: cy, z });
        charge.box(halfW * 2, D.stripT, D.coilD * 1.1, { y: cy + e * (halfH + D.coilT / 2), z });
      }
    } else if (spec.coil === 'ring') {   // round ring (plasma)
      b.torus(spec.coilR, D.ringTube, 6, D.ringSeg, TAU, S.neon, { y: cy, z });
      charge.torus(spec.coilR, D.glowTube, 4, D.ringSeg, TAU, { y: cy, z });
    } else {   // diamond ring (4 tubular segments) joined to the next one by laser lines
      b.torus(spec.coilR, D.ringTube, 4, 4, TAU, S.frame, { y: cy, z });
      charge.torus(spec.coilR, D.glowTube * D.diamondGlow, 4, 4, TAU, { y: cy, z });
      if (k < n - 1) {
        const z2 = start + len * (D.coilFrom + (D.coilTo - D.coilFrom) * ((k + 1) / (n - 1)));
        for (const e of [-1, 1]) {
          charge.segment([e * spec.coilR, cy, z], [e * spec.coilR, cy, z2], DEFENSE_DETAIL.lance.laserT);
          charge.segment([0, cy + e * spec.coilR, z], [0, cy + e * spec.coilR, z2], DEFENSE_DETAIL.lance.laserT);
        }
      }
    }
  }
  flash.point([0, cy, zEnd], DEFENSE_DETAIL.flashR * D.muzzleFlash);
  return [[0, cy, zEnd]];
}

// cradle the rails hinge on + capacitor banks on the back of the head
function railTurretExtra(b, glows, kit, shape, head) {
  const S = kit.S;
  const D = RAIL_DETAIL;
  const hd = shape.head;
  const sp = shape.barrels;
  const maxX = Math.max(...sp.offsets.map((o) => Math.abs(o[0])));
  for (const e of [-1, 1]) {
    b.box(D.cradle.w, D.cradle.h, D.cradle.d, S.frame, { x: e * (maxX + sp.r + D.cradle.w / 2), y: head.top });
    const x = e * hd.w * D.cap.xShare;
    const z = hd.d * D.cap.zShare;
    const y = head.top + D.cap.h / 2 - D.cap.sink;
    b.cylinder(D.cap.r, D.cap.r, D.cap.h, D.seg.cap, S.hullDark, { x, y, z });
    b.torus(D.cap.r + D.cap2.ringOver, D.cap.ringTube, 4, D.seg.capRing, TAU, S.neon, { rx: HALF_PI, x, y: y + D.cap.h * D.cap2.ringY, z });
    b.sphere(D.cap.r * D.cap2.domeR, D.seg.capDomeU, D.seg.capDomeV, S.hull, { x, y: y + D.cap.h / 2, z, sy: D.cap2.domeFlat });
  }
}

const RAIL_HOOKS = { turretExtra: railTurretExtra, barrels: railBarrels };
const RAIL_CACHE = createSharedCache((kit) => buildDefenseShared(kit, shapeOf(kit.style), RAIL_HOOKS));

export class RailGunProc extends DefenseProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: RAIL_CACHE, name: 'RailGunProc' });
    try {
      this.assemble(this.shared, nextDefenseInstance(), RAIL_SOCKETS);
    } catch (err) {
      this.dispose();   // give back the references super() took
      throw err;
    }
  }

  /** @param {number} delta seconds @param {boolean} [active] unused */
  update(delta) {
    if (this.shared) this.animate(delta);
  }
}
