// Data loop — WebSocket + REST polling, pushes into WASM

import { stripAnsi, detectStatus } from './status.js';
import { pushAgents, pushSaiyan } from './wasm-bridge.js';

let sessions = [];
const prevStatus = {};

export function startDataLoop(exports) {
  console.log('[bridge] Starting data loop');

  // WebSocket for session tree
  function connectWS() {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onmessage = (e) => {
      const d = JSON.parse(e.data);
      if (d.type === 'sessions') sessions = d.sessions;
    };
    ws.onclose = () => setTimeout(connectWS, 1000);
    ws.onerror = () => {};
  }
  connectWS();

  // Capture polling → status detection → push to WASM
  async function poll() {
    const targets = [];
    sessions.forEach(s =>
      s.windows.forEach(w => targets.push({
        target: `${s.name}:${w.index}`, name: w.name,
        session: s.name, windowIndex: w.index, active: w.active
      }))
    );

    const agents = [];
    const saiyanList = [];

    for (let i = 0; i < targets.length; i += 4) {
      await Promise.allSettled(targets.slice(i, i + 4).map(async (t) => {
        try {
          const res = await fetch(`/api/capture?target=${encodeURIComponent(t.target)}`);
          const data = await res.json();
          const content = data.content || '';
          const status = detectStatus(t.target, content);
          const text = stripAnsi(content);
          const lines = text.split('\n').filter(l => l.trim());
          const preview = (lines[lines.length - 1] || '').slice(0, 120);

          if (prevStatus[t.target] && prevStatus[t.target] !== 'busy' && status === 'busy')
            saiyanList.push(t.target);
          prevStatus[t.target] = status;
          agents.push({ ...t, status, preview });
        } catch {
          agents.push({ ...t, status: 'idle', preview: '' });
        }
      }));
    }

    if (agents.length > 0) pushAgents(exports, agents);
    if (saiyanList.length > 0) pushSaiyan(exports, saiyanList);

    setTimeout(poll, 5000);
  }
  poll();
}
