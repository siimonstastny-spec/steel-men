// Steel Men – procedural stealth bomber (roadmap U3). Broad flat fuselage, wide wings, two exhausts, a belly bomb bay
// with two doors and 4 bombs hidden inside. Ground attack only (no weapon barrel). Camouflage = owner calls
// setCloaked(0..1); it may move while cloaked. Shape by style.silhouette, no faction names.
//   dropBomb([index]) – visual only: the bay doors open (self-driven, setDeployed is overridden while bombs are in
//   flight), the bomb leaves, falls a short way, disappears and re-appears in the bay after BOMB.reload s. Returns the
//   bomb index. The real bomb projectile starts at socket `bomb_<i+1>` (read its world position BEFORE / at the call).
// Sockets: bomb_1..bomb_4 (drop points under the belly), aim, smoke, exhaust_1/2. Model units ≈ 8.6 long, 10.5 span.
// Hull flies at JET.altitude (rest pose). Registered as 'stealthBomber'.
// update() runs only at LOD0 and while visible (kit); at far LOD the bombs stay in the bay (frozen rest pose).
import { UnitBuilder, ProcUnit, UNIT_KIT, createUnitCache, registerProcUnit } from './UnitKit.js';
import { fuselage, wings, tailFins, exhaust, statusLamp } from './UnitModules.js';
import { teamAircraft } from './StealthJetUnit.js';   // team surfaces of aircraft: wing plates + fuselage cap / chevron

const HALF_PI = Math.PI / 2;
const BASE = { L: 8.4, W: 2.2, H: 1.0, span: 10.0, rc: 4.2, tc: 0.7, sweep: 2.2, fins: 2 };

/** Shapes by style.silhouette (unknown → rounded) */
export const STEALTH_BOMBER_SHAPES = {
  rounded: BASE,
  angular: { ...BASE, L: 8.8, W: 2.4, span: 10.6, sweep: 2.8 },
  round: { ...BASE, L: 8.0, W: 3.0, H: 1.1, tc: 0, sweep: 2.0, fins: 0 },
  faceted: { ...BASE, L: 8.8, W: 2.0, H: 0.9, span: 9.6, sweep: -0.8 },
};
const JET = {
  altitude: 3.5, bobAmp: 0.1, bobFreq: 0.3,
  engines: 2, engineSpacing: 0.9, engineR: 0.3, engineLen: 1.8,
  finH: 0.8, finChord: 1.4, finY: 0.3, finZ: -0.38, finTilt: 0.6,
  wingY: -0.1, wingZ: -0.1,
  statusY: 0.45, statusZ: -0.15,
};
/** Bomb bay: width share of W, length (model units), centre z share of L, belly height share of H (door hinge), door thickness */
const BAY = { w: 0.5, l: 2.6, z: -0.05, belly: -0.42, doorT: 0.05, open: 1.4 };
/** Bombs: count, radius, body length, nose length, fin size, height share of H (inside the hull), pitch between bombs */
const BOMB = {
  count: 4, r: 0.17, len: 0.55, nose: 0.22, fin: 0.14, y: -0.3, pitch: 0.62, seg: 8,
  // visual drop timing (s) and distance (model units)
  delay: 0.25, fall: 0.7, reload: 6, linger: 0.4, dropDistance: 6, bayEase: 6,
};
const BAY_EPS = 1e-3;
const BOMB_FIN_T = 0.02;   // bomb fin thickness
const SMOKE_Z = 0.3;       // smoke socket z share of L (behind the centre)

const shapeOf = (kit) => STEALTH_BOMBER_SHAPES[kit.style.silhouette] ?? STEALTH_BOMBER_SHAPES.rounded;
const bombZ = (L, i) => L * BAY.z + (i - (BOMB.count - 1) / 2) * BOMB.pitch;

function build(kit) {
  const s = shapeOf(kit);
  const { L, W, H } = s;
  const S = kit.S;
  const ub = new UnitBuilder(kit);
  ub.bone('hull', 'root', [0, JET.altitude, 0]);
  ub.meta.hull = { bone: 'hull', bank: true, bobAmp: JET.bobAmp, bobFreq: JET.bobFreq };
  fuselage(ub, { bone: 'hull', L, W, H });
  wings(ub, { bone: 'hull', y: H * JET.wingY, z: L * JET.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep });
  teamAircraft(ub, {
    bone: 'hull', L, W, H, wingY: H * JET.wingY, wingZ: L * JET.wingZ, span: s.span, rc: s.rc, tc: s.tc, sweep: s.sweep,
  });
  if (s.fins) tailFins(ub, { bone: 'hull', y: H * JET.finY, z: L * JET.finZ, h: JET.finH, chord: JET.finChord, count: s.fins, tilt: JET.finTilt });
  for (let i = 0; i < JET.engines; i++) {
    const x = (i - (JET.engines - 1) / 2) * JET.engineSpacing;
    exhaust(ub, { parent: 'hull', position: [x, 0, -L / 2], r: JET.engineR, length: JET.engineLen, index: i + 1 });
  }
  // bay doors: hinge at the bay edges, closed = flat under the bombs, open = hanging down / outwards (deploy channel rz)
  const bayW = W * BAY.w;
  const hingeY = H * BAY.belly;
  for (const side of [1, -1]) {
    const door = ub.bone(`bayDoor${side > 0 ? 'L' : 'R'}`, 'hull', [side * bayW / 2, hingeY, L * BAY.z]);
    ub.paint(door).box(bayW / 2, BAY.doorT, BAY.l, S.hullDark, { x: -side * bayW / 4 });
    ub.deploy(door, 'rz', side * BAY.open);
  }
  // bombs (one bone each: dropBomb animates it), sockets stay on the hull
  for (let i = 0; i < BOMB.count; i++) {
    const bone = ub.bone(`bomb_${i + 1}`, 'hull', [0, H * BOMB.y, bombZ(L, i)]);
    const b = ub.paint(bone);
    b.cylinder(BOMB.r, BOMB.r, BOMB.len, BOMB.seg, S.dark, { rx: HALF_PI });
    b.cylinder(0, BOMB.r, BOMB.nose, BOMB.seg, S.team, { rx: HALF_PI, z: (BOMB.len + BOMB.nose) / 2 });
    b.box(BOMB.fin * 2, BOMB_FIN_T, BOMB.fin, S.trim, { z: -BOMB.len / 2 });
    b.box(BOMB_FIN_T, BOMB.fin * 2, BOMB.fin, S.trim, { z: -BOMB.len / 2 });
    ub.socket(`bomb_${i + 1}`, 'hull', [0, hingeY - BOMB.r, bombZ(L, i)]);
  }
  statusLamp(ub, { parent: 'hull', position: [0, H * JET.statusY, L * JET.statusZ] });
  ub.socket('aim', 'hull', [0, 0, 0]);
  ub.socket('smoke', 'hull', [0, 0, -L * SMOKE_Z]);
  return ub.build();
}

const CACHE = createUnitCache(build);

export class StealthBomberUnit extends ProcUnit {
  /** @param {{ race?: string, teamColor?: THREE.ColorRepresentation }} [o] */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: CACHE, type: 'stealthBomber', name: 'StealthBomberUnit' });
    this.bombBones = [];
    this.bombRest = new Float32Array(BOMB.count);
    this.bombTimer = new Float32Array(BOMB.count);   // s left of the drop + reload cycle (0 = bomb in the bay)
    this.bombNext = 0;
    this.bayTimer = 0;                               // s the bay stays open
    this.bay = 0;                                    // door progress 0..1
    for (let i = 0; i < BOMB.count; i++) {
      const b = this.getBone(`bomb_${i + 1}`);
      this.bombBones.push(b);
      this.bombRest[i] = b.position.y;
    }
  }

  /** Visual bomb drop (see file header); index omitted = next bomb in turn. Returns the index used. */
  dropBomb(index = -1) {
    let i = index;
    if (i < 0 || i >= BOMB.count) { i = this.bombNext; this.bombNext = (i + 1) % BOMB.count; }
    this.bombTimer[i] = BOMB.delay + BOMB.fall + BOMB.reload;
    // a repeated drop restarts the cycle: put the bomb back in the bay at once (it may be falling or hidden)
    this.bombBones[i].position.y = this.bombRest[i];
    this.bombBones[i].scale.setScalar(1);
    this.bayTimer = Math.max(this.bayTimer, BOMB.delay + BOMB.fall + BOMB.linger);
    return i;
  }

  update(dt) {
    const hidden = UNIT_KIT.hiddenScale;
    const total = BOMB.delay + BOMB.fall + BOMB.reload;
    for (let i = 0; i < BOMB.count; i++) {
      const left = this.bombTimer[i];
      if (left <= 0) continue;
      const t = Math.max(0, left - dt);
      this.bombTimer[i] = t;
      const bone = this.bombBones[i];
      const e = total - t - BOMB.delay;   // s since the release (< 0 while the doors open)
      if (t <= 0) {
        bone.position.y = this.bombRest[i];
        bone.scale.setScalar(1);
      } else if (e >= BOMB.fall) {
        bone.position.y = this.bombRest[i];
        bone.scale.setScalar(hidden);
      } else if (e >= 0) {
        const k = e / BOMB.fall;
        bone.position.y = this.bombRest[i] - BOMB.dropDistance * k * k;
      }
    }
    this.bayTimer = Math.max(0, this.bayTimer - dt);
    if (this.bay > BAY_EPS || this.bayTimer > 0) {
      this.bay += ((this.bayTimer > 0 ? 1 : 0) - this.bay) * Math.min(1, dt * BOMB.bayEase);
      if (this.bay <= BAY_EPS && this.bayTimer <= 0) this.bay = 0;
      this.setDeployed(this.bay);
    }
  }
}

registerProcUnit('stealthBomber', (race, teamColor, opts) => new StealthBomberUnit({ race, teamColor, ...opts }));
