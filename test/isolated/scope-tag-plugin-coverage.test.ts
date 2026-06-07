import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

type MockSession = { name: string; windows: Array<{ index: number }> };

const sdkCalls = {
  hostExec: [] as string[],
  sessions: [] as MockSession[],
  tmux: "tmux-test",
};

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sdkCalls.sessions,
  hostExec: async (cmd: string) => {
    sdkCalls.hostExec.push(cmd);
    if (cmd.includes("display-message")) return "main-title\n";
    if (cmd.includes("show-options")) return "@agent-name oracle\nstatus on\n@role leader\n";
    return "";
  },
  tmuxCmd: () => sdkCalls.tmux,
}));

mock.module("maw-js/core/matcher/resolve-target", () => ({
  resolveSessionTarget: (raw: string, sessions: MockSession[]) => {
    const matches = sessions.filter((s) => s.name === raw || s.name.startsWith(raw));
    if (matches.length === 1) return { kind: "ok", match: matches[0] };
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
    return { kind: "none", hints: sessions.slice(0, 2) };
  },
}));

const scopeImpl = await import("../../src/vendor/mpr-plugins/scope/impl.ts?scope-tag-plugin-coverage");
const tagImpl = await import("../../src/vendor/mpr-plugins/tag/impl.ts?scope-tag-plugin-coverage");

const {
  cmdCreate,
  cmdDelete,
  cmdList,
  cmdShow,
  formatList,
  loadScope,
  scopePath,
  scopesDir,
  validateScopeName,
} = scopeImpl;
const { cmdTag } = tagImpl;

describe("vendor scope impl isolated coverage", () => {
  const originalMawHome = process.env.MAW_HOME;
  const originalConfigDir = process.env.MAW_CONFIG_DIR;
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maw-scope-impl-"));
    delete process.env.MAW_HOME;
    delete process.env.XDG_CONFIG_HOME;
    process.env.MAW_CONFIG_DIR = join(dir, "config");
  });

  afterEach(() => {
    if (originalMawHome === undefined) delete process.env.MAW_HOME;
    else process.env.MAW_HOME = originalMawHome;
    if (originalConfigDir === undefined) delete process.env.MAW_CONFIG_DIR;
    else process.env.MAW_CONFIG_DIR = originalConfigDir;
    if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    rmSync(dir, { recursive: true, force: true });
  });

  test("validates names and resolves live config paths with MAW_HOME precedence", () => {
    expect(validateScopeName("alpha_1-prod")).toBeNull();
    expect(validateScopeName("Bad")).toContain("invalid scope name");
    expect(validateScopeName("-bad")).toContain("invalid scope name");

    expect(scopesDir()).toBe(join(dir, "config", "scopes"));
    expect(scopePath("alpha")).toBe(join(dir, "config", "scopes", "alpha.json"));

    process.env.MAW_HOME = join(dir, "home");
    process.env.MAW_CONFIG_DIR = join(dir, "ignored-config");
    expect(scopesDir()).toBe(join(dir, "home", "config", "scopes"));

    delete process.env.MAW_HOME;
    delete process.env.MAW_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = join(dir, "xdg-config");
    expect(scopesDir()).toBe(join(dir, "xdg-config", "maw", "scopes"));
  });

  test("creates, lists, shows, formats, and deletes scope files without overwriting", () => {
    const created = cmdCreate({
      name: "beta",
      members: ["oracle", "scout"],
      lead: "oracle",
      ttl: "1h",
    });

    expect(created).toMatchObject({ name: "beta", members: ["oracle", "scout"], lead: "oracle", ttl: "1h" });
    expect(created.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(readFileSync(scopePath("beta"), "utf-8")).toContain('"lead": "oracle"');
    expect(cmdShow("beta")).toMatchObject({ name: "beta", lead: "oracle" });
    expect(cmdList().map((s) => s.name)).toEqual(["beta"]);
    expect(formatList(cmdList())).toContain("beta");
    expect(formatList([])).toBe("no scopes");

    expect(() => cmdCreate({ name: "beta", members: ["oracle"] })).toThrow(/already exists/);
    expect(cmdDelete("beta")).toBe(true);
    expect(cmdDelete("beta")).toBe(false);
    expect(cmdShow("beta")).toBeNull();
  });

  test("rejects invalid create/show/delete inputs and ignores malformed JSON during list/load", () => {
    expect(() => cmdCreate({ name: "bad space", members: ["oracle"] })).toThrow(/invalid scope name/);
    expect(() => cmdCreate({ name: "empty", members: [] })).toThrow(/at least one member/);
    expect(() => cmdCreate({ name: "bad-member", members: [""] })).toThrow(/empty\/invalid member/);
    expect(() => cmdCreate({ name: "bad-lead", members: ["oracle"], lead: "scout" })).toThrow(/is not in members/);
    expect(() => cmdShow("Bad")).toThrow(/invalid scope name/);
    expect(() => cmdDelete("Bad")).toThrow(/invalid scope name/);

    cmdCreate({ name: "good", members: ["oracle"] });
    writeFileSync(scopePath("broken"), "{not-json");
    writeFileSync(join(scopesDir(), "note.txt"), "ignore me");

    expect(loadScope("broken")).toBeNull();
    expect(cmdList().map((s) => s.name)).toEqual(["good"]);
  });
});

describe("vendor tag impl isolated coverage", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    sdkCalls.hostExec = [];
    sdkCalls.sessions = [
      { name: "mawjs", windows: [{ index: 3 }] },
      { name: "other", windows: [{ index: 0 }] },
    ];
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test("read mode resolves bare session to default window and prints title plus @ metadata", async () => {
    await cmdTag("mawjs");

    expect(sdkCalls.hostExec).toEqual([
      "tmux-test display-message -p -t 'mawjs:3' '#{pane_title}'",
      "tmux-test show-options -p -t 'mawjs:3'",
    ]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("mawjs:3"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("title:"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("main-title"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("@agent-name oracle"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("@role leader"));
  });

  test("write mode sets title and pane-scoped metadata on explicit window/pane target", async () => {
    await cmdTag("mawjs:2", {
      pane: 1,
      title: "lead's pane",
      meta: ["agent-name=oracle", "@role=lead's aide"],
    });

    expect(sdkCalls.hostExec).toEqual([
      "tmux-test select-pane -t 'mawjs:2.1' -T 'lead'\\''s pane'",
      "tmux-test set-option -p -t 'mawjs:2.1' '@agent-name' 'oracle'",
      "tmux-test set-option -p -t 'mawjs:2.1' '@role' 'lead'\\''s aide'",
    ]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("title: mawjs:2.1"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("meta: mawjs:2.1 @agent-name"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("meta: mawjs:2.1 @role"));
  });

  test("reports usage, invalid meta, ambiguous targets, and missing session hints", async () => {
    await expect(cmdTag("")).rejects.toThrow(/usage: maw tag/);
    await expect(cmdTag("mawjs", { meta: ["missing-equals"] })).rejects.toThrow(/--meta must be key=val/);

    sdkCalls.sessions = [
      { name: "maw-one", windows: [{ index: 0 }] },
      { name: "maw-two", windows: [{ index: 1 }] },
    ];
    await expect(cmdTag("maw")).rejects.toThrow(/'maw' is ambiguous/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("ambiguous"));

    sdkCalls.sessions = [{ name: "available", windows: [{ index: 0 }] }];
    await expect(cmdTag("missing")).rejects.toThrow(/session 'missing' not found/);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("did you mean"));
  });
});
