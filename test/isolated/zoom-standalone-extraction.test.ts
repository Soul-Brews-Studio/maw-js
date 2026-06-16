import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "../..");
const hostExecCalls: string[] = [];

mock.module("maw-js/sdk", () => ({
  listSessions: async () => [
    { name: "Neo", windows: [{ index: 5, name: "main", active: true }] },
  ],
  tmuxCmd: () => "tmux",
  loadConfig: () => ({ peers: [] }),
  cfgTimeout: () => 1234,
  buildCommandInDir: (dir: string, cmd: string) => `cd ${dir} && ${cmd}`,
  curlFetch: async () => ({ ok: true, data: {} }),
  tmux: {
    run: async () => "",
  },
  hostExec: async (cmd: string) => {
    hostExecCalls.push(cmd);
    return "";
  },
  parseFlags: (args: string[]) => {
    const out: Record<string, unknown> & { _: string[] } = { _: [] };
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i]!;
      if (arg === "--pane") {
        const value = args[++i];
        if (value === undefined || value.startsWith("--")) throw new Error("option requires argument: --pane");
        out["--pane"] = Number(value);
      } else out._.push(arg);
    }
    return out;
  },
  resolveSessionTarget: (target: string, sessions: Array<{ name: string; windows: unknown[] }>) => {
    const match = sessions.find((s) => s.name.toLowerCase() === target.toLowerCase());
    return match ? { kind: "exact", match } : { kind: "none", hints: [] };
  },
}));

describe("zoom standalone extraction prep (#2113)", () => {
  test("runtime imports stay on the SDK boundary", () => {
    const impl = readFileSync(join(root, "src/vendor/mpr-plugins/zoom/impl.ts"), "utf8");
    const index = readFileSync(join(root, "src/vendor/mpr-plugins/zoom/index.ts"), "utf8");
    expect(impl).toContain('from "maw-js/sdk"');
    expect(index).toContain('from "maw-js/sdk"');
    expect(impl).not.toContain("maw-js/core/");
    expect(index).not.toContain("maw-js/cli/");
  });

  test("handler runs with only maw-js/sdk mocked", async () => {
    hostExecCalls.length = 0;
    const handler = (await import("../../src/vendor/mpr-plugins/zoom/index.ts?standalone-extraction")).default;
    const result = await handler({ source: "cli", args: ["neo", "--pane", "2"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("toggled zoom on Neo:5.2");
    expect(hostExecCalls).toEqual(["tmux resize-pane -Z -t 'Neo:5.2'"]);
  });
});
