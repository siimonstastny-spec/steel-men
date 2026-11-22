// Steel Mans – which start position each seat gets (docs/notes/maps.md).
// Picked starts (map preview click, lobby) win; the other seats get a start from the match seed while allies stay
// side by side (Alliances.startOrder layout, turned around the ring). Maps with startAssignment 'fixed'
// (gen_01AI) keep the old order for unpicked seats, so old games / ?seed=42 checks are unchanged.
// Pure function, own generator (never world.rng): the same inputs give the same starts on every client.
import { startOrder, normalizeAlliances } from './Alliances.js';
import { seededRandom, hashSeed } from './AsciiMap.js';

/**
 * @param {object} p
 * @param {import('./Map.js').GameMap} p.map
 * @param {number} p.count              seats in the match
 * @param {number[]} [p.alliances]      alliance id per seat
 * @param {object|Array} [p.picks]      picks[seat] = start index (from the preview); invalid / duplicate ones are ignored
 * @param {number|string} [p.seed]      match seed
 * @returns {number[]} start index per seat (index into map.startPositions)
 */
export function assignStarts({ map, count, alliances, picks = null, seed = 0 }) {
  const starts = map.startPositions;
  const total = starts.length;
  let base = startOrder(count, alliances, map);
  if (map.startAssignment !== 'fixed' && total > 1) base = seededLayout(base, map, count, alliances, seed);
  if (!picks || total === 0) return base;

  const out = new Array(count).fill(-1);
  const used = new Set();
  for (let seat = 0; seat < count; seat++) {
    const p = picks[seat];
    if (Number.isInteger(p) && p >= 0 && p < total && !used.has(p)) {
      out[seat] = p;
      used.add(p);
    }
  }
  for (let seat = 0; seat < count; seat++) {
    if (out[seat] < 0 && !used.has(base[seat])) { out[seat] = base[seat]; used.add(base[seat]); }
  }
  const ring = ringOrder(starts);
  for (let seat = 0; seat < count; seat++) {
    if (out[seat] >= 0) continue;
    const from = ring.indexOf(base[seat]);
    let free = -1;
    for (let k = 0; k < total && free < 0; k++) { const s = ring[(from + k) % total]; if (!used.has(s)) free = s; }
    out[seat] = free >= 0 ? free : base[seat]; // more seats than starts: reuse (as startOrder does)
    used.add(out[seat]);
  }
  return out;
}

/** Valid picks only: { seat: startIndex } without duplicates or out-of-range values (UI / lobby settings) */
export function cleanPicks(picks, count, total) {
  const out = {};
  const used = new Set();
  for (let seat = 0; seat < count; seat++) {
    const p = picks?.[seat];
    if (Number.isInteger(p) && p >= 0 && p < total && !used.has(p)) { out[seat] = p; used.add(p); }
  }
  return out;
}

// Same layout as startOrder, shifted around the ring of starts by a seeded amount (2 players: a seeded start and
// the one opposite to it)
function seededLayout(base, map, count, alliances, seed) {
  const total = map.startPositions.length;
  const rand = seededRandom(hashSeed('starts', map.id, seed));
  const ids = normalizeAlliances(count, alliances);
  if (count === 2 && ids[0] !== ids[1]) {
    const k = Math.floor(rand() * total);
    return [k, map.opposite(k)];
  }
  if (count > total) return base;
  const ring = ringOrder(map.startPositions);
  const shift = Math.floor(rand() * total);
  return base.map((i) => ring[(ring.indexOf(i) + shift) % total]);
}

// Start indices sorted by angle around the map centre (same order as Alliances.startOrder's ring)
function ringOrder(starts) {
  const angle = (p) => Math.atan2(p.x, p.z);
  return starts.map((_, i) => i).sort((a, b) => angle(starts[a]) - angle(starts[b]) || a - b);
}
