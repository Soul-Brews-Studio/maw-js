import { describe, expect, test } from "bun:test";
import { expectStandalonePluginBoundary } from "./helpers/plugin-standalone-boundary";

const { inferRetrospectiveCommand } = await import(
  "../../src/vendor/mpr-plugins/done/retrospective-command.ts?plugin-done-standalone"
);

describe("done command plugin standalone boundary", () => {
  test("touched done autosave files keep explicit standalone import boundaries", () => {
    const imports = expectStandalonePluginBoundary({
      plugin: "done",
      files: ["done-autosave.ts", "retrospective-command.ts"],
      allowRelative: ["../../../core/xdg"],
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
