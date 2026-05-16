import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const wakeCmdSrc = readFileSync(join(import.meta.dir, "../../src/commands/shared/wake-cmd.ts"), "utf8");

describe("wake --list readonly preview (#1563)", () => {
  test("handles listWt before tmux session detection or respawn side effects", () => {
    const listIdx = wakeCmdSrc.indexOf("if (opts.listWt)");
    const detectIdx = wakeCmdSrc.indexOf("let session = preResolvedSession");
    const setEnvIdx = wakeCmdSrc.indexOf("await setSessionEnv(session)");
    const newSessionIdx = wakeCmdSrc.indexOf("await tmux.newSession");
    const newWindowIdx = wakeCmdSrc.indexOf("await tmux.newWindow(session");

    expect(listIdx).toBeGreaterThan(-1);
    expect(detectIdx).toBeGreaterThan(-1);
    expect(listIdx).toBeLessThan(detectIdx);
    expect(listIdx).toBeLessThan(setEnvIdx);
    expect(listIdx).toBeLessThan(newSessionIdx);
    expect(listIdx).toBeLessThan(newWindowIdx);
    expect(wakeCmdSrc.indexOf("if (opts.listWt)", listIdx + 1)).toBe(-1);
  });
});
