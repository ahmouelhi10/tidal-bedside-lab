// Drag handle that lets the learner widen or narrow a side window (the action panel, the echo window). The width is kept
// per window in localStorage (a convenience only: everything works without it). Double-click or Home resets it.
const load = (key) => { try { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; } };
const save = (key, v) => { try { if (v == null) localStorage.removeItem(key); else localStorage.setItem(key, String(Math.round(v))); } catch { /* storage blocked: keep the width for this visit only */ } };

/**
 * @param {HTMLElement} target the window whose width changes
 * @param {{edge: 'left'|'right', key: string, min: number, max: () => number, label: string, onChange?: () => void}} o
 *   edge: which side of the window carries the handle (a window docked on the right is resized from its left edge);
 *   host: the element that holds the handle (default: the window itself)
 * @returns {{handle: HTMLElement, apply: () => void, dispose: () => void}}
 */
export function makeResizable(target, { edge, key, min, max, label, onChange, host = target }) {
  const handle = document.createElement('div');
  handle.className = `rz rz-${edge}`; handle.tabIndex = 0;
  handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical'); handle.setAttribute('aria-label', label); handle.title = label;
  let width = load(key);
  const enabled = () => window.innerWidth > 600;                  // phones: panels are bottom sheets, widths come from the stylesheet
  const apply = () => {
    if (!enabled() || width == null) { target.style.width = ''; return; }
    width = Math.max(min, Math.min(max(), width));
    target.style.width = width + 'px';
    handle.setAttribute('aria-valuenow', String(Math.round(width)));
  };
  const set = (w) => { width = w; apply(); save(key, width); onChange?.(); };
  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    if (!enabled()) return;
    e.preventDefault(); e.stopPropagation(); handle.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, w: target.getBoundingClientRect().width }; document.body.classList.add('resizing');
  });
  handle.addEventListener('pointermove', (e) => { if (!drag) return; const dx = e.clientX - drag.x; set(drag.w + (edge === 'left' ? -dx : dx)); });
  const end = () => { drag = null; document.body.classList.remove('resizing'); };
  handle.addEventListener('pointerup', end); handle.addEventListener('pointercancel', end);
  handle.addEventListener('dblclick', () => { width = null; target.style.width = ''; save(key, null); onChange?.(); });
  handle.addEventListener('keydown', (e) => {
    const cur = target.getBoundingClientRect().width, step = e.shiftKey ? 60 : 20, grow = edge === 'left' ? 'ArrowLeft' : 'ArrowRight', shrink = edge === 'left' ? 'ArrowRight' : 'ArrowLeft';
    if (e.key === grow) set(cur + step); else if (e.key === shrink) set(cur - step);
    else if (e.key === 'Home') { width = null; target.style.width = ''; save(key, null); onChange?.(); } else return;
    e.preventDefault(); e.stopPropagation();
  });
  window.addEventListener('resize', apply);
  host.append(handle); apply();
  return { handle, apply, dispose: () => window.removeEventListener('resize', apply) };
}
