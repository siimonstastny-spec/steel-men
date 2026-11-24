// Steel Men – procedural light missile hovercraft (roadmap U1). Fast light hover vehicle with a pitching launcher
// pod of several small unguided rockets (ground and air: the pod elevates high). Hover pads glow under the skirt (no
// engine flame). Shape table keyed by style.silhouette with only `rounded` (other styles fall back to it).
//   • sockets: muzzle, launch_1..launch_ROCKETS (alternate them per salvo), turret, aim, cargo, smoke
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 5.6 long, 3.0 wide, 2.2 high. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, UNIT_KIT } from './UnitKit.js';
import { hull, hover, turret, weapon, statusLamp, roofMark, teamTrim } from './UnitModules.js';

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
const SPONSON = { w: 0.12, h: 0.28, d: 0.5, x: 0.5, y: 0.45, z: 0.05 };   // side pods (darker team lacquer): shares of W / H / L (x, z offsets)
// team colour on the open front deck (roofMark: shares of W, hull length, hull length) – flat decks only, round / faceted hulls use the module layout
const DECK_MARK = { rounded: { w: 0.55, d: 0.2, z: 0.25 }, angular: { w: 0.5, d: 0.16, z: 0.14 } };   // end at the deck edge (0.35 / 0.22 of the hull length)
// team rim on the hover skirt top edge by style.silhouette: rect = teamTrim box rim, ellipse = teamTrim ring, diamond = 4 bars along the rhombic skirt;
// h in model units (rect / ellipse × style.teamPaint.trim through teamTrim, diamond as is)
const SKIRT_RIM = { rounded: 'rect', angular: 'rect', round: 'ellipse', faceted: 'diamond' };
const SKIRT_RIM_H = { rect: 0.14, ellipse: 0.2, diamond: 0.14 };
const SKIRT_RIM_T = 0.06;   // diamond bar thickness
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
  // team colour: skirt rim, module team layouts (hull / turret, emblems on plates), deck mark, side pods
  const rim = SKIRT_RIM[kit.style.silhouette] ?? SKIRT_RIM.rounded;
  const sw = W * P.skirtW;
  const sl = L * P.skirtL;
  if (rim === 'diamond') {
    const a = sw / 2;
    const c = sl / 2;
    const h = SKIRT_RIM_H.diamond;
    for (const sx of [1, -1]) {
      for (const sz of [1, -1]) {   // edge (sx·a, 0) → (0, sz·c)
        ub.paint('hull').box(Math.hypot(a, c), h, SKIRT_RIM_T, S.teamPaint, {
          x: (sx * a) / 2, y: base + h / 2, z: (sz * c) / 2, ry: Math.atan2(-sz * c, -sx * a), detail: UNIT_KIT.teamPaint.lod.trim,
        });
      }
    }
  } else {
    teamTrim(ub, 'hull', { y: base, w: sw, d: sl, h: SKIRT_RIM_H[rim], round: rim === 'ellipse' });
  }
  const hullLen = L * P.hullL;
  const hl = hull(ub, { bone: 'hull', y: base, L: hullLen, W, H, team: true });
  const dm = DECK_MARK[kit.style.silhouette];
  if (dm) roofMark(ub, 'hull', { y: hl.top, z: hullLen * dm.z, w: W * dm.w, d: hullLen * dm.d });
  const hb = ub.paint('hull');
  for (const side of [1, -1]) hb.box(W * SPONSON.w, H * SPONSON.h, L * SPONSON.d, S.teamShade, { x: side * W * SPONSON.x, y: base + H * SPONSON.y, z: L * SPONSON.z });
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h, team: true });
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
