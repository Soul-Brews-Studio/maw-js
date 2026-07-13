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
