import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "path";

const root = join(import.meta.dir, "../../src");
const calls: string[] = [];

mock.module("maw-js/config", () => ({
  loadConfig: () => ({ githubOrg: "TestOrg" }),
}));

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => "/ghq",
}));

mock.module("maw-js/commands/shared/wake-target", () => ({
  parseWakeTarget: () => null,
  ensureCloned: async () => {
    calls.push("ensureCloned");
  },
}));

mock.module("maw-js/core/matcher/normalize-target", () => ({
  normalizeTarget: (target: string) => target,
}));

mock.module("maw-js/core/fleet/validate", () => ({
  assertValidOracleName: () => undefined,
}));

mock.module("maw-js/sdk", () => ({
  FLEET_DIR: "/fleet",
  hostExec: async (cmd: string) => {
    calls.push(`hostExec:${cmd}`);
    throw new Error(`hostExec should not be needed in this test: ${cmd}`);
  },
}));

mock.module("maw-js/core/fleet/leaf", () => ({
  writeSignal: () => {
    calls.push("writeSignal");
  },
}));

mock.module("maw-js/core/fleet/nicknames", () => ({
  validateNickname: (value: string) => ({ ok: true, value }),
  writeNickname: () => {
    calls.push("writeNickname");
  },
  setCachedNickname: () => {
    calls.push("setCachedNickname");
  },
}));

mock.module(join(root, "vendor/mpr-plugins/bud/smart-default-org"), () => ({
  resolveOrg: async () => ({ org: "TestOrg", source: "flag" }),
  formatOrgSource: () => "flag",
}));

mock.module(join(root, "vendor/mpr-plugins/bud/bud-repo"), () => ({
  ensureBudRepo: async () => {
    calls.push("ensureBudRepo");
    return "/tmp/testscaffold-oracle";
  },
}));

mock.module(join(root, "vendor/mpr-plugins/bud/bud-init"), () => ({
  initVault: () => {
    calls.push("initVault");
    return "/tmp/testscaffold-oracle/ψ";
  },
  generateClaudeMd: () => {
    calls.push("generateClaudeMd");
  },
  configureFleet: () => {
    calls.push("configureFleet");
    return "/fleet/01-testscaffold.json";
  },
  writeBirthNote: () => {
    calls.push("writeBirthNote");
  },
}));

mock.module(join(root, "vendor/mpr-plugins/bud/bud-wake"), () => ({
  finalizeBud: async () => {
    calls.push("finalizeBud");
  },
}));

const { cmdBud } = await import("../../src/vendor/mpr-plugins/bud/impl");

async function withCapturedLogs(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
  }
  return logs.join("\n");
}

describe("maw scaffold / bud --scaffold-only (#1551)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  test("scaffold-only creates the skeleton then stops before lifecycle side effects", async () => {
    const output = await withCapturedLogs(() => cmdBud("testscaffold", {
      root: true,
      org: "TestOrg",
      scaffoldOnly: true,
      note: "structure only",
      signalOnBirth: true,
    }));

    expect(calls).toContain("ensureBudRepo");
    expect(calls).toContain("initVault");
    expect(calls).toContain("generateClaudeMd");
    expect(calls).toContain("configureFleet");
    expect(calls).toContain("writeBirthNote");
    expect(calls).not.toContain("finalizeBud");
    expect(calls).not.toContain("writeSignal");
    expect(output).toContain("Scaffold complete");
    expect(output).toContain("skipped: git commit/push, wake, attach, parent sync_peers, /awaken");
  });

  test("normal bud still continues into finalizeBud", async () => {
    await withCapturedLogs(() => cmdBud("testnormal", { root: true, org: "TestOrg" }));

    expect(calls).toContain("ensureBudRepo");
    expect(calls).toContain("configureFleet");
    expect(calls).toContain("finalizeBud");
  });

  test("dry-run scaffold describes the stop point instead of wake/sync side effects", async () => {
    const output = await withCapturedLogs(() =>
      cmdBud("testdry", {
        from: "mawjs",
        org: "TestOrg",
        dryRun: true,
        scaffoldOnly: true,
      }),
    );

    expect(output).toContain("scaffold-only");
    expect(output).toContain("would stop before git commit/push");
    expect(output).not.toContain("would wake testdry");
    expect(output).not.toContain("would add testdry to mawjs");
    expect(calls).not.toContain("ensureBudRepo");
    expect(calls).not.toContain("finalizeBud");
  });
});
