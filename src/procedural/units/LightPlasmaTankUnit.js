// Steel Mans – procedural light plasma tank (roadmap U3). Fast light hull, one plasma weapon that can elevate to shoot
// air targets, swept speed fins with glowing edges at the back. Shape by style.silhouette (never by faction name):
//   rounded / angular = tracked, round / faceted = hover (glow under the pads, no flame – plus two ion nozzles).
// Sockets: muzzle, turret, aim, cargo, smoke (+ exhaust_1/2 on hovers). Model units ≈ 5.8–6.2 long, 2.4–3.0 wide, ≈ 2.2 high.
// Visual only; no per-frame code of its own (the kit drivers do everything). Registered as 'lightPlasmaTank'.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { hull, tracks, hover, turret, weapon, exhaust, statusLamp } from './UnitModules.js';

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
  } else {
    const th = L * P.th;
    tracks(ub, { L, gauge: W * P.gauge, tw: W * P.tw, th });
    ub.bone('hull', 'root', [0, th * P.hullLift, 0]);
    ub.meta.hull = { bone: 'hull', bank: false };
  }
  const hl = hull(ub, { bone: 'hull', y: base, L: L * P.hullL, W, H });
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h });
  weapon(ub, 'plasma', {
    parent: 'turret', position: [0, tr.mid, tr.front * WEAPON_MOUNT], length: s.gun.length, caliber: s.gun.caliber, pitch: s.gun.pitch,
  });
  // swept speed fins with a glowing top edge
  const fy = base + H * FIN.baseY;
  const fl = L * FIN.l;
  for (const side of [1, -1]) {
    const x = side * W * FIN.x;
    ub.paint('hull').box(FIN.t, FIN.h, fl, kit.S.hullDark, { x, y: fy + FIN.h / 2, z: L * FIN.z });
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
