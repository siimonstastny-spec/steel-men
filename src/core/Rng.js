// Steel Mans – seeded pseudo-random generator for the simulation (mulberry32: 32-bit state, fast, good enough
// for games). Every random decision that changes the simulation (hit rolls, scatter, drops…) must use the
// world's generator `world.rng`, never Math.random – two clients with the same seed and the same commands then
// roll the same numbers in the same order (lockstep multiplayer, replays). Purely visual randomness (explosion
// spin, animation phase) may keep Math.random as long as it never feeds back into the simulation.
//   const rng = new Rng(seed);  rng.next() in [0, 1);  rng.range(a, b);  rng.int(n);  rng.chance(p)
//   rng.state / rng.setState(s) – the whole generator state is one uint32 (state hashes, save / restore)

const GOLDEN = 0x6d2b79f5;          // mulberry32 increment
const UINT32 = 4294967296;          // 2^32 – maps a uint32 to [0, 1)
const FNV_OFFSET = 0x811c9dc5;      // FNV-1a, used to turn string seeds into numbers
const FNV_PRIME = 0x01000193;

/** uint32 from a number or a string seed (e.g. a room id from the host) */
export function seedFrom(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  let h = FNV_OFFSET;
  for (const ch of String(value)) h = Math.imul(h ^ ch.codePointAt(0), FNV_PRIME);
  return h >>> 0;
}

/** A fresh random seed for a new single-player match (not part of the simulation itself) */
export function randomSeed() {
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  return Math.floor(Math.random() * UINT32) >>> 0;
}

export class Rng {
  /** @param {number|string} [seed] */
  constructor(seed = 0) {
    this.state = 0;
    this.seed(seed);
  }

  /** Restarts the sequence from a seed (number or string) */
  seed(value) {
    this.state = seedFrom(value);
    return this;
  }

  /** Restores a state read from `rng.state` */
  setState(state) {
    this.state = state >>> 0;
    return this;
  }

  /** Uniform float in [0, 1) */
  next() {
    this.state = (this.state + GOLDEN) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32;
  }

  /** Uniform float in [a, b) */
  range(a, b) { return a + (b - a) * this.next(); }

  /** Uniform integer in [0, n) */
  int(n) { return Math.floor(this.next() * n); }

  /** true with probability p */
  chance(p) { return this.next() < p; }

  /** Uniform angle in [0, 2π) */
  angle() { return this.next() * Math.PI * 2; }
}
