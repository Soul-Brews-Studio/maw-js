import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

type MockSession = { name: string; windows: Array<{ index: number }> };

let sessions: MockSession[] = [];
let hostExecCalls: string[] = [];
let hostExecMode: "ok" | "read-throw" | "title-throw" | "meta-throw" = "ok";

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  tmuxCmd: () => "tmux-next",
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    if (hostExecMode === "read-throw" && cmd.includes("display-message")) {
      throw new Error("display failed");
    }
    if (hostExecMode === "title-throw" && cmd.includes("select-pane")) {
      throw new Error("title failed");
    }
    if (hostExecMode === "meta-throw" && cmd.includes("set-option")) {
      throw new Error("meta failed");
    }
    if (cmd.includes("display-message")) return "\n";
    if (cmd.includes("show-options")) return "status on\n";
    return "";
  },
}));

mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveSessionTarget: (raw: string, rows: MockSession[]) => {
    const candidates = rows.filter((row) => row.name === raw || row.name.startsWith(raw));
    if (candidates.length === 1) return { kind: "ok", match: candidates[0] };
    if (candidates.length > 1) return { kind: "ambiguous", candidates };
    return { kind: "none", hints: rows.slice(0, 2) };
  },
}));

const { cmdTag } = await import("../../src/vendor/mpr-plugins/tag/impl.ts?tag-impl-next-coverage");

describe("tag impl next coverage", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    sessions = [{ name: "mawjs", windows: [{ index: 7 }] }];
    hostExecCalls = [];
    hostExecMode = "ok";
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("explicit window targets report ambiguity and missing-session hints", async () => {
    sessions = [
      { name: "maw-one", windows: [{ index: 0 }] },
      { name: "maw-two", windows: [{ index: 1 }] },
    ];
    await expect(cmdTag("maw:2")).rejects.toThrow("'maw' is ambiguous");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("ambiguous"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("maw-one"));

    errorSpy.mockClear();
    sessions = [{ name: "available", windows: [{ index: 0 }] }];
    await expect(cmdTag("missing:2")).rejects.toThrow("session 'missing' not found");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("did you mean"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("available"));
  });

  test("read mode prints an empty metadata marker and wraps display failures", async () => {
    await cmdTag("mawjs:2");
    expect(hostExecCalls).toEqual([
      "tmux-next display-message -p -t 'mawjs:2' '#{pane_title}'",
      "tmux-next show-options -p -t 'mawjs:2'",
    ]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("title:"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("(none)"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("meta:  (none)"));

    hostExecMode = "read-throw";
    await expect(cmdTag("mawjs:2")).rejects.toThrow("read failed: display failed");
  });

  test("write mode wraps tmux title and metadata failures", async () => {
    hostExecMode = "title-throw";
    await expect(cmdTag("mawjs", { title: "lead" })).rejects.toThrow("select-pane -T failed: title failed");

    hostExecMode = "meta-throw";
    await expect(cmdTag("mawjs", { meta: ["role=lead"] })).rejects.toThrow("set-option failed: meta failed");
  });
});
