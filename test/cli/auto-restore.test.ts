import { describe, it, expect, beforeEach, afterEach } from "bun:test";

describe("maybeAutoRestore (hint mode)", () => {
  let logged: string[];
  const origLog = console.log;
  const origWrite = process.stdout.write;
  const origStdinTTY = process.stdin.isTTY;
  const origStdoutTTY = process.stdout.isTTY;

  beforeEach(() => {
    logged = [];
    console.log = (...args: any[]) => logged.push(args.join(" "));
    (process.stdout as any).write = (s: string) => logged.push(s);
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    console.log = origLog;
    (process.stdout as any).write = origWrite;
    Object.defineProperty(process.stdin, "isTTY", { value: origStdinTTY, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: origStdoutTTY, configurable: true });
  });

  it("skips for --help", async () => {
    const { maybeAutoRestore } = await import("../../src/cli/auto-restore");
    await maybeAutoRestore("--help");
    expect(logged).toEqual([]);
  });

  it("skips for diagnostic commands", async () => {
    const { maybeAutoRestore } = await import("../../src/cli/auto-restore");
    for (const cmd of ["capture", "locate", "messages", "oracle", "peek"]) {
      logged = [];
      await maybeAutoRestore(cmd);
      expect(logged).toEqual([]);
    }
  });

  it("skips when MAW_NO_PROMPT is set", async () => {
    process.env.MAW_NO_PROMPT = "1";
    try {
      const { maybeAutoRestore } = await import("../../src/cli/auto-restore");
      await maybeAutoRestore("ls");
      expect(logged).toEqual([]);
    } finally {
      delete process.env.MAW_NO_PROMPT;
    }
  });

  it("never opens /dev/tty (no blocking read)", async () => {
    const src = await Bun.file("src/cli/auto-restore.ts").text();
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    expect(code).not.toContain("openSync");
    expect(code).not.toContain("readSync");
    expect(code).not.toContain('"/dev/tty"');
  });

  it("does not contain Restore all? prompt", async () => {
    const src = await Bun.file("src/cli/auto-restore.ts").text();
    expect(src).not.toContain("Restore all?");
    expect(src).not.toContain("[y/N]");
  });

  it("contains hint text for maw wake", async () => {
    const src = await Bun.file("src/cli/auto-restore.ts").text();
    expect(src).toContain("maw wake");
  });
});
