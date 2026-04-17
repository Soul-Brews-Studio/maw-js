import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { _setDirs } from "../../src/commands/plugins/team/impl";

// Regression test for #393 Bug B — `maw team list` was only reading
// ~/.claude/teams/ (tool-layer store), leaving CLI-created teams (in
// ψ/memory/mailbox/teams/) invisible. Fix: union both stores in list
// output with a "STORE" column distinguishing tool vs vault.

let testDir: string;
let toolTeamsDir: string;
let tasksDir: string;
let oracleRoot: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  testDir = mkdtempSync(join(tmpdir(), "maw-bugB-"));
  toolTeamsDir = join(testDir, "tool-teams");
  tasksDir = join(testDir, "tasks");
  oracleRoot = join(testDir, "oracle");
  mkdirSync(toolTeamsDir, { recursive: true });
  mkdirSync(tasksDir, { recursive: true });
  // Oracle root markers for resolvePsi
  mkdirSync(join(oracleRoot, "ψ/memory/mailbox/teams"), { recursive: true });
  writeFileSync(join(oracleRoot, "CLAUDE.md"), "# oracle\n");
  process.chdir(oracleRoot);
  _setDirs(toolTeamsDir, tasksDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
});

function writeToolTeam(name: string, members: any[] = []) {
  const d = join(toolTeamsDir, name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "config.json"), JSON.stringify({ name, members }));
}

function writeVaultTeam(name: string, members: string[] = []) {
  const d = join(oracleRoot, "ψ/memory/mailbox/teams", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "manifest.json"), JSON.stringify({ name, members, description: "vault test" }));
}

describe("listVaultOnlyTeams + cmdTeamList — #393 Bug B", () => {
  test("vault teams appear in list with 'vault' store marker", async () => {
    writeVaultTeam("alpha-vault-only", ["agent-1", "agent-2"]);

    const { cmdTeamList } = await import("../../src/commands/plugins/team/impl");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    try {
      await cmdTeamList();
    } finally {
      console.log = origLog;
    }
    const joined = logs.join("\n");
    expect(joined).toContain("alpha-vault-only");
    expect(joined).toContain("vault");
    expect(joined).toContain("prep-only");
  });

  test("tool teams still listed with 'tool' store marker", async () => {
    writeToolTeam("beta-tool", [
      { name: "worker-a", agentType: "general-purpose", tmuxPaneId: "" },
    ]);

    const { cmdTeamList } = await import("../../src/commands/plugins/team/impl");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    try {
      await cmdTeamList();
    } finally {
      console.log = origLog;
    }
    const joined = logs.join("\n");
    expect(joined).toContain("beta-tool");
    expect(joined).toContain("tool");
  });

  test("team in BOTH stores is listed once (tool store wins — richer config)", async () => {
    writeToolTeam("both-stores", []);
    writeVaultTeam("both-stores", ["v-agent"]);

    const { cmdTeamList } = await import("../../src/commands/plugins/team/impl");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    try {
      await cmdTeamList();
    } finally {
      console.log = origLog;
    }
    const joined = logs.join("\n");
    // Team name appears once
    const matches = joined.split("\n").filter(l => l.includes("both-stores") && !l.includes("—"));
    expect(matches.length).toBe(1);
    // And it's marked as tool (not vault)
    expect(matches[0]).toContain("tool");
  });

  test("empty state (neither store has teams) shows clear message", async () => {
    const { cmdTeamList } = await import("../../src/commands/plugins/team/impl");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    try {
      await cmdTeamList();
    } finally {
      console.log = origLog;
    }
    const joined = logs.join("\n");
    expect(joined).toContain("No teams found");
    // Mentions BOTH stores so user knows where we looked
    expect(joined).toContain("tool");
    expect(joined).toContain("vault");
  });

  test("vault-only footer shows resume hint", async () => {
    writeVaultTeam("reincarnate-me", ["returning-agent"]);

    const { cmdTeamList } = await import("../../src/commands/plugins/team/impl");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: any[]) => logs.push(a.map(String).join(" "));
    try {
      await cmdTeamList();
    } finally {
      console.log = origLog;
    }
    const joined = logs.join("\n");
    expect(joined).toContain("maw team resume");
  });

  test("malformed vault manifest is skipped, not thrown", async () => {
    const d = join(oracleRoot, "ψ/memory/mailbox/teams/broken");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "manifest.json"), "{not-valid-json");

    const { cmdTeamList } = await import("../../src/commands/plugins/team/impl");
    await expect(cmdTeamList()).resolves.toBeUndefined();
  });
});

describe("cmdTeamCreate bridge — #393 Bug B extension", () => {
  test("create writes stub config.json to tool store", async () => {
    const { cmdTeamCreate } = await import("../../src/commands/plugins/team/impl");
    const origLog = console.log;
    console.log = () => {};
    try {
      cmdTeamCreate("bridge-test", { description: "testing bridge" });
    } finally {
      console.log = origLog;
    }
    // Vault manifest exists
    const vaultManifest = join(oracleRoot, "ψ/memory/mailbox/teams/bridge-test/manifest.json");
    expect(existsSync(vaultManifest)).toBe(true);
    // Tool store stub also exists
    const toolConfig = join(toolTeamsDir, "bridge-test/config.json");
    expect(existsSync(toolConfig)).toBe(true);
    const config = JSON.parse(readFileSync(toolConfig, "utf-8"));
    expect(config.name).toBe("bridge-test");
    expect(config.members).toEqual([]);
  });

  test("spawn syncs member to tool store config", async () => {
    const { cmdTeamCreate, cmdTeamSpawn } = await import("../../src/commands/plugins/team/impl");
    const origLog = console.log;
    console.log = () => {};
    try {
      cmdTeamCreate("spawn-bridge", { description: "spawn test" });
      cmdTeamSpawn("spawn-bridge", "researcher", { model: "sonnet" });
    } finally {
      console.log = origLog;
    }
    // Tool store config should have the member
    const toolConfig = join(toolTeamsDir, "spawn-bridge/config.json");
    expect(existsSync(toolConfig)).toBe(true);
    const config = JSON.parse(readFileSync(toolConfig, "utf-8"));
    expect(config.members.some((m: any) => m.name === "researcher")).toBe(true);
  });
});
