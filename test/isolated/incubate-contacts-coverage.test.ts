import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const budImplPath = join(import.meta.dir, "../../src/vendor/mpr-plugins/bud/impl.ts");
const sendTextImplPath = join(import.meta.dir, "../../src/vendor/mpr-plugins/send-text/impl.ts");

let config: Record<string, any> = {};

let budCalls: Array<{ stem: string; opts: Record<string, any> }> = [];
let budError: Error | null = null;
let sendTextCalls: Array<{ target: string; text: string }> = [];
let sendTextError: Error | null = null;
let sessions: any[] = [];
let resolveResult: any = { type: "pane", target: "%1" };
let resolveCalls: Array<{ stem: string; config: any; sessions: any[] }> = [];

let logs: string[] = [];
let errors: string[] = [];
const originalLog = console.log;
const originalError = console.error;
const originalCwd = process.cwd();

mock.module(budImplPath, () => ({
  cmdBud: async (stem: string, opts: Record<string, any>) => {
    budCalls.push({ stem, opts: { ...opts } });
    if (budError) throw budError;
  },
}));

mock.module(sendTextImplPath, () => ({
  cmdSendText: async (opts: { target: string; text: string }) => {
    sendTextCalls.push(opts);
    if (sendTextError) throw sendTextError;
  },
}));

mock.module("maw-js/sdk", () => ({
  listSessions: async () => sessions,
  resolveTarget: (stem: string, cfg: any, sessionRows: any[]) => {
    resolveCalls.push({ stem, config: cfg, sessions: sessionRows });
    return resolveResult;
  },
}));

mock.module("maw-js/config", () => ({
  loadConfig: () => config,
}));

const incubateImpl = await import("../../src/vendor/mpr-plugins/incubate/impl.ts?incubate-contacts-coverage");
const contactsImpl = await import("../../src/vendor/mpr-plugins/contacts/impl.ts?incubate-contacts-coverage");

const {
  buildSkillCommand,
  cmdIncubate,
  deriveStemFromSource,
  resolveMode,
} = incubateImpl;
const {
  cmdContactsAdd,
  cmdContactsLs,
  cmdContactsRm,
} = contactsImpl;

function resetConsoleCapture() {
  logs = [];
  errors = [];
  console.log = (...args: any[]) => logs.push(args.map(String).join(" "));
  console.error = (...args: any[]) => errors.push(args.map(String).join(" "));
}

function output() {
  return [...logs, ...errors].join("\n");
}

function stripAnsi(value: string) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

beforeEach(() => {
  config = {};
  budCalls = [];
  budError = null;
  sendTextCalls = [];
  sendTextError = null;
  sessions = [];
  resolveResult = { type: "pane", target: "%1" };
  resolveCalls = [];
  resetConsoleCapture();
});

afterEach(() => {
  process.chdir(originalCwd);
});

afterAll(() => {
  console.log = originalLog;
  console.error = originalError;
  process.chdir(originalCwd);
});

describe("incubate impl coverage", () => {
  test("derives stems, builds trigger commands, and resolves mutually exclusive modes", () => {
    expect(deriveStemFromSource("Soul-Brews-Studio/maw-js")).toBe("maw-js");
    expect(deriveStemFromSource("https://github.com/org/example.git")).toBe("example");
    expect(deriveStemFromSource("local-repo")).toBe("local-repo");
    expect(deriveStemFromSource("org/")).toBe("");

    expect(buildSkillCommand({ source: "org/repo" } as any)).toBe("/incubate org/repo");
    expect(buildSkillCommand({ source: "org/repo", mode: "flash" } as any)).toBe("/incubate org/repo --flash");
    expect(buildSkillCommand({ source: "org/repo", mode: "contribute" } as any)).toBe("/incubate org/repo --contribute");
    expect(buildSkillCommand({ source: "org/repo", trigger: "/custom seed" } as any)).toBe("/custom seed");

    expect(resolveMode(false, false)).toBe("default");
    expect(resolveMode(true, false)).toBe("flash");
    expect(resolveMode(false, true)).toBe("contribute");
    expect(() => resolveMode(true, true)).toThrow("--flash and --contribute are mutually exclusive");
  });

  test("validates required source and non-empty derived stem before budding", async () => {
    await expect(cmdIncubate({ source: "" } as any)).rejects.toThrow("usage: maw incubate <source-repo>");
    await expect(cmdIncubate({ source: "org/" } as any)).rejects.toThrow('could not derive stem from source: "org/"');

    expect(budCalls).toHaveLength(0);
    expect(sendTextCalls).toHaveLength(0);
    expect(resolveCalls).toHaveLength(0);
  });

  test("strips incubate-only options before bud and reports dry-run trigger dispatch", async () => {
    await cmdIncubate({
      source: "github.com/acme/repo",
      stem: "sprout",
      mode: "flash",
      trigger: "/custom incubate",
      noTrigger: false,
      from: "oracle-a",
      org: "Soul-Brews-Studio",
      issue: 42,
      note: "coverage",
      nickname: "Sprout",
      root: true,
      blank: true,
      seed: true,
      split: true,
      dryRun: true,
      signalOnBirth: true,
    } as any);

    expect(budCalls).toEqual([{
      stem: "sprout",
      opts: expect.objectContaining({
        repo: "github.com/acme/repo",
        from: "oracle-a",
        org: "Soul-Brews-Studio",
        issue: 42,
        note: "coverage",
        nickname: "Sprout",
        root: true,
        blank: true,
        seed: true,
        split: true,
        dryRun: true,
        signalOnBirth: true,
      }),
    }]);
    for (const incubateOnly of ["source", "stem", "mode", "trigger", "noTrigger"]) {
      expect(incubateOnly in budCalls[0].opts).toBe(false);
    }
    expect(sendTextCalls).toHaveLength(0);
    expect(resolveCalls).toHaveLength(0);
    expect(output()).toContain("[dry-run] would send");
    expect(output()).toContain("/custom incubate");
    expect(output()).toContain("sprout");
  });

  test("reports dry-run and live no-trigger paths without resolving panes", async () => {
    await cmdIncubate({ source: "org/no-trigger", noTrigger: true, dryRun: true } as any);
    expect(output()).toContain("[dry-run] --no-trigger: would NOT fire /incubate");

    resetConsoleCapture();
    await cmdIncubate({ source: "org/no-trigger", noTrigger: true } as any);
    expect(output()).toContain("--no-trigger: bud + wake done, skipping /incubate");

    expect(budCalls.map((call) => call.stem)).toEqual(["no-trigger", "no-trigger"]);
    expect(sendTextCalls).toHaveLength(0);
    expect(resolveCalls).toHaveLength(0);
  });

  test("skips trigger dispatch when the new oracle cannot be resolved", async () => {
    config = { node: "local" };
    sessions = [{ name: "repo-oracle" }];

    resolveResult = null;
    await cmdIncubate({ source: "org/repo" } as any);

    expect(resolveCalls).toEqual([{ stem: "repo", config, sessions }]);
    expect(sendTextCalls).toHaveLength(0);
    expect(output()).toContain("could not resolve repo after wake");
    expect(output()).toContain("try manually: maw send-text repo '/incubate org/repo'");

    resetConsoleCapture();
    resolveCalls = [];
    resolveResult = { type: "error", message: "ambiguous" };
    await cmdIncubate({ source: "org/repo", mode: "contribute" } as any);

    expect(resolveCalls).toEqual([{ stem: "repo", config, sessions }]);
    expect(sendTextCalls).toHaveLength(0);
    expect(output()).toContain("could not resolve repo after wake");
    expect(output()).toContain("/incubate org/repo --contribute");
  });

  test("fires the built incubate command and reports send-text failures gracefully", async () => {
    config = { node: "local-node" };
    sessions = [{ name: "repo-oracle", panes: ["%1"] }];
    resolveResult = { type: "pane", pane: "%1" };

    await cmdIncubate({ source: "org/repo", mode: "flash" } as any);
    expect(resolveCalls).toEqual([{ stem: "repo", config, sessions }]);
    expect(sendTextCalls).toEqual([{ target: "repo", text: "/incubate org/repo --flash" }]);
    expect(output()).toContain("firing");
    expect(output()).toContain("incubation dispatched");

    resetConsoleCapture();
    sendTextError = new Error("pane gone");
    await cmdIncubate({ source: "org/repo" } as any);

    expect(sendTextCalls.at(-1)).toEqual({ target: "repo", text: "/incubate org/repo" });
    expect(output()).toContain("send-text failed: pane gone");
    expect(output()).toContain("try manually: maw send-text repo '/incubate org/repo'");
  });
});

describe("contacts impl coverage", () => {
  test("lists an empty contacts file as no contacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-contacts-empty-"));
    config = { psiPath: join(root, "psi") };

    await cmdContactsLs();

    expect(stripAnsi(output())).toContain("no contacts");
    expect(existsSync(join(config.psiPath, "contacts.json"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("adds a contact with every supported field into the configured psi path", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-contacts-add-"));
    config = { psiPath: join(root, "custom-psi") };

    await cmdContactsAdd("morpheus", [
      "--maw", "white:morpheus",
      "--thread", "thread-123",
      "--inbox", "inbox/morpheus",
      "--repo", "github.com/zion/matrix",
      "--notes", "captain",
    ]);

    const saved = readJson(join(config.psiPath, "contacts.json"));
    expect(saved.contacts.morpheus).toEqual({
      maw: "white:morpheus",
      thread: "thread-123",
      inbox: "inbox/morpheus",
      repo: "github.com/zion/matrix",
      notes: "captain",
    });
    expect(saved.updated).toEqual(expect.any(String));
    expect(stripAnsi(output())).toContain("✓ contact morpheus saved");
    rmSync(root, { recursive: true, force: true });
  });

  test("lists active contacts with optional fields and hides retired contacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-contacts-list-"));
    config = { psiPath: join(root, "psi") };
    mkdirSync(config.psiPath, { recursive: true });
    writeFileSync(join(config.psiPath, "contacts.json"), JSON.stringify({
      contacts: {
        neo: {
          maw: "white:neo",
          thread: "thread-neo",
          inbox: "inbox/neo",
          repo: "github.com/zion/one",
          notes: "the one",
        },
        trinity: {},
        smith: { maw: "black:smith", retired: true },
      },
      updated: "old",
    }), "utf-8");

    await cmdContactsLs();

    const text = stripAnsi(output());
    expect(text).toContain("CONTACTS (2)");
    expect(text).toContain("neo");
    expect(text).toContain("maw: white:neo");
    expect(text).toContain("thread: thread-neo");
    expect(text).toContain("inbox: inbox/neo");
    expect(text).toContain("repo: github.com/zion/one");
    expect(text).toContain('"the one"');
    expect(text).toContain("trinity");
    expect(text).not.toContain("smith");
    rmSync(root, { recursive: true, force: true });
  });

  test("revives retired contacts while preserving existing fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-contacts-revive-"));
    config = { psiPath: join(root, "psi") };
    mkdirSync(config.psiPath, { recursive: true });
    writeFileSync(join(config.psiPath, "contacts.json"), JSON.stringify({
      contacts: {
        neo: { maw: "old:neo", notes: "old note", retired: true },
      },
      updated: "old",
    }), "utf-8");

    await cmdContactsAdd("neo", ["--thread", "thread-new"]);

    const saved = readJson(join(config.psiPath, "contacts.json"));
    expect(saved.contacts.neo).toEqual({
      maw: "old:neo",
      notes: "old note",
      thread: "thread-new",
    });
    expect("retired" in saved.contacts.neo).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("retiring a missing contact reports an error and existing contacts are marked retired", async () => {
    const root = mkdtempSync(join(tmpdir(), "maw-contacts-rm-"));
    config = { psiPath: join(root, "psi") };

    await cmdContactsRm("missing");
    expect(stripAnsi(output())).toContain("error: contact 'missing' not found");
    expect(existsSync(join(config.psiPath, "contacts.json"))).toBe(false);

    mkdirSync(config.psiPath, { recursive: true });
    writeFileSync(join(config.psiPath, "contacts.json"), JSON.stringify({
      contacts: { neo: { maw: "white:neo" } },
      updated: "old",
    }), "utf-8");

    resetConsoleCapture();
    await cmdContactsRm("neo");

    const saved = readJson(join(config.psiPath, "contacts.json"));
    expect(saved.contacts.neo).toEqual({ maw: "white:neo", retired: true });
    expect(stripAnsi(output())).toContain("✓ contact neo retired");
    rmSync(root, { recursive: true, force: true });
  });

  test("falls back to cwd ψ and then cwd psi when config has no psiPath", async () => {
    const withSymbolPsi = mkdtempSync(join(tmpdir(), "maw-contacts-symbol-"));
    config = {};
    mkdirSync(join(withSymbolPsi, "ψ"), { recursive: true });
    process.chdir(withSymbolPsi);

    await cmdContactsAdd("oracle", ["--maw", "fleet:oracle"]);
    expect(readJson(join(withSymbolPsi, "ψ", "contacts.json")).contacts.oracle).toEqual({
      maw: "fleet:oracle",
    });

    const withoutSymbolPsi = mkdtempSync(join(tmpdir(), "maw-contacts-plain-"));
    process.chdir(withoutSymbolPsi);
    resetConsoleCapture();

    await cmdContactsAdd("plain", []);
    expect(readJson(join(withoutSymbolPsi, "psi", "contacts.json")).contacts.plain).toEqual({});

    rmSync(withSymbolPsi, { recursive: true, force: true });
    rmSync(withoutSymbolPsi, { recursive: true, force: true });
  });
});
