// Steel Mans – modal square crop of an avatar picture: drag = move, wheel / slider = zoom, Confirm / Cancel.
//
//   openAvatarCropper(bitmap) -> Promise<{ sx, sy, side } | null>
//     bitmap = ImageBitmap / HTMLImageElement (not closed by the cropper); result = source-pixel square the user picked,
//     null = cancelled (Esc, Cancel, click outside). Styles: src/ui/avatarCropper.css (loaded here).
import { t } from '../i18n/i18n.js';
import { esc } from './hudUtil.js';

const VIEW_PX = 256;        // px: side of the square viewport (keep in sync with --crop-size in avatarCropper.css)
const ZOOM_MAX = 8;         // x: maximal zoom over "whole short side visible"
const ZOOM_STEP = 0.005;    // zoom change per wheel delta unit (exp): one 100-unit notch ~ x1.65
const SLIDER_STEPS = 1000;  // resolution of the zoom slider
const SHADE = 'rgba(8, 11, 14, 0.55)';
const FRAME = 'rgba(62, 166, 255, 0.9)';
const CSS_ID = 'avatar-cropper-css';

function ensureCss() {
  if (document.getElementById(CSS_ID)) return;
  const link = document.createElement('link');
  link.id = CSS_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./avatarCropper.css', import.meta.url).href;
  document.head.appendChild(link);
}

export function openAvatarCropper(bitmap) {
  ensureCss();
  const w = bitmap.width ?? bitmap.naturalWidth;
  const h = bitmap.height ?? bitmap.naturalHeight;
  const minSide = Math.min(w, h);
  let zoom = 1;                 // 1 = the short side fills the viewport
  let cx = w / 2;
  let cy = h / 2;               // centre of the viewport in source pixels

  const root = document.createElement('div');
  root.className = 'avatar-cropper';
  root.innerHTML = `<div class="avatar-cropper-box" role="dialog" aria-modal="true" aria-label="${esc(t('avatar.crop.title'))}">
    <h2>${t('avatar.crop.title')}</h2>
    <p class="avatar-cropper-hint">${t('avatar.crop.hint')}</p>
    <canvas width="${VIEW_PX}" height="${VIEW_PX}"></canvas>
    <input type="range" min="0" max="${SLIDER_STEPS}" value="0" aria-label="${esc(t('avatar.crop.zoom'))}">
    <div class="avatar-cropper-actions">
      <button class="menu-btn" data-act="cancel">${t('avatar.crop.cancel')}</button>
      <button class="menu-btn primary" data-act="ok">${t('avatar.crop.confirm')}</button>
    </div></div>`;
  const canvas = root.querySelector('canvas');
  const slider = root.querySelector('input');
  const g = canvas.getContext('2d');

  const clamp = () => {
    const half = minSide / zoom / 2;
    cx = Math.min(w - half, Math.max(half, cx));
    cy = Math.min(h - half, Math.max(half, cy));
  };
  const draw = () => {
    clamp();
    const side = minSide / zoom;
    g.clearRect(0, 0, VIEW_PX, VIEW_PX);
    g.drawImage(bitmap, cx - side / 2, cy - side / 2, side, side, 0, 0, VIEW_PX, VIEW_PX);
    g.fillStyle = SHADE;
    g.beginPath();                       // darken everything outside the round avatar preview
    g.rect(0, 0, VIEW_PX, VIEW_PX);
    g.arc(VIEW_PX / 2, VIEW_PX / 2, VIEW_PX / 2, 0, Math.PI * 2, true);
    g.fill('evenodd');
    g.strokeStyle = FRAME;
    g.lineWidth = 2;
    g.beginPath();
    g.arc(VIEW_PX / 2, VIEW_PX / 2, VIEW_PX / 2 - 1, 0, Math.PI * 2);
    g.stroke();
    slider.value = String(Math.round(Math.log(zoom) / Math.log(ZOOM_MAX) * SLIDER_STEPS));
  };
  const setZoom = (z) => {
    zoom = Math.min(ZOOM_MAX, Math.max(1, z));
    draw();
  };

  let drag = null;
  const onDown = (e) => {
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const k = minSide / zoom / VIEW_PX;   // source pixels per viewport pixel
    cx -= (e.clientX - drag.x) * k;
    cy -= (e.clientY - drag.y) * k;
    drag.x = e.clientX;
    drag.y = e.clientY;
    draw();
  };
  const onUp = (e) => {
    if (drag && e.pointerId === drag.id) drag = null;
  };
  const onWheel = (e) => {
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * ZOOM_STEP));
  };
  const onSlider = () => setZoom(Math.pow(ZOOM_MAX, Number(slider.value) / SLIDER_STEPS));

  return new Promise((resolve) => {
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      slider.removeEventListener('input', onSlider);
      root.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey, true);
      root.remove();
      resolve(result);
    };
    const confirm = () => {
      clamp();
      const side = minSide / zoom;
      finish({ sx: cx - side / 2, sy: cy - side / 2, side });
    };
    function onClick(e) {
      const act = e.target.closest?.('[data-act]')?.dataset.act;
      if (act === 'ok') confirm();
      else if (act === 'cancel' || e.target === root) finish(null);
    }
    function onKey(e) {
      if (e.code !== 'Escape' && e.code !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') finish(null);
      else confirm();
    }
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    slider.addEventListener('input', onSlider);
    root.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    draw();
    root.querySelector('[data-act="ok"]').focus();
  });
}
