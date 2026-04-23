import { describe, it, expect, mock, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { InvokeContext } from "../../../plugin/types";

// Capture real modules BEFORE any mock.module rewrites the cache.
// Namespace imports are live bindings, so we copy function references into
// locals to survive the rewrite (otherwise delegating to them would recurse
// into the mock itself).
import * as rawImpl from "./impl";
import * as rawBudRepo from "./bud-repo";
import * as rawBudWake from "./bud-wake";
import * as rawBudInit from "./bud-init";
import * as rawConfig from "../../../config";
import * as rawGhqRoot from "../../../config/ghq-root";

const realCmdBud = rawImpl.cmdBud;
const realEnsureBudRepo = rawBudRepo.ensureBudRepo;
const realFinalizeBud = rawBudWake.finalizeBud;
const realInitVault = rawBudInit.initVault;
const realGenerateClaudeMd = rawBudInit.generateClaudeMd;
const realConfigureFleet = rawBudInit.configureFleet;
const realWriteBirthNote = rawBudInit.writeBirthNote;
const realConfigModule = { ...rawConfig };
const realGhqRootModule = { ...rawGhqRoot };

let lastOpts: any = null;
let useReal = false;
let budRepoPath = "";

function installMocks() {
  mock.module("../../../config", () => ({
    ...realConfigModule,
    loadConfig: () => ({ githubOrg: "Soul-Brews-Studio", env: {}, commands: {}, sessions: {} }),
  }));
  // #680 — getGhqRoot moved to leaf module config/ghq-root.
  // The test never hits disk under ghqRoot (ensureBudRepo is fully mocked),
  // so "/tmp/nope" is inert — just feeds the predicted-path string.
  mock.module("../../../config/ghq-root", () => ({
    ...realGhqRootModule,
    getGhqRoot: () => "/tmp/nope",
  }));
  mock.module("./impl", () => ({
    cmdBud: async (name: string, opts: any) => {
      lastOpts = opts;
      if (useReal) return realCmdBud(name, opts);
      console.log(`budding ${name}`);
    },
  }));
  mock.module("./bud-repo", () => ({
    ensureBudRepo: async () => budRepoPath,
  }));
  mock.module("./bud-wake", () => ({
    finalizeBud: async () => {},
  }));
  mock.module("./bud-init", () => {
    const { mkdirSync } = require("fs");
    const { join } = require("path");
    return {
      initVault: (p: string) => {
        const psi = join(p, "ψ");
        mkdirSync(psi, { recursive: true });
        return psi;
      },
      generateClaudeMd: () => {},
      configureFleet: () => "/tmp/fake-fleet.json",
      writeBirthNote: () => {},
    };
  });
}

function restoreMocks() {
  // Re-register the real modules — bun has no "unmock" primitive, so we
  // install passthrough mocks that point back at the real implementations.
  mock.module("../../../config", () => realConfigModule);
  mock.module("../../../config/ghq-root", () => realGhqRootModule);
  mock.module("./impl", () => ({ cmdBud: realCmdBud }));
  mock.module("./bud-repo", () => ({ ensureBudRepo: realEnsureBudRepo }));
  mock.module("./bud-wake", () => ({ finalizeBud: realFinalizeBud }));
  mock.module("./bud-init", () => ({
    initVault: realInitVault,
    generateClaudeMd: realGenerateClaudeMd,
    configureFleet: realConfigureFleet,
    writeBirthNote: realWriteBirthNote,
  }));
}

describe("bud plugin", () => {
  let handler: (ctx: InvokeContext) => Promise<any>;

  beforeAll(() => installMocks());
  afterAll(() => restoreMocks());

  beforeEach(async () => {
    lastOpts = null;
    useReal = false;
    const mod = await import("./index");
    handler = mod.default;
  });

  it("cli: basic bud", async () => {
    const result = await handler({ source: "cli", args: ["myoracle"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("budding myoracle");
  });

  it("cli: bud with flags", async () => {
    const result = await handler({ source: "cli", args: ["newbud", "--from", "neo", "--dry-run"] });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("budding newbud");
  });

  it("cli: name starts with dash returns error", async () => {
    const result = await handler({ source: "cli", args: ["--unknown-flag"] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("looks like a flag");
  });

  it("cli: --nickname flag reaches cmdBud opts (#643 Phase 3)", async () => {
    const result = await handler({
      source: "cli",
      args: ["myplugin", "--nickname", "Bloom Two", "--dry-run"],
    });
    expect(result.ok).toBe(true);
    expect(lastOpts).not.toBeNull();
    expect(lastOpts.nickname).toBe("Bloom Two");
  });

  it("api: nickname passes through", async () => {
    const result = await handler({
      source: "api",
      args: { name: "myplugin", nickname: "Bloom Two", dryRun: true },
    });
    expect(result.ok).toBe(true);
    expect(lastOpts.nickname).toBe("Bloom Two");
  });
});

// ─── Integration: cmdBud --nickname writes ψ/nickname at birth (#643 Phase 3) ─
//
// Runs the real cmdBud (via `useReal = true`) but with repo/fleet/wake seams
// stubbed above. Verifies the authoritative on-disk write.

describe("cmdBud --nickname (#643 Phase 3)", () => {
  let prevMawHome: string | undefined;
  let sandbox: string;

  beforeAll(() => installMocks());
  afterAll(() => restoreMocks());

  beforeEach(() => {
    useReal = true;
    sandbox = mkdtempSync(join(tmpdir(), "maw-bud-nickname-"));
    budRepoPath = join(sandbox, "repo");
    mkdirSync(budRepoPath, { recursive: true });
    prevMawHome = process.env.MAW_HOME;
    process.env.MAW_HOME = join(sandbox, "home");
    mkdirSync(process.env.MAW_HOME, { recursive: true });
  });

  afterEach(() => {
    useReal = false;
    if (prevMawHome === undefined) delete process.env.MAW_HOME;
    else process.env.MAW_HOME = prevMawHome;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("writes ψ/nickname when --nickname is provided", async () => {
    await realCmdBud("myplugin", { from: "mawjs", nickname: "Bloom Two" });

    const file = join(budRepoPath, "ψ", "nickname");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf-8")).toBe("Bloom Two\n");
  });

  it("does NOT write ψ/nickname when --nickname is absent", async () => {
    await realCmdBud("plainbud", { from: "mawjs" });
    expect(existsSync(join(budRepoPath, "ψ", "nickname"))).toBe(false);
  });

  it("trims surrounding whitespace before writing", async () => {
    await realCmdBud("trimmed", { from: "mawjs", nickname: "  Bloom  " });
    expect(readFileSync(join(budRepoPath, "ψ", "nickname"), "utf-8")).toBe("Bloom\n");
  });

  it("rejects multi-line nickname before touching repo", async () => {
    await expect(
      realCmdBud("badbud", { from: "mawjs", nickname: "line1\nline2" }),
    ).rejects.toThrow(/single line/);
  });

  it("whitespace-only nickname is a no-op (no file written)", async () => {
    await realCmdBud("whitespace", { from: "mawjs", nickname: "   " });
    expect(existsSync(join(budRepoPath, "ψ", "nickname"))).toBe(false);
  });

  it("dry-run previews the nickname without writing", async () => {
    await realCmdBud("previewbud", { from: "mawjs", nickname: "Bloom", dryRun: true });
    expect(existsSync(join(budRepoPath, "ψ", "nickname"))).toBe(false);
  });
});
