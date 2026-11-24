// Steel Men – animace chování robota (stání, chůze, zásah, útok, smrt) – SIT
import * as THREE from 'three';
import { bindPart, retargetClip } from './AnimLibrary.js';
import { MECH, ATTACK_CLIP_SET } from '../config.js';

const CLIPS = {
  idle: 'stand',                 // crew on board – stands ready
  powerDown: 'standcrewless',    // crew left – plays once, then holds the last frame (mech is inactive)
  walk: 'walk',
  death: 'death_collapse',
  attackFallback: 'attackidlestill',
  hit: { front: 'GetHit_front', back: 'GetHit_back', left: 'GetHit_left', right: 'GetHit_right' },
};
const AIR_FADE = 0.2; // s – cross-fade between jet flight phases

export class MechAnimator {
  constructor(mech, lib) {
    this.mech = mech;
    this.lib = lib;
    this.mixer = new THREE.AnimationMixer(mech);
    this.bindings = new Map();
    this.cache = new Map();     // jméno klipu -> retargetovaný klip
    this.current = null;        // právě hrající akce
    this.oneShot = null;        // jednorázová akce (zásah, útok)
    this.attackAction = null;   // the oneShot when it is an attack clip (hit reactions do not interrupt it)
    this.baseName = 'idle';
    this.dead = false;
    this.attackCounters = new Map(); // `${set}/${side}` -> next clip variant
    this.walkRate = 1;
    this.walkClip = CLIPS.walk; // [R2] move loop – legs may bring their own (stats anim.move, e.g. the JumpJet hop run)
    this.air = { name: null, loop: false, duration: 0 }; // [R2] jet flight clip that replaces the base loop
    this.crewed = false;
    this.poweredDown = true;    // power-down already finished -> crewless pose starts at its last frame
    this.mixer.addEventListener('finished', (e) => this.#onFinished(e));
  }

  /** Přestaví vazby po změně složení robota (utržení / montáž ruky) */
  rebuild() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mech);
    this.cache.clear();
    this.current = null;
    this.oneShot = null;
    this.attackAction = null;
    this.bindings = new Map();
    for (const [slot, part] of Object.entries(this.mech.parts)) {
      bindPart(part.object, slot, this.lib, part.object.scale.x < 0, this.bindings);
    }
    if (this.dead) {
      const a = this.#once(CLIPS.death);
      a.reset().play();
      a.time = a.getClip().duration;
      this.current = a;
    } else {
      this.#switchTo(this.#base(), 0);
    }
  }

  setMoving(moving) {
    const name = moving ? 'walk' : 'idle';
    if (name === this.baseName) return;
    this.baseName = name;
    if (!this.oneShot && !this.dead && !this.air.name) this.#switchTo(this.#base(), 0.25);
  }

  /**
   * [R2] Clip of the move loop (null = the common walk). Unknown names fall back to the walk (warning once).
   * @param {string|null} name  e.g. 'RobotPartsJumpJet_LegsJetFly'
   */
  setWalkClip(name) {
    const clip = name && this.lib.clips.has(name) ? name : CLIPS.walk;
    if (name && clip !== name) console.warn(`[MechAnimator] Klip "${name}" neexistuje, používám chůzi`);
    if (clip === this.walkClip) return;
    this.walkClip = clip;
    if (this.baseName === 'walk' && !this.oneShot && !this.dead && !this.air.name) this.#switchTo(this.#base(), 0.25);
  }

  /**
   * [R2] Jet flight phase: plays `name` instead of the base loop (takeoff / flight / landing); null ends the flight.
   * A running one-shot (hit reaction) is dropped. Same name again = no-op.
   * @param {object} [opts] { loop, duration } – duration > 0 time-scales a non-looping clip to last that long
   */
  setAirClip(name, { loop = false, duration = 0 } = {}) {
    if (name === this.air.name) return;
    if (name && !this.lib.clips.has(name)) name = null;
    if (name === this.air.name) return;
    this.air.name = name;
    this.air.loop = loop;
    this.air.duration = duration;
    if (this.dead) return;
    this.oneShot = null;
    this.attackAction = null;
    this.#switchTo(this.#base(), AIR_FADE);
  }

  /** Reakce na zásah: 'front' | 'back' | 'left' | 'right' */
  hit(direction) {
    if (this.air.name) return; // [R2] no stagger in a jet flight
    // A running attack clip is never cut by a hit reaction: the shot is released on its own timer, so the mech would
    // fire from the idle pose once the short hit clip ended (Gatling "fires in the idle animation")
    if (this.oneShot && this.oneShot === this.attackAction) return;
    this.playOnce(CLIPS.hit[direction] ?? CLIPS.hit.front);
  }

  /**
   * Útok sadou dílu; vrací jméno přehraného klipu.
   * @param {string} set               part set of the weapon, e.g. 'SniperLaser'
   * @param {'left'|'right'|null} side  arm holding the weapon – only clips swinging that arm (null = torso/legs)
   * @param {number} [duration]        seconds the attack should take – the clip is time-scaled to fit
   */
  attack(set, side = null, duration = null) {
    // Some sets borrow the clips of another set (their own ones do not fit the weapon model)
    let names = this.lib.clipsForSet(ATTACK_CLIP_SET[set] ?? set, side);
    if (names.length === 0) names = [CLIPS.attackFallback];
    // Cycle through the variants of this weapon only, not through other weapons' clips
    const key = `${set}/${side}`;
    const n = this.attackCounters.get(key) ?? 0;
    this.attackCounters.set(key, n + 1);
    const name = names[n % names.length];
    if (!this.playOnce(name, 0.15, duration)) return null;
    this.attackAction = this.oneShot; // see hit()
    return name;
  }

  /**
   * Crewed = stand ready; crewless = play the power-down clip once and hold its last frame.
   * New mechs start already powered down.
   */
  setCrewed(crewed) {
    if (crewed === this.crewed) return;
    this.crewed = crewed;
    if (crewed) this.poweredDown = false; // next time the crew leaves, the power-down plays again
    if (this.baseName === 'idle' && !this.oneShot && !this.dead && !this.air.name) this.#switchTo(this.#base(), 0.4);
  }

  /** Walk animation speed relative to normal (1 = MECH.walkAnimScale) */
  setWalkRate(rate) {
    this.walkRate = rate;
    if (this.baseName === 'walk' && this.current && !this.oneShot && !this.dead && !this.air.name) {
      this.current.timeScale = MECH.walkAnimScale * rate;
    }
  }

  die() {
    this.dead = true;
    this.oneShot = null;
    this.attackAction = null;
    this.#switchTo(this.#once(CLIPS.death), 0.2);
  }

  /** @param {number} [duration]  play the clip in this many seconds (null = natural length) */
  playOnce(name, fade = 0.15, duration = null) {
    if (this.dead) return false;
    const a = this.#once(name);
    if (!a) return false;
    this.oneShot = a;
    this.#switchTo(a, fade);
    if (duration > 0) a.timeScale = a.getClip().duration / duration; // #switchTo -> reset() keeps timeScale
    return true;
  }

  update(dt) { this.mixer.update(dt); }

  // ---------- interní ----------

  #action(name) {
    let clip = this.cache.get(name);
    if (!clip) {
      const src = this.lib.clips.get(name);
      if (!src) { console.warn(`[MechAnimator] Klip "${name}" neexistuje`); return null; }
      clip = retargetClip(src, this.bindings, this.lib);
      this.cache.set(name, clip);
    }
    return this.mixer.clipAction(clip);
  }

  #once(name) {
    const a = this.#action(name);
    if (!a) return null;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = 1;
    return a;
  }

  #base() {
    if (this.air.name) return this.#airAction();
    if (this.baseName === 'idle' && !this.crewed) return this.#powerDownAction();
    const walking = this.baseName === 'walk';
    const a = this.#action(walking ? this.walkClip : CLIPS.idle);
    a.setLoop(THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = false;
    a.timeScale = walking ? MECH.walkAnimScale * this.walkRate : 1;
    return a;
  }

  // [R2] current jet flight phase clip (see setAirClip)
  #airAction() {
    const air = this.air;
    const a = this.#action(air.name);
    if (!a) return null;
    a.setLoop(air.loop ? THREE.LoopRepeat : THREE.LoopOnce, air.loop ? Infinity : 1);
    a.clampWhenFinished = !air.loop;
    a.timeScale = !air.loop && air.duration > 0 ? a.getClip().duration / air.duration : 1;
    return a;
  }

  #powerDownAction() {
    const a = this.#action(CLIPS.powerDown);
    if (!a) return null;
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = 1;
    return a;
  }

  #switchTo(action, fade) {
    if (!action) return;
    action.reset();
    action.setEffectiveWeight(1);
    action.play();
    // Already powered down (spawned crewless, or after a hit reaction): jump to the final pose
    if (this.poweredDown && action.getClip().name === CLIPS.powerDown) action.time = action.getClip().duration;
    if (this.current && this.current !== action) {
      if (fade > 0) this.current.crossFadeTo(action, fade, false);
      else this.current.stop();
    }
    this.current = action;
  }

  #onFinished(e) {
    if (e.action.getClip().name === CLIPS.powerDown) { this.poweredDown = true; return; }
    if (e.action !== this.oneShot) return;
    this.oneShot = null;
    this.attackAction = null;
    if (!this.dead) this.#switchTo(this.#base(), 0.25);
  }
}
