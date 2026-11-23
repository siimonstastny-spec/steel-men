// Steel Mans – option grid pages of the robot production buildings (BuildMenu shows them for a finished,
// selected own building). A pure view: state comes from world.production / the part stock, buttons submit
// commands through BuildMenu.submit (src/game/commands/productionCommands.js):
//   • part factory (stats.produces 'part'): slot tabs, one button per part the faction may make
//     (Production.partOptions) → 'queuePart'; the finished part goes into the stock (simulation)
//   • assembly bay (stats.produces 'mech'): slot tabs, the stocked parts of the slot (arms may be left empty,
//     ROBOT_PRODUCTION.requiredSlots). The chosen loadout is UI state; the first pick sends 'setAssemblyDraft'
//     (no mech drives in for service meanwhile). "Assemble" sends 'queueMech' – the simulation takes the parts,
//     pays rules.mechAssembly and spawns the mech in front of the bay.
//   • service page while a mech is inside: 'serviceRepair' / 'serviceSwap' / 'serviceCancel' / 'serviceRelease'
//   • 3D hologram in every own bay (MechHologram): the mech being assembled (Frame for parts not installed yet,
//     the parts appear one by one with the progress) or, while the bay is selected, the preview of the choice.
import { HUD, ROBOT_PRODUCTION, HOLOGRAM, ARMS, BAY_CREW, SHIFT_BATCH, PART_SALE } from '../config.js';
import { bayCrewCount } from '../game/BayCrew.js';
import { partStats, mechStatsFromLoadout, mechAssemblyStats } from '../data/Stats.js';
import { t } from '../i18n/i18n.js';
import { MECH_SLOTS, PART_SLOTS, ARM_SLOTS, partOptions, framePart, catalogSlot, armModel, stockKey } from '../game/PartStock.js';
import { progressOf } from './ProductionQueue.js';
import { MechHologram, PartHologram } from '../units/MechHologram.js';
import { taskProgress, waitingMech, canRelease } from '../game/Repair.js';
import { localTeam } from '../core/LocalPlayer.js';

const PERCENT = 100;

/** Service state of a bay as text: repairing / swapping with progress, stopped for lack of resources, idle */
export function serviceState(s) {
  const pct = Math.floor(taskProgress(s) * PERCENT);
  if (s.task?.type === 'repair') return t('service.repairing', { pct });
  if (s.task?.type === 'swap') return t('service.swapping', { part: t(`part.${s.task.slot}`), pct });
  if (s.stopped === 'noResources') return t('service.noResources');
  // The bay repairs the waiting mech by itself (Repair.js, no task): progress = HP share of its living parts
  if (!s.task && !s.stopped && s.mech?.damaged) return t('service.repairing', { pct: Math.floor(mechHpRatio(s.mech) * PERCENT) });
  return t('service.idle');
}

function mechHpRatio(mech) {
  let hp = 0;
  let max = 0;
  for (const key in mech.parts) {
    const p = mech.parts[key];
    if (!p?.alive) continue;
    hp += p.hp;
    max += p.maxHp;
  }
  return max > 0 ? hp / max : 1;
}

const TIME_DECIMALS = 1;
const SPEED_DECIMALS = 1;
const DPS_DECIMALS = 1;

export class RobotProduction {
  /**
   * @param {object} deps
   *   buildMenu  BuildMenu (submit, messages, producer ids, team / race / unlocks of the local player)
   *   catalog    parts.json (PartStock.loadPartCatalog)
   * (spawnMech is ignored – the simulation spawns assembled mechs, Production spawn.mech)
   */
  constructor({ buildMenu, catalog }) {
    Object.assign(this, { buildMenu, catalog });
    this.factorySlot = PART_SLOTS[0]; // legs | torso | 'arm' (one universal arm section)
    this.assemblySlot = MECH_SLOTS[0];
    this.serviceSlot = MECH_SLOTS[0];
    this.loadout = Object.fromEntries(MECH_SLOTS.map((s) => [s, null])); // chosen stocked part per slot
    this.leftEmpty = new Set();  // optional slots the player chose to leave empty (no arm)
    this.holograms = new Map();  // assembly bay structure -> MechHologram
    this.partHolograms = new Map(); // assembly bay structure -> PartHologram (part being mounted on a serviced mech)
    this.onOpenStock = null;     // [F1] set by main.js: () => stockWindow.open() (button "Part stock" in both panels)
    // Short notices of orders (e.g. a mech cannot drive into a bay that is assembling) go to the HUD message line
    buildMenu.input.notify = (text) => buildMenu.notify(text);
  }

  get team() { return this.buildMenu.team; }
  get race() { return this.buildMenu.race; }
  /** world.production – queues of all teams (read only here) */
  get queue() { return this.buildMenu.production; }
  get stock() { return this.buildMenu.economy.parts; }

  #tabs(current, select, slots = MECH_SLOTS) {
    return slots.map((s) => ({ label: t(`part.${s}`), on: s === current, onClick: () => select(s) }));
  }

  /** Stock / factory slot of a mech slot: both arms are the universal 'arm' */
  #stockSlot(slot) { return ARM_SLOTS.includes(slot) ? ARMS.slot : slot; }

  /** Model to mount in a mech slot for a stocked entry (arms: the model of that side) */
  #modelFor(p, slot) { return ARM_SLOTS.includes(slot) ? armModel(p.path, slot) : p.path; }

  /** Tooltip of a part (stats of an arm do not depend on the side) */
  #partTip(p, slot) {
    const s = partStats(p.path, catalogSlot(slot), this.race);
    const weapons = (s.weapons ?? []).map((w) => w.id).join(', ');
    return [`${t(`part.${slot}`)}: ${p.set}`, t('grid.cost', { ore: s.cost?.ore ?? 0, energy: s.cost?.energy ?? 0 }),
      t('grid.time', { time: +(s.buildTime ?? 0).toFixed(TIME_DECIMALS) }), `HP ${s.hp ?? '–'}`, weapons,
      t('parts.inStock', { n: this.stock.count(this.team, p.path) })].filter(Boolean).join('\n');
  }

  /** [F1] Grid button that opens the part stock window (where parts are sold) */
  #stockItem() {
    return { icon: PART_SALE.windowIcon, label: t('stock.open'), tip: t('stock.open.tip'), onClick: () => this.onOpenStock?.() };
  }

  #fullTip(producer) {
    return this.queue.isFull(producer) ? t('hud.queue.full', { max: HUD.production.maxQueue }) : '';
  }

  // ---------- part factory ----------

  factoryView(structure, title) {
    const producer = this.buildMenu.producerId(structure);
    const slot = this.factorySlot;
    const full = this.queue.isFull(producer);
    const items = partOptions(this.catalog, slot, this.race, this.buildMenu.unlocks).map((p) => ({
      icon: p.set.slice(0, ROBOT_PRODUCTION.setIconLetters), label: p.set, disabled: full,
      tip: [this.#partTip(p, slot), t('grid.shiftBatch', { n: SHIFT_BATCH.count }), this.#fullTip(producer)].filter(Boolean).join('\n'),
      onClick: (e) => this.#queuePart(structure, slot, p, e?.shift),
    }));
    items.push(this.#stockItem());
    return {
      title, items,
      tabs: this.#tabs(slot, (s) => { this.factorySlot = s;this.buildMenu.hud.refresh?.(); }, PART_SLOTS),
      summary: [
        { label: t('hud.queue.title'), value: `${this.queue.itemsOf(producer).length} / ${HUD.production.maxQueue}` },
        { label: t('parts.stock'), value: this.stock.total(this.team) },
      ],
    };
  }

  #queuePart(structure, slot, p, batch = false) {
    const cmd = { type: 'queuePart', producer: structure.eid, slot, path: p.path };
    if (batch) this.buildMenu.submitBatch(cmd); else this.buildMenu.submit(cmd);
  }

  // ---------- assembly bay ----------

  /** Stocked parts for a mech slot, as catalog entries ({ path, set }; arms: the stock key model, same list for both sides) */
  #stocked(slot) {
    return (this.catalog?.[catalogSlot(this.#stockSlot(slot))] ?? []).filter((p) => this.stock.count(this.team, p.path) > 0);
  }

  /** Stock of a type left for `slot` once the other chosen slots (this.loadout) have taken theirs */
  #available(slot, key) {
    const taken = MECH_SLOTS.filter((s) => s !== slot && stockKey(this.loadout[s]) === key).length;
    return this.stock.count(this.team, key) - taken;
  }

  /** Slot that may stay empty (arms) */
  #optional(slot) { return !ROBOT_PRODUCTION.requiredSlots.includes(slot); }

  /**
   * Keeps the chosen parts valid: a slot whose part ran out takes the first stocked one (or none); an optional
   * slot the player left empty stays empty.
   */
  #refreshLoadout() {
    const used = new Map(); // stock key -> pieces already given to earlier slots (2 arms of a type need 2 in stock)
    const take = (key) => used.set(key, (used.get(key) ?? 0) + 1);
    const free = (key) => this.stock.count(this.team, key) - (used.get(key) ?? 0) > 0;
    for (const slot of MECH_SLOTS) {
      if (this.leftEmpty.has(slot)) { this.loadout[slot] = null; continue; }
      const key = stockKey(this.loadout[slot]);
      if (key && free(key)) { take(key); continue; }
      const next = this.#stocked(slot).find((p) => free(p.path));
      this.loadout[slot] = next ? this.#modelFor(next, slot) : null;
      if (next) take(next.path);
    }
  }

  /**
   * Player picks a part (or no arm) for the bay's next mech. The first pick starts the assembly of this bay
   * (structure.assemblyDraft): from then on no mech drives in for service until the assembly is done or the choice is
   * cancelled. Not allowed while a mech is serviced in the bay.
   */
  #choose(structure, slot, path) {
    if (structure.service) { this.buildMenu.notify(t('assembly.blockedByService')); return; }
    if (!structure.assemblyDraft) this.buildMenu.submit({ type: 'setAssemblyDraft', bay: structure.eid, on: true });
    this.loadout[slot] = path;
    if (path) this.leftEmpty.delete(slot); else this.leftEmpty.add(slot);
    this.buildMenu.hud.refresh?.();
  }

  /** Stats preview loadout: chosen parts; Frame stands in for a missing required part, an empty arm stays empty */
  #previewLoadout() {
    return Object.fromEntries(MECH_SLOTS.map((s) => [s,
      this.loadout[s] ?? (this.#optional(s) ? null : framePart(this.catalog, s)?.path ?? null)]));
  }

  get #complete() { return ROBOT_PRODUCTION.requiredSlots.every((s) => this.loadout[s]); }

  assemblyView(structure, title) {
    if (structure.service) return this.#serviceView(structure, title);
    this.#refreshLoadout();
    const producer = this.buildMenu.producerId(structure);
    const slot = this.assemblySlot;
    const items = this.#stocked(slot).map((p) => {
      const left = this.#available(slot, p.path); // arms: one in stock cannot go on both sides
      const model = this.#modelFor(p, slot);
      return {
        icon: p.set.slice(0, ROBOT_PRODUCTION.setIconLetters), label: p.set, on: this.loadout[slot] === model,
        disabled: left <= 0 && this.loadout[slot] !== model,
        tip: [this.#partTip(p, slot), left <= 0 && ARM_SLOTS.includes(slot) ? t('assembly.armOther') : ''].filter(Boolean).join('\n'),
        onClick: () => this.#choose(structure, slot, model),
      };
    });
    if (this.#optional(slot)) {
      items.unshift({ icon: ROBOT_PRODUCTION.noArmIcon, label: t('assembly.noArm'), on: !this.loadout[slot],
        tip: t('assembly.noArm.tip'), onClick: () => this.#choose(structure, slot, null) });
    }
    if (structure.assemblyDraft) { // the started choice can be dropped – the bay is free for service again
      items.unshift({ icon: ROBOT_PRODUCTION.serviceIcons.stop, label: t('assembly.clearDraft'), tip: t('assembly.clearDraft.tip'),
        onClick: () => this.buildMenu.submit({ type: 'setAssemblyDraft', bay: structure.eid, on: false }) });
    }
    items.push(...this.buildMenu.gatherItems(structure)); // [R4] stance of new mechs, clear rally
    items.push(this.#releaseCrewItem(structure)); // [N2]
    items.push(this.#stockItem()); // [F1]
    const full = this.queue.isFull(producer);
    const complete = this.#complete;
    return {
      title, items,
      tabs: this.#tabs(slot, (s) => { this.assemblySlot = s; this.buildMenu.hud.refresh?.(); }),
      summary: this.#summaryRows(producer, structure),
      action: {
        label: full ? t('hud.queue.full', { max: HUD.production.maxQueue }) : t('assembly.start'),
        tip: complete ? t('assembly.start.tip') : t('assembly.missing'),
        disabled: full || !complete, onClick: () => this.#queueMech(structure),
      },
    };
  }

  #summaryRows(producer, structure) {
    const preview = this.#previewLoadout();
    const rows = MECH_SLOTS.map((s) => {
      const chosen = this.catalog?.[s]?.find((p) => p.path === this.loadout[s]);
      if (chosen) return { label: t(`part.${s}`), value: chosen.set };
      return this.#optional(s)
        ? { label: t(`part.${s}`), value: t('assembly.noArm') }
        : { label: t(`part.${s}`), value: t('assembly.frameMissing'), warn: true };
    });
    if (ROBOT_PRODUCTION.requiredSlots.every((s) => preview[s])) {
      const m = mechStatsFromLoadout(preview, this.race);
      rows.push(
        { label: t('summary.hp'), value: m.hp },
        { label: t('summary.speed'), value: `${m.mobility.moveSpeed.toFixed(SPEED_DECIMALS)} u/s` },
        { label: t('summary.load'), value: `${m.carriedMass} / ${m.loadCapacity}`, warn: m.overloaded },
        { label: t('summary.dps'), value: m.dps.toFixed(DPS_DECIMALS) },
      );
    }
    const a = mechAssemblyStats(this.race);
    rows.push(
      { label: t('assembly.cost'), value: t('grid.cost', { ore: a.cost.ore ?? 0, energy: a.cost.energy ?? 0 }) },
      { label: t('assembly.time'), value: t('grid.time', { time: +a.buildTime.toFixed(TIME_DECIMALS) }) },
      { label: t('hud.queue.title'), value: `${this.queue.itemsOf(producer).length} / ${HUD.production.maxQueue}` },
    );
    const waiting = waitingMech(structure);
    if (waiting) rows.push({ label: t('service.waiting'), value: waiting.name, warn: true });
    rows.push(this.#crewRow(structure)); // [N2]
    rows.push(...this.buildMenu.gatherSummary(structure)); // [R4]
    return rows;
  }

  // ---------- [N2] crews waiting in the bay (src/game/BayCrew.js) ----------

  /** Summary row: crews in the bay / capacity (warn when none – a new mech would come out inactive) */
  #crewRow(structure) {
    const n = bayCrewCount(structure);
    return { label: t('bayCrew.title'), value: `${n} / ${BAY_CREW.capacity}`, warn: n === 0 };
  }

  /** Grid button: every waiting crew walks out ('releaseBayCrew') */
  #releaseCrewItem(structure) {
    const n = bayCrewCount(structure);
    return {
      icon: BAY_CREW.releaseIcon, label: t('bayCrew.release'), disabled: n === 0,
      tip: t(n ? 'bayCrew.release.tip' : 'bayCrew.empty'),
      onClick: () => this.buildMenu.submit({ type: 'releaseBayCrew', bay: structure.eid }),
    };
  }

  // ---------- service of a mech in the bay (src/game/Repair.js) ----------

  /** Bay page while a mech is inside: repair / interrupt, parts of the slot to swap in, release */
  #serviceView(structure, title) {
    const s = structure.service;
    const mech = s.mech;
    const slot = this.serviceSlot;
    const task = s.task;
    const icons = ROBOT_PRODUCTION.serviceIcons;
    const locked = Boolean(task?.mounting);
    const mounted = mech.parts[slot] ?? null;
    const items = [task
      ? { icon: icons.stop, label: t('service.stop'), tip: t('service.stop.tip'), disabled: locked, onClick: () => this.#act(structure, { type: 'serviceCancel' }) }
      : { icon: icons.repair, label: t('service.repair'), tip: t('service.repair.tip'), disabled: !mech.damaged,
        onClick: () => this.#act(structure, { type: 'serviceRepair' }) }];
    if (this.#optional(slot) && mounted) {
      items.push({ icon: icons.removeArm, label: t('service.removeArm'), tip: t('service.removeArm.tip'), disabled: locked,
        on: task?.type === 'swap' && task.slot === slot && !task.path, onClick: () => this.#act(structure, { type: 'serviceSwap', slot, path: null }) });
    }
    for (const p of this.#stocked(slot)) {
      const model = this.#modelFor(p, slot); // arms from the shared stock, model of this side
      items.push({
        icon: p.set.slice(0, ROBOT_PRODUCTION.setIconLetters), label: p.set,
        on: task?.type === 'swap' && task.slot === slot && task.path === model,
        disabled: locked || mounted?.stats.path === model,
        tip: [this.#partTip(p, slot), t(mounted ? 'service.swap.tip' : 'service.mount.tip')].join('\n'),
        onClick: () => this.#act(structure, { type: 'serviceSwap', slot, path: model }),
      });
    }
    const rows = [{ label: mech.name, value: serviceState(s) }, { label: t('assembly.blockedByService'), value: '', warn: true }];
    for (const sl of MECH_SLOTS) {
      const p = mech.parts[sl];
      rows.push(p
        ? { label: t(`part.${sl}`), value: `${p.set} ${Math.round((p.hp / p.maxHp) * PERCENT)} %`, warn: p.hp < p.maxHp }
        : { label: t(`part.${sl}`), value: t('part.missing'), warn: true });
    }
    rows.push({ label: t('parts.stock'), value: this.stock.total(this.team) });
    rows.push(this.#crewRow(structure)); // [N2] the crew queue is independent of the service
    items.push(this.#releaseCrewItem(structure));
    return {
      title: t('service.title', { name: title }), items,
      tabs: this.#tabs(slot, (sl) => { this.serviceSlot = sl; this.buildMenu.hud.refresh?.(); }),
      summary: rows,
      // No release during a part swap (Repair.canRelease): it has to finish or be interrupted first
      action: { label: t('service.release'), disabled: !canRelease(structure),
        tip: t(canRelease(structure) ? 'service.release.tip' : 'service.release.blocked'), onClick: () => this.#act(structure, { type: 'serviceRelease' }) },
    };
  }

  /** Service command for the bay (src/game/Repair.js runs it in the simulation) */
  #act(structure, cmd) { this.buildMenu.submit({ ...cmd, bay: structure.eid }); }

  #queueMech(structure) {
    if (structure.service) { this.buildMenu.notify(t('assembly.blockedByService')); return; }
    if (!this.#complete) return;
    // The simulation takes the parts, pays and clears the bay's draft (Production 'queueMech')
    this.buildMenu.submit({ type: 'queueMech', producer: structure.eid, loadout: { ...this.loadout } });
  }

  // ---------- hologram in the bay ----------

  /** Per frame (BuildMenu.update): hologram of every own assembly bay */
  update(dt) {
    const world = this.buildMenu.world;
    const production = this.queue;
    if (!production) return;
    const selected = this.buildMenu.input.selectedStructure;
    for (const s of world.structures) {
      if (s.destroyed || !s.produces.includes('mech')) continue;
      if (s.team !== this.team) { this.#foreignHologram(s, dt); continue; }
      const item = production.itemsOf(this.buildMenu.producerId(s))[0];
      // (s.assemblyBusy – no mech drives in for service – is kept by the simulation, Production.update)
      // A serviced mech stands in the bay itself: no mech hologram, only the part being mounted (#servicePart)
      const slots = s.service ? null
        : item?.kind === 'mech' ? this.#assemblySlots(item) : s === selected ? this.#previewSlots() : null;
      const holo = slots ? this.#hologramOf(s) : this.holograms.get(s);
      if (slots) holo.show(slots); else holo?.hide();
      holo?.update(dt);
      this.#servicePart(s, dt);
    }
    for (const [s, holo] of this.holograms) {
      if (s.destroyed || s.removed) { holo.dispose(); this.holograms.delete(s); }
    }
    for (const [s, holo] of this.partHolograms) {
      if (s.destroyed || s.removed) { holo.dispose(); this.partHolograms.delete(s); }
    }
  }

  /**
   * Hologram of another team's bay [reminder 16]: only the mech being assembled (no preview, no service), and only
   * while the local player sees the building (fog of the local team). Display only – nothing here touches the simulation.
   */
  #foreignHologram(s, dt) {
    const fog = this.buildMenu.world.fog;
    const item = this.queue.itemsOf(this.buildMenu.producerId(s))[0];
    const seen = item?.kind === 'mech' && item.loadout && (!fog || fog.canTeamSee(localTeam(), s));
    const holo = seen ? this.#hologramOf(s) : this.holograms.get(s);
    if (!holo) return;
    holo.seenByLocal = Boolean(seen);
    if (seen) holo.show(this.#assemblySlots(item)); else holo.hide();
    holo.update(dt);
  }

  #frame(slot) { return { path: framePart(this.catalog, slot)?.path, frame: true }; }

  /** Part being swapped onto the serviced mech: hologram in its slot until it is mounted (a removed arm shows none) */
  #servicePart(s, dt) {
    const task = s.service?.task;
    const swap = task?.type === 'swap' && task.path ? task : null;
    let holo = this.partHolograms.get(s);
    if (!swap) { holo?.hide(); return; }
    if (!holo) { holo = new PartHologram(); this.partHolograms.set(s, holo); }
    holo.show(s.service.mech, swap.slot, swap.path, { mounting: swap.mounting });
    holo.update(dt);
  }

  /** Mech being assembled: parts appear one by one with the progress, Frame until then (and for empty arms) */
  #assemblySlots(item) {
    const { loadout } = item; // sim queue item of kind 'mech'
    const parts = MECH_SLOTS.filter((s) => loadout[s]);
    const done = Math.floor(progressOf(item) * (parts.length + 1)); // the last part appears before the mech leaves
    return Object.fromEntries(MECH_SLOTS.map((s) => {
      const i = parts.indexOf(s);
      return [s, i >= 0 && i < done ? { path: loadout[s], frame: false } : this.#frame(s)];
    }));
  }

  /** Preview of the current choice while the bay is selected: chosen parts, Frame for a missing required part */
  #previewSlots() {
    this.#refreshLoadout();
    return Object.fromEntries(MECH_SLOTS.map((s) => [s,
      this.loadout[s] ? { path: this.loadout[s], frame: false } : this.#optional(s) ? null : this.#frame(s)]));
  }

  #hologramOf(s) {
    let holo = this.holograms.get(s);
    if (!holo) {
      holo = new MechHologram();
      holo.owner = s.team;
      holo.position.set(s.position.x, s.position.y + (s.bodyHeight ?? 0) + HOLOGRAM.heightOffset, s.position.z);
      holo.rotation.y = s.rotation.y;
      this.buildMenu.world.scene.add(holo);
      this.holograms.set(s, holo);
    }
    return holo;
  }
}
