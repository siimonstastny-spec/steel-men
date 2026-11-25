// Steel Men – procedural Imaging Pole (a tall, thin mast with a turning optical head; unarmed watch post with a long sight).
// Built in code from the style modules (ProcModules.js) and the faction style:
//   • simBody (stats.json): halfX / halfZ ≈ 1.02, height ≈ 10.6 → a small pad ±1.02 and a slim mast, nothing wide
//   • mast by style.silhouette (rounded: round mast with a railed collar and a drum camera · angular: tapered armoured post
//     with a boxy turret and a spike · round: slender stem with two saucers and an eye sphere with a gyro ring · faceted:
//     blade mast with a crystal eye); edges, neon, lights, markings, texture, emblem come from the style
//   • the head scans: it sweeps left / right across an arc (slow idle, wider and faster while active); the lens glows and
//     pulses, a scan glint runs up the mast
//   • static body = one merged mesh (LODs) + emblem decals + a few glow layers + one animated head mesh (far LOD: frozen)
// Visual only: update() takes the frame delta (already × animScale, see ProcModel.tick); no allocations there.
import { PartBuilder, Blinker } from './ProcKit.js';
import {
  ProcModel, createSharedCache, GlowSet, marking, neonStrip, beacon, spike, emblemDecalGeometry, pulseWave, teamTrim,
} from './ProcModules.js';

const TAU = Math.PI * 2;

/** Animation tuning (visual only; style.anim multiplies speeds) */
export const IMAGING_ANIM = {
  sweepIdle: 0.35,        // rad/s of the sweep phase while idle
  sweepActive: 0.9,       // rad/s while active
  arcIdle: 0.9,           // rad – half angle of the sweep while idle
  arcActive: 1.9,         // rad – while active (≈ 110° each side)
  arcEase: 1.2,           // 1/s – how fast the arc widens / narrows
  jerkTicks: 12,          // when style.anim.jerk > 0 the head turns in steps of TAU / jerkTicks
  idleGlow: 0.45,
  idleBeacon: 0.4,
  blinkDuty: 0.5,
  phaseStep: 0.37,        // rad – sweep phase offset per instance
  glintPhaseStep: 0.31,   // share of a glint cycle – offset per instance
  timePhaseStep: 0.53,    // s – glow pulse offset per instance
  glint: { rate: 0.5, idleShare: 0.4 },   // scan glint runs up the mast (cycles per second)
};

/** Shared layout (model units = world units; origin = mast axis on the ground, front = +Z) */
const LAYOUT = {
  pad: 1.02, padH: 0.2,    // pad half size = stats simBody halfX / halfZ
  height: 10.6,            // top of the head (stats simBody bodyHeight)
  neonMin: 0.3,
  decal: { size: 0.8 },
};

/** Dimensions by style.silhouette (unknown → rounded). `head` = the optic: kind, centre height above the mast top, size */
const DIM = {
  rounded: {
    base: { w: 1.8, h: 1.1 },
    mast: { rTop: 0.2, rBottom: 0.32, seg: 12 },
    collar: { r: 0.85, h: 0.18, rail: 0.8, railH: 0.5, tube: 0.04, posts: 6 },
    mark: { len: 1.2, h: 0.25, y: 0.5 },
    decalY: 0.6,
    head: { kind: 'drum', r: 0.62, h: 0.9, barrel: [0.28, 0.9], lift: 0.55, lens: 0.2 },
    beacon: { x: 0.7, z: 0.7 },
  },
  angular: {
    base: { w: 1.9, topW: 1.3, h: 1.3 },
    mast: { w: 0.55, topW: 0.34 },
    spikes: { at: 0.75, h: 0.55, r: 0.12 },
    mark: { len: 1.1, h: 0.25, y: 0.45 },
    decalY: 0.7,
    head: { kind: 'box', w: 1.1, h: 0.75, d: 1.2, barrel: [0.45, 0.45, 0.7], lift: 0.45, lens: 0.2 },
    beacon: { x: 0, z: 0.75 },
  },
  round: {
    base: { rTop: 0.7, rBottom: 1.0, h: 0.8, seg: 20 },
    mast: { rTop: 0.14, rBottom: 0.26, seg: 12 },
    saucers: { ys: [2.8, 5.6], r: 0.65, flat: 0.28 },
    decalAngles: [Math.PI / 2],
    head: { kind: 'eye', r: 0.55, ring: 0.8, tube: 0.06, lift: 0.8, lens: 0.2 },
    beacon: { x: 0.85, z: 0.2 },
  },
  faceted: {
    base: { w: 1.7, h: 0.8 },
    mast: { w: 0.6, topW: 0.2 },
    blades: { r: 0.35, w: 0.12, topW: 0.04, h: 4.2, d: 0.7, topD: 0.3 },
    decalY: 0.5,
    head: { kind: 'crystal', size: 0.5, stretch: 1.5, disc: 0.75, discH: 0.08, discDy: 0.55, lift: 0.9, lens: 0.16 },
    beacon: null,
  },
};

const GLINT = { w: 0.5, tube: 0.04 };   // scan glint: a thin horizontal ring-like frame (box ring) round the mast

const BODIES = {};   // silhouette → mast builder

// ---------------------------------------------------------------- helpers (construction time only)

function wallDecal(c, position, nx, nz, size, tilt = 0) {
  c.decals.push({ position, normal: [nx * Math.cos(tilt), Math.sin(tilt), nz * Math.cos(tilt)], size });
}

/** Records where the head sits: its centre is at the top of the mast + lift; the mast top must leave room for the head */
function setHead(c, D, mastTop) {
  c.head = { ...D.head, y: mastTop + D.head.lift };
}

// ---------------------------------------------------------------- masts (one per silhouette; all fit the pad)

BODIES.rounded = (c) => {
  const D = DIM.rounded;
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  b.box(L.pad * 2, L.padH, L.pad * 2, S.ground, { base: true });
  const y0 = L.padH;
  b.box(D.base.w, D.base.h, D.base.w, S.teamPaint, { base: true, y: y0, detail: 2 });
  teamTrim(b, kit, { y: y0 + D.base.h, w: D.base.w - 0.1, d: D.base.w - 0.1 }, { detail: 2 });
  marking(b, kit, D.mark.len, D.mark.h, { y: y0 + D.mark.y, z: D.base.w / 2 + 0.02 });
  wallDecal(c, [0, y0 + D.decalY, D.base.w / 2], 0, 1, LAYOUT.decal.size);
  const y1 = y0 + D.base.h;
  const top = L.height - D.head.lift - D.head.h / 2;   // mast ends just under the head
  const M = D.mast;
  const h = top - y1;
  b.cylinder(M.rTop, M.rBottom, h, M.seg, S.hull, { y: y1 + h / 2 });
  if (kit.style.neon >= L.neonMin) b.torus(M.rBottom + (M.rTop - M.rBottom) * 0.3 + 0.03, 0.04, 4, 16, TAU, S.neon, { rx: Math.PI / 2, y: y1 + h * 0.3 });
  const Co = D.collar;
  b.cylinder(Co.r, Co.r, Co.h, 16, S.frame, { y: top - Co.h / 2 });
  if (kit.style.markings === 'hazard') {
    b.torus(Co.rail, Co.tube, 4, 20, TAU, S.accent, { rx: Math.PI / 2, y: top + Co.railH });
    for (let i = 0; i < Co.posts; i++) {
      const a = (i / Co.posts) * TAU;
      b.box(0.05, Co.railH, 0.05, S.frame, { base: true, x: Math.cos(a) * Co.rail, y: top, z: Math.sin(a) * Co.rail });
    }
  }
  beacon(b, glows.get('beaconA'), kit, [D.beacon.x, y0 + D.base.h, D.beacon.z]);
  beacon(b, glows.get('beaconA'), kit, [-D.beacon.x, y0 + D.base.h, D.beacon.z]);
  glows.get('pulse').segment([0, y1, M.rBottom + 0.02], [0, top - Co.h, M.rTop + 0.02], 0.05);
  setHead(c, D, top);
  c.glintR = M.rBottom + 0.06;
  c.glintY = [y1, top];
};

BODIES.angular = (c) => {
  const D = DIM.angular;
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  b.box(L.pad * 2, L.padH, L.pad * 2, S.ground, { base: true });
  const y0 = L.padH;
  const Ba = D.base;
  b.taperedBox(Ba.w, Ba.topW, Ba.h, Ba.w, S.teamPaint, { y: y0, detail: 2 }, Ba.topW);
  const y1 = y0 + Ba.h;
  const halfAt = Ba.w / 2 - ((Ba.w - Ba.topW) / 2) * (D.decalY / Ba.h);
  marking(b, kit, D.mark.len, D.mark.h, { y: y0 + D.mark.y, z: Ba.w / 2 - 0.02 });
  wallDecal(c, [0, y0 + Math.min(D.decalY, Ba.h - 0.3), halfAt], 0, 1, L.decal.size, Math.atan2((Ba.w - Ba.topW) / 2, Ba.h));
  const top = L.height - D.head.lift - D.head.h / 2;
  const M = D.mast;
  b.taperedBox(M.w, M.topW, top - y1, M.w, S.hull, { y: y1 }, M.topW);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) spike(b, kit, { x: sx * D.spikes.at, y: y1, z: sz * D.spikes.at, h: D.spikes.h, r: D.spikes.r });
  }
  b.box(0.7, 0.2, 0.7, S.hullDark, { base: true, y: top - 0.2 });
  beacon(b, glows.get('beaconA'), kit, [0, y1, D.beacon.z]);
  glows.get('pulse').segment([0, y1 + 0.2, M.w / 2 + 0.02], [0, top - 0.3, M.topW / 2 + 0.02], 0.05);
  setHead(c, D, top);
  c.glintR = M.w / 2 + 0.05;
  c.glintY = [y1, top];
};

BODIES.round = (c) => {
  const D = DIM.round;
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  b.cylinder(L.pad, L.pad, L.padH, 20, S.ground, { y: L.padH / 2 });
  const y0 = L.padH;
  const Ba = D.base;
  b.cylinder(Ba.rTop, Ba.rBottom, Ba.h, Ba.seg, S.teamPaint, { y: y0 + Ba.h / 2, detail: 2 });
  teamTrim(b, kit, { y: y0, r: L.pad - 0.1 }, { detail: 2 });
  const slope = Ba.rBottom - Ba.rTop;
  const nl = Math.hypot(Ba.h, slope);
  const rMid = (Ba.rTop + Ba.rBottom) / 2;
  for (const a of D.decalAngles) {
    c.decals.push({ position: [Math.cos(a) * rMid, y0 + Ba.h / 2, Math.sin(a) * rMid], normal: [(Ba.h / nl) * Math.cos(a), slope / nl, (Ba.h / nl) * Math.sin(a)], size: L.decal.size });
  }
  const y1 = y0 + Ba.h;
  const top = L.height - D.head.lift - D.head.ring;
  const M = D.mast;
  b.cylinder(M.rTop, M.rBottom, top - y1, M.seg, S.hull, { y: y1 + (top - y1) / 2 });
  for (const y of D.saucers.ys) {
    b.sphere(D.saucers.r, 16, 8, S.hullDark, { y, sy: D.saucers.flat });
    if (kit.rich) b.torus(D.saucers.r, 0.04, 4, 20, TAU, S.neon, { rx: Math.PI / 2, y });
  }
  beacon(b, glows.get('beaconA'), kit, [D.beacon.x, y0, D.beacon.z]);
  glows.get('pulse').segment([0, y1, M.rBottom + 0.02], [0, top, M.rTop + 0.02], 0.05);
  setHead(c, D, top);
  c.glintR = M.rBottom + 0.06;
  c.glintY = [y1, top];
};

BODIES.faceted = (c) => {
  const D = DIM.faceted;
  const { b, S, kit, glows } = c;
  const L = LAYOUT;
  b.cylinder(L.pad / Math.cos(Math.PI / 8), L.pad / Math.cos(Math.PI / 8), L.padH, 8, S.ground, { y: L.padH / 2, ry: Math.PI / 8 });
  const y0 = L.padH;
  b.box(D.base.w, D.base.h, D.base.w, S.teamPaint, { base: true, y: y0, detail: 2 });
  if (kit.style.neon >= L.neonMin) neonStrip(b, kit, D.base.w + 0.04, 0.06, D.base.w + 0.04, { y: y0 + D.base.h * 0.7 });
  const y1 = y0 + D.base.h;
  wallDecal(c, [0, y0 + D.decalY, D.base.w / 2], 0, 1, L.decal.size);
  const top = L.height - D.head.lift - D.head.size * D.head.stretch;
  const M = D.mast;
  b.taperedBox(M.w, M.topW, top - y1, M.w, S.hullDark, { y: y1, ry: Math.PI / 4 }, M.topW);
  const Bl = D.blades;
  for (let k = 0; k < 4; k++) {
    const ry = (k * Math.PI) / 2;
    b.taperedBox(Bl.w, Bl.topW, Bl.h, Bl.d, S.hull, { x: Math.round(Math.sin(ry)) * Bl.r, y: y1, z: Math.round(Math.cos(ry)) * Bl.r, ry }, Bl.topD);
  }
  beacon(b, glows.get('beaconA'), kit, [0, top, 0]);
  glows.get('pulse').segment([0, y1, 0], [0, top, 0], 0.08);
  setHead(c, D, top);
  c.glintR = M.w / 2 + 0.1;
  c.glintY = [y1, top];
};

// ---------------------------------------------------------------- optic heads (origin = head centre, lens looks along +Z)

function drumHead(kit, H) {
  const S = kit.S;
  const b = new PartBuilder();
  b.cylinder(H.r, H.r, H.h, 16, S.hullDark, {});
  b.cylinder(H.r * 1.04, H.r * 1.04, H.h * 0.22, 16, S.teamPaint, { y: H.h * 0.2 });
  b.cylinder(H.barrel[0], H.barrel[0], H.barrel[1], 10, S.frame, { rx: Math.PI / 2, z: H.r + H.barrel[1] / 2 - 0.1 });
  b.cylinder(H.lens, H.lens, 0.08, 10, S.lens, { rx: Math.PI / 2, z: H.r + H.barrel[1] - 0.06 });
  b.box(H.barrel[0] * 2.2, 0.05, H.barrel[1] * 0.8, S.dark, { y: H.barrel[0] + 0.03, z: H.r + H.barrel[1] * 0.4 });   // sunshade
  return b.build();
}

function boxHead(kit, H) {
  const S = kit.S;
  const b = new PartBuilder();
  b.box(H.w, H.h, H.d, S.hullDark, {});
  b.box(H.w * 1.04, H.h * 0.2, H.d * 1.04, S.teamPaint, { y: H.h * 0.2 });
  b.box(H.barrel[0], H.barrel[1], H.barrel[2], S.frame, { z: H.d / 2 + H.barrel[2] / 2 - 0.05 });
  b.box(H.lens * 1.6, H.lens * 1.6, 0.08, S.lens, { z: H.d / 2 + H.barrel[2] - 0.02 });
  spike(b, kit, { x: 0, y: H.h / 2, z: -H.d * 0.25, h: 0.5, r: 0.12 });
  return b.build();
}

function eyeHead(kit, H) {
  const S = kit.S;
  const b = new PartBuilder();
  b.sphere(H.r, 16, 10, S.hullDark, {});
  b.torus(H.ring, H.tube, 6, 24, TAU, S.teamPaint, {});
  b.torus(H.ring, H.tube, 6, 24, TAU, S.trim, { ry: Math.PI / 2 });
  b.sphere(H.lens, 10, 6, S.lens, { z: H.r - 0.05 });
  return b.build();
}

function crystalHead(kit, H) {
  const S = kit.S;
  const b = new PartBuilder();
  b.sphere(H.size, 6, 4, S.plasma, { sy: H.stretch });
  for (const s of [-1, 1]) b.box(H.disc * 2, H.discH, H.disc * 2, S.teamPaint, { y: s * H.discDy, ry: Math.PI / 4 });
  b.box(H.lens * 1.5, H.lens * 1.5, 0.3, S.lens, { z: H.size + 0.1 });
  return b.build();
}

const HEAD_BUILDERS = { drum: drumHead, box: boxHead, eye: eyeHead, crystal: crystalHead };

// ---------------------------------------------------------------- shared per-style data

function buildShared(kit) {
  const sil = Object.hasOwn(BODIES, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const c = {
    kit, S: kit.S, b: new PartBuilder(), glows: new GlowSet(), decals: [], head: null, glintR: 0.3, glintY: [0, 1],
  };
  BODIES[sil](c);
  const H = c.head;
  // head glow (local to the head): a halo round the lens and a short soft beam forward
  const lensGlow = new GlowSet();
  const lz = H.kind === 'drum' ? H.r + H.barrel[1] : H.kind === 'box' ? H.d / 2 + H.barrel[2] : H.kind === 'eye' ? H.r : H.size + 0.15;
  lensGlow.get('lens').point([0, 0, lz + 0.05], H.lens * 1.8);
  lensGlow.get('lens').segment([0, 0, lz + 0.1], [0, 0, lz + 1.6], 0.05);
  // scan glint: unit ring (square frame) that the model scales and moves up the mast
  const glint = new GlowSet();
  glint.get('glint').torus(c.glintR, GLINT.tube, 4, 20, TAU, { rx: Math.PI / 2 });
  return {
    sil,
    static: c.b.buildLods(),
    glow: c.glows.build(),
    emblem: emblemDecalGeometry(c.decals),
    head: { x: 0, y: H.y, z: 0, geometry: HEAD_BUILDERS[H.kind](kit, H) },
    lens: lensGlow.build().lens,
    glint: glint.build().glint,
    glintY: c.glintY,
  };
}

const IMAGING_CACHE = createSharedCache(buildShared);

let instanceCounter = 0;

// ---------------------------------------------------------------- the model

export class ImagingPoleProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: IMAGING_CACHE, name: 'ImagingPoleProc' });
    try {
      this.#build();
    } catch (err) {
      this.dispose();   // give back the references super() took
      throw err;
    }
  }

  #build() {
    const sh = this.shared;
    const an = this.kit.style.anim;
    const gc = this.kit.glowColors;
    const A = IMAGING_ANIM;
    const seq = instanceCounter++;

    this.staticMesh(sh.static);
    this.emblem(sh.emblem);
    const layer = (name, color, visible) => (sh.glow[name] ? this.glowLayer(sh.glow[name], color, { visible }) : null);
    this.beacons = layer('beaconA', gc.beacon, true);
    this.pulseGlow = layer('pulse', gc.pulse, true);

    // optic head: sweeps across an arc (far LOD: drawn frozen in its last pose); the lens glow is its child
    this.head = this.paintMesh(sh.head.geometry, this, { far: true });
    this.head.position.set(sh.head.x, sh.head.y, sh.head.z);
    this.lensGlow = this.glowLayer(sh.lens, gc.beam, { parent: this.head });
    this.glint = this.glowLayer(sh.glint, gc.pulse, { visible: false });
    this.glintY0 = sh.glintY[0];
    this.glintSpan = sh.glintY[1] - sh.glintY[0];

    this.phase = seq * A.phaseStep;
    this.glintClock = (seq * A.glintPhaseStep) % 1;
    this.arc = A.arcIdle;
    this.time = seq * A.timePhaseStep;
    this.jerkStep = an.jerk > 0 ? TAU / A.jerkTicks : 0;
    this.blink = new Blinker({ period: an.blink, duty: A.blinkDuty });
  }

  /**
   * Per-frame animation (no allocations). The head always sweeps slowly; while active the arc widens, the sweep speeds
   * up, the lens shines fully and the scan glint runs up the mast; beacons blink.
   * @param {number} delta   seconds (× animScale)
   * @param {boolean} active
   */
  update(delta, active = false) {
    if (!this.shared) return;
    const an = this.kit.style.anim;
    const A = IMAGING_ANIM;
    this.time += delta;
    this.arc += ((active ? A.arcActive : A.arcIdle) - this.arc) * Math.min(1, delta * A.arcEase);
    this.phase += delta * (active ? A.sweepActive : A.sweepIdle) * an.spin;
    const yaw = Math.sin(this.phase) * this.arc;
    this.head.rotation.y = this.jerkStep > 0 ? Math.round(yaw / this.jerkStep) * this.jerkStep : yaw;

    const glow = pulseWave(this.time, an.pulse) * (active ? 1 : A.idleGlow);
    this.lensGlow.setIntensity(glow);
    this.pulseGlow?.setIntensity(glow);
    const share = active ? 1 : A.glint.idleShare;
    this.glintClock = (this.glintClock + delta * A.glint.rate * share) % 1;
    this.glint.mesh.position.y = this.glintY0 + this.glintSpan * this.glintClock;
    this.glint.setIntensity(Math.sin(Math.PI * this.glintClock) * share);
    this.blink.update(delta, active);
    this.beacons?.setIntensity(active ? (this.blink.on ? 1 : 0) : A.idleBeacon);
  }
}
