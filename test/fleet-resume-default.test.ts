/**
 * fleet-resume.ts — default-suite coverage for reboot recap + worktree respawn helpers.
 */
import { describe, expect, test } from "bun:test";
import { fleetResumeDeps, respawnMissingWorktrees, resumeActiveItems, type FleetResumeDeps } from "../src/commands/shared/fleet-resume";
import type { FleetSession } from "../src/commands/shared/fleet-load";

const issue = (number: number, title: string, labels: string[] = []) => ({
  number,
  title,
  labels: labels.map(name => ({ name })),
});

function makeDeps(options: {
  sshResponses?: string[];
  sshThrowsOn?: (cmd: string, index: number) => boolean;
  sessions?: Array<{ name: string }>;
  windows?: Record<string, Array<{ name: string }>>;
  windowThrows?: Set<string>;
  newWindowThrows?: Set<string>;
  ghqRoot?: string;
} = {}) {
  const logs: string[] = [];
  const sshCommands: string[] = [];
  const sentText: Array<{ target: string; text: string }> = [];
  const newWindows: Array<{ session: string; name: string; cwd?: string }> = [];
  const pins: string[] = [];
  const sleeps: number[] = [];
  const responses = [...(options.sshResponses ?? [])];

  const deps = fleetResumeDeps({
    ssh: async (cmd: string) => {
      const index = sshCommands.length;
      sshCommands.push(cmd);
      if (options.sshThrowsOn?.(cmd, index)) throw new Error(`ssh boom ${index}`);
      return responses.shift() ?? "";
    },
    tmux: {
      listSessions: async () => options.sessions ?? [],
      listWindows: async (session: string) => {
        if (options.windowThrows?.has(session)) throw new Error(`window boom ${session}`);
        return (options.windows?.[session] ?? []).map((w, index) => ({ index, active: index === 0, ...w }));
      },
      sendText: async (target: string, text: string) => { sentText.push({ target, text }); },
      newWindow: async (session: string, name: string, opts: { cwd?: string }) => {
        if (options.newWindowThrows?.has(`${session}:${name}`)) throw new Error(`new window boom ${name}`);
        newWindows.push({ session, name, cwd: opts.cwd });
      },
    },
    buildCommand: (name: string) => `run-${name}`,
    getGhqRoot: () => options.ghqRoot ?? "/ghq",
    pinWindowWide: async (target: string) => { pins.push(target); },
    sleep: async (ms: number) => { sleeps.push(ms); },
    log: (...args: unknown[]) => { logs.push(args.map(String).join(" ")); },
  } satisfies Partial<FleetResumeDeps>);

  return { deps, logs, sshCommands, sentText, newWindows, pins, sleeps };
}

describe("fleetResumeDeps", () => {
  test("exposes production defaults with requested overrides", async () => {
    const ssh = async () => "[]";
    const originalLog = console.log;
    const seen: string[] = [];
    console.log = (line?: unknown) => { seen.push(String(line ?? "")); };
    const deps = fleetResumeDeps({ ssh });

    try {
      await deps.sleep(0);
      deps.log("fleet-resume-default");
    } finally {
      console.log = originalLog;
    }

    expect(seen).toEqual(["fleet-resume-default"]);
    expect(deps.ssh).toBe(ssh);
    expect(typeof deps.tmux.listSessions).toBe("function");
    expect(typeof deps.tmux.listWindows).toBe("function");
    expect(typeof deps.tmux.sendText).toBe("function");
    expect(typeof deps.tmux.newWindow).toBe("function");
    expect(typeof deps.buildCommand).toBe("function");
    expect(typeof deps.getGhqRoot).toBe("function");
    expect(typeof deps.pinWindowWide).toBe("function");
    expect(typeof deps.sleep).toBe("function");
    expect(typeof deps.log).toBe("function");
  });
});

describe("resumeActiveItems", () => {
  test("reports when the Pulse board has no oracle-assigned active items", async () => {
    const h = makeDeps({
      sshResponses: [JSON.stringify([
        issue(1, "Daily", ["daily-thread"]),
        issue(2, "Unassigned task"),
      ])],
    });

    await resumeActiveItems(h.deps);

    expect(h.sshCommands[0]).toContain("gh issue list --repo laris-co/pulse-oracle");
    expect(h.sentText).toEqual([]);
    expect(h.logs.join("\n")).toContain("No active board items to resume");
  });

  test("sends one recap per oracle, grouping active item numbers and ignoring session scan misses", async () => {
    const h = makeDeps({
      sshResponses: [JSON.stringify([
        issue(1, "Daily", ["daily-thread"]),
        issue(2, "Fix route", ["oracle:mawjs"]),
        issue(3, "Fix coverage", ["oracle:mawjs"]),
        issue(4, "File issue", ["oracle:issuer"]),
        issue(5, "Needs triage"),
      ])],
      sessions: [{ name: "broken" }, { name: "54-mawjs" }],
      windowThrows: new Set(["broken"]),
      windows: {
        "54-mawjs": [{ name: "mawjs-oracle" }, { name: "Issuer-Oracle" }],
      },
    });

    await resumeActiveItems(h.deps);

    expect(h.sleeps).toEqual([2000, 2000]);
    expect(h.sentText).toEqual([
      { target: "54-mawjs:mawjs-oracle", text: "/recap --deep — Resume after reboot. Active items: #2, #3" },
      { target: "54-mawjs:Issuer-Oracle", text: "/recap --deep — Resume after reboot. Active items: #4" },
    ]);
    expect(h.logs.join("\n")).toContain("mawjs: /recap sent (#2, #3)");
    expect(h.logs.join("\n")).toContain("issuer: /recap sent (#4)");
  });

  test("fails soft when Pulse issue lookup fails", async () => {
    const h = makeDeps({ sshThrowsOn: () => true });

    await resumeActiveItems(h.deps);

    expect(h.sentText).toEqual([]);
    expect(h.logs.join("\n")).toContain("resume skipped:");
  });
});

describe("respawnMissingWorktrees", () => {
  const mainSession: FleetSession = {
    name: "54-mawjs",
    windows: [
      { name: "mawjs-oracle", repo: "Soul-Brews-Studio/maw-js" },
      { name: "mawjs-existing", repo: "Soul-Brews-Studio/maw-js" },
      { name: "mawjs-5-alias", repo: "Soul-Brews-Studio/maw-js" },
      { name: "helper", repo: "Soul-Brews-Studio/other" },
    ],
  };

  test("spawns missing worktrees, pins them, sends launch commands, and skips covered names", async () => {
    const h = makeDeps({
      sshResponses: [
        [
          "/ghq/github.com/Soul-Brews-Studio/maw-js.wt-1-existing",
          "/ghq/github.com/Soul-Brews-Studio/maw-js.wt-2-new-task",
          "/ghq/github.com/Soul-Brews-Studio/maw-js.wt-3-new-task",
          "/ghq/github.com/Soul-Brews-Studio/maw-js.wt-4-running",
          "/ghq/github.com/Soul-Brews-Studio/maw-js.wt-5-alias",
          "/ghq/github.com/Soul-Brews-Studio/maw-js.wt-6-fail",
        ].join("\n"),
      ],
      windows: { "54-mawjs": [{ name: "mawjs-oracle" }, { name: "mawjs-existing" }, { name: "mawjs-running" }] },
      newWindowThrows: new Set(["54-mawjs:mawjs-fail"]),
    });

    const spawned = await respawnMissingWorktrees([mainSession], h.deps);

    expect(spawned).toBe(2);
    expect(h.sshCommands[0]).toBe("ls -d /ghq/github.com/Soul-Brews-Studio/maw-js.wt-* 2>/dev/null || true");
    expect(h.newWindows).toEqual([
      { session: "54-mawjs", name: "mawjs-new-task", cwd: "/ghq/github.com/Soul-Brews-Studio/maw-js.wt-2-new-task" },
      { session: "54-mawjs", name: "mawjs-3-new-task", cwd: "/ghq/github.com/Soul-Brews-Studio/maw-js.wt-3-new-task" },
    ]);
    expect(h.pins).toEqual(["54-mawjs:mawjs-new-task", "54-mawjs:mawjs-3-new-task"]);
    expect(h.sleeps).toEqual([300, 300]);
    expect(h.sentText).toEqual([
      { target: "54-mawjs:mawjs-new-task", text: "run-mawjs-new-task" },
      { target: "54-mawjs:mawjs-3-new-task", text: "run-mawjs-3-new-task" },
    ]);
    expect(h.logs.join("\n")).toContain("mawjs-new-task (discovered on disk)");
  });

  test("skips disabled sessions and fails soft on worktree scans or tmux window listing", async () => {
    const skipped: FleetSession = { name: "skip", skip_command: true, windows: [{ name: "skip-oracle", repo: "Org/skip" }] };
    const scanFails: FleetSession = { name: "scan-fails", windows: [{ name: "scan-oracle", repo: "Org/scan" }] };
    const windowsFail: FleetSession = { name: "windows-fail", windows: [{ name: "win-oracle", repo: "Org/win" }] };
    const h = makeDeps({
      sshResponses: ["/ghq/github.com/Org/scan.wt-1-a", "/ghq/github.com/Org/win.wt-1-b"],
      sshThrowsOn: (cmd) => cmd.includes("/Org/scan.wt-"),
      windowThrows: new Set(["windows-fail"]),
    });

    const spawned = await respawnMissingWorktrees([skipped, scanFails, windowsFail], h.deps);

    expect(spawned).toBe(0);
    expect(h.newWindows).toEqual([]);
    expect(h.sentText).toEqual([]);
  });
});
