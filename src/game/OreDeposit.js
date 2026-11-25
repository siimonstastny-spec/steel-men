// Steel Men – ore deposit on the map (data/maps/*.json → oreDeposits, superNode.ore). DrillTrucks park next
// to it and mine directly: ore goes straight to the team account (Vehicle harvest order). The deposit runs out
// unless the game has infinite deposits (world.settings.economy.infiniteDeposits).
//   def: { x, z, radius, amount, rateFactor, maxHarvesters, superNode? }
import * as THREE from 'three';
import { ORE_DEPOSIT } from '../config.js';
import { OreMineVisual, acquireMineMaterials, releaseMineMaterials } from './OreMineVisual.js'; // [ore-mine-visual]

export class OreDeposit {
  constructor(def, world, economy) {
    this.world = world;
    this.economy = economy;
    this.x = def.x;
    this.z = def.z;
    this.position = new THREE.Vector3(def.x, world.heightAt(def.x, def.z), def.z);
    this.radius = def.radius ?? 0;
    this.amount = (def.amount ?? 0) * (economy.depositScale ?? 1); // [B1] ore multiplier (1 = unchanged)
    this.initial = this.amount;
    this.rateFactor = def.rateFactor ?? 1;
    this.maxHarvesters = def.maxHarvesters ?? Infinity;
    this.superNode = Boolean(def.superNode);
    this.harvesters = new Set(); // vehicles mining this frame (refreshed every frame)
    this._mining = new Set();
    this.group = null;
    this.visual = null;
    this.#build(); // [ore-mine-visual] open-pit mine; the super node's apron + glow ring stay in Map.js
  }

  get infinite() { return this.economy.infiniteDeposits; }
  get depleted() { return !this.infinite && this.amount <= 0; }
  /** Share left 0..1 */
  get ratio() { return this.initial > 0 ? Math.max(0, this.amount / this.initial) : 0; }

  /** Pathfinding obstacle: the mine pit inside `radius` (the super node core is already a map obstacle) */
  get obstacle() {
    return this.superNode || !this.radius ? null : { x: this.x, z: this.z, radius: this.radius, owner: this };
  }

  /** May this vehicle mine here now? (slots are limited by maxHarvesters) */
  canHarvest(vehicle) {
    if (this.depleted) return false;
    return this.harvesters.has(vehicle) || this.harvesters.size < this.maxHarvesters;
  }

  /**
   * Takes up to `want` ore for a mining vehicle. @returns {number} ore actually taken
   */
  mine(vehicle, want) {
    if (!this.canHarvest(vehicle)) return 0;
    this._mining.add(vehicle);
    this.harvesters.add(vehicle);
    if (this.infinite) return want;
    const taken = Math.min(want, this.amount);
    this.amount -= taken;
    return taken;
  }

  /** Called by Economy.update after the vehicles moved: frees the slots of vehicles that stopped mining */
  update() {
    this.harvesters = this._mining;
    this._mining = new Set();
    this.#refreshVisual();
  }

  dispose() {
    if (!this.visual) return;
    this.visual.dispose();
    releaseMineMaterials(this.materials);
    this.visual = null;
    this.materials = null;
    this.group = null;
  }

  // ---------- visuals ----------

  /** [ore-mine-visual] Open-pit mine (src/game/OreMineVisual.js); shared materials are fog-patched once per map */
  #build() {
    const world = this.world;
    if (!world.scene) return;
    this.materials = acquireMineMaterials(world);
    this.visual = new OreMineVisual({
      x: this.x, z: this.z, radius: this.radius, superNode: this.superNode,
      heightAt: (x, z) => world.heightAt(x, z), planet: world.map?.planet ?? null,
      terrain: world.ground?.geometry ?? null, // mesh lowered under the pit (visual only, restored by dispose)
      batch: this.materials.batch, // all mines of the map drawn merged (3 draw calls in total)
    });
    for (const mesh of this.visual.meshes) mesh.userData.deposit = this; // invisible pick proxy → Economy.depositMeshes
    this.group = this.visual.group;
    this.group.name = 'oreDeposit';
    world.scene.add(this.group);
    this._shown = 1;
    this._depletedShown = false;
  }

  #refreshVisual() {
    if (!this.visual) return;
    const ratio = this.infinite ? 1 : this.ratio;
    const depleted = this.depleted;
    if (Math.abs(ratio - this._shown) < ORE_DEPOSIT.visualStep && depleted === this._depletedShown) return;
    this._shown = ratio;
    this._depletedShown = depleted;
    this.visual.setRemaining(ratio, depleted);
  }
}
