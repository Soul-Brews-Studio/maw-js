/**
 * Default-suite coverage for workspace lifecycle commands.
 *
 * The historical workspace suite is isolated because it stubs modules with
 * mock.module(). These tests use the injected dependency seam so lifecycle
 * command behavior contributes to LCOV without crossing the mock boundary.
 */
import { describe, expect, test } from "bun:test";
import {
  cmdWorkspaceCreate,
  cmdWorkspaceJoin,
  cmdWorkspaceLeave,
  type WorkspaceLifecycleDeps,
} from "../src/commands/shared/workspace-lifecycle";
import type { WorkspaceConfig } from "../src/commands/shared/workspace-store";

type CurlResponse = Awaited<ReturnType<WorkspaceLifecycleDeps["curlFetch"]>>;

function makeHarness(opts: {
  hub?: string | null;
  workspaceId?: string | null;
  workspace?: WorkspaceConfig | null;
  config?: Record<string, unknown>;
  response?: CurlResponse;
  renameThrows?: boolean;
  unlinkThrows?: boolean;
  useDefaultNow?: boolean;
} = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const calls: Array<{ url: string; opts: RequestInit }> = [];
  const saved: WorkspaceConfig[] = [];
  const renames: Array<[string, string]> = [];
  const unlinks: string[] = [];
  let reportedNoWorkspace = false;
  let exitCode: number | undefined;

  const deps: Partial<WorkspaceLifecycleDeps> = {
    loadConfig: () => opts.config ?? {},
    curlFetch: async (url, init) => {
      calls.push({ url, opts: init ?? {} });
      return opts.response ?? { ok: true, status: 200, data: null };
    },
    resolveHubUrl: () => opts.hub ?? null,
    resolveWorkspaceId: () => opts.workspaceId ?? null,
    reportNoWorkspaceId: () => { reportedNoWorkspace = true; errors.push("no workspace id"); },
    loadWorkspace: () => opts.workspace ?? null,
    saveWorkspace: (ws) => { saved.push(ws); },
    configPath: (id) => `/workspaces/${id}.json`,
    renameSync: (src, dest) => {
      if (opts.renameThrows) throw new Error("rename denied");
      renames.push([src, dest]);
    },
    unlinkSync: (src) => {
      if (opts.unlinkThrows) throw new Error("unlink denied");
      unlinks.push(src);
    },
    log: (...args) => logs.push(args.map(String).join(" ")),
    error: (...args) => errors.push(args.map(String).join(" ")),
    exit: (code): never => {
      exitCode = code;
      throw new Error(`__exit__:${code}`);
    },
  };

  if (!opts.useDefaultNow) {
    deps.now = () => new Date("2026-05-17T11:30:00.000Z");
  }

  async function run(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith("__exit__:")) throw error;
    }
  }

  return {
    deps,
    run,
    state: {
      logs,
      errors,
      calls,
      saved,
      renames,
      unlinks,
      get reportedNoWorkspace() { return reportedNoWorkspace; },
      get exitCode() { return exitCode; },
    },
  };
}

describe("workspace lifecycle default-suite seams", () => {
  test("create posts node identity, saves the returned workspace, and renders join code", async () => {
    const h = makeHarness({
      hub: "https://hub.example",
      config: { node: "m5" },
      response: { ok: true, status: 200, data: { id: "ws-1", name: "alpha", joinCode: "abc123" } },
      useDefaultNow: true,
    });

    await h.run(() => cmdWorkspaceCreate("alpha", "https://ignored.example", h.deps));

    expect(h.state.exitCode).toBeUndefined();
    expect(h.state.calls[0]).toMatchObject({ url: "https://hub.example/api/workspace/create" });
    expect(JSON.parse(String(h.state.calls[0].opts.body))).toEqual({ name: "alpha", nodeId: "m5" });
    expect(h.state.saved[0]).toMatchObject({
      id: "ws-1",
      name: "alpha",
      hubUrl: "https://hub.example",
      joinCode: "abc123",
      sharedAgents: [],
      lastStatus: "connected",
    });
    expect(h.state.saved[0].joinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(h.state.logs.join("\n")).toContain("workspace created");
    expect(h.state.logs.join("\n")).toContain("Join code:");
    expect(h.state.logs.join("\n")).toContain("/workspaces/ws-1.json");
  });

  test("create exits when no hub exists or when the hub response has no workspace id", async () => {
    const noHub = makeHarness({ hub: null });
    await noHub.run(() => cmdWorkspaceCreate("alpha", undefined, noHub.deps));
    expect(noHub.state.exitCode).toBe(1);
    expect(noHub.state.errors.join("\n")).toContain("no hub URL");

    const badHub = makeHarness({
      hub: "https://hub.example",
      response: { ok: false, status: 503, data: { error: "hub down" } },
    });
    await badHub.run(() => cmdWorkspaceCreate("beta", undefined, badHub.deps));
    expect(badHub.state.exitCode).toBe(1);
    expect(badHub.state.errors.join("\n")).toContain("failed to create workspace");
    expect(badHub.state.errors.join("\n")).toContain("hub down");
  });

  test("create default exit path delegates to process.exit", async () => {
    const originalExit = process.exit;
    let processExitCode: number | string | null | undefined;
    process.exit = ((code?: number | string | null): never => {
      processExitCode = code;
      throw new Error("__process_exit__");
    }) as typeof process.exit;

    try {
      await expect(cmdWorkspaceCreate("alpha", undefined, {
        resolveHubUrl: () => null,
        error: () => {},
      })).rejects.toThrow("__process_exit__");
    } finally {
      process.exit = originalExit;
    }

    expect(processExitCode).toBe(1);
  });

  test("join saves defaults, renders object/string agents, and uses local node fallback", async () => {
    const h = makeHarness({
      hub: "https://hub.example",
      response: {
        ok: true,
        status: 200,
        data: { id: "ws-j", agents: [{ name: "alice" }, "bob"] },
      },
    });

    await h.run(() => cmdWorkspaceJoin("invite-code", undefined, h.deps));

    expect(JSON.parse(String(h.state.calls[0].opts.body))).toEqual({ code: "invite-code", node: "local" });
    expect(h.state.saved[0]).toMatchObject({
      id: "ws-j",
      name: "unknown",
      hubUrl: "https://hub.example",
      joinCode: "invite-code",
      sharedAgents: [],
      lastStatus: "connected",
    });
    expect(h.state.logs.join("\n")).toContain("2 available");
    expect(h.state.logs.join("\n")).toContain("alice");
    expect(h.state.logs.join("\n")).toContain("bob");
  });

  test("join exits on no hub or a response without id", async () => {
    const noHub = makeHarness({ hub: null });
    await noHub.run(() => cmdWorkspaceJoin("code", undefined, noHub.deps));
    expect(noHub.state.exitCode).toBe(1);
    expect(noHub.state.errors.join("\n")).toContain("no hub URL");

    const badHub = makeHarness({
      hub: "https://hub.example",
      response: { ok: true, status: 200, data: { error: "bad code" } },
    });
    await badHub.run(() => cmdWorkspaceJoin("bad", undefined, badHub.deps));
    expect(badHub.state.exitCode).toBe(1);
    expect(badHub.state.errors.join("\n")).toContain("failed to join workspace");
    expect(badHub.state.errors.join("\n")).toContain("bad code");
  });

  test("leave reports missing context and missing workspace before contacting the hub", async () => {
    const noId = makeHarness({ workspaceId: null });
    await noId.run(() => cmdWorkspaceLeave(undefined, noId.deps));
    expect(noId.state.exitCode).toBe(1);
    expect(noId.state.reportedNoWorkspace).toBe(true);
    expect(noId.state.calls).toEqual([]);

    const missing = makeHarness({ workspaceId: "ghost", workspace: null });
    await missing.run(() => cmdWorkspaceLeave("ghost", missing.deps));
    expect(missing.state.exitCode).toBe(1);
    expect(missing.state.errors.join("\n")).toContain("workspace not found: ghost");
    expect(missing.state.calls).toEqual([]);
  });

  test("leave posts to the hub and archives local config even when the hub reports failure", async () => {
    const h = makeHarness({
      workspaceId: "ws-leave",
      workspace: {
        id: "ws-leave",
        name: "leaveme",
        hubUrl: "https://hub.example",
        sharedAgents: [],
        joinedAt: "then",
      },
      config: { node: "m5" },
      response: { ok: false, status: 500, data: { error: "hub err" } },
    });

    await h.run(() => cmdWorkspaceLeave("ws-leave", h.deps));

    expect(h.state.exitCode).toBeUndefined();
    expect(h.state.calls[0].url).toBe("https://hub.example/api/workspace/ws-leave/leave");
    expect(JSON.parse(String(h.state.calls[0].opts.body))).toEqual({ node: "m5" });
    expect(h.state.errors.join("\n")).toContain("hub err");
    expect(h.state.logs.join("\n")).toContain("removing local config anyway");
    expect(h.state.renames).toEqual([["/workspaces/ws-leave.json", "/workspaces/ws-leave.left.json"]]);
  });

  test("leave falls back to unlink when archive rename fails", async () => {
    const h = makeHarness({
      workspaceId: "ws-unlink",
      workspace: {
        id: "ws-unlink",
        name: "unlinkme",
        hubUrl: "https://hub.example",
        sharedAgents: [],
        joinedAt: "then",
      },
      response: { ok: true, status: 200, data: null },
      renameThrows: true,
    });

    await h.run(() => cmdWorkspaceLeave("ws-unlink", h.deps));

    expect(h.state.exitCode).toBeUndefined();
    expect(h.state.unlinks).toEqual(["/workspaces/ws-unlink.json"]);
    expect(h.state.logs.join("\n")).toContain("left workspace");
    expect(h.state.logs.join("\n")).toContain("/workspaces/ws-unlink.left.json");
  });

  test("leave default filesystem archivers rename and unlink fallback", async () => {
    const fs = require("fs") as typeof import("fs");
    const os = require("os") as typeof import("os");
    const path = require("path") as typeof import("path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "maw-workspace-lifecycle-"));

    try {
      const renamed = makeHarness({
        workspaceId: "ws-fs",
        workspace: {
          id: "ws-fs",
          name: "fs rename",
          hubUrl: "https://hub.example",
          sharedAgents: [],
          joinedAt: "then",
        },
        response: { ok: true, status: 200, data: null },
      });
      fs.writeFileSync(path.join(tmp, "ws-fs.json"), "{}");
      const { renameSync: _renameSync, unlinkSync: _unlinkSync, ...renameDeps } = renamed.deps;

      await renamed.run(() => cmdWorkspaceLeave("ws-fs", {
        ...renameDeps,
        configPath: (id) => path.join(tmp, `${id}.json`),
      }));

      expect(fs.existsSync(path.join(tmp, "ws-fs.json"))).toBe(false);
      expect(fs.existsSync(path.join(tmp, "ws-fs.left.json"))).toBe(true);

      const unlinked = makeHarness({
        workspaceId: "ws-fallback",
        workspace: {
          id: "ws-fallback",
          name: "fs unlink",
          hubUrl: "https://hub.example",
          sharedAgents: [],
          joinedAt: "then",
        },
        response: { ok: true, status: 200, data: null },
      });
      fs.writeFileSync(path.join(tmp, "ws-fallback.json"), "{}");
      const realRenameSync = fs.renameSync;
      const realUnlinkSync = fs.unlinkSync;
      const unlinkedPaths: string[] = [];
      fs.renameSync = (() => { throw new Error("rename denied"); }) as typeof fs.renameSync;
      fs.unlinkSync = ((target: fs.PathLike) => {
        unlinkedPaths.push(String(target));
        return realUnlinkSync(target);
      }) as typeof fs.unlinkSync;

      try {
        const { renameSync: _renameFallback, unlinkSync: _unlinkFallback, ...unlinkDeps } = unlinked.deps;
        await unlinked.run(() => cmdWorkspaceLeave("ws-fallback", {
          ...unlinkDeps,
          configPath: (id) => path.join(tmp, `${id}.json`),
        }));
      } finally {
        fs.renameSync = realRenameSync;
        fs.unlinkSync = realUnlinkSync;
      }

      expect(unlinkedPaths).toEqual([path.join(tmp, "ws-fallback.json")]);
      expect(fs.existsSync(path.join(tmp, "ws-fallback.json"))).toBe(false);
      expect(fs.existsSync(path.join(tmp, "ws-fallback.left.json"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
