// Steel Men – helpers for the alliance choice in the menus (new game and lobby). Pure functions, no DOM.
// An alliance layout is an array indexed by seat: alliances[seat] = alliance id (number). Seats with the same id are
// allies. The simulation gets the normalised layout (src/game/Alliances.js setAlliances), see docs/notes/n5-contract.md.
import { PLAYERS_UI } from '../config.js';

/** Label of an alliance id: 0 = "A", 1 = "B", … */
export const allianceLetter = (id) => PLAYERS_UI.allianceLetters[id] ?? String(id + 1);

/** Everybody alone: [0, 1, 2, …] */
export const ffaAlliances = (count) => Array.from({ length: count }, (_, i) => i);

/** Quick team layout for a player count (e.g. 2 on 2), or null when there is none */
export const presetAlliances = (count) => PLAYERS_UI.presets[count]?.alliances.slice() ?? null;

/** Dense ids in order of first appearance: [1, 1, 0, 0] -> [0, 0, 1, 1] */
export function normalizeAlliances(alliances) {
  const ids = new Map();
  return alliances.map((a) => {
    if (!ids.has(a)) ids.set(a, ids.size);
    return ids.get(a);
  });
}

/** How many different alliances the layout has */
export const allianceCount = (alliances) => new Set(alliances).size;

/** True when the layout can produce a winner (at least PLAYERS_UI.minAlliances different alliances) */
export const hasEnoughAlliances = (alliances) => allianceCount(alliances) >= PLAYERS_UI.minAlliances;

/** An id that is a whole number in 0..max-1 */
export const isAllianceId = (v, max) => Number.isInteger(v) && v >= 0 && v < max;
