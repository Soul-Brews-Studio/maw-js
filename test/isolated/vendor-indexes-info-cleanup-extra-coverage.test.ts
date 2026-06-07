import { beforeEach, describe, expect, mock, test } from "bun:test";

const avengersImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/avengers/impl.ts");
const cleanupZombiesPath = import.meta.resolve("../../src/vendor/mpr-plugins/cleanup/internal/team-cleanup-zombies.ts");
const cleanupPrunePath = import.meta.resolve("../../src/vendor/mpr-plugins/cleanup/internal/prune-stale-oracles.ts");
const learnImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/learn/impl.ts");
const aboutImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/about/internal/impl-about.ts");
const shellenvImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/shellenv/src/impl.ts");
const configPath = import.meta.resolve("../../src/config.ts");
const nicknamesPath = import.meta.resolve("../../src/core/fleet/nicknames.ts");

let avengersCalls: string[] = [];
let avengersError: Error | null = null;
let cleanupZombieCalls: Array<{ yes?: boolean }> = [];
let cleanupPruneCalls: Array<{ yes?: boolean; ask?: boolean; dryRun?: boolean }> = [];
let cleanupError: Error | null = null;
let learnCalls: Array<{ repo: string; mode: string }> = [];
let learnMessage = "learn stub output";
let learnError: Error | null = null;
let aboutCalls: string[] = [];
let aboutError: Error | null = null;
let shellenvCalls: Array<{ shell: string | undefined; opts: { help?: boolean } }> = [];
let shellenvError: Error | null = null;
let configValue: Record<string, unknown> | Error = { node: "local-node" };
let nicknameValue: string | null | Error = "friendly-oracle";
let fsReadValue: string | Error = JSON.stringify({ version: "9.8.7-test" });
let fsReadCalls: string[] = [];

mock.module(avengersImplPath, () => ({
  cmdAvengers: async (sub: string) => {
    avengersCalls.push(sub);
    if (avengersError) throw avengersError;
    console.log(`avengers:${sub}`);
  },
}));

mock.module(cleanupZombiesPath, () => ({
  cmdCleanupZombies: async (opts: { yes?: boolean } = {}) => {
    cleanupZombieCalls.push(opts);
    if (cleanupError) throw cleanupError;
    console.log(`zombies:${opts.yes ? "yes" : "no"}`);
  },
}));

mock.module(cleanupPrunePath, () => ({
  cmdPruneStale: async (opts: { yes?: boolean; ask?: boolean; dryRun?: boolean } = {}) => {
    cleanupPruneCalls.push(opts);
    if (cleanupError) throw cleanupError;
    console.log(`prune:${opts.yes ? "yes" : opts.ask ? "ask" : opts.dryRun ? "dry" : "preview"}`);
  },
}));

mock.module(learnImplPath, () => ({
  cmdLearn: async (repo: string, mode: string) => {
    learnCalls.push({ repo, mode });
    if (learnError) throw learnError;
    console.log(`learn:${repo}:${mode}`);
    return learnMessage;
  },
}));

mock.module(aboutImplPath, () => ({
  cmdOracleAbout: async (oracle: string) => {
    aboutCalls.push(oracle);
    if (aboutError) throw aboutError;
    console.log(`about:${oracle}`);
  },
}));

mock.module(shellenvImplPath, () => ({
  cmdShellenv: async (shell: string | undefined, opts: { help?: boolean } = {}) => {
    shellenvCalls.push({ shell, opts });
    if (shellenvError) throw shellenvError;
    console.log(`shellenv:${shell ?? "missing"}:${opts.help ? "help" : "emit"}`);
  },
}));

mock.module(configPath, () => ({
  loadConfig: () => {
    if (configValue instanceof Error) throw configValue;
    return configValue;
  },
}));

mock.module(nicknamesPath, () => ({
  resolveNickname: (node: string, cwd: string) => {
    if (nicknameValue instanceof Error) throw nicknameValue;
    return nicknameValue ? `${nicknameValue}:${node}:${cwd.length > 0 ? "cwd" : "nocwd"}` : nicknameValue;
  },
}));

mock.module("os", () => ({
  hostname: () => "fallback-host",
}));

mock.module("fs", () => ({
  readFileSync: (path: string) => {
    fsReadCalls.push(String(path));
    if (fsReadValue instanceof Error) throw fsReadValue;
    return fsReadValue;
  },
}));

const avengersHandler = (await import("../../src/vendor/mpr-plugins/avengers/index.ts?vendor-indexes-info-extra")).default;
const cleanupHandler = (await import("../../src/vendor/mpr-plugins/cleanup/index.ts?vendor-indexes-info-extra")).default;
const learnHandler = (await import("../../src/vendor/mpr-plugins/learn/index.ts?vendor-indexes-info-extra")).default;
const aboutHandler = (await import("../../src/vendor/mpr-plugins/about/index.ts?vendor-indexes-info-extra")).default;
const shellenvHandler = (await import("../../src/vendor/mpr-plugins/shellenv/src/index.ts?vendor-indexes-info-extra")).default;
const { buildInfo, infoView } = await import("../../src/views/info.ts?vendor-indexes-info-extra");

function ctx(source: "cli" | "api", args: unknown, writer?: (...parts: unknown[]) => void) {
  return { source, args, writer } as any;
}

function writer() {
  const lines: string[] = [];
  return {
    lines,
    fn: (...parts: unknown[]) => lines.push(parts.map(String).join(" ")),
  };
}

beforeEach(() => {
  avengersCalls = [];
  avengersError = null;
  cleanupZombieCalls = [];
  cleanupPruneCalls = [];
  cleanupError = null;
  learnCalls = [];
  learnMessage = "learn stub output";
  learnError = null;
  aboutCalls = [];
  aboutError = null;
  shellenvCalls = [];
  shellenvError = null;
  configValue = { node: "local-node" };
  nicknameValue = "friendly-oracle";
  fsReadValue = JSON.stringify({ version: "9.8.7-test" });
  fsReadCalls = [];
});

describe("vendor command index handlers isolated coverage", () => {
  test("avengers handles help before dispatch, defaults CLI/API to status, and reports dispatch failures", async () => {
    const help = writer();
    await expect(avengersHandler(ctx("cli", ["--help"], help.fn))).resolves.toEqual({ ok: true });
    expect(help.lines.join("\n")).toContain("usage: maw avengers");
    expect(avengersCalls).toEqual([]);

    await expect(avengersHandler(ctx("cli", [], help.fn))).resolves.toMatchObject({ ok: true });
    await expect(avengersHandler(ctx("api", { sub: "best" }, help.fn))).resolves.toMatchObject({ ok: true });
    expect(avengersCalls).toEqual(["status", "status"]);
    expect(help.lines.join("\n")).toContain("avengers:status");

    avengersError = new Error("avengers boom");
    await expect(avengersHandler(ctx("cli", ["traffic"], help.fn))).resolves.toMatchObject({
      ok: false,
      error: "avengers boom",
    });
    expect(avengersCalls.at(-1)).toBe("traffic");
  });

  test("cleanup parses zombie/prune flags, renders help, and returns captured errors", async () => {
    await expect(cleanupHandler(ctx("cli", ["--zombies", "--yes"]))).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining("zombies:yes"),
    });
    await expect(cleanupHandler(ctx("cli", ["--prune-stale", "--ask", "--dry-run"]))).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining("prune:ask"),
    });
    await expect(cleanupHandler(ctx("api", { ignored: true }))).resolves.toMatchObject({
      ok: true,
      output: expect.stringContaining("maw cleanup --zombie-agents"),
    });

    expect(cleanupZombieCalls).toEqual([{ yes: true }]);
    expect(cleanupPruneCalls).toEqual([{ yes: false, ask: true, dryRun: true }]);

    cleanupError = new Error("cleanup boom");
    await expect(cleanupHandler(ctx("cli", ["--prune-stale", "--yes"]))).resolves.toMatchObject({
      ok: false,
      error: "cleanup boom",
    });
  });

  test("learn validates CLI flags and dispatches default, fast, and deep modes", async () => {
    await expect(learnHandler(ctx("cli", []))).resolves.toMatchObject({
      ok: false,
      error: "usage: maw learn <repo> [--fast|--deep]",
    });
    await expect(learnHandler(ctx("cli", ["repo", "--fast", "--deep"]))).resolves.toMatchObject({
      ok: false,
      error: "maw learn: --fast and --deep are mutually exclusive",
    });
    await expect(learnHandler(ctx("cli", ["repo", "--wide"]))).resolves.toMatchObject({
      ok: false,
      error: "maw learn: unknown flag(s) --wide (accepts --fast, --deep)",
    });

    await expect(learnHandler(ctx("cli", ["owner/repo"]))).resolves.toMatchObject({ ok: true });
    await expect(learnHandler(ctx("cli", ["owner/repo", "--fast"]))).resolves.toMatchObject({ ok: true });
    await expect(learnHandler(ctx("cli", ["owner/repo", "--deep"]))).resolves.toMatchObject({ ok: true });
    expect(learnCalls).toEqual([
      { repo: "owner/repo", mode: "default" },
      { repo: "owner/repo", mode: "fast" },
      { repo: "owner/repo", mode: "deep" },
    ]);

    learnError = new Error("learn boom");
    await expect(learnHandler(ctx("cli", ["owner/repo"]))).resolves.toMatchObject({ ok: false, error: "learn boom" });
  });

  test("about validates CLI/API args, dispatches oracle lookup, and captures writer output", async () => {
    await expect(aboutHandler(ctx("cli", []))).resolves.toMatchObject({ ok: false, error: "usage: maw about <oracle>" });
    await expect(aboutHandler(ctx("api", {}))).resolves.toMatchObject({ ok: false, error: "oracle is required" });

    const out = writer();
    await expect(aboutHandler(ctx("cli", ["neo"], out.fn))).resolves.toMatchObject({ ok: true });
    await expect(aboutHandler(ctx("api", { oracle: "trinity" }))).resolves.toMatchObject({
      ok: true,
      output: "about:trinity",
    });
    expect(aboutCalls).toEqual(["neo", "trinity"]);
    expect(out.lines).toEqual(["about:neo"]);

    aboutError = new Error("about boom");
    await expect(aboutHandler(ctx("cli", ["neo"]))).resolves.toMatchObject({ ok: false, error: "about boom" });
  });

  test("shellenv index parses help aliases, shell positionals, API defaults, and thrown errors", async () => {
    await expect(shellenvHandler(ctx("cli", ["-h"]))).resolves.toMatchObject({
      ok: true,
      output: "shellenv:missing:help",
    });
    await expect(shellenvHandler(ctx("cli", ["zsh"]))).resolves.toMatchObject({
      ok: true,
      output: "shellenv:zsh:emit",
    });
    await expect(shellenvHandler(ctx("api", { shell: "bash" }))).resolves.toMatchObject({
      ok: true,
      output: "shellenv:missing:emit",
    });
    expect(shellenvCalls).toEqual([
      { shell: undefined, opts: { help: true } },
      { shell: "zsh", opts: { help: undefined } },
      { shell: undefined, opts: { help: undefined } },
    ]);

    shellenvError = new Error("shellenv boom");
    await expect(shellenvHandler(ctx("cli", ["fish"]))).resolves.toMatchObject({
      ok: false,
      error: "shellenv boom",
      exitCode: 1,
    });
  });
});

describe("info view isolated coverage", () => {
  test("buildInfo uses config node, package version, nickname, and schema capabilities", () => {
    const info = buildInfo();

    expect(info).toMatchObject({
      node: "local-node",
      version: "9.8.7-test",
      nickname: expect.stringContaining("friendly-oracle:local-node"),
      maw: {
        schema: "1",
        plugins: { manifestEndpoint: "/api/plugins" },
        capabilities: expect.arrayContaining(["plugin.listManifest", "peer.handshake", "info"]),
      },
    });
    expect(new Date(info.ts).toString()).not.toBe("Invalid Date");
    expect(fsReadCalls[0]).toContain("package.json");
  });

  test("buildInfo falls back when config, package, or nickname reads fail", () => {
    configValue = new Error("no config");
    fsReadValue = new Error("no package");
    nicknameValue = new Error("no nickname");

    expect(buildInfo()).toMatchObject({
      node: "fallback-host",
      version: "",
      maw: { schema: "1" },
    });
    expect(buildInfo().nickname).toBeUndefined();
  });

  test("infoView returns the buildInfo JSON body", async () => {
    configValue = { node: "route-node" };
    nicknameValue = null;

    const response = await infoView.request("/");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      node: "route-node",
      maw: { plugins: { manifestEndpoint: "/api/plugins" } },
    });
  });
});
