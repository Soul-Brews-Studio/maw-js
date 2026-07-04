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
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

// base64 of scripts/hooks/status-reporter.sh — verified in sync by the test.
const SCRIPT_B64 =
  "IyEvYmluL2Jhc2gKIyBDbGF1ZGUgQ29kZSBob29rIOKGkiBtYXcgYWdlbnQgc3RhdHVzIHJlcG9ydGVyCiMgUG9zdHMgZmVlZCBldmVudCB0byBtYXcgc2VydmVyIGZvciBzdGF0dXMgdHJhY2tpbmcuCiMgVXNlZCBieTogU2Vzc2lvblN0YXJ0LCBTdG9wIGhvb2tzIGluIGVhY2ggb3JhY2xlJ3MgLmNsYXVkZS9zZXR0aW5ncy5qc29uCiMKIyBQcm92aXNpb25lZCB0byAkSE9NRS8uY29uZmlnL21hdy9ob29rcy9zdGF0dXMtcmVwb3J0ZXIuc2ggYnkgYnVkLWluaXQgKwojIHNjcmlwdHMvZGVwbG95LWhvb2tzLnRzIChzcmMvY29yZS9zdGF0dXMtcmVwb3J0ZXIudHMgaXMgdGhlIHJ1bnRpbWUgc291cmNlKS4KCk1BV19QT1JUPSIke01BV19QT1JUOi0zNDU2fSIKTUFXX1VSTD0iaHR0cDovL2xvY2FsaG9zdDoke01BV19QT1JUfS9hcGkvZmVlZCIKCiMgQ0MgcGFzc2VzIGEgSlNPTiBwYXlsb2FkIG9uIHN0ZGluIChTdG9wIOKGkiBpbmNsdWRlcyAudHJhbnNjcmlwdF9wYXRoKS4gUmVhZCBpdCB1cAojIGZyb250IHNvIGl0J3MgYXZhaWxhYmxlIGZvciB0dXJuLWVuZGluZyBlcnJvciBkZXRlY3Rpb24gKGtvYm8tMTExKS4gSGFybWxlc3Mgd2hlbgojIGVtcHR5IChTZXNzaW9uU3RhcnQgLyBub24tQ0MgY2FsbGVycykg4oCUIG5vdGhpbmcgZG93bnN0cmVhbSByZXF1aXJlcyBpdC4KSU5QVVQ9JChjYXQgMj4vZGV2L251bGwpCgpIT09LX0VWRU5UPSIke0NMQVVERV9IT09LX0VWRU5UOi19IgpbIC16ICIkSE9PS19FVkVOVCIgXSAmJiBleGl0IDAKCk9SQUNMRT0iJHtDTEFVREVfQUdFTlRfTkFNRTotfSIKaWYgWyAteiAiJE9SQUNMRSIgXTsgdGhlbgogIE9SQUNMRT0kKHRtdXggZGlzcGxheS1tZXNzYWdlIC1wICcje3Nlc3Npb25fbmFtZX0nIDI+L2Rldi9udWxsIHwgc2VkICdzL15bMC05XSotLy8nKQpmaQpbIC16ICIkT1JBQ0xFIiBdICYmIGV4aXQgMAoKU0VTU0lPTl9JRD0iJHtDTEFVREVfU0VTU0lPTl9JRDotfSIKUFJPSkVDVD0kKGJhc2VuYW1lICIke1BXRH0iIDI+L2Rldi9udWxsKQoKIyBQYW5lIGlkICgkVE1VWF9QQU5FLCBlLmcuICIlNDAiKSDigJQgY2FycmllZCBhcyBkYXRhLnBhbmVJZCBzbyBhIFN0b3AgZXZlbnQgYXR0cmlidXRlcwojIHRoZSBpZGxlIHN0YXRlIHRvIHRoZSByaWdodCBwYW5lIChrb2JvLTEwOSwgZGVjaXNpb24gQikuIFNBTUUgam9pbiBrZXkgdGhlIHdvcmtsb2cgKwojIHByZXNlbmNlIGhvb2tzIHVzZS4gTm8gcGFuZSBJTkRFWCBoZXJlOiBpZGxlIGlzIGEgcGVyLXBhbmUgc3RhdGUgc2lnbmFsLCBuZXZlciBhCiMgZGlzcGxheWVkIGZlZWQgbGluZS4gRW1wdHkgb3V0c2lkZSB0bXV4IOKGkiBvbWl0IGRhdGEgKHBhbmVsZXNzIFN0b3AgPSBubyBwZXItcGFuZSBzaWduYWwpLgpQQU5FSUQ9IiR7VE1VWF9QQU5FOi19IgoKIyBUdXJuLWVuZGluZyBBUEkgZXJyb3IgKGtvYm8tMTExKTogb24gU3RvcCwgaWYgdGhlIExBU1QgYXNzaXN0YW50IG1lc3NhZ2UgaW4gdGhlCiMgdHJhbnNjcmlwdCBpcyBhbiBpc0FwaUVycm9yTWVzc2FnZSAoQ0MgcmVjb3JkcyBBUEkvcmF0ZS1saW1pdC9vdmVybG9hZCB0dXJucyB0aGlzCiMgd2F5LCBtb2RlbDoiPHN5bnRoZXRpYz4iKSwgZmxhZyB0aGUgcGFuZSBhcyBlcnJvci4gT25seSB0aGUgTEFTVCBhc3Npc3RhbnQgbWVzc2FnZQojIOKAlCBhIG1pZC10dXJuIGVycm9yIHRoYXQgbGF0ZXIgcmVjb3ZlcmVkIGxlYXZlcyBhIG5vcm1hbCBmaW5hbCBtZXNzYWdlLCBzbyBpdCBpcyBOT1QKIyBmbGFnZ2VkLiBCZXN0LWVmZm9ydDogbmVlZHMganEgKyB0aGUgdHJhbnNjcmlwdDsgYSBtaXNzaW5nIGVpdGhlciDihpIgZmFsbHMgYmFjayB0byBpZGxlLgojIHRhaWwgLW4gYm91bmRzIHRoZSByZWFkICh0aGUgdGVybWluYWwgbWVzc2FnZSBzaXRzIGF0IHRoZSBlbmQpOyBhIGpxIE5VTEwvYWJzZW50IGZsYWcKIyBjb21wYXJlcyBmYWxzZSwgc28gb25seSBhbiBleHBsaWNpdCB0cnVlIHRyaXBzIGl0LgpFUlJPUj0iIgppZiBbICIkSE9PS19FVkVOVCIgPSAiU3RvcCIgXSAmJiBjb21tYW5kIC12IGpxID4vZGV2L251bGwgMj4mMTsgdGhlbgogIFRSQU5TQ1JJUFQ9JChwcmludGYgJyVzJyAiJElOUFVUIiB8IGpxIC1yICcudHJhbnNjcmlwdF9wYXRoIC8vIGVtcHR5JyAyPi9kZXYvbnVsbCkKICBpZiBbIC1uICIkVFJBTlNDUklQVCIgXSAmJiBbIC1mICIkVFJBTlNDUklQVCIgXTsgdGhlbgogICAgTEFTVF9BU1NJU1RBTlRfRVJSPSQodGFpbCAtbiAxMDAgIiRUUkFOU0NSSVBUIiAyPi9kZXYvbnVsbCBcCiAgICAgIHwganEgLWMgJ3NlbGVjdCgudHlwZT09ImFzc2lzdGFudCIpIHwgLmlzQXBpRXJyb3JNZXNzYWdlJyAyPi9kZXYvbnVsbCB8IHRhaWwgLTEpCiAgICBbICIkTEFTVF9BU1NJU1RBTlRfRVJSIiA9ICJ0cnVlIiBdICYmIEVSUk9SPXRydWUKICBmaQpmaQoKREFUQT0iIgppZiBbIC1uICIkUEFORUlEIiBdOyB0aGVuCiAgaWYgWyAtbiAiJEVSUk9SIiBdOyB0aGVuCiAgICBEQVRBPSIsXCJkYXRhXCI6e1wicGFuZUlkXCI6XCIke1BBTkVJRH1cIixcImVycm9yXCI6dHJ1ZX0iCiAgZWxzZQogICAgREFUQT0iLFwiZGF0YVwiOntcInBhbmVJZFwiOlwiJHtQQU5FSUR9XCJ9IgogIGZpCmZpCgpjdXJsIC1zIC1YIFBPU1QgIiRNQVdfVVJMIiBcCiAgLUggJ0NvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vanNvbicgXAogIC1kICJ7XCJvcmFjbGVcIjpcIiR7T1JBQ0xFfVwiLFwiZXZlbnRcIjpcIiR7SE9PS19FVkVOVH1cIixcInNlc3Npb25JZFwiOlwiJHtTRVNTSU9OX0lEfVwiLFwicHJvamVjdFwiOlwiJHtQUk9KRUNUfVwiLFwiaG9zdFwiOlwiJChob3N0bmFtZSAtcyAyPi9kZXYvbnVsbCB8fCBlY2hvIGxvY2FsKVwiLFwibWVzc2FnZVwiOlwiaG9vazoke0hPT0tfRVZFTlR9XCIke0RBVEF9fSIgXAogID4vZGV2L251bGwgMj4mMSAmCgpleGl0IDAK";

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

// ── maw MCP nudge (mawjs-2) ──────────────────────────────────────────────────
// A universal PreToolUse(Bash) forcing function that denies bash `maw hey/reply/
// inbox/ls` and redirects to the maw_* MCP tools. Co-located with status-reporter
// (both are universal, per-oracle provisioned hooks — NOT company/worklog scoped)
// so bud-init can ship it without importing the heavy worklog hook-setup chain.
// Single source of truth: scripts/hooks/maw-mcp-nudge.sh; hook-setup re-exports
// MAW_MCP_NUDGE_B64 for its HOOKS table, and worklog.test asserts byte-identity.
export const MAW_MCP_NUDGE_B64 =
  "IyEvYmluL2Jhc2gKIyBQcmVUb29sVXNlKEJhc2gpIOKAlCBmb3JjZSB0aGUgbWF3XyogTUNQIHRvb2xzIG9uIHRoZSBob3QgcGF0aCBpbnN0ZWFkIG9mIGBtYXcgPGNtZD5gCiMgdmlhIGJhc2ggKGZsZWV0IHRva2VuLWF1ZGl0IDIwMjYtMDctMDU6IDY5NTQgYmFzaC1tYXcgY2FsbHMsIE1DUCB1c2FnZSAwKS4gVGhlIHJ1bGUKIyBhbHJlYWR5IGxpdmVkIGluIENMQVVERS5tZCBhbmQgd2FzIGlnbm9yZWQg4oaSIHRoaXMgaXMgdGhlIHN0cnVjdHVyYWwgZm9yY2luZyBmdW5jdGlvbgojIChkZW55KSwgbm90IGFub3RoZXIgaW50ZW50aW9uLiBERU5ZIG9ubHkgdGhlIHN1YmNvbW1hbmRzIHRoYXQgaGF2ZSBhIDE6MSBNQ1Agc3VyZmFjZQojIHdpdGggbm8gYmFzaC1vbmx5IHNpYmxpbmc7IGFsbG93IGV2ZXJ5dGhpbmcgZWxzZSAocGVlay93YWtlL2Jyb2FkY2FzdC90ZWFtL3F1b3RhICsKIyBpbmJveCBhcmNoaXZlIGhhdmUgbm8gTUNQIGVxdWl2YWxlbnQpLgojCiMgT3JhY2xlLWFnbm9zdGljOiBubyBoYXJkY29kZWQgb3JhY2xlIG5hbWUuIFByb3Zpc2lvbmVkIHRvCiMgJEhPTUUvLmNvbmZpZy9tYXcvaG9va3MvbWF3LW1jcC1udWRnZS5zaCBieSBgbWF3IGNvbXBhbnkgd29ya2xvZyBzZXR1cC1ob29rc2AgKyBidWQtaW5pdC4KIwojIHBvbnl0YWlsOiBzdWJzdHJpbmcgbWF0Y2ggb24gdGhlIHdob2xlIGNvbW1hbmQuIEEgY29tbWFuZCB0aGF0IG1lcmVseSBxdW90ZXMKIyAibWF3IGhleSIgaW5zaWRlIGEgc3RyaW5nIGNvdWxkIGZhbHNlLWRlbnkg4oCUIHJhcmU7IHJlLXdvcmQgb3IgdXNlIHRoZSBNQ1AgdG9vbC4KCklOUFVUPSQoY2F0KQpjb21tYW5kIC12IGpxID4vZGV2L251bGwgMj4mMSB8fCBleGl0IDAKQ01EPSQocHJpbnRmICclcycgIiRJTlBVVCIgfCBqcSAtciAnc2VsZWN0KC50b29sX25hbWU9PSJCYXNoIikgfCAudG9vbF9pbnB1dC5jb21tYW5kIC8vIGVtcHR5JyAyPi9kZXYvbnVsbCkKWyAteiAiJENNRCIgXSAmJiBleGl0IDAKCmNhc2UgIiRDTUQiIGluCiAgKiJtYXcgaW5ib3ggYXJjaGl2ZSIqKSBleGl0IDAgOzsgICAgICAgICAgICAgICAgICMgbm8gTUNQIOKGkiBhbGxvdwogICoibWF3IGhleSAiKnwqIm1hdyBoZXkiKSAgICAgVE9PTD0ibWF3X2hleSIgOzsKICAqIm1hdyByZXBseSIqKSAgICAgICAgICAgICAgIFRPT0w9Im1hd19yZXBseSIgOzsKICAqIm1hdyBpbmJveCIqKSAgICAgICAgICAgICAgIFRPT0w9Im1hd19pbmJveCIgOzsKICAqIm1hdyBscyIqKSAgICAgICAgICAgICAgICAgIFRPT0w9Im1hd19scyIgOzsKICAqKSBleGl0IDAgOzsKZXNhYwoKUkVBU09OPSJtYXcgaG90LXBhdGgg4oaSIHVzZSB0aGUgJHtUT09MfSBNQ1AgdG9vbCwgbm90IGJhc2ggKHN0cnVjdHVyZWQgKyBza2lwcyBydGsgcGFyc2U7IHRva2VuLWF1ZGl0KS4gSWYgJHtUT09MfSBpc24ndCBsb2FkZWQgeWV0OiBUb29sU2VhcmNoIFwic2VsZWN0Om1jcF9fbWF3X18ke1RPT0x9XCIgdGhlbiBjYWxsIGl0LiBiYXNoIG1hdyBpcyBhbGxvd2VkIG9ubHkgZm9yIHBlZWsvd2FrZS9icm9hZGNhc3QvdGVhbS9xdW90YSArIGluYm94IGFyY2hpdmUuIgoKcHJpbnRmICd7Imhvb2tTcGVjaWZpY091dHB1dCI6eyJob29rRXZlbnROYW1lIjoiUHJlVG9vbFVzZSIsInBlcm1pc3Npb25EZWNpc2lvbiI6ImRlbnkiLCJwZXJtaXNzaW9uRGVjaXNpb25SZWFzb24iOiVzfX1cbicgXAogICIkKHByaW50ZiAnJXMnICIkUkVBU09OIiB8IGpxIC1ScyAuKSIKZXhpdCAwCg==";

/** The maw-mcp-nudge shell script content. */
export const MAW_MCP_NUDGE_SH = Buffer.from(MAW_MCP_NUDGE_B64, "base64").toString("utf8");

/** Canonical install path: $HOME/.config/maw/hooks/maw-mcp-nudge.sh */
export function mawMcpNudgePath(home = homedir()): string {
  return join(home, ".config", "maw", "hooks", "maw-mcp-nudge.sh");
}

/**
 * Create the maw-mcp-nudge script if missing (or refresh a stale copy), and make
 * it executable. Idempotent. Ships the universal MCP-nudge hook so a freshly-budded
 * oracle whose settings.json wires it doesn't point at a missing script.
 */
export function ensureMawMcpNudgeScript(home = homedir()): EnsureResult {
  const path = mawMcpNudgePath(home);
  if (existsSync(path) && readFileSync(path, "utf-8") === MAW_MCP_NUDGE_SH) {
    try { chmodSync(path, 0o755); } catch {}
    return { path, created: false };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, MAW_MCP_NUDGE_SH);
  try { chmodSync(path, 0o755); } catch {}
  return { path, created: true };
}
