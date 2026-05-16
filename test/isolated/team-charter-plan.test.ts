import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import teamHandler from "../../src/vendor/mpr-plugins/team/index";
import { formatTeamCharterPlan, parseTeamCharterText, planTeamCharter } from "../../src/vendor/mpr-plugins/team/team-charter";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-team-charter-"));
  tmpDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, content, "utf-8");
  return file;
}

describe("team charter plan (#1594)", () => {
  test("parses the supported team.yaml subset and renders a read-only plan", () => {
    const charter = parseTeamCharterText(`
name: mawjs-features
description: Feature squad
goal: |
  Coordinate feature design.
  Keep writes isolated.
members:
  - role: designer
    target: auto
    model: opus
    cwd: /tmp/work
    prompt: |
      Design the surface.
      Keep it small.
  - role: verifier
    target: new:light
    model: sonnet
lifecycle:
  heartbeat_required: true
  heartbeat_truth_source: inbox
governance:
  requires_human_approval: false
`);

    expect(charter.name).toBe("mawjs-features");
    expect(charter.goal).toContain("Keep writes isolated");
    expect(charter.members).toHaveLength(2);
    expect(charter.members[0]).toMatchObject({ role: "designer", target: "auto", model: "opus", cwd: "/tmp/work" });
    expect(charter.members[0].prompt).toContain("Keep it small");
    expect(charter.lifecycle?.heartbeat_required).toBe(true);

    const plan = planTeamCharter(charter);
    const rendered = formatTeamCharterPlan(plan);

    expect(rendered).toContain("team charter plan: mawjs-features");
    expect(rendered).toContain("designer (target=auto, model=opus, cwd=/tmp/work)");
    expect(rendered).toContain("verifier (target=new:light, model=sonnet)");
    expect(rendered).toContain("no files written");
    expect(rendered).toContain("no claude processes spawned");
    expect(rendered).toContain("verifier: target 'new:light' is planned only");
  });

  test("parses JSON charters without requiring a YAML dependency", () => {
    const charter = parseTeamCharterText(JSON.stringify({
      name: "json-team",
      members: [{ role: "builder", target: "auto" }],
    }));

    expect(charter).toMatchObject({ name: "json-team", members: [{ role: "builder", target: "auto" }] });
  });

  test("team handler plan subcommand is read-only and prints planned artifacts", async () => {
    const file = tmpFile("team.yaml", `
name: safe-plan
members:
  - role: scout
    target: existing:mawjs-oracle
`);

    const result = await teamHandler({ source: "cli", args: ["plan", file] });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("team charter plan: safe-plan");
    expect(result.output).toContain("would prepare artifacts");
    expect(result.output).toContain("inboxes/scout.json");
    expect(result.output).toContain("no tmux panes changed");
    expect(result.output).toContain("target 'existing:mawjs-oracle' is planned only");
  });
});
