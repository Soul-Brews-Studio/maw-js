import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join, resolve } from "path";

const realFs = await import("fs");
const realSdk = await import("../../src/sdk");

const repoRoot = process.cwd();
const ghqRoot = resolve(repoRoot, "../../../..");
const reposRoot = join(ghqRoot, "github.com");

interface FleetSession {
  name: string;
  windows: Array<{ name: string; repo?: string }>;
  sync_peers?: string[];
  project_repos?: string[];
}

type DirEntryLike = { name: string; isDirectory: () => boolean };

let mockedFleet: FleetSession[] = [];
let existingPaths = new Set<string>();
let readdirEntries = new Map<string, DirEntryLike[]>();
let searchFiles = new Map<string, string[]>();
let matchLines = new Map<string, string>();
let hostExecCalls: string[] = [];
let logs: string[] = [];

function dir(name: string): DirEntryLike {
  return { name, isDirectory: () => true };
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

mock.module("fs", () => ({
  ...realFs,
  existsSync: (path: string) => existingPaths.has(path),
  readdirSync: (path: string) => (readdirEntries.get(path) ?? []) as ReturnType<typeof realFs.readdirSync>,
}));

mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => ghqRoot,
}));

mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleet: () => mockedFleet,
}));

mock.module("maw-js/sdk", () => ({
  ...realSdk,
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
}));

const { cmdFind } = await import("../../src/vendor/mpr-plugins/find/impl.ts?coverage-vendor-dream-bud-find");

const originalLog = console.log;

beforeEach(() => {
  mockedFleet = [];
  existingPaths = new Set<string>();
  readdirEntries = new Map<string, DirEntryLike[]>();
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

describe("find impl fleet psi coverage", () => {
  test("searches fleet repo psi memory and renders overflow when more than ten code matches exist", async () => {
    const orgPath = join(reposRoot, "Soul-Brews-Studio");
    const repoPath = join(orgPath, "alpha-oracle");
    const psiPath = join(repoPath, "ψ", "memory");
    const files = Array.from({ length: 12 }, (_, index) => join(psiPath, "notes", `hit-${index}.md`));

    readdirEntries.set(reposRoot, [dir("Soul-Brews-Studio")]);
    readdirEntries.set(orgPath, []);
    existingPaths.add(psiPath);
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
    expect(hostExecCalls.filter((command) => command.includes("grep -ril"))).toEqual([
      `grep -ril ${shSingleQuote("needle")} ${shSingleQuote(psiPath)} 2>/dev/null || true`,
    ]);
    expect(hostExecCalls.filter((command) => command.includes("grep -m1 -i"))).toHaveLength(12);
  });
});
