// Steel Men – diplomacy commands (docs/notes/b4-diplomacy.md).
//   { type: DIPLOMACY.commandType ('sendTribute'), team, to, resource, amount }
//     team gives `amount` (whole number > 0) of `resource` to the living ally `to`; stats.json
//     rules.diplomacy.tributeLoss of it is lost on the way. The receiver's storage cap (energy) is respected: when it
//     cannot take everything, the sender pays only what is needed for what arrives. Nothing arrives = dropped.
//   tributeQuote(world, team, to, resource, amount)
//     → { ok, paid, delivered, room, reason } – the exact outcome, used by the UI preview and by the simulation.
//       reason: null | 'match' | 'infinite' | 'ally' | 'resource' | 'amount' | 'funds' | 'full'
//       ('infinite' = [D1] start multiplier ∞: tributes are disabled)
import { registerCommand } from './CommandBus.js';
import { DIPLOMACY } from '../../config.js';
import { getStats } from '../../data/Stats.js';
import { areAllies } from '../Alliances.js';

const QUOTE = { ok: false, paid: 0, delivered: 0, room: 0, reason: null }; // reused result (read it synchronously)

const fail = (reason) => {
  QUOTE.ok = false; QUOTE.paid = 0; QUOTE.delivered = 0; QUOTE.room = 0; QUOTE.reason = reason;
  return QUOTE;
};

/** Share of a tribute that arrives (1 − rules.diplomacy.tributeLoss) */
export function tributeKeep() {
  const loss = getStats().rules.diplomacy?.tributeLoss ?? 0;
  return Math.min(1, Math.max(0, 1 - loss));
}

/**
 * Smallest whole `paid` (≤ amount) with floor(paid × keep) ≥ delivered. Starts at the estimate ceil(delivered / keep)
 * and corrects floating-point rounding by whole steps (at most a step or two). Requires delivered ≤ floor(amount × keep).
 */
function minimalPaid(delivered, keep, amount) {
  let paid = Math.min(amount, Math.max(1, Math.ceil(delivered / keep)));
  while (paid > 1 && Math.floor((paid - 1) * keep) >= delivered) paid--;
  while (paid < amount && Math.floor(paid * keep) < delivered) paid++;
  return paid;
}

/** A team still in the match and not out (eliminated / surrendered / left) */
function playing(match, team) {
  return match.teams.includes(team) && !match.eliminated.has(team);
}

/**
 * Exact outcome of a tribute. The returned object is shared: copy what you need before the next call.
 * @returns {{ok: boolean, paid: number, delivered: number, room: number, reason: string|null}}
 */
export function tributeQuote(world, team, to, resource, amount) {
  const eco = world.economy;
  const match = world.match;
  if (!eco || !match || match.result) return fail('match');
  if (eco.infiniteResources) return fail('infinite'); // [D1] resources never decrease: a tribute would create them
  if (!Number.isInteger(team) || !Number.isInteger(to) || team === to || !areAllies(team, to)
    || !playing(match, team) || !playing(match, to)) return fail('ally');
  if (typeof resource !== 'string' || !eco.resources.includes(resource)) return fail('resource');
  if (!Number.isInteger(amount) || amount <= 0 || amount > DIPLOMACY.maxAmount) return fail('amount');
  if (eco.amount(team, resource) < amount) return fail('funds');
  const keep = tributeKeep();
  const room = Math.max(0, Math.floor(eco.capOf(resource, to) - eco.amount(to, resource))); // Infinity for ore
  const full = Math.floor(amount * keep);
  const delivered = Math.min(full, room);
  if (delivered <= 0) return fail(room <= 0 ? 'full' : 'amount');
  // Cap reached: pay only what is needed for `delivered` (never more than asked)
  const paid = delivered === full ? amount : minimalPaid(delivered, keep, amount);
  QUOTE.ok = true; QUOTE.paid = paid; QUOTE.delivered = delivered; QUOTE.room = room; QUOTE.reason = null;
  return QUOTE;
}

registerCommand(DIPLOMACY.commandType, {
  validate: (world, cmd) => tributeQuote(world, cmd.team, cmd.to, cmd.resource, cmd.amount).ok,
  execute: (world, cmd) => {
    const q = tributeQuote(world, cmd.team, cmd.to, cmd.resource, cmd.amount);
    if (!q.ok) return null;
    const paid = q.paid;
    const delivered = q.delivered;
    const eco = world.economy;
    eco.add(cmd.team, cmd.resource, -paid, DIPLOMACY.flowKinds.sent);
    eco.add(cmd.to, cmd.resource, delivered, DIPLOMACY.flowKinds.received);
    return { paid, delivered }; // local result for UI feedback (CommandBus.onExecuted)
  },
});
