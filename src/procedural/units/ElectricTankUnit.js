// Steel Men – procedural electric tank (roadmap U3). Always a hover (glow under the pads), lightning gun in the turret
// and two tesla pylons on the hull whose tips are bridged by flickering arcs ("lightning between the spikes"; they
// flare up on every shot). Elevates to shoot air targets. Shape proportions by style.silhouette, never by faction name.
// Sockets: muzzle, turret, aim, cargo, smoke, exhaust_1/2. Model units ≈ 6.4 long, 3.2 wide, ≈ 2.6 high (with pylons).
// Registered as 'electricTank'. The arc bone is a kit arc (meta.arcs), driven by the ProcUnit; no code per frame here.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { hull, hover, turret, weapon, exhaust, statusLamp } from './UnitModules.js';
import { skirtTeamRim, teamDeck } from './LightPlasmaTankUnit.js';   // shared team helpers (skirt rim, deck marks)
import { makeRng } from '../ProcKit.js';

const BASE = {
  L: 6.4, W: 3.2, H: 1.05,
  turret: { w: 1.9, d: 2.0, h: 0.75, z: -0.02 },
  gun: { length: 2.0, caliber: 0.15, pitch: [-0.1, 1.15] },
  status: [-0.22, 0.8, -0.3],
};

/** Shapes by style.silhouette (unknown → rounded) */
export const ELECTRIC_TANK_SHAPES = {
  rounded: BASE,
  angular: { ...BASE, L: 6.8, W: 3.5, H: 1.15 },
  round: BASE,
  faceted: { ...BASE, W: 2.9, H: 0.95 },
};

const HOVER = {
  gap: 0.07, skirtL: 1.0, skirtW: 1.08, skirtH: 0.07, hullL: 0.9,
  pads: [[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]],
  exhaust: { x: 0.2, y: 0.45, z: -0.46, r: 0.2, length: 1.0 },
};
/** Tesla pylons (pair on the hull top): x share of W, z share of L, base height share of H, height, radii */
const PYLON = { x: 0.28, z: -0.27, baseY: 0.8, h: 0.95, rTop: 0.04, rBottom: 0.1, seg: 6, tipR: 0.07, tipIntensity: 0.9 };
/** Arcs between the pylon tips: count, segments, jitter (model units), thickness, seed, gap between arcs (y offset) */
const ARC = { count: 2, segments: 6, jitter: 0.16, thickness: 0.035, seed: 4242, yStep: 0.18 };
const WEAPON_MOUNT = 0.85;
const SOCKET_AIM = 0.5;
const SMOKE_Z = 0.45;   // smoke socket z share of the hull length (behind the centre)

const shapeOf = (kit) => ELECTRIC_TANK_SHAPES[kit.style.silhouette] ?? ELECTRIC_TANK_SHAPES.rounded;

function build(kit) {
  const s = shapeOf(kit);
  const { L, W, H } = s;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, L * HOVER.gap, 0]);
  const base = hover(ub, { bone: 'hull', L: L * HOVER.skirtL, W: W * HOVER.skirtW, skirtH: L * HOVER.skirtH, pads: HOVER.pads.map(([x, z]) => [x * W, z * L]) });
  // team colour: skirt rim, module layouts (team: true), deck marks on the rounded / angular hull; emblems on neutral plates
  skirtTeamRim(ub, { y: base, w: W * HOVER.skirtW, d: L * HOVER.skirtL });
  const hl = hull(ub, { bone: 'hull', y: base, L: L * HOVER.hullL, W, H, team: true });
  teamDeck(ub, { top: hl.top, hullLen: L * HOVER.hullL, L, W });
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h, team: true });
  weapon(ub, 'lightning', {
    parent: 'turret', position: [0, tr.mid, tr.front * WEAPON_MOUNT], length: s.gun.length, caliber: s.gun.caliber, pitch: s.gun.pitch,
  });
  // tesla pylons + arc bridge (own bone: the kit flickers it like the weapon arcs)
  const tips = [];
  const by = base + H * PYLON.baseY;
  for (const side of [1, -1]) {
    const x = side * W * PYLON.x;
    const z = L * PYLON.z;
    ub.paint('hull').cylinder(PYLON.rTop, PYLON.rBottom, PYLON.h, PYLON.seg, kit.S.frame, { x, y: by + PYLON.h / 2, z });
    tips.push([x, by + PYLON.h, z]);
    ub.glow('hull').point([x, by + PYLON.h, z], PYLON.tipR, ub.style.weaponGlow, { intensity: PYLON.tipIntensity });
  }
  const arc = ub.bone('arcBridge', 'hull');
  const ag = ub.glow(arc);
  const rng = makeRng(ARC.seed);
  for (let k = 0; k < ARC.count; k++) {
    const a = [tips[0][0], tips[0][1] - k * ARC.yStep, tips[0][2]];
    const e = [tips[1][0], tips[1][1] - k * ARC.yStep, tips[1][2]];
    let prev = a;
    for (let i = 1; i <= ARC.segments; i++) {
      const f = i / ARC.segments;
      const j = i === ARC.segments ? 0 : ARC.jitter;
      const p = [a[0] + (e[0] - a[0]) * f, a[1] + (e[1] - a[1]) * f + (rng() - 0.5) * 2 * j, a[2] + (rng() - 0.5) * 2 * j];
      ag.segment(prev, p, ARC.thickness, ub.style.weaponGlow);
      prev = p;
    }
  }
  const arcIndex = ub.meta.arcs.length;
  ub.meta.arcs.push({ bone: arc });
  ub.onFire('muzzle', { arcs: [arcIndex] });   // the bridge flares with every shot (merged with the weapon's own entry)
  const E = HOVER.exhaust;
  [1, -1].forEach((side, i) => exhaust(ub, { parent: 'hull', position: [side * W * E.x, base + H * E.y, L * E.z], r: E.r, length: E.length, index: i + 1 }));
  statusLamp(ub, { parent: 'hull', position: [W * s.status[0], base + H * s.status[1], L * s.status[2]] });
  ub.socket('aim', 'hull', [0, hl.top + t.h * SOCKET_AIM, 0]);
  ub.socket('cargo', 'hull', [0, hl.top, L * s.status[2]]);
  ub.socket('smoke', 'hull', [0, hl.top, -L * HOVER.hullL * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(build);

export class ElectricTankUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: THREE.ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'electricTank', name: 'ElectricTankUnit' });
  }
}

registerProcUnit('electricTank', (race, teamColor, opts) => new ElectricTankUnit({ race, teamColor, ...opts }));
