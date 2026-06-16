import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");

function parseFlags(args: string[], spec: Record<string, unknown>) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const parser = spec[arg];
    if (!parser) out._.push(arg);
    else if (parser === Boolean) out[arg] = true;
    else if (typeof parser === "string") out[parser] = true;
    else out[arg] = args[++i];
  }
  return out;
}

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  hostExec: async () => "",
  parseFlags,
}));

const { command, default: demoHandler } = await import("../../src/vendor/mpr-plugins/demo/index.ts?plugin-demo-standalone");
const { cmdDemo } = await import("../../src/vendor/mpr-plugins/demo/impl.ts?plugin-demo-standalone");

const originalTmux = process.env.TMUX;
const originalTmuxPane = process.env.TMUX_PANE;
const originalWrite = process.stdout.write;

beforeEach(() => {
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
});

afterEach(() => {
  if (originalTmux === undefined) delete process.env.TMUX;
  else process.env.TMUX = originalTmux;
  if (originalTmuxPane === undefined) delete process.env.TMUX_PANE;
  else process.env.TMUX_PANE = originalTmuxPane;
  process.stdout.write = originalWrite;
});

describe("demo plugin standalone boundary (#2113)", () => {
  test("uses SDK/plugin imports and no maw core imports", () => {
    const files = ["index.ts", "impl.ts"].map((file) =>
      readFileSync(join(root, "src/vendor/mpr-plugins/demo", file), "utf8"),
    );

    for (const source of files) {
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|cli|config|lib|plugin)(?:\/|")/);
      expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
    }
    const combined = files.join("\n");
    expect(combined).toContain('from "maw-js/sdk"');
    expect(combined).toContain('from "@maw-js/sdk/plugin"');
  });

  test("exports command metadata and help", async () => {
    expect(command).toMatchObject({
      name: "demo",
      description: expect.stringContaining("simulated multi-agent"),
    });

    const result = await demoHandler({ source: "cli", args: ["--help"] } as any);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Usage: maw demo [--fast]");
    expect(result.output).toContain("No API key required");
  });

  test("runs the fast tmux demo through injected SDK-like exec", async () => {
    process.env.TMUX = "/tmp/tmux.sock";
    process.env.TMUX_PANE = "%caller";
    const commands: string[] = [];
    const paneSnapshots = ["%caller", "%caller\n%agent1", "%caller\n%agent1", "%caller\n%agent1\n%agent2"];
    const writes: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    await cmdDemo({
      fast: true,
      sleep: async () => undefined,
      exec: async (command: string) => {
        commands.push(command);
        if (command.startsWith("tmux list-panes")) return paneSnapshots.shift() ?? "%caller\n%agent1\n%agent2";
        return "";
      },
    });

    expect(commands.some((command) => command.startsWith("chmod +x '/tmp/maw-demo-"))).toBe(true);
    expect(commands).toContainEqual(expect.stringContaining("tmux split-window -t '%caller' -h -l 50%"));
    expect(commands).toContainEqual(expect.stringContaining("tmux split-window -t '%agent1' -v -l 50%"));
    expect(commands).toContain("tmux kill-pane -t '%agent2'");
    expect(commands).toContain("tmux kill-pane -t '%agent1'");
    expect(commands.filter((command) => command.startsWith("rm -f '/tmp/maw-demo-"))).toHaveLength(2);
    expect(writes.join("")).toContain("COST REPORT — demo session");
    expect(writes.join("")).toContain("demo complete");
  });
});
