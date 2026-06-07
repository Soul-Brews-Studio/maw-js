import { describe, expect, test } from "bun:test";
import { teamOracleMemberNames } from "../../src/vendor/mpr-plugins/team/team-workspace";
import { resolveTeamSendMode } from "../../src/vendor/mpr-plugins/team/team-comms";

describe("team workspace helpers", () => {
  test("deduplicates oracle member names while preserving first-seen order", () => {
    expect(teamOracleMemberNames([
      { oracle: "volt", role: "builder", addedAt: "2026-05-16T00:00:00Z" },
      { oracle: "odin", role: "reviewer", addedAt: "2026-05-16T00:00:00Z" },
      { oracle: "volt", role: "builder", addedAt: "2026-05-16T00:00:00Z" },
    ])).toEqual(["volt", "odin"]);
  });

  test("resolves unquoted multi-word team send as broadcast unless first word is a member", () => {
    expect(resolveTeamSendMode(["hello", "team"], ["volt", "odin"])).toEqual({
      mode: "broadcast",
      message: "hello team",
    });
    expect(resolveTeamSendMode(["volt", "hello"], ["volt", "odin"])).toEqual({
      mode: "single",
      agent: "volt",
      message: "hello",
    });
    expect(resolveTeamSendMode(["agent", "legacy"], [])).toEqual({
      mode: "single",
      agent: "agent",
      message: "legacy",
    });
  });
});
