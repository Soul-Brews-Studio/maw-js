import { describe, expect, test } from "bun:test";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const { inferRetrospectiveCommand } = await import(
  "../../src/vendor/mpr-plugins/done/retrospective-command.ts?plugin-done-standalone"
);

describe("done command plugin standalone boundary", () => {
  test("touched done autosave files keep explicit standalone import boundaries", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "done",
      files: ["impl.ts", "done-autosave.ts", "retrospective-command.ts"],
      allowRelative: ["./done-autosave", "./done-worktree", "../../../core/xdg"],
      allowMawJs: [
        /^maw-js\/core\/matcher\/normalize-target$/,
        /^maw-js\/commands\/shared\/wake-resolve$/,
        /^maw-js\/config\/ghq-root$/,
        /^maw-js\/vendor\/mpr-plugins\/team\/team-charter$/,
        /^maw-js\/vendor\/mpr-plugins\/team\/team-liveness$/,
      ],
    }).map((record) => record.spec);

    expect(imports).toContain("maw-js/sdk");
    expect(imports).toContain("./retrospective-command");
  });

  test("shared retrospective inference covers claude, omx, and codex-style engines", () => {
    expect(inferRetrospectiveCommand("claude")).toBe("/rrr");
    expect(inferRetrospectiveCommand("node")).toBe("/rrr");
    expect(inferRetrospectiveCommand("omx")).toBe("$rrr");
    expect(inferRetrospectiveCommand("oh-my-codex")).toBe("$rrr");
    expect(inferRetrospectiveCommand("codex")).toBeNull();
    expect(inferRetrospectiveCommand("aider")).toBeNull();
    expect(inferRetrospectiveCommand("opencode")).toBeNull();
  });
});
