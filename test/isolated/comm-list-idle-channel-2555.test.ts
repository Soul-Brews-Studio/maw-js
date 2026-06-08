import { describe, it, expect } from "bun:test";
import { cmdList, formatIdleAge, oracleStemForChannel } from "../../src/commands/shared/comm-list";
import type { TmuxPane } from "../../src/core/transport/tmux-types";

/**
 * #2555 — `maw ls` shows idle duration + channel-listener status so operators
 * can see why an agent is (or isn't) auto-sleep exempt. cmdList is fully
 * dep-injected here, so this needs no tmux / FS / channel config.
 */

const NOW_MS = 1_000_000_000_000;

function pane(target: string, winIdx: number, idleSec: number): TmuxPane {
  return { id: target, command: "claude", target, title: "", winIdx, lastActivity: NOW_MS / 1000 - idleSec };
}

async function render(over: Partial<Parameters<typeof cmdList>[1]> = {}): Promise<string> {
  const outs: string[] = [];
  await cmdList({}, {
    listSessions: async () => [
      { name: "08-mawjs", windows: [{ index: 0, name: "mawjs-oracle", active: true }] },
      { name: "03-catlab", windows: [{ index: 0, name: "discord-oracle", active: false }] },
    ] as any,
    getPaneInfos: async () => ({
      "08-mawjs:0": { command: "claude", cwd: "/repos/mawjs-oracle" },
      "03-catlab:0": { command: "claude", cwd: "/repos/discord-oracle/agents/1-x" },
    }),
    isAgentCommand: (c: string) => c === "claude",
    listPanes: async () => [pane("08-mawjs:mawjs-oracle.0", 0, 600), pane("03-catlab:discord-oracle.0", 0, 7200)],
    channelIds: (stem: string) => (stem === "discord" ? ["plugin:discord@1"] : []),
    now: () => NOW_MS,
    env: {},
    log: { log: (m: string) => outs.push(m), error: () => {} },
    ...over,
  });
  return outs.join("\n");
}

describe("cmdList (#2555) — idle duration + channel status", () => {
  it("annotates each agent window with its idle duration", async () => {
    const out = await render();
    expect(out).toContain("0: mawjs-oracle");
    expect(out).toContain("idle 10m");
    expect(out).toContain("idle 2h");
  });

  it("tags channel listeners and leaves non-listeners untagged", async () => {
    const out = await render();
    const lines = out.split("\n");
    const discordLine = lines.find(l => l.includes("discord-oracle"))!;
    const mawjsLine = lines.find(l => l.includes("mawjs-oracle"))!;
    expect(discordLine).toContain("📡 [ch: plugin:discord@1]");
    expect(mawjsLine).not.toContain("[ch:");
  });

  it("fails soft when listPanes is unavailable (no idle column, rows still render)", async () => {
    const out = await render({ listPanes: async () => { throw new Error("no tmux"); } });
    expect(out).toContain("0: mawjs-oracle");
    expect(out).not.toContain("idle ");
  });
});

describe("formatIdleAge (#2555)", () => {
  it("renders seconds, minutes, hours", () => {
    expect(formatIdleAge(45)).toBe("45s");
    expect(formatIdleAge(600)).toBe("10m");
    expect(formatIdleAge(7200)).toBe("2h");
  });
  it("clamps negatives to 0s", () => {
    expect(formatIdleAge(-5)).toBe("0s");
  });
});

describe("oracleStemForChannel (#2555)", () => {
  it("prefers the -oracle repo dir in the cwd", () => {
    expect(oracleStemForChannel("/repos/discord-oracle/agents/1-x", "discord-fix-1")).toBe("discord");
  });
  it("falls back to the window name when cwd has no -oracle dir", () => {
    expect(oracleStemForChannel("/tmp/scratch", "telegram-oracle")).toBe("telegram-oracle");
  });
});
