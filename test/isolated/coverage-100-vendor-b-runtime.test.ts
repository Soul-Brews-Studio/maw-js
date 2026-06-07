import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as realChild from "node:child_process";

// ---- bg/src/impl.ts seams -------------------------------------------------

type BgSession = { created: number; paneCommand: string; tail: string };
const bgSessions = new Map<string, BgSession>();
let listFailure: { status: number; stdout: string; stderr: string } | null = null;
let spawnedArgs: string[][] = [];
let captureCalls = 0;
let onSecondCapture: (() => void) | null = null;

function bgSlug(target: string): string {
  return target.replace(/^maw-bg-/, "");
}

mock.module("node:child_process", () => ({
  ...realChild,
  spawnSync: (_cmd: string, args: string[] = []) => {
    const [subcommand] = args;
    if (subcommand === "list-sessions") {
      if (listFailure) return listFailure;
      return {
        status: 0,
        stdout: [...bgSessions.entries()]
          .map(([slug, s]) => `maw-bg-${slug}\t${s.created}\t${s.paneCommand}`)
          .join("\n"),
        stderr: "",
      };
    }
    if (subcommand === "capture-pane") {
      const target = args[args.indexOf("-t") + 1] ?? "";
      captureCalls++;
      if (captureCalls === 2) onSecondCapture?.();
      const session = bgSessions.get(bgSlug(target));
      return { status: session ? 0 : 1, stdout: session?.tail ?? "", stderr: session ? "" : "missing" };
    }
    if (subcommand === "has-session") {
      return { status: bgSessions.has(bgSlug(args.at(-1) ?? "")) ? 0 : 1, stdout: "", stderr: "" };
    }
    if (subcommand === "kill-session") {
      bgSessions.delete(bgSlug(args.at(-1) ?? ""));
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  },
  spawn: (_cmd: string, args: string[]) => {
    spawnedArgs.push(args);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  },
}));

const bg = await import("../../src/vendor/mpr-plugins/bg/src/impl.ts?coverage-100-vendor-b-runtime");

beforeEach(() => {
  bgSessions.clear();
  listFailure = null;
  spawnedArgs = [];
  captureCalls = 0;
  onSecondCapture = null;
  delete process.env.TMUX;
});

describe("coverage-100 vendor-b bg runtime gaps", () => {
  test("resolveSlug covers hash hits, ambiguous prefixes, and missing refs", () => {
    expect(bg.resolveSlug("a111", ["build-a111", "test-b222"])).toBe("build-a111");
    expect(() => bg.resolveSlug("build", ["build-a111", "build-b222"])).toThrow('ref "build" matches 2 sessions');
    expect(() => bg.resolveSlug("none", ["build-a111"])).toThrow('no session matching "none"');
    expect(bg.holdsOpen("echo ok")).toContain("[done — exit %d]");
  });

  test("bgList treats tmux no-server as empty and normalizes invalid creation times", () => {
    listFailure = { status: 1, stdout: "", stderr: "no server running on /tmp/tmux" };
    expect(bg.bgList()).toEqual([]);

    listFailure = null;
    bgSessions.set("odd-a111", { created: Number.NaN, paneCommand: "read", tail: "last" });
    expect(bg.bgList()).toEqual([
      { slug: "odd-a111", session: "maw-bg-odd-a111", ageSeconds: 0, status: "done", lastLine: "last" },
    ]);
  });

  test("tail follow reprints rolled output blocks and gc keeps non-threshold sessions", async () => {
    bgSessions.set("build-a111", { created: 1_700_000_000, paneCommand: "node", tail: "alpha\nbeta" });
    const writes: string[] = [];
    const controller = new AbortController();
    onSecondCapture = () => {
      bgSessions.get("build-a111")!.tail = "rolled";
      controller.abort();
    };

    await bg.bgTailFollow("build", { signal: controller.signal, writer: (chunk) => writes.push(chunk) });

    expect(writes.join("|")).toContain("rolled\n");

    const result = bg.bgGc({ thresholdSeconds: 999_999_999, dryRun: true });
    expect(result).toMatchObject({ reaped: [], kept: ["build-a111"], dryRun: true });
  });

  test("attach switches clients when already inside tmux", async () => {
    process.env.TMUX = "/tmp/tmux-1/default,1,0";
    bgSessions.set("build-a111", { created: 1_700_000_000, paneCommand: "node", tail: "" });

    await expect(bg.bgAttach("build")).resolves.toBe(0);

    expect(spawnedArgs).toEqual([["switch-client", "-t", "maw-bg-build-a111"]]);
  });
});
