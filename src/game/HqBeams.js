// Steel Men – beam into the sky above every finished main building (stats.json `hq: true`) in its owner's colour.
// Purely visual: it reads the world, never changes it. Wiring (main.js): `const hqBeams = new HqBeams(world)` once,
// then `hqBeams.update()` every simulation tick or frame – it creates a beam for each finished hq (also a captured
// or late-built one) and Effects.beam releases it when the building is destroyed. Look: R2.hqBeam in config.js.
import { TEAMS } from '../config.js';

export class HqBeams {
  constructor(world) {
    this.world = world;
    this.beams = new Map(); // structure -> { dispose }
  }

  update() {
    const { world } = this;
    for (const s of world.structures) {
      if (this.beams.has(s) || !s.stats?.hq || !s.complete || s.destroyed || s.removed) continue;
      const color = TEAMS[s.team]?.color ?? '#ffffff';
      this.beams.set(s, world.effects.beam(s, color, () => world.isVisible(s)));
    }
    for (const [s, beam] of this.beams) {
      if (s.destroyed || s.removed) { beam.dispose(); this.beams.delete(s); }
    }
  }

  dispose() {
    for (const beam of this.beams.values()) beam.dispose();
    this.beams.clear();
  }
}
