// Steel Men – procedural light plasma tank (roadmap U3). Fast light hull, one plasma weapon that can elevate to shoot
// air targets, swept speed fins with glowing edges at the back. Shape by style.silhouette (never by faction name):
//   rounded / angular = tracked, round / faceted = hover (glow under the pads, no flame – plus two ion nozzles).
// Sockets: muzzle, turret, aim, cargo, smoke (+ exhaust_1/2 on hovers). Model units ≈ 5.8–6.2 long, 2.4–3.0 wide, ≈ 2.2 high.
// Visual only; no per-frame code of its own (the kit drivers do everything). Registered as 'lightPlasmaTank'.
// Team colour (docs/notes/proc-unit-teamcolor-kit.md): hull / turret / tracks with team: true, deck mark (DECK_TEAM) on the
// tracked styles, rim round the hover skirt (skirtTeamRim), speed fins in the team lacquer; emblems on neutral plates.
// teamDeck / skirtTeamRim / DECK_TEAM are shared with ElectricTankUnit and StealthTankUnit.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit, UNIT_KIT } from './UnitKit.js';
import { hull, tracks, hover, turret, weapon, exhaust, statusLamp, roofMark, teamTrim } from './UnitModules.js';

/** Deck team marks by style.silhouette (shares of W, hull length, hull length); angular = darker cover + chevron (W, L, L) */
export const DECK_TEAM = {
  rounded: { deckMark: { w: 0.78, d: 0.62, z: -0.05 } },
  angular: { deckCover: { w: 0.54, d: 0.58, z: -0.06 }, chevron: { w: 0.44, d: 0.09, z: 0.167 } },
};
// team rims on the hover skirt top edge by style.silhouette: rect / ellipse = teamTrim, diamond = 4 bars along the rhombic skirt
const SKIRT_RIM = { rounded: 'rect', angular: 'rect', round: 'ellipse', faceted: 'diamond' };
const SKIRT_RIM_H = { rect: 0.14, ellipse: 0.2, diamond: 0.14 };
const SKIRT_RIM_T = 0.06;   // diamond bar thickness

/** Team rim along the top edge of a hover skirt (w × d, top at y) of the hull bone */
export function skirtTeamRim(ub, { y, w, d }) {
  const rim = SKIRT_RIM[ub.kit.style.silhouette] ?? SKIRT_RIM.rounded;
  if (rim !== 'diamond') {
    teamTrim(ub, 'hull', { y, w, d, h: SKIRT_RIM_H[rim], round: rim === 'ellipse' });
    return;
  }
  const a = w / 2;
  const c = d / 2;
  const h = SKIRT_RIM_H.diamond;
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {   // edge (sx·a, 0) → (0, sz·c)
      ub.paint('hull').box(Math.hypot(a, c), h, SKIRT_RIM_T, ub.kit.S.teamPaint, {
        x: (sx * a) / 2, y: y + h / 2, z: (sz * c) / 2, ry: Math.atan2(-sz * c, -sx * a), detail: UNIT_KIT.teamPaint.lod.trim,
      });
    }
  }
}

/** Deck team marks on the flat deck of the rounded / angular hull (top = hl.top); other silhouettes: nothing (module layout only) */
export function teamDeck(ub, { top, hullLen, L, W }) {
  const D = DECK_TEAM[ub.kit.style.silhouette];
  if (!D) return;
  const dm = D.deckMark;
  if (dm) roofMark(ub, 'hull', { y: top, z: hullLen * dm.z, w: W * dm.w, d: hullLen * dm.d });
  const dc = D.deckCover;
  const coverH = dc ? UNIT_KIT.teamPaint.roofMark.h : 0;
  if (dc) {
    ub.paint('hull').box(W * dc.w, coverH, hullLen * dc.d, ub.kit.S.teamShade, { y: top + coverH / 2, z: hullLen * dc.z, detail: UNIT_KIT.teamPaint.lod.roofMark });
  }
  const cv = D.chevron;
  if (cv) roofMark(ub, 'hull', { y: top + coverH, z: L * cv.z, w: W * cv.w, d: L * cv.d });
}

const BASE = {
  chassis: 'hover', L: 5.8, W: 2.6, H: 0.95,
  turret: { w: 1.5, d: 1.7, h: 0.7, z: -0.08 },
  gun: { length: 2.2, caliber: 0.14, pitch: [-0.1, 1.1] },   // pitch up to ≈ 63° (anti-air capable)
  status: [-0.2, 0.8, -0.3],
};

/** Shapes by style.silhouette (unknown → rounded); sizes in model units, status as shares of W, H, L */
export const LIGHT_PLASMA_TANK_SHAPES = {
  rounded: { ...BASE, chassis: 'tracks', W: 2.8 },
  angular: { ...BASE, chassis: 'tracks', L: 6.2, W: 3.0, H: 1.05 },
  round: BASE,
  faceted: { ...BASE, L: 6.2, W: 2.4, H: 0.9 },
};

/** Chassis proportions (shares of L / W of the shape) */
const CHASSIS = {
  tracks: { gauge: 0.88, tw: 0.2, th: 0.13, hullLift: 0.95, hullL: 0.92 },
  hover: {
    gap: 0.07, skirtL: 1.0, skirtW: 1.05, skirtH: 0.06, hullL: 0.9,
    pads: [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]],
    exhaust: { x: 0.2, y: 0.45, z: -0.45, r: 0.18, length: 1.1 },
  },
};
/** Speed fins (a pair at the back): thickness, height, length share of L, x share of W, z share of L, base height share of H */
const FIN = { t: 0.06, h: 0.55, l: 0.26, x: 0.36, z: -0.36, baseY: 0.75, glowT: 0.04, glowIntensity: 0.7, glowLen: 0.9 };
const WEAPON_MOUNT = 0.85;   // trunnion z = turret front × this
const SOCKET_AIM = 0.5;      // aim socket at hull top + turret height × this
const SMOKE_Z = 0.45;        // smoke socket z share of the hull length (behind the centre)

const shapeOf = (kit) => LIGHT_PLASMA_TANK_SHAPES[kit.style.silhouette] ?? LIGHT_PLASMA_TANK_SHAPES.rounded;

function build(kit) {
  const s = shapeOf(kit);
  const P = CHASSIS[s.chassis];
  const { L, W, H } = s;
  const ub = new UnitBuilder(kit);
  let base = 0;   // hull bottom in the hull bone's space
  if (s.chassis === 'hover') {
    ub.bone('hull', 'root', [0, L * P.gap, 0]);
    base = hover(ub, { bone: 'hull', L: L * P.skirtL, W: W * P.skirtW, skirtH: L * P.skirtH, pads: P.pads.map(([x, z]) => [x * W, z * L]) });
    skirtTeamRim(ub, { y: base, w: W * P.skirtW, d: L * P.skirtL });
  } else {
    const th = L * P.th;
    tracks(ub, { L, gauge: W * P.gauge, tw: W * P.tw, th, team: true });
    ub.bone('hull', 'root', [0, th * P.hullLift, 0]);
    ub.meta.hull = { bone: 'hull', bank: false };
  }
  const hl = hull(ub, { bone: 'hull', y: base, L: L * P.hullL, W, H, team: true });
  teamDeck(ub, { top: hl.top, hullLen: L * P.hullL, L, W });
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h, team: true });
  weapon(ub, 'plasma', {
    parent: 'turret', position: [0, tr.mid, tr.front * WEAPON_MOUNT], length: s.gun.length, caliber: s.gun.caliber, pitch: s.gun.pitch,
  });
  // swept speed fins with a glowing top edge
  const fy = base + H * FIN.baseY;
  const fl = L * FIN.l;
  for (const side of [1, -1]) {
    const x = side * W * FIN.x;
    ub.paint('hull').box(FIN.t, FIN.h, fl, kit.S.teamPaint, { x, y: fy + FIN.h / 2, z: L * FIN.z, detail: UNIT_KIT.teamPaint.lod.panel });
    ub.glow('hull').box(FIN.glowT, FIN.glowT, fl * FIN.glowLen, ub.style.weaponGlow, { x, y: fy + FIN.h, z: L * FIN.z, intensity: FIN.glowIntensity });
  }
  if (s.chassis === 'hover') {
    const E = P.exhaust;
    [1, -1].forEach((side, i) => exhaust(ub, { parent: 'hull', position: [side * W * E.x, base + H * E.y, L * E.z], r: E.r, length: E.length, index: i + 1 }));
  }
  statusLamp(ub, { parent: 'hull', position: [W * s.status[0], base + H * s.status[1], L * s.status[2]] });
  ub.socket('aim', 'hull', [0, hl.top + t.h * SOCKET_AIM, 0]);
  ub.socket('cargo', 'hull', [0, hl.top, L * s.status[2]]);
  ub.socket('smoke', 'hull', [0, hl.top, -L * P.hullL * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(build);

export class LightPlasmaTankUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: THREE.ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'lightPlasmaTank', name: 'LightPlasmaTankUnit' });
  }
}

registerProcUnit('lightPlasmaTank', (race, teamColor, opts) => new LightPlasmaTankUnit({ race, teamColor, ...opts }));
