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
import { MAW_MCP_NUDGE_B64 } from "../status-reporter";

interface HookSpec {
  event: "PostToolUse" | "PreToolUse" | "UserPromptSubmit" | "SessionStart";
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
    b64: "IyEvYmluL2Jhc2gKIyBDbGF1ZGUgQ29kZSBQb3N0VG9vbFVzZSBob29rIOKGkiBtYXcgd29ya2xvZyAoc2lnbmlmaWNhbnQgdG9vbC1jYWxsIGFjdGl2aXR5KS4KIwojIEZvcndhcmRzIHRoZSB0b29sIG5hbWUgKyBpbnB1dCB0byBtYXcgL2FwaS9mZWVkOyB0aGUgbWF3IHNlcnZlciBhcHBsaWVzIHRoZQojIHNpZ25pZmljYW5jZSBmaWx0ZXIgKGdpdC9naCBCYXNoLCBFZGl0L1dyaXRlL011bHRpRWRpdCkgYW5kIHBlcnNpc3RzIG1hdGNoaW5nCiMgY2FsbHMgdG8gd29ya2xvZy5qc29ubC4gVGhlIHNldHRpbmdzLmpzb24gbWF0Y2hlciBhbHJlYWR5IG5hcnJvd3MgdG8gdGhvc2UKIyB0b29scywgc28gdGhpcyBzY3JpcHQganVzdCBmb3J3YXJkcyB3aGF0IGl0IHJlY2VpdmVzLgojCiMgUHJvdmlzaW9uZWQgdG8gJEhPTUUvLmNvbmZpZy9tYXcvaG9va3Mvd29ya2xvZy10b29sLnNoIGJ5IGBtYXcgd2F0Y2ggc2V0dXAtaG9va3NgLgoKTUFXX1BPUlQ9IiR7TUFXX1BPUlQ6LTM0NTZ9IgpNQVdfVVJMPSJodHRwOi8vbG9jYWxob3N0OiR7TUFXX1BPUlR9L2FwaS9mZWVkIgoKY29tbWFuZCAtdiBqcSA+L2Rldi9udWxsIDI+JjEgfHwgZXhpdCAwCgpJTlBVVD0kKGNhdCkKVE9PTD0kKHByaW50ZiAnJXMnICIkSU5QVVQiIHwganEgLXIgJy50b29sX25hbWUgLy8gZW1wdHknKQpbIC16ICIkVE9PTCIgXSAmJiBleGl0IDAKVE9PTF9JTlBVVD0kKHByaW50ZiAnJXMnICIkSU5QVVQiIHwganEgLWMgJy50b29sX2lucHV0IC8vIHt9JykKCk9SQUNMRT0iJHtDTEFVREVfQUdFTlRfTkFNRTotfSIKaWYgWyAteiAiJE9SQUNMRSIgXTsgdGhlbgogIE9SQUNMRT0kKHRtdXggZGlzcGxheS1tZXNzYWdlIC1wICcje3Nlc3Npb25fbmFtZX0nIDI+L2Rldi9udWxsIHwgc2VkICdzL15bMC05XSotLy8nKQpmaQpbIC16ICIkT1JBQ0xFIiBdICYmIE9SQUNMRT0idW5rbm93biIKUFJPSkVDVD0kKGJhc2VuYW1lICIke1BXRH0iIDI+L2Rldi9udWxsKQojIFBhbmUgaW5kZXggKCN7cGFuZV9pbmRleH0sIGUuZy4gIjAiLyIxIikg4oCUIERJU1BMQVkga2V5OiB0aGUgZmVlZCBzaG93cyBvcmFjbGUuMC8uMS4KIyBFbXB0eSBvdXRzaWRlIHRtdXgg4oCUIHRoZSBzZXJ2ZXIgdHJlYXRzIGEgbWlzc2luZyBwYW5lIGFzIGJhY2stY29tcGF0LgpQQU5FPSQodG11eCBkaXNwbGF5LW1lc3NhZ2UgLXAgJyN7cGFuZV9pbmRleH0nIDI+L2Rldi9udWxsKQojIFBhbmUgaWQgKCRUTVVYX1BBTkUsIGUuZy4gIiU0MCIpIOKAlCBKT0lOIGtleTogdW5pcXVlICsgc3RhYmxlLCBTQU1FIGFzIHRoZSBzdGF0dXNsaW5lCiMgcHJlc2VuY2UgZmlsZSwgc28gdGhlIGJvYXJkIGpvaW5zIGZlZWQgYWN0aXZpdHkgdG8gYSBwcmVzZW5jZSBwYW5lIHBlci1wYW5lIChrb2JvLTEwOSkuCiMgU2VwYXJhdGUgZmllbGQgZnJvbSBgcGFuZWAgc28gZGlzcGxheSBzdGF5cyAuMC8uMSB3aGlsZSB0aGUgYmFkZ2Ugam9pbnMgYnkgcGFuZUlkLgpQQU5FSUQ9IiR7VE1VWF9QQU5FOi19IgoKUEFZTE9BRD0kKGpxIC1uIC0tYXJnIG8gIiRPUkFDTEUiIC0tYXJnIHAgIiRQUk9KRUNUIiAtLWFyZyB0ICIkVE9PTCIgLS1hcmcgcGFuZSAiJFBBTkUiIC0tYXJnIHBhbmVpZCAiJFBBTkVJRCIgLS1hcmdqc29uIHRpICIkVE9PTF9JTlBVVCIgXAogICd7b3JhY2xlOiRvLCBldmVudDoiUG9zdFRvb2xVc2UiLCBwcm9qZWN0OiRwLCBob3N0OiJsb2NhbCIsIG1lc3NhZ2U6KCJ0b29sOiIrJHQpLCBkYXRhOih7dG9vbF9uYW1lOiR0LCB0b29sX2lucHV0OiR0aX0gKyAoaWYgJHBhbmUgIT0gIiIgdGhlbiB7cGFuZTokcGFuZX0gZWxzZSB7fSBlbmQpICsgKGlmICRwYW5laWQgIT0gIiIgdGhlbiB7cGFuZUlkOiRwYW5laWR9IGVsc2Uge30gZW5kKSl9JykKCmN1cmwgLXMgLVggUE9TVCAiJE1BV19VUkwiIFwKICAtSCAnQ29udGVudC1UeXBlOiBhcHBsaWNhdGlvbi9qc29uJyBcCiAgLWQgIiRQQVlMT0FEIiA+L2Rldi9udWxsIDI+JjEgJgoKZXhpdCAwCg==",
  },
  {
    event: "UserPromptSubmit",
    matcher: "",
    file: "worklog-convo.sh",
    b64: "IyEvYmluL2Jhc2gKIyBDbGF1ZGUgQ29kZSBVc2VyUHJvbXB0U3VibWl0IGhvb2sg4oaSIG1hdyB3b3JrbG9nLgojICAgY2FwdHVyZTogICByZWNvcmQgdGhlIGRlY2lzaW9uL2luc3RydWN0aW9uICgiVG9ueeKGkm9yYWNsZTogWCIpCiMgICBpbnRlcnJ1cHQ6IGlmIHRoZSBwcmlvciB0dXJuIGVuZGVkIHdpdGggIltSZXF1ZXN0IGludGVycnVwdGVkIGJ5IHVzZXIuLi5dIiwKIyAgICAgICAgICAgICAgcmVjb3JkIGEga2luZDppbnRlcnJ1cHQgZXZlbnQgKHRoZSBjb3JyZWN0aW5nIHByb21wdCB0aGF0IGZvbGxvd3MpCiMgICBpbmplY3Q6ICAgIHJlYWQtYmVmb3JlLWFjdCDigJQgcHVzaCBjb21wYW55IHN0YXRlICsgb3BlbiBjbGFpbXMgYmFjayBpbnRvIGNvbnRleHQKIyBQcm92aXNpb25lZCBieSBgbWF3IHdhdGNoIHNldHVwLWhvb2tzYC4KCk1BV19QT1JUPSIke01BV19QT1JUOi0zNDU2fSIKQkFTRT0iaHR0cDovL2xvY2FsaG9zdDoke01BV19QT1JUfSIKY29tbWFuZCAtdiBqcSA+L2Rldi9udWxsIDI+JjEgfHwgZXhpdCAwCgpJTlBVVD0kKGNhdCkKUFJPTVBUPSQocHJpbnRmICclcycgIiRJTlBVVCIgfCBqcSAtciAnLnByb21wdCAvLyBlbXB0eScpClRSQU5TQ1JJUFQ9JChwcmludGYgJyVzJyAiJElOUFVUIiB8IGpxIC1yICcudHJhbnNjcmlwdF9wYXRoIC8vIGVtcHR5JykKCk9SQUNMRT0iJHtDTEFVREVfQUdFTlRfTkFNRTotfSIKaWYgWyAteiAiJE9SQUNMRSIgXTsgdGhlbgogIE9SQUNMRT0kKHRtdXggZGlzcGxheS1tZXNzYWdlIC1wICcje3Nlc3Npb25fbmFtZX0nIDI+L2Rldi9udWxsIHwgc2VkICdzL15bMC05XSotLy8nKQpmaQpbIC16ICIkT1JBQ0xFIiBdICYmIE9SQUNMRT0idW5rbm93biIKUFJPSkVDVD0kKGJhc2VuYW1lICIke1BXRH0iIDI+L2Rldi9udWxsKQojIFBhbmUgaW5kZXggKCN7cGFuZV9pbmRleH0sIGUuZy4gIjAiLyIxIikg4oCUIERJU1BMQVkga2V5OiB0aGUgZmVlZCBzaG93cyBvcmFjbGUuMC8uMS4KIyBFbXB0eSBvdXRzaWRlIHRtdXgg4oCUIHRoZSBzZXJ2ZXIgdHJlYXRzIGEgbWlzc2luZyBwYW5lIGFzIGJhY2stY29tcGF0LgpQQU5FPSQodG11eCBkaXNwbGF5LW1lc3NhZ2UgLXAgJyN7cGFuZV9pbmRleH0nIDI+L2Rldi9udWxsKQojIFBhbmUgaWQgKCRUTVVYX1BBTkUsIGUuZy4gIiU0MCIpIOKAlCBKT0lOIGtleTogdW5pcXVlICsgc3RhYmxlLCBTQU1FIGFzIHRoZSBzdGF0dXNsaW5lCiMgcHJlc2VuY2UgZmlsZSwgc28gdGhlIGJvYXJkIGpvaW5zIGZlZWQgYWN0aXZpdHkgdG8gYSBwcmVzZW5jZSBwYW5lIHBlci1wYW5lIChrb2JvLTEwOSkuCiMgU2VwYXJhdGUgZmllbGQgZnJvbSBgcGFuZWAgc28gZGlzcGxheSBzdGF5cyAuMC8uMSB3aGlsZSB0aGUgYmFkZ2Ugam9pbnMgYnkgcGFuZUlkLgpQQU5FSUQ9IiR7VE1VWF9QQU5FOi19IgoKIyBjYXB0dXJlIChmaXJlLWFuZC1mb3JnZXQpCmlmIFsgLW4gIiRQUk9NUFQiIF07IHRoZW4KICBDQVA9JChqcSAtbiAtLWFyZyBvICIkT1JBQ0xFIiAtLWFyZyBwICIkUFJPSkVDVCIgLS1hcmcgcHIgIiRQUk9NUFQiIC0tYXJnIHBhbmUgIiRQQU5FIiAtLWFyZyBwYW5laWQgIiRQQU5FSUQiIFwKICAgICd7b3JhY2xlOiRvLCBldmVudDoiVXNlclByb21wdFN1Ym1pdCIsIHByb2plY3Q6JHAsIGhvc3Q6ImxvY2FsIiwgbWVzc2FnZToicHJvbXB0IiwgZGF0YTooe3Byb21wdDokcHJ9ICsgKGlmICRwYW5lICE9ICIiIHRoZW4ge3BhbmU6JHBhbmV9IGVsc2Uge30gZW5kKSArIChpZiAkcGFuZWlkICE9ICIiIHRoZW4ge3BhbmVJZDokcGFuZWlkfSBlbHNlIHt9IGVuZCkpfScpCiAgY3VybCAtcyAtWCBQT1NUICIkQkFTRS9hcGkvZmVlZCIgLUggJ0NvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vanNvbicgLWQgIiRDQVAiID4vZGV2L251bGwgMj4mMSAmCmZpCgojIGludGVycnVwdCBkZXRlY3Rpb24g4oCUIHRoZSBwcmlvciB0dXJuIGxlZnQgdGhlIG1hcmtlciBhcyB0aGUgbGFzdCB0cmFuc2NyaXB0IGVudHJ5CmlmIFsgLW4gIiRUUkFOU0NSSVBUIiBdICYmIFsgLWYgIiRUUkFOU0NSSVBUIiBdOyB0aGVuCiAgaWYgdGFpbCAtbiAyICIkVFJBTlNDUklQVCIgMj4vZGV2L251bGwgfCBncmVwIC1xICJSZXF1ZXN0IGludGVycnVwdGVkIGJ5IHVzZXIiOyB0aGVuCiAgICBJRVY9JChqcSAtbiAtLWFyZyBvICIkT1JBQ0xFIiAtLWFyZyBwICIkUFJPSkVDVCIgLS1hcmcgcHIgIiRQUk9NUFQiIC0tYXJnIHBhbmUgIiRQQU5FIiAtLWFyZyBwYW5laWQgIiRQQU5FSUQiIFwKICAgICAgJ3tvcmFjbGU6JG8sIGV2ZW50OiJOb3RpZmljYXRpb24iLCBwcm9qZWN0OiRwLCBob3N0OiJsb2NhbCIsIG1lc3NhZ2U6ImludGVycnVwdCIsIGRhdGE6KHtraW5kOiJpbnRlcnJ1cHQiLCBwcm9tcHQ6JHByfSArIChpZiAkcGFuZSAhPSAiIiB0aGVuIHtwYW5lOiRwYW5lfSBlbHNlIHt9IGVuZCkgKyAoaWYgJHBhbmVpZCAhPSAiIiB0aGVuIHtwYW5lSWQ6JHBhbmVpZH0gZWxzZSB7fSBlbmQpKX0nKQogICAgY3VybCAtcyAtWCBQT1NUICIkQkFTRS9hcGkvZmVlZCIgLUggJ0NvbnRlbnQtVHlwZTogYXBwbGljYXRpb24vanNvbicgLWQgIiRJRVYiID4vZGV2L251bGwgMj4mMSAmCiAgZmkKZmkKCiMgaW5qZWN0IChyZWFkLWJlZm9yZS1hY3QpIOKAlCBzaG9ydCB0aW1lb3V0IHNvIGEgc2xvdy9hYnNlbnQgc2VydmVyIG5ldmVyIGJsb2NrcyB0aGUgYWdlbnQKSU5KRUNUPSQoY3VybCAtcyAtLW1heC10aW1lIDIgIiRCQVNFL2FwaS93b3JrbG9nP29yYWNsZT0ke09SQUNMRX0iIDI+L2Rldi9udWxsIHwganEgLXIgJy5pbmplY3QgLy8gZW1wdHknKQpbIC16ICIkSU5KRUNUIiBdICYmIGV4aXQgMApqcSAtbiAtLWFyZyBjdHggIiRJTkpFQ1QiICd7aG9va1NwZWNpZmljT3V0cHV0Ontob29rRXZlbnROYW1lOiJVc2VyUHJvbXB0U3VibWl0IiwgYWRkaXRpb25hbENvbnRleHQ6JGN0eH19JwpleGl0IDAK",
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
  {
    // /toilet away (kobo-280) — set presence away at harness submit-time, before the
    // skill boots, so hey can't inject mid-wrap. Gated on the explicit /toilet prompt;
    // the skill's step-0 away stays as backup. Inject-nothing (no stdout).
    event: "UserPromptSubmit",
    matcher: "",
    file: "toilet-away.sh",
    b64: "IyEvYmluL2Jhc2gKIyBVc2VyUHJvbXB0U3VibWl0OiB3aGVuIHRoZSBwcm9tcHQgaXMgL3RvaWxldCwgc2V0IHByZXNlbmNlIGF3YXkgSU1NRURJQVRFTFkg4oCUCiMgYXQgaGFybmVzcyBzdWJtaXQtdGltZSwgYmVmb3JlIHRoZSBMTE0gdHVybiBib290cyB0aGUgc2tpbGwuIENsb3NlcyB0aGUgd2luZG93CiMgd2hlcmUgaGV5IGluamVjdHMgZHVyaW5nIHJyci9mb3J3YXJkIHdyYXAuIFNraWxsIHN0ZXAgMCBzdGlsbCBzZXRzIGF3YXkgYXMgYmFja3VwLgojIHBvbnl0YWlsOiBnYXRlIG9uIHRoZSBleHBsaWNpdCAvdG9pbGV0IGNvbW1hbmQgb25seSDigJQgbmF0dXJhbC1sYW5ndWFnZSB0cmlnZ2VycwojIGZhbGwgYmFjayB0byB0aGUgc2tpbGwncyBzdGVwLTAgYXdheS4gRW1pdHMgbm90aGluZyAoc3Rkb3V0IHdvdWxkIHBvbGx1dGUgdGhlIHByb21wdCkuCnB5dGhvbjMgLWMgJwppbXBvcnQganNvbiwgc3lzCnRyeToKICAgIHAgPSBqc29uLmxvYWRzKHN5cy5zdGRpbi5yZWFkKCkpLmdldCgicHJvbXB0IiwgIiIpLnN0cmlwKCkKICAgIGlmIHAgPT0gIi90b2lsZXQiIG9yIHAuc3RhcnRzd2l0aCgiL3RvaWxldCAiKToKICAgICAgICBpbXBvcnQgc3VicHJvY2VzcwogICAgICAgIHN1YnByb2Nlc3MucnVuKFsibWF3IiwgInByZXNlbmNlIiwgImF3YXkiXSwgc3Rkb3V0PXN1YnByb2Nlc3MuREVWTlVMTCwgc3RkZXJyPXN1YnByb2Nlc3MuREVWTlVMTCwgdGltZW91dD0zKQpleGNlcHQgRXhjZXB0aW9uOgogICAgcGFzcwonCg==",
  },
  {
    // /seat back (kobo-289) — the PAIR of toilet-away.sh. Clears presence away at
    // harness submit-time when the prompt is /seat, deterministically. Without this
    // fleet-wide back-hook, an oracle that ran /toilet stays sticky-away (kobo-287)
    // whenever the /seat skill's LLM-driven step-2.5 `maw presence back` is skipped —
    // a board-lie (5 pgw panes + a Conductor were stuck away, cleared by hand).
    // GUARD: away-hook + back-hook are ALWAYS provisioned together — an away-only fleet
    // is permanent stuck-away. Gated on the explicit /seat prompt; skill step 2.5 stays
    // as backup. Inject-nothing (no stdout).
    event: "UserPromptSubmit",
    matcher: "",
    file: "seat-back.sh",
    b64: "IyEvYmluL2Jhc2gKIyBVc2VyUHJvbXB0U3VibWl0OiB3aGVuIHRoZSBwcm9tcHQgaXMgL3NlYXQsIGNsZWFyIHByZXNlbmNlIGF3YXkgSU1NRURJQVRFTFkg4oCUCiMgYXQgaGFybmVzcyBzdWJtaXQtdGltZSwgZGV0ZXJtaW5pc3RpY2FsbHkuIFRoaXMgaXMgdGhlIFBBSVIgb2YgdG9pbGV0LWF3YXkuc2gKIyAoa29iby0yODkpOiAvdG9pbGV0IHNldHMgYXdheSwgL3NlYXQgY2xlYXJzIGl0LiBXaXRob3V0IGEgZmxlZXQtd2lkZSBiYWNrLWhvb2ssCiMgYW4gb3JhY2xlIHRoYXQgcmFuIC90b2lsZXQgc3RheXMgc3RpY2t5LWF3YXkgKGtvYm8tMjg3KSBmb3JldmVyIHdoZW4gdGhlIC9zZWF0CiMgc2tpbGwncyBMTE0tZHJpdmVuIGJhY2sgc3RlcCBpcyBza2lwcGVkIOKAlCBhIGJvYXJkLWxpZS4gVGhlIHNraWxsJ3Mgc3RlcCAyLjUKIyBgbWF3IHByZXNlbmNlIGJhY2tgIHN0YXlzIGFzIGJhY2t1cDsgdGhpcyBob29rIGd1YXJhbnRlZXMgaXQgZmlyZXMuCiMgcG9ueXRhaWw6IGdhdGUgb24gdGhlIGV4cGxpY2l0IC9zZWF0IGNvbW1hbmQgb25seSDigJQgc2FtZSBkaXNjaXBsaW5lIGFzIHRvaWxldC1hd2F5LgojIEVtaXRzIG5vdGhpbmcgKHN0ZG91dCB3b3VsZCBwb2xsdXRlIHRoZSBwcm9tcHQpLgpweXRob24zIC1jICcKaW1wb3J0IGpzb24sIHN5cwp0cnk6CiAgICBwID0ganNvbi5sb2FkcyhzeXMuc3RkaW4ucmVhZCgpKS5nZXQoInByb21wdCIsICIiKS5zdHJpcCgpCiAgICBpZiBwID09ICIvc2VhdCIgb3IgcC5zdGFydHN3aXRoKCIvc2VhdCAiKToKICAgICAgICBpbXBvcnQgc3VicHJvY2VzcwogICAgICAgIHN1YnByb2Nlc3MucnVuKFsibWF3IiwgInByZXNlbmNlIiwgImJhY2siXSwgc3Rkb3V0PXN1YnByb2Nlc3MuREVWTlVMTCwgc3RkZXJyPXN1YnByb2Nlc3MuREVWTlVMTCwgdGltZW91dD0zKQpleGNlcHQgRXhjZXB0aW9uOgogICAgcGFzcwonCg==",
  },
  {
    // maw MCP nudge (mawjs-2) — PreToolUse(Bash) deny of `maw hey/reply/inbox/ls` via
    // bash, redirecting to the maw_* MCP tools (structured + no rtk parse; fleet
    // token-audit). Allows peek/wake/broadcast/team/quota + inbox archive (no MCP).
    // Universal behavior (not company-scoped) — also inlined by bud-init so new buds
    // inherit it without hand-wiring.
    event: "PreToolUse",
    matcher: "Bash",
    file: "maw-mcp-nudge.sh",
    b64: MAW_MCP_NUDGE_B64, // single source of truth in status-reporter.ts (co-located universal hook)
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
// — kept in sync by worklog.test.ts, which CI does not run today (src/ tests
// aren't discovered until kobo-472 lands); regenerate this by hand whenever
// the .sh changes.
const STATUSLINE_FILE = "maw-statusline.sh";
const STATUSLINE_B64 = "IyEvYmluL2Jhc2gKIyBDbGF1ZGUgQ29kZSBzdGF0dXNMaW5lIGNvbW1hbmQg4oaSIG1hdyBwcmVzZW5jZSBjYXB0dXJlIChrb2JvLTEwNCkuCiMKIyBSZWFkcyB0aGUgQ0Mgc3RhdHVzTGluZSBKU09OIG9uIHN0ZGluLCB3cml0ZXMgYSBzbWFsbCBwcmVzZW5jZSBmaWxlIGtleWVkIGJ5CiMgdGhlIHRtdXggcGFuZSBpZCAoJFRNVVhfUEFORSkgdG8gfi8ubWF3L3ByZXNlbmNlLzxwYW5lPi5qc29uIChhdG9taWMgd3JpdGUpLAojIHRoZW4gRUlUSEVSIGRlbGVnYXRlcyB0byB0aGUgb3JpZ2luYWwgc3RhdHVzTGluZSBjb21tYW5kIHRoaXMgb25lIHdyYXBwZWQKIyAocGFzc2VkIGJhc2U2NC1lbmNvZGVkIGFzICQxKSBPUiBwcmludHMgbWF3J3Mgb3duIGRlZmF1bHQgbGluZS4KIwojIEJlc3QtZWZmb3J0IGJ5IGRlc2lnbjogYSBtaXNzaW5nIGpxLCBubyB0bXV4LCBvciBhIHdyaXRlIGVycm9yIG11c3QgTkVWRVIKIyBicmVhayB0aGUgc3RhdHVzbGluZSDigJQgdGhlIHNjcmlwdCBhbHdheXMgZW1pdHMgYSBsaW5lIGFuZCBleGl0cyAwLiBDYXB0dXJlIGlzCiMgaW5kZXBlbmRlbnQgb2Ygb3V0cHV0ICh3ZSB3cml0ZSB0aGUgZmlsZSB3aGV0aGVyIHdlIGRlbGVnYXRlIG9yIHByaW50KS4KIwojIEtFWSA9IHBhbmUsIE5PVCBjd2Q6IGNyZXcvd2Fycm9vbSB3b3JrZXJzIHNoYXJlIG9uZSByZXBvIChjd2QgY29sbGlkZXMpIGJ1dAojIGVhY2ggaGFzIGEgdW5pcXVlIHRtdXggcGFuZS4gJFRNVVhfUEFORSAoZS5nLiAiJTQwIikgaXMgdGhlIHN0YWJsZSBqb2luIGtleS4KIwojIFByb3Zpc2lvbmVkIGJ5IGBtYXcgY29tcGFueSB3b3JrbG9nIHNldHVwLWhvb2tzYC4gU291cmNlIG9mIHRydXRoOgojIHNjcmlwdHMvaG9va3MvbWF3LXN0YXR1c2xpbmUuc2ggKGtlcHQgYnl0ZS1pZGVudGljYWwgdG8gdGhlIGVtYmVkZGVkIGNvcHkgYnkKIyB3b3JrbG9nLnRlc3QudHMpLgoKSU5QVVQ9JChjYXQpCgojIE9yYWNsZSBpZGVudGl0eSDigJQgc2VsZi1kZXNjcmliZSB0aGUgcHJlc2VuY2UgZmlsZSBzbyB0aGUgcmVhZCBzaWRlICh0aGUgYm9hcmQpCiMgZ3JvdXBzIHBlci1vcmFjbGUgYnkgYSBmaWxlIGZpZWxkLCB3aXRoIE5PIHRtdXggam9pbiBhdCByZWFkIHRpbWUgKGEgZGVhZCBhZ2VudAojIGp1c3Qgc3RvcHMgdXBkYXRpbmcg4oaSIG10aW1lIGdvZXMgc3RhbGUpLiBTYW1lIHJlc29sdXRpb24gdGhlIHdvcmtsb2cgaG9va3MgdXNlOgojIENMQVVERV9BR0VOVF9OQU1FLCBlbHNlIHRoZSB0bXV4IHNlc3Npb24gbmFtZSBtaW51cyBpdHMgbnVtZXJpYyBwYW5lIHByZWZpeC4KT1JBQ0xFPSIke0NMQVVERV9BR0VOVF9OQU1FOi19IgpbIC16ICIkT1JBQ0xFIiBdICYmIE9SQUNMRT0iJCh0bXV4IGRpc3BsYXktbWVzc2FnZSAtcCAnI3tzZXNzaW9uX25hbWV9JyAyPi9kZXYvbnVsbCB8IHNlZCAncy9eWzAtOV0qLS8vJykiClsgLXogIiRPUkFDTEUiIF0gJiYgT1JBQ0xFPSI/IgoKIyBDb21wYW55IHNlbGYtZGVzY3JpYmUgKGtvYm8tMjY3KSDigJQgdGhlIHNwYXduIChjcmV3IMKnMCAvIHdhcnJvb20pIHNldHMKIyBNQVdfUk9PTV9DT01QQU5ZIG9uY2UgcGVyIHBhbmU7IHdlIHN0YW1wIGl0IHZlcmJhdGltIHNvIHRoZSBwcmVzZW5jZSByZWFkIHNpZGUKIyBjYW4gc2NvcGUgYnkgY29tcGFueSB3aXRoIE5PIHRtdXgvcGFuZXMuZW52IGpvaW4uIFJlYWQgZnJvbSB0aGUgcGFuZSdzIG93biBlbnYKIyBlYWNoIHRpY2sgKG12IC1mIGtlZXBzIHRoZSBmaWVsZCkg4oCUIG5ldmVyIGRlcml2ZSBwZXItdGljaywgYSBwYW5lJ3MgY29tcGFueSBpcwojIGZpeGVkIGF0IHNwYXduLiBFbXB0eSB3aGVuIGEgcGFuZSB3YXNuJ3Qgc3Bhd25lZCB3aXRoIGEgY29tcGFueSDihpIgbnVsbCAodGhhdAojIHBhbmUgaXMgZXhjbHVkZWQgZnJvbSBhID9jb21wYW55PSBxdWVyeSwgaW5jbHVkZWQgaG9zdC13aWRlKS4KQ09NUEFOWT0iJHtNQVdfUk9PTV9DT01QQU5ZOi19IgoKUEFORT0iJHtUTVVYX1BBTkU6LX0iCgojIC0tLSBwcmVzZW5jZSBiYWRnZSAoa29iby0yOTcpOiBnbGFuY2VhYmxlIG9ubGluZS9hd2F5LCBwZXJzaXN0ZW50IGV2ZXJ5IHRpY2sgLS0tLS0KIyBBIHBhbmUgaXMgImF3YXkiIHdoZW4gaXRzIG5ld2VzdCBhd2F5L2JhY2sgd29ya2xvZyBtYXJrZXIgaXMgYGF3YXlgIChtYXcgcHJlc2VuY2UKIyBhd2F5L2JhY2ssIHN0aWNreSBrb2JvLTI4NykuIFJlYWQgaXQgY2hlYXBseSByZWFkLW9ubHk6IGdyZXAgVEhJUyBwYW5lJ3MgbWFya2VycywKIyBuZXdlc3Qgd2lucy4gQmVzdC1lZmZvcnQg4oCUIG5vIGNvbXBhbnkgLyBubyBmaWxlIC8gbm8gbWFya2VyIOKGkiBvbmxpbmUsIGFuZCBhbnkgZXJyb3IKIyBpcyBzd2FsbG93ZWQgc28gdGhlIGJhZGdlIGNhbiBuZXZlciBmYXVsdCB0aGUgc3RhdHVzbGluZS4gUHVyZWx5IGRpc3BsYXk6IG5vIHByZXNlbmNlCiMgbG9naWMgdG91Y2hlZC4gc2VhdC1yZXN1bWUuc2ggZmxpcHMgYXdheeKGkm9ubGluZSBhdCBib290OyB0aGlzIHNob3dzIHRoZSBzdGF0ZSBhdCBhbGwgdGltZXMuCkJBREdFPSQnXHgxYlszMm3il48gb25saW5lXHgxYlswbScKIyBrb2JvLTMwOCDigJQgYSBsZWFkL29yaWdpbmF0aW5nIHBhbmUgaXNuJ3Qgc3Bhd25lZCB3aXRoIE1BV19ST09NX0NPTVBBTlksIHNvIHRoZSBndWFyZAojIGJlbG93IHdvdWxkIHNraXAgYW5kIHNob3cgIm9ubGluZSIgZXZlbiB3aGlsZSB0aGUgcGFuZSBpcyBhY3R1YWxseSBhd2F5IChpdHMgYXdheSBtYXJrZXIKIyBzdGlsbCBsYW5kcyBpbiB0aGUgY29tcGFueSB3b3JrbG9nIGJlY2F1c2UgcHJlc2VuY2UgYXdheSArIGRlbGl2ZXJ5IHJlc29sdmUgdGhlIGNvbXBhbnkKIyBmcm9tIHRoZSByZWdpc3RyeSwgbm90IHRoZSBlbnYpLiBNaXJyb3IgY29tcGFueU9mT3JhY2xlTGlnaHQgKHByZXNlbmNlLWF3YXkudHMpOiB3aGVuIHRoZQojIGVudiBjb21wYW55IGlzIGVtcHR5IGJ1dCB0aGUgb3JhY2xlIHJlc29sdmVzLCBmaW5kIGl0cyBjb21wYW55IGZyb20gdGhlIHJlZ2lzdHJ5CiMgKH4vLm1hdy9jb21wYW5pZXMvKi5qc29uLCBzb3J0ZWQgZmlyc3QtbWF0Y2ggb24gbWFuYWdlciBvciBhIGRlcHQgbWVtYmVyKS4gQmFkZ2Utb25seSDigJQgdGhlCiMgY2FwdHVyZSBiZWxvdyBrZWVwcyB0aGUgdmVyYmF0aW0gZW52IGNvbXBhbnkgKGEgbGVhZCBwYW5lIHN0YXlzIGhvc3Qtd2lkZSBpbiA/Y29tcGFueT0pLCBhbmQKIyBubyBwcmVzZW5jZS9hd2F5IGxvZ2ljIGlzIHRvdWNoZWQuIEJlc3QtZWZmb3J0OiBhbnkgZXJyb3Ig4oaSIHN0YXlzIG9ubGluZS4KQkFER0VfQ09NUEFOWT0iJENPTVBBTlkiCmlmIFsgLXogIiRCQURHRV9DT01QQU5ZIiBdICYmIFsgIiRPUkFDTEUiICE9ICI/IiBdICYmIGNvbW1hbmQgLXYganEgPi9kZXYvbnVsbCAyPiYxOyB0aGVuCiAgQ0RJUj0iJHtNQVdfREFUQV9ESVI6LSRIT01FLy5tYXd9L2NvbXBhbmllcyIKICBmb3IgY2YgaW4gIiRDRElSIi8qLmpzb247IGRvICAgICAgICAgICAgIyBnbG9iIGV4cGFuZHMgc29ydGVkIOKGkiBmaXJzdC1tYXRjaCBhZ3JlZXMgd2l0aCBjb21wYW55T2ZPcmFjbGVMaWdodAogICAgWyAtZiAiJGNmIiBdIHx8IGNvbnRpbnVlCiAgICAjIGtvYm8tMzYzIGR1YWwtcmVhZDogYHRlYW1zYCBwcmVmZXJyZWQsIGBkZXBhcnRtZW50c2AgPSBsZWdhY3kgZmFsbGJhY2sgKHRoaXMKICAgICMgc2NyaXB0IGJ5cGFzc2VzIHRoZSBUUyBsb2FkQ29tcGFueS9wcmVzZW5jZS1hd2F5IG5vcm1hbGl6ZXJzIG9uIHB1cnBvc2UpLgogICAgaWYganEgLWUgLS1hcmcgbyAiJE9SQUNMRSIgJygubWFuYWdlciA9PSAkbykgb3IgKFsoLnRlYW1zIC8vIC5kZXBhcnRtZW50cylbXT8ubWVtYmVyc1tdPy5vcmFjbGVdIHwgaW5kZXgoJG8pICE9IG51bGwpJyAiJGNmIiA+L2Rldi9udWxsIDI+JjE7IHRoZW4KICAgICAgQkFER0VfQ09NUEFOWT0iJChqcSAtciAnLm5hbWUgLy8gIiInICIkY2YiIDI+L2Rldi9udWxsKSIKICAgICAgWyAteiAiJEJBREdFX0NPTVBBTlkiIF0gJiYgQkFER0VfQ09NUEFOWT0iJChiYXNlbmFtZSAiJGNmIiAuanNvbikiICAgIyBtaXJyb3IgYGMubmFtZSA/PyBmaWxlbmFtZWAKICAgICAgYnJlYWsKICAgIGZpCiAgZG9uZQpmaQppZiBbIC1uICIkUEFORSIgXSAmJiBbIC1uICIkQkFER0VfQ09NUEFOWSIgXTsgdGhlbgogIFdMPSIke01BV19EQVRBX0RJUjotJEhPTUUvLm1hd30vY29tcGFuaWVzLyR7QkFER0VfQ09NUEFOWX0vd29ya2xvZy5qc29ubCIKICBpZiBbIC1mICIkV0wiIF07IHRoZW4KICAgIExBU1Q9IiQoZ3JlcCAtRiAiXCJwYW5lSWRcIjpcIiRQQU5FXCIiICIkV0wiIDI+L2Rldi9udWxsIHwgZ3JlcCAtb0UgJyJraW5kIjoiKGF3YXl8YmFjaykiJyB8IHRhaWwgLTEpIgogICAgWyAiJExBU1QiID0gJyJraW5kIjoiYXdheSInIF0gJiYgQkFER0U9JCdceDFiWzMzbeKXiyBhd2F5XHgxYlswbScKICBmaQpmaQoKIyAtLS0gY2FwdHVyZSAoZ3VhcmRlZCBzbyBpdCBjYW4gbmV2ZXIgZmF1bHQgdGhlIHN0YXR1c2xpbmUpIC0tLS0tLS0tLS0tLS0tLS0tLQppZiBjb21tYW5kIC12IGpxID4vZGV2L251bGwgMj4mMSAmJiBbIC1uICIkUEFORSIgXTsgdGhlbgogIERJUj0iJHtNQVdfREFUQV9ESVI6LSRIT01FLy5tYXd9L3ByZXNlbmNlIgogIGlmIG1rZGlyIC1wICIkRElSIiAyPi9kZXYvbnVsbDsgdGhlbgogICAgT1VUPSIkRElSLyR7UEFORX0uanNvbiIKICAgIFRNUD0iJE9VVC4kJC50bXAiCiAgICBUUz0iJChkYXRlICslcykwMDAiICMgZXBvY2ggbXMgKGJlc3QtZWZmb3J0IOKAlCBzZWNvbmRzIHByZWNpc2lvbiBpcyBlbm91Z2ggZm9yIHN0YWxlbmVzcykKICAgICMgcmVtYWluaW5nX3BlcmNlbnRhZ2UgaXMgbnVsbCBiZWZvcmUgdGhlIGZpcnN0IEFQSSBjYWxsICsgcmlnaHQgYWZ0ZXIgL2NvbXBhY3QKICAgICMgKENDIGhhc24ndCBjb21wdXRlZCBpdCB5ZXQpIOKAlCBjYXJyeSB0aGUgbnVsbCB0aHJvdWdoIHNvIHRoZSBVSSBjYW4gc2hvdyAi4oCUIi4KICAgICMganEgcGF0aHMgYXJlIHRvbGVyYW50IG9mIG5lc3RpbmcgKGNvbnRleHRfd2luZG93LlggLy8gdG9wLWxldmVsIFgpIHNvIGEgc2NoZW1hCiAgICAjIHR3ZWFrIG9uIHRoZSBDQyBzaWRlIGRlZ3JhZGVzIHRvIG51bGwgaW5zdGVhZCBvZiBicmVha2luZyBjYXB0dXJlLgogICAgaWYgcHJpbnRmICclcycgIiRJTlBVVCIgfCBqcSAtYyBcCiAgICAgICAgLS1hcmcgcGFuZSAiJFBBTkUiIC0tYXJnIHRzICIkVFMiIC0tYXJnIG9yYWNsZSAiJE9SQUNMRSIgLS1hcmcgY29tcGFueSAiJENPTVBBTlkiICd7CiAgICAgICAgICBwYW5lOiAkcGFuZSwKICAgICAgICAgIG9yYWNsZTogJG9yYWNsZSwKICAgICAgICAgIGNvbXBhbnk6IChpZiAkY29tcGFueSA9PSAiIiB0aGVuIG51bGwgZWxzZSAkY29tcGFueSBlbmQpLAogICAgICAgICAgdHM6ICgkdHMgfCB0b251bWJlciksCiAgICAgICAgICBtb2RlbDogKC5tb2RlbC5kaXNwbGF5X25hbWUgLy8gLm1vZGVsLmlkIC8vIG51bGwpLAogICAgICAgICAgbW9kZWxfaWQ6ICgubW9kZWwuaWQgLy8gbnVsbCksCiAgICAgICAgICByZW1haW5pbmdfcGVyY2VudGFnZTogKC5jb250ZXh0X3dpbmRvdy5yZW1haW5pbmdfcGVyY2VudGFnZSAvLyAucmVtYWluaW5nX3BlcmNlbnRhZ2UgLy8gbnVsbCksCiAgICAgICAgICB1c2VkX3BlcmNlbnRhZ2U6ICguY29udGV4dF93aW5kb3cudXNlZF9wZXJjZW50YWdlIC8vIC51c2VkX3BlcmNlbnRhZ2UgLy8gbnVsbCksCiAgICAgICAgICB0b3RhbF9pbnB1dF90b2tlbnM6ICguY29udGV4dF93aW5kb3cudG90YWxfaW5wdXRfdG9rZW5zIC8vIC50b3RhbF9pbnB1dF90b2tlbnMgLy8gbnVsbCksCiAgICAgICAgICBjb250ZXh0X3dpbmRvd19zaXplOiAoLmNvbnRleHRfd2luZG93LmNvbnRleHRfd2luZG93X3NpemUgLy8gLmNvbnRleHRfd2luZG93X3NpemUgLy8gbnVsbCksCiAgICAgICAgICBzZXNzaW9uX2lkOiAoLnNlc3Npb25faWQgLy8gbnVsbCksCiAgICAgICAgICBjd2Q6ICguY3dkIC8vIC53b3Jrc3BhY2UuY3VycmVudF9kaXIgLy8gbnVsbCkKICAgICAgICB9JyA+ICIkVE1QIiAyPi9kZXYvbnVsbDsgdGhlbgogICAgICBtdiAtZiAiJFRNUCIgIiRPVVQiIDI+L2Rldi9udWxsIHx8IHJtIC1mICIkVE1QIiAyPi9kZXYvbnVsbAogICAgZWxzZQogICAgICBybSAtZiAiJFRNUCIgMj4vZGV2L251bGwKICAgIGZpCiAgZmkKZmkKCiMgLS0tIG91dHB1dDogZGVsZWdhdGUgdG8gdGhlIHdyYXBwZWQgc3RhdHVzbGluZSwgb3IgcHJpbnQgbWF3J3MgZGVmYXVsdCAtLS0tLS0KREVMRUdBVEVfQjY0PSIkezE6LX0iCmlmIFsgLW4gIiRERUxFR0FURV9CNjQiIF07IHRoZW4KICBERUxFR0FURT0iJChwcmludGYgJyVzJyAiJERFTEVHQVRFX0I2NCIgfCBiYXNlNjQgLWQgMj4vZGV2L251bGwpIgogIGlmIFsgLW4gIiRERUxFR0FURSIgXTsgdGhlbgogICAgcHJpbnRmICclcyAnICIkQkFER0UiICMga29iby0yOTcg4oCUIHByZWZpeCB0aGUgcHJlc2VuY2UgYmFkZ2UsIHRoZW4gdGhlIHVzZXIncyBsaW5lIHZlcmJhdGltCiAgICBwcmludGYgJyVzJyAiJElOUFVUIiB8IGV2YWwgIiRERUxFR0FURSIgIyBlbWl0IHRoZSBvcmlnaW5hbCBzdGF0dXNsaW5lIHZlcmJhdGltCiAgICBleGl0IDAKICBmaQpmaQoKIyBtYXcgZGVmYXVsdCBsaW5lIOKAlCBvbmx5IHJlYWNoZWQgd2hlbiBubyBwcmlvciBzdGF0dXNsaW5lIHdhcyB3cmFwcGVkLgppZiBjb21tYW5kIC12IGpxID4vZGV2L251bGwgMj4mMTsgdGhlbgogIE1PREVMPSIkKHByaW50ZiAnJXMnICIkSU5QVVQiIHwganEgLXIgJy5tb2RlbC5kaXNwbGF5X25hbWUgLy8gLm1vZGVsLmlkIC8vICI/IicgMj4vZGV2L251bGwpIgogICMga29iby00NDE6IGN0eCBtdXN0IHNob3cgVVNFRCUsIG5vdCByZW1haW5pbmclIOKAlCByZW1haW5pbmdfcGVyY2VudGFnZSBpcyBhIHJlYWwKICAjIGZpZWxkIGJ1dCBsYWJlbGluZyBpdCAiY3R4IFglIiBpbnZlcnRlZCB0aGUgcmVhZGluZyAoYSBmdWxsIHBhbmUgc2hvd2VkICJjdHggMCUiKS4KICBQQ1Q9IiQocHJpbnRmICclcycgIiRJTlBVVCIgfCBqcSAtciAnKC5jb250ZXh0X3dpbmRvdy51c2VkX3BlcmNlbnRhZ2UgLy8gLnVzZWRfcGVyY2VudGFnZSkgYXMgJHAgfCBpZiAkcCA9PSBudWxsIHRoZW4gIuKAlCIgZWxzZSAiXCgkcCB8IGZsb29yKSUiIGVuZCcgMj4vZGV2L251bGwpIgplbHNlCiAgTU9ERUw9Ij8iOyBQQ1Q9IuKAlCIKZmkKcHJpbnRmICclcyDCtyAlcyDCtyBjdHggJXMgwrcgJXMnICIkQkFER0UiICIkTU9ERUwiICIkUENUIiAiJE9SQUNMRSIgIyBrb2JvLTI5NyDigJQgYmFkZ2UgZmlyc3QKZXhpdCAwCg==";

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
  opts: { dryRun?: boolean; ghqRoot?: string; globalSettingsPath?: string } = {},
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
  if (curCmd.includes(STATUSLINE_FILE)) return "alreadyOk"; // project already ours — don't re-wrap

  // EFFECTIVE existing statusLine = project's own, else the user's GLOBAL
  // ~/.claude/settings.json (kobo-106). Claude Code falls back to global when a
  // project has none, so an agent like patchwork keeps its statusline (a
  // limit-tracker) in global only — wrapping just the project would leave the
  // global line to be shadowed by maw's default. Resolve effective FIRST, then
  // wrap it as our delegate. Skip if it's already maw's (never wrap maw-in-maw)
  // or absent (fresh install of maw's default line).
  const effectiveCmd = curCmd || globalStatuslineCommand(opts.globalSettingsPath);
  const delegateArg = effectiveCmd && !effectiveCmd.includes(STATUSLINE_FILE)
    ? " " + Buffer.from(effectiveCmd, "utf8").toString("base64")
    : "";
  if (opts.dryRun) return "updated";
  ensureStatuslineScript(); // the setting references this script — ensure on disk
  settings.statusLine = { type: "command", command: mawPath + delegateArg };
  mkdirSync(join(settingsPath, ".."), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return "updated";
}

/** The user's GLOBAL statusLine command (~/.claude/settings.json), or "" if
 *  none/unreadable. The fallback delegate when a project has no own statusLine
 *  (kobo-106). Path is injectable for tests. */
function globalStatuslineCommand(globalSettingsPath?: string): string {
  const p = globalSettingsPath ?? join(homedir(), ".claude", "settings.json");
  try {
    if (!existsSync(p)) return "";
    const s = JSON.parse(readFileSync(p, "utf-8"));
    return typeof s?.statusLine?.command === "string" ? s.statusLine.command : "";
  } catch {
    return "";
  }
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

// kobo-295 — auto-seat SessionStart wiring. This is the AUTO path (fires on session
// (re)boot after /clear), distinct from the /seat UserPromptSubmit back-hook (seat-back.sh
// in HOOKS[]). The script is a crew-skills asset installed at $HOME/.claude/hooks by
// `maw crew-skills sync`; here we only wire the SessionStart ENTRY into each company
// oracle's repo settings so it lands fleet-wide (crew-skills sync alone wired only the
// cwd repo → eq3-only, the kobo-294 gap). MUST stay byte-identical to crew-skills'
// SEAT_RESUME_COMMAND/MATCHER (sync.ts) — pinned by hook-setup.test — so the two wirings
// are idempotent BY COMMAND and compose with no duplicate entry + no migration. The
// script self-gates to @role (crew/warroom) repos → silent for plain panes = solo-safe.
export const SEAT_RESUME_COMMAND = "bash $HOME/.claude/hooks/seat-resume.sh";
export const SEAT_RESUME_MATCHER = "startup|resume|clear";

/** Add/upgrade the SessionStart seat-resume entry on a settings OBJECT (kobo-295),
 *  idempotent by COMMAND so it composes with a crew-skills-wired entry. Mutates
 *  `settings` in place; returns true when it changed something. The caller owns the
 *  single read+write of the settings file (provisionOracleHooks). */
function ensureSeatResumeEntry(settings: any): boolean {
  settings.hooks ??= {};
  settings.hooks.SessionStart ??= [];
  const entries = settings.hooks.SessionStart as any[];
  const existing = entries.find(
    (e) => Array.isArray(e?.hooks) && e.hooks.some((hk: any) => hk?.command === SEAT_RESUME_COMMAND),
  );
  if (existing) {
    if (existing.matcher === SEAT_RESUME_MATCHER) return false; // already current
    existing.matcher = SEAT_RESUME_MATCHER; // upgrade an old clear-only install in place
    return true;
  }
  entries.push({ matcher: SEAT_RESUME_MATCHER, hooks: [{ type: "command", command: SEAT_RESUME_COMMAND }] });
  return true;
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

  // kobo-295 — auto-seat SessionStart wiring, fleet-wide via this single choke point
  // (every provisioning path — attach/assign/repair — flows through provisionOracleHooks).
  if (ensureSeatResumeEntry(settings)) changed = true;

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
