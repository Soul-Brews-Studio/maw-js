import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
type ChannelConfig = { plugins: Array<{ id: string; env?: Record<string, string> }>; token_source?: string; permissionMode?: string };

const globalConfigs = new Map<string, ChannelConfig>();
const repoConfigs = new Map<string, ChannelConfig>();
const savedGlobals: Array<{ oracle: string; config: ChannelConfig }> = [];
const savedRepos: Array<{ repo: string; config: ChannelConfig }> = [];
let ghqHits: Record<string, string | null> = {};

const sdkMock = {
  loadOracleChannels: (oracle: string) => globalConfigs.get(oracle) ?? null,
  saveOracleChannels: (oracle: string, config: ChannelConfig) => {
    globalConfigs.set(oracle, structuredClone(config));
    savedGlobals.push({ oracle, config: structuredClone(config) });
  },
  listAllOracleChannels: () => [...globalConfigs.entries()].map(([oracle, config]) => ({ oracle, plugins: config.plugins })),
  loadRepoChannels: (repo: string) => repoConfigs.get(repo) ?? null,
  saveRepoChannels: (repo: string, config: ChannelConfig) => {
    repoConfigs.set(repo, structuredClone(config));
    savedRepos.push({ repo, config: structuredClone(config) });
  },
  getChannelEnv: () => ({}),
  ghqFind: async (suffix: string) => ghqHits[suffix] ?? null,
};

mock.module(import.meta.resolve("../../src/sdk"), () => ({ ...realSdk, ...sdkMock }));
mock.module(import.meta.resolve("../../src/sdk/index.ts"), () => ({ ...realSdk, ...sdkMock }));
mock.module(new URL("../../src/sdk/index.ts", import.meta.url).pathname, () => ({ ...realSdk, ...sdkMock }));

const { default: channelHandler } = await import("../../src/commands/plugins/channel/index.ts?plugin-channel-standalone");

function stripAnsi(value: string | undefined) {
  return String(value ?? "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

beforeEach(() => {
  globalConfigs.clear();
  repoConfigs.clear();
  savedGlobals.length = 0;
  savedRepos.length = 0;
  ghqHits = {};
});

describe("channel command plugin standalone boundary (#2288)", () => {
  test("uses SDK boundary and no direct core/shared/lib imports", () => {
    for (const rel of [
      "src/commands/plugins/channel/index.ts",
      "src/commands/plugins/channel/setup.ts",
    ]) {
      const source = readFileSync(join(root, rel), "utf8");
      expect(source).not.toMatch(/\.\.\/\.\.\/\.\.\/(?:core|commands\/shared|lib)(?:\/|")/);
      expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib|config)(?:\/|")/);
    }

    const index = readFileSync(join(root, "src/commands/plugins/channel/index.ts"), "utf8");
    expect(index).toContain('from "../../../sdk"');
    expect(index).not.toContain('import("../../../core/ghq")');
  });

  test("lists all channels, target channels, and json output from SDK storage", async () => {
    globalConfigs.set("mawjs", {
      plugins: [{ id: "plugin:discord@claude-plugins-official", env: { DISCORD_STATE_DIR: "~/.claude/channels/mawjs" } }],
      token_source: "pass:discord/mawjs-token",
      permissionMode: "acceptEdits",
    });

    const all = await channelHandler({ source: "cli", args: ["ls", "--verbose"] } as any);
    expect(all.ok).toBe(true);
    expect(stripAnsi(all.output)).toContain("mawjs");
    expect(stripAnsi(all.output)).toContain("plugin:discord@claude-plugins-official");
    expect(stripAnsi(all.output)).toContain("permissionMode: acceptEdits");
    expect(stripAnsi(all.output)).toContain("token: pass:discord/mawjs-token");

    const target = await channelHandler({ source: "cli", args: ["ls", "mawjs", "--json"] } as any);
    expect(target.ok).toBe(true);
    expect(JSON.parse(target.output!)).toEqual({
      oracle: "mawjs",
      plugins: [{ id: "plugin:discord@claude-plugins-official", env: { DISCORD_STATE_DIR: "~/.claude/channels/mawjs" } }],
      token_source: "pass:discord/mawjs-token",
      permissionMode: "acceptEdits",
    });
  });

  test("adds shorthand discord globally with env, pass token, and duplicate guard", async () => {
    const added = await channelHandler({
      source: "cli",
      args: ["add", "mawjs", "discord", "--env", "EXTRA=a=b", "--pass", "discord/mawjs-token"],
    } as any);

    expect(added.ok).toBe(true);
    expect(savedGlobals).toHaveLength(1);
    expect(savedGlobals[0]).toEqual({
      oracle: "mawjs",
      config: {
        plugins: [{
          id: "plugin:discord@claude-plugins-official",
          env: { DISCORD_STATE_DIR: "~/.claude/channels/mawjs", EXTRA: "a=b" },
        }],
        token_source: "pass:discord/mawjs-token",
      },
    });
    expect(stripAnsi(added.output)).toContain("channel added: mawjs → plugin:discord@claude-plugins-official");

    const duplicate = await channelHandler({ source: "cli", args: ["add", "mawjs", "discord"] } as any);
    expect(duplicate.ok).toBe(true);
    expect(savedGlobals).toHaveLength(1);
    expect(stripAnsi(duplicate.output)).toContain("already registered for mawjs");
  });

  test("adds repo-local channel config and removes global channel entries", async () => {
    const repo = join(root, "fixtures", "mawjs-oracle");
    const added = await channelHandler({ source: "cli", args: ["add", "mawjs", "discord", "--repo", repo] } as any);

    expect(added.ok).toBe(true);
    expect(savedRepos).toEqual([{ repo, config: { plugins: [{ id: "plugin:discord@claude-plugins-official", env: { DISCORD_STATE_DIR: ".claude/channel-state" } }] } }]);
    expect(savedGlobals).toEqual([]);
    expect(stripAnsi(added.output)).toContain(`repo mode — wrote ${repo}/.claude/channel.json`);

    globalConfigs.set("mawjs", { plugins: [{ id: "plugin:discord@claude-plugins-official" }, { id: "server:relay" }] });
    const removedOne = await channelHandler({ source: "cli", args: ["rm", "mawjs", "discord"] } as any);
    expect(removedOne.ok).toBe(true);
    expect(globalConfigs.get("mawjs")!.plugins).toEqual([{ id: "server:relay" }]);

    const removedAll = await channelHandler({ source: "cli", args: ["rm", "mawjs"] } as any);
    expect(removedAll.ok).toBe(true);
    expect(globalConfigs.get("mawjs")!.plugins).toEqual([]);
  });

  test("migrates global config to repo via SDK ghqFind in dry-run and write modes", async () => {
    globalConfigs.set("mawjs", { plugins: [{ id: "server:relay" }] });
    ghqHits = { "/mawjs": "/tmp/mawjs-oracle" };

    const dry = await channelHandler({ source: "cli", args: ["migrate", "--to-repo", "mawjs", "--dry-run"] } as any);
    expect(dry.ok).toBe(true);
    expect(stripAnsi(dry.output)).toContain("DRY-RUN mawjs: would write /tmp/mawjs-oracle/.claude/channel.json");
    expect(savedRepos).toEqual([]);

    const migrated = await channelHandler({ source: "cli", args: ["migrate", "--to-repo", "mawjs"] } as any);
    expect(migrated.ok).toBe(true);
    expect(savedRepos).toEqual([{ repo: "/tmp/mawjs-oracle", config: { plugins: [{ id: "server:relay" }] } }]);
    expect(stripAnsi(migrated.output)).toContain("1 migrated, 0 skipped, 0 failed");
  });
});
