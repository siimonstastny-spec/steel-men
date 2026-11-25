// Steel Men – model factories and helpers of the unit / robot / part icons (B2-1, docs/notes/b2-icons-core.md).
// Used only by src/ui/IconRenderer.js. Everything is visual; nothing here touches the simulation.
//   unitProcId('gunTank')                    → registered procedural unit id or '' (no procedural model / stats not loaded yet)
//   partProcId('legs', '3DParts/LegsBasic…') → registered robot part id or ''
//   createUnitIconModel / createRobotIconModel / createPartIconModel → ProcUnit in its rest pose (caller disposes)
//   iconBounds(model, box)                   → box of the pose that is really drawn (single-part icons hide bones)
//   drawCrewIcon(ctx, size, race, color)     → crew squad emblem drawn with the 2D canvas (crew has no procedural model)
import { createProceduralUnit, hasProceduralUnit } from './units/UnitKit.js';
import './units/index.js';   // registers every procedural unit
import { ProcRobot, ProcRobotPart, robotPartIds } from './robots/RobotParts.js';
import { emblemPathData } from './ProcModules.js';
import { getStats, partStats, isDataOnlyPart, SLOT_KIND } from '../data/Stats.js';
import { ICON_RENDERER, setFromPath } from '../config.js';
import { procPartId as mappedPartId } from './robots/RobotPartMap.js';   // [B6] set → proc id table

const TAU = Math.PI * 2;
const I = ICON_RENDERER;

// ---------------------------------------------------------------- id resolution (cached: UI asks on every redraw)

const unitIdCache = new Map();                                  // stats / model id → procedural unit id ('' = none)
const partIdCache = { legs: new Map(), torso: new Map(), leftArm: new Map(), rightArm: new Map() };
let kindIds = null;                                             // { legs: Set, torso: Set, arm: Set } of registered part ids

/** Procedural unit id behind a unit id (a registered id itself, or stats.json vehicles[id].procModel); '' = none */
export function unitProcId(id) {
  if (typeof id !== 'string' || !id) return '';
  let r = unitIdCache.get(id);
  if (r !== undefined) return r;
  if (hasProceduralUnit(id)) r = id;
  else {
    let proc;
    try { proc = getStats().vehicles?.[id]?.procModel; } catch { return ''; }   // stats not loaded yet: ask again later
    r = proc && hasProceduralUnit(proc) ? proc : '';
  }
  unitIdCache.set(id, r);
  return r;
}

/** Procedural robot part id behind a part model (registered id itself, or parts[set][kind].procModel by model path); '' = none */
export function partProcId(slot, model) {
  const cache = partIdCache[slot];
  if (!cache || typeof model !== 'string' || !model) return '';
  let r = cache.get(model);
  if (r !== undefined) return r;
  if (!kindIds) {
    const ids = robotPartIds();
    kindIds = { legs: new Set(ids.legs), torso: new Set(ids.torso), arm: new Set(ids.arm) };
  }
  const known = kindIds[SLOT_KIND[slot]];
  if (known.has(model)) r = model;
  else {
    let proc;
    try { proc = mappedPartId(setFromPath(model), SLOT_KIND[slot], partStats(model, slot)); } catch { return ''; }   // stats not loaded yet: ask again later
    r = proc && known.has(proc) ? proc : '';
  }
  cache.set(model, r);
  return r;
}

/** [B6] true when the part's own stats.json entry names its procedural model (not just the RobotPartMap fallback); registered id itself = true */
export function partHasOwnProc(slot, model) {
  if (typeof model !== 'string' || !model || !SLOT_KIND[slot]) return false;
  if (!partProcId(slot, model)) return false;
  if (!kindIds[SLOT_KIND[slot]].has(model)) {
    try { return !!partStats(model, slot).procModel; } catch { return false; }
  }
  return true;
}

const standInCache = { legs: new Map(), torso: new Map(), leftArm: new Map(), rightArm: new Map() };

/** [B3] true when the part model (path) belongs to a data-only set (stats.json parts[set][kind].standInSet / [A15] standInModel); registered ids = false */
export function partHasStandIn(slot, model) {
  const cache = standInCache[slot];
  if (!cache || typeof model !== 'string' || !model) return false;
  let r = cache.get(model);
  if (r !== undefined) return r;
  if (!kindIds) partProcId(slot, model);   // fills kindIds
  if (kindIds?.[SLOT_KIND[slot]].has(model)) r = false;
  else {
    try { r = isDataOnlyPart(partStats(model, slot)); } catch { return false; }   // stats not loaded yet: ask again later
  }
  cache.set(model, r);
  return r;
}

// ---------------------------------------------------------------- models

/** Procedural vehicle / aircraft in its rest pose (null = unknown id) */
export function createUnitIconModel(procId, race, teamColor) {
  const m = createProceduralUnit(procId, race, teamColor);
  m?.tick(0);
  return m;
}

/** Whole robot from part ids { legs, torso, leftArm, rightArm } ('' = no arm) */
export function createRobotIconModel(combo, race, teamColor) {
  const m = new ProcRobot({ race, teamColor, ...combo });
  m.tick(0);
  return m;
}

/**
 * One part: arm = ProcRobotPart; legs = robot without torso (its bone hides torso + arms); torso = robot whose pelvis
 * children other than the torso (the leg chains) are collapsed, arms are not built.
 */
export function createPartIconModel(slot, partId, race, teamColor) {
  if (slot === 'leftArm' || slot === 'rightArm') {
    const a = new ProcRobotPart({ race, teamColor, slot, partId });
    return a;
  }
  const m = new ProcRobot({ race, teamColor, [slot]: partId, leftArm: '', rightArm: '' });
  m.tick(0);
  const s = I.hiddenBoneScale;
  if (slot === 'legs') {
    m.setPartVisible('torso', false);
  } else {
    const torso = m.getSlotBone('torso');
    const pelvis = m.getBone('pelvis');
    if (pelvis) for (const c of pelvis.children) if (c !== torso && c.isBone) c.scale.setScalar(s);
    // bones hanging on the 'legs' wrapper next to the pelvis (none today: every leg mesh is on pelvis / thigh / shin / foot)
    const legsBone = m.getSlotBone('legs');
    if (legsBone) for (const c of legsBone.children) if (c !== pelvis && c.isBone) c.scale.setScalar(s);
  }
  m.updateMatrixWorld(true);
  return m;
}

/** Bounds of the drawn pose in world space (skinned: bones moved / hidden after the build are honoured) */
export function iconBounds(model, box) {
  const mesh = model.paintMesh;
  if (mesh?.isSkinnedMesh && typeof mesh.computeBoundingBox === 'function') {
    model.updateWorldMatrix(true, true);
    model.skeleton.update();
    mesh.computeBoundingBox();
    return box.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld);
  }
  return box.makeEmpty().expandByObject(model);
}

// ---------------------------------------------------------------- crew emblem (2D canvas)

/** Crew squad icon: team-coloured ring, helmeted bust, race emblem on the chest (emblem skipped while styles are loading) */
export function drawCrewIcon(ctx, size, race, teamColor) {
  const C = I.crew;
  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.scale(size / 100, size / 100);
  ctx.beginPath();
  ctx.arc(50, 50, C.discRadius, 0, TAU);
  ctx.fillStyle = C.background;
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.fillStyle = C.silhouette;
  const sh = C.shoulders;
  ctx.beginPath();
  ctx.moveTo(sh.left, sh.bottom);
  ctx.quadraticCurveTo(sh.left, sh.top, 50, sh.neckY);
  ctx.quadraticCurveTo(sh.right, sh.top, sh.right, sh.bottom);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.arc(C.head.x, C.head.y, C.head.r, 0, TAU);
  ctx.fill();
  ctx.fillStyle = C.visor;
  ctx.fillRect(C.visorBox.x, C.visorBox.y, C.visorBox.w, C.visorBox.h);
  let path = null;
  try { path = emblemPathData(race); } catch { path = null; }
  if (path) {
    const e = C.emblem;
    ctx.translate(e.x, e.y);
    ctx.scale(e.size / 100, e.size / 100);
    ctx.fillStyle = teamColor;
    ctx.fill(new Path2D(path), 'evenodd');
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(50, 50, C.discRadius, 0, TAU);
  ctx.lineWidth = C.ringWidth;
  ctx.strokeStyle = teamColor;
  ctx.stroke();
  ctx.restore();
}
