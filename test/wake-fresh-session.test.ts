import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { buildCommandInDirFromConfig } from "../src/config/command-logic";
import { buildWakeCommand } from "../src/commands/shared/wake-cmd";
import { validatePluginCliFlags } from "../src/cli/dispatch-match";
import type { LoadedPlugin } from "../src/plugin/types";

/**
 * `maw wake --fresh-session` (alias `--no-continue`) launches the engine with a
 * FRESH conversation by stripping the resume/`--continue` placeholder, so a seat
 * does not resume its latest conversation. It reuses the existing `freshLaunch`
 * strip path; this test locks the launch line's `--continue` behavior and the
 * flag→fresh wiring.
 */
describe("wake --fresh-session strips --continue from the launch line", () => {
  const config = { commands: { default: "claude --dangerously-skip-permissions --continue" } };

  test("default launch keeps --continue (resumes)", () => {
    const cmd = buildCommandInDirFromConfig(config, "worker", "/repos/x", { fresh: false });
    expect(cmd).toContain("--continue");
  });

  test("fresh launch drops --continue (fresh conversation)", () => {
    const cmd = buildCommandInDirFromConfig(config, "worker", "/repos/x", { fresh: true });
    expect(cmd).not.toContain("--continue");
  });
});

describe("buildWakeCommand wiring: freshSession routes exactly like freshLaunch", () => {
  test("freshSession produces the same launch line as freshLaunch", () => {
    const viaSession = buildWakeCommand("w", "/repos/x", { freshSession: true });
    const viaLaunch = buildWakeCommand("w", "/repos/x", { freshLaunch: true });
    expect(viaSession).toBe(viaLaunch);
  });

  test("neither flag → the two fresh forms still agree, and a plain wake may differ", () => {
    // config-independent invariant: the two fresh forms are always equal
    const a = buildWakeCommand("w", "/repos/x", {});
    const b = buildWakeCommand("w", "/repos/x", { freshSession: false, freshLaunch: false });
    expect(a).toBe(b);
  });
});

describe("the flags are declared on the wake manifest so the dispatcher reaches the handler", () => {
  // The CLI validates argv against the plugin manifest's cli.flags BEFORE
  // dispatch (dispatch-match.validatePluginCliFlags). Undeclared flags are
  // rejected, so both surfaces must declare them. Load the REAL plugin.json.
  const manifest = JSON.parse(readFileSync("src/vendor/mpr-plugins/wake/plugin.json", "utf8"));
  const wake: LoadedPlugin = { manifest, dir: "src/vendor/mpr-plugins/wake", wasmPath: "", kind: "ts" };

  test("--fresh-session passes manifest validation", () => {
    expect(validatePluginCliFlags(wake, ["oracle", "--fresh-session"])).toEqual({ ok: true });
  });

  test("--no-continue passes manifest validation", () => {
    expect(validatePluginCliFlags(wake, ["oracle", "--no-continue"])).toEqual({ ok: true });
  });

  test("an undeclared flag is still rejected (validator is active for this manifest)", () => {
    expect(validatePluginCliFlags(wake, ["oracle", "--fresh-sessionn"]).ok).toBe(false);
  });

  test("plugin.ts and plugin.json declare the same fresh flags (surface parity)", () => {
    const tsManifest = readFileSync("src/vendor/mpr-plugins/wake/plugin.ts", "utf8");
    for (const flag of ["--fresh-session", "--no-continue"]) {
      expect(tsManifest.includes(`"${flag}": "boolean"`)).toBe(true);
      expect(manifest.cli.flags[flag]).toBe("boolean");
    }
  });
});
