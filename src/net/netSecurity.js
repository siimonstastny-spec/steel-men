// Steel Men – limits and checks for data that arrives from other players (docs/notes/mp-security.md).
// The SAME check runs on the sender (own commands) and on every receiver, so what a client executes locally is exactly
// what the others accept (otherwise a rejected command would desync the match).
// NOTE: constants live here because src/config.js is not part of this task; the coordinator may move them to config.js.

export const NET_SECURITY = {
  maxCommandsPerTurn: 256,   // commands (+ control entries) of one player in one turn; more are dropped on the sender
  controlSlots: 2,           // of those, reserved for control entries (pause, speed) that bypass the local check
  maxParts: 16,              // a turn split into more message parts is garbage
  maxCoord: 100000,          // a coordinate (key x / y / z anywhere in a command) must be finite and within ±this
  maxAbsNumber: 2147483647,  // any other number (entity ids grow all match long, counts) must be finite and within ±this
  coordKeys: ['x', 'y', 'z'],
  maxCommandDepth: 6,        // nesting depth of a command object
  maxTypeLength: 64,         // length of a command type name
  maxTeam: 15,               // upper bound of cmd.team (real limit = team count of the match; this only rejects garbage)
  maxIncomingChars: 16384,   // a 'turn' message whose JSON is longer is ignored (legit ≤ NET.maxMessageBytes = 4096 B)
  maxPeerIdLength: 128,      // length of a player id in a lobby / start payload
  helloMinIntervalMs: 250,   // host: answers a client's 'hello' (full lobby publish) at most this often
};

/** Number of JSON characters of a value (Infinity when it cannot be serialised) */
export function jsonLength(value) {
  try { return JSON.stringify(value).length; } catch { return Infinity; }
}

function walk(v, depth, limits, coord) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v) && Math.abs(v) <= (coord ? limits.maxCoord : limits.maxAbsNumber);
  if (typeof v !== 'object' || depth > limits.maxCommandDepth) return false;
  if (Array.isArray(v)) return v.every((x) => walk(x, depth + 1, limits, false));
  for (const key of Object.keys(v)) if (!walk(v[key], depth + 1, limits, limits.coordKeys.includes(key))) return false;
  return true;
}

/**
 * Is this a well-formed command object? (plain JSON, integer team, bounded numbers / depth / size). Does not check
 * WHICH team may be commanded (Lockstep.#mayCommand) or whether the type exists (CommandBus).
 * @param {object} c
 * @param {number} maxBytes  NET.maxCommandBytes
 */
export function wellFormedCommand(c, maxBytes, limits = NET_SECURITY) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
  if (typeof c.type !== 'string' || !c.type || c.type.length > limits.maxTypeLength) return false;
  if (!Number.isInteger(c.team) || c.team < 0 || c.team > limits.maxTeam) return false;
  if (jsonLength(c) > maxBytes) return false;
  return walk(c, 0, limits, false);
}
