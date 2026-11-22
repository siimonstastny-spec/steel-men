// Three-way dialog in the style of ConfirmDialog.js (same CSS classes, confirmDialog.css): used for unsaved settings.
// choiceDialog({ messageKey, choices: [{ id, labelKey, danger }], cancelId, defaultId? }) -> Promise<id>; Esc / backdrop = the cancelId choice.
// Order of choices = order on screen: back / cancel on the left, continue / confirm on the right.
import { t } from '../i18n/i18n.js';

let open = null;

export function choiceDialog({ messageKey, params = {}, choices, cancelId, defaultId }) {
  if (open) return Promise.resolve(cancelId);
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    backdrop.innerHTML = `<div class="confirm-dialog" role="alertdialog" aria-modal="true"><p></p><div class="confirm-buttons"></div></div>`;
    backdrop.querySelector('p').textContent = t(messageKey, params);
    const row = backdrop.querySelector('.confirm-buttons');
    const close = (id) => {
      window.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      open = null;
      resolve(id);
    };
    const buttons = choices.map(({ id, labelKey, danger }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t(labelKey);
      if (danger) b.className = 'danger';
      b.addEventListener('click', () => close(id));
      row.appendChild(b);
      return b;
    });
    const onKey = (e) => {
      if (e.code === 'Escape') close(cancelId);
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') document.activeElement?.click?.();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) close(cancelId); });
    document.body.appendChild(backdrop);
    open = backdrop;
    // [B1] choices go left to right: back / cancel first, the continuing choice last (default focus unless defaultId says otherwise)
    const def = defaultId !== undefined ? choices.findIndex((c) => c.id === defaultId) : -1;
    buttons[def >= 0 ? def : buttons.length - 1].focus();
  });
}
