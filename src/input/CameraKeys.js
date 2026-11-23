// Steel Mans – camera panning with WASD (and arrow keys) along the ground, relative to the view direction
import * as THREE from 'three';
import { CAMERA, KEYBINDINGS, MOUSE } from '../config.js';
import { getSettings, onSettingsChange } from '../core/Profile.js';
import { clampToMap } from '../core/CameraBounds.js';

/** Applies the mouse settings (sensitivity, invert) to OrbitControls now and after every settings change */
export function initMouseSettings(controls) {
  const apply = () => {
    const m = getSettings().mouse;
    controls.rotateSpeed = MOUSE.baseRotateSpeed * m.rotateSensitivity * (m.invertRotate ? -1 : 1);
    controls.zoomSpeed = MOUSE.baseZoomSpeed * m.zoomSensitivity * (m.invertZoom ? -1 : 1);
  };
  apply();
  onSettingsChange(apply);
}

const KEYS = {
  forward: KEYBINDINGS.cameraForward,
  back: KEYBINDINGS.cameraBack,
  left: KEYBINDINGS.cameraLeft,
  right: KEYBINDINGS.cameraRight,
};

export class CameraKeys {
  /**
   * @param {THREE.Camera} camera
   * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} controls
   */
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.down = new Set();
    this._fwd = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._move = new THREE.Vector3();

    this._onKeyDown = (e) => {
      if (e.target.closest?.('input, select, textarea') || e.ctrlKey || e.altKey || e.metaKey) return;
      this.down.add(e.code);
    };
    this._onKeyUp = (e) => { this.down.delete(e.code); };
    this._onBlur = () => { this.down.clear(); }; // no stuck keys after alt-tab
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.down.clear();
  }

  #axis(name) {
    const keys = KEYS[name];
    for (let i = 0; i < keys.length; i++) if (this.down.has(keys[i])) return 1;
    return 0;
  }

  /** Moves the camera so it looks at a point (keeps the current angle and distance) */
  focus(point) {
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.set(point.x, this.controls.target.y, point.z);
    this.camera.position.copy(this.controls.target).add(offset);
    clampToMap(this.camera, this.controls);
  }

  update(dt) {
    clampToMap(this.camera, this.controls); // also catches right-drag pan, minimap jumps and a rebuilt (smaller) map
    const f = this.#axis('forward') - this.#axis('back');
    const r = this.#axis('right') - this.#axis('left');
    if (!f && !r) return;

    // Forward = view direction flattened onto the ground
    this.camera.getWorldDirection(this._fwd).setY(0).normalize();
    this._right.crossVectors(this._fwd, THREE.Object3D.DEFAULT_UP).normalize();
    this._move.set(0, 0, 0).addScaledVector(this._fwd, f).addScaledVector(this._right, r).normalize();

    // Faster when zoomed out
    const distance = this.camera.position.distanceTo(this.controls.target);
    this._move.multiplyScalar(CAMERA.panSpeed * Math.max(1, distance / CAMERA.panReferenceDistance) * dt);
    this.camera.position.add(this._move);
    this.controls.target.add(this._move);
  }
}
