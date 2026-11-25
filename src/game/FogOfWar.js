// Steel Men – fog of war for EVERY team (the simulation uses it, so it must be deterministic).
//
// Per team, a grid of FOG.cellSize cells over the map remembers which cells were ever seen (explored) and which
// are in sight of an own unit right now (visible). All teams are recomputed together every FOG.updateInterval
// seconds of SIM time (update(dt) is called from World.update with the fixed sim step – no wall clock), not every frame.
// Simulation API (never reads the local player): canTeamSee(team, unit), isPointVisibleTo(team, x, z),
// isPointExploredBy(team, x, z). The rendering / UI API below works for localTeam() only.
// [N5] Allies (src/game/Alliances.js) share one grid – sight and explored terrain – keyed by allianceLeader(team);
// without alliances every team keeps its own grid as before.
// Mode = world.settings.fogOfWar (FOG.modes):
//   'unexplored' – never-seen terrain is black, explored terrain is shrouded, enemies only within sight
//   'explored'   – the whole terrain is shown (shrouded outside sight), enemies only within sight
//   'off'        – everything visible
// The terrain and map meshes are darkened in their shader from a texture of the grid (patchMaterial);
// enemy units outside sight get object.visible = false and are filtered out of picking (World.pickables).
import * as THREE from 'three';
import { FOG, TEAMS } from '../config.js';
import { localTeam } from '../core/LocalPlayer.js';
import { areAllies, allianceLeader } from './Alliances.js';
import { sightFactor } from './Auras.js'; // [A9-buildings]

const BYTE = 255;

export class FogOfWar {
  /**
   * @param {import('./World.js').World} world
   * @param {number} size  map width = depth (units), centred on 0,0
   * @param {object} [opts]  { teamCount } – number of teams that get a sight grid (default TEAMS.length)
   */
  constructor(world, size, { teamCount = TEAMS.length } = {}) {
    this.world = world;
    this.size = size;
    this.half = size / 2;
    this.cellSize = FOG.cellSize;
    this.cols = Math.ceil(size / this.cellSize);
    const n = this.cols * this.cols;
    this.cells = n;
    this.grids = []; // team -> { visible: Uint8Array, explored: Uint8Array }
    for (let i = 0; i < teamCount; i++) this.#grid(i);
    this.timer = 0;
    this.lastMode = null;
    this.lastLocal = null;
    this.version = 0; // bumped after every recompute (the minimap redraws its fog layer then)
    this.texture = new THREE.DataTexture(new Uint8Array(n), this.cols, this.cols, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.unpackAlignment = 1; // one byte per texel – rows are not 4-byte aligned
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.wrapS = this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.uniforms = {
      fogMap: { value: this.texture },
      fogMapSize: { value: this.cols * this.cellSize }, // texture covers whole cells (may exceed the map)
    };
    this.recompute();
  }

  /** Current mode from the game settings ('unexplored' | 'explored' | 'off') */
  get mode() {
    const m = this.world.settings?.fogOfWar;
    return FOG.modes.includes(m) ? m : FOG.defaultMode;
  }

  /** The local player's team (rendering only) */
  get team() { return localTeam(); }

  /** Sight grid of the local player (the minimap reads these) */
  get visible() { return this.#grid(localTeam()).visible; }
  get explored() { return this.#grid(localTeam()).explored; }

  /** Called from World.update with the fixed sim dt: recomputes every team's sight on a sim-time cadence */
  update(dt) {
    if ((this.timer -= dt) > 0 && this.mode === this.lastMode) {
      if (this.lastLocal !== localTeam()) this.#present(); // only the viewpoint changed: no sim recompute
      return;
    }
    this.timer = FOG.updateInterval;
    this.recompute();
  }

  /** Recomputes every team's visibility from its units' sight, then refreshes texture and hidden enemies */
  recompute() {
    const mode = this.mode;
    this.lastMode = mode;
    this.grids.forEach((g) => g.visible.fill(0)); // forEach: allied teams leave holes in the array (#grid)
    if (mode !== 'off') {
      for (const unit of this.world.allUnits) {
        if (!Number.isInteger(unit.team) || !this.#sees(unit)) continue;
        this.#stamp(this.#grid(unit.team).visible, unit.position.x, unit.position.z,
          Math.max(FOG.minSight, (unit.stats?.sightRange ?? 0) * sightFactor(unit))); // [A9-buildings] recon enhancer aura
      }
      this.grids.forEach((g) => {
        for (let i = 0; i < g.visible.length; i++) if (g.visible[i]) g.explored[i] = 1;
      });
    }
    this.#present(); // bumps version
  }

  /** Can `team` see this unit? Own team and allies: always; others: only in a cell visible to that team (sim-safe) */
  canTeamSee(team, unit) {
    if (!unit || !unit.position || areAllies(unit.team, team)) return true; // no position (not a unit): nothing to hide
    if (unit.destroyed) return true; // wrecks stay visible in the fog
    if (unit.cloaked && this.world.stealth?.hiddenFrom(team, unit)) return false; // [A9-buildings] undetected cloak, any fog mode
    if (this.mode === 'off') return true;
    return this.isPointVisibleTo(team, unit.position.x, unit.position.z);
  }

  isPointVisibleTo(team, x, z) {
    if (this.mode === 'off') return true;
    return this.#grid(team).visible[this.cellAt(x, z)] === 1;
  }

  /** Terrain known to `team` (explored, or the whole map outside 'unexplored' mode) */
  isPointExploredBy(team, x, z) {
    if (this.mode !== 'unexplored') return true;
    return this.#grid(team).explored[this.cellAt(x, z)] === 1;
  }

  /** Can the local player see this unit? (display only – the simulation uses canTeamSee) */
  isVisible(unit) { return this.canTeamSee(localTeam(), unit); }

  isPointVisible(x, z) { return this.isPointVisibleTo(localTeam(), x, z); }

  isPointExplored(x, z) { return this.isPointExploredBy(localTeam(), x, z); }

  cellAt(x, z) {
    const c = (v) => THREE.MathUtils.clamp(Math.floor((v + this.half) / this.cellSize), 0, this.cols - 1);
    return c(z) * this.cols + c(x);
  }

  /**
   * Darkens a material by the fog texture (call once per material; terrain, rocks, super node…).
   * Units are not patched – enemies are hidden instead, own units are always in sight.
   */
  patchMaterial(material) {
    const uniforms = this.uniforms;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.fogMap = uniforms.fogMap;
      shader.uniforms.fogMapSize = uniforms.fogMapSize;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float fogMapSize;\nvarying vec2 vFogMapUv;')
        .replace('#include <project_vertex>',
          '#include <project_vertex>\nvec4 fogWorldPos = modelMatrix * vec4(transformed, 1.0);\nvFogMapUv = fogWorldPos.xz / fogMapSize + 0.5;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D fogMap;\nvarying vec2 vFogMapUv;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.rgb *= texture2D(fogMap, vFogMapUv).r;');
    };
    material.customProgramCacheKey = () => 'fogOfWar';
    material.needsUpdate = true;
  }

  // ---------- internal ----------

  // Grid of a team (shared by its alliance: stored under the alliance's lowest team), created on demand
  #grid(team) {
    return this.grids[allianceLeader(team)] ??= { visible: new Uint8Array(this.cells), explored: new Uint8Array(this.cells) };
  }

  // Presentation for the local player: fog texture and visibility of foreign units (no effect on the simulation)
  #present() {
    const local = localTeam();
    const mode = this.mode;
    const changed = this.lastLocal !== local;
    this.lastLocal = local;
    this.#writeTexture(mode);
    for (const unit of this.world.allUnits) {
      if (!areAllies(unit.team, local)) unit.visible = this.isVisible(unit);
      else if (changed) unit.visible = true; // seats were switched: own and allied units are never hidden
    }
    this.version++;
  }

  // Units that reveal their surroundings: alive, outside a mech (the mech sees for its crew)
  #sees(unit) {
    if (unit.destroyed || unit.removed || unit.inside || !unit.world) return false;
    const isMech = 'parts' in unit;
    return !isMech || unit.crew || FOG.crewlessMechsSee;
  }

  // Marks all cells whose centre lies within radius of x, z as visible
  #stamp(visible, x, z, radius) {
    const n = this.cols;
    const c = this.cellSize;
    const r2 = radius * radius;
    const x0 = Math.max(0, Math.floor((x - radius + this.half) / c));
    const x1 = Math.min(n - 1, Math.floor((x + radius + this.half) / c));
    const z0 = Math.max(0, Math.floor((z - radius + this.half) / c));
    const z1 = Math.min(n - 1, Math.floor((z + radius + this.half) / c));
    for (let iz = z0; iz <= z1; iz++) {
      const dz = (iz + 0.5) * c - this.half - z;
      for (let ix = x0; ix <= x1; ix++) {
        const dx = (ix + 0.5) * c - this.half - x;
        if (dx * dx + dz * dz <= r2) visible[iz * n + ix] = 1;
      }
    }
  }

  #writeTexture(mode) {
    const data = this.texture.image.data;
    const vis = Math.round(FOG.visibleBrightness * BYTE);
    const shroud = Math.round(FOG.exploredBrightness * BYTE);
    const black = Math.round(FOG.unexploredBrightness * BYTE);
    const { visible, explored } = this.#grid(localTeam());
    for (let i = 0; i < data.length; i++) {
      data[i] = mode === 'off' || visible[i] ? vis
        : mode === 'explored' || explored[i] ? shroud : black;
    }
    this.texture.needsUpdate = true;
  }
}
