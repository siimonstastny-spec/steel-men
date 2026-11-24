// Steel Mans – procedural light laser hovercraft (roadmap U4). Small fast hover vehicle with one laser (ground and air).
// Hover pads glow under the skirt (no flame). Shape table keyed by style.silhouette with only `faceted` (technology look:
// diamond skirt, prism hull, light lines); other styles fall back to it – shape, not names.
//   • sockets: muzzle, turret, aim, cargo, smoke
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 5.4 long, 2.7 wide, 1.9 high. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { hull, hover, turret, weapon, statusLamp } from './UnitModules.js';

/** Shape by style.silhouette (unknown → faceted); sizes in model units */
export const LIGHT_LASER_HOVER_SHAPES = {
  faceted: {
    L: 5.4, W: 2.5, H: 0.85,
    turret: { w: 1.5, d: 1.9, h: 0.6, z: -0.05 },
    gun: { length: 2.6, caliber: 0.08, pitch: [-0.1, 0.5] },
    status: [0.2, 0.8, -0.3],   // beside the dorsal fin (x share of W)
  },
};

const CHASSIS = {
  gap: 0.07, skirtL: 1.0, skirtW: 1.08, skirtH: 0.07, hullL: 0.9,
  pads: [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]],   // shares of W (x) and L (z)
};
const BLADE = { t: 0.06, h: 0.3, d: 0.4, x: 0.54, y: 0.42, z: -0.05, glowR: 0.07 };   // side stabiliser blades: shares of W / H / L
const WEAPON_MOUNT = 0.85;   // trunnion z = turret front × this
const SOCKET_AIM = 0.5;
const SMOKE_Z = 0.4;

const shapeOf = (kit) => LIGHT_LASER_HOVER_SHAPES[kit.style.silhouette] ?? LIGHT_LASER_HOVER_SHAPES.faceted;

function buildLightLaserHover(kit) {
  const s = shapeOf(kit);
  const P = CHASSIS;
  const { L, W, H } = s;
  const S = kit.S;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, L * P.gap, 0]);
  const base = hover(ub, { bone: 'hull', L: L * P.skirtL, W: W * P.skirtW, skirtH: L * P.skirtH, pads: P.pads.map(([x, z]) => [x * W, z * L]) });
  const hl = hull(ub, { bone: 'hull', y: base, L: L * P.hullL, W, H });
  const hb = ub.paint('hull');
  const hg = ub.glow('hull');
  for (const side of [1, -1]) {
    const bx = side * W * BLADE.x;
    const by = base + H * BLADE.y;
    hb.box(BLADE.t, H * BLADE.h, L * BLADE.d, S.hullDark, { x: bx, y: by, z: L * BLADE.z });
    hg.point([bx + side * BLADE.t, by, L * (BLADE.z + BLADE.d / 2)], BLADE.glowR, ub.style.weaponGlow, {});
  }
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h });
  weapon(ub, 'laser', {
    parent: 'turret', position: [0, tr.mid, tr.front * WEAPON_MOUNT], length: s.gun.length, caliber: s.gun.caliber, pitch: s.gun.pitch,
  });
  statusLamp(ub, { parent: 'hull', position: [W * s.status[0], base + H * s.status[1], L * s.status[2]] });
  ub.socket('aim', 'hull', [0, hl.top + t.h * SOCKET_AIM, 0]);
  ub.socket('cargo', 'hull', [0, hl.top, L * s.status[2]]);
  ub.socket('smoke', 'hull', [0, hl.top, -L * P.hullL * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildLightLaserHover);

export class LightLaserHoverUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'lightLaserHover', name: 'LightLaserHoverUnit' });
  }
}

registerProcUnit('lightLaserHover', (race, teamColor, opts) => new LightLaserHoverUnit({ race, teamColor, ...opts }));
