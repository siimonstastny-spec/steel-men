// Steel Mans – view adapter of the local player's production queues for the HUD (queue strip) and UnitOverlays
// (progress bar at the producer). The queues themselves live in the simulation (world.production,
// src/game/Production.js); this only reads them for localTeam(), adds display label / icon, and turns a cancel
// click into a 'cancelProduction' command. View items are cached per sim item id, so they stay the same object
// while the item exists (UnitOverlays keys its bars by item):
//   { id, producer (structure eid), kind, icon, label, elapsed, total }  (elapsed / total read live)
import { ROBOT_PRODUCTION, RESEARCH } from '../config.js';
import { t } from '../i18n/i18n.js';
import { localTeam } from '../core/LocalPlayer.js';
import { commandBus } from '../game/commands/CommandBus.js';
import '../game/commands/productionCommands.js';
import { unitName } from './BuildMenu.js';
import { researchName } from './ResearchView.js';

/** Grid / queue icon per production item kind */
export const ITEM_ICONS = {
  vehicle: '🚚', crew: '👥', part: ROBOT_PRODUCTION.partIcon, mech: ROBOT_PRODUCTION.mechIcon,
  research: RESEARCH.researchIcon, analysis: RESEARCH.analysisIcon,
};

/** Display name of a sim production item */
export function itemLabel(item, world) {
  switch (item.kind) {
    case 'vehicle': return unitName('vehicles', item.unitId);
    case 'crew': return t('grid.training');
    case 'part': return `${t(`part.${item.slot}`)}: ${item.set}`;
    case 'mech': return t('assembly.mech');
    case 'research': return researchName(item.researchId, world?.research?.defs?.[item.researchId]);
    case 'analysis': return t('research.analysis', { set: item.set, kind: t(`research.kind.${item.lootKind}`) });
    default: return item.kind;
  }
}

export class ProductionQueue {
  /** @param {object} world  reads world.production */
  constructor(world) {
    this.world = world;
    this.views = new Map(); // sim item id -> view item
  }

  get production() { return this.world.production ?? null; }

  #view(item) {
    let v = this.views.get(item.id);
    if (!v) {
      const world = this.world;
      v = {
        id: item.id, producer: item.producer, kind: item.kind, icon: ITEM_ICONS[item.kind] ?? '',
        label: itemLabel(item, world), sim: item,
        get elapsed() { return item.elapsed; },
        get total() { return item.total; },
      };
      this.views.set(item.id, v);
    }
    return v;
  }

  /** Items of one producer (structure eid), first = in progress – the sim items themselves */
  itemsOf(producer) { return this.production?.itemsOf(producer) ?? []; }

  isFull(producer) { return this.production?.isFull(producer) ?? false; }

  /** Local player's items, producer by producer (eid order); the first of each queue is in progress */
  get items() { return (this.production?.itemsOfTeam(localTeam()) ?? []).map((i) => this.#view(i)); }

  /** Local player's items in progress */
  get active() { return (this.production?.activeOfTeam(localTeam()) ?? []).map((i) => this.#view(i)); }

  /** Cancel click: a command (the refund happens in the simulation) */
  cancel(id) { commandBus.submit({ type: 'cancelProduction', team: localTeam(), itemId: id }); }

  /** Per frame: forgets views of finished / cancelled items */
  update() {
    if (!this.views.size) return;
    for (const id of [...this.views.keys()]) if (!this.production?.itemById(id)) this.views.delete(id);
  }
}

/**
 * [W3] The head item of a queue is not running yet because its deferred cost (energy) is not paid (Production.update):
 * `item.due` still holds an amount. Only the first item of a queue can wait; the others wait for their turn anyway.
 */
export function isWaitingEnergy(item, economy) {
  const sim = item.sim ?? item;
  return Boolean(sim.due) && Boolean(economy?.hasDue(sim.due));
}

/** Progress 0..1 of a queue item (sim item or view item) */
export const progressOf = (item) => (item.total > 0 ? Math.min(1, item.elapsed / item.total) : 1);
