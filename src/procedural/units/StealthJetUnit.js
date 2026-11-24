// Steel Mans – procedural stealth jet (roadmap U3). Slim fuselage, swept wings, V-tail, two exhausts (style flame kind),
// nose plasma gun (anti-air), glowing dorsal spine and intakes. Camouflage = owner calls setCloaked(0..1) (it may move
// while cloaked); setStatus('cloaked') = blue lamp. Shape by style.silhouette (fuselage / wings modules), no faction names.
// Sockets: muzzle, aim, smoke, exhaust_1/2. Model units ≈ 5.6–6.6 long, 5.2–6.0 span; hull flies at JET.altitude (rest pose,
// like the kit's previewJet – the owner decides the real height). Aircraft owner: setThrottle(speed / maxSpeed); bank is automatic.
// Registered as 'stealthJet'. No per-frame code of its own.
import { UnitBuilder, ProcUnit, createUnitCache, registerProcUnit } from './UnitKit.js';
import { fuselage, wings, tailFins, exhaust, weapon, statusLamp } from './UnitModules.js';

const BASE = { L: 6.2, W: 1.2, H: 0.75, span: 5.4, rc: 3.0, tc: 0.5, sweep: 1.8, fins: 2 };

/** Shapes by style.silhouette (unknown → rounded) */
export const STEALTH_JET_SHAPES = {
  rounded: BASE,
  angular: { ...BASE, L: 6.6, W: 1.4, span: 5.8, sweep: 2.3 },
  round: { ...BASE, L: 5.8, W: 1.8, H: 0.8, tc: 0, sweep: 1.4, fins: 0 },
  faceted: { ...BASE, L: 6.6, W: 1.0, H: 0.7, span: 5.2, tc: 0.4, sweep: -0.5 },
};
const JET = {
  altitude: 3, bobAmp: 0.1, bobFreq: 0.4,
  engines: 2, engineSpacing: 0.55, engineR: 0.22, engineLen: 1.5,
  finH: 0.9, finChord: 1.1, finY: 0.3, finZ: -0.38, finTilt: 0.6,
  wingY: -0.1, wingZ: -0.1,
  gunY: -0.3, gunZ: 0.3, gunLen: 1.3, gunCal: 0.1,
  statusY: 0.45, statusZ: -0.2,
  intake: { x: 0.5, z: 0.05, w: 0.3, h: 0.25, d: 0.9, haloR: 0.1 },        // box beside the fuselage (x share of W)
  spine: { y: 0.42, z0: -0.3, z1: 0.1, t: 0.035, intensity: 0.6 },            // glowing dorsal line (y share of H, z shares of L)
  smokeZ: 0.3,                                                                // smoke socket z share of L (behind the centre)
};

const shapeOf = (kit) => STEALTH_JET_SHAPES[kit.style.silhouette] ?? STEALTH_JET_SHAPES.rounded;

function build(kit) {
  const s = shapeOf(kit);
  const { L, W, H } = s;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, JET.altitude, 0]);
  ub.meta.hull = { bone: 'hull', bank: true, bobAmp: JET.bobAmp, bobFreq: JET.bobFreq };
  fuselage(ub, { bone: 'hull', L, W, H });
  wings(ub, { bone: 'hull', y: H * JET.wingY, z: L * JET.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  if (s.fins) tailFins(ub, { bone: 'hull', y: H * JET.finY, z: L * JET.finZ, h: JET.finH, chord: JET.finChord, count: s.fins, tilt: JET.finTilt });
  const I = JET.intake;
  for (const side of [1, -1]) {
    ub.paint('hull').box(I.w, I.h, I.d, kit.S.hullDark, { x: side * W * I.x, y: 0, z: L * I.z });
    ub.glow('hull').point([side * W * I.x, 0, L * I.z + I.d / 2], I.haloR, ub.style.weaponGlow, {});
  }
  const sp = JET.spine;
  ub.glow('hull').segment([0, H * sp.y, L * sp.z0], [0, H * sp.y, L * sp.z1], sp.t, ub.style.weaponGlow);
  for (let i = 0; i < JET.engines; i++) {
    const x = (i - (JET.engines - 1) / 2) * JET.engineSpacing;
    exhaust(ub, { parent: 'hull', position: [x, 0, -L / 2], r: JET.engineR, length: JET.engineLen, index: i + 1 });
  }
  weapon(ub, 'plasma', { parent: 'hull', position: [0, H * JET.gunY, L * JET.gunZ], length: JET.gunLen, caliber: JET.gunCal, pitch: [0, 0] });
  statusLamp(ub, { parent: 'hull', position: [0, H * JET.statusY, L * JET.statusZ] });
  ub.socket('aim', 'hull', [0, 0, 0]);
  ub.socket('smoke', 'hull', [0, 0, -L * JET.smokeZ]);
  return ub.build();
}

const CACHE = createUnitCache(build);

export class StealthJetUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: THREE.ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'stealthJet', name: 'StealthJetUnit' });
  }
}

registerProcUnit('stealthJet', (race, teamColor, opts) => new StealthJetUnit({ race, teamColor, ...opts }));
