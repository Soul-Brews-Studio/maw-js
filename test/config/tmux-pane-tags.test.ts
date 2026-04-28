/**
 * Tests for tagPane and readPaneTags from src/core/transport/tmux-pane-tags.ts.
 * Uses DI tmux parameter with a mock Tmux class.
 */
import { describe, it, expect } from "bun:test";
import { tagPane, readPaneTags } from "../../src/core/transport/tmux-pane-tags";

class MockTmux {
  calls: Array<{ cmd: string; args: string[] }> = [];
  responses: Record<string, string> = {};

  async run(...args: string[]): Promise<string> {
    const cmd = args[0];
    this.calls.push({ cmd, args: args.slice(1) });
    return this.responses[cmd] ?? "";
  }

  async tryRun(...args: string[]): Promise<string> {
    return this.run(...args);
  }
}

describe("tagPane", () => {
  it("sets pane title via select-pane -T", async () => {
    const mock = new MockTmux();
    await tagPane("session:0", { title: "my-title", tmux: mock as any });
    expect(mock.calls.length).toBe(1);
    expect(mock.calls[0].cmd).toBe("select-pane");
    expect(mock.calls[0].args).toContain("-T");
    expect(mock.calls[0].args).toContain("my-title");
  });

  it("sets @meta options via set-option", async () => {
    const mock = new MockTmux();
    await tagPane("session:0", { meta: { oracle: "pulse", role: "dev" }, tmux: mock as any });
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[0].cmd).toBe("set-option");
    expect(mock.calls[0].args).toContain("@oracle");
    expect(mock.calls[0].args).toContain("pulse");
    expect(mock.calls[1].args).toContain("@role");
    expect(mock.calls[1].args).toContain("dev");
  });

  it("prefixes @ automatically to meta keys", async () => {
    const mock = new MockTmux();
    await tagPane("session:0", { meta: { team: "alpha" }, tmux: mock as any });
    expect(mock.calls[0].args).toContain("@team");
  });

  it("preserves leading @ in meta keys", async () => {
    const mock = new MockTmux();
    await tagPane("session:0", { meta: { "@already": "ok" }, tmux: mock as any });
    expect(mock.calls[0].args).toContain("@already");
  });

  it("does nothing with empty opts", async () => {
    const mock = new MockTmux();
    await tagPane("session:0", { tmux: mock as any });
    expect(mock.calls.length).toBe(0);
  });

  it("sets both title and meta", async () => {
    const mock = new MockTmux();
    await tagPane("session:0", { title: "T", meta: { k: "v" }, tmux: mock as any });
    expect(mock.calls.length).toBe(2);
    expect(mock.calls[0].cmd).toBe("select-pane");
    expect(mock.calls[1].cmd).toBe("set-option");
  });
});

describe("readPaneTags", () => {
  it("returns title from display-message", async () => {
    const mock = new MockTmux();
    mock.responses["display-message"] = "my-pane-title\n";
    mock.responses["show-options"] = "";
    const result = await readPaneTags("session:0", { tmux: mock as any });
    expect(result.title).toBe("my-pane-title");
  });

  it("parses @key value from show-options", async () => {
    const mock = new MockTmux();
    mock.responses["display-message"] = "title\n";
    mock.responses["show-options"] = '@oracle pulse\n@role "team-lead"\n';
    const result = await readPaneTags("session:0", { tmux: mock as any });
    expect(result.meta["@oracle"]).toBe("pulse");
    expect(result.meta["@role"]).toBe("team-lead");
  });

  it("returns empty meta when no @options", async () => {
    const mock = new MockTmux();
    mock.responses["display-message"] = "T\n";
    mock.responses["show-options"] = "";
    const result = await readPaneTags("session:0", { tmux: mock as any });
    expect(result.meta).toEqual({});
  });
});
