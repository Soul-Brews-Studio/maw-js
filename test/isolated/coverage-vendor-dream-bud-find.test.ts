import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "path";

// Reset process-wide mocks before importing real modules for this file.
mock.restore();

const realSdk = await import("../../src/sdk");

const tempRoot = mkdtempSync(join(tmpdir(), "maw-find-coverage-"));
const ghqRoot = join(tempRoot, "ghq");
const reposRoot = join(ghqRoot, "github.com");

interface FleetSession {
  name: string;
  windows: Array<{ name: string; repo?: string }>;
  sync_peers?: string[];
  project_repos?: string[];
}

let mockedFleet: FleetSession[] = [];
let searchFiles = new Map<string, string[]>();
let matchLines = new Map<string, string>();
let hostExecCalls: string[] = [];
let logs: string[] = [];

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => ghqRoot,
}));

const fleetLoadMock = () => ({
  loadFleet: () => mockedFleet,
  loadFleetCore: () => mockedFleet,
  loadFleetEntries: () => mockedFleet,
  loadDisabledFleetEntries: () => [],
  fleetDirForWrite: () => join(tempRoot, "fleet"),
  resolveFleetSession: () => null,
});
mock.module("maw-js/commands/shared/fleet-load", fleetLoadMock);

const sdkMock = () => ({
  ...realSdk,
  loadFleetCore: () => mockedFleet,
  getGhqRoot: () => ghqRoot,
  hostExec: async (command: string) => {
    hostExecCalls.push(command);

    if (command.includes("grep -ril")) {
      for (const [psiPath, files] of searchFiles) {
        if (command.includes(shSingleQuote(psiPath))) return files.join("\n");
      }
      return "";
    }

    if (command.includes("grep -m1 -i")) {
      for (const [file, line] of matchLines) {
        if (command.includes(shSingleQuote(file))) return line;
      }
      return "";
    }

    throw new Error(`unexpected hostExec command: ${command}`);
  },
});
mock.module("maw-js/sdk", sdkMock);

const { cmdFind } = await import("../../src/vendor/mpr-plugins/find/impl.ts?coverage-vendor-dream-bud-find");

const originalLog = console.log;

beforeEach(() => {
  mockedFleet = [];
  searchFiles = new Map<string, string[]>();
  matchLines = new Map<string, string>();
  hostExecCalls = [];
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
});

afterAll(() => {
  mock.restore();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("find impl fleet psi coverage", () => {
  test("searches fleet repo psi memory and renders overflow when more than ten code matches exist", async () => {
    const orgPath = join(reposRoot, "Soul-Brews-Studio");
    const repoPath = join(orgPath, "alpha-oracle");
    const psiPath = join(repoPath, "ψ", "memory");
    const localPsi = join(process.cwd(), "ψ", "memory");
    const expectedGrepCommands = [
      `grep -ril ${shSingleQuote("needle")} ${shSingleQuote(psiPath)} 2>/dev/null || true`,
    ];
    if (existsSync(localPsi) && localPsi !== psiPath) {
      expectedGrepCommands.push(`grep -ril ${shSingleQuote("needle")} ${shSingleQuote(localPsi)} 2>/dev/null || true`);
    }
    const files = Array.from({ length: 12 }, (_, index) => join(psiPath, "notes", `hit-${index}.md`));

    mkdirSync(psiPath, { recursive: true });
    searchFiles.set(psiPath, files);
    for (const [index, file] of files.entries()) {
      matchLines.set(file, `needle line ${index}`);
    }
    mockedFleet = [
      {
        name: "101-alpha",
        windows: [{ name: "shell", repo: "Soul-Brews-Studio/alpha-oracle" }],
      },
    ];

    await cmdFind("needle");

    const output = logs.join("\n");
    expect(output).toContain("── Code ──");
    expect(output).toContain("alpha");
    expect(output).toContain("(12 matches)");
    expect(output).toContain("notes/hit-0.md");
    expect(output).toContain("needle line 0");
    expect(output).toContain("... and 2 more");
    expect(output).toContain("12 match(es)");
    expect(output).toContain("— 12 code");
    expect(hostExecCalls.filter((command) => command.includes("grep -ril"))).toEqual(expectedGrepCommands);
    expect(hostExecCalls.filter((command) => command.includes("grep -m1 -i"))).toHaveLength(12);
  });
});
