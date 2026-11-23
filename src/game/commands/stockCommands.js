// Steel Mans – part stock commands [F1] (docs/notes/f1-inventory.md). Import this module once so the command registers
// (StockWindow.js imports it). Schema:
//   { type: 'sellPart', team, path, count }   path = stock key (an arm of either side is accepted), count 1..in stock
// Selling returns rules.production.partSellFactor of the part's cost (ore AND energy, floored) at once. Allowed only
// while the team owns a finished building producing 'part' or 'mech' (PART_SALE.requiredProducers). Parts of any
// faction (salvage) sell for the same share – the price comes from the part's own stats. Deterministic: the stock
// and economy are changed only here, inside the commandBus tick. The AI does not use it.
import { registerCommand } from './CommandBus.js';
import { getStats, partStats } from '../../data/Stats.js';
import { PART_SALE } from '../../config.js';
import { catalogSlot, stockKey, MECH_SLOTS } from '../PartStock.js';

const REASON = { ok: '', team: 'team', part: 'part', stock: 'stock', building: 'building' };

/** Share of the cost returned for a sold part (stats.json rules.production.partSellFactor) */
export const sellFactor = () => getStats().rules.production?.partSellFactor ?? 0;

/** Does the team own a finished building that produces parts or mechs (condition of selling)? */
export function canSellParts(world, team) {
  for (const s of world.structures) {
    if (s.team !== team || s.destroyed || s.removed || !s.complete) continue;
    if (PART_SALE.requiredProducers.some((p) => s.produces?.includes(p))) return true;
  }
  return false;
}

/** Catalog slot of a stock key (legs | torso | leftArm), or null when it is no catalog part */
export function slotOfPath(catalog, path) {
  for (const slot of MECH_SLOTS) {
    if (catalog?.[catalogSlot(slot)]?.some((p) => p.path === path)) return catalogSlot(slot);
  }
  return null;
}

/** Sale value of ONE part: { ore, energy } (floored share of its cost), or null for an unknown part */
export function sellValue(world, team, path) {
  const key = stockKey(path);
  const slot = slotOfPath(world.production?.catalog, key);
  if (!slot) return null;
  const cost = partStats(key, slot, world.production.raceOf(team)).cost ?? {};
  const f = sellFactor();
  return { ore: Math.floor((cost.ore ?? 0) * f), energy: Math.floor((cost.energy ?? 0) * f) };
}

/** { ok, reason, count, gain: { ore, energy } } – what selling `count` pieces would do (used by validate, execute and the UI) */
export function sellQuote(world, cmd) {
  const team = cmd?.team;
  const stock = world.economy?.parts;
  if (!Number.isInteger(team) || !stock?.counts[team]) return { ok: false, reason: REASON.team };
  if (typeof cmd.path !== 'string') return { ok: false, reason: REASON.part };
  const have = stock.count(team, cmd.path);
  const wanted = cmd.count === undefined ? 1 : cmd.count;
  if (!Number.isInteger(wanted)) return { ok: false, reason: REASON.stock }; // NaN / fractions are refused, not rounded
  const count = Math.min(wanted, PART_SALE.maxCountClamp);
  if (count < 1 || have < count) return { ok: false, reason: REASON.stock };
  const one = sellValue(world, team, cmd.path);
  if (!one) return { ok: false, reason: REASON.part };
  if (!canSellParts(world, team)) return { ok: false, reason: REASON.building };
  return { ok: true, reason: REASON.ok, count, gain: { ore: one.ore * count, energy: one.energy * count } };
}

registerCommand(PART_SALE.commandType, {
  validate: (world, cmd) => sellQuote(world, cmd).ok,
  execute: (world, cmd) => {
    const q = sellQuote(world, cmd);
    if (!q.ok) return;
    const eco = world.economy;
    for (let i = 0; i < q.count; i++) eco.parts.take(cmd.team, cmd.path);
    // kind 'refund': the match statistics count it as money taken back from spending (no separate flow kind yet)
    if (q.gain.ore) eco.add(cmd.team, 'ore', q.gain.ore, 'refund');
    if (q.gain.energy) eco.add(cmd.team, 'energy', q.gain.energy, 'refund');
  },
});
