import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

// #2316 plugin-coverage-gate: the task board engine lives in src/core/tasks/* +
// the worklog company-scope helper. The `task` plugin is the thin CLI shell over
// that store, so these deep imports are the EXPLICIT, intended coupling — pin the
// boundary here so extraction drift is visible.

describe("task command plugin standalone boundary", () => {
  test("task shells the core/tasks store (+ worklog company-scope) over the SDK", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "task",
      allowMawJs: [/^maw-js\/config$/],
      allowRelative: [
        /^(?:\.\.\/){3}core\/tasks\//,
        /^(?:\.\.\/){3}core\/worklog\/company-scope$/,
        /^(?:\.\.\/){3}commands\/shared\/comm-send$/, // actor resolution (same as maw hey)
      ],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
  });

  test("CLI dispatches the nine documented subcommands", () => {
    const src = readFileSync(
      join(import.meta.dir, "../../src/vendor/mpr-plugins/task/index.ts"),
      "utf8",
    );
    for (const sub of ['subcmd === "add"', 'subcmd === "ls"', 'subcmd === "start"', 'subcmd === "claim"', 'subcmd === "review"', 'subcmd === "done"', 'subcmd === "archive"', 'subcmd === "block"', 'subcmd === "unblock"']) {
      expect(src).toContain(sub);
    }
    expect(src).toContain("addTask");
    expect(src).toContain("startTask"); // eq3-007: assignee picks up own work (todo → in-progress)
    expect(src).toContain("claimTask");
    expect(src).toContain("reviewTask");
    expect(src).toContain("completeTask");
    expect(src).toContain("archiveOldDone"); // eq3-008 P3: sweep old done → tasks/archive/
    expect(src).toContain("isOnBoard"); // board hides done outside the window
    expect(src).toContain("dependencyBlock"); // eq3-009a: derived blocked-by-dependency at board read
    expect(src).toContain("parentStateResolver");
    expect(src).toContain('"--parent"'); // add accepts parent deps
    expect(src).toContain("checklistProgress"); // eq3-009c: body checklist N/M on the board
    expect(src).toContain('"--body"'); // add accepts a body
    expect(src).toContain("blockTask"); // eq3-009b: explicit block/unblock + kinds + for
    expect(src).toContain("unblockTask");
    expect(src).toContain("BLOCK_KINDS");
    // actor resolution matches `maw hey` (resolveSenderIdentity), not config.oracle
    expect(src).toContain("resolveSenderIdentity");
  });

  test("manifest registers the `task` command", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "../../src/vendor/mpr-plugins/task/plugin.json"), "utf8"),
    );
    expect(manifest.name).toBe("task");
    expect(manifest.cli.command).toBe("task");
  });
});
