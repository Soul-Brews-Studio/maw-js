import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const wakeCmdSrc = readFileSync(join(import.meta.dir, "../../src/commands/shared/wake-cmd.ts"), "utf8");

describe("wake --list readonly preview (#1563)", () => {
  test("handles listWt before tmux session detection or respawn side effects", () => {
    const cmdWakeIdx = wakeCmdSrc.indexOf("export async function cmdWake");
    const cmdWakeSrc = wakeCmdSrc.slice(cmdWakeIdx);
    const listIdx = cmdWakeSrc.indexOf("if (opts.listWt)");
    const detectIdx = cmdWakeSrc.indexOf("let session = foreignSession || preResolvedSession");
    const setEnvIdx = cmdWakeSrc.indexOf("await setSessionEnv(session)");
    const newSessionIdx = cmdWakeSrc.indexOf("await tmux.newSession");
    const newWindowIdx = cmdWakeSrc.indexOf("await tmux.newWindow(session");

    expect(cmdWakeIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeGreaterThan(-1);
    expect(detectIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeLessThan(detectIdx);
    expect(listIdx).toBeLessThan(setEnvIdx);
    expect(listIdx).toBeLessThan(newSessionIdx);
    expect(listIdx).toBeLessThan(newWindowIdx);
    expect(cmdWakeSrc.indexOf("if (opts.listWt)", listIdx + 1)).toBe(-1);
  });
});
