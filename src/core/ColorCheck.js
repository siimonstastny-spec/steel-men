// Steel Men – colour similarity of team colours (CIE Lab distance, threshold COLOR_SIMILARITY.minDeltaE)
import { COLOR_SIMILARITY } from '../config.js';

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
// D65 reference white
const WHITE = [0.95047, 1, 1.08883];
const LAB_EPSILON = 216 / 24389;
const LAB_KAPPA = 24389 / 27;

function labF(v) { return v > LAB_EPSILON ? Math.cbrt(v) : (LAB_KAPPA * v + 16) / 116; }

/** '#rrggbb' -> [L, a, b] */
export function hexToLab(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255));
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WHITE[0];
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / WHITE[1];
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / WHITE[2];
  const [fx, fy, fz] = [labF(x), labF(y), labF(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Perceptual distance of two '#rrggbb' colours (ΔE76; 0 = identical) */
export function colorDistance(a, b) {
  const [l1, a1, b1] = hexToLab(a);
  const [l2, a2, b2] = hexToLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** True when two team colours are the same or too similar to tell apart */
export const colorsTooSimilar = (a, b) => colorDistance(a, b) < COLOR_SIMILARITY.minDeltaE;

/** First palette entry (list of '#rrggbb') that is distinct from all `others`, or null */
export function firstDistinctColor(palette, others) {
  return palette.find((c) => others.every((o) => !colorsTooSimilar(c, o))) ?? null;
}
