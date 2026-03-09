// Popup with live terminal stream — polls WASM for hover state,
// fetches tmux capture for hovered agent, renders ANSI as HTML.

import { readPopup } from './wasm-bridge.js';
import { ansiToHtml } from './ansi.js';

export function startPopupLoop(exports) {
  const popupEl = document.getElementById('agent-popup');
  let currentTarget = null;
  let captureTimer = null;
  let lastPopupState = '';

  // Poll WASM for hover state (50ms — responsive to mouse movement)
  setInterval(() => {
    try {
      const popup = readPopup(exports);
      if (popup === lastPopupState) return;
      lastPopupState = popup;

      if (!popup || popup === '0') {
        hide();
        return;
      }

      // Format: "1|x|y|name|session|status|preview|color|target"
      const parts = popup.split('|');
      if (parts[0] !== '1' || parts.length < 9) { hide(); return; }

      const [, x, y, name, session, status, preview, color, target] = parts;

      // Position popup (clamp to viewport)
      const px = Math.min(parseFloat(x), window.innerWidth - 500);
      const py = Math.max(parseFloat(y), 10);
      popupEl.style.left = `${px}px`;
      popupEl.style.top = `${py}px`;
      popupEl.className = 'visible';

      // New agent hovered — start capture stream
      if (target !== currentTarget) {
        currentTarget = target;

        // Show loading state
        popupEl.innerHTML = buildPopup(name, session, status, color,
          '<div class="term-loading">Connecting to terminal...</div>');

        // Stop previous polling
        if (captureTimer) clearInterval(captureTimer);

        // Fetch immediately, then every 500ms
        fetchCapture(target, name, session, status, color);
        captureTimer = setInterval(() =>
          fetchCapture(target, name, session, status, color), 500);
      }
    } catch (e) {}
  }, 50);

  function hide() {
    popupEl.className = '';
    currentTarget = null;
    if (captureTimer) { clearInterval(captureTimer); captureTimer = null; }
  }

  async function fetchCapture(target, name, session, status, color) {
    try {
      const res = await fetch(`/api/capture?target=${encodeURIComponent(target)}`);
      const data = await res.json();
      const content = data.content || '';

      // Show last 24 lines of terminal
      const lines = content.split('\n');
      const visible = lines.slice(-24).join('\n');
      const html = ansiToHtml(visible);

      popupEl.innerHTML = buildPopup(name, session, status, color,
        `<div class="term-content">${html}</div>`);

      // Auto-scroll terminal to bottom
      const termEl = popupEl.querySelector('.popup-terminal');
      if (termEl) termEl.scrollTop = termEl.scrollHeight;
    } catch (e) {
      // Keep showing last content
    }
  }
}

function buildPopup(name, session, status, color, terminalHtml) {
  const dot = status === 'busy' ? '#fdd835' : status === 'ready' ? '#4caf50' : '#555';
  return `
    <div class="popup-card" style="border-color:${color}">
      <div class="popup-header">
        <span class="popup-name" style="color:${color}">${name}</span>
        <span class="popup-status">
          <span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${dot};margin-right:4px"></span>
          ${status}
        </span>
      </div>
      <div class="popup-session">${session}</div>
      <div class="popup-terminal">${terminalHtml}</div>
    </div>`;
}
