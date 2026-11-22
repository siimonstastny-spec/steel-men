// Steel Mans – ore deposit on the map (data/maps/*.json → oreDeposits, superNode.ore). DrillTrucks park next
// to it and mine directly: ore goes straight to the team account (Vehicle harvest order). The deposit runs out
// unless the game has infinite deposits (world.settings.economy.infiniteDeposits).
//   def: { x, z, radius, amount, rateFactor, maxHarvesters, superNode? }
import * as THREE from 'three';
import { ORE_DEPOSIT } from '../config.js';

// Visual refresh granularity (share of the deposit) – avoids touching the scene graph every frame
const VISUAL_STEP = 0.01;

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
    if (!this.superNode) this.#build(); // the super node already has its own crystals (Map.js)
  }

  get infinite() { return this.economy.infiniteDeposits; }
  get depleted() { return !this.infinite && this.amount <= 0; }
  /** Share left 0..1 */
  get ratio() { return this.initial > 0 ? Math.max(0, this.amount / this.initial) : 0; }

  /** Pathfinding obstacle: the crystal core (the super node core is already a map obstacle) */
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
    if (!this.group) return;
    this.group.parent?.remove(this.group);
    this.group.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
    this.group = null;
  }

  // ---------- visuals ----------

  #build() {
    const cfg = ORE_DEPOSIT;
    const group = new THREE.Group();
    group.name = 'oreDeposit';
    group.position.copy(this.position);
    const mat = new THREE.MeshStandardMaterial({
      color: cfg.crystalColor, emissive: cfg.crystalEmissive, emissiveIntensity: cfg.crystalEmissiveIntensity,
      roughness: 0.35, metalness: 0.1, flatShading: true, transparent: true, opacity: 1,
    });
    this.material = mat;
    const crystal = (height, width) => {
      const geo = new THREE.OctahedronGeometry(1, 0);
      geo.scale(width, height / 2, width);
      geo.translate(0, height / 2, 0);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.userData.deposit = this;
      return mesh;
    };
    this.crystals = new THREE.Group();
    this.crystals.add(crystal(cfg.crystalHeight, cfg.crystalWidth));
    for (let i = 0; i < cfg.crystalCount; i++) {
      const a = (i / cfg.crystalCount) * Math.PI * 2;
      const c = crystal(cfg.crystalHeight * cfg.outerScale, cfg.crystalWidth * cfg.outerScale);
      c.position.set(Math.sin(a) * this.radius * cfg.ringFactor, 0, Math.cos(a) * this.radius * cfg.ringFactor);
      c.rotation.set(Math.cos(a) * cfg.tilt, 0, -Math.sin(a) * cfg.tilt);
      this.crystals.add(c);
    }
    group.add(this.crystals);
    this.world.scene.add(group);
    this.world.fog?.patchMaterial(mat); // darkened by the fog of war like the rest of the map
    this.group = group;
    this._shown = -1;
  }

  #refreshVisual() {
    if (!this.crystals) return;
    const ratio = this.infinite ? 1 : this.ratio;
    if (Math.abs(ratio - this._shown) < VISUAL_STEP && !(this.depleted && this._shown > 0)) return;
    this._shown = ratio;
    const cfg = ORE_DEPOSIT;
    const s = this.depleted ? cfg.minScale : cfg.minScale + (1 - cfg.minScale) * ratio;
    this.crystals.scale.setScalar(s);
    this.material.opacity = this.depleted ? cfg.depletedOpacity : 1;
  }
}
