// Canvas Bridge SDK v0.1
// Standardized JS ↔ WASM communication for Oracle canvas apps
// Any WASM engine (Bevy, custom) can use this bridge via window.__oracle_* globals

export class CanvasBridge {
  constructor(apiBase = window.location.origin) {
    this.apiBase = apiBase;
    this.ws = null;
    this.sessions = [];
    this.captures = {};
    this._agentData = null;
    this._zoomDelta = 0;
    this._callbacks = {
      onAgents: [],
      onCapture: [],
      onPopup: [],
      onZoom: [],
    };

    this._registerGlobals();
  }

  // --- Public API ---

  /** Start WebSocket + REST polling */
  connect() {
    this._connectWs();
    this._pollInterval = setInterval(() => this._pollSessions(), 5000);
    this._captureInterval = setInterval(() => this._pollCaptures(), 5000);
    return this;
  }

  /** Subscribe to events */
  on(event, callback) {
    if (this._callbacks[event]) {
      this._callbacks[event].push(callback);
    }
    return this;
  }

  /** Get current sessions */
  getSessions() { return this.sessions; }

  /** Get capture content for a target */
  getCapture(target) { return this.captures[target]?.content || ''; }

  /** Send keys to a tmux target */
  async sendKeys(target, keys) {
    try {
      await fetch(`${this.apiBase}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target, keys }),
      });
    } catch (e) { console.warn('[CanvasBridge] Send failed:', e); }
  }

  /** Push zoom from HTML controls to WASM */
  zoom(direction) { this._zoomDelta = direction; }

  /** Set zoom level display */
  setZoomDisplay(el) { this._zoomEl = el; }

  /** Set agent count display */
  setAgentCountDisplay(el) { this._agentCountEl = el; }

  /** Detect agent status from terminal content */
  static detectStatus(content) {
    if (!content || content.trim().length === 0) return 'idle';
    const last = content.slice(-500);
    const busyPatterns = [
      /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|◐|◓|◑|◒/,
      /\[.*tool.*\]/i,
      /Running|Executing|Building|Compiling/,
    ];
    const readyPatterns = [/❯\s*$/m, /\$\s*$/m, />\s*$/m];
    for (const p of busyPatterns) { if (p.test(last)) return 'busy'; }
    for (const p of readyPatterns) { if (p.test(last)) return 'ready'; }
    return 'idle';
  }

  /** ANSI to HTML with Catppuccin Mocha palette */
  static ansiToHtml(text) { return _ansiToHtml(text); }

  // --- WASM globals (the contract between JS and WASM) ---

  _registerGlobals() {
    const self = this;

    // WASM reads agent data from this
    window.__oracle_agents = () => self._agentData;

    // WASM calls these for popup
    window.__oracle_show_popup = (target, x, y) => {
      self._emit('onPopup', { action: 'show', target, x, y, capture: self.captures[target] });
    };
    window.__oracle_hide_popup = () => {
      self._emit('onPopup', { action: 'hide' });
    };

    // WASM reads zoom delta
    window.__oracle_get_zoom = () => { const d = self._zoomDelta; self._zoomDelta = 0; return d; };

    // WASM sets zoom level
    window.__oracle_set_zoom_level = (level) => {
      if (self._zoomEl) self._zoomEl.textContent = level.toFixed(1) + 'x';
      self._emit('onZoom', { level });
    };

    // WASM sets background
    window.__oracle_set_bg = (imageUrl) => {
      // Subclass or callback can handle this
    };
  }

  // --- Internal ---

  _emit(event, data) {
    for (const cb of this._callbacks[event] || []) { cb(data); }
  }

  _pushAgents() {
    const agents = [];
    for (const session of this.sessions) {
      for (const win of (session.windows || [])) {
        const target = `${session.name}:${win.index}`;
        const capture = this.captures[target] || {};
        const status = CanvasBridge.detectStatus(capture.content || '');
        const preview = _lastLine(capture.content || '');
        const name = win.name || `agent-${win.index}`;
        agents.push(`${target}|${name}|${session.name}|${status}|${preview}`);
      }
    }
    this._agentData = agents.length > 0 ? agents.join('\n') : null;

    if (this._agentCountEl) {
      this._agentCountEl.textContent = `${agents.length} agent${agents.length !== 1 ? 's' : ''}`;
    }

    this._emit('onAgents', agents);
  }

  _connectWs() {
    const wsUrl = `${this.apiBase.replace('http', 'ws')}/ws`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'sessions') {
          this.sessions = msg.sessions || [];
          this._pushAgents();
        } else if (msg.type === 'capture') {
          this.captures[msg.target] = { content: msg.content, time: Date.now() };
          this._pushAgents();
          this._emit('onCapture', { target: msg.target, content: msg.content });
        }
      } catch (err) { console.warn('[CanvasBridge] WS parse error:', err); }
    };

    this.ws.onclose = () => {
      setTimeout(() => this._connectWs(), 3000);
    };
    this.ws.onerror = () => {};
  }

  async _pollSessions() {
    try {
      const res = await fetch(`${this.apiBase}/api/sessions`);
      if (res.ok) { this.sessions = await res.json(); this._pushAgents(); }
    } catch (e) { /* retry */ }
  }

  async _pollCaptures() {
    const targets = [];
    for (const s of this.sessions) {
      for (const w of (s.windows || [])) { targets.push(`${s.name}:${w.index}`); }
    }
    for (let i = 0; i < targets.length; i += 4) {
      await Promise.allSettled(targets.slice(i, i + 4).map(async (target) => {
        try {
          const res = await fetch(`${this.apiBase}/api/capture?target=${encodeURIComponent(target)}`);
          if (res.ok) {
            const data = await res.json();
            this.captures[target] = { content: data.content, time: Date.now() };
          }
        } catch (e) { /* skip */ }
      }));
    }
    this._pushAgents();
  }
}

// --- ANSI parser (shared utility) ---

function _lastLine(content) {
  if (!content) return '';
  const lines = content.trim().split('\n');
  return (lines[lines.length - 1] || '').slice(0, 80);
}

const _AC = [
  "#0a0a0f","#f38ba8","#a6e3a1","#f9e2af","#89b4fa","#cba6f7","#94e2d5","#cdd6f4",
  "#585b70","#f38ba8","#a6e3a1","#f9e2af","#89b4fa","#cba6f7","#94e2d5","#ffffff",
];

function _a256(n) {
  if (n < 16) return _AC[n];
  if (n < 232) { n -= 16; return `rgb(${Math.floor(n/36)*51},${(Math.floor(n/6)%6)*51},${(n%6)*51})`; }
  const v = (n - 232) * 10 + 8;
  return `rgb(${v},${v},${v})`;
}

function _esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

function _ansiToHtml(text) {
  if (!text) return '';
  text = text.slice(-4000);
  let h = "", fg = null, bg = null;
  let b = 0, d = 0, i = 0, u = 0, s = 0, open = 0;
  for (const p of text.split(/(\x1b\[[0-9;]*m)/)) {
    const m = p.match(/^\x1b\[([0-9;]*)m$/);
    if (!m) { h += _esc(p); continue; }
    if (open) { h += "</span>"; open = 0; }
    const codes = m[1] ? m[1].split(";").map(Number) : [0];
    for (let j = 0; j < codes.length; j++) {
      const c = codes[j];
      if (!c) { fg = bg = null; b = d = i = u = s = 0; }
      else if (c === 1) b = 1; else if (c === 2) d = 1; else if (c === 3) i = 1;
      else if (c === 4) u = 1; else if (c === 9) s = 1;
      else if (c === 22) b = d = 0; else if (c === 23) i = 0;
      else if (c === 24) u = 0; else if (c === 29) s = 0;
      else if (c >= 30 && c <= 37) fg = _AC[c - 30];
      else if (c === 38 && codes[j+1] === 5) { fg = _a256(codes[j+2]); j += 2; }
      else if (c === 38 && codes[j+1] === 2) { fg = `rgb(${codes[j+2]},${codes[j+3]},${codes[j+4]})`; j += 4; }
      else if (c === 39) fg = null;
      else if (c >= 40 && c <= 47) bg = _AC[c - 40];
      else if (c === 48 && codes[j+1] === 5) { bg = _a256(codes[j+2]); j += 2; }
      else if (c === 48 && codes[j+1] === 2) { bg = `rgb(${codes[j+2]},${codes[j+3]},${codes[j+4]})`; j += 4; }
      else if (c === 49) bg = null;
      else if (c >= 90 && c <= 97) fg = _AC[c - 82];
      else if (c >= 100 && c <= 107) bg = _AC[c - 92];
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
