// Bridge: JS data layer → WASM game engine
// Polls maw-js server for session/capture data and pushes to window.__oracle_agents

const API_BASE = window.location.origin;
let ws = null;
let sessions = [];
let captures = {};

// --- Agent data pushed to WASM via window global ---
let _agentData = null;
window.__oracle_agents = function() { return _agentData; };

function pushAgentsToWasm() {
  const agents = [];
  for (const session of sessions) {
    for (const win of (session.windows || [])) {
      const target = `${session.name}:${win.index}`;
      const capture = captures[target] || {};
      const status = detectStatus(capture.content || '');
      const preview = lastLine(capture.content || '');
      const name = win.name || `agent-${win.index}`;

      agents.push(`${target}|${name}|${session.name}|${status}|${preview}`);
    }
  }
  _agentData = agents.length > 0 ? agents.join('\n') : null;

  const countEl = document.getElementById('agent-count');
  if (countEl) countEl.textContent = `${agents.length} agent${agents.length !== 1 ? 's' : ''}`;
}

// --- Status detection ---

const busyPatterns = [
  /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|◐|◓|◑|◒/,
  /\[.*tool.*\]/i,
  /Running|Executing|Building|Compiling/,
];
const readyPatterns = [
  /❯\s*$/m,
  /\$\s*$/m,
  />\s*$/m,
];

function detectStatus(content) {
  if (!content || content.trim().length === 0) return 'idle';
  const last50 = content.slice(-500);
  for (const p of busyPatterns) {
    if (p.test(last50)) return 'busy';
  }
  for (const p of readyPatterns) {
    if (p.test(last50)) return 'ready';
  }
  return 'idle';
}

function lastLine(content) {
  if (!content) return '';
  const lines = content.trim().split('\n');
  return (lines[lines.length - 1] || '').slice(0, 80);
}

// --- WebSocket connection ---

function connectWs() {
  const wsUrl = `${API_BASE.replace('http', 'ws')}/ws`;
  ws = new WebSocket(wsUrl);

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'sessions') {
        sessions = msg.sessions || [];
        pushAgentsToWasm();
      } else if (msg.type === 'capture') {
        captures[msg.target] = { content: msg.content, time: Date.now() };
        pushAgentsToWasm();
      }
    } catch (err) {
      console.warn('WS parse error:', err);
    }
  };

  ws.onclose = () => {
    console.log('WS closed, reconnecting in 3s...');
    setTimeout(connectWs, 3000);
  };

  ws.onerror = (err) => {
    console.warn('WS error:', err);
  };
}

// --- REST polling fallback ---

async function pollSessions() {
  try {
    const res = await fetch(`${API_BASE}/api/sessions`);
    if (res.ok) {
      sessions = await res.json();
      pushAgentsToWasm();
    }
  } catch (e) { /* retry next interval */ }
}

async function pollCaptures() {
  const targets = [];
  for (const session of sessions) {
    for (const win of (session.windows || [])) {
      targets.push(`${session.name}:${win.index}`);
    }
  }

  for (let i = 0; i < targets.length; i += 4) {
    const batch = targets.slice(i, i + 4);
    await Promise.allSettled(batch.map(async (target) => {
      try {
        const res = await fetch(`${API_BASE}/api/capture?target=${encodeURIComponent(target)}`);
        if (res.ok) {
          const data = await res.json();
          captures[target] = { content: data.content, time: Date.now() };
        }
      } catch (e) { /* skip */ }
    }));
  }
  pushAgentsToWasm();
}

// --- Popup: show terminal capture on hover/click ---

const popup = document.getElementById('agent-popup');
const popupName = document.getElementById('popup-name');
const popupStatus = document.getElementById('popup-status');
const popupTerminal = document.getElementById('popup-terminal');

let _pinnedTarget = null;
let _captureInterval = null;
let _showTime = 0;
let _hideRequested = false;

window.__oracle_show_popup = function(target, x, y) {
  if (_pinnedTarget) return;

  const capture = captures[target];
  if (!capture) return;

  _hideRequested = false;
  _showTime = Date.now();
  _showPopup(target, capture);
};

window.__oracle_hide_popup = function() {
  if (_pinnedTarget) return;
  _hideRequested = true;
};

// Check every 100ms if a deferred hide should execute (after anti-blink window)
setInterval(() => {
  if (!_hideRequested || _pinnedTarget) return;
  if (popup.style.display === 'none') return;
  if (Date.now() - _showTime >= 800) {
    popup.style.display = 'none';
    _hideRequested = false;
  }
}, 100);

function _showPopup(target, capture) {
  const parts = target.split(':');
  const session = sessions.find(s => s.name === parts[0]);
  const winIdx = parseInt(parts[1]);
  const win = session?.windows?.find(w => w.index === winIdx);
  const name = win?.name || target;
  const status = detectStatus(capture.content);

  popupName.textContent = name;
  popupStatus.textContent = status;
  popupStatus.className = `status status-${status}`;
  popupTerminal.innerHTML = ansiToHtml(capture.content || '');
  popupTerminal.scrollTop = popupTerminal.scrollHeight;

  popup.dataset.target = target;
  popup.style.display = 'block';
  popup.style.left = '50%';
  popup.style.top = '50%';
  popup.style.transform = 'translate(-50%, -50%)';
}

// Click popup to pin it
popup.addEventListener('click', (e) => {
  if (e.target.id === 'popup-close' || e.target.id === 'popup-send' || e.target.id === 'popup-input') return;
  const target = popup.dataset.target;
  if (!target || _pinnedTarget) return;

  _pinnedTarget = target;
  popup.classList.add('pinned');
  document.getElementById('popup-input').focus();

  // Realtime refresh pinned capture every 50ms
  _captureInterval = setInterval(() => {
    const cap = captures[_pinnedTarget];
    if (cap) {
      const wasAtBottom = popupTerminal.scrollHeight - popupTerminal.scrollTop - popupTerminal.clientHeight < 50;
      popupTerminal.innerHTML = ansiToHtml(cap.content || '');
      popupStatus.textContent = detectStatus(cap.content);
      popupStatus.className = `status status-${detectStatus(cap.content)}`;
      if (wasAtBottom) popupTerminal.scrollTop = popupTerminal.scrollHeight;
    }
  }, 50);
});

// Close button unpins
document.getElementById('popup-close').addEventListener('click', (e) => {
  e.stopPropagation();
  _pinnedTarget = null;
  popup.classList.remove('pinned');
  popup.style.display = 'none';
  if (_captureInterval) { clearInterval(_captureInterval); _captureInterval = null; }
});

// Esc to close popup (pinned or unpinned)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && popup.style.display !== 'none') {
    e.preventDefault();
    _pinnedTarget = null;
    popup.classList.remove('pinned');
    popup.style.display = 'none';
    if (_captureInterval) { clearInterval(_captureInterval); _captureInterval = null; }
  }
});

// Send input to agent via tmux
document.getElementById('popup-send').addEventListener('click', (e) => {
  e.stopPropagation();
  _sendInput();
});
document.getElementById('popup-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); _sendInput(); }
  e.stopPropagation(); // prevent WASD movement while typing
});

async function _sendInput() {
  const input = document.getElementById('popup-input');
  const text = input.value.trim();
  if (!text || !_pinnedTarget) return;
  input.value = '';

  try {
    await fetch(`${API_BASE}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: _pinnedTarget, keys: text + '\n' }),
    });
  } catch (e) { console.warn('Send failed:', e); }
}

// --- Full ANSI → HTML (Catppuccin Mocha palette) ---

const AC = [
  "#0a0a0f","#f38ba8","#a6e3a1","#f9e2af","#89b4fa","#cba6f7","#94e2d5","#cdd6f4",
  "#585b70","#f38ba8","#a6e3a1","#f9e2af","#89b4fa","#cba6f7","#94e2d5","#ffffff",
];

function a256(n) {
  if (n < 16) return AC[n];
  if (n < 232) {
    n -= 16;
    return `rgb(${Math.floor(n/36)*51},${(Math.floor(n/6)%6)*51},${(n%6)*51})`;
  }
  const v = (n - 232) * 10 + 8;
  return `rgb(${v},${v},${v})`;
}

function esc(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function ansiToHtml(text) {
  if (!text) return '';
  text = text.slice(-4000);
  let h = "", fg = null, bg = null;
  let b = 0, d = 0, i = 0, u = 0, s = 0, open = 0;

  for (const p of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = p.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) { h += esc(p); continue; }
    if (open) { h += "</span>"; open = 0; }
    const codes = m[1] ? m[1].split(";").map(Number) : [0];
    for (let j = 0; j < codes.length; j++) {
      const c = codes[j];
      if (!c) { fg = bg = null; b = d = i = u = s = 0; }
      else if (c === 1) b = 1; else if (c === 2) d = 1; else if (c === 3) i = 1;
      else if (c === 4) u = 1; else if (c === 9) s = 1;
      else if (c === 22) b = d = 0; else if (c === 23) i = 0;
      else if (c === 24) u = 0; else if (c === 29) s = 0;
      else if (c >= 30 && c <= 37) fg = AC[c - 30];
      else if (c === 38 && codes[j+1] === 5) { fg = a256(codes[j+2]); j += 2; }
      else if (c === 38 && codes[j+1] === 2) { fg = `rgb(${codes[j+2]},${codes[j+3]},${codes[j+4]})`; j += 4; }
      else if (c === 39) fg = null;
      else if (c >= 40 && c <= 47) bg = AC[c - 40];
      else if (c === 48 && codes[j+1] === 5) { bg = a256(codes[j+2]); j += 2; }
      else if (c === 48 && codes[j+1] === 2) { bg = `rgb(${codes[j+2]},${codes[j+3]},${codes[j+4]})`; j += 4; }
      else if (c === 49) bg = null;
      else if (c >= 90 && c <= 97) fg = AC[c - 82];
      else if (c >= 100 && c <= 107) bg = AC[c - 92];
    }
    const st = [];
    if (fg) st.push("color:" + fg);
    if (bg) st.push("background:" + bg);
    if (b) st.push("font-weight:bold");
    if (d) st.push("opacity:0.6");
    if (i) st.push("font-style:italic");
    if (u || s) st.push("text-decoration:" + (u ? "underline" : "") + (u && s ? " " : "") + (s ? "line-through" : ""));
    if (st.length) { h += `<span style="${st.join(";")}">`; open = 1; }
  }
  if (open) h += "</span>";
  return h;
}

// --- Background from WASM ---

window.__oracle_set_bg = function(imageUrl) {
  const bgLayer = document.getElementById('bg-layer');
  if (!bgLayer) return;

  const img = new Image();
  img.onload = () => {
    const scale = 4;
    const c = document.createElement('canvas');
    c.width = img.width * scale;
    c.height = img.height * scale;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, c.width, c.height);

    const dataUrl = c.toDataURL('image/png');
    bgLayer.style.backgroundImage = `url(${dataUrl})`;
    bgLayer.style.backgroundRepeat = 'repeat';
    bgLayer.style.backgroundSize = `${c.width}px ${c.height}px`;
    bgLayer.style.imageRendering = 'pixelated';
    bgLayer.style.opacity = '0.08';
    console.log('[Oracle Bridge] Background set from WASM:', imageUrl);
  };
  img.src = '/' + imageUrl;
};

// --- Zoom bridge ---

let _zoomDelta = 0;
window.__oracle_zoom = function(dir) { _zoomDelta = dir; };
window.__oracle_get_zoom = function() { const d = _zoomDelta; _zoomDelta = 0; return d; };
window.__oracle_set_zoom_level = function(level) {
  const el = document.getElementById('zoom-level');
  if (el) el.textContent = level.toFixed(1) + 'x';
};

// --- FPS counter ---

let _fpsFrames = 0;
let _fpsLast = performance.now();
function _fpsLoop() {
  _fpsFrames++;
  const now = performance.now();
  if (now - _fpsLast >= 1000) {
    const el = document.getElementById('fps');
    if (el) el.textContent = _fpsFrames + ' fps';
    _fpsFrames = 0;
    _fpsLast = now;
  }
  requestAnimationFrame(_fpsLoop);
}
requestAnimationFrame(_fpsLoop);

// --- Init ---

connectWs();
setInterval(pollSessions, 5000);
setInterval(pollCaptures, 5000);

console.log('[Oracle Bridge] 8-bit office bridge initialized');
