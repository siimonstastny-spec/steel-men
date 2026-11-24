// Steel Mans – procedural light missile hovercraft (roadmap U1). Fast light hover vehicle with a pitching launcher
// pod of several small unguided rockets (ground and air: the pod elevates high). Hover pads glow under the skirt (no
// engine flame). Shape table keyed by style.silhouette with only `rounded` (other styles fall back to it).
//   • sockets: muzzle, launch_1..launch_ROCKETS (alternate them per salvo), turret, aim, cargo, smoke
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 5.6 long, 3.0 wide, 2.2 high. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { hull, hover, turret, weapon, statusLamp } from './UnitModules.js';

/** Shape by style.silhouette (unknown → rounded); sizes in model units */
export const LIGHT_MISSILE_HOVER_SHAPES = {
  rounded: {
    L: 5.6, W: 3.0, H: 0.9,
    turret: { w: 1.7, d: 1.9, h: 0.55, z: -0.1 },
    launcher: { rockets: 8, pitch: [-0.05, 1.15] },   // rad limits; high elevation = anti-air
    status: [-0.3, 0.9, -0.3],
  },
};

const CHASSIS = {
  gap: 0.07, skirtL: 1.0, skirtW: 1.08, skirtH: 0.07, hullL: 0.9,
  pads: [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]],   // shares of W (x) and L (z)
};
const SPONSON = { w: 0.12, h: 0.28, d: 0.5, x: 0.5, y: 0.45, z: 0.05 };   // side pods: shares of W / H / L (x, z offsets)
const LAUNCHER_LIFT = 0.12;   // pod axis above the turret roof
const LAUNCHER_Z = 0.1;       // pod trunnion z = turret front × this (pod sits on top of the turret)
const SOCKET_AIM = 0.5;
const SMOKE_Z = 0.4;

const shapeOf = (kit) => LIGHT_MISSILE_HOVER_SHAPES[kit.style.silhouette] ?? LIGHT_MISSILE_HOVER_SHAPES.rounded;

function buildLightMissileHover(kit) {
  const s = shapeOf(kit);
  const P = CHASSIS;
  const { L, W, H } = s;
  const S = kit.S;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, L * P.gap, 0]);
  const base = hover(ub, { bone: 'hull', L: L * P.skirtL, W: W * P.skirtW, skirtH: L * P.skirtH, pads: P.pads.map(([x, z]) => [x * W, z * L]) });
  const hl = hull(ub, { bone: 'hull', y: base, L: L * P.hullL, W, H });
  const hb = ub.paint('hull');
  for (const side of [1, -1]) hb.box(W * SPONSON.w, H * SPONSON.h, L * SPONSON.d, S.hullDark, { x: side * W * SPONSON.x, y: base + H * SPONSON.y, z: L * SPONSON.z });
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h });
  weapon(ub, 'missile', {
    parent: 'turret', position: [0, tr.top + LAUNCHER_LIFT, tr.front * LAUNCHER_Z], count: s.launcher.rockets, pitch: s.launcher.pitch,
  });
  statusLamp(ub, { parent: 'hull', position: [W * s.status[0], base + H * s.status[1], L * s.status[2]] });
  ub.socket('aim', 'hull', [0, hl.top + t.h * SOCKET_AIM, 0]);
  ub.socket('cargo', 'hull', [0, hl.top, L * s.status[2]]);
  ub.socket('smoke', 'hull', [0, hl.top, -L * CHASSIS.hullL * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildLightMissileHover);

export class LightMissileHoverUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'lightMissileHover', name: 'LightMissileHoverUnit' });
  }
}

registerProcUnit('lightMissileHover', (race, teamColor, opts) => new LightMissileHoverUnit({ race, teamColor, ...opts }));
