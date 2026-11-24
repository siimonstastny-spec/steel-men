// Steel Mans – ovládání myší a klávesnicí: výběr, skupiny, rozkazy – SIT
//   levý klik na jednotku               = výběr (Shift = přidat / odebrat)
//   tažení levým                        = výběr obdélníkem (Shift = přidat; volba "bojové jednotky přednostně")
//   dvojklik na vlastní jednotku        = všechny jednotky stejného typu na obrazovce (Shift = přidat) [SELSET]
//   pravý klik na zem                   = jít na místo (skupina se rozestaví do formace)
//   pravý klik na nepřítele             = útok (roboti dojdou na dostřel a bojují)
//   pravý klik na vrak ruky (robot)     = dojít a namontovat
//   pravý klik na vlastního robota (posádka) = dojít a nastoupit
//   pravý klik na vlastní montážní halu (posádka) = zařadit se do fronty posádek haly [N2]
//   Ctrl + 1–9 = uložit skupinu · 1–9 = vybrat skupinu · 2× rychle = kamera na skupinu
//   E = vystoupit · X = +100 XP posádce (ladění) – klávesy viz KEYBINDINGS v config.js
//   Alt + levý klik na díl / posádku    = fyzický zásah 25 (ladění) · Alt + Shift = energetický
//   Alt + levý klik jinam (země, budova) = ping pro spojence (PING.modifier, ui/Pings.js) [N7]
import * as THREE from 'three';
import { findMechPart } from '../units/MechPart.js';
import { Crew } from '../units/Crew.js';
import { KEYBINDINGS, ORDER_BUTTONS, CAMERA, PLACEMENT, MATCH_UI, CMD_BUILD, BAY_CREW, WALL_DRAG, SELECTION, FORMATION } from '../config.js';
import { unitTypeKey, preferCombat, isOnScreen } from './SelectionRules.js';
import { bayCrewCount } from '../game/BayCrew.js';
import { getSettings } from '../core/Profile.js';
import { isTargetable, areEnemies } from '../game/Combat.js';
import { play } from '../audio/Sound.js';
import { setUnitHighlight } from '../core/Highlight.js';
import { confirmDialog, isConfirmDialogOpen } from '../ui/ConfirmDialog.js';
import { isServiceBay, bayAssembling, canRepairTarget, repairInterruptible } from '../game/Repair.js';
import { ALLY_REPAIR, ORE_ICON, ORE_ICON_CURSOR } from '../config.js'; // [N5FIX] repair cursor, [N5] ore icon

// [N5] Sets --cursor-mine once from the shared ore icon (glyph -> SVG data URL, image path -> url(path)).
function applyMineCursor() {
  const c = ORE_ICON_CURSOR;
  const img = c.imagePattern.test(ORE_ICON)
    ? `url("${ORE_ICON}")`
    : `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${c.size}' height='${c.size}'><text x='${c.size / 2}' y='${c.baselineY}' font-size='${c.fontSize}' text-anchor='middle'>${ORE_ICON}</text></svg>`)}")`;
  document.documentElement.style.setProperty('--cursor-mine', `${img} ${c.hotspot} ${c.hotspot}, ${c.fallback}`);
}
// [W4] cursors are defined in ui/cursors.css (custom properties with a standard-cursor fallback)
const CURSOR_MINE = 'var(--cursor-mine, copy)';
const CURSOR_ATTACK = 'var(--cursor-attack, crosshair)';
import { commandBus } from '../game/commands/CommandBus.js';
import { canGather } from '../game/Production.js';
import '../game/commands/productionCommands.js'; // setRally registers even before BuildMenu loads
import { canTake, pickTaker, SINGLE_TAKER_ORDERS } from '../game/commands/unitCommands.js'; // also registers the unit commands
import { localTeam, isLocal } from '../core/LocalPlayer.js';
import { t } from '../i18n/i18n.js';
import { isPingClick, submitPing } from '../ui/Pings.js'; // [N7] also registers the 'ping' command

const CLICK_TOLERANCE_PX = 5; // větší posun = výběr obdélníkem
// Orders that wait for a target click (button / key first, then left click)
export const TARGETED_ORDERS = ['move', 'attackMove', 'guard', 'patrol', 'repairUnit'];
// Orders issued at once by their key (the command grid calls command(name) for every button)
const INSTANT_KEY_ORDERS = ['eject', 'dropLeft', 'dropRight', 'stop', 'deleteUnit', 'stanceRanged', 'stanceMelee',
  'behaviourAggressive', 'behaviourDefensive', 'behaviourPassive', 'repair', 'formation'];
// Behaviour buttons -> unit.setBehaviour mode (BEHAVIOUR.mechModes / crewModes in config.js)
const BEHAVIOUR_COMMANDS = { behaviourAggressive: 'aggressive', behaviourDefensive: 'defensive', behaviourPassive: 'passive' };
const STANCE_COMMANDS = { stanceRanged: 'ranged', stanceMelee: 'melee' };
const DROP_ARM_COMMANDS = { dropLeft: 'rightArm', dropRight: 'leftArm' }; // pilot's side -> slot (slot names follow the models, see PILOT_ARM_SLOT)
const COORD_DECIMALS = 100; // points are sent rounded to 0.01

/** Plain-JSON point of a Vector3 */
const MINIMAP_ORDER_EVENT = 'steelmans:minimapOrder'; // same name in ui/Minimap.js
const pt = (v) => ({ x: Math.round(v.x * COORD_DECIMALS) / COORD_DECIMALS, z: Math.round(v.z * COORD_DECIMALS) / COORD_DECIMALS });
/** Entity ids of units */
const ids = (units) => units.map((u) => u.eid);

/** Short key name for a button hint: 'KeyQ' -> 'Q', 'Digit1' -> '1' */
export const keyLabel = (code = '') => code.replace(/^Key|^Digit|^Numpad/, '');

/** Crew under a picked object (walks up the parents) */
function findCrew(object) {
  for (let o = object; o; o = o.parent) if (o.userData.crew) return o.userData.crew;
  return null;
}

/** Vehicle or building under a picked object (model root carries userData.unit) */
function findUnit(object) {
  for (let o = object; o; o = o.parent) if (o.userData.unit) return o.userData.unit;
  return null;
}

const matches = (bindings, code) => bindings.includes(code);
const modifierDown = (e, mod) => (mod === 'shift' ? e.shiftKey : mod === 'alt' ? e.altKey : e.ctrlKey || e.metaKey);

export class CommandInput {
  /**
   * @param {THREE.Camera} camera
   * @param {HTMLElement} dom
   * @param {import('../game/World.js').World} world
   * @param {object} [opts]  { onFocus(point) } – centre the camera (double-tap on a control group)
   *                          { controls } – OrbitControls, panned by dragging with the right mouse button
   */
  constructor(camera, dom, world, { onFocus, controls = null } = {}) {
    applyMineCursor();
    this.camera = camera;
    this.dom = dom;
    this.world = world;
    this.onFocus = onFocus;
    this.controls = controls;
    this.rightDown = null;   // { x, y, lastX, lastY, time, event, dragging } while the right button is held
    this.suppressContextMenu = false;
    this._panFwd = new THREE.Vector3();
    this._panRight = new THREE.Vector3();
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.hovered = null;     // MechPart pod kurzorem
    this.hoverUnit = null;   // robot / vozidlo / budova pod kurzorem (celá jednotka svítí)
    this.selection = [];     // selected units (own units; an enemy only alone, for viewing)
    this.groups = new Map(); // control group number -> units
    this.lastGroupTap = { n: null, time: 0 };
    this.lastUnitClick = { unit: null, time: 0 }; // double click on an own unit selects its type on screen
    this.downPos = null;
    this.pending = null;     // targeted order waiting for a left click ('move' | 'attackMove' | 'guard' | 'patrol')
    this.selectedWreck = null; // wreck (ArmWreck / SalvageWreck) clicked on the ground – shown in the HUD
    this.notify = null;      // (text) => short notice in the HUD message line (set by RobotProduction)
    this.boxEl = this.#createBoxElement();

    dom.addEventListener('pointermove', (e) => this.#onMove(e));
    dom.addEventListener('pointerdown', (e) => this.#onDown(e));
    window.addEventListener('pointerup', (e) => this.#onUp(e));
    window.addEventListener('pointermove', (e) => { if (e.target !== dom) this.clearHover(); this.#onRightDrag(e); });
    dom.addEventListener('pointerleave', () => this.clearHover());
    window.addEventListener('blur', () => this.clearHover());
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
    // A drag may end over a HUD panel – the browser menu must not open there either
    window.addEventListener('contextmenu', (e) => {
      if (this.suppressContextMenu || this.rightDown) e.preventDefault();
      this.suppressContextMenu = false;
    });
    window.addEventListener('blur', () => { this.rightDown = null; });
    window.addEventListener('keydown', (e) => this.#onKey(e));
    // Right click on the minimap (Minimap.js dispatches this DOM event, no wiring in main.js needed)
    window.addEventListener(MINIMAP_ORDER_EVENT, (e) => { e.detail.handled = this.#minimapOrder(e.detail.point, e.detail.queued, e.detail.left); });
    // Ejected crews appear when the command runs: the selection follows them. Only the command of THIS client
    // counts (isOwn: in multiplayer the executed copy of a remote player's eject must not change our selection);
    // the crew ids are the executor's returned result.
    commandBus.onExecuted((cmd, tick, result) => {
      if (cmd.type !== 'eject' || !commandBus.isOwn(cmd) || cmd.team !== localTeam() || !result?.crews?.length) return;
      if (!this.selection.some((u) => cmd.units.includes(u.eid))) return;
      this.setSelection(result.crews.map((eid) => this.world.entityById(eid)).filter(Boolean));
    });
  }

  /** Submits a unit command of the local player (executed in the simulation, see game/commands/unitCommands.js) */
  #submit(type, payload) {
    commandBus.submit({ type, team: localTeam(), ...payload });
  }

  // ---------- selection ----------

  /** The single selected unit (HUD detail), or null for none / several */
  get selected() { return this.selection.length === 1 ? this.selection[0] : null; }
  get selectedMech() { const u = this.selected; return u?.isMech ? u : null; }
  get selectedCrew() { const u = this.selected; return u instanceof Crew ? u : null; }
  /** Own mechs in the selection – they receive orders */
  get selectedMechs() { return this.selection.filter((u) => u.isMech && isLocal(u)); }
  get selectedCrews() { return this.selection.filter((u) => u instanceof Crew && isLocal(u)); }
  /** Own vehicles in the selection (src/units/Vehicle.js) */
  get selectedVehicles() { return this.selection.filter((u) => u.isVehicle && isLocal(u)); }
  /** Own armed vehicles in the selection (CombatVehicle) – they take combat orders and behaviours like mechs */
  get selectedArmedVehicles() { return this.selectedVehicles.filter((v) => v.canAttack); }
  /** Own units that take combat orders now: active mechs and armed vehicles */
  get selectedFighters() { return [...this.selectedMechs.filter((m) => m.active || repairInterruptible(m)), ...this.selectedArmedVehicles]; }
  /** The single selected building (own or not), or null */
  get selectedStructure() { const u = this.selected; return u?.isStructure ? u : null; }
  /** Own buildings in the selection – they can be deleted */
  get selectedOwnStructures() { return this.selection.filter((u) => u.isStructure && isLocal(u) && !u.destroyed); }

  select(unit) { this.setSelection(unit ? [unit] : []); }

  /** Wreck under the cursor (part lying on the ground), or null */
  get hoveredWreck() {
    const w = this.hovered?.wreck;
    return w && !w.collected && !w.destroyed ? w : null;
  }

  /** Marks a wreck on the ground (clears the unit selection); null unmarks */
  selectWreck(wreck) {
    if (this.selectedWreck && this.selectedWreck !== this.hovered?.wreck) this.selectedWreck.part.setHighlighted(false);
    this.selectedWreck = wreck;
    if (wreck) { this.setSelection([]); wreck.part.setHighlighted(true); }
  }

  setSelection(units, add = false) {
    if (units.length && this.selectedWreck) this.selectWreck(null);
    const next = add ? [...new Set([...this.selection, ...units])] : units;
    for (const u of this.selection) u.setSelected(false);
    this.selection = next.filter((u) => u && !u.destroyed && !u.inside);
    for (const u of this.selection) u.setSelected(true);
  }

  /** Drops dead units / crews that got into a mech (the mech takes over the selection) */
  cleanSelection() {
    const h = this.hoverUnit;
    if (h && (h.destroyed || h.removed || h.inside || h.dead)) this.clearHover();
    const boarded = this.selection.filter((u) => u instanceof Crew && u.mech).map((c) => c.mech); // [N2] not a crew in a bay
    const keep = this.selection.filter((u) => !u.destroyed && !u.removed && !u.inside // crew boarded / mech in a bay
      && this.world.isVisible?.(u) !== false); // an enemy that went into the fog of war is deselected
    if (boarded.length || keep.length !== this.selection.length) this.setSelection([...keep, ...boarded]);
    for (const [n, units] of this.groups) {
      // [N2] a crew waiting in an assembly bay (no mech) stays in its group
      this.groups.set(n, units.map((u) => (u instanceof Crew && u.mech ? u.mech : u)).filter((u) => u && !u.destroyed && !u.removed));
    }
    // A marked wreck that was picked up or destroyed is no longer shown
    const w = this.selectedWreck;
    if (w && (w.collected || w.destroyed || w.removed)) this.selectedWreck = null;
  }

  // ---------- commands (keyboard + command bar) ----------

  /** Commands available for the current selection: name -> enabled */
  get commands() {
    const mechs = this.selectedMechs;
    const active = mechs.filter((m) => m.active || repairInterruptible(m));
    const single = this.selectedMech && isLocal(this.selectedMech) ? this.selectedMech : null;
    const crews = this.selectedCrews;
    const vehicles = this.selectedVehicles;
    const armed = this.selectedArmedVehicles.length > 0;
    const fighters = this.selectedFighters.length > 0;
    return {
      move: active.length > 0 || crews.length > 0 || vehicles.length > 0,
      behaviourAggressive: mechs.length > 0 || armed,
      behaviourDefensive: mechs.length > 0 || crews.length > 0 || armed,
      behaviourPassive: mechs.length > 0 || crews.length > 0 || armed,
      repair: mechs.some((m) => m.canRepair || m.repairing),
      repairUnit: vehicles.some((v) => v.repairer),
      stop: active.some((m) => m.order) || crews.some((c) => c.order) || vehicles.some((v) => v.order),
      deleteUnit: mechs.length > 0 || crews.length > 0 || vehicles.length > 0 || this.selectedOwnStructures.length > 0,
      eject: mechs.some((m) => m.crew),
      stanceRanged: active.some((m) => m.hasMixedWeapons),
      stanceMelee: active.some((m) => m.hasMixedWeapons),
      dropLeft: !!single?.active && !!single.parts.rightArm,   // pilot's left hand = slot rightArm (see PILOT_ARM_SLOT)
      dropRight: !!single?.active && !!single.parts.leftArm,
      attackMove: fighters,
      guard: fighters,
      patrol: fighters,
    };
  }

  /** Behaviour shared by all selected own units ('aggressive' | 'defensive' | 'passive'), null when mixed / none */
  get behaviour() {
    const s = new Set([...this.selectedMechs, ...this.selectedCrews, ...this.selectedArmedVehicles].map((u) => u.behaviour));
    return s.size === 1 ? [...s][0] : null;
  }

  /** Field repair: true while every selected mech that can be repaired is already repairing (button = "stop repair") */
  get repairing() {
    const mechs = this.selectedMechs.filter((m) => m.canRepair || m.repairing);
    return mechs.length > 0 && mechs.every((m) => m.repairing);
  }

  /** Current stance of the selected mechs ('ranged' | 'melee' | 'mixed' | null) */
  get stance() {
    const s = new Set(this.selectedMechs.filter((m) => m.hasMixedWeapons).map((m) => m.stance));
    return s.size === 0 ? null : s.size > 1 ? 'mixed' : [...s][0];
  }

  command(name) {
    const mechs = this.selectedMechs;
    const crews = this.selectedCrews;
    const vehicles = this.selectedVehicles;
    if (name === 'stop') {
      this.#setPending(null);
      const units = [...mechs, ...crews, ...vehicles];
      if (units.length) this.#submit('stop', { units: ids(units) });
    }
    if (name === 'deleteUnit') {
      this.#setPending(null);
      const units = [...mechs, ...vehicles, ...crews];
      const structures = this.selectedOwnStructures; // every building can be deleted (deleteStructure command)
      if (units.length === 0 && structures.length === 0) return;
      this.confirmDelete(units, structures);
      return;
    }
    if (name === 'eject') {
      const loaded = mechs.filter((m) => m.crew);
      if (loaded.length) this.#submit('eject', { units: ids(loaded) }); // the selection follows the crews (onExecuted)
    }
    if (name === 'formation') this.#cycleFormation([...mechs, ...crews, ...vehicles]);
    const behaviour = BEHAVIOUR_COMMANDS[name];
    if (behaviour) this.#submit('behaviour', { units: ids([...mechs, ...crews, ...this.selectedArmedVehicles]), mode: behaviour });
    if (name === 'repair') {
      // All repairing -> stop all; otherwise start on every mech that can be repaired
      this.#submit('repair', { units: ids(mechs), start: !this.repairing });
    }
    if (STANCE_COMMANDS[name] && mechs.length) this.#submit('stance', { units: ids(mechs), stance: STANCE_COMMANDS[name] });
    const single = mechs.length === 1 ? mechs[0] : null;
    if (DROP_ARM_COMMANDS[name] && single) this.#submit('dropArm', { units: [single.eid], slot: DROP_ARM_COMMANDS[name] });
    if (TARGETED_ORDERS.includes(name)) {
      // Second press of the same order cancels it; the target comes with the next left click
      this.#setPending(this.pending === name || !this.commands[name] ? null : name);
    }
  }

  /** Formation key: the next mode (after the majority mode of the units) for all of them (same as the HUD button) */
  #cycleFormation(units) {
    if (!units.length) return;
    const modes = FORMATION.modes;
    const fallback = modes.indexOf(FORMATION.defaultMode);
    const counts = modes.map(() => 0);
    for (const u of units) { const k = modes.indexOf(u.formation); counts[k < 0 ? fallback : k]++; }
    let best = 0;
    for (let k = 1; k < counts.length; k++) if (counts[k] > counts[best]) best = k;
    this.#submit('setFormation', { units: ids(units), mode: modes[(best + 1) % modes.length] });
  }

  /**
   * Asks for confirmation, then submits the delete commands for own units and / or buildings (also used by the
   * building page of the option grid, BuildMenu). The simulation does the deleting.
   */
  confirmDelete(units = [], structures = []) {
    const count = units.length + structures.length;
    if (!count) return;
    const messageKey = structures.length ? 'dialog.deleteStructures' : 'dialog.deleteUnits';
    confirmDialog({ messageKey, params: { value: count } }).then((ok) => {
      if (!ok) return;
      if (units.length) this.#submit('deleteUnit', { units: ids(units) });
      if (structures.length) this.#submit('deleteStructure', { structures: ids(structures) });
      this.setSelection([]);
    });
  }

  /** Esc: aborts target picking (the command grid shows the pending order) */
  cancelPending() { this.#setPending(null); }

  #setPending(name) {
    this.pending = name;
    this.dom.style.cursor = name ? ORDER_BUTTONS.pendingCursor : '';
  }

  /** Left click after choosing a targeted order: unit or ground under the cursor is the target */
  #issuePending(e) {
    const name = this.pending;
    this.#setPending(null);
    const queued = e.shiftKey; // Shift = add to the order queue (OrderQueue.js)
    if (name === 'move') { this.#moveOrder(e, true, queued); return; }
    if (name === 'repairUnit') { // repair vehicles: the own unit / building clicked
      const target = this.#pick(e).unit;
      const repairers = this.selectedVehicles.filter((v) => v.repairer);
      if (target?.eid != null && repairers.length) this.#submit('repairUnit', { units: ids(repairers), target: target.eid, queued });
      return;
    }
    const mechs = this.selectedFighters; // active mechs + armed vehicles
    if (!mechs.length) return;
    const { unit } = this.#pick(e);
    const enemy = name === 'attackMove' ? this.#enemyUnderCursor() : null;
    if (enemy) {
      this.#submit('attack', { units: ids(mechs), target: enemy.eid, queued });
      return;
    }
    if (name === 'guard' && unit && isLocal(unit) && isTargetable(unit)) {
      this.#submit('guard', { units: ids(mechs), target: unit.eid, queued });
      return;
    }
    const point = this.#pickGround();
    if (!point) return;
    this.#pointOrder(name, point, queued);
  }

  /** The one place where a targeted order meets a ground point (terrain click and minimap click alike) */
  #pointOrder(name, point, queued, withVehicles = true) {
    if (name === 'move') {
      const units = [...(withVehicles ? this.selectedVehicles : []), ...this.selectedMechs, ...this.selectedCrews];
      if (units.length) this.#submit('move', { units: ids(units), point: pt(point), queued });
      return;
    }
    const fighters = this.selectedFighters; // attackMove / patrol: active mechs + armed vehicles
    if (fighters.length) this.#submit(name, { units: ids(fighters), point: pt(point), queued });
  }

  #onKey(e) {
    if (e.target.closest?.('input, select, textarea')) return;
    if (document.getElementById('menu')?.hidden === false) return; // start menu / settings open
    if (isConfirmDialogOpen()) return;
    const kb = KEYBINDINGS;
    const group = kb.controlGroups.findIndex((codes) => matches(codes, e.code));
    if (group >= 0) { this.controlGroup(group + 1, modifierDown(e, kb.groupModifier)); e.preventDefault(); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    for (const name of [...INSTANT_KEY_ORDERS, ...TARGETED_ORDERS]) if (matches(kb[name] ?? [], e.code)) this.command(name);
    if (matches(kb.cancel, e.code)) {
      // Esc cancels a pending order / building placement first; with nothing to cancel it opens the game menu
      const nothingToCancel = !this.pending && !this.placement;
      this.#setPending(null);
      this.placement?.cancel();
      if (nothingToCancel) this.onGameMenu?.();
    }
    if (matches(MATCH_UI.menuKeys, e.code)) this.onGameMenu?.();
    if (this.placement && matches(kb.rotateBuilding ?? [], e.code)) { this.placement.rotate?.(e.shiftKey ? -1 : 1); e.preventDefault(); }
    // Idle crew / builder hotkeys (empty by default; the Hud supplies the callbacks, same as its buttons)
    if (!e.repeat && matches(kb.idleCrew ?? [], e.code)) this.onIdleCrew?.();
    if (!e.repeat && matches(kb.idleBuilder ?? [], e.code)) this.onIdleBuilder?.();
    if (!e.repeat && matches(kb.idleDrill ?? [], e.code)) this.onIdleDrill?.(); // [R6]
    if (!e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && matches(kb.stockWindow ?? [], e.code)) this.onStockWindow?.(); // [F1]
    if (matches(kb.debugXp, e.code)) {
      const own = this.selection.filter((u) => isLocal(u) && !u.isStructure);
      if (own.length) this.#submit('debugXp', { units: ids(own) }); // crews, armed vehicles (own XP), crews inside mechs
    }
  }

  /** Units of a control group that are still alive */
  groupUnits(n) {
    return (this.groups.get(n) ?? []).filter((u) => !u.destroyed && !u.removed);
  }

  /** save = store the selection as group n; otherwise select it (second quick call centres the camera) */
  controlGroup(n, save = false) {
    if (save) {
      const own = this.selection.filter((u) => isLocal(u));
      if (own.length) this.groups.set(n, own);
      return;
    }
    const units = (this.groups.get(n) ?? []).filter((u) => !u.destroyed && !u.removed);
    if (!units.length) return;
    this.setSelection(units);
    // Double tap = centre the camera on the group
    const now = performance.now() / 1000;
    if (this.lastGroupTap.n === n && now - this.lastGroupTap.time < KEYBINDINGS.doubleTapTime) {
      const c = new THREE.Vector3();
      for (const u of units) c.add(u.position);
      this.onFocus?.(c.divideScalar(units.length));
    }
    this.lastGroupTap = { n, time: now };
  }

  // ---------- picking ----------

  #setPointer(e) {
    const rect = this.dom.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  /** @returns {{ part, crew, unit }} – unit = mech or crew under the cursor */
  #pick(e) {
    this.#setPointer(e);
    const hit = this.raycaster.intersectObjects(this.world.pickables, false)[0];
    if (!hit) return { part: null, crew: null, unit: null };
    const part = findMechPart(hit.object);
    const crew = findCrew(hit.object);
    return { part, crew, unit: part?.mech ?? crew ?? findUnit(hit.object) };
  }

  /** Ore deposit under the cursor (crystals of a deposit or the super node), or null (call after #pick / #setPointer) */
  #depositUnderCursor() {
    const eco = this.world.economy;
    if (!eco) return null;
    const hit = this.raycaster.intersectObjects(eco.depositMeshes, false)[0];
    return hit ? eco.depositOf(hit.object) : null;
  }

  /**
   * Building placement mode (Construction.PlacementGhost): { move(point), confirm(point) -> done, cancel() }.
   * While set, the left click places the building, right click / Esc cancels it.
   */
  setPlacement(placement) {
    this.placement?.cancel();
    this.placement = placement;
    this.#setPending(null);
  }

  /** First targetable enemy among all hits of the current ray (call after #pick / #setPointer) */
  #enemyUnderCursor() {
    for (const hit of this.raycaster.intersectObjects(this.world.pickables, false)) {
      const unit = findMechPart(hit.object)?.mech ?? findCrew(hit.object) ?? findUnit(hit.object);
      if (unit && areEnemies({ team: localTeam() }, unit) && isTargetable(unit)) return unit; // N5: allies are not targets
    }
    return null;
  }

  /** First own assembly bay among all hits of the current ray, even behind own units (call after #pick / #setPointer) */
  #bayUnderCursor() {
    for (const hit of this.raycaster.intersectObjects(this.world.pickables, false)) {
      const unit = findUnit(hit.object);
      if (isServiceBay(unit, localTeam())) return unit;
    }
    return null;
  }

  /** First own finished building among all hits of the current ray, even behind own units (call after #pick / #setPointer) */
  #structureUnderCursor() {
    for (const hit of this.raycaster.intersectObjects(this.world.pickables, false)) {
      const unit = findUnit(hit.object);
      if (unit?.isStructure && isLocal(unit) && !unit.underConstruction) return unit;
    }
    return null;
  }

  /** First collectable arm wreck among all hits of the current ray, even behind an own unit (call after #pick / #setPointer) */
  #armWreckUnderCursor() {
    for (const hit of this.raycaster.intersectObjects(this.world.pickables, false)) {
      const part = findMechPart(hit.object);
      if (part?.wreck && part.isArm) return part;
    }
    return null;
  }

  /** First loadable legs / torso wreck among all hits of the current ray (call after #pick / #setPointer) */
  #salvageUnderCursor() {
    for (const hit of this.raycaster.intersectObjects(this.world.pickables, false)) {
      const wreck = findMechPart(hit.object)?.wreck;
      if (wreck && wreck.available) return wreck;
    }
    return null;
  }

  #pickGround() {
    return this.raycaster.intersectObject(this.world.ground, false)[0]?.point ?? null;
  }

  // ---------- mouse ----------

  #onMove(e) {
    if (this.placeDrag?.wall && this.placement === this.placeDrag.placement && e.buttons & 1) { this.#dragWall(e); return; }
    if (this.placeDrag && this.placement && e.buttons & 1) { this.#dragRotate(e); return; }
    if (this.downPos && e.buttons & 1) this.#updateBox(e);
    if (this.rightDown?.dragging) return; // panning – keep the grabbing cursor, no hover picking
    if (this.placement) { this.#setPointer(e); this.placement.move(this.#pickGround()); return; }
    const { part, unit } = this.#pick(e);
    this.pointerClient = { x: e.clientX, y: e.clientY }; // wreck tooltip position
    this.#setHover(part, unit);
    const enemy = unit && areEnemies({ team: localTeam() }, unit);
    // [N5FIX] selected repair vehicles over a unit they can repair (own, or an ally's finished building): repair cursor
    const repairable = unit && !enemy && this.selectedVehicles.some((v) => v.repairer && canRepairTarget(v, unit));
    // [N2] selected harvesters over an ore deposit they can mine: mining cursor
    const mineable = !this.pending && this.selectedVehicles.some((v) => v.harvester)
      && Boolean(this.#depositUnderCursor());
    // [W4] enemy unit / building under the cursor with armed units selected (mechs or armed vehicles): crosshair
    const canShoot = enemy && (this.selectedMechs.length > 0 || this.selectedVehicles.some((v) => v.canAttack));
    this.dom.style.cursor = this.pending ? ORDER_BUTTONS.pendingCursor
      : mineable ? CURSOR_MINE
      : part?.wreck && part.isArm ? 'grab'
      : canShoot ? CURSOR_ATTACK
      : repairable ? ALLY_REPAIR.cursor
      : unit ? 'pointer' : '';
  }

  /**
   * Hover glow: a wreck lights its own part, anything else the WHOLE unit (mech / vehicle / building).
   * Every change releases the previous target first, so nothing stays lit behind the cursor.
   */
  #setHover(part, unit) {
    if (part !== this.hovered) {
      const old = this.hovered;
      if (old?.wreck && old.wreck !== this.selectedWreck) old.setHighlighted(false);
      this.hovered = part;
      if (part?.wreck) part.setHighlighted(true);
    }
    const target = !part?.wreck && (unit?.isMech || unit?.isVehicle || unit?.isStructure) ? unit : null;
    if (target !== this.hoverUnit) {
      setUnitHighlight(this.hoverUnit, false);
      this.hoverUnit = target;
      setUnitHighlight(target, true);
    }
  }

  /** Drops all hover glow (cursor left the canvas, a panel is under it, the hovered unit died) */
  clearHover() {
    this.#setHover(null, null);
    this.pointerClient = null;
  }

  #onDown(e) {
    // Building placement: the press pins the building to the spot, dragging sideways turns it, release places it
    if (e.button === 0 && this.placement && e.target === this.dom) {
      this.#setPointer(e);
      const point = this.#pickGround();
      if (point) {
        this.placement.move(point);
        // Wall: the press sets the start of the line, dragging shows the line, the release orders it (#dragWall)
        if (this.placement.beginDrag?.(point)) {
          this.placeDrag = { wall: true, placement: this.placement, x: e.clientX, y: e.clientY, point, moved: false };
        } else {
          this.placeDrag = { x: e.clientX, point, yaw: this.placement.yaw, rotated: false };
        }
      }
      return;
    }
    if (e.button === 0) this.downPos = { x: e.clientX, y: e.clientY };
    if (e.button === 2) {
      if (this.placement) { this.placement.cancel(); return; } // right click aborts building placement
      if (this.pending) { this.#setPending(null); return; } // right click aborts a targeted order
      // The order waits for the release: holding and dragging pans the map instead (#onRightDrag)
      this.rightDown = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, time: performance.now() / 1000, event: e, dragging: false };
    }
  }

  /** Right button held: past CAMERA.rightDragThreshold the drag pans the camera over the ground */
  #onRightDrag(e) {
    const r = this.rightDown;
    if (!r) return;
    if (!(e.buttons & 2)) { this.rightDown = null; return; } // released outside the window
    if (!r.dragging) {
      if (Math.hypot(e.clientX - r.x, e.clientY - r.y) <= CAMERA.rightDragThreshold) return;
      r.dragging = true;
      this.dom.style.cursor = 'grabbing';
    }
    this.#pan(e.clientX - r.lastX, e.clientY - r.lastY);
    r.lastX = e.clientX;
    r.lastY = e.clientY;
  }

  /**
   * Moves camera and orbit target along the ground by a mouse movement in pixels. World units per pixel come
   * from the camera distance (like WASD: farther = faster); sensitivity / invert from the player's mouse settings.
   */
  #pan(dx, dy) {
    const controls = this.controls;
    if (!controls || (!dx && !dy)) return;
    const m = getSettings().mouse ?? {};
    const sensitivity = m.panSensitivity ?? 1;           // optional settings (Settings → Mouse may add them)
    const direction = (CAMERA.rightDragGrab ? -1 : 1) * (m.invertPan ? -1 : 1);
    const distance = this.camera.position.distanceTo(controls.target);
    const height = this.dom.clientHeight || window.innerHeight;
    const unitsPerPixel = (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / height;
    const scale = unitsPerPixel * CAMERA.rightDragSpeed * sensitivity * direction;
    // Screen right / up mapped onto the ground plane
    this.camera.getWorldDirection(this._panFwd).setY(0).normalize();
    this._panRight.crossVectors(this._panFwd, THREE.Object3D.DEFAULT_UP).normalize();
    const move = this._panRight.multiplyScalar(dx * scale).addScaledVector(this._panFwd, -dy * scale);
    this.camera.position.add(move);
    controls.target.add(move);
  }

  /** Right button released: a short still click issues the order at the press position, a drag issues nothing */
  #onRightUp(e) {
    const r = this.rightDown;
    this.rightDown = null;
    if (!r) return;
    if (r.dragging) { this.suppressContextMenu = true; this.dom.style.cursor = ''; return; }
    if (performance.now() / 1000 - r.time > CAMERA.rightClickMaxTime) return;
    if (e.target !== this.dom) return; // released over a HUD panel
    this.#order(r.event);
    this.#orderAck();
  }

  /** Confirmation sound of an order (only when something that can obey is selected) */
  #orderAck() {
    if (this.selectedMechs.length || this.selectedCrews.length || this.selectedVehicles.length) play('orderAck');
  }

  /** Wall drag: after WALL_DRAG.startPx the line follows the cursor over the ground */
  #dragWall(e) {
    const d = this.placeDrag;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) >= WALL_DRAG.startPx) d.moved = true;
    this.#setPointer(e);
    const point = this.#pickGround();
    if (!point) return;
    d.point = point;
    this.placement.move(point);
  }

  /** Horizontal drag while placing: smooth turn, CMD_BUILD.dragRotatePerPixel rad per px beyond a dead zone */
  #dragRotate(e) {
    const d = this.placeDrag;
    const dx = e.clientX - d.x;
    if (!d.rotated && Math.abs(dx) < PLACEMENT.dragRotateThreshold) return;
    d.rotated = true;
    const beyond = dx - Math.sign(dx) * PLACEMENT.dragRotateThreshold; // continuous from the edge of the dead zone
    this.placement.setYaw?.(d.yaw + beyond * PLACEMENT.dragRotateDirection * CMD_BUILD.dragRotatePerPixel);
    this.placement.move(d.point);
  }

  #onUp(e) {
    if (e.button === 2) { this.#onRightUp(e); return; }
    if (e.button === 0 && this.placeDrag) {
      const drag = this.placeDrag;
      this.placeDrag = null;
      if (drag.wall) {
        // Cancelled meanwhile (right click / Esc): nothing is ordered. Released over the HUD: the last ground point.
        if (this.placement !== drag.placement) return;
        let point = drag.point;
        if (e.target === this.dom) { this.#setPointer(e); point = this.#pickGround() ?? point; }
        this.placement.endDrag(point, drag.moved, e.shiftKey);
        return;
      }
      this.placement?.confirm(drag.point, e.shiftKey); // pinned spot, dragged rotation; Shift = keep placing
      return;
    }
    if (e.button !== 0 || !this.downPos) return;
    const start = this.downPos;
    this.downPos = null;
    this.boxEl.hidden = true;
    const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
    if (moved > CLICK_TOLERANCE_PX) { this.#boxSelect(start, e, e.shiftKey); return; }
    if (e.target !== this.dom) return; // click ended on UI
    if (this.placement) {
      this.#setPointer(e);
      const point = this.#pickGround();
      if (point) this.placement.confirm(point, e.shiftKey); // Shift = keep placing more of the same building
      return;
    }
    if (this.pending) { this.#issuePending(e); this.#orderAck(); return; }

    const { part, crew, unit } = this.#pick(e);
    if (e.altKey && (part?.mech || crew)) {
      // Debug damage is a command too (any team may be hit: the command carries the attacker's team)
      const slot = part?.mech ? Object.keys(part.mech.parts).find((k) => part.mech.parts[k] === part) : null;
      const target = part?.mech ?? crew;
      if (target?.eid != null) this.#submit('debugDamage', { target: target.eid, slot: slot ?? null, energy: e.shiftKey });
      return;
    }
    if (isPingClick(e)) { // [N7] modifier + click anywhere else (ground, units, buildings) = map ping for allies
      const point = this.#pickGround();
      if (point) submitPing(point);
      return;
    }
    if (!unit && part?.wreck) { this.selectWreck(part.wreck); return; } // part lying on the ground
    if (!unit) { if (!e.shiftKey) { this.select(null); this.selectWreck(null); } return; }
    if (!isLocal(unit)) { this.select(unit); return; } // enemies: view only
    const now = performance.now() / 1000;
    const doubleClick = this.lastUnitClick.unit === unit && now - this.lastUnitClick.time < SELECTION.doubleClickTime;
    this.lastUnitClick = doubleClick ? { unit: null, time: 0 } : { unit, time: now };
    if (doubleClick && this.#selectSameTypeOnScreen(unit, e.shiftKey)) return;
    if (e.shiftKey) {
      const has = this.selection.includes(unit);
      this.setSelection(has ? this.selection.filter((u) => u !== unit) : [...this.selection, unit]);
    } else {
      this.select(unit);
    }
  }

  // Right click: attack enemy / board own mech / collect wreck / move
  #order(e) {
    const mechs = this.selectedMechs;
    const crews = this.selectedCrews;
    const vehicles = this.selectedVehicles;
    if (!mechs.length && !crews.length && !vehicles.length) { this.#rallyOrder(e); return; }
    const queued = e.shiftKey; // Shift = add to the order queue (OrderQueue.js)
    const { part, unit } = this.#pick(e);
    // Units that already got an order from this click. canTake() (unitCommands.js) tells who can carry an order
    // out, the executors check it again when the command runs.
    const busy = new Set();
    const send = (type, units, payload) => this.#submit(type, { units: ids(units), queued, ...payload });
    /** Offers an order to `units` (not busy ones only); returns who takes it */
    const offer = (type, units, target, payload) => {
      const free = units.filter((u) => !busy.has(u));
      const takers = SINGLE_TAKER_ORDERS.has(type)
        ? [pickTaker(type, free, target, queued)].filter(Boolean)
        : free.filter((u) => canTake(type, u, target, queued));
      if (takers.length) { send(type, takers, payload); for (const u of takers) busy.add(u); }
      return takers;
    };
    // Vehicles: builders take over an own unfinished building, harvesters mine a deposit; the rest just moves
    if (unit?.isStructure && isLocal(unit) && unit.underConstruction) offer('helpBuild', vehicles, unit, { structure: unit.eid });
    const deposit = vehicles.some((v) => v.harvester) ? this.#depositUnderCursor() : null;
    if (deposit) offer('harvest', vehicles, deposit, { deposit: deposit.eid });
    // Salvage carriers (HoverTruck): load a legs / torso wreck (one truck per wreck), or unload at an own building
    const carriers = vehicles.filter((v) => !busy.has(v) && v.salvager);
    if (carriers.length) {
      const salvage = this.#salvageUnderCursor();
      if (salvage) offer('salvage', carriers, salvage, { wreck: salvage.eid });
      else {
        // The building wins even when an own unit stands in front of it (a mech in the bay doorway)
        const drop = unit?.isStructure ? unit : this.#structureUnderCursor();
        if (drop && isLocal(drop) && !drop.underConstruction) offer('deliver', carriers, drop, { structure: drop.eid });
      }
    }
    // Repair vehicles (HoverTruck): an own damaged mech, vehicle or finished building under the cursor;
    // [N5FIX] also an ally's damaged finished building (canTake -> Repair.canRepairTarget decides, enemies never)
    if (unit && (isLocal(unit) || unit.isStructure)) offer('repairUnit', vehicles.filter((v) => v.repairer), unit, { target: unit.eid });
    // Armed vehicles: an enemy under the cursor is attacked (same pick as for mechs)
    const armed = vehicles.filter((v) => !busy.has(v) && v.canAttack);
    const enemyForVehicles = armed.length ? this.#enemyUnderCursor() : null;
    if (enemyForVehicles) offer('attack', armed, enemyForVehicles, { target: enemyForVehicles.eid });
    const movers = vehicles.filter((v) => !busy.has(v));
    if (movers.length) {
      const point = this.#pickGround();
      if (point) send('move', movers, { point: pt(point) });
    }
    if (!mechs.length && !crews.length) return;

    // An enemy under the cursor wins even when an own unit stands in front of it (crowded melee),
    // so a right click on the enemy always (re)issues the attack
    const enemy = mechs.length ? this.#enemyUnderCursor() : null;
    if (enemy) {
      send('attack', mechs, { target: enemy.eid });
      return;
    }
    // A collectable arm wreck wins even when an own unit stands over it (same as enemies)
    const wreckPart = mechs.length ? this.#armWreckUnderCursor() : null;
    if (wreckPart) {
      offer('collect', mechs, wreckPart.wreck, { wreck: wreckPart.wreck.eid });
      return;
    }
    // Own assembly bay: the mechs drive in for service one after another (Repair.js), crews just walk there
    // (wins over own units standing in front of it, like enemies and wrecks)
    // [N2] crews go into the bay's crew queue (BayCrew.js) – a new mech takes the first one
    const bay = this.#bayUnderCursor();
    if (bay) {
      const point = this.#pickGround() ?? bay.position;
      if (mechs.length && bayAssembling(bay)) { // assembling another mech: the mechs only walk up to the bay
        send('move', mechs, { point: pt(point) });
        this.notify?.(t('service.bayAssembling'));
      } else if (mechs.length) {
        send('enterBay', mechs, { bay: bay.eid });
      }
      const joining = crews.filter((c) => canTake('joinBay', c, bay, queued));
      if (joining.length) send('joinBay', joining, { bay: bay.eid });
      if (joining.length && bayCrewCount(bay) + joining.length > BAY_CREW.capacity) this.notify?.(t('bayCrew.full'));
      return;
    }
    if (unit && isLocal(unit) && !(unit instanceof Crew) && crews.length) {
      // First crew boards, the mech has one seat
      offer('board', crews, unit, { mech: unit.eid });
      return;
    }
    if (part?.wreck && part.isArm) { // legs / torso salvage cannot be mounted – a click on it is a move
      offer('collect', mechs, part.wreck, { wreck: part.wreck.eid });
      return;
    }
    this.#moveOrder(e, false, queued);
  }

  /**
   * [R4] Right click on the ground with an own unit-producing building selected (nothing else that obeys): sets the
   * rally point of that building; Shift appends to the chain (setRally command, Production.js).
   */
  #rallyOrder(e) {
    const s = this.selectedStructure;
    if (!s || !isLocal(s) || s.destroyed || !canGather(s)) return;
    this.#setPointer(e);
    const point = this.#pickGround();
    if (!point) return;
    this.#submit('setRally', { structure: s.eid, points: [pt(point)], append: e.shiftKey });
    play('orderAck');
  }

  /** Click on the minimap = a click on the terrain at that point (same #pointOrder). Left click: runs the armed
   * point order (move / attack-move / patrol) and returns true, else false (the minimap moves the camera).
   * Right click: the armed point order, otherwise a plain move. Guard / repair aim at a unit, so they are skipped:
   * a left click leaves them armed, a right click moves. Shift = add to the order queue. Returns true if handled. */
  #minimapOrder(point, queued, left) {
    const armed = this.pending === 'move' || this.pending === 'attackMove' || this.pending === 'patrol' ? this.pending : null;
    if (left && !armed) return false;
    this.#setPending(null);
    this.#pointOrder(armed ?? 'move', point, queued);
    return true;
  }

  /** Plain move to the ground under the cursor (right click on ground, or the Move order – ignores enemies).
   * The simulation spreads the group in formations (unitCommands.js 'move'). */
  #moveOrder(e, withVehicles = false, queued = false) {
    this.#setPointer(e);
    const point = this.#pickGround();
    if (!point) return;
    this.#pointOrder('move', point, queued, withVehicles);
  }

  // ---------- box selection ----------

  #createBoxElement() {
    const el = document.createElement('div');
    el.className = 'select-box';
    el.hidden = true;
    document.body.appendChild(el);
    return el;
  }

  #updateBox(e) {
    const s = this.downPos;
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) <= CLICK_TOLERANCE_PX) return;
    Object.assign(this.boxEl.style, {
      left: `${Math.min(s.x, e.clientX)}px`, top: `${Math.min(s.y, e.clientY)}px`,
      width: `${Math.abs(e.clientX - s.x)}px`, height: `${Math.abs(e.clientY - s.y)}px`,
    });
    this.boxEl.hidden = false;
  }

  /** Double click: every own unit of the same type (SelectionRules.unitTypeKey) inside the camera view; Shift adds */
  #selectSameTypeOnScreen(unit, add) {
    const key = unitTypeKey(unit);
    if (!key) return false;
    const units = [...this.world.mechs, ...this.world.crews, ...this.world.vehicles]
      .filter((u) => isLocal(u) && !u.destroyed && !u.inside && unitTypeKey(u) === key && isOnScreen(u, this.camera));
    this.setSelection(units.includes(unit) ? units : [unit, ...units], add);
    return true;
  }

  #boxSelect(start, e, add) {
    const rect = this.dom.getBoundingClientRect();
    const [x1, x2] = [Math.min(start.x, e.clientX), Math.max(start.x, e.clientX)];
    const [y1, y2] = [Math.min(start.y, e.clientY), Math.max(start.y, e.clientY)];
    const p = new THREE.Vector3();
    const pointIn = (height, u) => {
      p.copy(u.position).setY(u.position.y + height).project(this.camera);
      const sx = rect.left + ((p.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - p.y) / 2) * rect.height;
      return p.z < 1 && sx >= x1 && sx <= x2 && sy >= y1 && sy <= y2;
    };
    // Feet or body centre inside the box is enough
    const inside = (u) => pointIn(0, u) || pointIn(u.aimHeight ?? 1, u);
    const units = [...this.world.mechs, ...this.world.crews, ...this.world.vehicles] // buildings: click only
      .filter((u) => isLocal(u) && !u.destroyed && !u.inside && inside(u));
    this.setSelection(preferCombat(units), add); // setting "prefer combat units": builders / unarmed crews drop out
  }
}
