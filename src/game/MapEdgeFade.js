// Steel Mans – smooth fade of the terrain into the void colour along the map border (visual only, no simulation state).
// Per-pixel: the terrain material's fragment shader mixes the final colour towards MAP_EDGE_FADE.color by the distance
// of the world position from the map border (smoothstep), so there are no vertex-interpolation steps. Vertex colours,
// heights, fog of war (FogOfWar.patchMaterial) and other objects are untouched.
import { MAP_EDGE_FADE } from '../config.js';

const STATE = 'mapEdgeFade'; // material.userData key
const CACHE_KEY = 'mapEdgeFade';

function hexToVec(hex) {
  // Components in the output (sRGB) space: the fade runs after the colour space conversion at the end of the shader
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

function patchShader(shader, uniforms) {
  shader.uniforms.edgeFadeHalf = uniforms.half;
  shader.uniforms.edgeFadeWidth = uniforms.width;
  shader.uniforms.edgeFadeColor = uniforms.color;
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vEdgeFadeXZ;')
    .replace('#include <project_vertex>',
      '#include <project_vertex>\nvEdgeFadeXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
  // dithering_fragment comes after fog_fragment (scene fog), so the fade is applied AFTER the fog and the fog cannot
  // lighten the black border; FogOfWar inserts its darkening directly after the same token, i.e. before this
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>',
      '#include <common>\nuniform float edgeFadeHalf;\nuniform float edgeFadeWidth;\nuniform vec3 edgeFadeColor;\nvarying vec2 vEdgeFadeXZ;')
    .replace('#include <dithering_fragment>',
      '#include <dithering_fragment>\n'
      + '{ float edgeDist = edgeFadeHalf - max(abs(vEdgeFadeXZ.x), abs(vEdgeFadeXZ.y));\n'
      + '  gl_FragColor.rgb = mix(edgeFadeColor, gl_FragColor.rgb, smoothstep(0.0, edgeFadeWidth, edgeDist)); }');
}

/**
 * Makes `material` (the shared terrain material) fade into MAP_EDGE_FADE.color within MAP_EDGE_FADE.width units of the
 * border of a map with half size `half`. Safe to call on every map load (updates the uniform only), and it composes
 * with FogOfWar.patchMaterial, which later assigns onBeforeCompile / customProgramCacheKey on the same material:
 * both are wrapped with accessors so the fade shader patch always runs first and the fog's assignment is kept.
 * Allocates nothing per frame and nothing that needs disposing (one small uniform set per material).
 * @param {THREE.Material} material
 * @param {number} half  half of the map size (units)
 */
export function applyMapEdgeFade(material, half) {
  if (!material) return;
  let state = material.userData[STATE];
  if (!state) {
    const uniforms = {
      half: { value: half },
      width: { value: MAP_EDGE_FADE.width },
      color: { value: hexToVec(MAP_EDGE_FADE.color) },
    };
    let innerCompile = material.onBeforeCompile;
    let innerKey = material.customProgramCacheKey;
    Object.defineProperty(material, 'onBeforeCompile', {
      configurable: true,
      get: () => (shader, renderer) => { patchShader(shader, uniforms); innerCompile.call(material, shader, renderer); },
      set: (fn) => { innerCompile = fn; },
    });
    Object.defineProperty(material, 'customProgramCacheKey', {
      configurable: true,
      get: () => () => `${innerKey.call(material)}|${CACHE_KEY}`,
      set: (fn) => { innerKey = fn; },
    });
    state = material.userData[STATE] = { uniforms };
    material.needsUpdate = true;
  }
  // A new map only changes uniforms (no recompile); width / colour are re-read so config tuning applies too
  state.uniforms.half.value = half;
  state.uniforms.width.value = Math.min(MAP_EDGE_FADE.width, half);
  const [r, g, b] = hexToVec(MAP_EDGE_FADE.color);
  state.uniforms.color.value[0] = r; state.uniforms.color.value[1] = g; state.uniforms.color.value[2] = b;
}
