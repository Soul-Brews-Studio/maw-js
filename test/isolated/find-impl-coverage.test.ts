import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join, resolve } from "path";

const realFs = await import("fs");
const realSdk = await import("../../src/sdk");

const repoRoot = process.cwd();
const ghqRoot = resolve(repoRoot, "../../../..");
const reposRoot = join(ghqRoot, "github.com");
const localPsi = join(repoRoot, "ψ", "memory");

interface FleetSession {
  name: string;
  windows: Array<{ name: string; repo?: string }>;
  sync_peers?: string[];
  project_repos?: string[];
}

type DirEntryLike = { name: string; isDirectory: () => boolean };

let mockedFleet: FleetSession[] = [];
let mockedGhqRoot = ghqRoot;
let existingPaths = new Set<string>();
let readdirEntries = new Map<string, DirEntryLike[]>();
let readdirErrors = new Map<string, Error>();
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

await mock.module("fs", () => ({
  ...realFs,
  existsSync: (path: string) => existingPaths.has(path),
  readdirSync: (path: string, _opts?: unknown) => {
    const error = readdirErrors.get(path);
    if (error) throw error;
    return (readdirEntries.get(path) ?? []) as ReturnType<typeof realFs.readdirSync>;
  },
}));

await mock.module("maw-js/config/ghq-root", () => ({
  getGhqRoot: () => mockedGhqRoot,
}));

await mock.module("maw-js/commands/shared/fleet-load", () => ({
  loadFleet: () => mockedFleet,
}));

await mock.module("maw-js/sdk", () => ({
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

const { cmdFind } = await import("../../src/vendor/mpr-plugins/find/impl.ts?find-impl-coverage");

const originalConsoleLog = console.log;

beforeEach(() => {
  mockedFleet = [];
  mockedGhqRoot = ghqRoot;
  existingPaths = new Set<string>();
  readdirEntries = new Map<string, DirEntryLike[]>();
  readdirErrors = new Map<string, Error>();
  searchFiles = new Map<string, string[]>();
  matchLines = new Map<string, string>();
  hostExecCalls = [];
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalConsoleLog;
});

describe("find impl isolated coverage", () => {
  test("reports no matches when repo scanning is unreadable and no psi targets exist", async () => {
    const orgPath = join(reposRoot, "Soul-Brews-Studio");

    readdirEntries.set(reposRoot, [dir("Soul-Brews-Studio")]);
    readdirErrors.set(orgPath, new Error("unreadable"));
    mockedFleet = [{ name: "101-empty", windows: [{ name: "shell" }] }];

    await cmdFind("needle");

    const output = logs.join("\n");
    expect(output).toContain("Searching");
    expect(output).toContain("no matches found across 0 oracle(s)");
    expect(output).not.toContain("── Oracles ──");
    expect(output).not.toContain("── Fleet ──");
    expect(output).not.toContain("── Code ──");
    expect(hostExecCalls).toHaveLength(0);
  });

  test("renders filtered results, deduplicates the local psi target, and shell-quotes grep args", async () => {
    const keyword = "na't";
    const orgPath = join(reposRoot, "Soul-Brews-Studio");
    const matchedFile = join(localPsi, "notes", `${keyword}.md`);

    readdirEntries.set(reposRoot, [dir("Soul-Brews-Studio")]);
    readdirEntries.set(orgPath, [dir(`${keyword}-oracle`), dir("skip-oracle")]);
    existingPaths.add(localPsi);
    searchFiles.set(localPsi, [matchedFile]);
    matchLines.set(matchedFile, `memory line for ${keyword}`);
    mockedFleet = [
      {
        name: `101-${keyword}`,
        windows: [{ name: `${keyword}-window`, repo: "Soul-Brews-Studio/maw-js" }],
        sync_peers: [`peer-${keyword}`],
        project_repos: [`project-${keyword}`],
      },
      {
        name: "102-skipme",
        windows: [{ name: `${keyword}-window`, repo: "Soul-Brews-Studio/maw-js" }],
        sync_peers: [`peer-${keyword}`],
        project_repos: [`project-${keyword}`],
      },
    ];

    await cmdFind(keyword, { oracle: keyword });

    const output = logs.join("\n");
    expect(output).toContain("── Oracles ──");
    expect(output).toContain(`(${`Soul-Brews-Studio/${keyword}-oracle`})`);
    expect(output).toContain("── Fleet ──");
    expect(output).toContain(`session 101-${keyword}`);
    expect(output).toContain(`window ${keyword}-window (Soul-Brews-Studio/maw-js)`);
    expect(output).toContain(`sync_peer peer-${keyword}`);
    expect(output).toContain(`project_repo project-${keyword}`);
    expect(output).not.toContain("102-skipme");
    expect(output).toContain("── Code ──");
    expect(output).toContain(`notes/${keyword}.md`);
    expect(output).toContain(`memory line for ${keyword}`);
    expect(output).toContain("6 match(es)");
    expect(output).toContain("1 oracle(s), 4 fleet, 1 code");

    const fileSearchCalls = hostExecCalls.filter((command) => command.includes("grep -ril"));
    const firstLineCalls = hostExecCalls.filter((command) => command.includes("grep -m1 -i"));

    expect(fileSearchCalls).toEqual([
      `grep -ril ${shSingleQuote(keyword)} ${shSingleQuote(localPsi)} 2>/dev/null || true`,
    ]);
    expect(firstLineCalls).toEqual([
      `grep -m1 -i ${shSingleQuote(keyword)} ${shSingleQuote(matchedFile)} 2>/dev/null || true`,
    ]);
  });
});
