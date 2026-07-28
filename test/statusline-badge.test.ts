import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// kobo-297 — lock the maw-statusline.sh presence badge to the REAL away/back state,
// not just its b64-sync string. The badge is the feature's trust surface: if it
// silently broke and showed "online" while a pane is away, we'd be back to the
// original silent-drop problem. Runs the real script with a real worklog on disk,
// exactly as Claude Code invokes it (statusLine JSON on stdin), and asserts output.
const SCRIPT = join(import.meta.dir, "..", "scripts", "hooks", "maw-statusline.sh");
const PANE = "%77";
const COMPANY = "kobo";
const STDIN = JSON.stringify({ model: { display_name: "Opus" }, context_window: { remaining_percentage: 80 } });

let dataDir = "";

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "statusline-badge-"));
  mkdirSync(join(dataDir, "companies", COMPANY), { recursive: true });
});
afterEach(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function marker(paneId: string, kind: "away" | "back"): string {
  return JSON.stringify({ ts: 1, oracle: "patchwork", paneId, kind, summary: kind });
}

/** Append worklog lines (order = chronological; last = newest), then run the badge. */
function badge(lines: string[]): string {
  if (lines.length) {
    writeFileSync(join(dataDir, "companies", COMPANY, "worklog.jsonl"), lines.join("\n") + "\n");
  }
  const res = spawnSync("bash", [SCRIPT], {
    input: STDIN,
    env: { ...process.env, MAW_DATA_DIR: dataDir, TMUX_PANE: PANE, MAW_ROOM_COMPANY: COMPANY, CLAUDE_AGENT_NAME: "patchwork" },
    encoding: "utf-8",
  });
  return res.stdout;
}

describe("maw-statusline.sh presence badge (kobo-297)", () => {
  test("newest marker away → badge shows ○ away (not online)", () => {
    const out = badge([marker(PANE, "away")]);
    expect(out).toContain("○ away");
    expect(out).not.toContain("● online");
  });

  test("newest marker back → badge shows ● online", () => {
    const out = badge([marker(PANE, "away"), marker(PANE, "back")]); // away then back: sticky flip
    expect(out).toContain("● online");
    expect(out).not.toContain("○ away");
  });

  test("no marker → default ● online", () => {
    expect(badge([])).toContain("● online");
  });

  test("away marker on a DIFFERENT pane → this pane stays ● online (pane-scoped)", () => {
    const out = badge([marker("%99", "away")]); // some other pane is away
    expect(out).toContain("● online");
    expect(out).not.toContain("○ away");
  });
});

// kobo-308 — a lead/originating pane isn't spawned with MAW_ROOM_COMPANY, so before the
// registry fallback the badge guard skipped and showed "online" while the pane was away.
// The badge now resolves the company from the registry (mirror companyOfOracleLight) when
// the env is empty, so it reads the SAME worklog the away marker was written to.
describe("maw-statusline.sh badge registry-fallback when MAW_ROOM_COMPANY is empty (kobo-308)", () => {
  // Run the badge with NO MAW_ROOM_COMPANY in the env (a lead/originating pane).
  function badgeNoCompany(lines: string[], registry?: unknown): string {
    if (lines.length) {
      writeFileSync(join(dataDir, "companies", COMPANY, "worklog.jsonl"), lines.join("\n") + "\n");
    }
    if (registry !== undefined) {
      writeFileSync(join(dataDir, "companies", `${COMPANY}.json`), JSON.stringify(registry));
    }
    const env = { ...process.env, MAW_DATA_DIR: dataDir, TMUX_PANE: PANE, CLAUDE_AGENT_NAME: "patchwork" };
    delete (env as Record<string, string | undefined>).MAW_ROOM_COMPANY; // the lead-pane condition
    const res = spawnSync("bash", [SCRIPT], { input: STDIN, env, encoding: "utf-8" });
    return res.stdout;
  }

  test("empty env + registry manager-match + away marker → ○ away (was blind before)", () => {
    const out = badgeNoCompany([marker(PANE, "away")], { name: COMPANY, manager: "patchwork", departments: {} });
    expect(out).toContain("○ away");
    expect(out).not.toContain("● online");
  });

  test("empty env + registry dept-member-match + away marker → ○ away", () => {
    const registry = { name: COMPANY, manager: "someone-else", departments: { core: { members: [{ oracle: "patchwork" }] } } };
    const out = badgeNoCompany([marker(PANE, "away")], registry);
    expect(out).toContain("○ away");
    expect(out).not.toContain("● online");
  });

  test("empty env + NO registry match → ● online (fallback finds nothing, never faults)", () => {
    const out = badgeNoCompany([marker(PANE, "away")], { name: COMPANY, manager: "not-me", departments: {} });
    expect(out).toContain("● online");
    expect(out).not.toContain("○ away");
  });

  test("empty env + registry match + back marker → ● online (sticky flip still honored)", () => {
    const out = badgeNoCompany([marker(PANE, "away"), marker(PANE, "back")], { name: COMPANY, manager: "patchwork", departments: {} });
    expect(out).toContain("● online");
    expect(out).not.toContain("○ away");
  });
});

// kobo-441 — the ctx% figure was reading context_window.remaining_percentage but
// printing it under a "ctx X%" label, so a nearly-full pane showed "ctx 0%" (read as
// empty, the most dangerous misreading possible). Fix: read used_percentage instead
// (Claude's own precomputed, per-invocation figure) so the label direction is correct.
// No worklog/company setup needed here — only stdin JSON shape is under test.
describe("maw-statusline.sh ctx% direction+source fix (kobo-441)", () => {
  function ctxLine(input: unknown): string {
    const res = spawnSync("bash", [SCRIPT], {
      input: JSON.stringify(input),
      env: { ...process.env, MAW_DATA_DIR: dataDir, TMUX_PANE: PANE, CLAUDE_AGENT_NAME: "patchwork" },
      encoding: "utf-8",
    });
    return res.stdout;
  }

  test("used_percentage near 100 → ctx shows a HIGH number, not near-zero", () => {
    const out = ctxLine({ model: { display_name: "Opus" }, context_window: { used_percentage: 97, remaining_percentage: 3 } });
    expect(out).toContain("ctx 97%");
    expect(out).not.toContain("ctx 0%");
    expect(out).not.toContain("ctx 3%");
  });

  test("used_percentage near 0 → ctx shows a LOW number (paired with the above to lock direction)", () => {
    const out = ctxLine({ model: { display_name: "Opus" }, context_window: { used_percentage: 2, remaining_percentage: 98 } });
    expect(out).toContain("ctx 2%");
    expect(out).not.toContain("ctx 98%");
  });

  test("used_percentage null → ctx shows the unknown marker, never 0%", () => {
    const out = ctxLine({ model: { display_name: "Opus" }, context_window: { used_percentage: null } });
    expect(out).toContain("ctx —");
    expect(out).not.toContain("ctx 0%");
  });

  test("used_percentage absent entirely → ctx shows the unknown marker, never 0%", () => {
    const out = ctxLine({ model: { display_name: "Opus" } });
    expect(out).toContain("ctx —");
    expect(out).not.toContain("ctx 0%");
  });

  test("used_percentage at flat top-level (no context_window nesting) → still read correctly", () => {
    const out = ctxLine({ model: { display_name: "Opus" }, used_percentage: 55 });
    expect(out).toContain("ctx 55%");
  });
});
