// Steel Mans – procedural heavy bomber (roadmap U2): large four-engine war plane (four big exhaust flames), bomb bay
// doors under the belly (sockets bomb_1..n = where bombs leave), weak defensive guns (tail gun faces backwards).
//   • aircraft rig: hull bone hovers at the altitude, banks into turns, setThrottle() drives the flames
//   • sockets: muzzle (tail gun, points back), muzzle_2 (dorsal gun), bomb_1..n, exhaust_1..4, aim, smoke
// Model units (before VEHICLE.modelScale × stats.modelScale): ≈ 15 long, 17 span, ≈ 5.7 high with the fin. Visual only.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { fuselage, wings, tailFins, exhaust, weapon, statusLamp, UNIT_MODULES } from './UnitModules.js';

const PI = Math.PI;

/** Shapes by style.silhouette (sizes in model units; Y / Z of parts as shares of H / L unless noted) */
export const HEAVY_BOMBER_SHAPES = {
  angular: {
    L: 15.0, W: 3.4, H: 2.6, span: 17.0, rc: 6.5, tc: 2.6, sweep: 3.0,
    altitude: 3.0, bobAmp: 0.1, bobFreq: 0.25,
    wingY: -0.1, wingZ: -0.1,
    fin: { h: 1.9, chord: 3.0, y: 0.3, z: -0.38 },
    engines: { pos: [[-5.6, -4.3], [-3.2, -4.6], [3.2, -4.6], [5.6, -4.3]], r: 0.5, length: 2.6, y: -0.1 },   // [x, z] model units, y share of H
    nacelle: { w: 1.3, h: 1.2, len: 4.5 },
    bay: { w: 0.55, len: 0.3, z: 0.0, doorT: 0.1, gap: 0.03, bombs: 6, bombZ: 0.07 },   // shares of W / L; bombZ = spacing share of L
    tail: { z: -0.42, y: 0.2, length: 1.2, caliber: 0.07 },
    dorsal: { z: 0.05, length: 1.2, caliber: 0.07 },
    status: [0.5, -0.15],
  },
};

const SMOKE_Z = 0.4;   // smoke socket z share of L (behind the centre)

const shapeOf = (kit) => HEAVY_BOMBER_SHAPES[kit.style.silhouette] ?? Object.values(HEAVY_BOMBER_SHAPES)[0];

function buildHeavyBomber(kit) {
  const s = shapeOf(kit);
  const { L, W, H } = s;
  const S = kit.S;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, s.altitude, 0]);
  ub.meta.hull = { bone: 'hull', bank: true, bobAmp: s.bobAmp, bobFreq: s.bobFreq };
  fuselage(ub, { bone: 'hull', L, W, H });
  wings(ub, { bone: 'hull', y: H * s.wingY, z: L * s.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  tailFins(ub, { bone: 'hull', y: H * s.fin.y, z: L * s.fin.z, h: s.fin.h, chord: s.fin.chord, count: 1 });
  const E = s.engines;
  const hb = ub.paint('hull');
  E.pos.forEach(([x, z], i) => {
    const y = H * E.y;
    hb.box(s.nacelle.w, s.nacelle.h, s.nacelle.len, S.hullDark, { x, y, z: z + UNIT_MODULES.exhaust.nozzleLen + s.nacelle.len / 2 });
    exhaust(ub, { parent: 'hull', position: [x, y, z], r: E.r, length: E.length, index: i + 1 });
  });
  // bomb bay doors (two flaps with a seam) + bomb drop sockets along the bay
  const B = s.bay;
  const bayW = W * B.w;
  const bayL = L * B.len;
  const bayY = -H / 2 - B.doorT / 2;
  for (const side of [1, -1]) hb.box(bayW / 2 - B.gap, B.doorT, bayL, S.dark, { x: side * bayW / 4, y: bayY, z: L * B.z });
  for (let i = 0; i < B.bombs; i++) ub.socket(`bomb_${i + 1}`, 'hull', [0, bayY - B.doorT, L * B.z + (i - (B.bombs - 1) / 2) * L * B.bombZ]);
  // defensive guns: tail gun on a bone turned backwards, dorsal gun on the spine
  const T = s.tail;
  ub.bone('tail', 'hull', [0, H * T.y, L * T.z], { rotation: [0, PI, 0] });
  weapon(ub, 'gun', { parent: 'tail', position: [0, 0, 0], length: T.length, caliber: T.caliber, pitch: [0, 0] });
  const D = s.dorsal;
  weapon(ub, 'gun', { parent: 'hull', position: [0, H / 2, L * D.z], length: D.length, caliber: D.caliber, pitch: [0, 0], sfx: '_2' });
  statusLamp(ub, { parent: 'hull', position: [0, H * s.status[0], L * s.status[1]] });
  ub.socket('aim', 'hull', [0, 0, 0]);
  ub.socket('smoke', 'hull', [0, 0, -L * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(buildHeavyBomber);

export class HeavyBomberUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: import('three').ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'heavyBomber', name: 'HeavyBomberUnit' });
  }
}

registerProcUnit('heavyBomber', (race, teamColor, opts) => new HeavyBomberUnit({ race, teamColor, ...opts }));
