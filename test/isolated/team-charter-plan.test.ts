import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

import teamHandler from "../../src/vendor/mpr-plugins/team/index";
import { composeTeamCharterMemberPrompt, formatTeamCharterLoad, formatTeamCharterPlan, formatTeamCharterPreflight, loadTeamCharter, parseTeamCharterText, planTeamCharter, preflightTeamCharter, spawnFromTeamCharter } from "../../src/vendor/mpr-plugins/team/team-charter";
import { _setDirs, TEAMS_DIR, TASKS_DIR } from "../../src/vendor/mpr-plugins/team/team-helpers";

const tmpDirs: string[] = [];

afterEach(() => {
  _setDirs(join(homedir(), ".claude/teams"), join(homedir(), ".claude/tasks"));
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-team-charter-"));
  tmpDirs.push(dir);
  const file = join(dir, name);
  writeFileSync(file, content, "utf-8");
  return file;
}

async function withIsolatedTeamStores<T>(fn: (root: string) => T | Promise<T>): Promise<T> {
  const originalCwd = process.cwd();
  const originalTeams = TEAMS_DIR;
  const originalTasks = TASKS_DIR;
  const root = mkdtempSync(join(tmpdir(), "maw-team-charter-store-"));
  tmpDirs.push(root);
  mkdirSync(join(root, "ψ"), { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), "test oracle\n", "utf-8");
  _setDirs(join(root, "teams"), join(root, "tasks"));
  process.chdir(root);
  try {
    return await fn(root);
  } finally {
    process.chdir(originalCwd);
    _setDirs(originalTeams, originalTasks);
  }
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

  test("parses quoted scalars, inline comments, blank member lines, and YAML map blanks", () => {
    const charter = parseTeamCharterText(`
name: quoted-team # stripped comment
description: "hash # stays"
members:
  - role: scout

    target: 'auto'
lifecycle:

  retries: 2
governance:
  requires_human_approval: false
`);

    expect(charter.description).toBe("hash # stays");
    expect(charter.members).toEqual([{ role: "scout", target: "auto" }]);
    expect(charter.lifecycle?.retries).toBe(2);
    expect(charter.governance?.requires_human_approval).toBe(false);
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



  test("preflights charters without writing files", async () => {
    await withIsolatedTeamStores(async (root) => {
      const charter = parseTeamCharterText(`
name: preflight-team
members:
  - role: scout
    target: auto
  - role: bridge
    target: existing:mawjs-oracle
governance:
  requires_human_approval: true
`);

      const result = preflightTeamCharter(charter);
      const rendered = formatTeamCharterPreflight(result);

      expect(result.errors).toHaveLength(0);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(rendered).toContain("team charter preflight: preflight-team");
      expect(rendered).toContain("status: passed with warnings");
      expect(rendered).toContain("read-only preflight only");
      expect(rendered).toContain("no files written");
      expect(rendered).toContain("target:bridge");
      expect(existsSync(join(root, "teams", "preflight-team", "config.json"))).toBe(false);
      expect(existsSync(join(root, "ψ", "memory", "mailbox", "teams", "preflight-team", "manifest.json"))).toBe(false);
    });
  });

  test("handler preflight fails loudly for duplicate roles and unsupported targets", async () => {
    const file = tmpFile("team.yaml", `
name: bad-preflight
members:
  - role: scout
    target: auto
  - role: scout
    target: nowhere
`);

    const result = await teamHandler({ source: "cli", args: ["preflight", file] });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("preflight failed");
    expect(result.output).toContain("team charter preflight: bad-preflight");
    expect(result.output).toContain("duplicate role(s): scout");
    expect(result.output).toContain("unsupported target 'nowhere'");
  });

  test("preflight reports invalid names, new targets, and cwd presence checks", async () => {
    await withIsolatedTeamStores(async (root) => {
      const existingCwd = join(root, "workspace");
      mkdirSync(existingCwd, { recursive: true });
      const charter = {
        name: "bad-view",
        members: [
          { role: "scout", target: "new:helper", cwd: existingCwd },
          { role: "verifier", target: "auto", cwd: join(root, "missing") },
        ],
      };

      const result = preflightTeamCharter(charter);
      const rendered = formatTeamCharterPreflight(result);

      expect(result.errors.some((check) => check.label === "team name")).toBe(true);
      expect(result.warnings.some((check) => check.label === "target:scout")).toBe(true);
      expect(rendered).toContain(`cwd:scout: ${existingCwd}`);
      expect(rendered).toContain("cwd:verifier");
      expect(rendered).toContain("does not exist on this machine yet");
    });
  });

  test("loads a charter into config, inboxes, and vault manifest only when --no-spawn is set", async () => {
    await withIsolatedTeamStores(async (root) => {
      const charter = parseTeamCharterText(`
name: load-team
members:
  - role: scout
    target: auto
    model: spark
  - role: bridge
    target: existing:mawjs-oracle
governance:
  requires_human_approval: true
`);

      const result = loadTeamCharter(charter, { noSpawn: true, now: () => 123 });
      const rendered = formatTeamCharterLoad(result);
      const configPath = join(root, "teams", "load-team", "config.json");
      const scoutInbox = join(root, "teams", "load-team", "inboxes", "scout.json");
      const bridgeInbox = join(root, "teams", "load-team", "inboxes", "bridge.json");
      const manifestPath = join(root, "ψ", "memory", "mailbox", "teams", "load-team", "manifest.json");

      expect(rendered).toContain("team charter loaded: load-team");
      expect(rendered).toContain("--no-spawn respected");
      expect(rendered).toContain("no tmux panes changed");
      expect(rendered).toContain("no claude processes spawned");
      expect(existsSync(configPath)).toBe(true);
      expect(JSON.parse(readFileSync(configPath, "utf-8"))).toMatchObject({
        name: "load-team",
        createdAt: 123,
        members: [
          { name: "scout", model: "spark" },
          { name: "bridge", backendType: "existing:mawjs-oracle" },
        ],
      });
      expect(JSON.parse(readFileSync(scoutInbox, "utf-8"))).toEqual([]);
      expect(JSON.parse(readFileSync(bridgeInbox, "utf-8"))).toEqual([]);
      expect(JSON.parse(readFileSync(manifestPath, "utf-8"))).toMatchObject({
        name: "load-team",
        source: "team-charter",
        members: ["scout", "bridge"],
        charter: { governance: { requires_human_approval: true } },
      });
    });
  });

  test("load rejects unsafe spawn mode and existing artifacts", async () => {
    await withIsolatedTeamStores(async (root) => {
      const charter = parseTeamCharterText(`
name: collision-team
members:
  - role: scout
`);

      expect(() => loadTeamCharter(charter)).toThrow("requires --no-spawn");

      const configPath = join(root, "teams", "collision-team", "config.json");
      mkdirSync(join(root, "teams", "collision-team"), { recursive: true });
      writeFileSync(configPath, "{}", "utf-8");

      expect(() => loadTeamCharter(charter, { noSpawn: true })).toThrow("already exists; refusing to overwrite");
    });
  });

  test("handler refuses load without explicit --no-spawn", async () => {
    const file = tmpFile("team.yaml", `
name: require-safe-load
members:
  - role: scout
`);

    const result = await teamHandler({ source: "cli", args: ["load", file] });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("--no-spawn required");
    expect(result.output).toContain("maw team load <team.yaml|team.json> --no-spawn");
  });



  test("composes shared goal before each member prompt for charter spawn", () => {
    const charter = parseTeamCharterText(`
name: prompt-team
goal: |
  Ship the thing.
members:
  - role: builder
    prompt: |
      Build narrowly.
`);

    const prompt = composeTeamCharterMemberPrompt(charter, charter.members[0]);

    expect(prompt).toContain("## Team goal\nShip the thing.");
    expect(prompt).toContain("## Role prompt\nBuild narrowly.");
    expect(prompt.indexOf("## Team goal")).toBeLessThan(prompt.indexOf("## Role prompt"));
  });

  test("handler spawn-from blocks governance approval before writing files", async () => {
    await withIsolatedTeamStores(async (root) => {
      const file = join(root, "team.yaml");
      writeFileSync(file, `
name: guarded-spawn
members:
  - role: scout
    target: auto
governance:
  requires_human_approval: true
`, "utf-8");

      const result = await teamHandler({ source: "cli", args: ["spawn-from", file] });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("governance requires human approval");
      expect(existsSync(join(root, "teams", "guarded-spawn", "config.json"))).toBe(false);
      expect(existsSync(join(root, "ψ", "memory", "mailbox", "teams", "guarded-spawn", "manifest.json"))).toBe(false);
    });
  });

  test("handler spawn-from blocks non-auto targets before writing files", async () => {
    await withIsolatedTeamStores(async (root) => {
      const file = join(root, "team.yaml");
      writeFileSync(file, `
name: remote-blocked
members:
  - role: bridge
    target: existing:mawjs-oracle
`, "utf-8");

      const result = await teamHandler({ source: "cli", args: ["spawn-from", file, "--approve"] });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("supports only target:auto");
      expect(existsSync(join(root, "teams", "remote-blocked", "config.json"))).toBe(false);
      expect(existsSync(join(root, "ψ", "memory", "mailbox", "teams", "remote-blocked", "manifest.json"))).toBe(false);
    });
  });

  test("spawnFromTeamCharter includes preflight errors in its direct failure", async () => {
    await expect(spawnFromTeamCharter({
      name: "bad-spawn-view",
      members: [{ role: "scout", target: "auto" }],
    })).rejects.toThrow("preflight failed: team name:");
  });

  test("handler spawn-from materializes local target:auto spawn prompts without --exec", async () => {
    await withIsolatedTeamStores(async (root) => {
      const file = join(root, "team.yaml");
      writeFileSync(file, `
name: local-spawn
description: Local charter spawn
goal: |
  Ship charter spawn.
members:
  - role: scout
    target: auto
    model: spark
    prompt: |
      Scout narrowly.
governance:
  requires_human_approval: true
`, "utf-8");

      const result = await teamHandler({ source: "cli", args: ["spawn-from", file, "--approve"] });
      const promptPath = join(root, "ψ", "memory", "mailbox", "teams", "local-spawn", "scout-spawn-prompt.md");
      const configPath = join(root, "teams", "local-spawn", "config.json");

      expect(result.ok).toBe(true);
      expect(result.output).toContain("team charter spawn complete: local-spawn");
      expect(result.output).toContain("spawn prompts written; no tmux panes spawned without --exec");
      expect(existsSync(configPath)).toBe(true);
      expect(JSON.parse(readFileSync(configPath, "utf-8"))).toMatchObject({
        name: "local-spawn",
        members: [{ name: "scout", model: "spark" }],
      });
      expect(readFileSync(promptPath, "utf-8")).toContain("## Team goal\nShip charter spawn.");
      expect(readFileSync(promptPath, "utf-8")).toContain("## Role prompt\nScout narrowly.");
    });
  });

  test("handler load subcommand materializes files without spawning", async () => {
    await withIsolatedTeamStores(async (root) => {
      const file = join(root, "team.yaml");
      writeFileSync(file, `
name: handler-load
members:
  - role: scout
    target: auto
`, "utf-8");

      const result = await teamHandler({ source: "cli", args: ["load", file, "--no-spawn"] });

      expect(result.ok).toBe(true);
      expect(result.output).toContain("team charter loaded: handler-load");
      expect(result.output).toContain("no tmux panes changed");
      expect(result.output).toContain("no claude processes spawned");
      expect(existsSync(join(root, "teams", "handler-load", "config.json"))).toBe(true);
      expect(existsSync(join(root, "teams", "handler-load", "inboxes", "scout.json"))).toBe(true);
      expect(existsSync(join(root, "ψ", "memory", "mailbox", "teams", "handler-load", "manifest.json"))).toBe(true);
    });
  });
});
