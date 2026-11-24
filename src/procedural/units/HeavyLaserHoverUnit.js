// Steel Mans – procedural heavy laser hovercraft (roadmap U4). Artillery-like long-range laser platform that needs no
// deploying: very long barrel with capacitor coils, rear power cells (glow), six hover pads. Shape table keyed by
// style.silhouette with only `faceted` (others fall back to it).
//   • sockets: muzzle, turret, aim, cargo, smoke
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 8.4 long, 4.2 wide, 2.6 high. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { hull, hover, turret, weapon, statusLamp } from './UnitModules.js';

/** Shape by style.silhouette (unknown → faceted); sizes in model units */
export const HEAVY_LASER_HOVER_SHAPES = {
  faceted: {
    L: 8.4, W: 3.9, H: 1.25,
    turret: { w: 2.5, d: 3.0, h: 0.95, z: -0.08 },
    gun: { length: 5.4, caliber: 0.14, pitch: [-0.05, 0.7] },
    status: [0.2, 0.8, -0.38],   // beside the dorsal fin (x share of W)
  },
};

const CHASSIS = {
  gap: 0.06, skirtL: 1.0, skirtW: 1.08, skirtH: 0.06, hullL: 0.92,
  pads: [[0.32, 0.36], [-0.32, 0.36], [0.32, 0], [-0.32, 0], [0.32, -0.36], [-0.32, -0.36]],   // shares of W (x) and L (z)
};
const CELL = { w: 0.22, h: 0.55, d: 0.6, x: 0.26, y: 0.5, z: -0.62, glow: 0.8, glowW: 0.5, glowH: 0.7, glowD: 1.02 };   // rear power cells on the turret: shares of turret w / h / d
const CHEEK = { w: 0.12, h: 0.55, d: 0.55, x: 0.52, y: 0.5, z: 0.1 };               // turret cheek plates: shares of turret w / h / d
const SKIRT_WING = { w: 0.12, h: 0.35, d: 0.62, x: 0.52, y: 0.4, z: -0.04 };        // hull side armour: shares of W / H / L
const WEAPON_MOUNT = 0.85;   // trunnion z = turret front × this
const SOCKET_AIM = 0.5;
const SMOKE_Z = 0.4;

const shapeOf = (kit) => HEAVY_LASER_HOVER_SHAPES[kit.style.silhouette] ?? HEAVY_LASER_HOVER_SHAPES.faceted;

function buildHeavyLaserHover(kit) {
  const s = shapeOf(kit);
  const P = CHASSIS;
  const { L, W, H } = s;
  const S = kit.S;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, L * P.gap, 0]);
  const base = hover(ub, { bone: 'hull', L: L * P.skirtL, W: W * P.skirtW, skirtH: L * P.skirtH, pads: P.pads.map(([x, z]) => [x * W, z * L]) });
  const hl = hull(ub, { bone: 'hull', y: base, L: L * P.hullL, W, H });
  const hb = ub.paint('hull');
  for (const side of [1, -1]) {
    hb.box(W * SKIRT_WING.w, H * SKIRT_WING.h, L * SKIRT_WING.d, S.hullDark, { x: side * W * SKIRT_WING.x, y: base + H * SKIRT_WING.y, z: L * SKIRT_WING.z });
  }
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h });
  const tb = ub.paint('turret');
  const tg = ub.glow('turret');
  for (const side of [1, -1]) {
    tb.box(t.w * CHEEK.w, t.h * CHEEK.h, t.d * CHEEK.d, S.hullDark, { x: side * t.w * CHEEK.x, y: t.h * CHEEK.y, z: t.d * CHEEK.z });
    const cx = side * t.w * CELL.x;
    const cy = t.h * CELL.y;
    const cz = t.d * CELL.z;
    tb.box(t.w * CELL.w, t.h * CELL.h, t.d * CELL.d, S.hullDark, { x: cx, y: cy, z: cz });
    tg.box(t.w * CELL.w * CELL.glowW, t.h * CELL.h * CELL.glowH, t.d * CELL.d * CELL.glowD, ub.style.weaponGlow, { x: cx, y: cy, z: cz, intensity: CELL.glow });
  }
  weapon(ub, 'laser', {
    parent: 'turret', position: [0, tr.mid, tr.front * WEAPON_MOUNT], length: s.gun.length, caliber: s.gun.caliber, pitch: s.gun.pitch,
  });
  statusLamp(ub, { parent: 'hull', position: [W * s.status[0], base + H * s.status[1], L * s.status[2]] });
  ub.socket('aim', 'hull', [0, hl.top + t.h * SOCKET_AIM, 0]);
  ub.socket('cargo', 'hull', [0, hl.top, L * s.status[2]]);
  ub.socket('smoke', 'hull', [0, hl.top, -L * P.hullL * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildHeavyLaserHover);

export class HeavyLaserHoverUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'heavyLaserHover', name: 'HeavyLaserHoverUnit' });
  }
}

registerProcUnit('heavyLaserHover', (race, teamColor, opts) => new HeavyLaserHoverUnit({ race, teamColor, ...opts }));
