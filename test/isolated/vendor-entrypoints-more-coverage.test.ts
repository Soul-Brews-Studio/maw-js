/** Isolated coverage for thin/absent vendor plugin entry modules. */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const whoamiImplPath = import.meta.resolve("../../src/vendor/mpr-plugins/whoami/impl");
const tokenLibPath = import.meta.resolve("../../src/vendor/mpr-plugins/token/lib");

let whoamiMode: "ok" | "stderr" | "throw" = "ok";
let whoamiCalls = 0;

mock.module(whoamiImplPath, () => ({
  cmdWhoami: async () => {
    whoamiCalls += 1;
    if (whoamiMode === "throw") throw new Error("tmux missing");
    if (whoamiMode === "stderr") console.error("session-from-stderr");
    else console.log("session-from-stdout");
  },
}));

let envrcPresent = true;
let envrcContent = "export SECRET=shh\n";
let passAlreadyExists = false;
let confirmAnswer = true;
let runResult: { ok: boolean; exitCode?: number } = { ok: true, exitCode: 0 };
let existsCalls: string[] = [];
let readCalls: Array<{ path: string; encoding: string }> = [];
let confirmCalls: string[] = [];
let passExistsCalls: string[] = [];
let runCalls: Array<{ cmd: string[]; opts: { stdin?: string } }> = [];

mock.module("fs", () => ({
  existsSync: (path: string) => {
    existsCalls.push(path);
    return envrcPresent;
  },
  readFileSync: (path: string, encoding: string) => {
    readCalls.push({ path, encoding });
    return envrcContent;
  },
}));

mock.module(tokenLibPath, () => ({
  PASS_PREFIX: "envrc",
  confirm: async (message: string) => {
    confirmCalls.push(message);
    return confirmAnswer;
  },
  defaultName: (name: string | undefined, cwd: string) => name ?? cwd.split("/").filter(Boolean).at(-1) ?? "default",
  passExists: (path: string) => {
    passExistsCalls.push(path);
    return passAlreadyExists;
  },
  run: (cmd: string[], opts: { stdin?: string } = {}) => {
    runCalls.push({ cmd, opts });
    return runResult;
  },
}));

const whoami = await import("../../src/vendor/mpr-plugins/whoami/index.ts?vendor-entrypoints-more-coverage");
const tokenSave = await import("../../src/vendor/mpr-plugins/token/save.ts?vendor-entrypoints-more-coverage");
const oracleSkills = await import("../../src/vendor/mpr-plugins/oracle-skills/index.ts?vendor-entrypoints-more-coverage");

const originalSpawnSync = Bun.spawnSync;

function writer() {
  const lines: string[] = [];
  return {
    lines,
    fn: (...parts: unknown[]) => lines.push(parts.map(String).join(" ")),
  };
}

beforeEach(() => {
  whoamiMode = "ok";
  whoamiCalls = 0;

  envrcPresent = true;
  envrcContent = "export SECRET=shh\n";
  passAlreadyExists = false;
  confirmAnswer = true;
  runResult = { ok: true, exitCode: 0 };
  existsCalls = [];
  readCalls = [];
  confirmCalls = [];
  passExistsCalls = [];
  runCalls = [];

  (Bun as any).spawnSync = originalSpawnSync;
});

afterEach(() => {
  (Bun as any).spawnSync = originalSpawnSync;
});

describe("whoami vendor entrypoint", () => {
  test("exports command metadata and routes console output through ctx.writer", async () => {
    expect(whoami.command).toEqual({ name: "whoami", description: "Print the current tmux session name." });

    const out = writer();
    await expect(whoami.default({ source: "cli", args: [], writer: out.fn } as any)).resolves.toEqual({
      ok: true,
      output: undefined,
    });
    expect(whoamiCalls).toBe(1);
    expect(out.lines).toEqual(["session-from-stdout"]);
  });

  test("buffers stderr output and prefers captured logs on failure", async () => {
    whoamiMode = "stderr";
    await expect(whoami.default({ source: "api", args: {} } as any)).resolves.toEqual({
      ok: true,
      output: "session-from-stderr",
    });

    whoamiMode = "throw";
    await expect(whoami.default({ source: "cli", args: [] } as any)).resolves.toEqual({
      ok: false,
      error: "tmux missing",
      output: undefined,
    });
  });
});

describe("token save entry module", () => {
  test("reports missing .envrc before checking pass or reading secrets", async () => {
    envrcPresent = false;

    await expect(tokenSave.cmdSave({ cwd: "/tmp/oracle" })).resolves.toEqual({
      ok: false,
      error: "no .envrc in current directory",
    });
    expect(existsCalls).toEqual(["/tmp/oracle/.envrc"]);
    expect(passExistsCalls).toEqual([]);
    expect(readCalls).toEqual([]);
    expect(runCalls).toEqual([]);
  });

  test("skips overwrite when pass entry exists and confirmation is declined", async () => {
    passAlreadyExists = true;
    confirmAnswer = false;

    await expect(tokenSave.cmdSave({ cwd: "/tmp/oracle" })).resolves.toEqual({
      ok: true,
      skipped: true,
      path: "envrc/oracle",
    });
    expect(passExistsCalls).toEqual(["envrc/oracle"]);
    expect(confirmCalls).toEqual(["Overwrite envrc/oracle?"]);
    expect(readCalls).toEqual([]);
    expect(runCalls).toEqual([]);
  });

  test("writes .envrc through stdin, honors explicit names/force, and masks pass failure output", async () => {
    envrcContent = "export SECRET=super-secret\n";
    passAlreadyExists = true;

    await expect(tokenSave.cmdSave({ cwd: "/tmp/oracle", name: "custom", force: true })).resolves.toEqual({
      ok: true,
      path: "envrc/custom",
    });
    expect(confirmCalls).toEqual([]);
    expect(readCalls).toEqual([{ path: "/tmp/oracle/.envrc", encoding: "utf-8" }]);
    expect(runCalls).toEqual([
      {
        cmd: ["pass", "insert", "--multiline", "--force", "envrc/custom"],
        opts: { stdin: "export SECRET=super-secret\n" },
      },
    ]);
    expect(runCalls[0].cmd.join(" ")).not.toContain("super-secret");

    runCalls = [];
    readCalls = [];
    runResult = { ok: false, exitCode: 17 };
    await expect(tokenSave.cmdSave({ cwd: "/tmp/oracle", name: "custom", assumeYes: true })).resolves.toEqual({
      ok: false,
      error: "pass insert failed (exit 17)",
    });
    expect(runCalls[0].opts.stdin).toBe("export SECRET=super-secret\n");
  });
});

describe("oracle-skills vendor entrypoint", () => {
  test("exports command metadata and forwards only CLI args with inherited stdio", async () => {
    const spawnCalls: Array<{ cmd: string[]; opts: Record<string, unknown> }> = [];
    (Bun as any).spawnSync = (cmd: string[], opts: Record<string, unknown>) => {
      spawnCalls.push({ cmd, opts });
      return { exitCode: 0 };
    };

    expect(oracleSkills.command.name).toBe("oracle-skills");
    await expect(oracleSkills.default({ source: "cli", args: ["list", "--json"] } as any)).resolves.toEqual({ ok: true, output: "" });
    await expect(oracleSkills.default({ source: "api", args: ["ignored"] } as any)).resolves.toEqual({ ok: true, output: "" });

    expect(spawnCalls).toEqual([
      {
        cmd: ["arra-oracle-skills", "list", "--json"],
        opts: { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
      },
      {
        cmd: ["arra-oracle-skills"],
        opts: { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
      },
    ]);
  });

  test("returns install hint on spawn failure and propagates non-zero exit codes", async () => {
    (Bun as any).spawnSync = () => {
      throw new Error("ENOENT");
    };
    const missing = await oracleSkills.default({ source: "cli", args: ["help"] } as any);
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("arra-oracle-skills not found on $PATH");
    expect(missing.output).toBe("");

    (Bun as any).spawnSync = () => ({ exitCode: 23 });
    await expect(oracleSkills.default({ source: "cli", args: ["sync"] } as any)).resolves.toEqual({
      ok: false,
      error: "arra-oracle-skills exited with code 23",
      output: "",
    });
  });
});
