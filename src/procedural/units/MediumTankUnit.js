// Steel Mans – procedural medium tank (roadmap U1). Balanced tracked tank: wider and longer than the light tank, taller
// turret with a rear bustle, one main cannon. The file belongs to one faction look only: the shape table is keyed by
// style.silhouette and has just the `rounded` entry (every other style falls back to it – shape, not names).
//   • sockets: muzzle, turret, aim, cargo, smoke; bones: hull, turret, barrel, recoil, flash, tracks (see proc-unit-kit.md)
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 7.0 long, 3.7 wide, 3.1 high. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { hull, tracks, turret, weapon, statusLamp } from './UnitModules.js';

/** Shape by style.silhouette (unknown → rounded); sizes in model units */
export const MEDIUM_TANK_SHAPES = {
  rounded: {
    L: 7.0, W: 3.7, H: 1.2,
    turret: { w: 2.5, d: 2.7, h: 0.95, z: -0.06 }, gun: { length: 3.4, caliber: 0.16, pitch: [-0.1, 0.3] },
    status: [-0.34, 1.0, -0.4],
  },
};

const CHASSIS = { gauge: 0.88, tw: 0.26, th: 0.14, hullLift: 0.95, hullL: 0.92 };   // shares of L / W
const BUSTLE = { w: 0.8, h: 0.6, d: 0.7, y: 0.5, z: -0.62 };    // turret rear box: shares of turret w / h / d, centre height share, z share of d
const STOWAGE = { w: 0.22, h: 0.18, d: 0.32, x: 0.5, y: 0.78, z: -0.2 };   // hull side boxes: shares of W / H / L (x, y, z = centre offsets)
const WEAPON_MOUNT = 0.85;   // trunnion z = turret front × this
const SOCKET_AIM = 0.5;      // aim socket at hull top + turret height × this
const SMOKE_Z = 0.45;        // smoke socket behind the centre, share of the hull length

const shapeOf = (kit) => MEDIUM_TANK_SHAPES[kit.style.silhouette] ?? MEDIUM_TANK_SHAPES.rounded;

function buildMediumTank(kit) {
  const s = shapeOf(kit);
  const P = CHASSIS;
  const { L, W, H } = s;
  const ub = new UnitBuilder(kit);
  const th = L * P.th;
  tracks(ub, { L, gauge: W * P.gauge, tw: W * P.tw, th });
  ub.bone('hull', 'root', [0, th * P.hullLift, 0]);
  ub.meta.hull = { bone: 'hull', bank: false };
  const hl = hull(ub, { bone: 'hull', y: 0, L: L * P.hullL, W, H });
  // hull stowage boxes (cheap plain boxes over the track tops)
  const S = kit.S;
  const hb = ub.paint('hull');
  for (const side of [1, -1]) hb.box(W * STOWAGE.w, H * STOWAGE.h, L * STOWAGE.d, S.hullDark, { x: side * W * STOWAGE.x, y: H * STOWAGE.y, z: L * STOWAGE.z });
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h });
  ub.paint('turret').box(t.w * BUSTLE.w, t.h * BUSTLE.h, t.d * BUSTLE.d, S.hull, { y: t.h * BUSTLE.y, z: t.d * BUSTLE.z });
  weapon(ub, 'cannon', {
    parent: 'turret', position: [0, tr.mid, tr.front * WEAPON_MOUNT], length: s.gun.length, caliber: s.gun.caliber, pitch: s.gun.pitch,
  });
  statusLamp(ub, { parent: 'hull', position: [W * s.status[0], H * s.status[1], L * s.status[2]] });
  ub.socket('aim', 'hull', [0, hl.top + t.h * SOCKET_AIM, 0]);
  ub.socket('cargo', 'hull', [0, hl.top, L * s.status[2]]);
  ub.socket('smoke', 'hull', [0, hl.top, -L * CHASSIS.hullL * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildMediumTank);

export class MediumTankUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'mediumTank', name: 'MediumTankUnit' });
  }
}

registerProcUnit('mediumTank', (race, teamColor, opts) => new MediumTankUnit({ race, teamColor, ...opts }));
