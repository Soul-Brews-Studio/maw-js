/**
 * Tests for src/lib/artifacts.ts — createArtifact, updateArtifact, writeResult,
 * addAttachment, listArtifacts, getArtifact.
 *
 * Uses unique team/task IDs to avoid collision, cleans up after.
 * homedir() caches at process start so HOME override won't work;
 * instead we use a unique test team prefix and clean up.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { rmSync, existsSync, readFileSync } from "fs";
import { dirname } from "path";
import {
  createArtifact, updateArtifact, writeResult,
  addAttachment, listArtifacts, getArtifact, artifactDir,
} from "../../src/lib/artifacts";

const TEST_TEAM = `_test_${Date.now()}`;

afterAll(() => {
  // Clean up test artifacts
  const dir = dirname(artifactDir(TEST_TEAM, "x"));
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("createArtifact", () => {
  it("creates artifact directory with spec and meta", () => {
    const dir = createArtifact(TEST_TEAM, "task-001", "Test Task", "Do something");
    expect(existsSync(dir)).toBe(true);

    const spec = readFileSync(`${dir}/spec.md`, "utf-8");
    expect(spec).toContain("# Test Task");
    expect(spec).toContain("Do something");

    const meta = JSON.parse(readFileSync(`${dir}/meta.json`, "utf-8"));
    expect(meta.team).toBe(TEST_TEAM);
    expect(meta.taskId).toBe("task-001");
    expect(meta.status).toBe("pending");
  });

  it("creates attachments subdirectory", () => {
    const dir = createArtifact(TEST_TEAM, "task-002", "Sub", "Desc");
    expect(existsSync(`${dir}/attachments`)).toBe(true);
  });
});

describe("updateArtifact", () => {
  it("updates meta fields", () => {
    const dir = createArtifact(TEST_TEAM, "task-upd", "Update Test", "Desc");
    updateArtifact(TEST_TEAM, "task-upd", { status: "in_progress", owner: "neo" });

    const meta = JSON.parse(readFileSync(`${dir}/meta.json`, "utf-8"));
    expect(meta.status).toBe("in_progress");
    expect(meta.owner).toBe("neo");
  });

  it("does nothing for nonexistent artifact", () => {
    // Should not throw
    updateArtifact(TEST_TEAM, "nonexistent", { status: "completed" });
  });
});

describe("writeResult", () => {
  it("writes result.md and sets status to completed", () => {
    const dir = createArtifact(TEST_TEAM, "task-res", "Result Test", "Desc");
    writeResult(TEST_TEAM, "task-res", "# Done\nAll good.");

    const result = readFileSync(`${dir}/result.md`, "utf-8");
    expect(result).toContain("# Done");

    const meta = JSON.parse(readFileSync(`${dir}/meta.json`, "utf-8"));
    expect(meta.status).toBe("completed");
  });
});

describe("addAttachment", () => {
  it("writes file to attachments dir", () => {
    createArtifact(TEST_TEAM, "task-att", "Attach Test", "Desc");
    const dest = addAttachment(TEST_TEAM, "task-att", "output.txt", "hello");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf-8")).toBe("hello");
  });

  it("sanitizes filename", () => {
    createArtifact(TEST_TEAM, "task-att2", "Attach2", "Desc");
    const dest = addAttachment(TEST_TEAM, "task-att2", "bad file@name!.txt", "data");
    expect(dest).toContain("bad_file_name_.txt");
  });
});

describe("listArtifacts", () => {
  it("lists artifacts for test team", () => {
    const arts = listArtifacts(TEST_TEAM);
    expect(arts.length).toBeGreaterThan(0);
    expect(arts.every(a => a.team === TEST_TEAM)).toBe(true);
  });

  it("returns empty for nonexistent team", () => {
    expect(listArtifacts("_nonexistent_team_")).toEqual([]);
  });

  it("includes hasResult flag", () => {
    createArtifact(TEST_TEAM, "task-hr", "HasResult", "Desc");
    writeResult(TEST_TEAM, "task-hr", "done");
    const arts = listArtifacts(TEST_TEAM);
    const hr = arts.find(a => a.taskId === "task-hr");
    expect(hr?.hasResult).toBe(true);
  });
});

describe("getArtifact", () => {
  it("returns full artifact contents", () => {
    createArtifact(TEST_TEAM, "task-get", "Get Test", "Details here");
    writeResult(TEST_TEAM, "task-get", "All done");

    const a = getArtifact(TEST_TEAM, "task-get");
    expect(a).not.toBeNull();
    expect(a!.meta.subject).toBe("Get Test");
    expect(a!.spec).toContain("Details here");
    expect(a!.result).toContain("All done");
    expect(Array.isArray(a!.attachments)).toBe(true);
  });

  it("returns null for nonexistent", () => {
    expect(getArtifact(TEST_TEAM, "nope")).toBeNull();
  });
});

describe("artifactDir", () => {
  it("returns expected path components", () => {
    const dir = artifactDir("myteam", "task-123");
    expect(dir).toContain("myteam");
    expect(dir).toContain("task-123");
    expect(dir).toContain(".maw");
  });
});
