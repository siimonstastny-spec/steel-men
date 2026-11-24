// Steel Mans – procedural heavy tank (roadmap U2): massive tracked hull, big turret, heavy cannon (muzzle, barrel pitch,
// recoil) and a weak rotary AA machine gun on the turret roof (second weapon: socket muzzle_2, bone barrel_2).
//   • dimensions per style.silhouette (ROCKET_HEAVY_TANK_SHAPES, unknown → first entry); looks adapt through the modules
//   • sockets: muzzle (cannon), muzzle_2 (AA gun), turret, aim, cargo, smoke
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 8.0 long, 4.9 wide, 3.3 high. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { hull, tracks, turret, weapon, statusLamp } from './UnitModules.js';

/** Shapes by style.silhouette (sizes in model units; shares of L / W where noted) */
export const ROCKET_HEAVY_TANK_SHAPES = {
  angular: {
    L: 8.0, W: 4.4, H: 1.5, trackH: 0.14, gauge: 0.88, trackW: 0.26, hullLift: 0.95, hullL: 0.92,
    turret: { w: 3.0, d: 3.2, h: 1.1, z: -0.07 },
    gun: { length: 4.4, caliber: 0.2, pitch: [-0.1, 0.3] },
    aa: { x: 0.28, z: -0.0, length: 1.1, caliber: 0.05, pitch: [0, 0] },   // x share of turret width, above the roof
    aaLift: 0.14,
    status: [-0.3, -0.3],   // x, z shares of W, L
  },
};

const WEAPON_MOUNT = 0.85;   // trunnion z = turret front × this
const SOCKET_AIM = 0.5;      // aim socket at hull top + turret height × this
const SMOKE_Z = 0.45;        // smoke socket z share of the hull length (behind the centre)

const shapeOf = (kit) => ROCKET_HEAVY_TANK_SHAPES[kit.style.silhouette] ?? Object.values(ROCKET_HEAVY_TANK_SHAPES)[0];

function buildHeavyTank(kit) {
  const s = shapeOf(kit);
  const { L, W, H } = s;
  const ub = new UnitBuilder(kit);
  const th = L * s.trackH;
  tracks(ub, { L, gauge: W * s.gauge, tw: W * s.trackW, th });
  ub.bone('hull', 'root', [0, th * s.hullLift, 0]);
  ub.meta.hull = { bone: 'hull', bank: false };
  const hl = hull(ub, { bone: 'hull', y: 0, L: L * s.hullL, W, H });
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h });
  weapon(ub, 'cannon', {
    parent: 'turret', position: [0, tr.mid, tr.front * WEAPON_MOUNT], length: s.gun.length, caliber: s.gun.caliber, pitch: s.gun.pitch,
  });
  weapon(ub, 'gun', {
    parent: 'turret', position: [t.w * s.aa.x, tr.top + s.aaLift, t.d * s.aa.z], length: s.aa.length, caliber: s.aa.caliber, pitch: s.aa.pitch, sfx: '_2',
  });
  statusLamp(ub, { parent: 'hull', position: [W * s.status[0], hl.top, L * s.status[1]] });
  ub.socket('aim', 'hull', [0, hl.top + t.h * SOCKET_AIM, 0]);
  ub.socket('cargo', 'hull', [0, hl.top, L * s.status[1]]);
  ub.socket('smoke', 'hull', [0, hl.top, -L * s.hullL * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildHeavyTank);

export class RocketHeavyTankUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'rocketHeavyTank', name: 'RocketHeavyTankUnit' });
  }
}

registerProcUnit('rocketHeavyTank', (race, teamColor, opts) => new RocketHeavyTankUnit({ race, teamColor, ...opts }));
