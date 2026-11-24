// Steel Men – alliances of the running match (docs/notes/n5-contract.md, docs/notes/n5a-sim.md).
//
// Seat = team index (unit.team). alliances[team] = alliance id (any integer); teams with the same id are allies:
// they never shoot each other (Combat.areEnemies), share the fog of war (FogOfWar) and win together (Match).
// Economy, research, production and unit control stay per team.
// The table is part of the simulation: set it once at match start from the game settings (identical on every
// client), before any unit is added. Default (nothing set) = every team on its own, like before alliances existed.
//   setAlliances(arr)                   arr[team] = alliance id; invalid / missing = everybody alone
//   normalizeAlliances(count, arr)      valid table of length count (everybody alone when arr does not fit)
//   allianceOf(team)                    alliance id, or null for a team outside the table
//   areAllies(a, b)                     team numbers; a team is always allied with itself
//   teamsOfAlliance(id)                 member teams, ascending
//   alliesOf(team)                      other members of the team's alliance, ascending
//   allianceLeader(team)                lowest team of the team's alliance (the team itself outside the table)
//   allianceIds()                       distinct ids in seat order (order of first appearance)
//   startOrder(count, alliances, map)   start position index for each seat
//   clampPlayerCount(value)             settings.playerCount -> PLAYERS.min..MAX_PLAYERS (missing = PLAYERS.default)
import { MAX_PLAYERS, PLAYERS } from '../config.js';

let table = [];    // team -> alliance id
let leaders = [];  // team -> lowest team with the same alliance id

/** Everybody alone: [0, 1, …, count - 1] */
const everybodyAlone = (count) => Array.from({ length: count }, (_, team) => team);

/**
 * A valid alliance table for `count` seats: arr when it has an integer for every seat, else everybody alone.
 * @param {number} count
 * @param {number[]} [arr]
 * @returns {number[]}
 */
export function normalizeAlliances(count, arr) {
  if (!Array.isArray(arr) || arr.length < count) return everybodyAlone(count);
  const out = arr.slice(0, count);
  return out.every((id) => Number.isInteger(id)) ? out : everybodyAlone(count);
}

/**
 * Sets the alliances of the match (call at match start, before any unit is added).
 * @param {number[]} [arr]  arr[team] = alliance id; missing / invalid = everybody alone
 */
export function setAlliances(arr) {
  table = Array.isArray(arr) && arr.every((id) => Number.isInteger(id)) ? [...arr] : [];
  leaders = table.map((id) => table.indexOf(id));
}

/** Alliance id of a team, or null when the team is not in the table */
export function allianceOf(team) {
  return Number.isInteger(team) && team >= 0 && team < table.length ? table[team] : null;
}

/** Same team, or both teams in the table with the same alliance id. Hot path (every enemy check) – keep it cheap. */
export function areAllies(a, b) {
  if (a === b) return true;
  const ia = table[a];
  return ia !== undefined && ia === table[b];
}

/** Member teams of an alliance, ascending */
export function teamsOfAlliance(id) {
  const out = [];
  table.forEach((a, team) => { if (a === id) out.push(team); });
  return out;
}

/** The other members of the team's alliance, ascending (empty outside the table) */
export function alliesOf(team) {
  const id = allianceOf(team);
  return id === null ? [] : teamsOfAlliance(id).filter((t) => t !== team);
}

/** Lowest team of the team's alliance – allied teams share everything keyed by it (fog grids) */
export function allianceLeader(team) {
  return leaders[team] ?? team;
}

/** Distinct alliance ids in seat order */
export function allianceIds() {
  return [...new Set(table)];
}

/**
 * Start position index for each seat. Two players on their own: start 0 and the start opposite it (as before
 * alliances). Otherwise the starts are walked around the map centre beginning at start 0; each alliance takes a
 * block of neighbouring starts (allies side by side), and the blocks are spread evenly around the ring (enemies
 * face each other). Members of an alliance are placed in seat order. Deterministic: depends only on the arguments.
 * @param {number} count       number of seats in the match
 * @param {number[]} alliances alliance id per seat (normalizeAlliances)
 * @param {{startPositions: {x:number, z:number}[], opposite: (i:number) => number}} map
 * @returns {number[]} index into map.startPositions for each seat
 */
export function startOrder(count, alliances, map) {
  const starts = map.startPositions;
  const total = starts.length;
  const ids = normalizeAlliances(count, alliances);
  const distinct = [...new Set(ids)];
  if (total === 0) return everybodyAlone(count).map(() => 0);
  if (count > total) return everybodyAlone(count).map((seat) => seat % total); // map too small: starts are reused
  if (count === 2 && distinct.length === 2) return [0, map.opposite(0)];
  const ring = ringFrom(starts, 0);
  const order = new Array(count);
  const blocks = distinct.map((id) => everybodyAlone(count).filter((seat) => ids[seat] === id));
  let next = 0;        // first free ring slot
  let left = count;    // seats not placed yet
  blocks.forEach((seats, j) => {
    const even = Math.round((j * total) / blocks.length);
    const first = Math.min(Math.max(even, next), total - left);
    seats.forEach((seat, k) => { order[seat] = ring[first + k]; });
    next = first + seats.length;
    left -= seats.length;
  });
  return order;
}

/** Start indices sorted by angle around the map centre, rotated so that `first` comes first */
function ringFrom(starts, first) {
  const angle = (p) => Math.atan2(p.x, p.z);
  const sorted = starts.map((p, i) => i).sort((a, b) => angle(starts[a]) - angle(starts[b]) || a - b);
  const at = sorted.indexOf(first);
  return [...sorted.slice(at), ...sorted.slice(0, at)];
}

/**
 * Number of players from the game settings, clamped to PLAYERS.min..MAX_PLAYERS; missing = PLAYERS.default.
 * @param {number} [value]
 */
export function clampPlayerCount(value) {
  if (!Number.isInteger(value)) return PLAYERS.default;
  return Math.min(MAX_PLAYERS, Math.max(PLAYERS.min, value));
}
