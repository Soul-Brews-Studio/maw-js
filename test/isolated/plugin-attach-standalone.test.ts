import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");

type Session = { name: string; windows: Array<{ name: string; repo?: string; index?: number }> };

let sessions: Session[] = [];
let fleet: Session[] = [];
const attached: string[] = [];

function simpleParseFlags(args: string[], spec: Record<string, unknown>) {
  const out: Record<string, any> & { _: string[] } = { _: [] };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const parser = spec[arg];
    if (!parser) {
      out._.push(arg);
    } else if (typeof parser === "string") {
      out[parser] = true;
    } else if (parser === Boolean) {
      out[arg] = true;
    } else if (parser === String || parser === Number) {
      out[arg] = args[++i];
    }
  }
  return out;
}

function nameMatches(name: string, target: string) {
  const n = name.toLowerCase().replace(/^\d+-/, "").replace(/-oracle$/, "");
  const t = target.toLowerCase().replace(/^\d+-/, "").replace(/-oracle$/, "");
  return n === t || name.toLowerCase() === target.toLowerCase() || name.toLowerCase().endsWith(`-${t}`);
}

const sdkMock = {
  parseFlags: simpleParseFlags,
  getGhqRoot: () => "/ghq/github.com",
  listSessions: async () => sessions,
  loadFleetCore: () => fleet,
  hostExec: async () => "",
  UserError: class UserError extends Error { readonly isUserError = true; },
  isInfrastructureChannelSessionName: (sessionName: string) => sessionName === "0-overview" || sessionName.includes("channel"),
  resolveFleetWindowSessionTarget: (target: string, rows: Session[]) => {
    const matches = rows.filter((row) =>
      row.windows.some((window) => window.name === target || window.repo?.endsWith(`/${target}-oracle`)),
    );
    if (matches.length === 1) return { kind: "fuzzy", match: matches[0] };
    if (matches.length > 1) return { kind: "ambiguous", candidates: matches };
    return { kind: "none", hints: [] };
  },
};

mock.module("maw-js/sdk", () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk"), () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));
mock.module(new URL("../../src/sdk/index.ts", import.meta.url).pathname, () => ({ ...realSdk, ...sdkMock }));

mock.module(import.meta.resolve("../../src/commands/plugins/tmux/impl.ts"), () => ({
  cmdTmuxAttach: (target: string) => attached.push(target),
}));
mock.module(import.meta.resolve("../../src/commands/plugins/tmux/safety.ts"), () => ({
  isClaudeLikePane: (command?: string) => command === "claude" || command === "codex",
}));
mock.module(import.meta.resolve("../../src/vendor/mpr-plugins/ls/internal/peer-resolve.ts"), () => ({
  resolvePeer: (alias: string) => alias === "remote" ? { alias, node: alias, url: "https://remote.invalid", sshAlias: "remote-ssh" } : null,
  resolveAllPeers: () => [],
}));

const { default: attachHandler } = await import("../../src/vendor/mpr-plugins/attach/index.ts?plugin-attach-standalone");
const attachImpl = await import("../../src/vendor/mpr-plugins/attach/impl.ts?plugin-attach-standalone");
const resolver = await import("../../src/vendor/mpr-plugins/attach/resolve-attach-target.ts?plugin-attach-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  sessions = [];
  fleet = [];
  attached.length = 0;
});

describe("attach plugin standalone boundary (#2313)", () => {
  test("uses SDK for former core/shared/config dependencies", () => {
    for (const rel of [
      "src/vendor/mpr-plugins/attach/index.ts",
      "src/vendor/mpr-plugins/attach/impl.ts",
      "src/vendor/mpr-plugins/attach/resolve-attach-target.ts",
    ]) {
      const source = readFileSync(join(root, rel), "utf8");
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|config|cli)(?:\/|")/);
      expect(source).not.toMatch(/from\s+["']\.\.\/\.\.\/\.\.\/(?:core|commands\/shared|sdk|config|cli)/);
    }

    expect(readFileSync(join(root, "src/vendor/mpr-plugins/attach/impl.ts"), "utf8")).toContain('from "maw-js/sdk"');
    expect(readFileSync(join(root, "src/vendor/mpr-plugins/attach/resolve-attach-target.ts"), "utf8")).toContain('from "maw-js/sdk"');
    expect(readFileSync(join(root, "src/sdk/index.ts"), "utf8")).toContain("resolveFleetWindowSessionTarget");
    expect(readFileSync(join(root, "src/sdk/index.ts"), "utf8")).toContain("isInfrastructureChannelSessionName");
  });

  test("resolver returns live, sleeping, remote, and invalid remote tiers", async () => {
    sessions = [{ name: "01-mawjs", windows: [{ name: "mawjs-oracle", repo: "Soul-Brews-Studio/mawjs-oracle" }] }];
    fleet = [{ name: "02-sleepy", windows: [{ name: "sleepy", repo: "Soul/sleepy-oracle" }] }];
    const deps = { listSessions: async () => sessions, loadFleet: () => fleet };

    await expect(resolver.resolveAttachTarget("mawjs", deps as any, { preferOracleWindow: true })).resolves.toEqual({
      tier: 1,
      sessionName: "01-mawjs",
      windowName: "mawjs-oracle",
    });
    await expect(resolver.resolveAttachTarget("sleepy", deps as any)).resolves.toEqual({ tier: 2, fleetName: "02-sleepy" });
    await expect(resolver.resolveAttachTarget("remote:neo", deps as any)).resolves.toMatchObject({
      tier: 3,
      node: "remote",
      sessionName: "neo",
      sshAlias: "remote-ssh",
    });
    await expect(resolver.resolveAttachTarget("remote:", deps as any)).resolves.toMatchObject({
      tier: "error",
      error: "invalid remote attach target 'remote:'",
    });
  });

  test("handler parses CLI/API dry-run paths without touching tmux attach", async () => {
    sessions = [{ name: "01-mawjs", windows: [{ name: "mawjs-oracle" }] }];

    const cli = await attachHandler({ source: "cli", args: ["mawjs", "--dry-run"] } as any);
    expect(cli.ok).toBe(true);
    expect(stripAnsi(cli.output)).toContain("[dry-run] Tier 1 (live) — would attach to 01-mawjs:mawjs-oracle");

    const api = await attachHandler({ source: "api", args: { name: "mawjs", dryRun: true } } as any);
    expect(api.ok).toBe(true);
    expect(stripAnsi(api.output)).toContain("would attach to 01-mawjs:mawjs-oracle");
    expect(attached).toEqual([]);
  });

  test("handler validates missing names and flag-looking targets", async () => {
    await expect(attachHandler({ source: "cli", args: [] } as any)).resolves.toEqual({
      ok: false,
      error: "usage: maw attach <name> [--shell [--split|--no-split]] [--dry-run] [-y|--yes]",
    });
    await expect(attachHandler({ source: "api", args: {} } as any)).resolves.toEqual({ ok: false, error: "name required" });
    await expect(attachHandler({ source: "cli", args: ["--bogus"] } as any)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("looks like a flag"),
    });
  });

  test("buildAttachShellPlan resolves fleet repo and workspace cwd fallbacks", () => {
    const repoPlan = attachImpl.buildAttachShellPlan("mawjs", "01-mawjs", [
      { name: "01-mawjs", windows: [{ name: "mawjs", repo: "Soul-Brews-Studio/mawjs-oracle" }] },
    ]);
    expect(repoPlan).toMatchObject({
      sessionName: "01-mawjs",
      targetWindow: "01-mawjs:mawjs",
      windowName: "mawjs-shell",
      cwd: "/ghq/github.com/Soul-Brews-Studio/mawjs-oracle",
    });
    expect(repoPlan.command).toContain("cd '/ghq/github.com/Soul-Brews-Studio/mawjs-oracle'");

    const workspacePlan = attachImpl.buildAttachShellPlan("scratch", "scratch", [], {
      readSessionOption: () => "/tmp/scratch space",
    });
    expect(workspacePlan.cwd).toBe("/tmp/scratch space");
    expect(workspacePlan.command).toContain("cd '/tmp/scratch space'");

    expect(() => attachImpl.buildAttachShellPlan("missing", "missing", [])).toThrow("cannot resolve repo path");
  });
});
