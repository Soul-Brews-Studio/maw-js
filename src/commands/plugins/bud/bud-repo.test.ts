import { describe, it, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Regression for #630 — config.ghqRoot can drift from the real `ghq root`
// (e.g. stale override: "/tmp/nope"). When that happens, ensureBudRepo must
// trust ghq's landing dir, not the predicted path.

type ExecCall = string;
const execCalls: ExecCall[] = [];
// Sequential return values for successive `ghq list` calls.
let ghqListQueue: string[] = [];

mock.module("../../../sdk", () => ({
  hostExec: async (cmd: string) => {
    execCalls.push(cmd);
    if (cmd.startsWith("ghq list")) return ghqListQueue.shift() ?? "";
    if (cmd.startsWith("gh repo view")) return ""; // triggers create path
    if (cmd.startsWith("gh repo create")) return "";
    if (cmd.startsWith("ghq get")) return "";
    return "";
  },
}));

describe("ensureBudRepo (#630)", () => {
  beforeEach(() => {
    execCalls.length = 0;
    ghqListQueue = [];
  });

  it("returns ghq's actual clone path when it diverges from predicted", async () => {
    const actualClone = mkdtempSync(join(tmpdir(), "maw-bud-real-clone-"));
    // First ghq list = pre-clone check (empty), second = post-clone resolve.
    ghqListQueue = ["", actualClone + "\n"];

    const { ensureBudRepo } = await import("./bud-repo");
    const predicted = "/tmp/nope/Soul-Brews-Studio/widget-oracle";

    try {
      const resolved = await ensureBudRepo(
        "Soul-Brews-Studio/widget-oracle",
        predicted,
        "widget-oracle",
        "Soul-Brews-Studio",
      );

      expect(resolved).toBe(actualClone);
      expect(resolved).not.toBe(predicted);
      expect(execCalls.some(c => c.startsWith("ghq get github.com/Soul-Brews-Studio/widget-oracle"))).toBe(true);
      expect(execCalls.some(c => c.includes("ghq list --exact --full-path"))).toBe(true);
    } finally {
      rmSync(actualClone, { recursive: true, force: true });
    }
  });

  it("throws if ghq list cannot find the repo after ghq get", async () => {
    ghqListQueue = ["", ""]; // pre-check empty, post-clone also empty
    const { ensureBudRepo } = await import("./bud-repo");

    await expect(
      ensureBudRepo(
        "Soul-Brews-Studio/ghost-oracle",
        "/tmp/nope/Soul-Brews-Studio/ghost-oracle",
        "ghost-oracle",
        "Soul-Brews-Studio",
      ),
    ).rejects.toThrow(/ghq get succeeded but ghq list cannot find/);
  });

  it("short-circuits when repo is already cloned (via ghq) at a non-predicted path", async () => {
    const preExisting = mkdtempSync(join(tmpdir(), "maw-bud-pre-clone-"));
    ghqListQueue = [preExisting + "\n"];
    const { ensureBudRepo } = await import("./bud-repo");

    try {
      const resolved = await ensureBudRepo(
        "Soul-Brews-Studio/existing-oracle",
        "/tmp/nope/Soul-Brews-Studio/existing-oracle",
        "existing-oracle",
        "Soul-Brews-Studio",
      );

      expect(resolved).toBe(preExisting);
      // No gh/ghq-get should run when a pre-existing clone is found
      expect(execCalls.some(c => c.startsWith("gh repo create"))).toBe(false);
      expect(execCalls.some(c => c.startsWith("ghq get"))).toBe(false);
    } finally {
      rmSync(preExisting, { recursive: true, force: true });
    }
  });
});
