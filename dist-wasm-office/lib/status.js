// Status detection — mirrors useSessions.ts heuristic

const busyRx = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◑◒◓]/;
const hashHist = {};

export function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return h;
}

export function detectStatus(target, content) {
  const text = stripAnsi(content);
  const lines = text.split('\n').filter(l => l.trim());
  const bottom = lines.slice(-5).join('\n');
  const hasPrompt = bottom.includes('❯');
  const hasBusy = busyRx.test(bottom) || /● \w+/.test(bottom) ||
    /\b(Read|Edit|Write|Bash|Grep|Glob|Agent)\b/.test(bottom);
  const topPart = text.split('\n').slice(0, Math.floor(text.split('\n').length * 0.85)).join('\n');
  const h = hash(topPart);
  const e = hashHist[target] || { prev: 0, curr: 0, n: 0 };
  e.prev = e.curr; e.curr = h;
  e.n = (e.prev !== 0 && e.prev !== e.curr) ? 0 : e.n + 1;
  hashHist[target] = e;
  if (hasBusy) return 'busy';
  if (hasPrompt && e.n >= 2) return 'ready';
  if (e.prev === 0) return hasPrompt ? 'ready' : 'idle';
  if (e.n <= 3) return 'busy';
  if (e.n <= 8) return 'ready';
  return hasPrompt ? 'ready' : 'idle';
}
