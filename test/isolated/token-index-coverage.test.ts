import { beforeEach, describe, expect, mock, test } from "bun:test";

const listPath = import.meta.resolve("../../src/vendor/mpr-plugins/token/list");
const currentPath = import.meta.resolve("../../src/vendor/mpr-plugins/token/current");
const usePath = import.meta.resolve("../../src/vendor/mpr-plugins/token/use");
const savePath = import.meta.resolve("../../src/vendor/mpr-plugins/token/save");
const loadPath = import.meta.resolve("../../src/vendor/mpr-plugins/token/load");
const scanPath = import.meta.resolve("../../src/vendor/mpr-plugins/token/scan");

let throwLabel: string | null = null;

let listResult: Record<string, unknown> = {};
let formattedList = "formatted token list";
let currentResult: string | null = "active-token";
let useResult: Record<string, unknown> = { ok: true, name: "active-token", direnvOk: true };
let saveResult: Record<string, unknown> = { ok: true, path: "envrc/demo" };
let loadResult: Record<string, unknown> = { ok: true, path: "envrc/demo", direnvOk: true };
let scanResult: Record<string, unknown> = { ok: true, rows: [], ghqRoot: "/tmp/ghq" };
let formattedScan = "formatted token scan";

let listCalls: Array<unknown> = [];
let formatListCalls: Array<unknown> = [];
let currentCalls: Array<unknown> = [];
let useCalls: Array<unknown> = [];
let saveCalls: Array<unknown> = [];
let loadCalls: Array<unknown> = [];
let scanCalls: Array<unknown> = [];
let formatScanCalls: Array<unknown> = [];

mock.module(listPath, () => ({
  cmdList: (cwd?: string) => {
    listCalls.push(cwd);
    if (throwLabel === "list") throw new Error("list exploded");
    return listResult;
  },
  formatList: (result: Record<string, unknown>) => {
    formatListCalls.push(result);
    if (throwLabel === "format-list") throw new Error("format list exploded");
    return formattedList;
  },
}));

mock.module(currentPath, () => ({
  cmdCurrent: (cwd?: string) => {
    currentCalls.push(cwd);
    if (throwLabel === "current") throw new Error("current exploded");
    return currentResult;
  },
}));

mock.module(usePath, () => ({
  cmdUse: (opts: Record<string, unknown>) => {
    useCalls.push(opts);
    if (throwLabel === "use") throw new Error("use exploded");
    return useResult;
  },
}));

mock.module(savePath, () => ({
  cmdSave: async (opts: Record<string, unknown>) => {
    saveCalls.push(opts);
    if (throwLabel === "save") throw new Error("save exploded");
    return saveResult;
  },
}));

mock.module(loadPath, () => ({
  cmdLoad: async (opts: Record<string, unknown>) => {
    loadCalls.push(opts);
    if (throwLabel === "load") throw new Error("load exploded");
    return loadResult;
  },
}));

mock.module(scanPath, () => ({
  cmdScan: () => {
    scanCalls.push({});
    if (throwLabel === "scan") throw new Error("scan exploded");
    return scanResult;
  },
  formatScan: (result: Record<string, unknown>) => {
    formatScanCalls.push(result);
    if (throwLabel === "format-scan") throw new Error("format scan exploded");
    return formattedScan;
  },
}));

const { command, default: handler } = await import("../../src/vendor/mpr-plugins/token/index.ts?token-index-coverage");

beforeEach(() => {
  throwLabel = null;

  listResult = {
    ok: true,
    cwd: "/tmp/demo",
    active: "active-token",
    envrcPresent: true,
    tokens: ["active-token", "backup-token"],
    envrcs: ["demo"],
  };
  formattedList = "formatted token list";
  currentResult = "active-token";
  useResult = { ok: true, name: "active-token", direnvOk: true };
  saveResult = { ok: true, path: "envrc/demo" };
  loadResult = { ok: true, path: "envrc/demo", direnvOk: true };
  scanResult = { ok: true, rows: [], ghqRoot: "/tmp/ghq" };
  formattedScan = "formatted token scan";

  listCalls = [];
  formatListCalls = [];
  currentCalls = [];
  useCalls = [];
  saveCalls = [];
  loadCalls = [];
  scanCalls = [];
  formatScanCalls = [];
});

async function invoke(args: string[] | Record<string, unknown>, writer?: (...args: unknown[]) => void) {
  return handler({
    source: Array.isArray(args) ? "cli" : "api",
    args,
    writer,
  } as any);
}

describe("token plugin index", () => {
  test("exports metadata and prints help for non-cli invocation shapes", async () => {
    const writes: string[] = [];
    const result = await invoke({ ignored: true }, (...parts: unknown[]) => {
      writes.push(parts.map(String).join(" "));
    });

    expect(command).toEqual({
      name: "token",
      description:
        "Store and restore .envrc files via pass, and manage active Claude OAuth tokens.",
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("usage: maw token <list|use|current|save|load|scan>");
    expect(writes.join("\n")).toContain("security: token values are never printed");
  });

  test("routes list aliases and respects ctx.writer", async () => {
    const writes: string[] = [];
    let result = await invoke(["ls"], (...parts: unknown[]) => writes.push(parts.map(String).join(" ")));
    expect(result).toEqual({ ok: true, output: "" });
    expect(listCalls).toEqual([undefined]);
    expect(formatListCalls).toEqual([listResult]);
    expect(writes).toEqual([formattedList]);

    result = await invoke(["tokens"]);
    expect(result).toEqual({ ok: true, output: formattedList });

    result = await invoke(["list"]);
    expect(result).toEqual({ ok: true, output: formattedList });
  });

  test("current prints active token name or stays silent when none is active", async () => {
    let result = await invoke(["current"]);
    expect(result).toEqual({ ok: true, output: "active-token" });
    expect(currentCalls).toEqual([undefined]);

    currentResult = null;
    result = await invoke(["current"]);
    expect(result).toEqual({ ok: true, output: "" });
  });

  test("use without a name prints list output plus usage guidance", async () => {
    const result = await invoke(["use"]);

    expect(listCalls).toEqual([undefined]);
    expect(formatListCalls).toEqual([listResult]);
    expect(useCalls).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain(formattedList);
    expect(result.output).toContain("Usage: maw token use <name> [--no-team]");
  });

  test("use forwards flags, surfaces failures, and warns when direnv allow fails", async () => {
    useResult = { ok: true, name: "beta", direnvOk: false };
    let result = await invoke(["use", "beta", "--no-team"]);
    expect(useCalls).toEqual([{ name: "beta", noTeam: true }]);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Now using: beta");
    expect(result.output).toContain("warning: direnv allow failed");

    useResult = { ok: false, error: "token missing" };
    result = await invoke(["use", "ghost"]);
    expect(result).toEqual({ ok: false, error: "token missing", output: "" });
  });

  test("save handles skipped, saved, and failing results", async () => {
    saveResult = { ok: true, skipped: true, path: "envrc/demo" };
    let result = await invoke(["save", "demo", "-f"]);
    expect(saveCalls).toEqual([{ name: "demo", force: true }]);
    expect(result).toEqual({ ok: true, output: "Skipped (would overwrite envrc/demo)" });

    saveResult = { ok: true, path: "envrc/demo" };
    result = await invoke(["save", "demo", "--force"]);
    expect(saveCalls.at(-1)).toEqual({ name: "demo", force: true });
    expect(result).toEqual({ ok: true, output: "Saved .envrc as envrc/demo" });

    saveResult = { ok: false, error: "save failed" };
    result = await invoke(["save"]);
    expect(result).toEqual({ ok: false, error: "save failed", output: "" });
  });

  test("load handles skipped, saved, failing, and direnv warning branches", async () => {
    loadResult = { ok: true, skipped: true, path: "envrc/demo" };
    let result = await invoke(["load", "demo", "-f"]);
    expect(loadCalls).toEqual([{ name: "demo", force: true }]);
    expect(result).toEqual({ ok: true, output: "Skipped (would overwrite .envrc; envrc/demo)" });

    loadResult = { ok: true, path: "envrc/demo", direnvOk: false };
    result = await invoke(["load", "demo", "--force"]);
    expect(loadCalls.at(-1)).toEqual({ name: "demo", force: true });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Loaded envrc/demo into .envrc");
    expect(result.output).toContain("warning: direnv allow failed");

    loadResult = { ok: false, error: "load failed" };
    result = await invoke(["load"]);
    expect(result).toEqual({ ok: false, error: "load failed", output: "" });
  });

  test("scan formats successful and failing scan results", async () => {
    scanResult = { ok: true, rows: [{ label: "~", tokenName: "main", method: "named" }], ghqRoot: "/tmp/ghq" };
    let result = await invoke(["scan"]);
    expect(scanCalls).toEqual([{}]);
    expect(formatScanCalls).toEqual([scanResult]);
    expect(result).toEqual({ ok: true, output: formattedScan });

    scanResult = { ok: false, rows: [], ghqRoot: null, error: "ghq missing" };
    result = await invoke(["scan"]);
    expect(result).toEqual({ ok: false, error: "ghq missing", output: formattedScan });
  });

  test("unknown subcommands print help and return a structured error", async () => {
    const result = await invoke(["bogus"]);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("maw token: unknown subcommand \"bogus\" (expected list|use|current|save|load|scan)");
    expect(result.output).toContain("aliases:");
  });

  test("caught dispatcher exceptions are returned without leaking extra output", async () => {
    throwLabel = "format-list";
    const result = await invoke(["list"]);
    expect(result).toEqual({ ok: false, error: "format list exploded", output: undefined });
  });
});
