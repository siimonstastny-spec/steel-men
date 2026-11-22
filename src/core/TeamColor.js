// Steel Mans – team colours. All models share one "team blue" painted into their textures
// (hue ~222°). applyTeamColor() re-hues exactly that blue to the player's colour and keeps
// the shading, so robots, crews, vehicles and buildings all recolour the same way.
import * as THREE from 'three';
import { TEAM_COLOR } from '../config.js';

const textureCache = new Map();   // `${source.uuid}|${hex}` -> recoloured texture
const sourceOf = new WeakMap();   // recoloured texture -> original texture (recolouring is repeatable)

/**
 * Recolours every textured material under `object` to the given team colour.
 * Safe to call again with another colour (e.g. an arm picked up by another team).
 * Materials shared with other models are cloned first; materials marked
 * `userData.unique = true` (already private to this model) are changed in place.
 * @param {THREE.Object3D} object
 * @param {THREE.ColorRepresentation} color  e.g. '#d33' or 0xdd3333
 */
export function applyTeamColor(object, color) {
  const hex = new THREE.Color(color).getHexString();
  object.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const updated = list.map((material) => {
      if (!material.map) return material;
      const texture = teamTexture(sourceOf.get(material.map) ?? material.map, hex);
      if (material.map === texture) return material;
      const own = material.userData.unique ? material : material.clone();
      own.userData.unique = true;
      own.map = texture;
      return own;
    });
    mesh.material = Array.isArray(mesh.material) ? updated : updated[0];
  });
}

/** Recoloured copy of a texture (cached per source texture and colour) */
export function teamTexture(source, hex) {
  const key = `${source.uuid}|${hex}`;
  let texture = textureCache.get(key);
  if (!texture) {
    texture = recolor(source, hex);
    textureCache.set(key, texture);
    sourceOf.set(texture, source);
  }
  return texture;
}

function recolor(source, hex) {
  const img = source.image;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  recolorPixels(data.data, hex);
  ctx.putImageData(data, 0, 0);

  const texture = source.clone(); // keeps flipY, wrapping, filtering, colour space
  // A clone shares the Source with the original – setting .image would overwrite the original's pixels
  texture.source = new THREE.Source(canvas);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Pixels close to the reference team blue (hue window + minimum saturation) are moved to the
 * team colour: hue replaced, saturation and brightness scaled so the reference blue becomes
 * exactly the team colour and darker / lighter shades stay darker / lighter.
 */
function recolorPixels(px, hex) {
  const c = TEAM_COLOR;
  // sRGB components straight from the hex – texture pixels are sRGB too (THREE.Color would be linear)
  const channel = (i) => parseInt(hex.slice(i, i + 2), 16) / 255;
  const [teamH, teamS, teamV] = rgbToHsv(channel(0), channel(2), channel(4));
  const sScale = teamS / c.referenceSaturation;
  const vScale = teamV / c.referenceValue;
  const out = [0, 0, 0];

  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
    const [h, s, v] = rgbToHsv(r, g, b);
    const hueDist = Math.abs(((h - c.referenceHue + 540) % 360) - 180);
    const w = (1 - smoothstep(c.hueRange, c.hueRange + c.hueSoftness, hueDist))
      * smoothstep(c.minSaturation, c.minSaturation + c.saturationSoftness, s);
    if (w <= 0) continue;
    hsvToRgb(teamH, Math.min(1, s * sScale), Math.min(1, v * vScale), out);
    px[i] = Math.round((r + (out[0] - r) * w) * 255);
    px[i + 1] = Math.round((g + (out[1] - g) * w) * 255);
    px[i + 2] = Math.round((b + (out[2] - b) * w) * 255);
  }
}

function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** r, g, b in 0–1 -> [hue 0–360, saturation 0–1, value 0–1] */
function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, max ? d / max : 0, max];
}

function hsvToRgb(h, s, v, out) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  out[0] = f(5); out[1] = f(3); out[2] = f(1);
  return out;
}
