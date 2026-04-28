/**
 * Tests for bud scaffold pure helpers:
 *   - from-repo-git.ts: scaffoldBranchName
 *   - from-repo-exec.ts: oracleMarkerBegin, oracleMarkerEnd
 */
import { describe, it, expect } from "bun:test";
import { scaffoldBranchName } from "../../src/commands/plugins/bud/from-repo-git";
import { oracleMarkerBegin, oracleMarkerEnd } from "../../src/commands/plugins/bud/from-repo-exec";

describe("scaffoldBranchName", () => {
  it("prefixes with oracle/scaffold-", () => {
    expect(scaffoldBranchName("neo")).toBe("oracle/scaffold-neo");
  });

  it("handles hyphenated stems", () => {
    expect(scaffoldBranchName("my-cool-project")).toBe("oracle/scaffold-my-cool-project");
  });

  it("handles empty string", () => {
    expect(scaffoldBranchName("")).toBe("oracle/scaffold-");
  });
});

describe("oracleMarkerBegin", () => {
  it("wraps stem in HTML comment", () => {
    expect(oracleMarkerBegin("neo")).toBe("<!-- oracle-scaffold: begin stem=neo -->");
  });

  it("handles hyphenated stems", () => {
    expect(oracleMarkerBegin("my-proj")).toContain("stem=my-proj");
  });
});

describe("oracleMarkerEnd", () => {
  it("wraps stem in HTML comment", () => {
    expect(oracleMarkerEnd("neo")).toBe("<!-- oracle-scaffold: end stem=neo -->");
  });

  it("begin and end are symmetric", () => {
    const stem = "test";
    expect(oracleMarkerBegin(stem)).toContain("begin");
    expect(oracleMarkerEnd(stem)).toContain("end");
    expect(oracleMarkerBegin(stem)).toContain(stem);
    expect(oracleMarkerEnd(stem)).toContain(stem);
  });
});
