import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdir, writeFile, rm, utimes } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { listFleetJobs, classifyJob, newestRunDir } from "../src/core/fleet/claude-jobs";

const TMP = join(tmpdir(), `claude-jobs-test-${process.pid}`);

beforeAll(async () => {
  await mkdir(TMP, { recursive: true });
});

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});

describe("classifyJob", () => {
  test("null runDir → regression generic", () => {
    expect(classifyJob(null)).toEqual({ kind: "regression" });
  });

  test("log with 'Regression' → regression", async () => {
    const d = join(TMP, "run-reg");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "out.log"), "Regression starting on branch main\n");
    expect(classifyJob(d)).toEqual({ kind: "regression" });
  });

  test("log with 'Single-test' → single-test + parses test name", async () => {
    const d = join(TMP, "run-single");
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "out.log"), "Single-test run\nSINGLE_TEST=test-mixed-flow.sh\n");
    const r = classifyJob(d);
    expect(r.kind).toBe("single-test");
    expect(r.singleTest).toBe("test-mixed-flow.sh");
  });
});

describe("newestRunDir", () => {
  test("returns null when runRoot missing", () => {
    expect(newestRunDir("/nonexistent/path/xyz", new Date().toISOString())).toBeNull();
  });

  test("picks the dir whose mtime is closest to startedAt", async () => {
    const root = join(TMP, "run-root");
    await mkdir(root, { recursive: true });
    const now = Date.now();
    const near = join(root, "20260422-120000");
    const far = join(root, "20260422-110000");
    await mkdir(near, { recursive: true });
    await mkdir(far, { recursive: true });
    // near is at now, far is 1h earlier
    await utimes(near, now / 1000, now / 1000);
    await utimes(far, (now - 3600_000) / 1000, (now - 3600_000) / 1000);
    const startedAt = new Date(now).toISOString();
    expect(newestRunDir(root, startedAt)).toBe(near);
  });

  test("ignores non-timestamp dirs", async () => {
    const root = join(TMP, "run-root-mixed");
    await mkdir(root, { recursive: true });
    await mkdir(join(root, "not-a-timestamp"), { recursive: true });
    await mkdir(join(root, "20260422-120000"), { recursive: true });
    const r = newestRunDir(root, new Date().toISOString());
    expect(r).toBe(join(root, "20260422-120000"));
  });
});

describe("listFleetJobs", () => {
  test("empty when no regression script running", async () => {
    const fakeExec = async (cmd: string) => {
      if (cmd.includes("pgrep")) return "";
      return "";
    };
    const jobs = await listFleetJobs({ exec: fakeExec, runRoot: TMP });
    expect(jobs).toEqual([]);
  });

  test("returns job when pgrep finds PID + runDir has marker", async () => {
    const root = join(TMP, "live-run");
    await mkdir(root, { recursive: true });
    const runDir = join(root, "20260422-130000");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "out.log"), "Single-test run\nSINGLE_TEST=test-foo.sh\n");
    const fakeExec = async (cmd: string) => {
      if (cmd.includes("pgrep")) return "12345\n";
      if (cmd.includes("ps -p 12345 -o lstart")) {
        return new Date().toString() + "\n";
      }
      return "";
    };
    const jobs = await listFleetJobs({ exec: fakeExec, runRoot: root });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].pid).toBe(12345);
    expect(jobs[0].kind).toBe("single-test");
    expect(jobs[0].singleTest).toBe("test-foo.sh");
    expect(jobs[0].runId).toBe("20260422-130000");
  });
});
