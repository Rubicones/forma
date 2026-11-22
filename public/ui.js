// Shared pieces of the interface for the client-work screens: modal dialogs in the design system (title, close
// button, Escape, one at a time per kind) and a confirm step that replaces the browser's own confirm().
import {el} from './dom.js';

const open = new Map();   // key -> dialog, so a double click does not stack two copies of the same dialog

// Opens a modal. Returns {dialog, body, foot, setTitle, close} or null when one with this key is already open
// (that one is brought forward instead). body: where the content goes; foot: the row for the buttons.
// backdropClose: a click outside closes it too (only for dialogs without anything to lose).
export function openModal({key = null, className = '', title = '', label = '', backdropClose = false} = {}) {
  if (key && open.get(key)?.isConnected) { open.get(key).focus(); return null; }
  const dialog = el('dialog', 'modal card' + (className ? ' ' + className : ''));
  const head = el('div', 'modal-head');
  const h = el('h2', '', title);
  h.id = 'modal-' + Math.random().toString(36).slice(2);
  dialog.setAttribute('aria-labelledby', h.id);
  if (label) dialog.setAttribute('aria-label', label);
  const x = el('button', 'icon-btn modal-x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', 'Close');
  x.onclick = () => dialog.close();
  head.append(h, x);
  const body = el('div', 'modal-body');
  const foot = el('div', 'modal-foot');
  dialog.append(head, body, foot);
  if (backdropClose) {
    // Outside the box on both press and release: a text selection dragged out of the dialog does not close it.
    const outside = e => { const r = dialog.getBoundingClientRect(); return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom; };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', e => { pressedOutside = e.target === dialog && outside(e); });
    dialog.addEventListener('click', e => { if (pressedOutside && e.target === dialog && outside(e)) dialog.close(); });
  }
  dialog.addEventListener('close', () => { dialog.remove(); if (key && open.get(key) === dialog) open.delete(key); });
  document.body.append(dialog);
  if (key) open.set(key, dialog);
  dialog.showModal();
  return {dialog, body, foot, setTitle: text => { h.textContent = text; }, close: () => dialog.close()};
}

export function button(label, cls = 'btn secondary', onClick = null) {
  const b = el('button', cls, label);
  b.type = 'button';
  if (onClick) b.onclick = onClick;
  return b;
}

// A loading state on a button that survives nothing else: on, then off (or the dialog closes).
export function busy(btn, on = true) {
  btn.disabled = on;
  btn.classList.toggle('is-loading', on);
  btn.setAttribute('aria-busy', String(on));
}

// A message line inside a dialog or form: plain, or an error the eye catches.
export function message(node, text = '', {error = false} = {}) {
  node.textContent = text;
  node.classList.toggle('is-error', Boolean(error && text));
}

// A confirm step in the design system. Resolves true only on the confirm button.
export function confirmAction({title, text = '', confirm = 'Confirm', cancel = 'Cancel', danger = false} = {}) {
  return new Promise(resolve => {
    const m = openModal({className: 'modal-confirm', title, backdropClose: true});
    if (!m) return resolve(false);
    let answer = false;
    if (text) m.body.append(el('p', 'modal-text', text));
    const no = button(cancel, 'btn secondary', () => m.close());
    const yes = button(confirm, 'btn ' + (danger ? 'danger' : 'primary'), () => { answer = true; m.close(); });
    m.foot.append(no, yes);
    m.dialog.addEventListener('close', () => resolve(answer));
    yes.focus();
  });
}
