import { describe, expect, test } from "bun:test";

const {
  attachRemoteSession,
  SshAttachError,
} = await import("../../src/core/transport/ssh-attach.ts?ssh-attach-helper");

describe("ssh attach transport helper", () => {
  test("attaches to a remote tmux session through ssh with inherited stdio", () => {
    const calls: unknown[] = [];

    attachRemoteSession({
      node: "alpha",
      sshAlias: "alpha@white.wg",
      sessionName: "volt-oracle",
      spawnSync: ((cmd: string[], opts: unknown) => {
        calls.push({ cmd, opts });
        return { exitCode: 0 } as ReturnType<typeof Bun.spawnSync>;
      }) as typeof Bun.spawnSync,
    });

    expect(calls).toEqual([{
      cmd: ["ssh", "-tt", "alpha@white.wg", "tmux attach-session -t 'volt-oracle'"],
      opts: { stdio: ["inherit", "inherit", "inherit"] },
    }]);
  });

  test("rejects unsafe tmux session names before invoking ssh", () => {
    const calls: unknown[] = [];

    expect(() => attachRemoteSession({
      node: "alpha",
      sshAlias: "alpha@white.wg",
      sessionName: "bad;rm",
      spawnSync: ((cmd: string[], opts: unknown) => {
        calls.push({ cmd, opts });
        return { exitCode: 0 } as ReturnType<typeof Bun.spawnSync>;
      }) as typeof Bun.spawnSync,
    })).toThrow(SshAttachError);

    expect(calls).toEqual([]);
  });

  test("surfaces nonzero ssh exit as a friendly attach error", () => {
    expect(() => attachRemoteSession({
      node: "alpha",
      sshAlias: "alpha@white.wg",
      sessionName: "volt-oracle",
      spawnSync: (() => ({ exitCode: 255 }) as ReturnType<typeof Bun.spawnSync>) as typeof Bun.spawnSync,
    })).toThrow("ssh attach to alpha (alpha@white.wg) failed with exit 255");
  });
});
