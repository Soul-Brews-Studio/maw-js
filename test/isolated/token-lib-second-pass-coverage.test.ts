import { afterEach, describe, expect, test } from "bun:test";

import {
  detectActiveToken,
  fingerprintTokens,
  listEnvrcNames,
  listTokenNames,
  setRunOverride,
  type RunResult,
} from "../../src/vendor/mpr-plugins/token/lib";

function result(ok: boolean, stdout = "", stderr = "", exitCode = ok ? 0 : 1): RunResult {
  return { ok, stdout, stderr, exitCode };
}

afterEach(() => {
  setRunOverride(null);
});

describe("token lib second-pass parsing coverage", () => {
  test("detectActiveToken accepts unquoted pass forms and ignores inactive legacy sources", () => {
    expect(detectActiveToken([
      "   # export CLAUDE_TOKEN_NAME=\"commented-name\"",
      "export CLAUDE_CODE_OAUTH_TOKEN=$(pass show claude/token-direct.no-quotes)",
    ].join("\n"))).toBe("direct.no-quotes");

    expect(detectActiveToken([
      "export CLAUDE_CODE_OAUTH_TOKEN=$TOKEN_TEAM",
      "TOKEN_TEAM=$(pass show claude/token-team-prod.2)",
    ].join("\n"))).toBe("team-prod.2");

    expect(detectActiveToken([
      "export CLAUDE_CODE_OAUTH_TOKEN=$TOKEN_MISSING",
      "# TOKEN_MISSING=$(pass show claude/token-commented-source)",
    ].join("\n"))).toBeNull();
  });

  test("list parsers skip headers, directories, blank lines, roots, and malformed pass output", () => {
    const calls: string[][] = [];
    setRunOverride((cmd) => {
      calls.push(cmd);
      if (cmd[0] === "pass" && cmd[1] === "ls" && cmd[2] === "claude") {
        return result(true, [
          "Password Store",
          "claude/",
          "not-a-token",
          "\u001b[34m├── token-alpha.one\u001b[0m",
          "│   └── token-team-prod",
          "###",
          "",
        ].join("\n"));
      }
      if (cmd[0] === "pass" && cmd[1] === "ls" && cmd[2] === "envrc") {
        return result(true, [
          "Password Store",
          "envrc",
          "envrc/",
          "nested/",
          "###",
          "",
          "  alpha",
          "  branch.name  ",
          "  team-prod",
        ].join("\n"));
      }
      return result(false, "", "unexpected command", 9);
    });

    expect(listTokenNames()).toEqual(["alpha.one", "team-prod"]);
    expect(listEnvrcNames()).toEqual(["alpha", "branch.name", "team-prod"]);
    expect(calls).toEqual([
      ["pass", "ls", "claude"],
      ["pass", "ls", "envrc"],
    ]);
  });

  test("fingerprintTokens counts only readable token values long enough to fingerprint", () => {
    const calls: string[][] = [];
    setRunOverride((cmd) => {
      calls.push(cmd);
      if (cmd[0] === "pass" && cmd[1] === "ls" && cmd[2] === "claude") {
        return result(true, [
          "├── token-good",
          "├── token-missing",
          "└── token-too-short",
        ].join("\n"));
      }
      if (cmd[0] === "pass" && cmd[1] === "show" && cmd[2] === "claude/token-good") {
        return result(true, "  abcdefgh-token  \n");
      }
      if (cmd[0] === "pass" && cmd[1] === "show" && cmd[2] === "claude/token-too-short") {
        return result(true, "1234567\n");
      }
      return result(false, "", "missing", 2);
    });

    expect([...fingerprintTokens().entries()]).toEqual([["abcdefgh-token", "good"]]);
    expect(calls).toEqual([
      ["pass", "ls", "claude"],
      ["pass", "show", "claude/token-good"],
      ["pass", "show", "claude/token-missing"],
      ["pass", "show", "claude/token-too-short"],
    ]);
  });
});
