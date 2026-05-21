import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupAutoWake } from "../src/vendor/mpr-plugins/setup/auto-wake";
import setupHandler from "../src/vendor/mpr-plugins/setup/index";
import { checkRebootReadiness } from "../src/commands/shared/fleet-doctor-reboot";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "maw-auto-wake-"));
  writeFileSync(join(dir, "ecosystem.config.cjs"), "module.exports = { apps: [] };\n");
  return dir;
}

describe("maw setup auto-wake (#1811)", () => {
  test("registers maw-boot with pm2 and saves the dump after enabling linger", async () => {
    const repo = makeRepo();
    const calls: string[][] = [];

    const result = await setupAutoWake(
      { repoRoot: repo, user: "alpha" },
      {
        platform: () => "linux",
        user: () => "alpha",
        cwd: () => repo,
        existsSync: () => true,
        execFileSync: ((cmd: string, args: string[]) => {
          calls.push([cmd, ...args]);
          return "";
        }) as any,
      },
    );

    expect(calls).toEqual([
      ["loginctl", "enable-linger", "alpha"],
      ["pm2", "startup", "systemd", "-u", "alpha", "--hp", "/home/alpha"],
      ["pm2", "start", "ecosystem.config.cjs", "--only", "maw-boot"],
      ["pm2", "save"],
    ]);
    expect(result.steps.map((step) => step.command)).toEqual(calls);
  });

  test("dry-run reports the same commands without executing them", async () => {
    const repo = makeRepo();
    let execCount = 0;

    const result = await setupAutoWake(
      { repoRoot: repo, user: "alpha", dryRun: true },
      {
        platform: () => "linux",
        existsSync: () => true,
        execFileSync: (() => {
          execCount++;
          return "";
        }) as any,
      },
    );

    expect(execCount).toBe(0);
    expect(result.steps.every((step) => step.skipped)).toBe(true);
  });



  test("refuses non-dry-run setup on unsupported service-manager platforms", async () => {
    const repo = makeRepo();

    await expect(
      setupAutoWake(
        { repoRoot: repo, user: "alpha" },
        {
          platform: () => "win32",
          existsSync: () => true,
          execFileSync: (() => "") as any,
        },
      ),
    ).rejects.toThrow("only implemented for Linux/macOS");

    await expect(
      setupAutoWake(
        { repoRoot: repo, user: "alpha" },
        {
          platform: () => "darwin",
          existsSync: () => true,
          execFileSync: (() => "") as any,
        },
      ),
    ).rejects.toThrow("macOS launchd auto-wake setup is not implemented yet");
  });

  test("dry-run renders the macOS home path without executing service-manager commands", async () => {
    const repo = makeRepo();

    const result = await setupAutoWake(
      { repoRoot: repo, user: "alpha", dryRun: true },
      {
        platform: () => "darwin",
        existsSync: () => true,
        execFileSync: (() => {
          throw new Error("dry-run should not execute");
        }) as any,
      },
    );

    expect(result.steps[1].command).toEqual([
      "pm2",
      "startup",
      "systemd",
      "-u",
      "alpha",
      "--hp",
      "/Users/alpha",
    ]);
    expect(result.steps.every((step) => step.skipped)).toBe(true);
  });

  test("refuses to run outside a repo with ecosystem.config.cjs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-auto-wake-missing-"));

    await expect(
      setupAutoWake(
        { repoRoot: dir, user: "alpha" },
        {
          platform: () => "linux",
          existsSync: () => false,
          execFileSync: (() => "") as any,
        },
      ),
    ).rejects.toThrow("ecosystem.config.cjs not found");
  });
});

describe("maw fleet doctor --reboot (#1811)", () => {
  test("passes when Linux linger, pm2 service, pm2 dump, and a recent snapshot are present", () => {
    const checks = checkRebootReadiness({
      platform: () => "linux",
      user: () => "alpha",
      homedir: () => "/home/alpha",
      env: { PM2_HOME: "/tmp/pm2" },
      existsSync: () => true,
      readFileSync: (() => JSON.stringify([{ name: "maw-server" }, { name: "maw-boot" }])) as any,
      execFileSync: ((cmd: string) => cmd === "loginctl" ? "yes\n" : "enabled\n") as any,
      listSnapshots: () => [{
        file: "latest.json",
        timestamp: new Date().toISOString(),
        trigger: "manual",
        sessionCount: 1,
        windowCount: 1,
      }],
    });

    expect(checks.map((check) => [check.name, check.level])).toEqual([
      ["linger", "pass"],
      ["pm2-service", "pass"],
      ["pm2-dump", "pass"],
      ["snapshot", "pass"],
    ]);
  });

  test("also accepts legacy maw pm2 server names", () => {
    const checks = checkRebootReadiness({
      platform: () => "linux",
      user: () => "alpha",
      homedir: () => "/home/alpha",
      env: { PM2_HOME: "/tmp/pm2" },
      existsSync: () => true,
      readFileSync: (() => JSON.stringify([{ name: "maw" }, { name: "maw-boot" }])) as any,
      execFileSync: ((cmd: string) => cmd === "loginctl" ? "yes\n" : "enabled\n") as any,
      listSnapshots: () => [{
        file: "latest.json",
        timestamp: new Date().toISOString(),
        trigger: "manual",
        sessionCount: 1,
        windowCount: 1,
      }],
    });

    expect(checks.find((check) => check.name === "pm2-dump")).toMatchObject({ level: "pass" });
  });

  test("flags a saved pm2 dump that never registered maw-boot", () => {
    const checks = checkRebootReadiness({
      platform: () => "linux",
      user: () => "alpha",
      homedir: () => "/home/alpha",
      env: { PM2_HOME: "/tmp/pm2" },
      existsSync: () => true,
      readFileSync: (() => JSON.stringify([{ name: "maw" }])) as any,
      execFileSync: ((cmd: string) => cmd === "loginctl" ? "yes\n" : "enabled\n") as any,
      listSnapshots: () => [{
        file: "latest.json",
        timestamp: new Date().toISOString(),
        trigger: "manual",
        sessionCount: 1,
        windowCount: 1,
      }],
    });

    expect(checks.find((check) => check.name === "pm2-dump")).toMatchObject({
      level: "fail",
      message: "pm2 dump missing maw-boot",
      fix: "maw setup auto-wake",
    });
  });

  test("flags disabled Linux linger, disabled pm2 service, and unreadable pm2 dumps", () => {
    const checks = checkRebootReadiness({
      platform: () => "linux",
      user: () => "alpha",
      homedir: () => "/home/alpha",
      env: { PM2_HOME: "/tmp/pm2" },
      existsSync: () => true,
      readFileSync: (() => "{not-json") as any,
      execFileSync: ((cmd: string) => cmd === "loginctl" ? "no\n" : "disabled\n") as any,
      listSnapshots: () => [{
        file: "latest.json",
        timestamp: new Date().toISOString(),
        trigger: "manual",
        sessionCount: 1,
        windowCount: 1,
      }],
    });

    expect(checks.find((check) => check.name === "linger")).toMatchObject({
      level: "fail",
      fix: "maw setup auto-wake --user alpha",
      detail: { observed: "no" },
    });
    expect(checks.find((check) => check.name === "pm2-service")).toMatchObject({
      level: "fail",
      fix: "pm2 startup systemd -u alpha --hp /home/alpha",
      detail: { observed: "disabled" },
    });
    expect(checks.find((check) => check.name === "pm2-dump")).toMatchObject({
      level: "fail",
      message: "pm2 dump is unreadable: /tmp/pm2/dump.pm2",
      fix: "pm2 save",
    });
  });

  test("warns when service-manager probes throw and fails when pm2 dump is missing", () => {
    const checks = checkRebootReadiness({
      platform: () => "linux",
      user: () => "alpha",
      homedir: () => "/home/alpha",
      env: { PM2_HOME: "/tmp/pm2" },
      existsSync: () => false,
      readFileSync: (() => "[]") as any,
      execFileSync: (() => {
        throw new Error("service manager missing");
      }) as any,
      listSnapshots: () => [{
        file: "latest.json",
        timestamp: new Date().toISOString(),
        trigger: "manual",
        sessionCount: 1,
        windowCount: 1,
      }],
    });

    expect(checks.find((check) => check.name === "linger")).toMatchObject({
      level: "warn",
      detail: { error: "service manager missing" },
    });
    expect(checks.find((check) => check.name === "pm2-service")).toMatchObject({
      level: "warn",
      detail: { error: "service manager missing" },
    });
    expect(checks.find((check) => check.name === "pm2-dump")).toMatchObject({
      level: "fail",
      message: "pm2 dump not found at /tmp/pm2/dump.pm2",
    });
  });

  test("reports missing server app names and stale or unreadable snapshots", () => {
    const stale = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    let checks = checkRebootReadiness({
      platform: () => "linux",
      user: () => "alpha",
      homedir: () => "/home/alpha",
      env: { PM2_HOME: "/tmp/pm2" },
      existsSync: () => true,
      readFileSync: (() => JSON.stringify([{ name: "maw-boot" }])) as any,
      execFileSync: ((cmd: string) => cmd === "loginctl" ? "yes\n" : "enabled\n") as any,
      listSnapshots: () => [{
        file: "old.json",
        timestamp: stale,
        trigger: "manual",
        sessionCount: 1,
        windowCount: 1,
      }],
    });

    expect(checks.find((check) => check.name === "pm2-dump")).toMatchObject({
      level: "fail",
      message: "pm2 dump missing maw or maw-server",
      detail: { missing: ["maw or maw-server"] },
    });
    expect(checks.find((check) => check.name === "snapshot")).toMatchObject({
      level: "warn",
      fix: "maw fleet snapshot manual",
      detail: { timestamp: stale },
    });

    checks = checkRebootReadiness({
      platform: () => "linux",
      user: () => "alpha",
      homedir: () => "/home/alpha",
      env: { PM2_HOME: "/tmp/pm2" },
      existsSync: () => true,
      readFileSync: (() => JSON.stringify([{ name: "maw" }, { name: "maw-boot" }])) as any,
      execFileSync: ((cmd: string) => cmd === "loginctl" ? "yes\n" : "enabled\n") as any,
      listSnapshots: () => {
        throw new Error("snapshot dir unreadable");
      },
    });

    expect(checks.find((check) => check.name === "snapshot")).toMatchObject({
      level: "fail",
      message: "could not inspect fleet snapshots",
      detail: { error: "snapshot dir unreadable" },
    });
  });

  test("checks macOS launchd and warns on unknown service-manager platforms", () => {
    let checks = checkRebootReadiness({
      platform: () => "darwin",
      user: () => "alpha",
      homedir: () => "/Users/alpha",
      env: {},
      existsSync: (path: string) => path.endsWith("com.maw.boot.plist"),
      readFileSync: (() => "") as any,
      execFileSync: (() => "") as any,
      listSnapshots: () => [{
        file: "latest.json",
        timestamp: new Date().toISOString(),
        trigger: "manual",
        sessionCount: 1,
        windowCount: 1,
      }],
    });

    expect(checks.find((check) => check.name === "launchd")).toMatchObject({
      level: "pass",
      detail: { plist: "/Users/alpha/Library/LaunchAgents/com.maw.boot.plist" },
    });

    checks = checkRebootReadiness({
      platform: () => "darwin",
      user: () => "alpha",
      homedir: () => "/Users/alpha",
      env: {},
      existsSync: () => false,
      readFileSync: (() => "") as any,
      execFileSync: (() => "") as any,
      listSnapshots: () => [{
        file: "latest.json",
        timestamp: new Date().toISOString(),
        trigger: "manual",
        sessionCount: 1,
        windowCount: 1,
      }],
    });

    expect(checks.find((check) => check.name === "launchd")).toMatchObject({
      level: "fail",
      fix: "macOS auto-wake setup is not implemented yet",
    });

    checks = checkRebootReadiness({
      platform: () => "freebsd" as NodeJS.Platform,
      user: () => "alpha",
      homedir: () => "/home/alpha",
      env: {},
      existsSync: () => false,
      readFileSync: (() => "") as any,
      execFileSync: (() => "") as any,
      listSnapshots: () => [{
        file: "latest.json",
        timestamp: new Date().toISOString(),
        trigger: "manual",
        sessionCount: 1,
        windowCount: 1,
      }],
    });

    expect(checks.find((check) => check.name === "service-manager")).toMatchObject({
      level: "warn",
      message: "reboot doctor does not know how to inspect freebsd",
    });
  });

  test("flags missing snapshots because restore has nothing to wake", () => {
    const checks = checkRebootReadiness({
      platform: () => "linux",
      user: () => "alpha",
      homedir: () => "/home/alpha",
      env: { PM2_HOME: "/tmp/pm2" },
      existsSync: () => true,
      readFileSync: (() => JSON.stringify([{ name: "maw" }, { name: "maw-boot" }])) as any,
      execFileSync: ((cmd: string) => cmd === "loginctl" ? "yes\n" : "enabled\n") as any,
      listSnapshots: () => [],
    });

    expect(checks.find((check) => check.name === "snapshot")).toMatchObject({
      level: "fail",
      fix: "maw fleet snapshot manual",
    });
  });
});


describe("maw setup plugin handler (#1811)", () => {
  test("prints setup usage for help and missing subcommand", async () => {
    const help = await setupHandler({ source: "cli", args: ["--help"] } as any);
    const missing = await setupHandler({ source: "cli", args: [] } as any);

    expect(help).toMatchObject({ ok: true });
    expect(help.output).toContain("maw setup auto-wake [--dry-run]");
    expect(missing.output).toBe(help.output);
  });

  test("rejects unknown setup subcommands with usage", async () => {
    const result = await setupHandler({ source: "cli", args: ["bogus"] } as any);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("unknown setup subcommand: bogus");
    expect(result.error).toContain("maw setup auto-wake");
  });

  test("formats dry-run auto-wake commands", async () => {
    const repo = makeRepo();
    const result = await setupHandler({
      source: "cli",
      args: ["auto-wake", "--dry-run", "--user", "alpha", "--repo", repo],
    } as any);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("maw setup auto-wake");
    expect(result.output).toContain("dry-run loginctl enable-linger alpha");
    expect(result.output).toContain("dry-run pm2 start ecosystem.config.cjs --only maw-boot");
    expect(result.output).toContain("next reboot will restore fleet from the latest snapshot");
  });

  test("returns setup errors from auto-wake", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maw-setup-handler-missing-"));
    const result = await setupHandler({
      source: "cli",
      args: ["auto-wake", "--dry-run", "--repo", dir],
    } as any);

    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain("ecosystem.config.cjs not found");
  });
});
