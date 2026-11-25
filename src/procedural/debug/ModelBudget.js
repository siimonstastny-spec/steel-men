// Steel Men – [B4] model budget tool: triangles and draw calls of every model the game can draw (procedural and GLB), per LOD.
// Console only, never imported by the game:
//   const B = await import('./src/procedural/debug/ModelBudget.js');
//   const r = await B.runModelBudget();               // everything (a few seconds); { kinds: ['vehicle'], styles: ['X'] } narrows it
//   copy(B.toMarkdown(r));                            // table for docs/notes/b4-budget.md   (B.toTsv(r) for a spreadsheet)
//   r.overLimit                                       // rows over a PROC_BUDGET limit (proc models only)
// Models are built like the game builds them (never added to a scene, never batched), measured and disposed at once (shared
// geometry caches are ref-counted by the kits). The GLB models are read from the AssetLoader cache (not cloned, nothing to dispose).
// Reads data only; touches neither the simulation nor `world`. Details: docs/notes/b4-budget-tool.md.
import { loadStats, getStats, unitStats, crewStats, raceKeys, withModelRaceParts, modelRaceOf, SLOT_KIND } from '../../data/Stats.js';
import { loadGltf } from '../../core/AssetLoader.js';
import { PROC_BUDGET, PROC_ROBOTS, PROC_CREW, BUILDING_LOD } from '../../config.js';
import { loadBuildingStyles, styleKeys, getBuildingStyle } from '../BuildingStyle.js';
import { triangleCount } from '../ProcKit.js';
import { proceduralIds, proceduralEnabled, createProceduralStructure, hasProceduralModel } from '../registry.js';
import { createProceduralUnit, hasProceduralUnit } from '../units/UnitKit.js';
import '../units/index.js';
import { ProcRobot, robotPartIds, ROBOT_KIT } from '../robots/RobotParts.js';
import { procPartId } from '../robots/RobotPartMap.js';
import { ProcCrewMember } from '../crew/ProcCrew.js';

/** Kinds of rows; GLB kinds start with `glb` */
export const BUDGET_KINDS = ['building', 'vehicle', 'robot', 'crew', 'glbBuilding', 'glbVehicle', 'glbRobotPart', 'glbRobot', 'glbCrew'];

const ARM_SLOTS = ['leftArm', 'rightArm'];
const ROBOT_SLOTS = ['legs', 'torso', 'leftArm', 'rightArm'];
const YES = 'ano';
const NO = 'ne';
const HIDDEN = 'skryté';
const PROC_DRAWS = 'ne (kreslí proc)';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const nameOf = (path) => path.split('/').pop().replace(/\.glb$/i, '');
const procOn = () => globalThis.window?.steelMen?.procedural !== false;   // PROC_* flags are honoured together with this switch

// ---------------------------------------------------------------- measuring helpers

/** Triangles + draw calls of a GLB scene: visible meshes × material groups (one material = 1) */
function glbMeasure(root) {
  let triangles = 0;
  let drawCalls = 0;
  let meshes = 0;
  root.traverse((o) => {
    if (!o.isMesh || !o.visible || !o.geometry?.attributes?.position) return;
    meshes++;
    triangles += triangleCount(o.geometry);
    const m = o.material;
    if (Array.isArray(m)) {
      const used = new Set(o.geometry.groups.map((g) => g.materialIndex));
      drawCalls += used.size || m.length;
    } else drawCalls++;
  });
  return { triangles, drawCalls, meshes };
}

const glbCache = new Map();   // path -> Promise<{ triangles, drawCalls, meshes }>
function glbStats(path) {
  if (!glbCache.has(path)) {
    glbCache.set(path, loadGltf(path).then((g) => glbMeasure(g.scene)).catch((e) => { glbCache.delete(path); throw e; }));
  }
  return glbCache.get(path);
}
const sumStats = (list) => list.reduce((a, s) => ({ triangles: a.triangles + s.triangles, drawCalls: a.drawCalls + s.drawCalls, meshes: a.meshes + s.meshes }), { triangles: 0, drawCalls: 0, meshes: 0 });

/** Far LOD `level` of a ProcUnit: one instanced draw call per far group that has a geometry at that level */
function farStats(model, level) {
  let triangles = 0;
  let drawCalls = 0;
  for (const f of model.shared?.far ?? []) {
    const g = f.lods[level];
    if (!g) continue;
    triangles += triangleCount(g);
    drawCalls++;
  }
  return { triangles, drawCalls };
}

/** Row factory; `limit` = { value, count } (count false = informative) */
function makeRow(base, tri, drawCalls, limit = null, note = '') {
  const over = !!limit && limit.value != null && limit.value > 0 && limit.metric > limit.value;
  return {
    ...base, tri: Math.round(tri), drawCalls, over: over && limit.count, info: over && !limit.count, note,
  };
}

const lim = (metric, value, count = true) => ({ metric, value, count });

// ---------------------------------------------------------------- procedural units (vehicles, robots, crew share the ProcUnit LODs)

// LOD0 + far LODs of a built ProcUnit (rows share `base`); `limitTri` applies to LOD0
function unitRows(model, base, limitTri, rows, note = '') {
  const s = model.stats();
  rows.push(makeRow({ ...base, lod: 'LOD0' }, s.triangles, s.drawCalls, lim(s.triangles, limitTri), `${note}${note ? '; ' : ''}skinned, ${model.bones?.length ?? 0} bones`.trim()));
  for (const l of PROC_BUDGET.lodLevels) {
    const f = farStats(model, l);
    if (f.drawCalls) rows.push(makeRow({ ...base, lod: `LOD${l}` }, f.triangles, f.drawCalls, null, 'instanced'));
  }
}

function measureVehicles(styles, rows, res) {
  const byProc = new Map();   // procModel -> [vehicle ids]
  for (const [id, v] of Object.entries(getStats().vehicles ?? {})) {
    if (!v.procModel) continue;
    if (!byProc.has(v.procModel)) byProc.set(v.procModel, []);
    byProc.get(v.procModel).push(id);
  }
  return { byProc, jobs: [...byProc].flatMap(([proc, ids]) => styles.map((style) => () => {
    const inGame = proceduralEnabled() && hasProceduralUnit(proc) ? YES : NO;
    const model = createProceduralUnit(proc, style, PROC_BUDGET.teamColor);
    if (!model) { res.errors.push(`vehicle ${proc}/${style}: no procedural model`); return; }
    try {
      unitRows(model, { kind: 'vehicle', id: proc, style, source: 'proc', inGame }, PROC_BUDGET.unitTri, rows, ids.join(','));
    } finally { model.dispose(); }
  })) };
}

function measureCrew(styles, rows, res) {
  return styles.map((style) => () => {
    const inGame = PROC_CREW.enabled && procOn() && PROC_CREW.races.includes(style) ? YES : NO;
    const model = new ProcCrewMember({ race: style, teamColor: PROC_BUDGET.teamColor, index: 0 });
    try {
      const sil = getBuildingStyle(style).silhouette ?? '';
      unitRows(model, { kind: 'crew', id: 'crewMember', style, source: 'proc', inGame }, PROC_BUDGET.crewTri, rows, `silhouette ${sil}`);
    } finally { model.dispose(); }
  });
}

// ---------------------------------------------------------------- robots

function robotJob(style, rows, res) {
  const ids = robotPartIds();
  const D = ROBOT_KIT.defaults;
  const inGame = PROC_ROBOTS.enabled && procOn() && PROC_ROBOTS.races.includes(style) ? YES : NO;
  const build = (combo) => new ProcRobot({ race: style, teamColor: PROC_BUDGET.teamColor, ...combo });
  const lod0Tri = (combo) => {
    const r = build(combo);
    try { return r.stats().triangles; } finally { r.dispose(); }
  };
  return () => {
    // 1. each part alone on a base robot (default legs + torso, no arms): triangle delta of the part
    const base = { legs: D.legs, torso: D.torso, leftArm: '', rightArm: '' };
    const t0 = lod0Tri(base);
    const delta = { legs: [], torso: [], leftArm: [], rightArm: [] };
    for (const slot of ROBOT_SLOTS) {
      for (const id of ids[SLOT_KIND[slot]]) {
        try {
          const d = lod0Tri({ ...base, [slot]: id }) - t0;
          delta[slot].push({ id, d });
          res.robotParts.push({ style, slot, id, tri: t0 + d, delta: d });
        } catch (err) { res.errors.push(`robot part ${style}/${slot}/${id}: ${err.message}`); }
      }
    }
    // 2. heaviest combination: per slot the part with the largest delta (arm: '' = none when no arm adds triangles)
    const best = (list, optional) => {
      const top = list.reduce((a, b) => (b.d > a.d ? b : a), { id: optional ? '' : list[0]?.id, d: optional ? 0 : -Infinity });
      return top.id;
    };
    const heavy = {
      legs: best(delta.legs, false), torso: best(delta.torso, false), leftArm: best(delta.leftArm, true), rightArm: best(delta.rightArm, true),
    };
    const model = build(heavy);
    try {
      const id = ROBOT_SLOTS.map((s) => heavy[s] || '-').join(' + ');
      unitRows(model, { kind: 'robot', id, style, source: 'proc', inGame }, PROC_BUDGET.robotTri, rows, 'heaviest combination (legs + torso + left + right arm)');
    } finally { model.dispose(); }
    // 3. combinations over the limit (additive estimate from the deltas; the heaviest one above is measured for real)
    const limit = PROC_BUDGET.robotTri;
    const arms = (list) => [0, ...list.map((e) => e.d)];
    const L = arms(delta.leftArm);
    const R = arms(delta.rightArm);
    let total = 0;
    let over = 0;
    for (const a of delta.legs) {
      for (const b of delta.torso) {
        const rest = limit - t0 - a.d - b.d;
        for (const l of L) for (const r of R) { total++; if (l + r > rest) over++; }
      }
    }
    res.robotCombos.push({ style, total, over, share: total ? over / total : 0, limit });
  };
}

// ---------------------------------------------------------------- buildings

function buildingRows(model, base, rows) {
  const s0 = model.stats();
  const animated = model.paintMeshes.length - 1;
  rows.push(makeRow({ ...base, lod: 'LOD0' }, s0.triangles, s0.drawCalls, lim(s0.triangles, PROC_BUDGET.buildingTri, false),
    `${model.glowLayers.length} glow, ${Math.max(0, animated)} animated paint meshes, ${model.emblemMeshes.length} emblem`));
  const lods = model.staticLods;
  if (!lods) {
    for (const l of PROC_BUDGET.lodLevels) rows.push(makeRow({ ...base, lod: `LOD${l}` }, s0.triangles, s0.drawCalls, lim(s0.drawCalls, PROC_BUDGET.buildingDrawCalls), 'no staticMesh(): not batched, every mesh at every LOD'));
    return;
  }
  for (let l = 1; l < lods.length; l++) {
    const g = lods[l];
    if (!g) continue;
    let tri = triangleCount(g);
    let dc = 1;   // instanced static body
    const parts = ['body'];
    if (l <= BUILDING_LOD.emblemMaxLod) {
      for (const src of model.emblemSources) if (src.parent === model) { tri += triangleCount(src.geometry); dc++; parts.push('emblem'); }
    }
    for (const m of model.farMeshes) { tri += triangleCount(m.geometry); dc++; parts.push('far'); }
    rows.push(makeRow({ ...base, lod: `LOD${l}` }, tri, dc, lim(dc, PROC_BUDGET.buildingDrawCalls), `instanced: ${parts.join(' + ')}`));
  }
}

function buildingJobs(styles, rows, res) {
  return proceduralIds().flatMap((id) => styles.map((style) => () => {
    const inGame = proceduralEnabled() && hasProceduralModel(id) ? YES : NO;
    const model = createProceduralStructure(id, style, PROC_BUDGET.teamColor);
    if (!model) { res.errors.push(`building ${id}/${style}: no procedural model`); return; }
    try {
      buildingRows(model, { kind: 'building', id, style, source: 'proc', inGame }, rows);
    } finally { model.dispose(); }
  }));
}

// ---------------------------------------------------------------- GLB

const safe = (res, what, fn) => async () => { try { await fn(); } catch (err) { res.errors.push(`${what}: ${err.message}`); } };

/** GLB rows of structures / vehicles / crew: one row per distinct model path (several ids and styles often share one) */
function glbGroupJobs(kind, entries, rows, res, limit, drawsInGame) {
  // entries: [{ key (dedupe), id, style, paths: [path…], procDraws }]
  const groups = new Map();
  for (const e of entries) {
    const g = groups.get(e.key) ?? { ...e, ids: new Set(), styles: new Set(), allProc: true };
    g.ids.add(e.id);
    g.styles.add(e.style);
    g.allProc &&= e.procDraws;
    groups.set(e.key, g);
  }
  return [...groups.values()].map((g) => safe(res, `${kind} ${g.key}`, async () => {
    const s = sumStats(await Promise.all(g.paths.map(glbStats)));
    rows.push(makeRow({
      kind, id: g.paths.map(nameOf).join(' + '), style: [...g.styles].join(','), source: 'GLB', lod: 'LOD0', inGame: drawsInGame(g),
    }, s.triangles, s.drawCalls, limit ? lim(s.triangles, limit, false) : null, `${s.meshes} meshes; ids ${[...g.ids].join(',')}`));
  }));
}

function glbBuildingJobs(styles, rows, res) {
  const entries = [];
  for (const [id] of Object.entries(getStats().structures ?? {})) {
    for (const style of styles) {
      try {
        const st = unitStats('structures', id, style);
        if (st.model) entries.push({ key: st.model, id, style, paths: [st.model], procDraws: proceduralEnabled() && hasProceduralModel(id) });
      } catch (err) { res.errors.push(`glb building ${id}/${style}: ${err.message}`); }
    }
  }
  return glbGroupJobs('building', entries, rows, res, PROC_BUDGET.buildingTri, (g) => (g.allProc ? PROC_DRAWS : YES));
}

function glbVehicleJobs(styles, rows, res) {
  const entries = [];
  for (const [id, v] of Object.entries(getStats().vehicles ?? {})) {
    for (const style of styles) {
      try {
        const st = unitStats('vehicles', id, style);
        if (!st.model) continue;
        const paths = [st.model];
        const turrets = st.turret?.models;
        if (turrets) {
          const t = turrets[style] ?? turrets[modelRaceOf(style)] ?? Object.values(turrets)[0];
          if (t) paths.push(t);
        }
        entries.push({ key: paths.join('+'), id, style, paths, procDraws: !!v.procModel && proceduralEnabled() && hasProceduralUnit(v.procModel) });
      } catch (err) { res.errors.push(`glb vehicle ${id}/${style}: ${err.message}`); }
    }
  }
  return glbGroupJobs('vehicle', entries, rows, res, PROC_BUDGET.unitTri, (g) => (g.allProc ? PROC_DRAWS : YES));
}

function glbCrewJobs(styles, rows, res) {
  const entries = [];
  for (const style of styles) {
    try {
      const st = crewStats(style);
      if (st.model) entries.push({ key: st.model, id: 'crewMember', style, paths: [st.model], procDraws: PROC_CREW.enabled && procOn() && PROC_CREW.races.includes(style) });
    } catch (err) { res.errors.push(`glb crew ${style}: ${err.message}`); }
  }
  return glbGroupJobs('crew', entries, rows, res, PROC_BUDGET.crewTri, (g) => (g.allProc ? PROC_DRAWS : YES));
}

// robot parts: catalog parts.json { legs|torso|leftArm|rightArm: [{ path, set, race }] }, with stand-in model races added
async function loadCatalog() {
  const catalog = await fetch('./parts.json').then((r) => r.json());
  return withModelRaceParts(catalog);
}

// the part is hidden by a procedural robot when a proc race owns it and the part has a procedural id
function partHidden(p, slot) {
  if (!(PROC_ROBOTS.enabled && procOn())) return false;
  if (!procPartId(p.set, SLOT_KIND[slot], null)) return false;
  return PROC_ROBOTS.races.some((r) => p.race === r || p.race === null || p.race === modelRaceOf(r));
}
const partVisibleElsewhere = (p, styles) => styles.some((r) => !(PROC_ROBOTS.enabled && procOn() && PROC_ROBOTS.races.includes(r)) && (p.race === r || p.race === null || p.race === modelRaceOf(r)));

function glbRobotJobs(styles, rows, res, wantParts, wantRobots) {
  const jobs = [];
  const state = { catalog: null, stats: new Map() };
  const load = safe(res, 'parts.json', async () => {
    state.catalog = await loadCatalog();
    const paths = new Set();
    for (const slot of ROBOT_SLOTS) for (const p of state.catalog[slot] ?? []) paths.add(p.path);
    const list = [...paths];
    for (let i = 0; i < list.length; i += PROC_BUDGET.yieldEvery) {
      await Promise.all(list.slice(i, i + PROC_BUDGET.yieldEvery).map(async (path) => {
        try { state.stats.set(path, await glbStats(path)); } catch (err) { res.errors.push(`glb part ${path}: ${err.message}`); }
      }));
    }
  });
  const emit = safe(res, 'glb robots', async () => {
    const c = state.catalog;
    if (!c) return;
    const statOf = (p) => state.stats.get(p.path);
    if (wantParts) {
      for (const slot of ROBOT_SLOTS) {
        for (const p of c[slot] ?? []) {
          const s = statOf(p);
          if (!s) continue;
          const hidden = partHidden(p, slot);
          const inGame = hidden ? (partVisibleElsewhere(p, styles) ? 'částečně' : HIDDEN) : (p.set === 'Alien' ? NO : YES);
          rows.push(makeRow({ kind: 'robotPart', id: nameOf(p.path), style: p.race ?? '-', source: 'GLB', lod: 'LOD0', inGame }, s.triangles, s.drawCalls, null, `${slot}, set ${p.set}${p.set === 'Alien' ? ' (Alien)' : ''}`));
        }
      }
    }
    if (wantRobots) {
      // heaviest GLB robot per race: per slot the part with most triangles (additive – one GLB part = one set of meshes)
      const groups = [...styles.map((r) => ({ label: r, fits: (p) => p.set !== 'Alien' && (p.race === r || p.race === null) })), { label: 'Alien', fits: (p) => p.set === 'Alien' }];
      for (const g of groups) {
        const pick = {};
        for (const slot of ROBOT_SLOTS) {
          let top = null;
          for (const p of c[slot] ?? []) { const s = statOf(p); if (s && g.fits(p) && (!top || s.triangles > top.s.triangles)) top = { p, s }; }
          pick[slot] = top;
        }
        const parts = ROBOT_SLOTS.map((slot) => pick[slot]).filter(Boolean);
        if (!parts.length) continue;
        const total = sumStats(parts.map((t) => t.s));
        const procRace = PROC_ROBOTS.enabled && procOn() && PROC_ROBOTS.races.includes(g.label);
        rows.push(makeRow({
          kind: 'robot', id: ROBOT_SLOTS.map((slot) => (pick[slot] ? pick[slot].p.set : '-')).join(' + '), style: g.label, source: 'GLB', lod: 'LOD0',
          inGame: g.label === 'Alien' ? NO : (procRace ? HIDDEN : YES),
        }, total.triangles, total.drawCalls, lim(total.triangles, PROC_BUDGET.robotTri, false), `heaviest set (legs + torso + left + right arm), ${total.meshes} meshes`));
      }
    }
  });
  jobs.push(load, emit);
  return jobs;
}

// ---------------------------------------------------------------- run

/**
 * Measures the models. Returns { rows, overLimit, robotCombos, robotParts, errors, summary, limits }.
 * @param {object} [o] { kinds = BUDGET_KINDS (any subset), styles = PROC_BUDGET.styles (null = every style that is a race), print = console.log (null = silent) }
 * rows: { kind, id, style, source 'proc'|'GLB', lod, tri, drawCalls, over, info, inGame, note }
 */
export async function runModelBudget({ kinds = BUDGET_KINDS, styles, print = console.log } = {}) {
  await Promise.all([loadStats(), loadBuildingStyles()]);
  const log = typeof print === 'function' ? print : () => {};   // null / false = silent
  const all = styleKeys();
  const races = raceKeys();
  const use = styles ?? PROC_BUDGET.styles ?? (all.filter((k) => races.includes(k)).length ? all.filter((k) => races.includes(k)) : all);
  const want = (k) => kinds.includes(k);
  const rows = [];
  const res = { rows, overLimit: [], robotCombos: [], robotParts: [], errors: [], summary: {}, limits: { ...PROC_BUDGET } };

  const jobs = [];   // [label, fn] – sync jobs measure one model, async ones (GLB) load files
  const add = (label, list) => { for (const fn of list) jobs.push([label, fn]); };
  if (want('building')) add('buildings', buildingJobs(use, rows, res));
  if (want('vehicle')) add('vehicles', measureVehicles(use, rows, res).jobs);
  if (want('robot')) add('robots', use.map((s) => robotJob(s, rows, res)));
  if (want('crew')) add('crew', measureCrew(use, rows, res));
  if (want('glbBuilding')) add('glb buildings', glbBuildingJobs(use, rows, res));
  if (want('glbVehicle')) add('glb vehicles', glbVehicleJobs(use, rows, res));
  if (want('glbCrew')) add('glb crew', glbCrewJobs(use, rows, res));
  if (want('glbRobotPart') || want('glbRobot')) add('glb robots', glbRobotJobs(use, rows, res, want('glbRobotPart'), want('glbRobot')));

  let done = 0;
  let last = '';
  for (const [label, fn] of jobs) {
    if (label !== last) { log(`[ModelBudget] ${label}…`); last = label; }
    try { await fn(); } catch (err) { res.errors.push(`${label}: ${err.message}`); console.warn(`[ModelBudget] ${label}`, err); }
    if (++done % PROC_BUDGET.yieldEvery === 0) await tick();
  }

  res.overLimit = rows.filter((r) => r.over);
  const b0 = rows.filter((r) => r.kind === 'building' && r.source === 'proc' && r.lod === 'LOD0').map((r) => r.tri).sort((a, b) => a - b);
  if (b0.length) res.summary.suggestedBuildingTri = Math.ceil(b0[Math.min(b0.length - 1, Math.floor(b0.length * PROC_BUDGET.percentile))] / 1000) * 1000;
  res.summary.rows = rows.length;
  res.summary.overLimit = res.overLimit.length;
  res.summary.info = rows.filter((r) => r.info).length;
  res.summary.errors = res.errors.length;
  log(`[ModelBudget] ${rows.length} rows, ${res.overLimit.length} over limit, ${res.summary.info} info, ${res.errors.length} errors`
    + (res.summary.suggestedBuildingTri ? `, suggested buildingTri ${res.summary.suggestedBuildingTri}` : ''));
  if (res.errors.length) log(res.errors.slice(0, 20).join('\n'));
  return res;
}

// ---------------------------------------------------------------- output

const COLUMNS = ['druh', 'id', 'styl', 'zdroj', 'LOD', 'tri', 'draw cally', 'přes limit', 've hře kreslí', 'poznámka'];
const KIND_ORDER = ['building', 'vehicle', 'robot', 'robotPart', 'crew'];
const cells = (r) => [r.kind, r.id, r.style, r.source, r.lod, r.tri, r.drawCalls, r.over ? 'ANO' : (r.info ? 'info' : ''), r.inGame, r.note];
const sortRows = (rows) => rows.map((r, i) => [r, i]).sort((a, b) =>
  KIND_ORDER.indexOf(a[0].kind) - KIND_ORDER.indexOf(b[0].kind) || (a[0].source === b[0].source ? 0 : a[0].source === 'proc' ? -1 : 1) || a[1] - b[1]).map((e) => e[0]);

/** Markdown tables (rows, robot combinations over the limit, heaviest robot parts, limits) for docs/notes/b4-budget.md */
export function toMarkdown(result) {
  const esc = (v) => String(v ?? '').replaceAll('|', '/');
  const L = result.limits;
  const out = [];
  out.push(`Limity: vozidlo LOD0 ${L.unitTri} tri, robot ${L.robotTri} tri, posádka ${L.crewTri} tri, budova LOD1+ ${L.buildingDrawCalls} draw callů, budova LOD0 ${L.buildingTri} tri (info).`);
  if (result.summary.suggestedBuildingTri) out.push(`Navržené buildingTri (percentil ${L.percentile}): ${result.summary.suggestedBuildingTri}.`);
  out.push('', `| ${COLUMNS.join(' | ')} |`, `|${COLUMNS.map(() => '---').join('|')}|`);
  for (const r of sortRows(result.rows)) out.push(`| ${cells(r).map(esc).join(' | ')} |`);
  if (result.robotCombos.length) {
    out.push('', '**Sestavy robotů nad limitem (odhad ze součtu příspěvků dílů, LOD0)**', '', '| styl | sestav | nad limitem | podíl | limit tri |', '|---|---|---|---|---|');
    for (const c of result.robotCombos) out.push(`| ${c.style} | ${c.total} | ${c.over} | ${(c.share * 100).toFixed(1)} % | ${c.limit} |`);
  }
  if (result.robotParts.length) {
    out.push('', '**Nejtěžší proc díly robotů (LOD0, základ + díl; 5 na slot a styl)**', '', '| styl | slot | díl | tri | příspěvek |', '|---|---|---|---|---|');
    const keys = [...new Set(result.robotParts.map((p) => `${p.style}|${p.slot}`))];
    for (const k of keys) {
      const list = result.robotParts.filter((p) => `${p.style}|${p.slot}` === k).sort((a, b) => b.tri - a.tri).slice(0, 5);
      for (const p of list) out.push(`| ${p.style} | ${p.slot} | ${esc(p.id)} | ${p.tri} | ${p.delta >= 0 ? '+' : ''}${p.delta} |`);
    }
  }
  if (result.errors.length) out.push('', '**Chyby měření**', '', ...result.errors.map((e) => `- ${esc(e)}`));
  return out.join('\n');
}

/** Tab separated rows (header + rows) for a spreadsheet */
export function toTsv(result) {
  const clean = (v) => String(v ?? '').replaceAll('\t', ' ').replaceAll('\n', ' ');
  return [COLUMNS, ...sortRows(result.rows).map(cells)].map((r) => r.map(clean).join('\t')).join('\n');
}
