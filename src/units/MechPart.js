// Steel Men – jedna část robota s vlastním HP – SIT
import * as THREE from 'three';
import { applyArmor } from '../data/Stats.js';
import { MUZZLE, HIGHLIGHT } from '../config.js';

const HOVER_COLOR = new THREE.Color(HIGHLIGHT.color);
const BLACK = new THREE.Color(0x000000);
const DARK_FACTOR = 0.25;

export class MechPart {
  /**
   * @param {string} key      typ modelu: 'legs' | 'torso' | 'leftArm' | 'rightArm'
   * @param {THREE.Object3D} object  kořen načteného modelu
   * @param {object} stats   resolved part stats from Stats.partStats()
   * @param {number} [maxHp]  optional override of stats.hp
   */
  constructor(key, object, stats, maxHp = stats.hp) {
    this.key = key;
    this.stats = stats;
    this.set = stats.set; // sada dílu, např. 'Basic', 'Axe' (určuje útočné animace)
    this.object = object;
    this.maxHp = maxHp;
    this.hp = maxHp;
    // Runtime weapon state; cooldown = seconds until the weapon can fire again
    this.weapons = stats.weapons.map((def) => ({ def, part: this, cooldown: 0 }));
    this.mech = null;   // robot, na kterém je díl namontován
    this.wreck = null;  // ArmWreck, pokud díl leží na zemi
    this.slot = key;    // kotevní slot, na kterém je díl (u rukou se může lišit od key)
    this.highlighted = false;
    this.charred = false; // součást zničeného robota
    this.meshes = [];

    object.name = `part_${key}`;
    object.userData.mechPart = this;

    // Vlastní meshe pouze tohoto dílu (MechPart vzniká dřív, než se díly spojí)
    object.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      // Kopie materiálu, aby zvýraznění/poškození neovlivnilo jiné díly a roboty
      o.material = Array.isArray(o.material) ? o.material.map((m) => m.clone()) : o.material.clone();
      for (const m of this.#materials(o)) m.userData.unique = true; // TeamColor may recolour it in place
      for (const m of this.#materials(o)) m.userData.baseColor = m.color ? m.color.clone() : null;
      this.meshes.push(o);
    });
  }

  /**
   * World position a shot leaves from: the part's launch sockets in turn (MUZZLE.socketPatterns),
   * or the centre of this part's own geometry when the model has none.
   * @param {number} [index]  shot number within a burst – several muzzles take turns
   */
  muzzlePoint(index = 0, out = new THREE.Vector3()) {
    this.muzzles ??= this.#findMuzzles();
    if (this.muzzles.length) return this.muzzles[index % this.muzzles.length].getWorldPosition(out);
    const box = this.worldBounds();
    return box.isEmpty() ? this.object.getWorldPosition(out) : box.getCenter(out);
  }

  /** World-space bounding box of this part's own geometry (not of parts hanging under it) */
  worldBounds(out = null) {
    out ??= new THREE.Box3();
    out.makeEmpty();
    const meshBox = new THREE.Box3();
    for (const mesh of this.meshes) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      out.union(meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
    }
    return out;
  }

  // Launch sockets of this part only (arms hang under torso nodes – stop at other parts' roots)
  #findMuzzles() {
    const found = [];
    const visit = (o) => {
      if (o !== this.object && o.userData.mechPart) return;
      if (MUZZLE.socketPatterns.some((re) => re.test(o.name))) found.push(o);
      for (const c of o.children) visit(c);
    };
    visit(this.object);
    return found;
  }

  /**
   * New stats for the same model (research of the owner changed, or the part changed owner). HP keep their
   * share of max HP; runtime weapon state (cooldowns) stays, linked to the new weapon data.
   */
  setStats(stats) {
    const ratio = this.maxHp > 0 ? this.hp / this.maxHp : 1;
    this.stats = stats;
    this.maxHp = stats.hp;
    if (this.hp > 0) this.hp = Math.max(Number.EPSILON, ratio * this.maxHp);
    this.weapons.forEach((w, i) => { if (stats.weapons[i]) w.def = stats.weapons[i]; });
  }

  get alive() { return this.hp > 0; }
  get isArm() { return this.key === 'leftArm' || this.key === 'rightArm'; }

  /**
   * @param {number|object} damage  number = physical, or { physical, energy }; reduced by this part's armor
   * @param {THREE.Vector3} [source] odkud zásah přišel (pro animaci zásahu)
   * @returns {number} HP actually removed
   */
  takeDamage(damage, source = null) {
    if (!this.alive) return 0;
    return this.loseHp(applyArmor(damage, this.stats.armor).total, source);
  }

  /**
   * Removes HP without armour (damage already reduced, e.g. spilled over from another part – Combat.damageMechPart)
   * @returns {number} HP actually removed
   */
  loseHp(amount, source = null) {
    if (!this.alive || amount <= 0) return 0;
    const dealt = Math.min(amount, this.hp);
    this.hp -= dealt;
    if (this.hp < 1e-6) this.hp = 0; // float leftovers of an even split must not keep a part "alive"
    this.#applyLook();
    this.mech?.onPartDamaged(this, source, dealt);
    return dealt;
  }

  /** Obnoví část HP (podíl z maxHp) a vrátí původní vzhled */
  restore(ratio) {
    this.hp = Math.min(this.maxHp, this.hp + Math.round(this.maxHp * ratio));
    this.charred = false;
    this.#applyLook();
  }

  /**
   * [R1] Can a repair restore HP of this part? Below max HP and alive – or a broken arm (0 HP) still mounted on
   * a mech: repairing it makes it work again (weapons come back as soon as it has HP – ModularMech.weapons).
   * Torso / legs at 0 HP mean a destroyed mech: never repairable.
   */
  get repairable() { return this.hp < this.maxHp && (this.alive || (this.isArm && this.mech !== null && !this.charred)); }

  /** Adds HP (repair) up to maxHp; [R1] a broken mounted arm comes back to life, other 0 HP parts cannot be repaired */
  heal(amount) {
    if (!this.repairable || amount <= 0) return;
    const revived = !this.alive;
    this.hp = Math.min(this.maxHp, this.hp + amount);
    if (revived) this.#applyLook(); // no longer drawn dark
  }

  updateWeapons(dt) {
    for (const w of this.weapons) w.cooldown = Math.max(0, w.cooldown - dt);
  }

  setCharred(on) { this.charred = on; this.#applyLook(); }
  setHighlighted(on) { this.highlighted = on; this.#applyLook(); }

  #applyLook() {
    const dark = !this.alive || this.charred;
    for (const mesh of this.meshes) {
      for (const m of this.#materials(mesh)) {
        if (m.userData.baseColor) {
          m.color.copy(m.userData.baseColor);
          if (dark) m.color.multiplyScalar(DARK_FACTOR);
        }
        if (m.emissive) {
          m.emissive.copy(this.highlighted ? HOVER_COLOR : BLACK);
          m.emissiveIntensity = this.highlighted ? HIGHLIGHT.intensity : 1;
        }
      }
    }
  }

  #materials(mesh) { return Array.isArray(mesh.material) ? mesh.material : [mesh.material]; }
}

// Najde MechPart k libovolnému objektu (jde nahoru po rodičích)
export function findMechPart(object) {
  for (let o = object; o; o = o.parent) {
    if (o.userData.mechPart) return o.userData.mechPart;
  }
  return null;
}
