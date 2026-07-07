import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// kobo-174 — PreToolUse card-create gate. Real behavior: pipe a tool-call JSON
// (as Claude Code would) into the hook and assert the deny/allow decision. tmux
// is unavailable here, so these cover every branch reachable WITHOUT a live @role:
// fail-CLOSED (empty role while gated), the --force-lead override, opt-in (no
// config), the two card-create paths, and non-create / non-gated pass-through.
// The positive "lead role → deny / non-lead → allow" paths need a real tmux pane
// → test/isolated/card-gate-tmux.test.ts.

const HOOK = join(import.meta.dir, "..", "src", "vendor", "mpr-plugins", "crew-skills", "assets", "hooks", "maw-card-gate.sh");
const COORD = "eq3:eq3-oracle.2";

let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "card-gate-"));
});
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

function writeConfig(gate: unknown | null) {
  mkdirSync(join(home, ".claude"), { recursive: true });
  const body = gate === null ? {} : { mawCardGate: gate };
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify(body));
}

// Run the hook with a clean env (NO TMUX_PANE → role empty → fail-closed path).
// Returns { out, code }. execFileSync throws only on non-zero exit; the hook
// always exits 0 (deny is expressed in stdout JSON, not the exit code).
function runHook(input: unknown, extraEnv: Record<string, string> = {}): string {
  return execFileSync("bash", [HOOK], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_PROJECT_DIR: home, ...extraEnv },
  });
}

function decision(out: string): string | null {
  if (!out.trim()) return null; // no output = allow
  return JSON.parse(out).hookSpecificOutput.permissionDecision;
}

const GATE = { leadRole: "lead", gatedTools: ["maw_task add"], coordinator: COORD };

describe("card-gate hook — kobo-174", () => {
  test("bash `maw task add` while gated + no @role → fail-CLOSED deny, actionable reason", () => {
    writeConfig(GATE);
    const out = runHook({ tool_name: "Bash", tool_input: { command: "maw task add --title x --company kobo" } });
    expect(decision(out)).toBe("deny");
    const reason = JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain(COORD);        // points at the conductor
    expect(reason).toContain("--force-lead"); // names the override
  });

  test("MCP maw_task action=add while gated + no @role → fail-CLOSED deny", () => {
    writeConfig(GATE);
    const out = runHook({ tool_name: "mcp__maw__maw_task", tool_input: { action: "add", title: "x" } });
    expect(decision(out)).toBe("deny");
  });

  test("bash `maw company task add` (alt path) → deny", () => {
    writeConfig(GATE);
    const out = runHook({ tool_name: "Bash", tool_input: { command: "maw company task add --title x" } });
    expect(decision(out)).toBe("deny");
  });

  test("--force-lead conscious override → allow", () => {
    writeConfig(GATE);
    const out = runHook({ tool_name: "Bash", tool_input: { command: "maw task add --title x --force-lead" } });
    expect(decision(out)).toBeNull();
  });

  test("no mawCardGate config → opt-in, allow", () => {
    writeConfig(null);
    const out = runHook({ tool_name: "mcp__maw__maw_task", tool_input: { action: "add", title: "x" } });
    expect(decision(out)).toBeNull();
  });

  test("card-create not in gatedTools → allow", () => {
    writeConfig({ leadRole: "lead", gatedTools: [], coordinator: COORD });
    const out = runHook({ tool_name: "mcp__maw__maw_task", tool_input: { action: "add", title: "x" } });
    expect(decision(out)).toBeNull();
  });

  test("non-create bash (`maw task ls`) → allow even when gated", () => {
    writeConfig(GATE);
    const out = runHook({ tool_name: "Bash", tool_input: { command: "maw task ls --company kobo" } });
    expect(decision(out)).toBeNull();
  });

  test("non-create MCP (action=comment) → allow", () => {
    writeConfig(GATE);
    const out = runHook({ tool_name: "mcp__maw__maw_task", tool_input: { action: "comment", id: "kobo-1", text: "hi" } });
    expect(decision(out)).toBeNull();
  });

  test("unrelated tool (Read) → allow", () => {
    writeConfig(GATE);
    const out = runHook({ tool_name: "Read", tool_input: { file_path: "/tmp/x" } });
    expect(decision(out)).toBeNull();
  });
});
