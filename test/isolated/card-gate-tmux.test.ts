import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// kobo-174 — the POSITIVE role branches of the card-gate need a live tmux @role
// marker (the only reliable lead signal on the origin pane, kobo-178). Isolated
// (skipped by default-safe / CI, which has no tmux) — run locally before push.
// Creates a throwaway detached tmux session, sets @role on a pane, and drives the
// hook with TMUX_PANE pointed at it, exactly as Claude Code would.

const HOOK = join(import.meta.dir, "..", "..", "src", "vendor", "mpr-plugins", "crew-skills", "assets", "hooks", "maw-card-gate.sh");
const SESSION = "cardgate-test-" + process.pid;
const COORD = "eq3:eq3-oracle.2";

function tmuxOk(): boolean {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; } catch { return false; }
}

const HAS_TMUX = tmuxOk();
let home: string;
let pane: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "card-gate-tmux-"));
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"),
    JSON.stringify({ mawCardGate: { leadRole: "lead", gatedTools: ["maw_task add"], coordinator: COORD } }));
  if (!HAS_TMUX) return;
  execFileSync("tmux", ["new-session", "-d", "-s", SESSION, "-x", "80", "-y", "24", "sh"]);
  pane = execFileSync("tmux", ["display-message", "-t", SESSION, "-p", "#{pane_id}"], { encoding: "utf8" }).trim();
});

afterAll(() => {
  if (HAS_TMUX) { try { execFileSync("tmux", ["kill-session", "-t", SESSION]); } catch {} }
  rmSync(home, { recursive: true, force: true });
});

function setRole(role: string) {
  execFileSync("tmux", ["set-option", "-p", "-t", pane, "@role", role]);
}

function runHook(input: unknown): string {
  return execFileSync("bash", [HOOK], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: home, CLAUDE_PROJECT_DIR: home, TMUX_PANE: pane, TMUX: process.env.TMUX ?? "" },
  });
}

function decision(out: string): string | null {
  return out.trim() ? JSON.parse(out).hookSpecificOutput.permissionDecision : null;
}

const CREATE = { tool_name: "mcp__maw__maw_task", tool_input: { action: "add", title: "x" } };

describe.if(HAS_TMUX)("card-gate hook — live @role (isolated, tmux)", () => {
  test("@role '👤 lead' → deny card-create", () => {
    setRole("👤 lead");
    expect(decision(runHook(CREATE))).toBe("deny");
  });

  test("@role '🎼 Conductor' → allow", () => {
    setRole("🎼 Conductor");
    expect(decision(runHook(CREATE))).toBeNull();
  });

  test("@role '🔎 worker' → allow", () => {
    setRole("🔎 worker");
    expect(decision(runHook(CREATE))).toBeNull();
  });

  test("empty @role while gated → fail-CLOSED deny (HARDEN)", () => {
    setRole("");
    expect(decision(runHook(CREATE))).toBe("deny");
  });
});

test.if(!HAS_TMUX)("tmux unavailable → live-@role cases skipped", () => {
  expect(HAS_TMUX).toBe(false);
});
