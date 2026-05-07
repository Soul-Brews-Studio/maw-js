// #1114 — Canonical CLI error format.
//
// RFC: maw-js CLI previously had three drifting error styles:
//   1. red-✗  — `\x1b[31m✗\x1b[0m message`  (most common; no semantic prefix)
//   2. bare-✗ — `✗ message`                  (uncolored; visually inconsistent)
//   3. red "error:" prefix — already used by impl-rename.ts                       ← canonical
//
// Decision: standardize on the red `error:` prefix (Rust/cargo-style). It's
// machine-greppable, screen-reader-friendly, and decouples the visual marker
// from the word semantic. Optional dim hint on the next line for actionable
// remediation. ✗ glyphs remain valid for non-error inline status (warnings,
// progress markers).
//
// Format (canonical):
//   error: <message>
//     hint: <optional-hint>
//
// ANSI: red on `error`, default on message; dim on the hint line.
// No trailing newline — the caller is responsible (matches console.error).

const RED = "\x1b[31m";
const DIM = "\x1b[90m";
const RESET = "\x1b[0m";

export function formatError(msg: string, hint?: string): string {
  const main = `${RED}error${RESET}: ${msg}`;
  return hint ? `${main}\n${DIM}  hint: ${hint}${RESET}` : main;
}
