// Steel Men – procedural anti-aircraft turret (roadmap 18, defence buildings; new building, tier 2, air targets only,
// strong). There is no GLB for it: footprint is meant to be similar to the point defence system (plinth ±6.0, Venus disc
// Ø 10), see docs/notes/proc-defense.md for the exact numbers and the data entry the coordinator adds.
//   • same kit as PointDefenseProc (plinth, tower, turret head on a slew ring, barrel node with launch sockets, sensor,
//     style vent) but taller, with FOUR barrels fixed at AA_PITCH above the horizon, ammo boxes on the head and a
//     bigger radar; recoil runs along the tilted barrels
//   • styles by style.silhouette (AA_SHAPES): rounded / angular / round / faceted, same family as the point defence
//   • sockets: socket_launch_1 … socket_launch_4 (AA_SOCKETS) – the data entry lists them in launchSockets
// Visual only, no allocations in update().
import {
  buildDefenseShared, DefenseProcModel, nextDefenseInstance, barrelCluster,
} from './PointDefenseProc.js';
import { createSharedCache } from './ProcModules.js';

/** Launch socket names (data: structures.aaTurret.launchSockets), one per barrel */
export const AA_SOCKETS = ['socket_launch_1', 'socket_launch_2', 'socket_launch_3', 'socket_launch_4'];

/** Ammo boxes on the turret head (model units; "Share" = share of the head size) */
const AA_DETAIL = {
  ammo: { w: 1.1, h: 0.9, d: 2.2, xShare: 0.28, zShare: -0.3, sink: 0.1 },
  cradle: { w: 0.7, h: 1.4, d: 1.8 },
};

// four barrels as a 2 × 2 block (x, y in the tilted barrel node's space)
const FOUR = (x, y) => [[-x, -y], [x, -y], [-x, y], [x, y]];

/** Anti-aircraft shapes by style.silhouette (unknown → rounded). Plinth R stays within ±6.0 (disc Ø 10). */
export const AA_SHAPES = {
  rounded: {
    plinth: { kind: 'box', R: 6.0, h: 1.6, ventX: 3.6, ventZ: -3.6, ventR: 0.8 },
    tower: { seg: 20, rTop: 1.8, rBottom: 2.4, h: 4.5 },
    head: { kind: 'box', w: 5.0, h: 2.6, d: 5.0, ring: 2.2, faceX: 2.5, edge: 1 },
    barrels: { kind: 'tube', r: 0.3, len: 6.0, start: -0.8, offsets: FOUR(0.85, 0.55) },
    sensor: { kind: 'dish', mastH: 1.6, z: -1.4 },
    pitch: 0.95,
  },
  angular: {
    plinth: { kind: 'armored', R: 6.2, h: 2.0, baseH: 0.8, ventX: 3.2, ventZ: -3.2, ventR: 0.8 },
    tower: { seg: 4, rTop: 2.2, rBottom: 3.0, h: 3.2 },
    head: { kind: 'wedge', w: 5.4, topW: 4.4, topD: 4.4, h: 2.8, d: 5.0, ring: 2.8, faceX: 2.6 },
    barrels: { kind: 'shroud', r: 0.36, len: 5.6, start: -0.8, offsets: FOUR(1.0, 0.6) },
    sensor: { kind: 'bar', mastH: 1.4, z: -1.5 },
    pitch: 0.85,
  },
  round: {
    plinth: { kind: 'disc', R: 5.0, h: 1.5, ventX: 1.9, ventZ: -1.9, ventR: 0.8 },
    tower: { seg: 24, rTop: 1.6, rBottom: 2.2, h: 4.0 },
    head: { kind: 'dome', r: 2.6, flat: 0.75, ring: 2.3, faceX: 2.6, w: 5.2, d: 5.2 },
    barrels: { kind: 'emitter', r: 0.38, len: 4.2, start: -0.6, offsets: FOUR(0.8, 0.5) },
    sensor: { kind: 'ring', r: 3.4, y: 1.2, z: 0 },
    pitch: 0.95,
  },
  faceted: {
    plinth: { kind: 'faceted', R: 5.8, h: 2.0, ventX: 3.2, ventZ: -3.2, ventR: 0.7 },
    tower: { seg: 4, rTop: 0.8, rBottom: 1.2, h: 4.8 },
    head: { kind: 'box', w: 3.0, h: 2.2, d: 5.2, ring: 1.5, faceX: 1.5, edge: 1 },
    barrels: { kind: 'lance', r: 0.18, len: 6.5, start: -0.8, offsets: FOUR(0.7, 0.45) },
    sensor: { kind: 'crystal', y: 2.4, z: -0.6 },
    pitch: 1.05,
  },
};

const shapeOf = (style) => AA_SHAPES[style.silhouette] ?? AA_SHAPES.rounded;

// ammo boxes on the shoulders of the head + the trunnion cradle the tilted barrels hinge on
function ammoBoxes(b, glows, kit, shape, head) {
  const A = AA_DETAIL.ammo;
  const C = AA_DETAIL.cradle;
  const hd = shape.head;
  const maxX = Math.max(...shape.barrels.offsets.map((o) => Math.abs(o[0])));
  for (const e of [-1, 1]) {
    b.box(A.w, A.h, A.d, kit.S.teamPaint, { x: e * hd.w * A.xShare, y: head.top - A.sink, z: hd.d * A.zShare });
    b.box(C.w, C.h, C.d, kit.S.frame, { x: e * (maxX + shape.barrels.r + C.w / 2), y: head.top });
  }
}

const AA_HOOKS = { turretExtra: ammoBoxes, barrels: barrelCluster };
const AA_CACHE = createSharedCache((kit) => buildDefenseShared(kit, shapeOf(kit.style), AA_HOOKS));

export class AaTurretProc extends DefenseProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: AA_CACHE, name: 'AaTurretProc' });
    try {
      this.assemble(this.shared, nextDefenseInstance(), AA_SOCKETS);
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
