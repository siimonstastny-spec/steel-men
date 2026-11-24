// Steel Men – procedural robot arms (experiment): basic fist. Rig = the GLB RobotPartsBasic hand arm: 'shoulder{L,R}'
// (on the 'armL' / 'armR' wrapper at socket_ArmLeft / socket_ArmRight) → 'elbow{L,R}' → 'fist{L,R}'. The arm is built
// for its side (sign −1 = left = −x), so no negative scale is needed. Robot faces +Z. Construction time only.
// Arm contract: build(ub, kit, ctx { bone, side, sfx, slot }) → { rig: { shoulder, elbow, fist, attack, fire } }.
// Weapon arms add their muzzles as `socket_Launch_<sfx><n>` (unique per robot, matches MUZZLE.socketPatterns).
import { registerRobotPart, gltfNode, block, limbBetween, joint, plate, lightLine } from './RobotKit.js';

const HALF_PI = Math.PI / 2;
const LINE_OUT = 0.05;

/**
 * Arm dimensions (raw GLB units, x for the RIGHT arm = +x side; mirrored for the left). Basic follows
 * RobotPartsBasic/*BasicHandArmX_Skel.glb: elbow 4.9 below the socket, fist 5.7 below the elbow, ~13.7 long.
 */
export const ARM_SHAPES = {
  fist: {
    elbow: [0.85, -4.9, -0.1], fist: [0, -5.7, 0.1],
    pad: { w: 3.8, h: 3.2, d: 4.6, x: 0.5, y: 0.6, z: 0.3, trimY: -1.0 },   // shoulder pad (team colour)
    fin: { w: 0.35, h: 1.4, d: 3.0, x: 0.9, y: 2.5 },                        // pad fin (faceted / angular only)
    shoulderJoint: { r: 1.2, len: 1.8, x: -0.4 },
    upper: { w: 1.9, d: 2.1, top: 0.4, bottom: 0.3, taper: 0.9 },
    elbowJoint: { r: 1.0, len: 2.0 },
    fore: { w: 2.4, d: 2.6, top: 0.4, bottom: 0.2, taper: 1.2 },
    blade: { w: 3.6, h: 2.2, th: 0.35, x: 1.35, y: -2.8, z: 0.3 },           // armour blade on the outer side
    foreLine: { len: 3.0, y: -2.8 },
    hand: { w: 2.4, h: 2.4, d: 2.6, y: -1.4, z: 0.5 },
    knuckles: { w: 2.5, h: 0.7, d: 0.8, y: -2.2, z: 1.6 },
    thumb: { w: 0.6, h: 1.4, d: 0.9, x: -1.3, y: -1.1, z: 1.0 },
    laser: { w: 2.2, t: 0.18, y: -2.2, z: 2.05 },                            // knuckle laser edge (lens: flares on a punch)
    sfx: [0, -2.5, 0.9],                                                     // socket_SFX_1_<L|R> (GLB: socket_SFX_1)
  },
};

registerRobotPart('arm', 'fist', {
  label: 'Basic fist',
  build(ub, kit, ctx) {
    const D = ARM_SHAPES.fist;
    const S = kit.S;
    const sg = ctx.side;
    const m = ([x, y, z]) => [x * sg, y, z];
    const shoulder = gltfNode(ctx, `shoulder${ctx.sfx}`);
    const elbow = gltfNode(ctx, `elbow${ctx.sfx}`);
    const fist = gltfNode(ctx, `fist${ctx.sfx}`);
    ub.bone(shoulder, ctx.bone);
    ub.bone(elbow, shoulder, m(D.elbow));
    ub.bone(fist, elbow, D.fist);

    // shoulder: inner joint, big pad in the team colour with a light trim (and a fin on sharp styles)
    const sb = ub.paint(shoulder);
    joint(sb, kit, D.shoulderJoint.r, D.shoulderJoint.len, S.frame, { x: sg * D.shoulderJoint.x });
    const P = D.pad;
    block(sb, kit, P.w, P.h, P.d, S.teamPaint, { x: sg * P.x, y: P.y, z: P.z });
    lightLine(sb, kit, P.d, 'z', { x: sg * (P.x + P.w / 2), y: P.y + P.trimY, z: P.z });
    const style = kit.style.silhouette;
    if (style === 'faceted' || style === 'angular') {
      plate(sb, kit, D.fin.d, D.fin.h, D.fin.w, S.hullDark, { x: sg * D.fin.x, y: D.fin.y, z: P.z, ry: HALF_PI });
    }
    const U = D.upper;
    limbBetween(sb, kit, [0, 0, 0], m(D.elbow), U.w, U.d, S.hull, { top: U.top, bottom: U.bottom, taper: U.taper });

    // elbow + forearm with an armour blade and a light line
    const eb = ub.paint(elbow);
    joint(eb, kit, D.elbowJoint.r, D.elbowJoint.len, S.frame, {});
    const F = D.fore;
    limbBetween(eb, kit, [0, 0, 0], D.fist, F.w, F.d, S.hull, { top: F.top, bottom: F.bottom, taper: F.taper });
    const B = D.blade;
    plate(eb, kit, B.w, B.h, B.th, S.hullDark, { x: sg * B.x, y: B.y, z: B.z, ry: HALF_PI });
    lightLine(eb, kit, D.foreLine.len, 'y', { y: D.foreLine.y, z: F.d / 2 * F.taper + LINE_OUT });

    // fist: hand block, knuckle bar, thumb, laser edge on the knuckles (lens bone, flares on the punch)
    const fb = ub.paint(fist);
    const H = D.hand;
    block(fb, kit, H.w, H.h, H.d, S.hullDark, { y: H.y, z: H.z });
    const K = D.knuckles;
    fb.box(K.w, K.h, K.d, S.frame, { y: K.y, z: K.z });
    const T = D.thumb;
    fb.box(T.w, T.h, T.d, S.frame, { x: -sg * T.x, y: T.y, z: T.z, detail: 0 });
    const L = D.laser;
    const lens = ub.bone(`knuckle${ctx.sfx}`, fist, [0, L.y, L.z]);
    ub.glow(lens).box(L.w, L.t, L.t, kit.glowColors.laser);
    const li = ub.meta.lenses.push({ bone: lens }) - 1;
    const fire = `punch_${ctx.sfx}`;
    ub.onFire(fire, { lenses: [li] });
    ub.socket(`${ctx.sockets.sfx}_${ctx.sfx}`, fist, D.sfx);   // socket_SFX_1_L / _R: unique per robot (ProcUnit sockets are keyed by name)
    return { rig: { shoulder, elbow, fist, attack: 'punch', fire } };
  },
});
