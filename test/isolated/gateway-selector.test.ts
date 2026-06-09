import { describe, expect, test } from "bun:test";

import { BunGateway, RustGateway, normalizeGateway, selectGateway } from "../../src/core/gateway";
import { routeToolsWithDeps, type RouteToolsDeps } from "../../src/cli/route-tools";

function routeDeps(calls: Array<Record<string, unknown>>): RouteToolsDeps {
  const unused = async () => { throw new Error("unexpected loader"); };
  return {
    log: (...args: unknown[]) => calls.push({ type: "log", args }),
    error: (...args: unknown[]) => calls.push({ type: "error", args }),
    stdoutWrite: (chunk: string) => calls.push({ type: "stdout", chunk }),
    exit: (code?: number) => { throw new Error(`exit ${code ?? 0}`); },
    paths: {
      resolve: (...parts: string[]) => parts.join("/"),
      join: (...parts: string[]) => parts.join("/"),
      existsSync: () => false,
      homedir: () => "/tmp",
      sourceDir: "/src/cli",
    },
    loadPluginLegacyTools: unused as RouteToolsDeps["loadPluginLegacyTools"],
    loadPluginLifecycleTools: unused as RouteToolsDeps["loadPluginLifecycleTools"],
    loadPluginCreateTools: unused as RouteToolsDeps["loadPluginCreateTools"],
    loadArtifactsTools: unused as RouteToolsDeps["loadArtifactsTools"],
    loadAgentsTools: unused as RouteToolsDeps["loadAgentsTools"],
    loadAuditTools: unused as RouteToolsDeps["loadAuditTools"],
    loadTmuxTools: unused as RouteToolsDeps["loadTmuxTools"],
    loadServeStatusTools: unused as RouteToolsDeps["loadServeStatusTools"],
    loadServeStartTools: async () => ({
      acquirePidLock: (instanceName, opts) => calls.push({ type: "lock", instanceName, opts }),
      startServer: (port, options) => calls.push({ type: "start", port, options }),
    }),
  };
}

describe("gateway selector (#2566)", () => {
  test("selectGateway honors CLI > env > config > bun precedence", () => {
    expect(selectGateway({}).kind).toBe("bun");
    expect(selectGateway({ config: { gateway: "auto" } })).toBeInstanceOf(BunGateway);
    expect(selectGateway({ config: { gateway: "rust" } })).toBeInstanceOf(RustGateway);
    expect(selectGateway({ env: { MAW_GATEWAY: "rust" }, config: { gateway: "bun" } })).toBeInstanceOf(RustGateway);
    expect(selectGateway({ cliGateway: "bun", env: { MAW_GATEWAY: "rust" }, config: { gateway: "rust" } }).kind).toBe("bun");
  });

  test("rejects invalid gateway values at the selection boundary", () => {
    expect(normalizeGateway("BUN")).toBe("bun");
    expect(() => selectGateway({ cliGateway: "sidecar" })).toThrow("--gateway must be one of: bun, rust, auto");
    expect(() => normalizeGateway(7, "config.gateway")).toThrow("config.gateway must be one of: bun, rust, auto");
  });

  test("maw serve forwards --gateway without treating it as an unknown flag", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await expect(routeToolsWithDeps("serve", ["serve", "--gateway", "rust", "4567", "--force-takeover"], routeDeps(calls))).resolves.toBe(true);

    expect(calls).toContainEqual({ type: "lock", instanceName: null, opts: { forceTakeover: true } });
    expect(calls).toContainEqual({ type: "start", port: 4567, options: { verbosity: 1, gateway: "rust" } });
  });

  test("maw serve accepts --gateway=auto and preserves --as handling", async () => {
    const calls: Array<Record<string, unknown>> = [];
    await expect(routeToolsWithDeps("serve", ["serve", "--gateway=auto", "--as", "blue", "4568"], routeDeps(calls))).resolves.toBe(true);

    expect(calls).toContainEqual({ type: "lock", instanceName: "blue", opts: { forceTakeover: false } });
    expect(calls).toContainEqual({ type: "start", port: 4568, options: { verbosity: 1, gateway: "auto" } });
  });
});
