import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Redirect ARTIFACTS_ROOT for testing
const testRoot = mkdtempSync(join(tmpdir(), "maw-artifacts-test-"));

// We need to test the functions directly with the test root
// Since artifacts.ts uses a constant, we test the logic via the public API
import {
  createArtifact,
  updateArtifact,
  writeResult,
  addAttachment,
  listArtifacts,
  getArtifact,
  artifactDir,
} from "../src/lib/artifacts";

// Override artifact roots for tests by setting HOME / XDG env before each call.
const originalEnv = {
  HOME: process.env.HOME,
  MAW_HOME: process.env.MAW_HOME,
  MAW_CACHE_DIR: process.env.MAW_CACHE_DIR,
  MAW_XDG: process.env.MAW_XDG,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};

beforeEach(() => {
  process.env.HOME = testRoot;
  delete process.env.MAW_HOME;
  delete process.env.MAW_XDG;
  delete process.env.XDG_CACHE_HOME;
  process.env.MAW_CACHE_DIR = join(testRoot, "cache");
});
afterAll(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(testRoot, { recursive: true });
});

describe("createArtifact", () => {
  test("creates dir + spec.md + meta.json", () => {
    const dir = createArtifact("test-team", "1", "Build feature", "Do the thing");
    expect(existsSync(join(dir, "spec.md"))).toBe(true);
    expect(existsSync(join(dir, "meta.json"))).toBe(true);
    expect(existsSync(join(dir, "attachments"))).toBe(true);

    const spec = readFileSync(join(dir, "spec.md"), "utf-8");
    expect(spec).toContain("Build feature");
    expect(spec).toContain("Do the thing");

    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    expect(meta.team).toBe("test-team");
    expect(meta.taskId).toBe("1");
    expect(meta.status).toBe("pending");
  });
});

describe("updateArtifact", () => {
  test("updates status and owner", () => {
    createArtifact("update-team", "2", "Test task", "desc");
    updateArtifact("update-team", "2", { status: "in_progress", owner: "scout" });
    const dir = artifactDir("update-team", "2");
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    expect(meta.status).toBe("in_progress");
    expect(meta.owner).toBe("scout");
  });
});

describe("writeResult", () => {
  test("writes result.md and marks completed", () => {
    createArtifact("result-team", "3", "Write result", "desc");
    writeResult("result-team", "3", "# Result\n\nDone!");
    const dir = artifactDir("result-team", "3");
    expect(existsSync(join(dir, "result.md"))).toBe(true);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    expect(meta.status).toBe("completed");
  });
});

describe("addAttachment", () => {
  test("writes file to attachments/", () => {
    createArtifact("attach-team", "4", "Attach", "desc");
    const path = addAttachment("attach-team", "4", "report.txt", "data here");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toBe("data here");
  });
});

describe("listArtifacts", () => {
  test("discovers artifacts across teams", () => {
    createArtifact("list-a", "1", "Task A1", "desc");
    createArtifact("list-b", "1", "Task B1", "desc");
    writeResult("list-a", "1", "done");
    const all = listArtifacts();
    const teamA = all.filter(a => a.team === "list-a");
    const teamB = all.filter(a => a.team === "list-b");
    expect(teamA.length).toBe(1);
    expect(teamA[0].hasResult).toBe(true);
    expect(teamB.length).toBe(1);
    expect(teamB[0].hasResult).toBe(false);
  });

  test("filters by team name", () => {
    const filtered = listArtifacts("list-a");
    expect(filtered.every(a => a.team === "list-a")).toBe(true);
  });
});

describe("getArtifact", () => {
  test("returns full artifact with spec + result + attachments", () => {
    createArtifact("get-team", "5", "Full artifact", "the spec");
    writeResult("get-team", "5", "the result");
    addAttachment("get-team", "5", "chart.png", Buffer.from("fake-png"));
    const art = getArtifact("get-team", "5");
    expect(art).not.toBeNull();
    expect(art!.spec).toContain("the spec");
    expect(art!.result).toContain("the result");
    expect(art!.attachments).toContain("chart.png");
    expect(art!.meta.status).toBe("completed");
  });

  test("returns null for missing artifact", () => {
    expect(getArtifact("nope", "999")).toBeNull();
  });
});

describe("XDG cache paths", () => {
  test("writes new artifacts under XDG cache when enabled", () => {
    const cacheHome = join(testRoot, "xdg-cache");
    delete process.env.MAW_CACHE_DIR;
    process.env.MAW_XDG = "1";
    process.env.XDG_CACHE_HOME = cacheHome;

    const dir = createArtifact("xdg-team", "1", "XDG artifact", "desc");

    expect(dir).toBe(join(cacheHome, "maw", "artifacts", "xdg-team", "1"));
    expect(existsSync(join(dir, "meta.json"))).toBe(true);
  });

  test("reads legacy ~/.maw artifacts after XDG is enabled", () => {
    const cacheHome = join(testRoot, "xdg-cache");
    const legacyDir = join(testRoot, ".maw", "artifacts", "legacy-team", "9");
    mkdirSync(join(legacyDir, "attachments"), { recursive: true });
    writeFileSync(join(legacyDir, "spec.md"), "# Legacy\n\nold task\n");
    writeFileSync(join(legacyDir, "meta.json"), JSON.stringify({
      team: "legacy-team",
      taskId: "9",
      subject: "Legacy artifact",
      status: "pending",
      createdAt: "2026-05-21T00:00:00.000Z",
      updatedAt: "2026-05-21T00:00:00.000Z",
    }, null, 2));

    delete process.env.MAW_CACHE_DIR;
    process.env.MAW_XDG = "1";
    process.env.XDG_CACHE_HOME = cacheHome;

    const art = getArtifact("legacy-team", "9");
    expect(art?.dir).toBe(legacyDir);
    expect(art?.spec).toContain("old task");
    expect(listArtifacts("legacy-team").map((a) => a.taskId)).toContain("9");
  });
});
