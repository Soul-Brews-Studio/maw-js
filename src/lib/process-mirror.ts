/**
 * Process raw tmux pane capture into N visible non-empty lines.
 * Replaces 6+ box-drawing chars with a 60-char separator. Pads to fixed height.
 */
export function processMirror(raw: string, lines: number): string {
  const sep = '─'.repeat(60);
  const filtered = raw
    .replace(/[─━]{6,}/g, sep)
    .split('\n')
    .filter(l => l.trim() !== '');
  const visible = filtered.slice(-lines);
  const pad = Math.max(0, lines - visible.length);
  return '\n'.repeat(pad) + visible.join('\n');
}
