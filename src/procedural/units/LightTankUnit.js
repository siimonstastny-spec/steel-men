// Steel Mans – procedural light tank (roadmap U0 sample model, proof of the unit kit). One file = one unit type:
// a build function composing UnitModules into a UnitBuilder, a shared cache, a ProcUnit subclass, a registry line.
//   • shape by style.silhouette (LIGHT_TANK_SHAPES): rounded / angular = tracked cannon tank, round = hover plasma tank,
//     faceted = hover laser tank (the faction texts ask for hovers on the round / faceted styles)
//   • preview / test overrides: new LightTankUnit({ chassis: 'tracks' | 'wheels' | 'hover', weapon: 'cannon' | 'missile' |
//     'gun' | 'laser' | 'plasma' | 'lightning' }) – each combination is its own cached variant
//   • sockets: muzzle, turret, aim, cargo, smoke (+ exhaust_1/2 on hovers, launch_1..n with the missile pod)
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 6.2 long, 3.3 wide, 2.7 high. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { hull, tracks, wheels, hover, turret, weapon, exhaust, statusLamp } from './UnitModules.js';

/** Shapes by style.silhouette (unknown → rounded); sizes in model units, z / status as shares of L, W, H */
export const LIGHT_TANK_SHAPES = {
  rounded: {
    chassis: 'tracks', weapon: 'cannon', L: 6.2, W: 3.3, H: 1.0,
    turret: { w: 2.0, d: 2.2, h: 0.8, z: -0.06 }, gun: { length: 2.8, caliber: 0.13, pitch: [-0.1, 0.3] },
    status: [-0.32, 1.0, -0.38],
  },
  angular: {
    chassis: 'tracks', weapon: 'cannon', L: 6.6, W: 3.6, H: 1.15,
    turret: { w: 2.3, d: 2.4, h: 0.9, z: -0.07 }, gun: { length: 3.0, caliber: 0.15, pitch: [-0.1, 0.3] },
    status: [-0.3, 1.0, -0.3],
  },
  round: {
    chassis: 'hover', weapon: 'plasma', L: 6.0, W: 3.1, H: 1.1,
    turret: { w: 2.0, d: 2.0, h: 0.85, z: -0.04 }, gun: { length: 2.0, caliber: 0.16, pitch: [-0.1, 0.35] },
    status: [-0.22, 0.8, -0.3],
  },
  faceted: {
    chassis: 'hover', weapon: 'laser', L: 6.4, W: 2.7, H: 0.95,
    turret: { w: 1.7, d: 2.3, h: 0.7, z: -0.06 }, gun: { length: 3.0, caliber: 0.09, pitch: [-0.1, 0.35] },
    status: [0, 0.86, -0.32],
  },
};

/** Chassis proportions (shares of L / W of the shape) */
const CHASSIS = {
  tracks: { gauge: 0.88, tw: 0.26, th: 0.14, hullLift: 0.95, hullL: 0.92 },
  wheels: { gauge: 0.86, ww: 0.18, r: 0.085, axles: [0.3, 0, -0.3], steer: 1, bellyL: 0.8, hullLift: 1.3, hullL: 0.95 },
  hover: {
    gap: 0.07, skirtL: 1.0, skirtW: 1.08, skirtH: 0.07, hullL: 0.9, pads: [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]],
    exhaust: { x: 0.22, y: 0.45, z: -0.45, r: 0.2, length: 1.0 },
  },
};
const WEAPON_MOUNT = 0.85;   // trunnion z = turret front × this
const SOCKET_AIM = 0.5;      // aim socket at hull top + turret height × this
const SOCKET_SMOKE = 0.45;   // smoke socket z = −hull length × this (rear deck)

const shapeOf = (kit) => LIGHT_TANK_SHAPES[kit.style.silhouette] ?? LIGHT_TANK_SHAPES.rounded;
const variantKey = (chassis, weaponKind) => (chassis || weaponKind ? `${chassis ?? ''}:${weaponKind ?? ''}` : '');

function buildLightTank(kit, variant) {
  const s = shapeOf(kit);
  const [chassisOverride, weaponOverride] = variant ? variant.split(':') : [];
  const chassis = chassisOverride && Object.hasOwn(CHASSIS, chassisOverride) ? chassisOverride : s.chassis;
  const kind = weaponOverride || s.weapon;
  const P = CHASSIS[chassis];
  const { L, W, H } = s;
  const ub = new UnitBuilder(kit);
  let base = 0;   // hull bottom in the hull bone's space
  if (chassis === 'hover') {
    ub.bone('hull', 'root', [0, L * P.gap, 0]);
    base = hover(ub, {
      bone: 'hull', L: L * P.skirtL, W: W * P.skirtW, skirtH: L * P.skirtH, pads: P.pads.map(([x, z]) => [x * W, z * L]),
    });
  } else if (chassis === 'wheels') {
    const r = L * P.r;
    wheels(ub, { L: L * P.bellyL, gauge: W * P.gauge, r, ww: W * P.ww, axles: P.axles.map((a) => a * L), steer: P.steer });
    ub.bone('hull', 'root', [0, r * P.hullLift, 0]);
    ub.meta.hull = { bone: 'hull', bank: false };
  } else {
    const th = L * P.th;
    tracks(ub, { L, gauge: W * P.gauge, tw: W * P.tw, th });
    ub.bone('hull', 'root', [0, th * P.hullLift, 0]);
    ub.meta.hull = { bone: 'hull', bank: false };
  }
  const hl = hull(ub, { bone: 'hull', y: base, L: L * P.hullL, W, H });
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h });
  weapon(ub, kind, {
    parent: 'turret', position: [0, tr.mid, tr.front * WEAPON_MOUNT], length: s.gun.length, caliber: s.gun.caliber, pitch: s.gun.pitch,
  });
  if (chassis === 'hover') {
    const E = P.exhaust;
    [1, -1].forEach((side, i) => exhaust(ub, {
      parent: 'hull', position: [side * W * E.x, base + H * E.y, L * E.z], r: E.r, length: E.length, index: i + 1,
    }));
  }
  statusLamp(ub, { parent: 'hull', position: [W * s.status[0], base + H * s.status[1], L * s.status[2]] });
  ub.socket('aim', 'hull', [0, hl.top + t.h * SOCKET_AIM, 0]);
  ub.socket('cargo', 'hull', [0, hl.top, L * s.status[2]]);
  ub.socket('smoke', 'hull', [0, hl.top, -L * P.hullL * SOCKET_SMOKE]);
  return ub.build();
}

const CACHE = createUnitCache(buildLightTank);

export class LightTankUnit extends ProcUnit {
  /**
   * @param {object} [o]
   * @param {string} [o.race]        race / style key (unknown → first style)
   * @param {THREE.ColorRepresentation} [o.teamColor]
   * @param {'tracks'|'wheels'|'hover'} [o.chassis]   override (preview / tests)
   * @param {string} [o.weapon]      cannon | missile | gun | laser | plasma | lightning (override)
   */
  constructor({ race, teamColor, chassis, weapon: weaponKind } = {}) {
    super({ race, teamColor, cache: CACHE, variant: variantKey(chassis, weaponKind), type: 'lightTank', name: 'LightTankUnit' });
  }
}

registerProcUnit('lightTank', (race, teamColor, opts) => new LightTankUnit({ race, teamColor, ...opts }));
