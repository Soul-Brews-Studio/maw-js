import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildWakeBudLineage, writeWakeBudBirthSignal, writeWakeBudLineage } from "../../src/commands/shared/wake-cmd";

describe("wake --bud lineage", () => {
  test("builds deterministic YAML for a lineage-stamped worktree", () => {
    const yaml = buildWakeBudLineage({
      parentOracle: "mawjs",
      task: "features",
      branch: "agents/1-features",
      buddedAt: "2026-05-16T09:30:00.000Z",
      buddedBy: "m5:mawjs-codex",
    });

    expect(yaml).toBe([
      'budded_from: "mawjs"',
      'budded_at: "2026-05-16T09:30:00.000Z"',
      'budded_by: "m5:mawjs-codex"',
      'branch: "agents/1-features"',
      'task: "features"',
      '',
    ].join("\n"));
  });

  test("writes ψ/.lineage.yaml without mutating fleet or repo metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-wake-bud-"));
    try {
      const file = writeWakeBudLineage(dir, {
        parentOracle: "mawjs",
        task: "channel",
        branch: "agents/7-channel",
        buddedAt: "2026-05-16T09:31:00.000Z",
        buddedBy: "tester",
      });

      expect(file).toBe(join(dir, "ψ", ".lineage.yaml"));
      expect(readFileSync(file, "utf-8")).toContain('budded_from: "mawjs"');
      expect(readFileSync(file, "utf-8")).toContain('task: "channel"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("can drop an optional parent ψ/memory/signals birth signal", () => {
    const parentRoot = mkdtempSync(join(tmpdir(), "maw-wake-bud-parent-"));
    try {
      const file = writeWakeBudBirthSignal(parentRoot, "mawjs-channel", {
        parentOracle: "mawjs",
        task: "channel",
        branch: "agents/7-channel",
        worktreePath: "/tmp/mawjs-oracle.wt-7-channel",
      });

      expect(file.startsWith(join(parentRoot, "ψ", "memory", "signals"))).toBe(true);
      expect(existsSync(file)).toBe(true);
      expect(readdirSync(join(parentRoot, "ψ", "memory", "signals"))).toHaveLength(1);
      const signal = JSON.parse(readFileSync(file, "utf-8"));
      expect(signal.bud).toBe("mawjs-channel");
      expect(signal.kind).toBe("info");
      expect(signal.message).toBe("wake-bud born: mawjs-channel");
      expect(signal.context).toEqual({
        buddedFrom: "mawjs",
        task: "channel",
        branch: "agents/7-channel",
        worktreePath: "/tmp/mawjs-oracle.wt-7-channel",
      });
    } finally {
      rmSync(parentRoot, { recursive: true, force: true });
    }
  });
});
