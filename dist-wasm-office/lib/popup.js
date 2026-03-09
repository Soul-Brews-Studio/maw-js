// Popup renderer — polls WASM state, renders HTML overlay

import { readPopup } from './wasm-bridge.js';

export function startPopupLoop(exports) {
  const popupEl = document.getElementById('agent-popup');
  let lastPopup = '';

  setInterval(() => {
    try {
      const popup = readPopup(exports);
      if (popup === lastPopup) return;
      lastPopup = popup;

      if (!popup || popup === '0') {
        popupEl.className = '';
        return;
      }

      // Format: "1|x|y|name|session|status|preview|color"
      const parts = popup.split('|');
      if (parts[0] !== '1' || parts.length < 8) {
        popupEl.className = '';
        return;
      }
      const [, x, y, name, session, status, preview, color] = parts;

      popupEl.style.left = `${x}px`;
      popupEl.style.top = `${y}px`;
      popupEl.className = 'visible';
      popupEl.innerHTML = `
        <div style="background:#1a1a2e;border:1px solid ${color};border-radius:8px;padding:12px;min-width:200px;color:#fff;font-family:monospace">
          <div style="font-size:14px;font-weight:bold;color:${color};margin-bottom:4px">${name}</div>
          <div style="font-size:11px;color:#888;margin-bottom:8px">${session} &bull; ${status}</div>
          <div style="font-size:11px;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px">${preview || '...'}</div>
        </div>`;
    } catch (e) {}
  }, 50);
}
