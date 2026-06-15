import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const realSdk = await import("../../src/sdk/index.ts");
afterAll(() => { mock.restore(); });

const root = join(import.meta.dir, "../..");
const attachCalls: unknown[] = [];
const spawnCalls: Array<{ command: string; args: string[]; opts: Record<string, unknown> }> = [];
let spawnResult: { status?: number | null; signal?: string | null; error?: Error } = { status: 0 };

class MockSshAttachError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SshAttachError";
  }
}

mock.module("maw-js/sdk", () => ({
  ...realSdk,
  SshAttachError: MockSshAttachError,
  attachRemoteSession: (opts: unknown) => {
    attachCalls.push(opts);
  },
}));

mock.module("child_process", () => ({
  spawnSync: (command: string, args: string[], opts: Record<string, unknown>) => {
    spawnCalls.push({ command, args, opts });
    return spawnResult;
  },
}));

const attachSsh = (await import("../../src/vendor/mpr-plugins/attach-ssh/index.ts?plugin-attach-ssh-standalone")).default;

const target = {
  tier: 3 as const,
  sessionName: "alpha-pane",
  node: "m5",
  peerUrl: "http://m5.local",
  sshAlias: "m5-ssh",
};

beforeEach(() => {
  attachCalls.length = 0;
  spawnCalls.length = 0;
  spawnResult = { status: 0 };
});

describe("attach-ssh plugin standalone boundary (#2223)", () => {
  test("uses only SDK plus platform dependencies, with no core/shared/lib imports", () => {
    const source = readFileSync(join(root, "src/vendor/mpr-plugins/attach-ssh/index.ts"), "utf8");
    expect(source).toContain('from "maw-js/sdk"');
    expect(source).toContain('from "child_process"');
    expect(source).not.toMatch(/maw-js\/(?:core|commands\/shared|lib|config|plugin)(?:\/|")/);
    expect(source).not.toMatch(/from\s+["'](?:\.\.\/)+/);
  });

  test("manifest advertises an attach strategy capability", async () => {
    const manifest = JSON.parse(await Bun.file(join(root, "src/vendor/mpr-plugins/attach-ssh/plugin.json")).text());
    expect(manifest).toMatchObject({
      name: "attach-ssh",
      entry: "./index.ts",
      capabilities: ["attach:strategy"],
      strategy: { tier: 3 },
    });
  });

  test("default probe uses ssh preflight then delegates through the SDK boundary", async () => {
    await attachSsh.execute(target);

    expect(spawnCalls).toEqual([
      {
        command: "ssh",
        args: ["-o", "ConnectTimeout=3", "-o", "BatchMode=yes", "m5-ssh", "true"],
        opts: { timeout: 4000, stdio: "ignore" },
      },
    ]);
    expect(attachCalls).toEqual([{ node: "m5", sshAlias: "m5-ssh", sessionName: "alpha-pane" }]);
  });

  test("default probe reports unreachable aliases without invoking attach", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
    try {
      spawnResult = { status: 255 };
      await expect(attachSsh.execute(target)).rejects.toThrow("ssh m5-ssh unreachable in 3s");
    } finally {
      console.error = originalError;
    }

    expect(attachCalls).toEqual([]);
    expect(errors.join("\n")).toContain("check ~/.ssh/config for 'Host m5-ssh'");
    expect(errors.join("\n")).toContain("ssh m5-ssh.wg");
  });

  test("friendly SDK attach errors are preserved", async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
    try {
      await expect(attachSsh.execute(target, {
        probe: () => ({ ok: true }),
        ssh: () => { throw new MockSshAttachError("ssh attach blocked"); },
      })).rejects.toThrow("ssh attach blocked");
    } finally {
      console.error = originalError;
    }

    expect(errors).toEqual(["ssh attach blocked"]);
  });
});
