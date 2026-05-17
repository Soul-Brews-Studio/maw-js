/**
 * Focused isolated coverage for src/commands/shared/fleet-wake.ts failure paths.
 */
import { describe, expect, test } from "bun:test";
import { join } from "path";
import { addRepo, cmdWakeAll, ghqRoot, HostExecError, state } from "../helpers/fleet-wake-harness";

describe("cmdWakeAll fail-soft cases", () => {
  test("throws a clear error when the first window cwd is missing", async () => {
    state.fleet = [{ name: "01-bad", windows: [{ name: "bad-oracle", repo: "missing-repo" }] }];
    await expect(cmdWakeAll()).rejects.toThrow(/refusing to spawn 01-bad/);
    expect(state.captured).toContain("hasSession 01-bad");
    expect(state.captured.some(c => c.startsWith("newSession 01-bad"))).toBe(false);
  });

  test("skips missing secondary window cwd while still waking the session", async () => {
    state.fleet = [{ name: "01-partial", windows: [{ name: "partial-oracle", repo: "partial" }, { name: "partial-missing", repo: "partial-missing" }] }];
    addRepo("partial");
    await cmdWakeAll();
    expect(state.captured).toContain(`newSession 01-partial partial-oracle ${join(ghqRoot, "partial")}`);
    expect(state.captured.some(c => c.startsWith("newWindow 01-partial:partial-missing"))).toBe(false);
    expect(state.captured).toContain("selectWindow 01-partial:1");
  });

  test("ssh transport errors during secondary window creation produce a remote-skip warning", async () => {
    state.fleet = [
      { name: "01-remote-window", windows: [{ name: "remote-oracle", repo: "remote" }, { name: "remote-tools", repo: "remote-tools" }] },
      { name: "02-local", windows: [{ name: "local-oracle", repo: "local" }] },
    ];
    addRepo("remote");
    addRepo("remote-tools");
    addRepo("local");
    state.newWindowThrows = new Map([[
      "01-remote-window:remote-tools",
      new HostExecError("white", "ssh", new Error("ssh unavailable"), 255),
    ]]);

    await cmdWakeAll();

    expect(state.captured).toContain(`newWindow 01-remote-window:remote-tools ${join(ghqRoot, "remote-tools")}`);
    expect(state.captured).toContain(`newSession 02-local local-oracle ${join(ghqRoot, "local")}`);
    expect(state.captured).not.toContain("selectWindow 01-remote-window:1");
    expect(state.captured).toContain("selectWindow 02-local:1");
  });

  test("ssh transport errors from verification and restore are skipped", async () => {
    state.fleet = [{ name: "01-remote", windows: [{ name: "remote-oracle", repo: "remote" }] }];
    addRepo("remote");
    const sshError = new HostExecError("white", "ssh", new Error("ssh unavailable"), 255);
    state.ensureThrows = sshError;
    state.restoreThrows = new Map([["01-remote", sshError]]);

    await cmdWakeAll();

    expect(state.captured).toContain("ensureSessionRunning 01-remote");
    expect(state.captured).toContain("restoreTabOrder 01-remote");
  });
});
