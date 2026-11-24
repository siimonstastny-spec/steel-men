// Steel Men – identities of computer players: a call sign and an avatar index (docs/notes/n6-ainames.md).
// Pure functions, no DOM. The avatar of a name is its index in AI_PLAYERS.names (Avatar.js draws it from the index).
//
//   hashSeed(text)                      string -> 32-bit seed (e.g. the lobby code)
//   pickAiIndex(seed, usedIndices)      name index: deterministic from the seed, first one not in usedIndices
//   pickAiNames(count, seed, taken?)    count identities { name, avatar } for seats 0..count-1, no repeats while names last
//   aiIdentity(index)                   { name, avatar }
//   cleanAiIdentity({ aiName, avatar }) validated identity of data that came over the network (or null without a name)
import { AI_PLAYERS } from '../config.js';

const NAMES = AI_PLAYERS.names;

/** FNV-1a of a string as an unsigned 32-bit number */
export function hashSeed(text) {
  let h = AI_PLAYERS.hashBasis >>> 0;
  const s = String(text ?? '');
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), AI_PLAYERS.hashPrime) >>> 0;
  return h;
}

/** The identity of a name index (index wraps around the list) */
export function aiIdentity(index) {
  const i = ((Math.trunc(index) % NAMES.length) + NAMES.length) % NAMES.length;
  return { name: NAMES[i], avatar: i };
}

/** Name index chosen by the seed; when it is used already, the next free one (all used: the seed's own pick) */
export function pickAiIndex(seed, usedIndices = []) {
  const used = new Set(usedIndices);
  const start = (Number(seed) >>> 0) % NAMES.length;
  for (let k = 0; k < NAMES.length; k++) {
    const i = (start + k) % NAMES.length;
    if (!used.has(i)) return i;
  }
  return start;
}

/**
 * Identities for `count` seats from one seed. Seat k starts its search at seed + k * seedStep, so the result differs per
 * seed but is the same for everybody who knows the seed. `taken` = name indices that must not be used.
 */
export function pickAiNames(count, seed, taken = []) {
  const used = [...taken];
  const out = [];
  for (let team = 0; team < count; team++) {
    const i = pickAiIndex((Number(seed) >>> 0) + Math.imul(team, AI_PLAYERS.seedStep), used);
    used.push(i);
    out.push(aiIdentity(i));
  }
  return out;
}

/** Name indices already used by a list of seats / identities ({ aiName } or { name }) */
export function usedNameIndices(list) {
  const out = [];
  for (const e of list ?? []) {
    const n = e?.aiName ?? e?.name;
    const i = typeof n === 'string' ? NAMES.indexOf(n) : -1;
    if (i >= 0) out.push(i);
  }
  return out;
}

/**
 * Validated identity of untrusted data (seat from the network): { name, avatar } or null when there is no usable name.
 * The avatar must be a non-negative whole number, else it follows from the name.
 */
export function cleanAiIdentity(src) {
  const name = typeof src?.aiName === 'string' ? src.aiName.trim().slice(0, AI_PLAYERS.nameMaxLength) : '';
  if (!name) return null;
  const listed = NAMES.indexOf(name);
  const avatar = Number.isInteger(src.avatar) && src.avatar >= 0 ? src.avatar : (listed >= 0 ? listed : hashSeed(name) % NAMES.length);
  return { name, avatar };
}
