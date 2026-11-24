// Steel Men – [hologram] placement preview: the real building model drawn as a see-through hologram: light green on a free spot
// (PLACEMENT.validColor), red on a blocked one (PLACEMENT.invalidColor) – the same for every team, never the team colour. One shared shader per preview: fresnel edge, slow horizontal scan lines.
// Visual only (time comes from the render clock, never from the simulation). Used by PlacementGhost (Construction.js)
// and the wall / turret previews (Walls.js).
import * as THREE from 'three';
import { loadModel } from '../core/AssetLoader.js';
import { getRenderClock } from '../core/Graphics.js';
import { PLACEMENT, TEAMS } from '../config.js';
import { structureScale } from '../units/Structure.js';
import { useProceduralModel, createProceduralStructure, loadBuildingStyles } from '../procedural/registry.js';

const VERTEX = /* glsl */`
#include <common>
#include <skinning_pars_vertex>
varying vec3 vNormalView;
varying vec3 vToEye;
varying float vHeight;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vNormalView = normalize(transformedNormal);
  vToEye = -mvPosition.xyz;
  vHeight = (modelMatrix * vec4(transformed, 1.0)).y;
}`;

const FRAGMENT = /* glsl */`
uniform vec3 uColor;
uniform float uOpacity;
uniform float uRim;
uniform float uRimPower;
uniform float uLineDensity;
uniform float uLineSpeed;
uniform float uLineStrength;
uniform float uGlow;
uniform float uLineSharpness;
uniform float uRimAlpha;
uniform float uTime;
varying vec3 vNormalView;
varying vec3 vToEye;
varying float vHeight;
void main() {
  float facing = abs(dot(normalize(vNormalView), normalize(vToEye)));
  float fresnel = pow(1.0 - clamp(facing, 0.0, 1.0), uRimPower);
  float wave = 0.5 + 0.5 * sin((vHeight * uLineDensity - uTime * uLineSpeed) * 6.2831853);
  float line = smoothstep(uLineSharpness, 1.0, wave);
  float light = 1.0 + uRim * fresnel + uLineStrength * line;
  float alpha = clamp(uOpacity * (1.0 + uRim * uRimAlpha * fresnel + uLineStrength * line), 0.0, 1.0);
  gl_FragColor = vec4(uColor * uGlow * light, alpha);
  #include <colorspace_fragment>
}`;

const noRaycast = () => {};
const state = new WeakMap(); // model → { meshes, valid } (not in userData: clone() would copy it through JSON)

export class PlacementHologram {
  /** @param {number} team index into TEAMS (the preview takes its colour) */
  constructor(team) {
    this.uniforms = {
      uOpacity: { value: PLACEMENT.hologramOpacity },
      uRim: { value: PLACEMENT.hologramRim },
      uRimPower: { value: PLACEMENT.hologramRimPower },
      uLineDensity: { value: PLACEMENT.hologramLineDensity },
      uLineSpeed: { value: PLACEMENT.hologramLineSpeed },
      uLineStrength: { value: PLACEMENT.hologramLineStrength },
      uGlow: { value: PLACEMENT.hologramGlow },
      uLineSharpness: { value: PLACEMENT.hologramLineSharpness },
      uRimAlpha: { value: PLACEMENT.hologramRimAlpha },
      uTime: { value: 0 },
    };
    this.valid = this.#material(PLACEMENT.validColor); // (team is kept in the signature; colours no longer depend on it)
    this.invalid = this.#material(PLACEMENT.invalidColor);
  }

  // Both variants share every uniform object (only the colour differs), so they are one shader and one set of settings
  #material(color) {
    const material = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uColor: { value: new THREE.Color(color) } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    material.onBeforeRender = () => { this.uniforms.uTime.value = getRenderClock(); };
    return material;
  }

  /** Opacity relative to PLACEMENT.hologramOpacity (1 = normal; the wall post under the cursor before the line starts is fainter) */
  setFade(factor) { this.uniforms.uOpacity.value = PLACEMENT.hologramOpacity * factor; }

  /** Turns every mesh of `model` into a hologram: no shadows, not clickable, procedural emblem decals hidden */
  apply(model, proc = null) {
    const meshes = [];
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.material = this.valid;
      o.castShadow = false;
      o.receiveShadow = false;
      o.raycast = noRaycast;
      meshes.push(o);
    });
    // Procedural extras (emblem decals, glow layers) would be a second look on top of the hologram: hidden
    if (proc) {
      for (const m of proc.emblemMeshes) m.visible = false;
      for (const layer of proc.glowLayers) layer.mesh.visible = false;
    }
    state.set(model, { meshes, valid: true });
    return model;
  }

  /** Valid / invalid colour of a model made by apply() (nothing happens when it is already in that state) */
  setValid(model, valid) {
    const s = state.get(model);
    if (!s || s.valid === valid) return;
    s.valid = valid;
    const material = valid ? this.valid : this.invalid;
    for (const m of s.meshes) m.material = material;
  }

  /** Releases the two materials (models have their own dispose / are released by the preview source) */
  dispose() {
    this.valid.dispose();
    this.invalid.dispose();
  }
}

/**
 * Source of preview models of one building id: the procedural model when it has one (a new one per piece, laid out like
 * Structure.#attachModel), else the GLB (the loaded copy first, then clones – geometries are shared with the asset cache).
 * Never batches. `release(model)` frees a piece: procedural → its dispose(), GLB → just removed from its parent.
 * @returns {Promise<{ proc: boolean, create(): THREE.Object3D, release(model): void }>}
 */
export async function createPreviewSource({ id, race, team, stats, fp }) {
  const proc = useProceduralModel(id);
  if (proc) await loadBuildingStyles();
  const glb = proc ? null : await loadModel(stats.model);
  const scale = structureScale(stats);
  return {
    proc,
    create() {
      let model;
      if (proc) model = createProceduralStructure(id, race, TEAMS[team].color);
      else model = glb.clone(true); // every piece is a clone of the untouched template (no preview state on it)
      model.scale.setScalar(scale);
      const c = proc ? model.glbCentre : null;
      if (proc) model.position.set(c ? -c.x * scale : 0, 0, c ? -c.z * scale : 0);
      else model.position.set(-fp.offsetX, 0, -fp.offsetZ);
      return model;
    },
    release(model) {
      if (typeof model.dispose === 'function' && model.userData.procedural) model.dispose();
      else model.removeFromParent();
    },
  };
}
