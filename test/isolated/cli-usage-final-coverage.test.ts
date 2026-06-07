import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type FakePlugin = {
  disabled?: boolean;
  manifest: {
    weight?: number;
    description?: string;
    cli?: { command?: string };
  };
};

let packages: FakePlugin[] = [];
let discoverThrows = false;
let logs: string[] = [];

const realRegistry = await import("../../src/plugin/registry");

mock.module("../../src/plugin/registry", () => ({
  ...realRegistry,
  discoverPackages: () => {
    if (discoverThrows) throw new Error("registry unavailable");
    return packages;
  },
}));

const { formatUsage, usage } = await import("../../src/cli/usage.ts?final-coverage");

const originalLog = console.log;

function plugin(command: string, weight: number, description = `${command} description`): FakePlugin {
  return {
    manifest: {
      weight,
      description,
      cli: { command },
    },
  };
}

beforeEach(() => {
  packages = [];
  discoverThrows = false;
  logs = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
});

afterEach(() => {
  console.log = originalLog;
});

describe("cli usage final coverage", () => {
  test("core-tier usage inserts direct alias rows before the active command count", () => {
    const rendered = formatUsage([plugin("brew", 0)]);

    expect(rendered).toContain("core");
    expect(rendered).toContain("maw brew");
    expect(rendered).toContain("maw ls");
    expect(rendered).toContain("commands active");
  });

  test("usage prints discovered packages and falls back when discovery throws", () => {
    packages = [plugin("brew", 0)];
    usage();
    expect(logs.join("\n")).toContain("maw brew");

    logs = [];
    discoverThrows = true;
    usage();
    expect(logs.join("\n")).toContain("maw plugin ls");
  });
});
