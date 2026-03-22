// Bridge: JS data layer → WASM game engine
// Polls maw-js server for session/capture data and pushes to window.__oracle_agents

const API_BASE = window.location.origin;
let ws = null;
let sessions = [];
let captures = {};

// --- Agent data pushed to WASM via window global ---
// WASM calls window.__oracle_agents() as a function — must return string or null
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
      const name = win.name || `agent-${idx}`;

      agents.push(`${target}|${name}|${session.name}|${status}|${preview}`);
    }
  }
  _agentData = agents.length > 0 ? agents.join('\n') : null;

  // Update navbar agent count
  const countEl = document.getElementById('agent-count');
  if (countEl) countEl.textContent = `${agents.length} agent${agents.length !== 1 ? 's' : ''}`;
}

// --- Status detection (reuse from existing office) ---

const spinnerChars = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏','◐','◓','◑','◒'];
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
  } catch (e) {
    // Silent fail, will retry
  }
}

async function pollCaptures() {
  const targets = [];
  for (const session of sessions) {
    for (const win of (session.windows || [])) {
      targets.push(`${session.name}:${win.index}`);
    }
  }

  // Parallel fetch, 4 at a time
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

window.__oracle_show_popup = function(target, x, y) {
  const capture = captures[target];
  if (!capture) return;

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

  popup.style.display = 'block';

  // Center the popup on screen
  popup.style.left = '50%';
  popup.style.top = '50%';
  popup.style.transform = 'translate(-50%, -50%)';
};

window.__oracle_hide_popup = function() {
  popup.style.display = 'none';
};

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
  text = text.slice(-4000); // last 4000 chars
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
    // Scale up pixel art 4× with crisp rendering
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
    bgLayer.style.opacity = '0.08'; // subtle texture overlay
    console.log('[Oracle Bridge] Background set from WASM:', imageUrl);
  };
  img.src = '/' + imageUrl;
};

// --- Init ---

connectWs();
setInterval(pollSessions, 5000);
setInterval(pollCaptures, 5000);

console.log('[Oracle Bridge] 8-bit office bridge initialized');
