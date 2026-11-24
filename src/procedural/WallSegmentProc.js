// Steel Men – procedural wall segment (roadmap 18, walls). Drop-in alternative to
// models/3DStructures{race}/MobileWallWall{race}.glb (one box ±16 long, 9 high, ≤ 5 thick), very cheap because many are built:
//   • modelled at the NOMINAL length WALL_SPAN (32 GLB units) and stretched along x by the structure (Walls.js sets
//     holder.scale.x, exactly like the GLB) – so the model works from 0.2 × to 1.4 × and, being static, is batched
//     (instanced) like every finished building. Details are few, wide and tolerant of the stretch; the ends sit inside the posts
//   • by style.silhouette (SEGMENT_SHAPES / SEGMENT_BUILDERS): rounded = sloped barrier with a round cap and hazard stripes,
//     angular = heavy sloped wall with buttresses, rust plates, crenellations and spikes, round = smooth elliptical tube with a
//     plasma conduit and team-coloured rails, faceted = NO physical wall: thin ground and top rails and four laser lines between the
//     posts (glowing paint, visible in every LOD) + a translucent energy sheet and line halos (glow layers, near LOD only)
//   • no emblem (it would be stretched with the segment): the faction mark stands on the posts
// Draw calls: 1 (3 for the barrier style, 2 for the tube style – glow layers). Triangles ≈ 130–260 per segment.
// Visual only: update() takes the frame delta, nothing here is read by the simulation. No allocations in update().
import { PartBuilder } from './ProcKit.js';
import { ProcModel, createSharedCache, GlowSet, marking, neonStrip, spike, pulseWave } from './ProcModules.js';
import { WALL_SPAN, WALL_LAYOUT, WALL_ANIM, WALL_TEAM, HALF_PI, nextWallInstance, pickBoxGeometry, addPickBox } from './MobileWallProc.js';

// Team paint (S.teamPaint / S.teamShade, see WALL_TEAM): long boxes / tubes along the whole nominal length, so they stretch
// with the segment (holder.scale.x) like the wall itself; they are vertices of the static geometry (batching unchanged).
const TEAM_DETAIL = { detail: WALL_TEAM.detail };

const DEG = Math.PI / 180;
const FACE_OUT = 0.02;       // markings / strips stand this far off the wall face

/** Segment shapes by style.silhouette (GLB units; the segment is ≤ 4.4 thick, 9 high; unknown → rounded) */
export const SEGMENT_SHAPES = {
  rounded: {
    footH: 0.8, footD: 4.4,
    body: { y0: 0.8, h: 7.2, d: 4.0, topD: 3.2 },
    cap: { r: 1.6, flat: 0.6, seg: 10 },
    team: { y: 2.0, h: 2.2, t: 0.12, len: 31 },   // wide team band on both faces (the round cap on top is team paint too)
    mark: { y: 4.8, h: 1.4, len: 30 },
    neon: { y: 7.2, h: 0.12, t: 0.06, len: 30 },
  },
  angular: {
    footH: 1.0, footD: 5.0,
    body: { y0: 1.0, h: 6.0, d: 4.4, topD: 2.8 },
    parapet: { h: 1.0, d: 3.0 },
    merlons: { count: 6, w: 2.4, h: 1.0, d: 2.4 },
    spike: { h: 0.8, r: 0.2 },
    buttress: { xs: [-10, 0, 10], w: 1.6, topW: 0.9, h: 5.2, d: 1.0, topD: 0.5, sink: 0.3 },
    rust: { y: 2.0, h: 1.6, len: 31.5, t: 0.1 },
    team: { y: 4.4, h: 1.6, len: 31, t: 0.1 },   // wide team band under the parapet (the parapet is team paint too)
  },
  round: {
    A: 2.2, B: 4.5, seg: 16,                                  // elliptical tube: half thickness A, half height B (sits on the ground)
    // degrees from the top; the rails sit at teamOut (inside the surface scale, they bulge out by their tube radius). The upper half is
    // NOT left light (style hull colours are light for this style): a team-shade rail at upperTeamPhis and a truly dark rail
    // (S.dark – hullDark is the style's secondary and comes out light) at darkPhis; the neon accent stays on the ridge conduit
    teamPhis: [90, 68, 112], teamTube: 1.0, teamOut: 0.9, outScale: 1.01,
    upperTeamPhis: [48], upperTeamTube: 1.0, darkPhis: [26], darkTube: 0.8,
    conduit: { r: 0.35, seg: 8, glowR: 0.8 },
  },
  faceted: {
    rail: { h: 0.8, d: 1.6 }, topRail: { h: 0.5, d: 1.6 },   // both rails are team paint (the posts hold the emitters)
    lineT: 0.16, sheet: { y: 5.0, h: 7.0, t: 0.1 }, halo: 0.45,
  },
};

const both = [-1, 1];

function buildRoundedSegment(b, glows, kit, P) {
  const S = kit.S;
  const bd = P.body;
  const faceHalf = (y) => bd.d / 2 + ((bd.topD - bd.d) / 2) * ((y - bd.y0) / bd.h);
  b.box(WALL_SPAN, P.footH, P.footD, S.hullDark, { base: true });
  b.taperedBox(WALL_SPAN, WALL_SPAN, bd.h, bd.d, S.hull, { y: bd.y0 }, bd.topD);
  b.cylinder(P.cap.r, P.cap.r, WALL_SPAN, P.cap.seg, S.teamShade, { rz: HALF_PI, sx: P.cap.flat, y: bd.y0 + bd.h, ...TEAM_DETAIL }, true);   // round top edge = team paint
  for (const e of both) {
    const turn = e > 0 ? 0 : Math.PI;
    b.box(P.team.len, P.team.h, P.team.t, S.teamPaint, { y: P.team.y, z: e * faceHalf(P.team.y), ...TEAM_DETAIL });
    marking(b, kit, P.mark.len, P.mark.h, { y: P.mark.y, z: e * (faceHalf(P.mark.y) + FACE_OUT), ry: turn });
    if (kit.style.neon >= WALL_LAYOUT.neonMin) neonStrip(b, kit, P.neon.len, P.neon.h, P.neon.t, { y: P.neon.y, z: e * (faceHalf(P.neon.y) + P.neon.t / 2) });
  }
}

function buildAngularSegment(b, glows, kit, P) {
  const S = kit.S;
  const bd = P.body;
  const faceHalf = (y) => bd.d / 2 + ((bd.topD - bd.d) / 2) * ((y - bd.y0) / bd.h);
  const topY = bd.y0 + bd.h;
  b.box(WALL_SPAN, P.footH, P.footD, S.hullDark, { base: true });
  b.taperedBox(WALL_SPAN, WALL_SPAN, bd.h, bd.d, S.hull, { y: bd.y0 }, bd.topD);
  b.box(WALL_SPAN, P.parapet.h, P.parapet.d, S.teamShade, { base: true, y: topY, ...TEAM_DETAIL });   // the parapet is team paint
  const M = P.merlons;
  const pitch = WALL_SPAN / M.count;
  const merlonY = topY + P.parapet.h;
  for (let i = 0; i < M.count; i++) {
    const x = -WALL_SPAN / 2 + pitch * (i + 0.5);
    b.box(M.w, M.h, M.d, S.hullDark, { base: true, x, y: merlonY });
    spike(b, kit, { x, y: merlonY + M.h, z: 0, h: P.spike.h, r: P.spike.r });
  }
  const U = P.buttress;
  for (const e of both) {
    b.box(P.rust.len, P.rust.h, P.rust.t, S.lower, { y: P.rust.y, z: e * (faceHalf(P.rust.y) + P.rust.t / 2) });
    b.box(P.team.len, P.team.h, P.team.t, S.teamPaint, { y: P.team.y, z: e * (faceHalf(P.team.y) + P.team.t / 2), ...TEAM_DETAIL });
    for (const x of U.xs) b.taperedBox(U.w, U.topW, U.h, U.d, S.hullDark, { x, y: bd.y0, z: e * (faceHalf(bd.y0) + U.d / 2 - U.sink) }, U.topD);
  }
}

function buildRoundSegment(b, glows, kit, P) {
  const S = kit.S;
  const vertical = P.B / P.A;                                   // sx scales the tube's height (its local x is world y after the turn)
  b.cylinder(P.A, P.A, WALL_SPAN, P.seg, S.hull, { rz: HALF_PI, sx: vertical, y: P.B }, true);
  // lines along the tube surface (angle phi from the top): team band on the equator, team shade and dark rails above it
  const along = (phi, tube, s, out = P.outScale, t = {}) => {
    const a = phi * DEG;
    b.cylinder(tube, tube, WALL_SPAN, 5, s, { rz: HALF_PI, y: P.B + P.B * Math.cos(a) * out, z: P.A * Math.sin(a) * out, ...t }, true);
  };
  for (const phi of P.teamPhis) for (const e of both) along(e * phi, P.teamTube, S.teamPaint, P.teamOut, TEAM_DETAIL);   // broad team band (three overlapping rails) around the equator
  for (const phi of P.upperTeamPhis) for (const e of both) along(e * phi, P.upperTeamTube, S.teamShade, P.teamOut, TEAM_DETAIL);   // darker team shade on the upper flank
  for (const phi of P.darkPhis) for (const e of both) along(e * phi, P.darkTube, S.dark, P.teamOut);                              // dark neutral rail beside the ridge conduit
  const c = P.conduit;                                           // plasma conduit on the ridge
  b.cylinder(c.r, c.r, WALL_SPAN, c.seg, S.plasma, { rz: HALF_PI, y: P.B * 2 }, true);
  glows.get('pulse').cylinder(c.glowR, c.glowR, WALL_SPAN, c.seg, { rz: HALF_PI, y: P.B * 2 });
}

function buildFacetedSegment(b, glows, kit, P) {
  const S = kit.S;
  const top = WALL_LAYOUT.segmentHeight;
  b.box(WALL_SPAN, P.rail.h, P.rail.d, S.teamPaint, { base: true, ...TEAM_DETAIL });
  b.box(WALL_SPAN, P.topRail.h, P.topRail.d, S.teamShade, { y: top - P.topRail.h / 2, ...TEAM_DETAIL });
  const sheet = glows.get('sheet');
  const halo = glows.get('halo');
  for (const y of WALL_LAYOUT.barrierYs) {
    b.box(WALL_SPAN, P.lineT, P.lineT, S.plasma, { y });   // emissive paint: the barrier stays visible in the far LODs
    halo.box(WALL_SPAN, P.halo, P.halo, { y });
  }
  sheet.box(WALL_SPAN, P.sheet.h, P.sheet.t, { y: P.sheet.y });
}

const SEGMENT_BUILDERS = { rounded: buildRoundedSegment, angular: buildAngularSegment, round: buildRoundSegment, faceted: buildFacetedSegment };

/** Shared record of the segment of one style: { static (LODs), glow } */
function buildShared(kit) {
  const key = Object.hasOwn(SEGMENT_BUILDERS, kit.style.silhouette) ? kit.style.silhouette : 'rounded';
  const b = new PartBuilder();
  const glows = new GlowSet();
  SEGMENT_BUILDERS[key](b, glows, kit, SEGMENT_SHAPES[key]);
  const sheet = SEGMENT_SHAPES.faceted.sheet;
  // the barrier is all thin lines: an invisible box over its full height makes it clickable
  return { static: b.buildLods(), glow: glows.build(), pick: key === 'faceted' ? pickBoxGeometry(sheet.y, sheet.h) : null };
}

const SEGMENT_CACHE = createSharedCache(buildShared);

export class WallSegmentProc extends ProcModel {
  /**
   * @param {object} [opts]
   * @param {string} [opts.race]       race key of data/buildingStyles.json (unknown → first style)
   * @param {THREE.ColorRepresentation} [opts.teamColor]
   */
  constructor({ race, teamColor } = {}) {
    super({ race, teamColor, cache: SEGMENT_CACHE, name: 'WallSegmentProc' });
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
    const seq = nextWallInstance();
    this.staticMesh(sh.static);
    if (sh.pick) addPickBox(this, sh.pick);
    const layer = (name, opacity) => (sh.glow[name] ? this.glowLayer(sh.glow[name], gc.pulse, { opacity }) : null);
    this.sheetGlow = layer('sheet', WALL_ANIM.sheetOpacity);
    this.haloGlow = layer('halo', WALL_ANIM.haloOpacity);
    this.pulseGlow = layer('pulse', WALL_ANIM.haloOpacity);
    this.time = seq * WALL_ANIM.phaseStep;
    this.pulseHz = an.pulse;
    this.animated = Boolean(this.sheetGlow || this.haloGlow || this.pulseGlow);   // the other styles are fully static
  }

  /** Per-frame animation (numbers only, no allocations); `active` is unused */
  update(delta) {
    if (!this.shared || !this.animated) return;
    this.time += delta;
    const glow = pulseWave(this.time, this.pulseHz);
    this.sheetGlow?.setIntensity(glow);
    this.haloGlow?.setIntensity(glow);
    this.pulseGlow?.setIntensity(glow);
  }
}
