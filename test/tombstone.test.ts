// BL-226 — worktree tombstone unit tests (pure, dependency-injected).
import { describe, test, expect } from "bun:test";
import {
  collectWorktreeFacts,
  tombstoneBlocker,
  renderTombstone,
  recordTombstone,
  type WorktreeFacts,
} from "../src/core/fleet/tombstone";

// Fake exec that answers per-command from a map (substring match).
function fakeExec(answers: Array<[RegExp, string | (() => string)]>): (cmd: string) => Promise<string> {
  return async (cmd: string) => {
    for (const [re, val] of answers) {
      if (re.test(cmd)) {
        const out = typeof val === "function" ? val() : val;
        return out;
      }
    }
    return "";
  };
}
// merge-base --is-ancestor exits non-zero when NOT an ancestor → model as throw.
function execWith(opts: { head?: string; porcelain?: string; merged?: boolean | "error" }): (cmd: string) => Promise<string> {
  return async (cmd: string) => {
    if (/rev-parse --short HEAD/.test(cmd)) return opts.head ?? "abc1234";
    if (/status --porcelain/.test(cmd)) return opts.porcelain ?? "";
    if (/merge-base --is-ancestor/.test(cmd)) {
      if (opts.merged === "error") throw new Error("fatal: not a git repo");
      if (opts.merged) return "";
      throw new Error("exit 1"); // not an ancestor
    }
    return "";
  };
}

const baseInput = { mainPath: "/repo/x", wtPath: "/repo/x.wt-slug", branch: "feat/slug", baseBranch: "main" };

describe("BL-226 tombstone — collectWorktreeFacts", () => {
  test("clean + merged worktree", async () => {
    const f = await collectWorktreeFacts(baseInput, { exec: execWith({ head: "deadbee", porcelain: "", merged: true }) });
    expect(f.head).toBe("deadbee");
    expect(f.uncommittedFiles).toEqual([]);
    expect(f.mergedIntoBase).toBe("yes");
  });

  test("dirty + not-merged worktree", async () => {
    const f = await collectWorktreeFacts(baseInput, {
      exec: execWith({ porcelain: " M src/a.ts\n?? scratch.txt", merged: false }),
    });
    expect(f.uncommittedFiles).toEqual(["M src/a.ts", "?? scratch.txt"]);
    expect(f.mergedIntoBase).toBe("no");
  });

  test("merge check error → unknown (never throws)", async () => {
    const f = await collectWorktreeFacts(baseInput, { exec: execWith({ merged: "error" }) });
    expect(f.mergedIntoBase).toBe("unknown");
  });

  test("detached/empty branch skips merge check → unknown", async () => {
    const f = await collectWorktreeFacts({ ...baseInput, branch: "HEAD" }, { exec: execWith({ merged: true }) });
    expect(f.mergedIntoBase).toBe("unknown");
  });
});

describe("BL-226 tombstone — tombstoneBlocker (fail-closed)", () => {
  const facts = (over: Partial<WorktreeFacts>): WorktreeFacts => ({
    ...baseInput, head: "abc", uncommittedFiles: [], mergedIntoBase: "yes", ...over,
  });
  test("clean + merged → not blocked", () => {
    expect(tombstoneBlocker(facts({})).blocked).toBe(false);
  });
  test("uncommitted files → blocked", () => {
    const b = tombstoneBlocker(facts({ uncommittedFiles: ["M a"] }));
    expect(b.blocked).toBe(true);
    expect(b.reasons.join(" ")).toContain("uncommitted");
  });
  test("not merged → blocked", () => {
    expect(tombstoneBlocker(facts({ mergedIntoBase: "no" })).blocked).toBe(true);
  });
  test("unknown merge status → blocked (fail-closed)", () => {
    const b = tombstoneBlocker(facts({ mergedIntoBase: "unknown" }));
    expect(b.blocked).toBe(true);
    expect(b.reasons.join(" ")).toContain("could not be verified");
  });
});

describe("BL-226 tombstone — renderTombstone", () => {
  test("frontmatter + blocker section + uncommitted list", () => {
    const md = renderTombstone(
      { ...baseInput, head: "abc1234", uncommittedFiles: ["M src/a.ts"], mergedIntoBase: "no" },
      { slug: "mawjs-fix-a", reason: "done", successor: "none", born: "2026-10-01", now: new Date("2026-10-09T12:00:00Z") },
    );
    expect(md).toContain("slug: mawjs-fix-a");
    expect(md).toContain("head: abc1234");
    expect(md).toContain("merged_into_base: no");
    expect(md).toContain("blocked: true");
    expect(md).toContain("BLOCKER");
    expect(md).toContain("`M src/a.ts`");
    expect(md).toContain("ceased: 2026-10-09T12:00:00.000Z");
  });
  test("clean worktree → no blocker section, notes no uncommitted", () => {
    const md = renderTombstone(
      { ...baseInput, head: "abc", uncommittedFiles: [], mergedIntoBase: "yes" },
      { slug: "clean-one" },
    );
    expect(md).toContain("blocked: false");
    expect(md).not.toContain("BLOCKER");
    expect(md).toContain("No uncommitted changes recorded");
  });
});

describe("BL-226 tombstone — recordTombstone", () => {
  test("writes to <mainPath>/ψ/memory/tombstones/<date>_<slug>.md + returns blocker", async () => {
    const writes: Array<[string, string]> = [];
    const result = await recordTombstone(
      baseInput,
      { slug: "mawjs-fix-a", reason: "maw done" },
      {
        exec: execWith({ porcelain: " M a.ts", merged: false }),
        writeFile: async (p, c) => { writes.push([p, c]); },
        now: () => new Date("2026-10-09T05:00:00Z"),
      },
    );
    expect(result.wrote).toBe(true);
    expect(result.path).toBe("/repo/x/ψ/memory/tombstones/2026-10-09_mawjs-fix-a.md");
    expect(result.blocker.blocked).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0][0]).toBe(result.path);
    expect(writes[0][1]).toContain("slug: mawjs-fix-a");
  });

  test("no writeFile dep → prepared (dir only), blocker still computed", async () => {
    const result = await recordTombstone(
      baseInput,
      { slug: "x" },
      { exec: execWith({ porcelain: "", merged: true }) },
    );
    expect(result.wrote).toBe(false);
    expect(result.blocker.blocked).toBe(false);
  });
});
