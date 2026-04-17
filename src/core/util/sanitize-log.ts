/**
 * Sanitize an attacker-influenceable string before logging.
 *
 * Closes CodeQL `js/log-injection` (alpha.129 first-scan, issue #474). When
 * untrusted bytes — fields parsed from WebSocket frames, HTTP headers, peer
 * messages — go straight into `console.log`, an attacker can:
 *
 *   1. Forge log lines with embedded `\n` to make their payload look like a
 *      separate, legitimate event (log injection / log forgery).
 *   2. Re-color subsequent terminal output with ANSI escape sequences, hiding
 *      real warnings or impersonating other tools' output.
 *   3. Smuggle control characters (BEL, BS, DEL) that affect what an operator
 *      sees vs. what the log file actually contains.
 *
 * This helper neutralizes all three. It is deliberately conservative: replace
 * the dangerous byte with a visible printable marker rather than silently
 * dropping it, so an operator can see "something untrusted was here" without
 * the byte itself doing damage.
 *
 * Truncation is opt-in via `maxLen`. When applied, the truncation marker
 * (`…[+N]`) is itself printable + visible.
 *
 * Use `sanitizeLogField` for any value that originated outside this process
 * AND is about to be interpolated into a log line. Local-only values
 * (timestamps, our own config, exception stacks from our own code) do not
 * need it.
 */

const MAX_DEFAULT_LEN = 200;

// Strips ANSI CSI sequences (ESC [ ... letter), the most common control
// vector. Also covers OSC (ESC ]) by stripping the lead-in. Other esc forms
// are rare but neutralized by the control-char step below.
const ANSI_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// All ASCII control characters except tab (\x09) and space — covers ESC
// (\x1b), newlines, CR, BEL, BS, NUL, plus 0x7F (DEL). Bare ESC that did
// NOT match a CSI/OSC sequence above falls through here and gets the
// visible \xHH marker treatment (consistent with other control bytes).
// Tab is operationally useful in log output, so keep it.
const CONTROL_CHARS_RE = /[\x00-\x08\x0a-\x1f\x7f]/g;

/**
 * Sanitize one untrusted field for safe inclusion in a log line.
 *
 * @param value any input — coerced to string. `undefined` and `null` become
 *              the literal string `"undefined"` / `"null"` (printable, visible).
 * @param maxLen optional cap. Defaults to 200; pass 0 to disable truncation.
 * @returns a string safe to interpolate into `console.log` etc.
 */
export function sanitizeLogField(value: unknown, maxLen: number = MAX_DEFAULT_LEN): string {
  // Coerce. Avoid throwing on objects with custom toString that errors —
  // wrap defensively.
  let s: string;
  try {
    s = value === undefined ? "undefined" : value === null ? "null" : String(value);
  } catch {
    s = "[unstringifiable]";
  }

  // Order matters: strip ANSI escape sequences FIRST (they contain printable
  // chars after \x1b that we want to preserve nothing of), then strip the
  // remaining control characters.
  s = s.replace(ANSI_CSI_RE, "")
       .replace(ANSI_OSC_RE, "")
       .replace(CONTROL_CHARS_RE, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

  if (maxLen > 0 && s.length > maxLen) {
    const dropped = s.length - maxLen;
    s = `${s.slice(0, maxLen)}…[+${dropped}]`;
  }

  return s;
}
