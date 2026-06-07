import { describe, expect, test } from "bun:test";
import {
  paneTargetCandidatesFromListPanesOutput,
  resolvePaneTargetFromListPanesOutput,
} from "../../src/commands/shared/pane-target-resolver";

const raw = [
  "%101|||47-mawjs:1.0|||codex-headless-demo-layout|||tile-1|||/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle.wt-7-codex-headless",
  "%202|||47-mawjs:1.1|||notes|||researcher|||/opt/Code/github.com/Soul-Brews-Studio/notes-oracle.wt-2-researcher",
].join("\n");

const nestedAgentsRaw = [
  "%303|||47-mawjs:2.0|||nested-agent|||tile-3|||/opt/Code/github.com/Soul-Brews-Studio/mawjs-oracle/agents/12-codex-headless",
  "%404|||47-mawjs:2.1|||plain-nested-agent|||tile-4|||/opt/Code/github.com/Soul-Brews-Studio/not-oracle/agents/researcher",
].join("\n");

describe("tmux kill pane target fallback (#1502)", () => {
  test("indexes pane titles, tile roles, and worktree aliases", () => {
    const names = paneTargetCandidatesFromListPanesOutput(raw).map(c => `${c.name}:${c.source}:${c.resolved}`);

    expect(names).toContain("codex-headless-demo-layout:pane-title:%101");
    expect(names).toContain("tile-1:tile-role:%101");
    expect(names).toContain("codex-headless:worktree-role:%101");
    expect(names).toContain("mawjs-codex-headless:worktree-alias:%101");
  });

  test("indexes nested agents paths as dir, role, and repo-role aliases", () => {
    const names = paneTargetCandidatesFromListPanesOutput(nestedAgentsRaw)
      .map(c => `${c.name}:${c.source}:${c.resolved}`);

    expect(names).toContain("12-codex-headless:worktree-dir:%303");
    expect(names).toContain("codex-headless:worktree-role:%303");
    expect(names).toContain("mawjs-codex-headless:worktree-alias:%303");
    expect(names).toContain("researcher:worktree-dir:%404");
    expect(names).toContain("not-researcher:worktree-alias:%404");
    expect(names).not.toContain("researcher:worktree-role:%404");
  });

  test("resolves nested agents repo-role aliases to pane ids", () => {
    const hit = resolvePaneTargetFromListPanesOutput("mawjs-codex-headless", nestedAgentsRaw);

    expect(hit.kind).toBe("match");
    if (hit.kind !== "match") throw new Error("expected match");
    expect(hit.candidate.resolved).toBe("%303");
    expect(hit.candidate.source).toBe("worktree-alias");
  });

  test("resolves the natural mawjs-prefixed worktree alias to the orphan pane id", () => {
    const hit = resolvePaneTargetFromListPanesOutput("mawjs-codex-headless", raw);

    expect(hit.kind).toBe("match");
    if (hit.kind !== "match") throw new Error("expected match");
    expect(hit.candidate.resolved).toBe("%101");
    expect(hit.candidate.source).toBe("worktree-alias");
  });

  test("exact pane title wins directly", () => {
    const hit = resolvePaneTargetFromListPanesOutput("codex-headless-demo-layout", raw);

    expect(hit.kind).toBe("match");
    if (hit.kind !== "match") throw new Error("expected match");
    expect(hit.candidate.resolved).toBe("%101");
    expect(hit.candidate.source).toBe("pane-title");
  });

  test("ambiguous fuzzy pane/worktree matches refuse to choose silently", () => {
    const ambiguousRaw = [
      "%1|||47-mawjs:1.0|||codex-a|||worker|||/tmp/mawjs-oracle.wt-1-codex",
      "%2|||47-mawjs:1.1|||codex-b|||worker|||/tmp/mawjs-oracle.wt-2-codex",
    ].join("\n");

    const hit = resolvePaneTargetFromListPanesOutput("worker", ambiguousRaw);

    expect(hit.kind).toBe("ambiguous");
    if (hit.kind !== "ambiguous") throw new Error("expected ambiguous");
    expect(hit.candidates.map(c => c.resolved).sort()).toEqual(["%1", "%2"]);
  });
});
