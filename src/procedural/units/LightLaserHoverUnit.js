// Steel Men – procedural light laser hovercraft (roadmap U4). Small fast hover vehicle with one laser (ground and air).
// Hover pads glow under the skirt (no flame). Shape table keyed by style.silhouette with only `faceted` (technology look:
// diamond skirt, prism hull, light lines); other styles fall back to it – shape, not names.
//   • sockets: muzzle, turret, aim, cargo, smoke
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 5.4 long, 2.7 wide, 1.9 high. Visual only.
//   • team colour: hull / turret with team: true + deck mark ahead of the turret + skirt rim (skirtRim, shared by the
//     other U4 hovers) + team stabiliser blades; faction emblem on plates (modules)
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, UNIT_KIT } from './UnitKit.js';
import { hull, hover, turret, weapon, statusLamp, roofMark, teamTrim, UNIT_MODULES } from './UnitModules.js';

/** Shape by style.silhouette (unknown → faceted); sizes in model units */
export const LIGHT_LASER_HOVER_SHAPES = {
  faceted: {
    L: 5.4, W: 2.5, H: 0.85,
    turret: { w: 1.5, d: 1.9, h: 0.6, z: -0.05 },
    gun: { length: 2.6, caliber: 0.08, pitch: [-0.1, 0.5] },
    status: [0.2, 0.8, -0.3],   // beside the dorsal fin (x share of W)
    // deck mark ahead of the turret by style.silhouette (shares of W, hull length, hull length; ledge = angular: on the lower-hull
    // ledge ahead of the deck). round / faceted hulls have no flat deck: their module cap / strakes are the team paint
    team: {
      deckMark: {
        rounded: { w: 0.5, d: 0.15, z: 0.24, ledge: false },
        angular: { w: 0.6, d: 0.1, z: 0.37, ledge: true },
      },
    },
  },
};

/** Deck mark of a hover hull on the 'hull' bone (m = entry of team.deckMark / team.bay for the silhouette, undefined = none) */
export function deckMark(ub, m, { base, top, W, H, hullLen }) {
  if (!m) return;
  const y = m.ledge ? base + H * UNIT_MODULES.hull.angular.lowerShare : top;
  roofMark(ub, 'hull', { y, z: hullLen * m.z, w: W * m.w, d: hullLen * m.d });
}

// Team rim round the hover skirt top edge, by style.silhouette (the hover module shapes the skirt the same way):
// rect / ellipse = teamTrim (× style.teamPaint.trim), diamond = 4 bars along the rhombic skirt. Heights in model units.
const SKIRT_RIM = { rounded: 'rect', angular: 'rect', round: 'ellipse', faceted: 'diamond' };
const SKIRT_RIM_H = { rect: 0.14, ellipse: 0.2, diamond: 0.14 };
const SKIRT_RIM_T = 0.06;   // diamond bar thickness

/** Team rim on the skirt top edge of the 'hull' bone (base = hull bottom, sw × sl = skirt footprint); shared by the U4 hovers */
export function skirtRim(ub, base, sw, sl, hScale = 1) {
  const rim = SKIRT_RIM[ub.kit.style.silhouette] ?? SKIRT_RIM.rounded;
  if (rim !== 'diamond') {
    teamTrim(ub, 'hull', { y: base, w: sw, d: sl, h: SKIRT_RIM_H[rim] * hScale, round: rim === 'ellipse' });
    return;
  }
  const a = sw / 2;
  const c = sl / 2;
  const h = SKIRT_RIM_H.diamond * hScale;
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {   // edge (sx·a, 0) → (0, sz·c)
      ub.paint('hull').box(Math.hypot(a, c), h, SKIRT_RIM_T, ub.kit.S.teamPaint, {
        x: (sx * a) / 2, y: base + h / 2, z: (sz * c) / 2, ry: Math.atan2(-sz * c, -sx * a), detail: UNIT_KIT.teamPaint.lod.trim,
      });
    }
  }
}

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
  skirtRim(ub, base, W * P.skirtW, L * P.skirtL);
  const hullLen = L * P.hullL;
  const hl = hull(ub, { bone: 'hull', y: base, L: hullLen, W, H, team: true });
  deckMark(ub, s.team.deckMark[kit.style.silhouette], { base, top: hl.top, W, H, hullLen });
  const hb = ub.paint('hull');
  const hg = ub.glow('hull');
  for (const side of [1, -1]) {
    const bx = side * W * BLADE.x;
    const by = base + H * BLADE.y;
    hb.box(BLADE.t, H * BLADE.h, L * BLADE.d, S.teamPaint, { x: bx, y: by, z: L * BLADE.z, detail: UNIT_KIT.teamPaint.lod.panel });
    hg.point([bx + side * BLADE.t, by, L * (BLADE.z + BLADE.d / 2)], BLADE.glowR, ub.style.weaponGlow, {});
  }
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h, team: true });
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
