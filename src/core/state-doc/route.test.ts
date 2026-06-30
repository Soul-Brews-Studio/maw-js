import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleStateDocRequest, stateDocPath } from "./route";

// Pin the data dir to a temp sandbox so the read is deterministic + isolated.
const dir = mkdtempSync(join(tmpdir(), "maw-statedoc-"));
const prev = process.env.MAW_DATA_DIR;

beforeAll(() => {
  process.env.MAW_DATA_DIR = dir;
  const pgwDir = join(dir, "state", "pgw");
  mkdirSync(pgwDir, { recursive: true });
  writeFileSync(join(pgwDir, "state.md"), "# pgw\n\n## COORDINATION\n- DOING: ship company-ui\n");
});

afterAll(() => {
  if (prev === undefined) delete process.env.MAW_DATA_DIR;
  else process.env.MAW_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("handleStateDocRequest (company-ui markdown panel)", () => {
  test("present file → { exists:true, markdown }", async () => {
    const res = handleStateDocRequest(new Request("http://x/api/state?company=pgw"));
    const body = (await res.json()) as { company: string; exists: boolean; markdown: string };
    expect(body.company).toBe("pgw");
    expect(body.exists).toBe(true);
    expect(body.markdown).toContain("## COORDINATION");
  });

  test("missing file → { exists:false } (no throw, panel hides)", async () => {
    const res = handleStateDocRequest(new Request("http://x/api/state?company=kobo"));
    const body = (await res.json()) as { exists: boolean; markdown: string };
    expect(body.exists).toBe(false);
    expect(body.markdown).toBe("");
  });

  test("no company → empty (no throw)", async () => {
    const res = handleStateDocRequest(new Request("http://x/api/state"));
    const body = (await res.json()) as { company: null; exists: boolean };
    expect(body.company).toBeNull();
    expect(body.exists).toBe(false);
  });

  test("company is sanitized to a single safe segment (no path traversal)", () => {
    // ".." / separators collapse to underscores → stays inside <data>/state/.
    expect(stateDocPath("../../etc")).toBe(join(dir, "state", "______etc", "state.md"));
    expect(stateDocPath("a/b")).toBe(join(dir, "state", "a_b", "state.md"));
  });
});
