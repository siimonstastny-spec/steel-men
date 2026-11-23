// Steel Mans – generated avatar of a computer player (no image files): a geometric badge in the team colour with the
// monogram of the call sign and 1..N small bars, all derived from the avatar index (docs/notes/n6-ainames.md).
//
//   avatarHtml({ name, avatar, color, size })   inline <svg class="ai-avatar"> string (name and colour are escaped / validated)
//   playerAvatarHtml(team, color, place)        avatar of the computer player of a team (via PlayerLabels), '' for a human;
//                                               place = key of AI_PLAYERS.avatar.sizes ('menu' | 'lobby' | 'stats')
//   [UISMALL] silhouetteHtml / imageAvatarHtml / humanAvatarHtml({ image, color, size, title })   human players
//   [UISMALL] avatarForNetwork(dataUrl)         Promise<tiny dataUrl | ''> for the lobby (Lobby.create / join { avatarImg })
//   [UISMALL] fileToAvatarData(file)           Promise<dataUrl | null>: crop + scale to a small square (Settings upload)
// Styles: .ai-avatar in src/ui/menu.css, .human-avatar in src/ui/lobby.css.
import { AI_PLAYERS, UI_SMALL } from '../config.js';
import { cleanAvatarImage, playerAvatarIndex, playerImage, playerIsHuman, playerLabel } from '../core/PlayerLabels.js';

const A = AI_PLAYERS.avatar;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const HEX_BASE = 16;
const COLOR_PARTS = [[1, 3], [3, 5], [5, 7]]; // r, g, b slices of #rrggbb
const CHANNEL_MAX = 255;
const LUMA = [0.2126, 0.7152, 0.0722];
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// Outlines as points on a unit square (0..1), scaled into the viewBox; null = circle
const SHAPES = [
  null,
  [[0.5, 0], [1, 0.25], [1, 0.75], [0.5, 1], [0, 0.75], [0, 0.25]],               // hexagon
  [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],                                       // diamond
  [[0, 0], [1, 0], [1, 0.55], [0.5, 1], [0, 0.55]],                               // shield
  [[0.3, 0], [0.7, 0], [1, 0.3], [1, 0.7], [0.7, 1], [0.3, 1], [0, 0.7], [0, 0.3]], // octagon
  [[0, 0], [1, 0], [1, 1], [0, 1]],                                               // square
];

const num = (n) => Math.round(n * 100) / 100;

function lightColor(hex) {
  const [r, g, b] = COLOR_PARTS.map(([a, z]) => parseInt(hex.slice(a, z), HEX_BASE) / CHANNEL_MAX);
  return LUMA[0] * r + LUMA[1] * g + LUMA[2] * b > A.lightLuminance;
}

function shapeSvg(index, fill) {
  const full = A.viewBox - A.strokeWidth * 2;
  const pts = SHAPES[index % SHAPES.length];
  const common = `class="shape" fill="${fill}" stroke-width="${A.strokeWidth}"`;
  if (!pts) return `<circle ${common} cx="${A.viewBox / 2}" cy="${A.viewBox / 2}" r="${full / 2}"/>`;
  const points = pts.map(([x, y]) => `${num(A.strokeWidth + x * full)},${num(A.strokeWidth + y * full)}`).join(' ');
  return `<polygon ${common} points="${points}"/>`;
}

function pipsSvg(count, fill) {
  const total = count * A.pipWidth + (count - 1) * A.pipGap;
  const x0 = (A.viewBox - total) / 2;
  return Array.from({ length: count }, (_, k) =>
    `<rect x="${num(x0 + k * (A.pipWidth + A.pipGap))}" y="${A.pipY}" width="${A.pipWidth}" height="${A.pipHeight}" fill="${fill}"/>`).join('');
}

/** Inline SVG of one avatar; `avatar` = non-negative whole number (anything else is treated as 0), `size` in px */
export function avatarHtml({ name = '', avatar = 0, color, size = A.sizes.menu } = {}) {
  const index = Number.isInteger(avatar) && avatar >= 0 ? avatar : 0;
  const fill = typeof color === 'string' && COLOR_RE.test(color) ? color.toLowerCase() : A.fallbackColor;
  const ink = lightColor(fill) ? A.darkText : A.lightText;
  const letter = esc((Array.from(String(name).trim())[0] ?? '').toUpperCase());
  const pips = 1 + (Math.floor(index / SHAPES.length) % A.pips);
  const label = esc(name);
  return `<svg class="ai-avatar" viewBox="0 0 ${A.viewBox} ${A.viewBox}" width="${size}" height="${size}" role="img" aria-label="${label}">
    <title>${label}</title>${shapeSvg(index, fill)}
    <text x="${A.viewBox / 2}" y="${A.letterY}" text-anchor="middle" font-size="${A.letterSize}" font-weight="700" fill="${ink}">${letter}</text>${pipsSvg(pips, ink)}</svg>`;
}

// ---------- [UISMALL] human players: uploaded picture or a neutral head silhouette ----------

const H = UI_SMALL.humanAvatar;
const safeFill = (color) => (typeof color === 'string' && COLOR_RE.test(color) ? color.toLowerCase() : A.fallbackColor);

/** Neutral head-and-shoulders silhouette on a disc of the team colour (SVG, no ids so any number can share a page) */
export function silhouetteHtml({ color, size = A.sizes.menu, title = '' } = {}) {
  const fill = safeFill(color);
  const ink = lightColor(fill) ? A.darkText : A.lightText;
  const c = A.viewBox / 2;
  const { head, shoulders: sh } = H;
  const left = num(sh.cx - sh.halfWidth);
  const right = num(sh.cx + sh.halfWidth);
  const label = esc(title);
  return `<svg class="ai-avatar human-avatar" viewBox="0 0 ${A.viewBox} ${A.viewBox}" width="${size}" height="${size}" role="img" aria-label="${label}">
    <title>${label}</title><circle class="shape" fill="${fill}" stroke-width="${A.strokeWidth}" cx="${c}" cy="${c}" r="${(A.viewBox - A.strokeWidth * 2) / 2}"/>
    <g fill="${ink}" fill-opacity="${H.inkOpacity}"><circle cx="${head.cx}" cy="${head.cy}" r="${head.r}"/>
    <path d="M${left},${sh.bottom} A${sh.halfWidth},${sh.height} 0 0 1 ${right},${sh.bottom} Z"/></g></svg>`;
}

/** Uploaded picture as a round avatar with a team-colour ring; `image` must pass cleanAvatarImage (else the silhouette) */
export function imageAvatarHtml({ image, color, size = A.sizes.menu, title = '' } = {}) {
  const src = cleanAvatarImage(image);
  if (!src) return silhouetteHtml({ color, size, title });
  return `<img class="ai-avatar human-avatar picture" src="${src}" width="${size}" height="${size}" alt="${esc(title)}" title="${esc(title)}" style="border-color:${safeFill(color)}">`;
}

/** Avatar of a human player: the picture when there is one, else the silhouette */
export const humanAvatarHtml = (opts) => (opts?.image ? imageAvatarHtml(opts) : silhouetteHtml(opts));

/**
 * Avatar of a team's player in the colour given: a computer player's badge, a human's picture / silhouette (teams marked
 * { human: true } in setPlayerLabels), '' for a team without any identity
 */
export function playerAvatarHtml(team, color, place = 'menu') {
  const size = A.sizes[place] ?? A.sizes.menu;
  const avatar = playerAvatarIndex(team);
  if (avatar != null) return avatarHtml({ name: playerLabel(team), avatar, color, size });
  if (playerIsHuman(team)) return humanAvatarHtml({ image: playerImage(team), color, size });
  return '';
}

/** Crops / scales a picture source (bitmap or image) to a size x size JPEG data URL, first quality step that fits maxLength */
function squareData(source, width, height, size, steps, maxLength, crop = null) {
  const side = crop ? crop.side : Math.min(width, height);
  if (!(side > 0)) return null;
  const sx = crop ? crop.sx : (width - side) / 2;
  const sy = crop ? crop.sy : (height - side) / 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = H.background; // transparent PNGs would turn black in a JPEG
  g.fillRect(0, 0, size, size);
  g.drawImage(source, sx, sy, side, side, 0, 0, size, size);
  for (const q of steps) {
    const url = canvas.toDataURL(H.mime, q);
    if (cleanAvatarImage(url, maxLength)) return url;
  }
  return null;
}

/**
 * Tiny version of the stored avatar for the lobby network presence (UI_SMALL.humanAvatar.netSize / netMaxLength).
 * @returns {Promise<string>} data URL, '' = none / failed (the others then see the silhouette)
 */
export async function avatarForNetwork(dataUrl) {
  if (!cleanAvatarImage(dataUrl)) return '';
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    return squareData(img, img.naturalWidth, img.naturalHeight, H.netSize, H.netQualitySteps, H.netMaxLength) ?? '';
  } catch {
    return '';
  }
}

/**
 * Reads a picture file into the small square stored in the profile: centre crop, scaled to UI_SMALL.humanAvatar.size,
 * JPEG data URL below maxDataLength. @returns {Promise<string|null>} null = not an image / too big / undecodable
 */
export async function fileToAvatarData(file) {
  if (!file || !String(file.type).startsWith('image/') || file.size > H.maxFileBytes) return null;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
    return squareData(bitmap, bitmap.width, bitmap.height, H.size, H.qualitySteps, H.maxDataLength);
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
}

/**
 * Like fileToAvatarData, but the user first picks the square in a crop dialog (drag + zoom, AvatarCropper.js).
 * @returns {Promise<string|null|undefined>} data URL; null = not an image / too big / undecodable (show the error);
 *   undefined = the user cancelled the dialog (change nothing)
 */
export async function pickAvatarData(file) {
  if (!file || !String(file.type).startsWith('image/') || file.size > H.maxFileBytes) return null;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
    if (!bitmap.width || !bitmap.height) return null;
    const { openAvatarCropper } = await import('./AvatarCropper.js');
    const crop = await openAvatarCropper(bitmap);
    if (!crop) return undefined;
    return squareData(bitmap, bitmap.width, bitmap.height, H.size, H.qualitySteps, H.maxDataLength, crop);
  } catch {
    return null;
  } finally {
    bitmap?.close?.();
  }
}
