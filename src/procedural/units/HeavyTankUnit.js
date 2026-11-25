// Steel Men – procedural heavy tank (roadmap U1). Big, slow tracked tank: large turret with a heavy cannon plus a
// roof-mounted rotary machine gun for anti-air (weak). Shape table keyed by style.silhouette with only `rounded`
// (other styles fall back to it – shape, not names).
//   • sockets: muzzle (cannon), muzzle_2 (AA machine gun, fire('muzzle_2')), turret, aim, cargo, smoke
//   • the AA gun bone `barrel_2` rests pitched up (AA_REST_PITCH); it is not driven by setBarrelPitch (that moves the cannon)
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 8.2 long, 4.4 wide, 3.7 high. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { hull, tracks, turret, weapon, statusLamp, teamPanel } from './UnitModules.js';

/** Shape by style.silhouette (unknown → rounded); sizes in model units */
export const HEAVY_TANK_SHAPES = {
  rounded: {
    L: 8.2, W: 4.4, H: 1.45,
    turret: { w: 3.1, d: 3.2, h: 1.1, z: -0.05 }, gun: { length: 4.2, caliber: 0.21, pitch: [-0.08, 0.28] },
    aa: { length: 1.1, x: 0.3, z: -0.12 },   // x share of turret w, z share of turret d (centre offsets)
    status: [-0.36, 1.0, -0.4],
  },
};

const CHASSIS = { gauge: 0.88, tw: 0.26, th: 0.14, hullLift: 0.95, hullL: 0.92 };   // shares of L / W
const BUSTLE = { w: 0.85, h: 0.65, d: 0.65, y: 0.5, z: -0.62 };    // turret rear box: shares of turret w / h / d, centre height share, z share of d
const BUSTLE_DETAIL = 2;   // far LOD kept down to LOD2 (same as the kit's team panel it carries)
const SIDE_ARMOR = { w: 0.1, h: 0.5, d: 0.4, x: 0.52, y: 0.5, z: 0.25 };   // turret cheek plates (darker team lacquer): shares of turret w / h / d, z = centre share of d (in front of the side emblems)
const BUSTLE_PANEL = { w: 0.6, h: 0.6 };   // team panel on the bustle's rear face: shares of the bustle width / height
const AA_PEDESTAL = { r: 0.22, h: 0.18, flare: 1.2, seg: 8 };   // AA gun base cylinder (model units), bottom radius × flare
const AA_REST_PITCH = 0.55;                              // rad, AA gun elevation at rest (bone rotation.x = −pitch)
const AA_LIFT = 0.28;                                    // AA gun axis above the turret roof
const WEAPON_MOUNT = 0.85;
const SOCKET_AIM = 0.5;
const SMOKE_Z = 0.45;

const shapeOf = (kit) => HEAVY_TANK_SHAPES[kit.style.silhouette] ?? HEAVY_TANK_SHAPES.rounded;

function buildHeavyTank(kit) {
  const s = shapeOf(kit);
  const P = CHASSIS;
  const { L, W, H } = s;
  const S = kit.S;
  const ub = new UnitBuilder(kit);
  const th = L * P.th;
  // team colour: module team layouts (skirts / plates / pods / blades, deck, roof mark, emblems on plates) + cheek plates + bustle panel
  tracks(ub, { L, gauge: W * P.gauge, tw: W * P.tw, th, team: true });
  ub.bone('hull', 'root', [0, th * P.hullLift, 0]);
  ub.meta.hull = { bone: 'hull', bank: false };
  const hl = hull(ub, { bone: 'hull', y: 0, L: L * P.hullL, W, H, team: true });
  const t = s.turret;
  const tr = turret(ub, { parent: 'hull', y: hl.top, z: L * t.z, w: t.w, d: t.d, h: t.h, team: true });
  const tb = ub.paint('turret');
  tb.box(t.w * BUSTLE.w, t.h * BUSTLE.h, t.d * BUSTLE.d, S.teamShade, { y: t.h * BUSTLE.y, z: t.d * BUSTLE.z, detail: BUSTLE_DETAIL });   // B4 r3: stays with the team panel on its rear face (no floating disc in LOD2)
  teamPanel(ub, 'turret', t.w * BUSTLE.w * BUSTLE_PANEL.w, t.h * BUSTLE.h * BUSTLE_PANEL.h, {
    y: t.h * BUSTLE.y, z: t.d * (BUSTLE.z - BUSTLE.d / 2), ry: Math.PI,
  });
  for (const side of [1, -1]) tb.box(t.w * SIDE_ARMOR.w, t.h * SIDE_ARMOR.h, t.d * SIDE_ARMOR.d, S.teamShade, { x: side * t.w * SIDE_ARMOR.x, y: t.h * SIDE_ARMOR.y, z: t.d * SIDE_ARMOR.z });
  weapon(ub, 'cannon', {
    parent: 'turret', position: [0, tr.mid, tr.front * WEAPON_MOUNT], length: s.gun.length, caliber: s.gun.caliber, pitch: s.gun.pitch,
  });
  // anti-air machine gun on a pedestal on the roof (own barrel bone, rests pitched up)
  const ax = t.w * s.aa.x;
  const az = t.d * s.aa.z;
  tb.cylinder(AA_PEDESTAL.r, AA_PEDESTAL.r * AA_PEDESTAL.flare, AA_PEDESTAL.h, AA_PEDESTAL.seg, S.hullDark, { x: ax, y: t.h + AA_PEDESTAL.h / 2, z: az });
  weapon(ub, 'gun', { parent: 'turret', position: [ax, t.h + AA_LIFT, az], length: s.aa.length, sfx: '_2', pitch: [0, 0] });
  ub.boneDefs[ub.boneIndex('barrel_2')].rotation = [-AA_REST_PITCH, 0, 0];
  statusLamp(ub, { parent: 'hull', position: [W * s.status[0], H * s.status[1], L * s.status[2]] });
  ub.socket('aim', 'hull', [0, hl.top + t.h * SOCKET_AIM, 0]);
  ub.socket('cargo', 'hull', [0, hl.top, L * s.status[2]]);
  ub.socket('smoke', 'hull', [0, hl.top, -L * CHASSIS.hullL * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildHeavyTank);

export class HeavyTankUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'heavyTank', name: 'HeavyTankUnit' });
  }
}

registerProcUnit('heavyTank', (race, teamColor, opts) => new HeavyTankUnit({ race, teamColor, ...opts }));
