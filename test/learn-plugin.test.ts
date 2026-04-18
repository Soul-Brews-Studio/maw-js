/**
 * maw learn — core plugin scaffold tests (#521).
 *
 * The impl is a stub — these tests pin the plugin SHAPE, not behavior:
 *   - plugin.json is valid + matches the registered command
 *   - stub returns a well-shaped string with mode + issue pointer
 *   - CLI flag parsing rejects unknown flags and conflicting modes
 *   - missing <repo> positional returns a usage error
 *
 * When the real impl lands (parallel agents, ghq, docs), these tests stay
 * relevant as the outer plugin contract — the inner agent work gets its
 * own tests.
 */
import { describe, it, expect } from "bun:test";
import { join } from "path";
import { readFileSync } from "fs";
import type { InvokeContext } from "../src/plugin/types";

const { default: learn, command } = await import("../src/commands/plugins/learn/index");
const { cmdLearn, resolveMode } = await import("../src/commands/plugins/learn/impl");

describe("learn plugin — scaffold", () => {
  it("plugin.json has expected command + flags", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "../src/commands/plugins/learn/plugin.json"), "utf-8"),
    );
    expect(manifest.name).toBe("learn");
    expect(manifest.cli.command).toBe("learn");
    expect(manifest.cli.flags).toEqual({ "--fast": "boolean", "--deep": "boolean" });
    expect(manifest.entry).toBe("./index.ts");
  });

  it("exports command metadata matching the manifest", () => {
    expect(command.name).toBe("learn");
  });

  it("resolveMode: flag combinations → mode", () => {
    expect(resolveMode(false, false)).toBe("default");
    expect(resolveMode(true, false)).toBe("fast");
    expect(resolveMode(false, true)).toBe("deep");
    expect(() => resolveMode(true, true)).toThrow(/mutually exclusive/);
  });

  it("cmdLearn stub: returns well-shaped message with mode + issue link", async () => {
    const out = await cmdLearn("owner/repo", "fast");
    expect(out).toContain("not yet implemented");
    expect(out).toContain("fast");
    expect(out).toContain("owner/repo");
    expect(out).toContain("issues/521");
  });

  it("CLI handler: missing <repo> returns usage error", async () => {
    const ctx: InvokeContext = { source: "cli", args: [] };
    const r = await learn(ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("usage:");
  });

  it("CLI handler: --fast + --deep conflict returns error", async () => {
    const ctx: InvokeContext = { source: "cli", args: ["x", "--fast", "--deep"] };
    const r = await learn(ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("mutually exclusive");
  });

  it("CLI handler: unknown flag returns error", async () => {
    const ctx: InvokeContext = { source: "cli", args: ["x", "--nope"] };
    const r = await learn(ctx);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unknown flag");
  });

  it("CLI handler: valid invocation returns ok + stub output", async () => {
    const ctx: InvokeContext = { source: "cli", args: ["some/repo", "--deep"] };
    const r = await learn(ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain("deep");
    expect(r.output).toContain("some/repo");
  });
});
