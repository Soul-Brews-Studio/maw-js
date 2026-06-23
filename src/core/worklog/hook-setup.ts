/**
 * Install the worklog CC hooks into company oracles' Claude Code settings.
 *
 * Engine-first: `maw watch setup-hooks` provisions the hook scripts + merges the
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
    b64: "IyEvYmluL2Jhc2gKIyBDbGF1ZGUgQ29kZSBQb3N0VG9vbFVzZSBob29rIOKGkiBtYXcgd29ya2xvZyAoc2lnbmlmaWNhbnQgdG9vbC1jYWxsIGFjdGl2aXR5KS4KIwojIEZvcndhcmRzIHRoZSB0b29sIG5hbWUgKyBpbnB1dCB0byBtYXcgL2FwaS9mZWVkOyB0aGUgbWF3IHNlcnZlciBhcHBsaWVzIHRoZQojIHNpZ25pZmljYW5jZSBmaWx0ZXIgKGdpdC9naCBCYXNoLCBFZGl0L1dyaXRlL011bHRpRWRpdCkgYW5kIHBlcnNpc3RzIG1hdGNoaW5nCiMgY2FsbHMgdG8gd29ya2xvZy5qc29ubC4gVGhlIHNldHRpbmdzLmpzb24gbWF0Y2hlciBhbHJlYWR5IG5hcnJvd3MgdG8gdGhvc2UKIyB0b29scywgc28gdGhpcyBzY3JpcHQganVzdCBmb3J3YXJkcyB3aGF0IGl0IHJlY2VpdmVzLgojCiMgUHJvdmlzaW9uZWQgdG8gJEhPTUUvLmNvbmZpZy9tYXcvaG9va3Mvd29ya2xvZy10b29sLnNoIGJ5IGBtYXcgd2F0Y2ggc2V0dXAtaG9va3NgLgoKTUFXX1BPUlQ9IiR7TUFXX1BPUlQ6LTM0NTZ9IgpNQVdfVVJMPSJodHRwOi8vbG9jYWxob3N0OiR7TUFXX1BPUlR9L2FwaS9mZWVkIgoKY29tbWFuZCAtdiBqcSA+L2Rldi9udWxsIDI+JjEgfHwgZXhpdCAwCgpJTlBVVD0kKGNhdCkKVE9PTD0kKHByaW50ZiAnJXMnICIkSU5QVVQiIHwganEgLXIgJy50b29sX25hbWUgLy8gZW1wdHknKQpbIC16ICIkVE9PTCIgXSAmJiBleGl0IDAKVE9PTF9JTlBVVD0kKHByaW50ZiAnJXMnICIkSU5QVVQiIHwganEgLWMgJy50b29sX2lucHV0IC8vIHt9JykKCk9SQUNMRT0iJHtDTEFVREVfQUdFTlRfTkFNRTotfSIKaWYgWyAteiAiJE9SQUNMRSIgXTsgdGhlbgogIE9SQUNMRT0kKHRtdXggZGlzcGxheS1tZXNzYWdlIC1wICcje3Nlc3Npb25fbmFtZX0nIDI+L2Rldi9udWxsIHwgc2VkICdzL15bMC05XSotLy8nKQpmaQpbIC16ICIkT1JBQ0xFIiBdICYmIE9SQUNMRT0idW5rbm93biIKUFJPSkVDVD0kKGJhc2VuYW1lICIke1BXRH0iIDI+L2Rldi9udWxsKQoKUEFZTE9BRD0kKGpxIC1uIC0tYXJnIG8gIiRPUkFDTEUiIC0tYXJnIHAgIiRQUk9KRUNUIiAtLWFyZyB0ICIkVE9PTCIgLS1hcmdqc29uIHRpICIkVE9PTF9JTlBVVCIgXAogICd7b3JhY2xlOiRvLCBldmVudDoiUG9zdFRvb2xVc2UiLCBwcm9qZWN0OiRwLCBob3N0OiJsb2NhbCIsIG1lc3NhZ2U6KCJ0b29sOiIrJHQpLCBkYXRhOnt0b29sX25hbWU6JHQsIHRvb2xfaW5wdXQ6JHRpfX0nKQoKY3VybCAtcyAtWCBQT1NUICIkTUFXX1VSTCIgXAogIC1IICdDb250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL2pzb24nIFwKICAtZCAiJFBBWUxPQUQiID4vZGV2L251bGwgMj4mMSAmCgpleGl0IDAK",
  },
  {
    event: "UserPromptSubmit",
    matcher: "",
    file: "worklog-convo.sh",
    b64: "IyEvYmluL2Jhc2gKIyBDbGF1ZGUgQ29kZSBVc2VyUHJvbXB0U3VibWl0IGhvb2sg4oaSIG1hdyB3b3JrbG9nLgojICAgY2FwdHVyZTogICByZWNvcmQgdGhlIGRlY2lzaW9uL2luc3RydWN0aW9uICgiVG9ueeKGkm9yYWNsZTogWCIpCiMgICBpbnRlcnJ1cHQ6IGlmIHRoZSBwcmlvciB0dXJuIGVuZGVkIHdpdGggIltSZXF1ZXN0IGludGVycnVwdGVkIGJ5IHVzZXIuLi5dIiwKIyAgICAgICAgICAgICAgcmVjb3JkIGEga2luZDppbnRlcnJ1cHQgZXZlbnQgKHRoZSBjb3JyZWN0aW5nIHByb21wdCB0aGF0IGZvbGxvd3MpCiMgICBpbmplY3Q6ICAgIHJlYWQtYmVmb3JlLWFjdCDigJQgcHVzaCBjb21wYW55IHN0YXRlICsgb3BlbiBjbGFpbXMgYmFjayBpbnRvIGNvbnRleHQKIyBQcm92aXNpb25lZCBieSBgbWF3IHdhdGNoIHNldHVwLWhvb2tzYC4KCk1BV19QT1JUPSIke01BV19QT1JUOi0zNDU2fSIKQkFTRT0iaHR0cDovL2xvY2FsaG9zdDoke01BV19QT1JUfSIKY29tbWFuZCAtdiBqcSA+L2Rldi9udWxsIDI+JjEgfHwgZXhpdCAwCgpJTlBVVD0kKGNhdCkKUFJPTVBUPSQocHJpbnRmICclcycgIiRJTlBVVCIgfCBqcSAtciAnLnByb21wdCAvLyBlbXB0eScpClRSQU5TQ1JJUFQ9JChwcmludGYgJyVzJyAiJElOUFVUIiB8IGpxIC1yICcudHJhbnNjcmlwdF9wYXRoIC8vIGVtcHR5JykKCk9SQUNMRT0iJHtDTEFVREVfQUdFTlRfTkFNRTotfSIKaWYgWyAteiAiJE9SQUNMRSIgXTsgdGhlbgogIE9SQUNMRT0kKHRtdXggZGlzcGxheS1tZXNzYWdlIC1wICcje3Nlc3Npb25fbmFtZX0nIDI+L2Rldi9udWxsIHwgc2VkICdzL15bMC05XSotLy8nKQpmaQpbIC16ICIkT1JBQ0xFIiBdICYmIE9SQUNMRT0idW5rbm93biIKUFJPSkVDVD0kKGJhc2VuYW1lICIke1BXRH0iIDI+L2Rldi9udWxsKQoKIyBjYXB0dXJlIChmaXJlLWFuZC1mb3JnZXQpCmlmIFsgLW4gIiRQUk9NUFQiIF07IHRoZW4KICBDQVA9JChqcSAtbiAtLWFyZyBvICIkT1JBQ0xFIiAtLWFyZyBwICIkUFJPSkVDVCIgLS1hcmcgcHIgIiRQUk9NUFQiIFwKICAgICd7b3JhY2xlOiRvLCBldmVudDoiVXNlclByb21wdFN1Ym1pdCIsIHByb2plY3Q6JHAsIGhvc3Q6ImxvY2FsIiwgbWVzc2FnZToicHJvbXB0IiwgZGF0YTp7cHJvbXB0OiRwcn19JykKICBjdXJsIC1zIC1YIFBPU1QgIiRCQVNFL2FwaS9mZWVkIiAtSCAnQ29udGVudC1UeXBlOiBhcHBsaWNhdGlvbi9qc29uJyAtZCAiJENBUCIgPi9kZXYvbnVsbCAyPiYxICYKZmkKCiMgaW50ZXJydXB0IGRldGVjdGlvbiDigJQgdGhlIHByaW9yIHR1cm4gbGVmdCB0aGUgbWFya2VyIGFzIHRoZSBsYXN0IHRyYW5zY3JpcHQgZW50cnkKaWYgWyAtbiAiJFRSQU5TQ1JJUFQiIF0gJiYgWyAtZiAiJFRSQU5TQ1JJUFQiIF07IHRoZW4KICBpZiB0YWlsIC1uIDIgIiRUUkFOU0NSSVBUIiAyPi9kZXYvbnVsbCB8IGdyZXAgLXEgIlJlcXVlc3QgaW50ZXJydXB0ZWQgYnkgdXNlciI7IHRoZW4KICAgIElFVj0kKGpxIC1uIC0tYXJnIG8gIiRPUkFDTEUiIC0tYXJnIHAgIiRQUk9KRUNUIiAtLWFyZyBwciAiJFBST01QVCIgXAogICAgICAne29yYWNsZTokbywgZXZlbnQ6Ik5vdGlmaWNhdGlvbiIsIHByb2plY3Q6JHAsIGhvc3Q6ImxvY2FsIiwgbWVzc2FnZToiaW50ZXJydXB0IiwgZGF0YTp7a2luZDoiaW50ZXJydXB0IiwgcHJvbXB0OiRwcn19JykKICAgIGN1cmwgLXMgLVggUE9TVCAiJEJBU0UvYXBpL2ZlZWQiIC1IICdDb250ZW50LVR5cGU6IGFwcGxpY2F0aW9uL2pzb24nIC1kICIkSUVWIiA+L2Rldi9udWxsIDI+JjEgJgogIGZpCmZpCgojIGluamVjdCAocmVhZC1iZWZvcmUtYWN0KSDigJQgc2hvcnQgdGltZW91dCBzbyBhIHNsb3cvYWJzZW50IHNlcnZlciBuZXZlciBibG9ja3MgdGhlIGFnZW50CklOSkVDVD0kKGN1cmwgLXMgLS1tYXgtdGltZSAyICIkQkFTRS9hcGkvd29ya2xvZz9vcmFjbGU9JHtPUkFDTEV9IiAyPi9kZXYvbnVsbCB8IGpxIC1yICcuaW5qZWN0IC8vIGVtcHR5JykKWyAteiAiJElOSkVDVCIgXSAmJiBleGl0IDAKanEgLW4gLS1hcmcgY3R4ICIkSU5KRUNUIiAne2hvb2tTcGVjaWZpY091dHB1dDp7aG9va0V2ZW50TmFtZToiVXNlclByb21wdFN1Ym1pdCIsIGFkZGl0aW9uYWxDb250ZXh0OiRjdHh9fScKZXhpdCAwCg==",
  },
  {
    event: "SessionStart",
    matcher: "",
    file: "worklog-orient.sh",
    b64: "IyEvYmluL2Jhc2gKIyBDbGF1ZGUgQ29kZSBTZXNzaW9uU3RhcnQgaG9vayDihpIgbWF3IHdvcmtsb2c6IGluamVjdCBsYXRlc3QgY29tcGFueSBzdGF0ZSBvbiB3YWtlCiMgKG9yaWVudGF0aW9uKSwgc28gYW4gb3JhY2xlIHN0YXJ0cyBhbHJlYWR5IGF3YXJlIG9mIHJlY2VudCBhY3Rpdml0eSArIG9wZW4gY2xhaW1zLgojIFByb3Zpc2lvbmVkIGJ5IGBtYXcgd2F0Y2ggc2V0dXAtaG9va3NgLgoKTUFXX1BPUlQ9IiR7TUFXX1BPUlQ6LTM0NTZ9IgpCQVNFPSJodHRwOi8vbG9jYWxob3N0OiR7TUFXX1BPUlR9Igpjb21tYW5kIC12IGpxID4vZGV2L251bGwgMj4mMSB8fCBleGl0IDAKCk9SQUNMRT0iJHtDTEFVREVfQUdFTlRfTkFNRTotfSIKaWYgWyAteiAiJE9SQUNMRSIgXTsgdGhlbgogIE9SQUNMRT0kKHRtdXggZGlzcGxheS1tZXNzYWdlIC1wICcje3Nlc3Npb25fbmFtZX0nIDI+L2Rldi9udWxsIHwgc2VkICdzL15bMC05XSotLy8nKQpmaQpbIC16ICIkT1JBQ0xFIiBdICYmIGV4aXQgMAoKSU5KRUNUPSQoY3VybCAtcyAtLW1heC10aW1lIDIgIiRCQVNFL2FwaS93b3JrbG9nP29yYWNsZT0ke09SQUNMRX0iIDI+L2Rldi9udWxsIHwganEgLXIgJy5pbmplY3QgLy8gZW1wdHknKQpbIC16ICIkSU5KRUNUIiBdICYmIGV4aXQgMApqcSAtbiAtLWFyZyBjdHggIiRJTkpFQ1QiICd7aG9va1NwZWNpZmljT3V0cHV0Ontob29rRXZlbnROYW1lOiJTZXNzaW9uU3RhcnQiLCBhZGRpdGlvbmFsQ29udGV4dDokY3R4fX0nCmV4aXQgMAo=",
  },
];

export function hookScriptBody(file: string): string {
  const h = HOOKS.find(x => x.file === file);
  if (!h) throw new Error(`unknown worklog hook: ${file}`);
  return Buffer.from(h.b64, "base64").toString("utf8");
}

function hookPath(file: string): string {
  return mawConfigPath("hooks", file);
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

/** Merge all worklog hooks into each company member's settings.json. */
export function setupWorklogHooks(opts: SetupHooksOpts = {}): SetupHooksResult {
  const company = opts.company ?? "kobo";
  const ghqRoot = opts.ghqRoot ?? join(homedir(), "ghq/github.com/meganechan");
  const result: SetupHooksResult = { scriptsInstalled: 0, updated: [], alreadyOk: [], skipped: [] };

  result.scriptsInstalled = opts.dryRun
    ? HOOKS.filter(h => !existsSync(hookPath(h.file))).length
    : ensureWorklogHookScripts();

  for (const oracle of companyOracles(company)) {
    const repo = oracle.endsWith("-oracle") ? oracle : `${oracle}-oracle`;
    const dir = join(ghqRoot, repo);
    if (!existsSync(dir)) {
      result.skipped.push(oracle);
      continue;
    }
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

    if (!changed) {
      result.alreadyOk.push(oracle);
      continue;
    }
    if (opts.dryRun) {
      result.updated.push(oracle);
      continue;
    }
    mkdirSync(join(settingsPath, ".."), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    result.updated.push(oracle);
  }
  return result;
}
