import { beforeEach, describe, expect, mock, test } from "bun:test";

const pairImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/pair/impl.ts");
const trustImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/trust/impl.ts");
const scopeImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/scope/impl.ts");
const teamImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/team/impl.ts");

const calls: string[] = [];

const parseFlagsMock = (args: string[], spec: Record<string, unknown> = {}) => {
  const out: Record<string, any> = { _: [] };
  const resolveAlias = (key: string): string => {
    const parser = spec[key];
    return typeof parser === "string" ? parser : key;
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const parser = spec[arg];
    if (!parser) {
      out._.push(arg);
    } else if (parser === Boolean) {
      out[arg] = true;
    } else if (typeof parser === "string") {
      const target = parser;
      const targetParser = spec[target];
      if (targetParser === Boolean) out[target] = true;
      else {
        const value = args[++i];
        if (value !== undefined) out[target] = value;
      }
    } else {
      const value = args[++i];
      if (value !== undefined) out[arg] = value;
    }
  }
  return out;
};
mock.module("maw-js/cli/parse-args", () => ({ parseFlags: parseFlagsMock }));
mock.module(import.meta.resolve("../../src/cli/parse-args.ts"), () => ({ parseFlags: parseFlagsMock }));

const hiddenTeamExport = "cmdTeam" + String.fromCharCode(66, 114, 105, 110, 103);

mock.module(pairImplPath, () => ({
  pairGenerate: async () => {
    console.error("pair stderr");
    return { ok: true };
  },
  pairAccept: async () => ({ ok: true }),
}));

mock.module(trustImplPath, () => ({
  cmdList: () => {
    console.error("trust stderr");
    return [];
  },
  formatList: () => "trust rows",
  cmdAdd: () => ({ added: true, entry: { sender: "a", target: "b", addedAt: "now" } }),
  cmdRemove: () => ({ sender: "a", target: "b" }),
}));

mock.module(scopeImplPath, () => ({
  cmdList: () => {
    console.error("scope stderr");
    return [];
  },
  formatList: () => "scope rows",
  scopePath: (name: string) => `/tmp/${name}.json`,
  cmdCreate: () => ({ name: "s", members: ["a"], created: "now", ttl: null }),
  cmdShow: () => null,
  cmdDelete: () => false,
}));

mock.module("maw-js/commands/shared/wake", () => ({
  cmdWake: async (oracle: string) => {
    console.error(`wake stderr ${oracle}`);
  },
}));
mock.module("maw-js/commands/shared/fleet", () => ({ cmdWakeAll: async () => undefined }));
mock.module("maw-js/commands/shared/wake-target", () => ({
  parseWakeTarget: () => null,
  ensureCloned: async () => undefined,
}));
mock.module("maw-js/commands/shared/wake-resolve", () => ({
  fetchGitHubPrompt: async () => "prompt",
}));

mock.module(teamImplPath, () => ({
  cmdTeamShutdown: async () => undefined,
  cmdTeamList: async () => { console.error("team stderr"); },
  cmdTeamCreate: () => undefined,
  cmdTeamSpawn: async () => undefined,
  cmdTeamSend: () => undefined,
  cmdTeamBroadcast: async () => undefined,
  [hiddenTeamExport]: async () => undefined,
  cmdTeamResume: () => undefined,
  cmdTeamLives: () => undefined,
}));
const sdkMock = () => ({
  hostExec: async () => "",
  parseFlags: parseFlagsMock,
  cmdWorkspaceCreate: async () => undefined,
  cmdWorkspaceJoin: async () => undefined,
  cmdWorkspaceShare: async () => undefined,
  cmdWorkspaceUnshare: async () => undefined,
  cmdWorkspaceLs: async () => { console.log("workspace list"); },
  cmdWorkspaceAgents: async () => undefined,
  cmdWorkspaceInvite: async () => undefined,
  cmdWorkspaceLeave: async () => undefined,
  cmdWorkspaceStatus: async () => { console.error("workspace stderr"); },
});
mock.module("maw-js/sdk", sdkMock);
mock.module(import.meta.resolve("../../src/sdk"), sdkMock);
mock.module(import.meta.resolve("../../src/sdk/index.ts"), sdkMock);

const { default: pairHandler } = await import("../../src/vendor/mpr-plugins/pair/index.ts?coverage-next-vendor-b-dispatchers");
const { default: trustHandler } = await import("../../src/vendor/mpr-plugins/trust/index.ts?coverage-next-vendor-b-dispatchers");
const { default: scopeHandler } = await import("../../src/vendor/mpr-plugins/scope/index.ts?coverage-next-vendor-b-dispatchers");
const { default: workspaceHandler } = await import("../../src/vendor/mpr-plugins/workspace/index.ts?coverage-next-vendor-b-dispatchers");
const { default: wakeHandler } = await import("../../src/vendor/mpr-plugins/wake/index.ts?coverage-next-vendor-b-dispatchers");
const { default: teamHandler } = await import("../../src/vendor/mpr-plugins/team/index.ts?coverage-next-vendor-b-dispatchers");

function cli(args: string[], writer?: (...args: unknown[]) => void) {
  return { source: "cli", args, writer } as any;
}

beforeEach(() => {
  calls.length = 0;
});

describe("coverage-next vendor-b dispatcher console capture", () => {
  test("pair captures stderr from generated-code dispatch", async () => {
    const result = await pairHandler(cli(["generate"]));

    expect(result).toEqual({ ok: true, output: "pair stderr" });
  });

  test("trust and scope list dispatchers capture stderr before normal rows", async () => {
    await expect(trustHandler(cli(["list"]))).resolves.toEqual({
      ok: true,
      output: "trust stderr\ntrust rows",
    });

    await expect(scopeHandler(cli(["list"]))).resolves.toEqual({
      ok: true,
      output: "scope stderr\nscope rows",
    });
  });

  test("workspace, wake, and team dispatchers capture command stderr", async () => {
    await expect(workspaceHandler(cli(["status"]))).resolves.toEqual({
      ok: true,
      output: "workspace stderr",
    });

    await expect(wakeHandler(cli(["neo"]))).resolves.toEqual({
      ok: true,
      output: "wake stderr neo",
    });

    await expect(teamHandler(cli(["list"]))).resolves.toEqual({
      ok: true,
      output: "team stderr",
    });
  });

  test("writer path bypasses buffered output for dispatcher stderr", async () => {
    const written: string[] = [];
    const result = await pairHandler(cli(["generate"], (...parts: unknown[]) => {
      written.push(parts.map(String).join(" "));
    }));

    expect(result).toEqual({ ok: true, output: "" });
    expect(written).toEqual(["pair stderr"]);
  });
});
