// Small in-game confirm dialog (window.confirm() does not work inside the artifact).
// confirmDialog({ messageKey, params }) -> Promise<boolean>; Enter / confirm button = true, Esc / cancel / backdrop = false.
import { t } from '../i18n/i18n.js';

let open = null;

/** True while a confirm dialog is shown (game hotkeys ignore keys then) */
export const isConfirmDialogOpen = () => open !== null;

export function confirmDialog({ messageKey, params = {}, confirmKey = 'dialog.confirm', cancelKey = 'dialog.cancel' }) {
  if (open) return Promise.resolve(false);
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    backdrop.innerHTML = `<div class="confirm-dialog" role="alertdialog" aria-modal="true">
      <p></p>
      <div class="confirm-buttons">
        <button type="button" data-role="cancel"></button>
        <button type="button" data-role="confirm" class="danger"></button>
      </div></div>`;
    backdrop.querySelector('p').textContent = t(messageKey, params);
    const cancelBtn = backdrop.querySelector('[data-role="cancel"]');
    const confirmBtn = backdrop.querySelector('[data-role="confirm"]');
    cancelBtn.textContent = t(cancelKey);
    confirmBtn.textContent = t(confirmKey);

    const close = (result) => {
      window.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      open = null;
      resolve(result);
    };
    const onKey = (e) => {
      if (e.code === 'Escape') close(false);
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') close(document.activeElement !== cancelBtn);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    confirmBtn.addEventListener('click', () => close(true));
    cancelBtn.addEventListener('click', () => close(false));
    backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(false); });
    document.body.appendChild(backdrop);
    open = backdrop;
    cancelBtn.focus(); // the safe choice is the default
  });
}
