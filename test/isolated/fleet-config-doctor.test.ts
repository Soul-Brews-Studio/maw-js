import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildConfigInventory,
  buildFleetConfigDoctorReport,
  cmdFleetConfigDoctor,
  compareConfigInventories,
  formatFleetConfigDoctorReport,
} from "../../src/commands/shared/fleet-config-doctor.ts?fleet-config-doctor-test";

const tempRoots: string[] = [];

function tempRoot(name: string): string {
  const root = join(tmpdir(), `maw-fleet-config-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return root;
}

function write(root: string, rel: string, contents: string): void {
  const path = join(root, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
}

function cloneConfig(from: string, to: string): void {
  for (const entry of buildConfigInventory(from)) write(to, entry.path, Buffer.from("placeholder").toString());
  // Re-copy with the real contents for the specific fixture paths used below.
  write(to, ".claude/settings.json", "secure settings\n");
  write(to, ".claude/hooks/auto-rrr.sh", "#!/bin/sh\necho rrr\n");
  write(to, ".claude/skills/foo/SKILL.md", "# foo\n");
  write(to, "CLAUDE.md", "# Claude\n");
  write(to, ".mcp.json", "{}\n");
}

function fixtureFleet(repoNames: string[]) {
  return repoNames.map((repo, index) => ({
    file: `${String(index + 1).padStart(2, "0")}-${repo.split("/").pop()}.json`,
    num: index + 1,
    groupName: repo.split("/").pop() || repo,
    session: {
      name: `${String(index + 1).padStart(2, "0")}-${repo.split("/").pop()}`,
      windows: [{ name: repo.split("/").pop() || repo, repo }],
    },
  })) as any;
}

afterEach(() => {
  process.exitCode = undefined;
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fleet config drift doctor (#1865)", () => {
  test("inventories supported repo-local config files while ignoring local-only settings", () => {
    const root = tempRoot("inventory");
    write(root, ".claude/settings.json", "shared\n");
    write(root, ".claude/settings.local.json", "local-only\n");
    write(root, ".claude/hooks/check.sh", "hook\n");
    write(root, ".claude/skills/a/SKILL.md", "skill\n");
    write(root, "CLAUDE.md", "doc\n");

    const files = buildConfigInventory(root).map((entry) => entry.path);
    expect(files).toEqual([
      ".claude/hooks/check.sh",
      ".claude/settings.json",
      ".claude/skills/a/SKILL.md",
      "CLAUDE.md",
    ]);
  });

  test("compares baseline and target config by missing, changed, and extra files", () => {
    const baseline = tempRoot("baseline-compare");
    const target = tempRoot("target-compare");
    write(baseline, ".claude/settings.json", "secure settings\n");
    write(baseline, ".claude/hooks/auto-rrr.sh", "#!/bin/sh\necho rrr\n");
    write(baseline, "CLAUDE.md", "# Claude\n");

    write(target, ".claude/settings.json", "stale settings\n");
    write(target, "CLAUDE.md", "# Claude\n");
    write(target, ".claude/commands/extra.md", "extra\n");

    const diff = compareConfigInventories(buildConfigInventory(baseline), buildConfigInventory(target));
    expect(diff.missing).toEqual([".claude/hooks/auto-rrr.sh"]);
    expect(diff.changed).toEqual([".claude/settings.json"]);
    expect(diff.extra).toEqual([".claude/commands/extra.md"]);
  });

  test("reports fleet-wide drift without applying any changes", async () => {
    const baseline = tempRoot("baseline-report");
    write(baseline, ".claude/settings.json", "secure settings\n");
    write(baseline, ".claude/hooks/auto-rrr.sh", "#!/bin/sh\necho rrr\n");
    write(baseline, ".claude/skills/foo/SKILL.md", "# foo\n");
    write(baseline, "CLAUDE.md", "# Claude\n");
    write(baseline, ".mcp.json", "{}\n");

    const ghq = tempRoot("ghq-report");
    const ok = join(ghq, "github.com", "Org", "ok-oracle");
    const drift = join(ghq, "github.com", "Org", "drift-oracle");
    const empty = join(ghq, "github.com", "Org", "empty-oracle");
    mkdirSync(ok, { recursive: true });
    mkdirSync(drift, { recursive: true });
    mkdirSync(empty, { recursive: true });
    cloneConfig(baseline, ok);
    write(drift, ".claude/settings.json", "stale settings\n");
    write(drift, ".claude/skills/foo/SKILL.md", "# foo\n");
    write(drift, "CLAUDE.md", "# Claude\n");
    write(drift, ".mcp.json", "{}\n");
    write(drift, ".claude/commands/extra.md", "extra\n");

    const report = buildFleetConfigDoctorReport(
      { baseline },
      { ghqRoot: ghq, loadFleetEntries: () => fixtureFleet(["Org/ok-oracle", "Org/drift-oracle", "Org/empty-oracle", "Org/missing-oracle"]) },
    );

    expect(report.summary).toEqual({ total: 4, ok: 1, drift: 1, missingRepo: 1, noConfig: 1 });
    const driftTarget = report.targets.find((target) => target.repo === "Org/drift-oracle")!;
    expect(driftTarget.status).toBe("drift");
    expect(driftTarget.missing).toEqual([".claude/hooks/auto-rrr.sh"]);
    expect(driftTarget.changed).toEqual([".claude/settings.json"]);
    expect(driftTarget.extra).toEqual([".claude/commands/extra.md"]);

    const human = formatFleetConfigDoctorReport(report);
    expect(human).toContain("Fleet Config Drift Doctor");
    expect(human).toContain("Report-only: no files changed");

    const logs: string[] = [];
    const returned = await cmdFleetConfigDoctor(
      { baseline, json: true },
      { ghqRoot: ghq, loadFleetEntries: () => fixtureFleet(["Org/drift-oracle"]), log: (msg) => logs.push(String(msg)) },
    );
    expect(returned.summary.drift).toBe(1);
    expect(JSON.parse(logs[0]).targets[0].status).toBe("drift");
    expect(process.exitCode).toBeUndefined();
  });
});
