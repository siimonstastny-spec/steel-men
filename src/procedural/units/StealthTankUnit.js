// Steel Men – procedural stealth tank (roadmap U3). Low, flat hull with diamond-section side pods, snub plasma gun and
// a dim "cloak emitter" ring on the turret base. The camouflage itself is the owner's call: setCloaked(0..1) fades the
// hull to style.unit.cloak.minOpacity, hides glow / emblem / shadow (kit); setStatus('cloaked') = blue lamp.
// Shape by style.silhouette (never by faction name): rounded / angular = tracked, round / faceted = hover.
// Sockets: muzzle, turret, aim, cargo, smoke (+ exhaust_1/2 on hovers). Model units ≈ 6 long, 2.6–3.0 wide, ≈ 1.9 high.
// Registered as 'stealthTank'. No per-frame code of its own.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { hull, tracks, hover, turret, weapon, exhaust, statusLamp, prism } from './UnitModules.js';
import { skirtTeamRim, teamDeck } from './LightPlasmaTankUnit.js';   // shared team helpers (skirt rim, deck marks)

const HALF_PI = Math.PI / 2;
const BASE = {
  chassis: 'hover', L: 6.0, W: 2.8, H: 0.8,
  turret: { w: 1.6, d: 1.9, h: 0.5, z: -0.06 },
  gun: { length: 1.8, caliber: 0.13, pitch: [-0.1, 1.0] },
  status: [-0.2, 0.8, -0.32],
};

/** Shapes by style.silhouette (unknown → rounded) */
export const STEALTH_TANK_SHAPES = {
  rounded: { ...BASE, chassis: 'tracks' },
  angular: { ...BASE, chassis: 'tracks', L: 6.4, W: 3.1, H: 0.9 },
  round: BASE,
  faceted: { ...BASE, W: 2.6, H: 0.75 },
};

const CHASSIS = {
  tracks: { gauge: 0.88, tw: 0.2, th: 0.12, hullLift: 0.95, hullL: 0.92 },
  hover: {
    gap: 0.06, skirtL: 1.0, skirtW: 1.05, skirtH: 0.06, hullL: 0.92,
    pads: [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]],
    exhaust: { x: 0.2, y: 0.45, z: -0.46, r: 0.17, length: 0.9 },
  },
};
/** Diamond side pods: size, length share of L, x offset beyond W/2, height share of H, z share of L */
const POD = { size: 0.5, l: 0.5, out: 0.05, y: 0.4, z: -0.05 };
/** Sensor eyes (glow points at the nose): x share of W, y share of H, z share of L, radius, intensity */
const EYE = { x: 0.12, y: 0.45, z: 0.4, r: 0.08, intensity: 0.8 };
/** Cloak emitter ring on the turret base: radius share of turret width, tube, segments, intensity */
const RING = { r: 0.55, tube: 0.025, seg: 14, radial: 3, intensity: 0.5, y: 0.02 };
const WEAPON_MOUNT = 0.85;
const SOCKET_AIM = 0.5;
const SMOKE_Z = 0.45;   // smoke socket z share of the hull length (behind the centre)

const shapeOf = (kit) => STEALTH_TANK_SHAPES[kit.style.silhouette] ?? STEALTH_TANK_SHAPES.rounded;

function build(kit) {
  const s = shapeOf(kit);
  const P = CHASSIS[s.chassis];
  const { L, W, H } = s;
  const ub = new UnitBuilder(kit);
  let base = 0;
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
  const g = ub.glow('hull');
  for (const side of [1, -1]) {
    prism(ub.paint('hull'), 4, POD.size, POD.size, L * POD.l, kit.S.teamShade, { x: side * (W / 2 + POD.out), y: base + H * POD.y, z: L * POD.z });
    g.point([side * W * EYE.x, base + H * EYE.y, L * EYE.z], EYE.r, ub.style.weaponGlow, { intensity: EYE.intensity });
  }
  ub.glow('turret').torus(t.w * RING.r, RING.tube, RING.radial, RING.seg, ub.style.hoverGlow, { rx: HALF_PI, y: RING.y, intensity: RING.intensity });
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

export class StealthTankUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: THREE.ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'stealthTank', name: 'StealthTankUnit' });
  }
}

registerProcUnit('stealthTank', (race, teamColor, opts) => new StealthTankUnit({ race, teamColor, ...opts }));
