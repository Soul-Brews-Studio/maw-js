import { describe, expect, test } from "bun:test";
import { cmdDone, type DoneDeps } from "../src/commands/shared/done";

type WindowInfo = { index: number; name: string; active: boolean };

function depsFor(options: {
  current?: string;
  kills?: string[];
  errors?: string[];
} = {}): DoneDeps {
  const kills = options.kills ?? [];
  const errors = options.errors ?? [];
  return {
    listSessions: async () => [
      {
        name: "mawjs",
        windows: [
          { index: 0, name: "mawjs-oracle", active: false },
          { index: 1, name: "codex-pr", active: true },
        ] satisfies WindowInfo[],
      },
    ],
    ghqRoot: "/repos",
    fleetDir: "/fleet",
    fs: {
      readdirSync: () => [],
      mkdirSync: () => undefined,
      appendFileSync: () => undefined,
      readFileSync: () => "",
      writeFileSync: () => undefined,
    },
    hostExec: async (command) => {
      if (command.startsWith("find ")) return "";
      throw new Error(`unexpected host command: ${command}`);
    },
    tmux: {
      run: async () => {
        if (options.current === undefined) throw new Error("not in tmux");
        return options.current;
      },
      killWindow: async (target) => {
        kills.push(target);
      },
      sendText: async () => undefined,
    },
    takeSnapshot: async () => undefined,
    logger: {
      log: () => undefined,
      error: (...args) => errors.push(args.map(String).join(" ")),
    },
  };
}

describe("done lead guard", () => {
  test("refuses to done the lead window from a non-lead context", async () => {
    const kills: string[] = [];
    const errors: string[] = [];

    await expect(cmdDone("mawjs-oracle", { force: true }, depsFor({
      current: "mawjs\t1",
      kills,
      errors,
    }))).rejects.toThrow("refusing to done lead window");

    expect(kills).toEqual([]);
    expect(errors.join("\n")).toContain("target a non-lead agent window");
  });

  test("allows the lead window to done a non-lead agent", async () => {
    const kills: string[] = [];

    await cmdDone("codex-pr", { force: true }, depsFor({
      current: "mawjs\t0",
      kills,
    }));

    expect(kills).toEqual(["mawjs:codex-pr"]);
  });
});
