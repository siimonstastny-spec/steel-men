// Steel Men – edge scrolling: the cursor at a window edge pans the camera along the ground.
// Runs only when Settings → Game → edge scrolling is on (profile settings.ui.edgeScroll, read live),
// the window has focus, the cursor is over the map (not a HUD panel, not outside the window) and no menu is open.
import * as THREE from 'three';
import { CAMERA } from '../config.js';
import { getSettings } from '../core/Profile.js';
import { clampToMap } from '../core/CameraBounds.js';

const ROTATE_OR_PAN_BUTTONS = 2 | 4; // right (map drag) or middle (rotate) held – the camera is already moving

export class EdgeScroll {
  /**
   * @param {THREE.Camera} camera
   * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} controls
   * @param {HTMLElement} dom  the game canvas – only a cursor over it scrolls
   */
  constructor(camera, controls, dom) {
    this.camera = camera;
    this.controls = controls;
    this.dom = dom;
    this.pointer = null;   // { x, y } while the cursor is over the canvas, null otherwise
    this.buttons = 0;
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._move = new THREE.Vector3();
    this._pos = { x: 0, y: 0 }; // recycled pointer object (no allocation per event)
    this._onMove = (e) => {
      if (e.target === dom) { this._pos.x = e.clientX; this._pos.y = e.clientY; this.pointer = this._pos; }
      else this.pointer = null;
      this.buttons = e.buttons;
    };
    this._onLeave = () => { this.pointer = null; };
    window.addEventListener('pointermove', this._onMove);
    document.addEventListener('pointerleave', this._onLeave);                        // cursor left the page
    document.documentElement.addEventListener('mouseleave', this._onLeave);
    window.addEventListener('blur', this._onLeave);
  }

  dispose() {
    window.removeEventListener('pointermove', this._onMove);
    document.removeEventListener('pointerleave', this._onLeave);
    document.documentElement.removeEventListener('mouseleave', this._onLeave);
    window.removeEventListener('blur', this._onLeave);
    this.pointer = null;
  }

  get enabled() {
    return !!getSettings().ui?.edgeScroll && document.hasFocus()
      && document.getElementById('menu')?.hidden !== false; // start menu / settings open = no scrolling
  }

  update(dt) {
    const p = this.pointer;
    if (!p || (this.buttons & ROTATE_OR_PAN_BUTTONS) || !this.enabled) return;
    const edge = CAMERA.edgeScrollWidth;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const r = (p.x >= w - edge ? 1 : 0) - (p.x <= edge ? 1 : 0);
    const f = (p.y <= edge ? 1 : 0) - (p.y >= h - edge ? 1 : 0);
    if (!r && !f) return;

    // Same as WASD: forward = view direction on the ground, faster when zoomed out
    this.camera.getWorldDirection(this._fwd).setY(0).normalize();
    this._right.crossVectors(this._fwd, THREE.Object3D.DEFAULT_UP).normalize();
    this._move.set(0, 0, 0).addScaledVector(this._fwd, f).addScaledVector(this._right, r).normalize();
    const distance = this.camera.position.distanceTo(this.controls.target);
    this._move.multiplyScalar(CAMERA.edgeScrollSpeed * Math.max(1, distance / CAMERA.panReferenceDistance) * dt);
    this.camera.position.add(this._move);
    this.controls.target.add(this._move);
    clampToMap(this.camera, this.controls);
  }
}
