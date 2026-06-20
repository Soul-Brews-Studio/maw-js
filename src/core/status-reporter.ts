/**
 * status-reporter.ts — ship + provision the agent status-reporter hook script.
 *
 * bud-init and scripts/deploy-hooks.ts wire each oracle's .claude/settings.json
 * to run `$HOME/.config/maw/hooks/status-reporter.sh` on SessionStart/Stop, but
 * nothing ever created that file — so a clean deploy wired a hook pointing at a
 * missing script, and agent status silently never updated. This provisions it.
 *
 * The script content is embedded (base64) so it survives bundling into the
 * `maw` binary; the human-readable source of truth is
 * `scripts/hooks/status-reporter.sh`, and status-reporter.test.ts asserts the
 * two stay in sync.
 */
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

// base64 of scripts/hooks/status-reporter.sh — verified in sync by the test.
const SCRIPT_B64 =
  "IyEvYmluL2Jhc2gKIyBDbGF1ZGUgQ29kZSBob29rIOKGkiBtYXcgYWdlbnQgc3RhdHVzIHJlcG9ydGVyCiMgUG9zdHMgZmVlZCBldmVudCB0byBtYXcgc2VydmVyIGZvciBzdGF0dXMgdHJhY2tpbmcuCiMgVXNlZCBieTogU2Vzc2lvblN0YXJ0LCBTdG9wIGhvb2tzIGluIGVhY2ggb3JhY2xlJ3MgLmNsYXVkZS9zZXR0aW5ncy5qc29uCiMKIyBQcm92aXNpb25lZCB0byAkSE9NRS8uY29uZmlnL21hdy9ob29rcy9zdGF0dXMtcmVwb3J0ZXIuc2ggYnkgYnVkLWluaXQgKwojIHNjcmlwdHMvZGVwbG95LWhvb2tzLnRzIChzcmMvY29yZS9zdGF0dXMtcmVwb3J0ZXIudHMgaXMgdGhlIHJ1bnRpbWUgc291cmNlKS4KCk1BV19QT1JUPSIke01BV19QT1JUOi0zNDU2fSIKTUFXX1VSTD0iaHR0cDovL2xvY2FsaG9zdDoke01BV19QT1JUfS9hcGkvZmVlZCIKCkhPT0tfRVZFTlQ9IiR7Q0xBVURFX0hPT0tfRVZFTlQ6LX0iClsgLXogIiRIT09LX0VWRU5UIiBdICYmIGV4aXQgMAoKT1JBQ0xFPSIke0NMQVVERV9BR0VOVF9OQU1FOi19IgppZiBbIC16ICIkT1JBQ0xFIiBdOyB0aGVuCiAgT1JBQ0xFPSQodG11eCBkaXNwbGF5LW1lc3NhZ2UgLXAgJyN7c2Vzc2lvbl9uYW1lfScgMj4vZGV2L251bGwgfCBzZWQgJ3MvXlswLTldKi0vLycpCmZpClsgLXogIiRPUkFDTEUiIF0gJiYgZXhpdCAwCgpTRVNTSU9OX0lEPSIke0NMQVVERV9TRVNTSU9OX0lEOi19IgpQUk9KRUNUPSQoYmFzZW5hbWUgIiR7UFdEfSIgMj4vZGV2L251bGwpCgpjdXJsIC1zIC1YIFBPU1QgIiRNQVdfVVJMIiBcCiAgLUggJ0NvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vanNvbicgXAogIC1kICJ7XCJvcmFjbGVcIjpcIiR7T1JBQ0xFfVwiLFwiZXZlbnRcIjpcIiR7SE9PS19FVkVOVH1cIixcInNlc3Npb25JZFwiOlwiJHtTRVNTSU9OX0lEfVwiLFwicHJvamVjdFwiOlwiJHtQUk9KRUNUfVwiLFwiaG9zdFwiOlwiJChob3N0bmFtZSAtcyAyPi9kZXYvbnVsbCB8fCBlY2hvIGxvY2FsKVwiLFwibWVzc2FnZVwiOlwiaG9vazoke0hPT0tfRVZFTlR9XCJ9IiBcCiAgPi9kZXYvbnVsbCAyPiYxICYKCmV4aXQgMAo=";

/** The status-reporter shell script content. */
export const STATUS_REPORTER_SH = Buffer.from(SCRIPT_B64, "base64").toString("utf8");

/** Canonical install path: $HOME/.config/maw/hooks/status-reporter.sh */
export function statusReporterPath(home = homedir()): string {
  return join(home, ".config", "maw", "hooks", "status-reporter.sh");
}

export interface EnsureResult {
  path: string;
  /** true if we wrote the file (it was missing), false if it already existed. */
  created: boolean;
}

/**
 * Create the status-reporter script if it's missing, and make it executable.
 * Non-destructive: an existing script (e.g. a hand-customized one) is left as
 * is — we only fix the "wired but never shipped" gap. Idempotent.
 */
export function ensureStatusReporterScript(home = homedir()): EnsureResult {
  const path = statusReporterPath(home);
  if (existsSync(path)) {
    try { chmodSync(path, 0o755); } catch {}
    return { path, created: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, STATUS_REPORTER_SH);
  try { chmodSync(path, 0o755); } catch {}
  return { path, created: true };
}
