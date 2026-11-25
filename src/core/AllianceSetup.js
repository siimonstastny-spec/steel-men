// Steel Men – helpers for the alliance choice in the menus (new game and lobby). Pure functions, no DOM.
// An alliance layout is an array indexed by seat: alliances[seat] = alliance id (number). Seats with the same id are
// allies. The simulation gets the normalised layout (src/game/Alliances.js setAlliances), see docs/notes/n5-contract.md.
import { PLAYERS_UI, A4_UI } from '../config.js';

/** Label of an alliance id: 0 = "A", 1 = "B", … */
export const allianceLetter = (id) => PLAYERS_UI.allianceLetters[id] ?? String(id + 1);

/** Everybody alone: [0, 1, 2, …] */
export const ffaAlliances = (count) => Array.from({ length: count }, (_, i) => i);

/** [A4-UI] Quick team layouts offered for a player count: [{ id, alliances }] (empty when there is none) */
export const alliancePresets = (count) => PLAYERS_UI.presets[count] ?? [];

/** Quick team layout for a player count by preset id (first one without id), or null when there is none */
export function presetAlliances(count, id) {
  const list = alliancePresets(count);
  const p = id ? list.find((x) => x.id === id) : list[0];
  return p ? p.alliances.slice() : null;
}

/** [A4-UI] Id of the preset the (open seats') layout equals, or null */
export function matchingPresetId(count, alliances) {
  const norm = normalizeAlliances(alliances).join();
  return alliancePresets(count).find((p) => p.alliances.join() === norm)?.id ?? null;
}

/** [A4-UI] True when so many AI play that the performance warning is shown */
export const aiPerfWarning = (aiCount) => aiCount > A4_UI.perfWarnAiAbove;

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
