/**
 * Install the worklog CC hooks into company oracles' Claude Code settings.
 *
 * Engine-first: `maw company worklog setup-hooks` provisions the hook scripts + merges the
 * hooks into each company member's .claude/settings.json, idempotently, so the
 * capture+inject engine runs without anyone configuring anything.
 *
 *   PostToolUse      → capture significant tool calls           (worklog-tool.sh)
 *   UserPromptSubmit → capture decisions + inject read-before-act (worklog-convo.sh)
 *   SessionStart     → inject orientation on wake                 (worklog-orient.sh)
 *
 * Scripts are base64-embedded (survive bundling); source of truth =
 * scripts/hooks/*.sh, kept in sync by hook-setup.test.ts.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { mawConfigPath } from "../xdg";
import { companyOracles } from "./company-scope";

interface HookSpec {
  event: "PostToolUse" | "UserPromptSubmit" | "SessionStart";
  matcher: string;
  file: string; // basename under ~/.config/maw/hooks/
  b64: string; // base64 of scripts/hooks/<file>
}

// base64 of scripts/hooks/*.sh — kept in sync by hook-setup.test.ts.
const HOOKS: HookSpec[] = [
  {
    event: "PostToolUse",
    matcher: "Bash|Edit|Write|MultiEdit",
    file: "worklog-tool.sh",
    b64: "IyEvYmluL2Jhc2gKIyBDbGF1ZGUgQ29kZSBQb3N0VG9vbFVzZSBob29rIOKGkiBtYXcgd29ya2xvZyAoc2lnbmlmaWNhbnQgdG9vbC1jYWxsIGFjdGl2aXR5KS4KIwojIEZvcndhcmRzIHRoZSB0b29sIG5hbWUgKyBpbnB1dCB0byBtYXcgL2FwaS9mZWVkOyB0aGUgbWF3IHNlcnZlciBhcHBsaWVzIHRoZQojIHNpZ25pZmljYW5jZSBmaWx0ZXIgKGdpdC9naCBCYXNoLCBFZGl0L1dyaXRlL011bHRpRWRpdCkgYW5kIHBlcnNpc3RzIG1hdGNoaW5nCiMgY2FsbHMgdG8gd29ya2xvZy5qc29ubC4gVGhlIHNldHRpbmdzLmpzb24gbWF0Y2hlciBhbHJlYWR5IG5hcnJvd3MgdG8gdGhvc2UKIyB0b29scywgc28gdGhpcyBzY3JpcHQganVzdCBmb3J3YXJkcyB3aGF0IGl0IHJlY2VpdmVzLgojCiMgUHJvdmlzaW9uZWQgdG8gJEhPTUUvLmNvbmZpZy9tYXcvaG9va3Mvd29ya2xvZy10b29sLnNoIGJ5IGBtYXcgd2F0Y2ggc2V0dXAtaG9va3NgLgoKTUFXX1BPUlQ9IiR7TUFXX1BPUlQ6LTM0NTZ9IgpNQVdfVVJMPSJodHRwOi8vbG9jYWxob3N0OiR7TUFXX1BPUlR9L2FwaS9mZWVkIgoKY29tbWFuZCAtdiBqcSA+L2Rldi9udWxsIDI+JjEgfHwgZXhpdCAwCgpJTlBVVD0kKGNhdCkKVE9PTD0kKHByaW50ZiAnJXMnICIkSU5QVVQiIHwganEgLXIgJy50b29sX25hbWUgLy8gZW1wdHknKQpbIC16ICIkVE9PTCIgXSAmJiBleGl0IDAKVE9PTF9JTlBVVD0kKHByaW50ZiAnJXMnICIkSU5QVVQiIHwganEgLWMgJy50b29sX2lucHV0IC8vIHt9JykKCk9SQUNMRT0iJHtDTEFVREVfQUdFTlRfTkFNRTotfSIKaWYgWyAteiAiJE9SQUNMRSIgXTsgdGhlbgogIE9SQUNMRT0kKHRtdXggZGlzcGxheS1tZXNzYWdlIC1wICcje3Nlc3Npb25fbmFtZX0nIDI+L2Rldi9udWxsIHwgc2VkICdzL15bMC05XSotLy8nKQpmaQpbIC16ICIkT1JBQ0xFIiBdICYmIE9SQUNMRT0idW5rbm93biIKUFJPSkVDVD0kKGJhc2VuYW1lICIke1BXRH0iIDI+L2Rldi9udWxsKQojIFBhbmUgaW5kZXggZGlzdGluZ3Vpc2hlcyBtdWx0aXBsZSBwYW5lcyBvZiBvbmUgb3JhY2xlIChodW1hbi9jb29yZC93b3JrZXIpLgojIEVtcHR5IG91dHNpZGUgdG11eCDigJQgdGhlIHNlcnZlciB0cmVhdHMgYSBtaXNzaW5nIHBhbmUgYXMgYmFjay1jb21wYXQuClBBTkU9JCh0bXV4IGRpc3BsYXktbWVzc2FnZSAtcCAnI3twYW5lX2luZGV4fScgMj4vZGV2L251bGwpCgpQQVlMT0FEPSQoanEgLW4gLS1hcmcgbyAiJE9SQUNMRSIgLS1hcmcgcCAiJFBST0pFQ1QiIC0tYXJnIHQgIiRUT09MIiAtLWFyZyBwYW5lICIkUEFORSIgLS1hcmdqc29uIHRpICIkVE9PTF9JTlBVVCIgXAogICd7b3JhY2xlOiRvLCBldmVudDoiUG9zdFRvb2xVc2UiLCBwcm9qZWN0OiRwLCBob3N0OiJsb2NhbCIsIG1lc3NhZ2U6KCJ0b29sOiIrJHQpLCBkYXRhOih7dG9vbF9uYW1lOiR0LCB0b29sX2lucHV0OiR0aX0gKyAoaWYgJHBhbmUgIT0gIiIgdGhlbiB7cGFuZTokcGFuZX0gZWxzZSB7fSBlbmQpKX0nKQoKY3VybCAtcyAtWCBQT1NUICIkTUFXX1VSTCIgXAogIC1IICdDb250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL2pzb24nIFwKICAtZCAiJFBBWUxPQUQiID4vZGV2L251bGwgMj4mMSAmCgpleGl0IDAK",
  },
  {
    event: "UserPromptSubmit",
    matcher: "",
    file: "worklog-convo.sh",
    b64: "IyEvYmluL2Jhc2gKIyBDbGF1ZGUgQ29kZSBVc2VyUHJvbXB0U3VibWl0IGhvb2sg4oaSIG1hdyB3b3JrbG9nLgojICAgY2FwdHVyZTogICByZWNvcmQgdGhlIGRlY2lzaW9uL2luc3RydWN0aW9uICgiVG9ueeKGkm9yYWNsZTogWCIpCiMgICBpbnRlcnJ1cHQ6IGlmIHRoZSBwcmlvciB0dXJuIGVuZGVkIHdpdGggIltSZXF1ZXN0IGludGVycnVwdGVkIGJ5IHVzZXIuLi5dIiwKIyAgICAgICAgICAgICAgcmVjb3JkIGEga2luZDppbnRlcnJ1cHQgZXZlbnQgKHRoZSBjb3JyZWN0aW5nIHByb21wdCB0aGF0IGZvbGxvd3MpCiMgICBpbmplY3Q6ICAgIHJlYWQtYmVmb3JlLWFjdCDigJQgcHVzaCBjb21wYW55IHN0YXRlICsgb3BlbiBjbGFpbXMgYmFjayBpbnRvIGNvbnRleHQKIyBQcm92aXNpb25lZCBieSBgbWF3IHdhdGNoIHNldHVwLWhvb2tzYC4KCk1BV19QT1JUPSIke01BV19QT1JUOi0zNDU2fSIKQkFTRT0iaHR0cDovL2xvY2FsaG9zdDoke01BV19QT1JUfSIKY29tbWFuZCAtdiBqcSA+L2Rldi9udWxsIDI+JjEgfHwgZXhpdCAwCgpJTlBVVD0kKGNhdCkKUFJPTVBUPSQocHJpbnRmICclcycgIiRJTlBVVCIgfCBqcSAtciAnLnByb21wdCAvLyBlbXB0eScpClRSQU5TQ1JJUFQ9JChwcmludGYgJyVzJyAiJElOUFVUIiB8IGpxIC1yICcudHJhbnNjcmlwdF9wYXRoIC8vIGVtcHR5JykKCk9SQUNMRT0iJHtDTEFVREVfQUdFTlRfTkFNRTotfSIKaWYgWyAteiAiJE9SQUNMRSIgXTsgdGhlbgogIE9SQUNMRT0kKHRtdXggZGlzcGxheS1tZXNzYWdlIC1wICcje3Nlc3Npb25fbmFtZX0nIDI+L2Rldi9udWxsIHwgc2VkICdzL15bMC05XSotLy8nKQpmaQpbIC16ICIkT1JBQ0xFIiBdICYmIE9SQUNMRT0idW5rbm93biIKUFJPSkVDVD0kKGJhc2VuYW1lICIke1BXRH0iIDI+L2Rldi9udWxsKQojIFBhbmUgaW5kZXggZGlzdGluZ3Vpc2hlcyBtdWx0aXBsZSBwYW5lcyBvZiBvbmUgb3JhY2xlIChodW1hbi9jb29yZC93b3JrZXIpLgojIEVtcHR5IG91dHNpZGUgdG11eCDigJQgdGhlIHNlcnZlciB0cmVhdHMgYSBtaXNzaW5nIHBhbmUgYXMgYmFjay1jb21wYXQuClBBTkU9JCh0bXV4IGRpc3BsYXktbWVzc2FnZSAtcCAnI3twYW5lX2luZGV4fScgMj4vZGV2L251bGwpCgojIGNhcHR1cmUgKGZpcmUtYW5kLWZvcmdldCkKaWYgWyAtbiAiJFBST01QVCIgXTsgdGhlbgogIENBUD0kKGpxIC1uIC0tYXJnIG8gIiRPUkFDTEUiIC0tYXJnIHAgIiRQUk9KRUNUIiAtLWFyZyBwciAiJFBST01QVCIgLS1hcmcgcGFuZSAiJFBBTkUiIFwKICAgICd7b3JhY2xlOiRvLCBldmVudDoiVXNlclByb21wdFN1Ym1pdCIsIHByb2plY3Q6JHAsIGhvc3Q6ImxvY2FsIiwgbWVzc2FnZToicHJvbXB0IiwgZGF0YTooe3Byb21wdDokcHJ9ICsgKGlmICRwYW5lICE9ICIiIHRoZW4ge3BhbmU6JHBhbmV9IGVsc2Uge30gZW5kKSl9JykKICBjdXJsIC1zIC1YIFBPU1QgIiRCQVNFL2FwaS9mZWVkIiAtSCAnQ29udGVudC1UeXBlOiBhcHBsaWNhdGlvbi9qc29uJyAtZCAiJENBUCIgPi9kZXYvbnVsbCAyPiYxICYKZmkKCiMgaW50ZXJydXB0IGRldGVjdGlvbiDigJQgdGhlIHByaW9yIHR1cm4gbGVmdCB0aGUgbWFya2VyIGFzIHRoZSBsYXN0IHRyYW5zY3JpcHQgZW50cnkKaWYgWyAtbiAiJFRSQU5TQ1JJUFQiIF0gJiYgWyAtZiAiJFRSQU5TQ1JJUFQiIF07IHRoZW4KICBpZiB0YWlsIC1uIDIgIiRUUkFOU0NSSVBUIiAyPi9kZXYvbnVsbCB8IGdyZXAgLXEgIlJlcXVlc3QgaW50ZXJydXB0ZWQgYnkgdXNlciI7IHRoZW4KICAgIElFVj0kKGpxIC1uIC0tYXJnIG8gIiRPUkFDTEUiIC0tYXJnIHAgIiRQUk9KRUNUIiAtLWFyZyBwciAiJFBST01QVCIgLS1hcmcgcGFuZSAiJFBBTkUiIFwKICAgICAgJ3tvcmFjbGU6JG8sIGV2ZW50OiJOb3RpZmljYXRpb24iLCBwcm9qZWN0OiRwLCBob3N0OiJsb2NhbCIsIG1lc3NhZ2U6ImludGVycnVwdCIsIGRhdGE6KHtraW5kOiJpbnRlcnJ1cHQiLCBwcm9tcHQ6JHByfSArIChpZiAkcGFuZSAhPSAiIiB0aGVuIHtwYW5lOiRwYW5lfSBlbHNlIHt9IGVuZCkpfScpCiAgICBjdXJsIC1zIC1YIFBPU1QgIiRCQVNFL2FwaS9mZWVkIiAtSCAnQ29udGVudC1UeXBlOiBhcHBsaWNhdGlvbi9qc29uJyAtZCAiJElFViIgPi9kZXYvbnVsbCAyPiYxICYKICBmaQpmaQoKIyBpbmplY3QgKHJlYWQtYmVmb3JlLWFjdCkg4oCUIHNob3J0IHRpbWVvdXQgc28gYSBzbG93L2Fic2VudCBzZXJ2ZXIgbmV2ZXIgYmxvY2tzIHRoZSBhZ2VudApJTkpFQ1Q9JChjdXJsIC1zIC0tbWF4LXRpbWUgMiAiJEJBU0UvYXBpL3dvcmtsb2c/b3JhY2xlPSR7T1JBQ0xFfSIgMj4vZGV2L251bGwgfCBqcSAtciAnLmluamVjdCAvLyBlbXB0eScpClsgLXogIiRJTkpFQ1QiIF0gJiYgZXhpdCAwCmpxIC1uIC0tYXJnIGN0eCAiJElOSkVDVCIgJ3tob29rU3BlY2lmaWNPdXRwdXQ6e2hvb2tFdmVudE5hbWU6IlVzZXJQcm9tcHRTdWJtaXQiLCBhZGRpdGlvbmFsQ29udGV4dDokY3R4fX0nCmV4aXQgMAo=",
  },
  {
    event: "SessionStart",
    matcher: "",
    file: "worklog-orient.sh",
    b64: "IyEvYmluL2Jhc2gKIyBDbGF1ZGUgQ29kZSBTZXNzaW9uU3RhcnQgaG9vayDihpIgbWF3IHdvcmtsb2c6IGluamVjdCBsYXRlc3QgY29tcGFueSBzdGF0ZSBvbiB3YWtlCiMgKG9yaWVudGF0aW9uKSwgc28gYW4gb3JhY2xlIHN0YXJ0cyBhbHJlYWR5IGF3YXJlIG9mIHJlY2VudCBhY3Rpdml0eSArIG9wZW4gY2xhaW1zLgojIFByb3Zpc2lvbmVkIGJ5IGBtYXcgd2F0Y2ggc2V0dXAtaG9va3NgLgoKTUFXX1BPUlQ9IiR7TUFXX1BPUlQ6LTM0NTZ9IgpCQVNFPSJodHRwOi8vbG9jYWxob3N0OiR7TUFXX1BPUlR9Igpjb21tYW5kIC12IGpxID4vZGV2L251bGwgMj4mMSB8fCBleGl0IDAKCk9SQUNMRT0iJHtDTEFVREVfQUdFTlRfTkFNRTotfSIKaWYgWyAteiAiJE9SQUNMRSIgXTsgdGhlbgogIE9SQUNMRT0kKHRtdXggZGlzcGxheS1tZXNzYWdlIC1wICcje3Nlc3Npb25fbmFtZX0nIDI+L2Rldi9udWxsIHwgc2VkICdzL15bMC05XSotLy8nKQpmaQpbIC16ICIkT1JBQ0xFIiBdICYmIGV4aXQgMAoKSU5KRUNUPSQoY3VybCAtcyAtLW1heC10aW1lIDIgIiRCQVNFL2FwaS93b3JrbG9nP29yYWNsZT0ke09SQUNMRX0iIDI+L2Rldi9udWxsIHwganEgLXIgJy5pbmplY3QgLy8gZW1wdHknKQpbIC16ICIkSU5KRUNUIiBdICYmIGV4aXQgMApqcSAtbiAtLWFyZyBjdHggIiRJTkpFQ1QiICd7aG9va1NwZWNpZmljT3V0cHV0Ontob29rRXZlbnROYW1lOiJTZXNzaW9uU3RhcnQiLCBhZGRpdGlvbmFsQ29udGV4dDokY3R4fX0nCmV4aXQgMAo=",
  },
  {
    // Company/dept policy — inject ONLY while the oracle is attached (server
    // decides via the attach marker). Separate concern + endpoint from worklog,
    // toggles independently. UserPromptSubmit only — wake injects nothing.
    event: "UserPromptSubmit",
    matcher: "",
    file: "company-policy.sh",
    b64: "IyEvYmluL2Jhc2gKIyBDbGF1ZGUgQ29kZSBVc2VyUHJvbXB0U3VibWl0IGhvb2sg4oaSIG1hdyBwb2xpY3k6IGluamVjdCBjb21wYW55ICsgZGVwdCBwb2xpY3kKIyBiYWNrIGludG8gY29udGV4dCwgYnV0IE9OTFkgd2hpbGUgdGhlIG9yYWNsZSBpcyBhdHRhY2hlZCAoc2VydmVyIGRlY2lkZXM7CiMgZGV0YWNoZWQg4oaSIGVtcHR5IOKGkiBub3RoaW5nIGluamVjdGVkKS4gSW5qZWN0LW9ubHkg4oCUIG5vIGNhcHR1cmUuCiMgUHJvdmlzaW9uZWQgYnkgYG1hdyB3YXRjaCBzZXR1cC1ob29rc2AuCgpNQVdfUE9SVD0iJHtNQVdfUE9SVDotMzQ1Nn0iCkJBU0U9Imh0dHA6Ly9sb2NhbGhvc3Q6JHtNQVdfUE9SVH0iCmNvbW1hbmQgLXYganEgPi9kZXYvbnVsbCAyPiYxIHx8IGV4aXQgMAoKT1JBQ0xFPSIke0NMQVVERV9BR0VOVF9OQU1FOi19IgppZiBbIC16ICIkT1JBQ0xFIiBdOyB0aGVuCiAgT1JBQ0xFPSQodG11eCBkaXNwbGF5LW1lc3NhZ2UgLXAgJyN7c2Vzc2lvbl9uYW1lfScgMj4vZGV2L251bGwgfCBzZWQgJ3MvXlswLTldKi0vLycpCmZpClsgLXogIiRPUkFDTEUiIF0gJiYgZXhpdCAwCgpJTkpFQ1Q9JChjdXJsIC1zIC0tbWF4LXRpbWUgMiAiJEJBU0UvYXBpL3BvbGljeT9vcmFjbGU9JHtPUkFDTEV9IiAyPi9kZXYvbnVsbCB8IGpxIC1yICcuaW5qZWN0IC8vIGVtcHR5JykKWyAteiAiJElOSkVDVCIgXSAmJiBleGl0IDAKanEgLW4gLS1hcmcgY3R4ICIkSU5KRUNUIiAne2hvb2tTcGVjaWZpY091dHB1dDp7aG9va0V2ZW50TmFtZToiVXNlclByb21wdFN1Ym1pdCIsIGFkZGl0aW9uYWxDb250ZXh0OiRjdHh9fScKZXhpdCAwCg==",
  },
];

export function hookScriptBody(file: string): string {
  const h = HOOKS.find(x => x.file === file);
  if (h) return Buffer.from(h.b64, "base64").toString("utf8");
  if (file === STATUSLINE_FILE) return Buffer.from(STATUSLINE_B64, "base64").toString("utf8");
  throw new Error(`unknown worklog hook: ${file}`);
}

function hookPath(file: string): string {
  return mawConfigPath("hooks", file);
}

// ── statusLine capture (kobo-104) ────────────────────────────────────────────
// The presence pipeline's capture side: a CC statusLine command that writes a
// per-pane presence file (model + context%). statusLine is a settings.json FIELD
// (not a hooks event), so it provisions separately from HOOKS but ships through
// the SAME setup-hooks sweep + attach path. base64 of scripts/hooks/maw-statusline.sh
// — kept in sync by worklog.test.ts.
const STATUSLINE_FILE = "maw-statusline.sh";
const STATUSLINE_B64 = "IyEvYmluL2Jhc2gKIyBDbGF1ZGUgQ29kZSBzdGF0dXNMaW5lIGNvbW1hbmQg4oaSIG1hdyBwcmVzZW5jZSBjYXB0dXJlIChrb2JvLTEwNCkuCiMKIyBSZWFkcyB0aGUgQ0Mgc3RhdHVzTGluZSBKU09OIG9uIHN0ZGluLCB3cml0ZXMgYSBzbWFsbCBwcmVzZW5jZSBmaWxlIGtleWVkIGJ5CiMgdGhlIHRtdXggcGFuZSBpZCAoJFRNVVhfUEFORSkgdG8gfi8ubWF3L3ByZXNlbmNlLzxwYW5lPi5qc29uIChhdG9taWMgd3JpdGUpLAojIHRoZW4gRUlUSEVSIGRlbGVnYXRlcyB0byB0aGUgb3JpZ2luYWwgc3RhdHVzTGluZSBjb21tYW5kIHRoaXMgb25lIHdyYXBwZWQKIyAocGFzc2VkIGJhc2U2NC1lbmNvZGVkIGFzICQxKSBPUiBwcmludHMgbWF3J3Mgb3duIGRlZmF1bHQgbGluZS4KIwojIEJlc3QtZWZmb3J0IGJ5IGRlc2lnbjogYSBtaXNzaW5nIGpxLCBubyB0bXV4LCBvciBhIHdyaXRlIGVycm9yIG11c3QgTkVWRVIKIyBicmVhayB0aGUgc3RhdHVzbGluZSDigJQgdGhlIHNjcmlwdCBhbHdheXMgZW1pdHMgYSBsaW5lIGFuZCBleGl0cyAwLiBDYXB0dXJlIGlzCiMgaW5kZXBlbmRlbnQgb2Ygb3V0cHV0ICh3ZSB3cml0ZSB0aGUgZmlsZSB3aGV0aGVyIHdlIGRlbGVnYXRlIG9yIHByaW50KS4KIwojIEtFWSA9IHBhbmUsIE5PVCBjd2Q6IGNyZXcvd2Fycm9vbSB3b3JrZXJzIHNoYXJlIG9uZSByZXBvIChjd2QgY29sbGlkZXMpIGJ1dAojIGVhY2ggaGFzIGEgdW5pcXVlIHRtdXggcGFuZS4gJFRNVVhfUEFORSAoZS5nLiAiJTQwIikgaXMgdGhlIHN0YWJsZSBqb2luIGtleS4KIwojIFByb3Zpc2lvbmVkIGJ5IGBtYXcgY29tcGFueSB3b3JrbG9nIHNldHVwLWhvb2tzYC4gU291cmNlIG9mIHRydXRoOgojIHNjcmlwdHMvaG9va3MvbWF3LXN0YXR1c2xpbmUuc2ggKGtlcHQgYnl0ZS1pZGVudGljYWwgdG8gdGhlIGVtYmVkZGVkIGNvcHkgYnkKIyB3b3JrbG9nLnRlc3QudHMpLgoKSU5QVVQ9JChjYXQpCgojIE9yYWNsZSBpZGVudGl0eSDigJQgc2VsZi1kZXNjcmliZSB0aGUgcHJlc2VuY2UgZmlsZSBzbyB0aGUgcmVhZCBzaWRlICh0aGUgYm9hcmQpCiMgZ3JvdXBzIHBlci1vcmFjbGUgYnkgYSBmaWxlIGZpZWxkLCB3aXRoIE5PIHRtdXggam9pbiBhdCByZWFkIHRpbWUgKGEgZGVhZCBhZ2VudAojIGp1c3Qgc3RvcHMgdXBkYXRpbmcg4oaSIG10aW1lIGdvZXMgc3RhbGUpLiBTYW1lIHJlc29sdXRpb24gdGhlIHdvcmtsb2cgaG9va3MgdXNlOgojIENMQVVERV9BR0VOVF9OQU1FLCBlbHNlIHRoZSB0bXV4IHNlc3Npb24gbmFtZSBtaW51cyBpdHMgbnVtZXJpYyBwYW5lIHByZWZpeC4KT1JBQ0xFPSIke0NMQVVERV9BR0VOVF9OQU1FOi19IgpbIC16ICIkT1JBQ0xFIiBdICYmIE9SQUNMRT0iJCh0bXV4IGRpc3BsYXktbWVzc2FnZSAtcCAnI3tzZXNzaW9uX25hbWV9JyAyPi9kZXYvbnVsbCB8IHNlZCAncy9eWzAtOV0qLS8vJykiClsgLXogIiRPUkFDTEUiIF0gJiYgT1JBQ0xFPSI/IgoKIyAtLS0gY2FwdHVyZSAoZ3VhcmRlZCBzbyBpdCBjYW4gbmV2ZXIgZmF1bHQgdGhlIHN0YXR1c2xpbmUpIC0tLS0tLS0tLS0tLS0tLS0tLQpQQU5FPSIke1RNVVhfUEFORTotfSIKaWYgY29tbWFuZCAtdiBqcSA+L2Rldi9udWxsIDI+JjEgJiYgWyAtbiAiJFBBTkUiIF07IHRoZW4KICBESVI9IiR7TUFXX0RBVEFfRElSOi0kSE9NRS8ubWF3fS9wcmVzZW5jZSIKICBpZiBta2RpciAtcCAiJERJUiIgMj4vZGV2L251bGw7IHRoZW4KICAgIE9VVD0iJERJUi8ke1BBTkV9Lmpzb24iCiAgICBUTVA9IiRPVVQuJCQudG1wIgogICAgVFM9IiQoZGF0ZSArJXMpMDAwIiAjIGVwb2NoIG1zIChiZXN0LWVmZm9ydCDigJQgc2Vjb25kcyBwcmVjaXNpb24gaXMgZW5vdWdoIGZvciBzdGFsZW5lc3MpCiAgICAjIHJlbWFpbmluZ19wZXJjZW50YWdlIGlzIG51bGwgYmVmb3JlIHRoZSBmaXJzdCBBUEkgY2FsbCArIHJpZ2h0IGFmdGVyIC9jb21wYWN0CiAgICAjIChDQyBoYXNuJ3QgY29tcHV0ZWQgaXQgeWV0KSDigJQgY2FycnkgdGhlIG51bGwgdGhyb3VnaCBzbyB0aGUgVUkgY2FuIHNob3cgIuKAlCIuCiAgICAjIGpxIHBhdGhzIGFyZSB0b2xlcmFudCBvZiBuZXN0aW5nIChjb250ZXh0X3dpbmRvdy5YIC8vIHRvcC1sZXZlbCBYKSBzbyBhIHNjaGVtYQogICAgIyB0d2VhayBvbiB0aGUgQ0Mgc2lkZSBkZWdyYWRlcyB0byBudWxsIGluc3RlYWQgb2YgYnJlYWtpbmcgY2FwdHVyZS4KICAgIGlmIHByaW50ZiAnJXMnICIkSU5QVVQiIHwganEgLWMgXAogICAgICAgIC0tYXJnIHBhbmUgIiRQQU5FIiAtLWFyZyB0cyAiJFRTIiAtLWFyZyBvcmFjbGUgIiRPUkFDTEUiICd7CiAgICAgICAgICBwYW5lOiAkcGFuZSwKICAgICAgICAgIG9yYWNsZTogJG9yYWNsZSwKICAgICAgICAgIHRzOiAoJHRzIHwgdG9udW1iZXIpLAogICAgICAgICAgbW9kZWw6ICgubW9kZWwuZGlzcGxheV9uYW1lIC8vIC5tb2RlbC5pZCAvLyBudWxsKSwKICAgICAgICAgIG1vZGVsX2lkOiAoLm1vZGVsLmlkIC8vIG51bGwpLAogICAgICAgICAgcmVtYWluaW5nX3BlcmNlbnRhZ2U6ICguY29udGV4dF93aW5kb3cucmVtYWluaW5nX3BlcmNlbnRhZ2UgLy8gLnJlbWFpbmluZ19wZXJjZW50YWdlIC8vIG51bGwpLAogICAgICAgICAgdXNlZF9wZXJjZW50YWdlOiAoLmNvbnRleHRfd2luZG93LnVzZWRfcGVyY2VudGFnZSAvLyAudXNlZF9wZXJjZW50YWdlIC8vIG51bGwpLAogICAgICAgICAgdG90YWxfaW5wdXRfdG9rZW5zOiAoLmNvbnRleHRfd2luZG93LnRvdGFsX2lucHV0X3Rva2VucyAvLyAudG90YWxfaW5wdXRfdG9rZW5zIC8vIG51bGwpLAogICAgICAgICAgY29udGV4dF93aW5kb3dfc2l6ZTogKC5jb250ZXh0X3dpbmRvdy5jb250ZXh0X3dpbmRvd19zaXplIC8vIC5jb250ZXh0X3dpbmRvd19zaXplIC8vIG51bGwpLAogICAgICAgICAgc2Vzc2lvbl9pZDogKC5zZXNzaW9uX2lkIC8vIG51bGwpLAogICAgICAgICAgY3dkOiAoLmN3ZCAvLyAud29ya3NwYWNlLmN1cnJlbnRfZGlyIC8vIG51bGwpCiAgICAgICAgfScgPiAiJFRNUCIgMj4vZGV2L251bGw7IHRoZW4KICAgICAgbXYgLWYgIiRUTVAiICIkT1VUIiAyPi9kZXYvbnVsbCB8fCBybSAtZiAiJFRNUCIgMj4vZGV2L251bGwKICAgIGVsc2UKICAgICAgcm0gLWYgIiRUTVAiIDI+L2Rldi9udWxsCiAgICBmaQogIGZpCmZpCgojIC0tLSBvdXRwdXQ6IGRlbGVnYXRlIHRvIHRoZSB3cmFwcGVkIHN0YXR1c2xpbmUsIG9yIHByaW50IG1hdydzIGRlZmF1bHQgLS0tLS0tCkRFTEVHQVRFX0I2ND0iJHsxOi19IgppZiBbIC1uICIkREVMRUdBVEVfQjY0IiBdOyB0aGVuCiAgREVMRUdBVEU9IiQocHJpbnRmICclcycgIiRERUxFR0FURV9CNjQiIHwgYmFzZTY0IC1kIDI+L2Rldi9udWxsKSIKICBpZiBbIC1uICIkREVMRUdBVEUiIF07IHRoZW4KICAgIHByaW50ZiAnJXMnICIkSU5QVVQiIHwgZXZhbCAiJERFTEVHQVRFIiAjIGVtaXQgdGhlIG9yaWdpbmFsIHN0YXR1c2xpbmUgdmVyYmF0aW0KICAgIGV4aXQgMAogIGZpCmZpCgojIG1hdyBkZWZhdWx0IGxpbmUg4oCUIG9ubHkgcmVhY2hlZCB3aGVuIG5vIHByaW9yIHN0YXR1c2xpbmUgd2FzIHdyYXBwZWQuCmlmIGNvbW1hbmQgLXYganEgPi9kZXYvbnVsbCAyPiYxOyB0aGVuCiAgTU9ERUw9IiQocHJpbnRmICclcycgIiRJTlBVVCIgfCBqcSAtciAnLm1vZGVsLmRpc3BsYXlfbmFtZSAvLyAubW9kZWwuaWQgLy8gIj8iJyAyPi9kZXYvbnVsbCkiCiAgUENUPSIkKHByaW50ZiAnJXMnICIkSU5QVVQiIHwganEgLXIgJyguY29udGV4dF93aW5kb3cucmVtYWluaW5nX3BlcmNlbnRhZ2UgLy8gLnJlbWFpbmluZ19wZXJjZW50YWdlKSBhcyAkcCB8IGlmICRwID09IG51bGwgdGhlbiAi4oCUIiBlbHNlICJcKCRwIHwgZmxvb3IpJSIgZW5kJyAyPi9kZXYvbnVsbCkiCmVsc2UKICBNT0RFTD0iPyI7IFBDVD0i4oCUIgpmaQpwcmludGYgJyVzIMK3IGN0eCAlcyDCtyAlcycgIiRNT0RFTCIgIiRQQ1QiICIkT1JBQ0xFIgpleGl0IDAK";

/** Provision the statusLine capture script to the config dir. Returns count written. */
export function ensureStatuslineScript(): number {
  const p = hookPath(STATUSLINE_FILE);
  const body = hookScriptBody(STATUSLINE_FILE);
  if (existsSync(p) && readFileSync(p, "utf-8") === body) {
    try { chmodSync(p, 0o755); } catch {}
    return 0;
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
  try { chmodSync(p, 0o755); } catch {}
  return 1;
}

/**
 * Provision the maw statusLine into ONE oracle's settings.json (kobo-104).
 * WRAPS an existing statusLine instead of clobbering it: the prior command is
 * base64-encoded and passed to maw-statusline.sh as $1, which runs it verbatim
 * after writing the presence file (RTK/token statuslines keep working). Already
 * maw-wrapped → "alreadyOk" (idempotent, never double-wraps). Same skipped/repo
 * semantics as provisionOracleHooks.
 */
export function provisionOracleStatusline(
  oracle: string,
  opts: { dryRun?: boolean; ghqRoot?: string } = {},
): ProvisionOutcome {
  const ghqRoot = opts.ghqRoot ?? defaultGhqRoot();
  const dir = oracleRepoDir(oracle, ghqRoot);
  if (!existsSync(dir)) return "skipped";

  const settingsPath = join(dir, ".claude", "settings.json");
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { settings = {}; }
  }
  const mawPath = hookPath(STATUSLINE_FILE);
  const cur = settings.statusLine;
  const curCmd = typeof cur?.command === "string" ? cur.command : "";
  if (curCmd.includes(STATUSLINE_FILE)) return "alreadyOk"; // already ours — don't re-wrap

  // Wrap a pre-existing (non-maw) statusLine by encoding its whole command as our
  // arg; empty when there was none (fresh install of maw's default line).
  const delegateArg = curCmd ? " " + Buffer.from(curCmd, "utf8").toString("base64") : "";
  if (opts.dryRun) return "updated";
  ensureStatuslineScript(); // the setting references this script — ensure on disk
  settings.statusLine = { type: "command", command: mawPath + delegateArg };
  mkdirSync(join(settingsPath, ".."), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return "updated";
}

/** Provision all hook scripts to the config dir (idempotent). Returns count written. */
export function ensureWorklogHookScripts(): number {
  let written = 0;
  for (const h of HOOKS) {
    const p = hookPath(h.file);
    const body = hookScriptBody(h.file);
    if (existsSync(p) && readFileSync(p, "utf-8") === body) {
      try { chmodSync(p, 0o755); } catch {}
      continue;
    }
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    try { chmodSync(p, 0o755); } catch {}
    written++;
  }
  return written;
}

function isWorklogHook(hook: any, file: string): boolean {
  return typeof hook?.command === "string" && hook.command.includes(file);
}

export interface SetupHooksOpts {
  company?: string; // default "kobo"
  dryRun?: boolean;
  ghqRoot?: string; // default ~/ghq/github.com/meganechan
}

export interface SetupHooksResult {
  scriptsInstalled: number;
  updated: string[];
  alreadyOk: string[];
  skipped: string[];
}

/** Default fleet repo root (where <oracle>-oracle checkouts live). */
function defaultGhqRoot(): string {
  return join(homedir(), "ghq/github.com/meganechan");
}

/** Resolve an oracle's repo dir by the `<oracle>-oracle` name convention. */
function oracleRepoDir(oracle: string, ghqRoot: string): string {
  const repo = oracle.endsWith("-oracle") ? oracle : `${oracle}-oracle`;
  return join(ghqRoot, repo);
}

export type ProvisionOutcome = "updated" | "alreadyOk" | "skipped";

/**
 * Provision the unified company-context hook set (worklog capture/inject +
 * company-policy inject) into ONE oracle's `.claude/settings.json`, idempotently.
 *
 * Returns:
 *  - "updated"   — installed the missing hooks
 *  - "alreadyOk" — all hooks already present
 *  - "skipped"   — repo dir not found (no checkout/window yet) → caller should
 *                  warn + defer, NEVER error. A later `attach` re-provisions.
 *
 * Best-effort: only writes when something changed (and not in dryRun).
 */
export function provisionOracleHooks(
  oracle: string,
  opts: { dryRun?: boolean; ghqRoot?: string } = {},
): ProvisionOutcome {
  const ghqRoot = opts.ghqRoot ?? defaultGhqRoot();
  const dir = oracleRepoDir(oracle, ghqRoot);
  if (!existsSync(dir)) return "skipped";

  const settingsPath = join(dir, ".claude", "settings.json");
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { settings = {}; }
  }
  settings.hooks ??= {};

  let changed = false;
  for (const h of HOOKS) {
    settings.hooks[h.event] ??= [];
    const entries = settings.hooks[h.event] as any[];
    if (entries.some(e => e.hooks?.some((hk: any) => isWorklogHook(hk, h.file)))) continue;
    entries.push({ matcher: h.matcher, hooks: [{ type: "command", command: hookPath(h.file) }] });
    changed = true;
  }

  if (!changed) return "alreadyOk";
  if (opts.dryRun) return "updated";
  ensureWorklogHookScripts(); // the settings reference these scripts — ensure on disk
  mkdirSync(join(settingsPath, ".."), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return "updated";
}

export interface OracleHookStatus {
  oracle: string;
  /** repo checkout resolved on disk */
  hasDir: boolean;
  /** hook files already installed in settings.json */
  installed: string[];
  /** hook files missing */
  missing: string[];
}

/** Inspect which hooks of the unified set an oracle currently has (read-only). */
export function hooksStatusForOracle(
  oracle: string,
  opts: { ghqRoot?: string } = {},
): OracleHookStatus {
  const ghqRoot = opts.ghqRoot ?? defaultGhqRoot();
  const dir = oracleRepoDir(oracle, ghqRoot);
  if (!existsSync(dir)) {
    return { oracle, hasDir: false, installed: [], missing: HOOKS.map(h => h.file) };
  }
  const settingsPath = join(dir, ".claude", "settings.json");
  let settings: any = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { settings = {}; }
  }
  const installed: string[] = [];
  const missing: string[] = [];
  for (const h of HOOKS) {
    const entries = settings?.hooks?.[h.event] as any[] | undefined;
    const has = Array.isArray(entries)
      && entries.some(e => e.hooks?.some((hk: any) => isWorklogHook(hk, h.file)));
    (has ? installed : missing).push(h.file);
  }
  return { oracle, hasDir: true, installed, missing };
}

export type PruneOutcome = "pruned" | "nothing" | "skipped";

/**
 * Remove the unified hook set from an oracle's settings.json (used when it
 * leaves a company). Only OUR hooks are stripped — other hooks in the same
 * event are preserved; an entry is dropped only when it becomes empty.
 */
export function pruneOracleHooks(
  oracle: string,
  opts: { dryRun?: boolean; ghqRoot?: string } = {},
): PruneOutcome {
  const ghqRoot = opts.ghqRoot ?? defaultGhqRoot();
  const dir = oracleRepoDir(oracle, ghqRoot);
  if (!existsSync(dir)) return "skipped";
  const settingsPath = join(dir, ".claude", "settings.json");
  if (!existsSync(settingsPath)) return "nothing";
  let settings: any = {};
  try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { return "nothing"; }
  if (!settings.hooks || typeof settings.hooks !== "object") return "nothing";

  let changed = false;
  for (const event of Object.keys(settings.hooks)) {
    const entries = settings.hooks[event];
    if (!Array.isArray(entries)) continue;
    const kept: any[] = [];
    for (const e of entries) {
      if (Array.isArray(e.hooks)) {
        const hooksKept = e.hooks.filter((hk: any) => !HOOKS.some(h => isWorklogHook(hk, h.file)));
        if (hooksKept.length !== e.hooks.length) changed = true;
        if (hooksKept.length === 0) continue; // entry now empty → drop
        e.hooks = hooksKept;
      }
      kept.push(e);
    }
    settings.hooks[event] = kept;
    if (kept.length === 0) delete settings.hooks[event];
  }

  if (!changed) return "nothing";
  if (opts.dryRun) return "pruned";
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return "pruned";
}

/** Merge the unified hook set into each company member's settings.json (sweep). */
export function setupWorklogHooks(opts: SetupHooksOpts = {}): SetupHooksResult {
  const company = opts.company ?? "kobo";
  const ghqRoot = opts.ghqRoot ?? defaultGhqRoot();
  const result: SetupHooksResult = { scriptsInstalled: 0, updated: [], alreadyOk: [], skipped: [] };

  result.scriptsInstalled = opts.dryRun
    ? HOOKS.filter(h => !existsSync(hookPath(h.file))).length + (existsSync(hookPath(STATUSLINE_FILE)) ? 0 : 1)
    : ensureWorklogHookScripts() + ensureStatuslineScript();

  for (const oracle of companyOracles(company)) {
    // Two provisioners per oracle: worklog hooks (events) + statusLine (presence
    // capture, kobo-104). "updated" if EITHER installed something; "skipped" only
    // when the repo checkout is missing (both agree — same dir resolution).
    const hooks = provisionOracleHooks(oracle, { dryRun: opts.dryRun, ghqRoot });
    const sline = provisionOracleStatusline(oracle, { dryRun: opts.dryRun, ghqRoot });
    if (hooks === "skipped" && sline === "skipped") result.skipped.push(oracle);
    else if (hooks === "updated" || sline === "updated") result.updated.push(oracle);
    else result.alreadyOk.push(oracle);
  }
  return result;
}
