// Steel Men – shared code of the four superweapon buildings (OrbitalBombProc, TectonicTorpedoProc, PhaseChargeProc,
// NeutronBombProc; docs/notes/b3-common.md "Superzbraně – API stavu nabíjení").
//   • ChargeDrive        the charge state machine: setCharge(ratio, state) / launch() → smoothed `shown`, `energy` (0..1 growth
//                        driver incl. the launch flare), `flash` (state look: steady / ready pulse / stalled blink / cooldown dim),
//                        `launchP` (0..1 progress of the ~2.8 s launch animation, 0 outside)
//   • SuperweaponProc    ProcModel base class: setCharge, launch, update() → animate(dt, sw, active) of the subclass
//   • plinth()           style-shaped base slab (rounded / angular / round / faceted) with team belt, trim and emblem decals
//   • newContext / silhouetteOf / capacitor / StepTurn / sub  small construction and animation helpers
// Visual only: nothing here is read by the simulation, no Math.random / Date.now. update() allocates nothing.
import { PartBuilder, smootherstep } from './ProcKit.js';
import { ProcModel, GlowSet, styledBox, marking, teamTrim, pulseWave } from './ProcModules.js';

const TAU = Math.PI * 2;

/** Detail level of team-painted parts (kept in LOD2 like the other buildings) */
export const SW_TEAM_DETAIL = 2;

/** Charge / launch tuning (visual only; style.anim multiplies speeds in the buildings) */
export const SW_ANIM = {
  chargeEase: 2.5,        // 1/s – how fast the shown charge follows the simulated ratio
  floor: 0.12,            // energy at ratio 0 (the building is never completely dead)
  stalled: { hz: 2.6, level: 0.3 },       // no power: hard blink between `level` and 1
  ready: { hz: 1.7, depth: 0.55 },        // weapon ready: strong glow pulse (pulseWave depth)
  cooldown: { level: 0.45 },              // after launch: dim steady glow
  launch: { time: 2.8, rise: 0.15, hold: 0.7 },   // s; envelope rises in `rise` share, holds until `hold`, falls to 1
  phaseStep: 0.43,        // s – clock offset per instance
  beaconBase: 0.3,        // beacon intensity at zero energy
  beaconBlink: 0.18,      // ready: beacons blink between this and 1
};

/** Style-shaped base slab (model units; halfX / halfZ = the footprint ground box of stats simBody) */
export const SW_PLINTH = {
  padH: 0.3,              // ground slab
  h: 2.2,                 // plinth body above the slab
  inset: 1.0,             // body inset from the footprint edge
  taper: 0.4,             // round: radius lost over the height
  taperAngular: 1.2,      // angular: half-width lost over the height
  taperFaceted: 0.5,
  beltH: 0.7, beltOut: 0.03,
  decal: { size: 1.8, y: 1.2 },
  mark: { len: 5, h: 0.5, y: 0.9, out: 0.02 },
  neonTube: 0.07,
  neonMin: 0.3,           // style.neon from which neon rings are added
  segments: { round: 40, faceted: 8 },
};

/** Sub-progress 0..1 of `p` between `from` and `to`, smootherstep eased (0 before, 1 after) */
export const sub = (p, from, to) => smootherstep((p - from) / (to - from));

/** Linear ramp 0..1 of `p` between `from` and `to` (not eased) */
export const ramp = (p, from, to) => (p <= from ? 0 : p >= to ? 1 : (p - from) / (to - from));

/** Construction context of one style's shared geometry; bodies fill `parts` (geometries) and `spec` (numbers) */
export function newContext(kit) {
  return { kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), decals: [], parts: {}, spec: {} };
}

/** Silhouette key of the style that `table` has a builder for (unknown → rounded) */
export const silhouetteOf = (kit, table) => (Object.hasOwn(table, kit.style.silhouette) ? kit.style.silhouette : 'rounded');

/** Wall decal; `tilt` leans the normal upwards (sloped walls) */
export function wallDecal(c, position, nx, nz, size, tilt = 0) {
  c.decals.push({ position, normal: [nx * Math.cos(tilt), Math.sin(tilt), nz * Math.cos(tilt)], size });
}

/**
 * Plinth of a superweapon: ground slab + body of the silhouette's shape + team belt + trim + emblem decals.
 * Returns the y of its top face. The slab fills halfX × halfZ (round / faceted: a circle / octagon of the smaller half).
 */
export function plinth(c, sil, halfX, halfZ) {
  const { b, S, kit } = c;
  const P = SW_PLINTH;
  const y0 = P.padH;
  const y1 = y0 + P.h;
  const w = halfX * 2 - P.inset * 2;
  const d = halfZ * 2 - P.inset * 2;
  const D = P.decal;
  const neon = kit.style.neon >= P.neonMin;
  if (sil === 'round') {
    const r = Math.min(halfX, halfZ) - P.inset;
    const rTop = r - P.taper;
    b.cylinder(r + P.inset, r + P.inset, P.padH, P.segments.round, S.ground, { y: P.padH / 2 });
    b.cylinder(rTop, r, P.h, P.segments.round, S.hull, { y: y0 + P.h / 2 });
    b.cylinder(r + P.beltOut - P.taper * (P.beltH / P.h), r + P.beltOut, P.beltH, P.segments.round, S.teamPaint, { y: y0 + P.beltH / 2, detail: SW_TEAM_DETAIL });
    teamTrim(b, kit, { y: y1, r: rTop - 0.1 }, { detail: SW_TEAM_DETAIL });
    if (neon) b.torus(rTop + 0.05, P.neonTube, 4, 48, TAU, S.neon, { rx: Math.PI / 2, y: y1 - 0.3 });
    const rMid = r - P.taper * (D.y / P.h);
    const nl = Math.hypot(P.h, P.taper);
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      c.decals.push({ position: [Math.cos(a) * rMid, y0 + D.y, Math.sin(a) * rMid], normal: [(P.h / nl) * Math.cos(a), P.taper / nl, (P.h / nl) * Math.sin(a)], size: D.size });
    }
  } else if (sil === 'faceted') {
    const rr = (Math.min(halfX, halfZ) - P.inset) / Math.cos(Math.PI / 8);
    const k8 = P.segments.faceted;
    const apo = rr * Math.cos(Math.PI / 8);
    b.cylinder(rr + P.inset, rr + P.inset, P.padH, k8, S.ground, { y: P.padH / 2, ry: Math.PI / 8 });
    b.cylinder(rr - P.taperFaceted, rr, P.h, k8, S.hull, { y: y0 + P.h / 2, ry: Math.PI / 8 });
    b.cylinder(rr + P.beltOut, rr + P.beltOut, P.beltH, k8, S.teamPaint, { y: y0 + P.beltH / 2, ry: Math.PI / 8, detail: SW_TEAM_DETAIL });
    if (neon) b.torus(apo - P.taperFaceted * 0.5, P.neonTube, 4, 8, TAU, S.neon, { rx: Math.PI / 2, ry: Math.PI / 8, y: y1 - 0.3 });
    const tilt = Math.atan2(P.taperFaceted * Math.cos(Math.PI / 8), P.h);
    const ap = apo - P.taperFaceted * Math.cos(Math.PI / 8) * (D.y / P.h);
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      wallDecal(c, [Math.sin(a) * ap, y0 + D.y, Math.cos(a) * ap], Math.sin(a), Math.cos(a), D.size, tilt);
    }
  } else if (sil === 'angular') {
    const tp = P.taperAngular;
    b.box(halfX * 2, P.padH, halfZ * 2, S.ground, { base: true });
    b.taperedBox(w, w - tp * 2, P.h, d, S.hull, { y: y0 }, d - tp * 2);
    b.box(w + P.beltOut * 2, P.beltH, d + P.beltOut * 2, S.teamPaint, { base: true, y: y0, detail: SW_TEAM_DETAIL });
    const tilt = Math.atan2(tp, P.h);
    const hx = w / 2 - tp * (D.y / P.h);
    const hz = d / 2 - tp * (D.y / P.h);
    for (const e of [-1, 1]) {
      wallDecal(c, [0, y0 + D.y, e * hz], 0, e, D.size, tilt);
      wallDecal(c, [e * hx, y0 + D.y, 0], e, 0, D.size, tilt);
    }
    marking(b, kit, P.mark.len, P.mark.h, { y: y0 + P.mark.y, z: d / 2 + P.mark.out });
  } else {   // rounded
    b.box(halfX * 2, P.padH, halfZ * 2, S.ground, { base: true });
    styledBox(b, kit, w, P.h, d, S.hull, { base: true, y: y0 });
    b.box(w + P.beltOut * 2, P.beltH, d + P.beltOut * 2, S.teamPaint, { base: true, y: y0, detail: SW_TEAM_DETAIL });
    teamTrim(b, kit, { y: y1, w: w - 0.3, d: d - 0.3 }, { detail: SW_TEAM_DETAIL });
    for (const e of [-1, 1]) {
      wallDecal(c, [0, y0 + D.y, e * d / 2], 0, e, D.size);
      wallDecal(c, [e * w / 2, y0 + D.y, 0], e, 0, D.size);
    }
    marking(b, kit, P.mark.len, P.mark.h, { y: y0 + P.mark.y, z: d / 2 + P.mark.out });
  }
  return y1;
}

/**
 * Small capacitor / pylon stub: dark cylinder with a team cap (and a neon ring on rich styles).
 * `segments` = silhouette look (6 angular, 8 faceted, 14 rounded / round). Returns its top y.
 */
export function capacitor(c, { x, y, z, h, r, segments = 14, cap = true }) {
  const { b, S, kit } = c;
  b.cylinder(r, r * 1.15, h, segments, S.hullDark, { x, y: y + h / 2, z });
  if (cap) b.cylinder(r * 1.1, r * 1.1, 0.4, segments, S.teamPaint, { x, y: y + h + 0.2, z, detail: SW_TEAM_DETAIL });
  if (kit.rich) b.torus(r * 1.08, 0.06, 4, segments * 2, TAU, S.neon, { rx: Math.PI / 2, x, y: y + h * 0.5, z });
  return y + h + (cap ? 0.4 : 0);
}

/** Turning part: `angle` advances by delta × speed, optionally in stepped ticks (jerky styles) */
export class StepTurn {
  constructor(object, { step = 0, phase = 0, axis = 'y' } = {}) {
    this.object = object;
    this.step = step;
    this.angle = phase;
    this.axis = axis;
    object.rotation[axis] = phase;
  }

  update(delta, speed) {
    this.angle += delta * speed;
    this.object.rotation[this.axis] = this.step > 0 ? Math.round(this.angle / this.step) * this.step : this.angle;
  }
}

/** Charge state machine (one per model); all outputs are plain numbers, update() allocates nothing */
export class ChargeDrive {
  constructor(phase = 0) {
    this.ratio = 0;
    this.state = 'charging';
    this.seen = false;
    this.shown = 0;        // eased ratio
    this.time = phase;     // animation clock (s)
    this.launchT = -1;     // s since launch(), −1 = idle
    this.launching = false;
    this.launchP = 0;      // 0..1 progress of the launch animation
    this.env = 0;          // launch flare envelope 0..1
    this.energy = SW_ANIM.floor;   // growth driver 0..1 (charge + launch flare)
    this.flash = 1;        // state look multiplier 0..1 (apply to glow intensities)
    this.ready = false;
    this.stalled = false;
  }

  /** Idempotent; unknown state = 'charging'. The first call snaps the shown charge (no ease-in on load). */
  set(ratio, state) {
    this.ratio = ratio > 0 ? (ratio < 1 ? ratio : 1) : 0;
    this.state = state === 'stalled' || state === 'ready' || state === 'cooldown' ? state : 'charging';
    this.ready = this.state === 'ready';
    this.stalled = this.state === 'stalled';
    if (!this.seen) { this.seen = true; this.shown = this.ratio; }
  }

  launch() { this.launchT = 0; }

  update(delta) {
    const A = SW_ANIM;
    const L = A.launch;
    this.time += delta;
    this.shown += (this.ratio - this.shown) * Math.min(1, delta * A.chargeEase);
    if (this.launchT >= 0) {
      this.launchT += delta;
      this.launchP = this.launchT / L.time;
      if (this.launchP >= 1) { this.launchT = -1; this.launchP = 0; }
    }
    this.launching = this.launchT >= 0;
    const p = this.launchP;
    this.env = !this.launching ? 0 : p < L.rise ? smootherstep(p / L.rise) : p < L.hold ? 1 : 1 - smootherstep((p - L.hold) / (1 - L.hold));
    const base = A.floor + (1 - A.floor) * this.shown;
    this.energy = base + (1 - base) * this.env;
    let f = 1;
    if (this.state === 'ready') f = pulseWave(this.time, A.ready.hz, A.ready.depth);
    else if (this.state === 'stalled') f = Math.sin(TAU * A.stalled.hz * this.time) > 0 ? 1 : A.stalled.level;
    else if (this.state === 'cooldown') f = A.cooldown.level;
    this.flash = f + (1 - f) * this.env;
  }
}

let seqCounter = 0;

/**
 * Base class of the superweapon buildings. Subclass: constructor calls super({ race, teamColor, cache, name }) and then builds
 * its meshes; it implements animate(dt, sw, active) (dt = delta × animScale, sw = ChargeDrive) and may set `this.beacons`
 * (a GlowLayer – the base class drives its intensity).
 */
export class SuperweaponProc extends ProcModel {
  constructor(opts) {
    super(opts);
    this.seq = seqCounter++;
    this.sw = new ChargeDrive(this.seq * SW_ANIM.phaseStep);
    this.beacons = null;
    this.updated = false;   // set by update(); tick() checks whether it ran
  }

  /** Charge state (called every tick by Structure): ratio 0..1, state 'charging' | 'stalled' | 'ready' | 'cooldown' */
  setCharge(ratio, state = 'charging') {
    this.sw.set(ratio, state);
  }

  /** One-shot launch animation (~2.8 s); the model then returns to the look given by setCharge */
  launch() {
    this.sw.launch();
  }

  /**
   * ProcModel.tick skips update() for hidden / far (LOD > 0) models. A launch must still run its course there, otherwise
   * its tail would play when the camera arrives (and a flying bomb would flash by for a frame): while no update() ran
   * this tick and a launch is (or just was) running, the clock advances and the final pose is applied (delta 0).
   */
  tick(delta, active, sunClock) {
    this.updated = false;
    const wasLaunching = this.sw.launching;
    super.tick(delta, active, sunClock);
    if (this.updated || !this.shared || !(wasLaunching || this.sw.launchT >= 0)) return;
    this.sw.update(delta * this.animScale);
    this.animate(0, this.sw, active);
  }

  update(delta, active = false) {
    if (!this.shared) return;
    this.updated = true;
    const sw = this.sw;
    sw.update(delta);
    if (this.beacons) {
      const A = SW_ANIM;
      const v = sw.ready ? (Math.sin(TAU * A.ready.hz * sw.time) > 0 ? 1 : A.beaconBlink) : (A.beaconBase + (1 - A.beaconBase) * sw.energy) * (sw.stalled ? sw.flash : 1);
      this.beacons.setIntensity(v);
    }
    this.animate(delta, sw, active);
  }

  /** Override: per-frame animation (no allocations) */
  animate() {}
}
