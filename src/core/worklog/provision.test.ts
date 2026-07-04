import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { provisionOracleHooks, hooksStatusForOracle, pruneOracleHooks, provisionOracleStatusline } from "./hook-setup";

// Per-oracle provisioning of the unified company-context hook set (worklog +
// company-policy). Isolated via a temp ghqRoot (repo dirs) + temp MAW_HOME (so
// ensureWorklogHookScripts writes the scripts into a sandbox, not ~/.config).
describe("per-oracle hook provisioning", () => {
  let ghq = "";
  let home = "";
  const origHome = process.env.MAW_HOME;

  beforeEach(() => {
    ghq = mkdtempSync(join(tmpdir(), "maw-prov-ghq-"));
    home = mkdtempSync(join(tmpdir(), "maw-prov-home-"));
    process.env.MAW_HOME = home;
  });
  afterEach(() => {
    if (origHome === undefined) delete process.env.MAW_HOME;
    else process.env.MAW_HOME = origHome;
    for (const d of [ghq, home]) if (d) rmSync(d, { recursive: true, force: true });
  });

  function mkRepo(oracle: string): string {
    const dir = join(ghq, `${oracle}-oracle`);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    return dir;
  }
  function readSettings(oracle: string): any {
    const p = join(ghq, `${oracle}-oracle`, ".claude", "settings.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf-8")) : null;
  }
  function allCommands(settings: any): string[] {
    return Object.values(settings.hooks ?? {})
      .flat()
      .flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command));
  }

  it("skipped when repo dir absent (defer, never throws)", () => {
    expect(provisionOracleHooks("ghost", { ghqRoot: ghq })).toBe("skipped");
    expect(hooksStatusForOracle("ghost", { ghqRoot: ghq }).hasDir).toBe(false);
  });

  it("updated → alreadyOk (idempotent); installs the full unified set incl. policy", () => {
    mkRepo("alice");
    expect(provisionOracleHooks("alice", { ghqRoot: ghq })).toBe("updated");
    const st = hooksStatusForOracle("alice", { ghqRoot: ghq });
    expect(st.hasDir).toBe(true);
    expect(st.missing).toEqual([]);
    expect(st.installed).toContain("company-policy.sh");
    expect(st.installed.length).toBeGreaterThanOrEqual(4);
    expect(provisionOracleHooks("alice", { ghqRoot: ghq })).toBe("alreadyOk");
  });

  it("dryRun reports updated but writes nothing", () => {
    mkRepo("bob");
    expect(provisionOracleHooks("bob", { ghqRoot: ghq, dryRun: true })).toBe("updated");
    expect(readSettings("bob")).toBeNull();
  });

  it("preserves pre-existing non-worklog hooks; prune strips only ours", () => {
    const dir = mkRepo("carol");
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/my/custom.sh" }] }] },
      }, null, 2),
    );
    provisionOracleHooks("carol", { ghqRoot: ghq });
    let cmds = allCommands(readSettings("carol"));
    expect(cmds).toContain("/my/custom.sh");
    expect(cmds.some((c) => c.includes("company-policy.sh"))).toBe(true);

    expect(pruneOracleHooks("carol", { ghqRoot: ghq })).toBe("pruned");
    cmds = allCommands(readSettings("carol"));
    expect(cmds).toContain("/my/custom.sh"); // foreign hook survives
    expect(cmds.some((c) => c.includes("company-policy.sh"))).toBe(false);
    expect(cmds.some((c) => c.includes("worklog-"))).toBe(false);

    expect(pruneOracleHooks("carol", { ghqRoot: ghq })).toBe("nothing");
  });

  it("prune skipped when repo dir absent", () => {
    expect(pruneOracleHooks("ghost", { ghqRoot: ghq })).toBe("skipped");
  });

  // kobo-104 — statusLine presence-capture provisioning (settings.json FIELD).
  describe("statusLine provisioning (presence capture)", () => {
    it("fresh install sets statusLine → maw-statusline.sh, no delegate arg", () => {
      mkRepo("dave");
      expect(provisionOracleStatusline("dave", { ghqRoot: ghq })).toBe("updated");
      const cmd = readSettings("dave").statusLine.command as string;
      expect(cmd).toContain("maw-statusline.sh");
      expect(cmd.trim().endsWith("maw-statusline.sh")).toBe(true); // nothing wrapped → no arg
      // idempotent — already ours, never re-wraps
      expect(provisionOracleStatusline("dave", { ghqRoot: ghq })).toBe("alreadyOk");
    });

    it("WRAPS a pre-existing statusLine (RTK/token) instead of clobbering it", () => {
      const dir = mkRepo("erin");
      writeFileSync(
        join(dir, ".claude", "settings.json"),
        JSON.stringify({ statusLine: { type: "command", command: "rtk statusline --fancy" } }, null, 2),
      );
      expect(provisionOracleStatusline("erin", { ghqRoot: ghq })).toBe("updated");
      const cmd = readSettings("erin").statusLine.command as string;
      expect(cmd).toContain("maw-statusline.sh");
      // the original command survives — base64-encoded as maw-statusline.sh's arg
      const arg = cmd.split(/\s+/).pop()!;
      expect(Buffer.from(arg, "base64").toString("utf8")).toBe("rtk statusline --fancy");
      // idempotent — a second pass sees it's already wrapped, no double-encode
      expect(provisionOracleStatusline("erin", { ghqRoot: ghq })).toBe("alreadyOk");
    });

    it("dryRun reports updated but writes nothing; skipped when repo absent", () => {
      mkRepo("frank");
      expect(provisionOracleStatusline("frank", { ghqRoot: ghq, dryRun: true })).toBe("updated");
      expect(readSettings("frank")).toBeNull();
      expect(provisionOracleStatusline("ghost", { ghqRoot: ghq })).toBe("skipped");
    });
  });
});
