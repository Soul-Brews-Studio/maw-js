import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realChild from "child_process";
import { join } from "path";

let configValue: any = { githubOrgs: ["Soul-Brews-Studio"] };
const repoListings = new Map<string, string>();
const psiExitCodes = new Map<string, number>();
const execFileCalls: Array<{ cmd: string; args: string[] }> = [];
const spawnCalls: string[] = [];

const realSpawn = Bun.spawn;

mock.module("child_process", () => ({
  ...realChild,
  execFileSync: (cmd: string, args: string[]) => {
    execFileCalls.push({ cmd, args });
    const endpoint = String(args[1] ?? "");
    if (!repoListings.has(endpoint)) throw new Error(`gh failed for ${endpoint}`);
    return repoListings.get(endpoint)!;
  },
}));

mock.module(join(import.meta.dir, "../src/config"), () => ({
  loadConfig: () => configValue,
}));

const { scanRemote } = await import("../src/core/fleet/registry-oracle-scan-remote");

const origLog = console.log;
const origWarn = console.warn;
const origError = console.error;
const origWrite = process.stdout.write;

let logs: string[] = [];
let warns: string[] = [];
let errors: string[] = [];
let writes: string[] = [];

async function run<T>(fn: () => Promise<T>): Promise<T> {
  logs = [];
  warns = [];
  errors = [];
  writes = [];
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(" ")); };
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  (process.stdout as unknown as { write: typeof process.stdout.write }).write =
    ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = origWrite;
  }
}

beforeEach(() => {
  configValue = { githubOrgs: ["Soul-Brews-Studio"] };
  repoListings.clear();
  psiExitCodes.clear();
  execFileCalls.length = 0;
  spawnCalls.length = 0;
  logs = [];
  warns = [];
  errors = [];
  writes = [];
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn =
    ((cmd: string[]) => {
      const endpoint = String(cmd[2] ?? "");
      const fullName = endpoint.replace(/^\/repos\//, "").replace(/\/contents\/ψ$/, "");
      spawnCalls.push(fullName);
      return { exited: Promise.resolve(psiExitCodes.get(fullName) ?? 1) };
    }) as typeof Bun.spawn;
});

afterEach(() => {
  console.log = origLog;
  console.warn = origWarn;
  console.error = origError;
  (process.stdout as unknown as { write: typeof process.stdout.write }).write = origWrite;
  (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = realSpawn;
});

describe("scanRemote default-suite coverage", () => {
  test("uses config orgs, filters oracle repos, dedupes ψ checks, and sorts results by derived name", async () => {
    configValue = { githubOrgs: ["OrgA"] };
    repoListings.set(
      "/orgs/OrgA/repos?per_page=100&type=all",
      [
        "OrgA/zeta-oracle zeta-oracle",
        "OrgA/misc misc",
        "OrgA/alpha-oracle alpha-oracle",
        "OrgA/alpha-oracle alpha-oracle",
      ].join("\n"),
    );
    psiExitCodes.set("OrgA/alpha-oracle", 0);
    psiExitCodes.set("OrgA/zeta-oracle", 1);

    const entries = await run(() => scanRemote(undefined, false));

    expect(execFileCalls).toEqual([{
      cmd: "gh",
      args: [
        "api",
        "/orgs/OrgA/repos?per_page=100&type=all",
        "--paginate",
        "--jq",
        '.[] | .full_name + " " + .name',
      ],
    }]);
    expect(spawnCalls).toEqual(["OrgA/zeta-oracle", "OrgA/alpha-oracle"]);
    expect(entries.map((entry) => ({
      org: entry.org,
      repo: entry.repo,
      name: entry.name,
      has_psi: entry.has_psi,
      local_path: entry.local_path,
    }))).toEqual([
      { org: "OrgA", repo: "alpha-oracle", name: "alpha", has_psi: true, local_path: "" },
      { org: "OrgA", repo: "zeta-oracle", name: "zeta", has_psi: false, local_path: "" },
    ]);
    expect(entries.every((entry) => entry.detected_at.includes("T"))).toBe(true);
    expect(writes.join("\n")).toContain("⏳ scanning OrgA");
    expect(writes.join("\n")).toContain("alpha-oracle...");
    expect(logs.join("\n")).toContain("4 repos, 3 oracles");
    expect(logs.join("\n")).toContain("ψ/");
    expect(logs.join("\n")).toContain("—");
  });

  test("rejects invalid org names before gh or ψ checks", async () => {
    const entries = await run(() => scanRemote(["bad;org"]));

    expect(entries).toEqual([]);
    expect(execFileCalls).toEqual([]);
    expect(spawnCalls).toEqual([]);
    expect(errors).toEqual(['\u001b[31m✗\u001b[0m invalid org name "bad;org" — skipping']);
  });

  test("warns on gh failures and still continues scanning later orgs", async () => {
    repoListings.set(
      "/orgs/GoodOrg/repos?per_page=100&type=all",
      "GoodOrg/pulse-oracle pulse-oracle\nGoodOrg/readme readme",
    );
    psiExitCodes.set("GoodOrg/pulse-oracle", 0);

    const entries = await run(() => scanRemote(["BadOrg", "GoodOrg"]));

    expect(entries.map((entry) => entry.name)).toEqual(["pulse"]);
    expect(warns.join("\n")).toContain("[oracle-registry] BadOrg failed: gh failed for /orgs/BadOrg/repos?per_page=100&type=all");
    expect(execFileCalls.map((call) => call.args[1])).toEqual([
      "/orgs/BadOrg/repos?per_page=100&type=all",
      "/orgs/GoodOrg/repos?per_page=100&type=all",
    ]);
    expect(spawnCalls).toEqual(["GoodOrg/pulse-oracle"]);
  });
});
