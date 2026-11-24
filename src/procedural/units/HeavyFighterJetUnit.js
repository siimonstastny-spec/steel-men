// Steel Mans – procedural heavy fighter jet (roadmap U2): strong air-to-air airframe with FOUR engines (four exhaust
// flames, size / colour from the style data), belly missile pod and a rotary cannon.
//   • aircraft rig: hull bone hovers at JET altitude, banks into turns (meta.hull bank), setThrottle() drives the flames
//   • sockets: muzzle + launch_1..4 (missile pod), muzzle_2 (cannon), exhaust_1..4, aim, smoke
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 9.0 long, 8.5 span, ≈ 4.7 high with fins. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { fuselage, wings, tailFins, exhaust, weapon, statusLamp, UNIT_MODULES } from './UnitModules.js';

/** Shapes by style.silhouette (sizes in model units; Y / Z of parts as shares of H / L) */
export const HEAVY_FIGHTER_SHAPES = {
  angular: {
    L: 9.0, W: 1.9, H: 1.5, span: 8.5, rc: 4.2, tc: 0.9, sweep: 2.6,
    altitude: 3.0, bobAmp: 0.12, bobFreq: 0.35,
    wingY: -0.1, wingZ: -0.1,
    fins: { count: 2, h: 1.4, chord: 1.8, y: 0.3, z: -0.38 },
    engines: { x: [-1.45, -0.55, 0.55, 1.45], r: 0.36, length: 1.8, z: -0.46, y: -0.1 },   // z share of L, y share of H
    nacelle: { w: 0.85, h: 0.8, len: 3.2 },
    missiles: { count: 4, x: 0, y: -0.45, z: 0.12, length: 1.0 },
    gun: { x: 0.35, y: -0.15, z: 0.28, length: 1.3, caliber: 0.08 },   // x share of W
    status: [0.45, -0.25],
  },
};

const SMOKE_Z = 0.4;   // smoke socket z share of L (behind the centre)

const shapeOf = (kit) => HEAVY_FIGHTER_SHAPES[kit.style.silhouette] ?? Object.values(HEAVY_FIGHTER_SHAPES)[0];

function buildHeavyFighter(kit) {
  const s = shapeOf(kit);
  const { L, W, H } = s;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, s.altitude, 0]);
  ub.meta.hull = { bone: 'hull', bank: true, bobAmp: s.bobAmp, bobFreq: s.bobFreq };
  fuselage(ub, { bone: 'hull', L, W, H });
  wings(ub, { bone: 'hull', y: H * s.wingY, z: L * s.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  tailFins(ub, { bone: 'hull', y: H * s.fins.y, z: L * s.fins.z, h: s.fins.h, chord: s.fins.chord, count: s.fins.count });
  const E = s.engines;
  const nb = ub.paint('hull');
  E.x.forEach((x, i) => {
    const pos = [x, H * E.y, L * E.z];
    nb.box(s.nacelle.w, s.nacelle.h, s.nacelle.len, kit.S.hullDark, { x, y: pos[1], z: pos[2] + UNIT_MODULES.exhaust.nozzleLen + s.nacelle.len / 2 });
    exhaust(ub, { parent: 'hull', position: pos, r: E.r, length: E.length, index: i + 1 });
  });
  const m = s.missiles;
  weapon(ub, 'missile', { parent: 'hull', position: [m.x, H * m.y, L * m.z], length: m.length, count: m.count, pitch: [0, 0] });
  const g = s.gun;
  weapon(ub, 'gun', { parent: 'hull', position: [W * g.x, H * g.y, L * g.z], length: g.length, caliber: g.caliber, pitch: [0, 0], sfx: '_2' });
  statusLamp(ub, { parent: 'hull', position: [0, H * s.status[0], L * s.status[1]] });
  ub.socket('aim', 'hull', [0, 0, 0]);
  ub.socket('smoke', 'hull', [0, 0, -L * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildHeavyFighter);

export class HeavyFighterJetUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'heavyFighterJet', name: 'HeavyFighterJetUnit' });
  }
}

registerProcUnit('heavyFighterJet', (race, teamColor, opts) => new HeavyFighterJetUnit({ race, teamColor, ...opts }));
